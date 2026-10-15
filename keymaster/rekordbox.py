"""Writes keys and cue points straight into the Rekordbox 6/7 database (master.db) via pyrekordbox.

Rekordbox must be closed while writing. Every write run copies master.db into
keymaster-backups/ next to it first.
"""

import shutil
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import uuid4

from pyrekordbox.config import get_config
from pyrekordbox.masterdb import MasterDatabase
from pyrekordbox.masterdb.models import DjmdCue, DjmdKey
from pyrekordbox.utils import get_rekordbox_pid

from . import keys
from .analysis import Cue

# DjmdCue.Kind of hot cues A..H as Rekordbox stores them (4 is skipped); memory cues are 0.
HOT_KIND = [1, 2, 3, 5, 6, 7, 8, 9]
MEMORY_KIND = 0
FRAMES_PER_SEC = 150  # InFrame unit used by Rekordbox
AUDIO_EXT = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".alac"}


@dataclass
class Change:
    content: object
    old_key: str | None = None
    new_key: str | None = None
    cues: list[str] = field(default_factory=list)  # human readable cue actions

    @property
    def empty(self) -> bool:
        return self.new_key is None and not self.cues


def default_db_path() -> Path:
    cfg = get_config("rekordbox7") or get_config("rekordbox6")
    path = cfg.get("db_path") if cfg else None
    if not path:
        raise FileNotFoundError("No Rekordbox 6/7 database found. Pass --db /path/to/master.db")
    return Path(path)


def rekordbox_running() -> bool:
    return bool(get_rekordbox_pid())


def open_db(path: Path | None = None) -> tuple[MasterDatabase, Path]:
    path = Path(path) if path else default_db_path()
    return MasterDatabase(path, db_dir=path.parent), path


def is_live_db(path: Path) -> bool:
    """True for the database Rekordbox itself uses (as opposed to a copy passed with --db)."""
    try:
        return Path(path).resolve() == default_db_path().resolve()
    except FileNotFoundError:
        return False


def commit(db: MasterDatabase, path: Path) -> None:
    """Commits; pyrekordbox refuses while Rekordbox runs, which only matters for the live database."""
    if is_live_db(path):
        db.commit()
        return
    import pyrekordbox.masterdb.database as dbmod

    orig = dbmod.get_rekordbox_pid
    dbmod.get_rekordbox_pid = lambda: 0
    try:
        db.commit()
    finally:
        dbmod.get_rekordbox_pid = orig


def backup(db_path: Path) -> Path:
    dest_dir = db_path.parent / "keymaster-backups"
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"{db_path.stem}-{datetime.now():%Y%m%d-%H%M%S}.db"
    shutil.copy2(db_path, dest)
    return dest


# ---------- finding tracks ----------

def playlist_contents(db: MasterDatabase, name: str) -> list:
    pls = db.get_playlist(Name=name).all()
    if not pls:
        raise LookupError(f"Playlist '{name}' not found")
    if len(pls) > 1:
        raise LookupError(f"{len(pls)} playlists are called '{name}', please rename one")
    return db.get_playlist_contents(pls[0]).all()


def audio_files(paths: list[Path]) -> list[Path]:
    out = []
    for p in paths:
        p = p.expanduser().resolve()
        if p.is_dir():
            out += sorted(f for f in p.rglob("*") if f.suffix.lower() in AUDIO_EXT and not f.name.startswith("._"))
        else:
            out.append(p)
    return out


def content_for_path(db: MasterDatabase, path: Path, size: int | None = None):
    """Collection entry for a file: exact path first, then a unique file name (+ size) match."""
    # macOS may hand out decomposed umlauts (NFD) while Rekordbox stored composed ones (NFC), or vice versa.
    for form in ("NFC", "NFD"):
        hit = db.get_content(FolderPath=unicodedata.normalize(form, str(path))).first()
        if hit:
            return hit
    cands = [c for form in ("NFC", "NFD") for c in db.get_content(FileNameL=unicodedata.normalize(form, path.name)).all()]
    if size:
        cands = [c for c in cands if c.FileSize == size] or cands
    return cands[0] if len(cands) == 1 else None


# ---------- writing ----------

def _key_row(db: MasterDatabase, name: str) -> DjmdKey:
    row = db.get_key(ScaleName=name).first()
    if row is None:
        row = DjmdKey.create(ID=str(db.generate_unused_id(DjmdKey)), ScaleName=name, UUID=str(uuid4()))
        db.add(row)
        db.flush()
    return row


def set_key(db: MasterDatabase, content, key: keys.Key, notation: str, overwrite: bool, ch: Change) -> None:
    old = content.Key.ScaleName if content.Key else None
    name = key.name(notation)
    if old == name or (old and not overwrite):
        return
    ch.old_key, ch.new_key = old, name
    content.KeyID = _key_row(db, name).ID


def _fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:06.3f}"


def set_cues(db: MasterDatabase, content, cues: list[Cue], memory: list[float], overwrite: bool, ch: Change) -> None:
    existing = db.get_cue(ContentID=content.ID).all()
    by_kind = {c.Kind: c for c in existing if c.Kind in HOT_KIND}
    mem_ms = [c.InMsec for c in existing if c.Kind == MEMORY_KIND]
    todo = [(HOT_KIND[c.slot], c.t, c.name) for c in cues if 0 <= c.slot < 8]
    todo += [(MEMORY_KIND, t, "") for t in memory]
    for kind, t, name in todo:
        ms = int(round(t * 1000))
        label = f"{'ABCDEFGH'[HOT_KIND.index(kind)]}" if kind else "Memory"
        if kind == MEMORY_KIND:
            if any(abs(ms - m) < 50 for m in mem_ms):
                continue
            mem_ms.append(ms)
        elif kind in by_kind:
            row = by_kind[kind]
            if not overwrite or (abs(row.InMsec - ms) < 5 and (row.Comment or "") == name):
                continue
            row.InMsec, row.InFrame, row.Comment = ms, int(round(t * FRAMES_PER_SEC)), name
            ch.cues.append(f"{label} {_fmt(t)} {name} (replaced)".rstrip())
            continue
        db.add(DjmdCue.create(
            ID=str(db.generate_unused_id(DjmdCue)), ContentID=content.ID, ContentUUID=content.UUID,
            InMsec=ms, InFrame=int(round(t * FRAMES_PER_SEC)), InMpegFrame=0, InMpegAbs=0,
            OutMsec=-1, OutFrame=0, OutMpegFrame=0, OutMpegAbs=0,
            Kind=kind, Color=-1, ColorTableIndex=None, ActiveLoop=0, Comment=name,
            BeatLoopSize=0, CueMicrosec=0, UUID=str(uuid4()),
        ))
        ch.cues.append(f"{label} {_fmt(t)} {name}".rstrip())
    if ch.cues:
        content.CueUpdated = str(int(content.CueUpdated or 0) + 1)


# ---------- Key Master / Rekordbox XML ----------

@dataclass
class XmlTrack:
    path: Path
    size: int | None
    key: keys.Key | None
    cues: list[Cue]
    memory: list[float]


def read_xml(file: Path) -> list[XmlTrack]:
    """Reads a rekordbox.xml (e.g. the Key Master browser export)."""
    out = []
    for tr in ET.parse(file).getroot().iter("TRACK"):
        loc = tr.get("Location")
        if not loc:
            continue  # playlist reference
        u = urlparse(loc)
        path = Path(unquote(u.path))
        cues, memory = [], []
        for pm in tr.iter("POSITION_MARK"):
            t, num = float(pm.get("Start", 0)), int(pm.get("Num", -1))
            if 0 <= num < 8:
                cues.append(Cue(num, t, pm.get("Name", "")))
            elif num == -1:
                memory.append(t)
        size = tr.get("Size")
        out.append(XmlTrack(path, int(size) if size and size.isdigit() else None,
                            keys.parse(tr.get("Tonality", "")), cues, memory))
    return out


# ---------- Key Master app: collection import, XML export, direct write ----------

def _grid_from_anlz(db: MasterDatabase, content) -> tuple[float, float] | None:
    """(bpm, first downbeat) from Rekordbox's own beat grid in the ANLZ file."""
    try:
        anlz = db.read_anlz_file(content, "DAT")
        if anlz is None or "PQTZ" not in anlz:
            return None
        beats, bpms, times = anlz.get_tag("PQTZ").get()
        if not len(times):
            return None
        down = times[beats == 1]
        first = float(down[0] if len(down) else times[0])
        return float(round(float(sorted(bpms)[len(bpms) // 2]), 2)), first
    except Exception:  # noqa: BLE001 - missing/odd analysis files are common
        return None


def import_collection(lib, db_path: Path | None = None, progress=None) -> dict:
    """Adds Rekordbox tracks (with key, grid, cues) and playlists to the Key Master library.

    Local edits win: fields that already have a value in Key Master are not overwritten.
    """
    import os

    db, _ = open_db(db_path)
    contents = db.get_content().all()
    rb_to_local, added, skipped = {}, 0, 0
    for i, c in enumerate(contents):
        if progress and i % 50 == 0:
            progress(i / max(1, len(contents)))
        p = c.FolderPath
        if not p or not os.path.exists(p) or Path(p).suffix.lower() not in AUDIO_EXT:
            skipped += 1
            continue
        existing = lib.by_path(p)
        tid = existing["id"] if existing else lib.add_file(Path(p))
        added += 0 if existing else 1
        t = lib.track(tid)
        upd = {"rb_id": str(c.ID)}
        if c.Title and not existing:
            upd["title"] = c.Title
        if c.Artist and c.Artist.Name and not existing:
            upd["artist"] = c.Artist.Name
        if c.Genre and c.Genre.Name and not t.get("genre"):
            upd["genre"] = c.Genre.Name
        k = keys.parse(c.Key.ScaleName) if c.Key else None
        if k and not t.get("key"):
            upd["key"] = k.camelot
        if not t.get("bpm"):
            grid = _grid_from_anlz(db, c)
            if grid:
                upd["bpm"], upd["first_beat"] = grid
            elif c.BPM:
                upd["bpm"] = c.BPM / 100
        cues = t["cues"]
        if not any(cues):
            mem = []
            for q in db.get_cue(ContentID=c.ID).all():
                tt = (q.InMsec or 0) / 1000
                if q.Kind in HOT_KIND:
                    cues[HOT_KIND.index(q.Kind)] = {"t": tt, "name": q.Comment or ""}
                elif q.Kind == MEMORY_KIND:
                    mem.append(tt)
            upd["cues"] = cues
            if mem and not t["memory"]:
                upd["memory"] = sorted(mem)
        lib.update(tid, **upd)
        rb_to_local[str(c.ID)] = tid
    n_pl = 0
    for pl in db.get_playlist().all():
        if pl.Attribute != 0:  # folders and smart playlists
            continue
        ids = [rb_to_local[str(s.ID)] for s in db.get_playlist_contents(pl).all() if str(s.ID) in rb_to_local]
        lib.save_playlist(pl.Name, ids, source="rekordbox", rb_id=str(pl.ID))
        n_pl += 1
    db.close()
    return {"tracks": len(rb_to_local), "added": added, "skipped": skipped, "playlists": n_pl}


def _location(path: str) -> str:
    from urllib.parse import quote

    return "file://localhost" + quote(path)


def _esc(s) -> str:
    from xml.sax.saxutils import quoteattr

    return quoteattr(str(s))[1:-1]


HOT_COLORS = ["#ff5d73", "#ff9f43", "#ffd84d", "#5ee38c", "#3fd1c4", "#5aa2ff", "#a77bff", "#ff74c8"]
KIND_BY_EXT = {".mp3": "MP3 File", ".wav": "WAV File", ".m4a": "M4A File", ".aac": "M4A File", ".flac": "FLAC File",
               ".aif": "AIFF File", ".aiff": "AIFF File", ".ogg": "OGG File"}


def build_xml(tracks: list[dict], playlists: list[tuple[str, list[int]]], notation: str = "camelot",
              use_processed: bool = False, grid: bool = True, memory_cues: bool = True) -> str:
    """Rekordbox XML with key, BPM, beat grid, hot + memory cues, energy comment and playlists."""
    import os

    idx = {t["id"]: i + 1 for i, t in enumerate(tracks)}
    out = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
           '  <PRODUCT Name="Key Master" Version="1.0" Company=""/>', f'  <COLLECTION Entries="{len(tracks)}">']
    for t in tracks:
        path = t["path"]
        if use_processed and t.get("processed_path") and os.path.exists(t["processed_path"]):
            path = t["processed_path"]
        k = keys.parse(t.get("key") or "")
        a = {"TrackID": idx[t["id"]], "Name": t.get("title") or Path(path).stem, "Artist": t.get("artist") or "",
             "Genre": t.get("genre") or "", "Kind": KIND_BY_EXT.get(Path(path).suffix.lower(), "MP3 File"),
             "Size": t.get("size") or 0, "TotalTime": int(round(t.get("duration") or 0)),
             "SampleRate": t.get("sample_rate") or 44100, "AverageBpm": f"{(t.get('bpm') or 0):.2f}",
             "Tonality": k.name(notation) if k else "", "Rating": int(t.get("rating") or 0) * 51}
        if k:
            a["Comments"] = f"{k.camelot} - Energy {t.get('energy') or '-'}"
        a["Location"] = _location(path)
        kids = []
        if grid and t.get("bpm"):
            kids.append(f'      <TEMPO Inizio="{(t.get("first_beat") or 0):.3f}" Bpm="{t["bpm"]:.2f}" Metro="4/4" Battito="1"/>')
        cues = [(n, c) for n, c in enumerate(t.get("cues") or []) if c]
        if memory_cues:
            for tt in sorted(set([c["t"] for _, c in cues] + list(t.get("memory") or []))):
                kids.append(f'      <POSITION_MARK Name="" Type="0" Start="{tt:.3f}" Num="-1"/>')
        for n, c in cues:
            col = HOT_COLORS[n].lstrip("#")
            r, g, b = (int(col[i:i + 2], 16) for i in (0, 2, 4))
            kids.append(f'      <POSITION_MARK Name="{_esc(c.get("name") or "")}" Type="0" Start="{c["t"]:.3f}" '
                        f'Num="{n}" Red="{r}" Green="{g}" Blue="{b}"/>')
        attrs = " ".join(f'{k_}="{_esc(v)}"' for k_, v in a.items())
        out.append(f"    <TRACK {attrs}>\n" + "\n".join(kids) + "\n    </TRACK>" if kids else f"    <TRACK {attrs}/>")
    out.append("  </COLLECTION>")
    out += ["  <PLAYLISTS>", f'    <NODE Type="0" Name="ROOT" Count="{len(playlists)}">']
    for name, ids in playlists:
        ids = [i for i in ids if i in idx]
        out.append(f'      <NODE Name="{_esc(name)}" Type="1" KeyType="0" Entries="{len(ids)}">')
        out += [f'        <TRACK Key="{idx[i]}"/>' for i in ids]
        out.append("      </NODE>")
    out += ["    </NODE>", "  </PLAYLISTS>", "</DJ_PLAYLISTS>"]
    return "\n".join(out) + "\n"


def write_tracks(tracks: list[dict], playlists: list[tuple[str, list[int]]] = (), notation: str = "camelot",
                 overwrite: bool = True, swap_processed: bool = False, db_path: Path | None = None) -> dict:
    """Writes keys, hot/memory cues and playlists of Key Master tracks straight into master.db."""
    import os

    db, path = open_db(db_path)
    if is_live_db(path) and rekordbox_running():
        db.close()
        raise RuntimeError("Rekordbox is running. Please close Rekordbox and try again.")
    changes, missing, swapped = [], 0, 0
    contents = {}
    for t in tracks:
        c = (db.get_content(ID=t["rb_id"]) if t.get("rb_id") else None) or content_for_path(db, Path(t["path"]), t.get("size"))
        if c is None:
            missing += 1
            continue
        contents[t["id"]] = c
        ch = Change(c)
        k = keys.parse(t.get("key") or "")
        if k:
            set_key(db, c, k, notation, overwrite, ch)
        cues = [Cue(n, q["t"], q.get("name") or "") for n, q in enumerate(t.get("cues") or []) if q]
        set_cues(db, c, cues, list(t.get("memory") or []), overwrite, ch)
        changes.append(ch)
    for name, ids in playlists:
        pl = db.get_playlist(Name=name).first() or db.create_playlist(name)
        have = {str(s.ID) for s in db.get_playlist_contents(pl).all()}
        for i in ids:
            c = contents.get(i)
            if c is not None and str(c.ID) not in have:
                db.add_to_playlist(pl, c)
    backup_path = backup(path)
    commit(db, path)
    if swap_processed:
        for t in tracks:
            c = contents.get(t["id"])
            if c is not None and t.get("processed_path") and os.path.exists(t["processed_path"]) and c.FolderPath != t["processed_path"]:
                db.update_content_path(c, t["processed_path"], save=True, check_path=True, commit=False)
                swapped += 1
        if swapped:
            commit(db, path)
    db.close()
    return {"keys": sum(1 for c in changes if c.new_key), "cues": sum(len(c.cues) for c in changes),
            "tracks": len(changes), "missing": missing, "swapped": swapped, "backup": str(backup_path)}
