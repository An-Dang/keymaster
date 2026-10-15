"""Local Key Master library: tracks, user edits (grid, cues, key), loudness, playlists and saved mashups.

Stored in SQLite under the user data dir; per-track caches (waveform, stems, pitch renders) next to it.
"""

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from platformdirs import user_data_dir

DATA_DIR = Path(os.environ.get("KEYMASTER_DATA") or user_data_dir("Key Master", appauthor=False))
CACHE_DIR = DATA_DIR / "cache"
AUDIO_EXT = {".mp3", ".wav", ".aif", ".aiff", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".alac"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS tracks (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  size INTEGER, mtime REAL,
  title TEXT, artist TEXT, genre TEXT,
  duration REAL, sample_rate INTEGER,
  bpm REAL, first_beat REAL, key TEXT, key_strength REAL, energy INTEGER,
  bpm_detected REAL, first_beat_detected REAL, key_detected TEXT,
  lufs REAL, peak_db REAL, clipped INTEGER,
  cues TEXT, memory TEXT,
  rating INTEGER DEFAULT 0,
  rb_id TEXT, processed_path TEXT,
  status TEXT DEFAULT 'new', error TEXT,
  analyzed_at REAL, updated_at REAL
);
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, source TEXT DEFAULT 'local', rb_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id INTEGER, track_id INTEGER, pos INTEGER,
  PRIMARY KEY (playlist_id, pos)
);
CREATE TABLE IF NOT EXISTS mashups (
  id INTEGER PRIMARY KEY, a_id INTEGER, b_id INTEGER, a_shift INTEGER DEFAULT 0, b_shift INTEGER DEFAULT 0,
  a_stem TEXT, b_stem TEXT, rating INTEGER DEFAULT 0, note TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
"""

# Columns the UI may change directly.
EDITABLE = {"bpm", "first_beat", "key", "cues", "memory", "rating", "title", "artist", "genre"}
JSON_COLS = {"cues", "memory"}


def empty_cues() -> list:
    return [None] * 8


class Library:
    def __init__(self, path: Path | None = None):
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_DIR.mkdir(exist_ok=True)
        self.path = path or DATA_DIR / "library.sqlite"
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ---------- tracks ----------

    def _row(self, r: sqlite3.Row | None) -> dict | None:
        if r is None:
            return None
        d = dict(r)
        for c in JSON_COLS:
            d[c] = json.loads(d[c]) if d[c] else (empty_cues() if c == "cues" else [])
        return d

    def tracks(self) -> list[dict]:
        with self._lock:
            return [self._row(r) for r in self.db.execute("SELECT * FROM tracks ORDER BY artist COLLATE NOCASE, title COLLATE NOCASE")]

    def track(self, tid: int) -> dict | None:
        with self._lock:
            return self._row(self.db.execute("SELECT * FROM tracks WHERE id=?", (tid,)).fetchone())

    def by_path(self, path: str) -> dict | None:
        with self._lock:
            return self._row(self.db.execute("SELECT * FROM tracks WHERE path=?", (path,)).fetchone())

    def add_file(self, path: Path, **fields) -> int:
        st = path.stat()
        title, artist = split_name(path.stem)
        base = {"path": str(path), "size": st.st_size, "mtime": st.st_mtime, "title": title, "artist": artist,
                "cues": json.dumps(empty_cues()), "memory": "[]", "updated_at": time.time()}
        base.update({k: (json.dumps(v) if k in JSON_COLS else v) for k, v in fields.items()})
        with self._lock:
            old = self.db.execute("SELECT id FROM tracks WHERE path=?", (str(path),)).fetchone()
            if old:
                return old["id"]
            cols = ",".join(base)
            cur = self.db.execute(f"INSERT INTO tracks ({cols}) VALUES ({','.join('?' * len(base))})", tuple(base.values()))
            self.db.commit()
            return cur.lastrowid

    def update(self, tid: int, **fields) -> dict:
        if fields:
            fields["updated_at"] = time.time()
            vals = [json.dumps(v) if k in JSON_COLS else v for k, v in fields.items()]
            with self._lock:
                self.db.execute(f"UPDATE tracks SET {','.join(f'{k}=?' for k in fields)} WHERE id=?", (*vals, tid))
                self.db.commit()
        return self.track(tid)

    def delete(self, tid: int) -> None:
        with self._lock:
            self.db.execute("DELETE FROM tracks WHERE id=?", (tid,))
            self.db.execute("DELETE FROM playlist_tracks WHERE track_id=?", (tid,))
            self.db.commit()

    def scan_folder(self, folder: Path, recursive: bool = True) -> list[int]:
        ids = []
        folder = folder.expanduser()
        for f in sorted(folder.rglob("*") if recursive else folder.iterdir()):
            # Skip macOS junk on USB sticks (._ files, .Trashes, .Spotlight-V100, ...).
            hidden = any(part.startswith(".") for part in f.relative_to(folder).parts)
            if f.suffix.lower() in AUDIO_EXT and not hidden and f.is_file():
                ids.append(self.add_file(f))
        return ids

    # ---------- playlists ----------

    def playlists(self) -> list[dict]:
        with self._lock:
            rows = self.db.execute(
                "SELECT p.*, COUNT(pt.track_id) AS n FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id "
                "GROUP BY p.id ORDER BY p.source DESC, p.name COLLATE NOCASE").fetchall()
            return [dict(r) for r in rows]

    def playlist_track_ids(self, pid: int) -> list[int]:
        with self._lock:
            return [r[0] for r in self.db.execute("SELECT track_id FROM playlist_tracks WHERE playlist_id=? ORDER BY pos", (pid,))]

    def save_playlist(self, name: str, track_ids: list[int], source: str = "local", rb_id: str | None = None,
                      pid: int | None = None) -> int:
        with self._lock:
            if pid is None and rb_id:
                r = self.db.execute("SELECT id FROM playlists WHERE rb_id=?", (rb_id,)).fetchone()
                pid = r["id"] if r else None
            if pid is None:
                pid = self.db.execute("INSERT INTO playlists (name, source, rb_id) VALUES (?,?,?)", (name, source, rb_id)).lastrowid
            else:
                self.db.execute("UPDATE playlists SET name=? WHERE id=?", (name, pid))
            self.db.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
            self.db.executemany("INSERT INTO playlist_tracks VALUES (?,?,?)", [(pid, t, i) for i, t in enumerate(track_ids)])
            self.db.commit()
            return pid

    def delete_playlist(self, pid: int) -> None:
        with self._lock:
            self.db.execute("DELETE FROM playlists WHERE id=?", (pid,))
            self.db.execute("DELETE FROM playlist_tracks WHERE playlist_id=?", (pid,))
            self.db.commit()

    # ---------- mashups ----------

    def mashups(self) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.db.execute("SELECT * FROM mashups ORDER BY rating DESC, created_at DESC")]

    def save_mashup(self, **m) -> int:
        m.setdefault("created_at", time.time())
        with self._lock:
            cur = self.db.execute(f"INSERT INTO mashups ({','.join(m)}) VALUES ({','.join('?' * len(m))})", tuple(m.values()))
            self.db.commit()
            return cur.lastrowid

    def update_mashup(self, mid: int, **m) -> None:
        with self._lock:
            self.db.execute(f"UPDATE mashups SET {','.join(f'{k}=?' for k in m)} WHERE id=?", (*m.values(), mid))
            self.db.commit()

    def delete_mashup(self, mid: int) -> None:
        with self._lock:
            self.db.execute("DELETE FROM mashups WHERE id=?", (mid,))
            self.db.commit()

    # ---------- settings ----------

    def settings(self) -> dict:
        with self._lock:
            return {r["k"]: json.loads(r["v"]) for r in self.db.execute("SELECT * FROM settings")}

    def set_settings(self, **kv) -> dict:
        with self._lock:
            self.db.executemany("INSERT OR REPLACE INTO settings VALUES (?,?)", [(k, json.dumps(v)) for k, v in kv.items()])
            self.db.commit()
        return self.settings()


def split_name(stem: str) -> tuple[str, str]:
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
        return title.strip(), artist.strip()
    return stem, ""


def cache_dir(tid: int) -> Path:
    d = CACHE_DIR / str(tid)
    d.mkdir(parents=True, exist_ok=True)
    return d
