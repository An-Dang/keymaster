"""Key Master local app: FastAPI server for the two-deck UI in app/.

Runs only on 127.0.0.1. Heavy work (analysis, stems, key shift, volume processing) runs in
background job lanes; the UI polls /api/jobs.
"""

import heapq
import itertools
import os
import subprocess
import threading
import time
import traceback
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from . import analysis, audio, keys, suggest
from . import rekordbox as rb
from .library import AUDIO_EXT, CACHE_DIR, EDITABLE, Library, cache_dir

APP_DIR = Path(__file__).resolve().parent.parent / "app"
STEMS_OUT = Path.home() / "Music" / "Key Master" / "Stems"

DEFAULT_SETTINGS = {
    "autogain": True,  # 'Level volume' in the player
    "preset": "festival",  # target loudness for player + processing
    "repair": True,
    "contrast": False,
    "out_mode": "suffix",  # 'suffix' = next to original with _KM, 'folder' = into out_folder
    "out_folder": str(Path.home() / "Music" / "Key Master" / "Processed"),
    "notation": "camelot",
    "auto_analyze": True,
    "quantize": True,  # snap cues/loops to the beat and keep beat phase on hot cue jumps
    "folders": [],  # folders added to the library (shown in the sidebar)
}


GRID_SINCE = 1792135378  # grid detection switched to Beat This! beats/downbeats; older analyses get redone
AUTO_CUE_NAMES = {"Start", "Drop", "Break"}  # names phrase_cues() gives; other names mean the user edited the cues


# ---------- jobs ----------

class Jobs:
    """Priority job lanes: 'analysis' (2 workers) and 'render' (1 worker, stems/pitch/processing)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._queues: dict[str, list] = {"analysis": [], "render": []}
        self._seq = itertools.count()
        self.jobs: dict[int, dict] = {}
        self._pending_keys: dict[str, int] = {}
        for lane, n in (("analysis", 2), ("render", 1)):
            for _ in range(n):
                threading.Thread(target=self._worker, args=(lane,), daemon=True).start()

    def submit(self, lane: str, kind: str, label: str, fn, key: str | None = None, priority: int = 5,
               track_id: int | None = None) -> dict:
        with self._lock:
            if key and key in self._pending_keys:
                job = self.jobs[self._pending_keys[key]]
                if job["state"] in ("queued", "running"):
                    if priority < job["priority"] and job["state"] == "queued":
                        job["priority"] = priority
                        heapq.heappush(self._queues[lane], (priority, next(self._seq), job["id"]))
                    return job
            jid = next(self._seq)
            job = {"id": jid, "lane": lane, "kind": kind, "label": label, "track_id": track_id, "state": "queued",
                   "progress": 0.0, "error": None, "result": None, "priority": priority, "created": time.time(),
                   "_fn": fn, "_key": key}
            self.jobs[jid] = job
            if key:
                self._pending_keys[key] = jid
            heapq.heappush(self._queues[lane], (priority, jid, jid))
            self._cv.notify_all()
            return job

    def _worker(self, lane: str):
        while True:
            with self._lock:
                while True:
                    while self._queues[lane]:
                        prio, _, jid = heapq.heappop(self._queues[lane])
                        job = self.jobs.get(jid)
                        if job and job["state"] == "queued" and prio == job["priority"]:
                            break
                    else:
                        self._cv.wait()
                        continue
                    break
                job["state"] = "running"
                job["started"] = time.time()
            try:
                job["result"] = job["_fn"](lambda p: job.__setitem__("progress", float(p)))
                job["state"], job["progress"] = "done", 1.0
            except Exception as e:  # noqa: BLE001 - surfaced to the UI
                job["state"], job["error"] = "error", str(e)
                traceback.print_exc()
            job["finished"] = time.time()

    def public(self, since: float = 0) -> list[dict]:
        cutoff = time.time() - 120
        out = []
        for j in list(self.jobs.values()):
            if j["state"] in ("done", "error") and j.get("finished", 0) < cutoff:
                continue
            out.append(pub(j))
        return out

    def counts(self) -> dict:
        c = {"queued": 0, "running": 0}
        for j in self.jobs.values():
            if j["state"] in c:
                c[j["state"]] += 1
        return c


def pub(job: dict) -> dict:
    return {k: v for k, v in job.items() if not k.startswith("_")}


# ---------- app ----------

def create_app() -> FastAPI:
    lib = Library()
    jobs = Jobs()
    settings = {**DEFAULT_SETTINGS, **lib.settings()}
    app = FastAPI(title="Key Master")

    def track_or_404(tid: int) -> dict:
        t = lib.track(tid)
        if not t:
            raise HTTPException(404, "Track not found")
        return t

    # ----- analysis -----

    def analyze_job(tid: int):
        def run(progress):
            t = lib.track(tid)
            if not t:
                return None
            path = Path(t["path"])
            if not path.exists():
                lib.update(tid, status="missing", error="File not found")
                raise FileNotFoundError(f"File missing: {path}")
            lib.update(tid, status="analyzing")
            x, sr = audio.load_stereo(path)
            progress(0.2)
            mono = audio.to_mono_44k(x, sr)
            r = analysis.analyze(path, auto_cues=True, y=mono, sr=44100)
            progress(0.6)
            wave = analysis.waveform(mono, 44100)
            (cache_dir(tid) / "wave.bin").write_bytes(wave.tobytes())
            loud = audio.measure(x, sr)
            progress(0.9)
            t = lib.track(tid)
            upd = {"duration": r.duration, "sample_rate": sr, "energy": r.energy, "key_strength": r.key.strength,
                   "bpm_detected": r.bpm, "first_beat_detected": r.first_beat, "key_detected": r.key.camelot,
                   "lufs": loud["lufs"], "peak_db": loud["peak_db"], "clipped": loud["clipped"],
                   "status": "ready", "error": None, "analyzed_at": time.time()}
            # The grid follows the analysis unless it was edited by hand or came from Rekordbox
            # (then bpm/first_beat differ from the last detected values).
            grid_auto = not t.get("bpm") or (t.get("bpm") == t.get("bpm_detected")
                                             and t.get("first_beat") == t.get("first_beat_detected"))
            if grid_auto:
                upd["bpm"], upd["first_beat"] = r.bpm, r.first_beat
            elif t.get("first_beat") is None:
                upd["first_beat"] = r.first_beat
            if not t.get("key"):
                upd["key"] = r.key.camelot
            auto_named = all(c is None or c.get("name") in AUTO_CUE_NAMES for c in t["cues"])
            if not any(t["cues"]) or (grid_auto and auto_named):
                cues = [None] * 8
                for c in r.cues:
                    cues[c.slot] = {"t": round(c.t, 3), "name": c.name}
                upd["cues"] = cues
            lib.update(tid, **upd)
            return {"track_id": tid}
        return run

    def enqueue_analysis(tid: int, priority: int = 5) -> dict:
        t = lib.track(tid)
        name = (t or {}).get("title") or str(tid)
        return jobs.submit("analysis", "analyze", f"Analysis: {name}", analyze_job(tid), key=f"an:{tid}",
                           priority=priority, track_id=tid)

    def regrid_old(priority: int = 6):
        """Re-analyses tracks analysed before the current grid detection; repeats until all are done."""
        for t in lib.tracks():
            if t["status"] == "ready" and (t.get("analyzed_at") or 0) < GRID_SINCE and os.path.exists(t["path"]):
                enqueue_analysis(t["id"], priority)

    def retry_reappeared(priority: int = 5):
        """Tracks marked missing (e.g. USB stick or drive unplugged) are analysed again once their file is back."""
        for t in lib.tracks():
            if t["status"] == "missing" and os.path.exists(t["path"]):
                enqueue_analysis(t["id"], priority)

    def watch():
        enqueue_missing()
        while True:
            regrid_old()
            retry_reappeared()
            time.sleep(20)

    def enqueue_missing(priority: int = 5):
        for t in lib.tracks():
            if t["status"] in ("new", "analyzing") or not (CACHE_DIR / str(t["id"]) / "wave.bin").exists():
                if t["status"] != "missing":
                    enqueue_analysis(t["id"], priority)

    if settings.get("auto_analyze"):
        threading.Thread(target=watch, daemon=True).start()

    # ----- audio variants (stems, key shift) -----

    def variant_path(tid: int, stem: str, shift: int) -> Path:
        t = lib.track(tid)
        if stem == "mix" and shift == 0:
            return Path(t["path"])
        return cache_dir(tid) / f"{stem}_{shift:+d}.flac"

    def render_job(tid: int, stem: str, shift: int):
        def run(progress):
            t = track_or_404(tid)
            dest = variant_path(tid, stem, shift)
            if dest.exists():
                return {"ready": True}
            if stem != "mix":
                base = variant_path(tid, stem, 0)
                if not base.exists():
                    x, sr = audio.load_stereo(Path(t["path"]))
                    parts = audio.separate(x, sr, progress=lambda p: progress(p * (0.7 if shift else 1)))
                    for name, data in parts.items():
                        audio.write(variant_path(tid, name, 0), data, sr)
                if shift == 0:
                    return {"ready": True}
                x, sr = audio.load_stereo(base)
            else:
                x, sr = audio.load_stereo(Path(t["path"]))
            progress(0.75)
            audio.write(dest, audio.pitch_shift(x, sr, shift), sr)
            return {"ready": True}
        return run

    # ----- routes: state & library -----

    @app.get("/", response_class=HTMLResponse)
    def index():
        return (APP_DIR / "index.html").read_text(encoding="utf-8")

    app.mount("/app", StaticFiles(directory=APP_DIR), name="app")

    @app.get("/api/state")
    def state():
        return {"tracks": lib.tracks(), "playlists": lib.playlists(), "settings": settings,
                "presets": {k: vars(p) for k, p in audio.PRESETS.items()}, "engines": list(analysis.ENGINES),
                "stems": audio.stems_available(), "mashups": lib.mashups(), "rekordbox_running": rb.rekordbox_running()}

    @app.get("/api/tracks")
    def tracks():
        return lib.tracks()

    @app.patch("/api/tracks/{tid}")
    def patch_track(tid: int, body: dict = Body(...)):
        track_or_404(tid)
        bad = set(body) - EDITABLE
        if bad:
            raise HTTPException(400, f"Not editable: {', '.join(sorted(bad))}")
        if "key" in body and body["key"] and not keys.parse(body["key"]):
            raise HTTPException(400, "Unknown key")
        if "key" in body and body["key"]:
            body["key"] = keys.parse(body["key"]).camelot
        return lib.update(tid, **body)

    @app.delete("/api/tracks/{tid}")
    def delete_track(tid: int):
        lib.delete(tid)
        return {"ok": True}

    @app.post("/api/tracks/{tid}/analyze")
    def reanalyze(tid: int, body: dict = Body(default={})):
        track_or_404(tid)
        if body.get("reset"):
            t = lib.track(tid)
            lib.update(tid, bpm=t.get("bpm_detected"), first_beat=t.get("first_beat_detected"), key=t.get("key_detected"))
        return pub(enqueue_analysis(tid, priority=1))

    @app.post("/api/tracks/{tid}/priority")
    def prioritize(tid: int):
        """Called when a track is loaded into a deck: analyse it before everything else."""
        t = track_or_404(tid)
        if t["status"] != "ready" or not (CACHE_DIR / str(tid) / "wave.bin").exists():
            enqueue_analysis(tid, priority=0)
        return {"ok": True}

    @app.get("/api/wave/{tid}")
    def wave(tid: int):
        f = CACHE_DIR / str(tid) / "wave.bin"
        if not f.exists():
            raise HTTPException(409, "Not analyzed yet")
        return Response(f.read_bytes(), media_type="application/octet-stream",
                        headers={"X-Wave-Rate": str(analysis.WAVE_RATE), "Cache-Control": "no-cache"})

    @app.get("/api/pcm/{tid}")
    def pcm(tid: int, stem: str = "mix"):
        """Decoded audio as 16-bit WAV for the decks.

        Decoding here (same decoder as the analysis) keeps beat grid and playback on one time base and
        plays formats the browser cannot decode (AIFF, ALAC).
        """
        import io

        import soundfile as sf

        track_or_404(tid)
        if stem not in ("mix", "vocals", "instrumental"):
            raise HTTPException(400, "Invalid stem")
        p = variant_path(tid, stem, 0)
        if not p.exists():
            raise HTTPException(409 if stem != "mix" else 404, "Stem not rendered yet" if stem != "mix" else "File not found")
        x, sr = audio.load_stereo(p)
        buf = io.BytesIO()
        sf.write(buf, np.clip(x, -1, 1), sr, format="WAV", subtype="PCM_16")
        return Response(buf.getvalue(), media_type="audio/wav", headers={"Cache-Control": "no-store"})

    @app.post("/api/tracks/{tid}/render")
    def render(tid: int, body: dict = Body(...)):
        t = track_or_404(tid)
        stem, shift = body.get("stem", "mix"), int(body.get("shift", 0))
        if stem not in ("mix", "vocals", "instrumental") or abs(shift) > 6:
            raise HTTPException(400, "Invalid variant")
        if stem != "mix" and not audio.stems_available():
            raise HTTPException(400, "Stem separation is not installed (pip install demucs)")
        if variant_path(tid, stem, shift).exists():
            return {"ready": True}
        what = {"mix": "Key", "vocals": "Vocals", "instrumental": "Instrumental"}[stem]
        label = f"{what}{f' {shift:+d}' if shift else ''}: {t.get('title')}"
        job = jobs.submit("render", "render", label, render_job(tid, stem, shift), key=f"r:{tid}:{stem}:{shift}",
                          priority=1, track_id=tid)
        return {"ready": False, "job": job["id"]}

    @app.post("/api/stems/export")
    def export_stem(body: dict = Body(...)):
        tid, stem, shift = int(body["track_id"]), body.get("stem", "vocals"), int(body.get("shift", 0))
        t = track_or_404(tid)
        src = variant_path(tid, stem, shift)
        if not src.exists():
            raise HTTPException(409, "Render the stem first")
        STEMS_OUT.mkdir(parents=True, exist_ok=True)
        name = f"{t.get('artist') + ' - ' if t.get('artist') else ''}{t.get('title')}"
        k = t.get("key")
        tag = f"{stem}{f' {shift:+d}' if shift else ''}{f' {suggest.shift_camelot(k, shift)}' if k else ''}"
        dest = STEMS_OUT / f"{name} [{tag}].flac".replace("/", "-")
        import shutil

        shutil.copy2(src, dest)
        audio.copy_tags(Path(t["path"]), dest)
        return {"path": str(dest)}

    @app.post("/api/reveal")
    def reveal(body: dict = Body(...)):
        p = Path(body["path"])
        if not p.exists():
            raise HTTPException(404, "Not found")
        subprocess.run(["open", "-R", str(p)], check=False)
        return {"ok": True}

    # ----- folders / rekordbox -----

    def remember_folder(folder: Path) -> None:
        folders = [f for f in settings.get("folders", []) if f != str(folder)] + [str(folder)]
        settings["folders"] = folders
        lib.set_settings(folders=folders)

    @app.post("/api/folders")
    def add_folder(body: dict = Body(default={})):
        path = body.get("path")
        if not path:
            r = subprocess.run(["osascript", "-e", 'POSIX path of (choose folder with prompt "Choose a music folder for Key Master")'],
                               capture_output=True, text=True)
            path = r.stdout.strip()
            if not path:
                return {"added": 0, "cancelled": True}
        folder = Path(path).expanduser()
        if not folder.is_dir():
            raise HTTPException(400, f"Not a folder: {folder}")
        ids = lib.scan_folder(folder, recursive=bool(body.get("recursive", True)))
        for tid in ids:
            if lib.track(tid)["status"] != "ready":
                enqueue_analysis(tid)
        remember_folder(folder)
        return {"added": len(ids), "path": str(folder), "folders": settings["folders"]}

    @app.delete("/api/folders")
    def remove_folder(path: str, tracks: int = 1):
        """Forgets a folder; with tracks=1 also removes its tracks from the library (files stay on disk)."""
        folder = str(Path(path))
        settings["folders"] = [f for f in settings.get("folders", []) if f != folder]
        lib.set_settings(folders=settings["folders"])
        removed = 0
        if tracks:
            prefix = folder.rstrip("/") + "/"
            for t in lib.tracks():
                if t["path"].startswith(prefix):
                    lib.delete(t["id"])
                    removed += 1
        return {"removed": removed, "folders": settings["folders"]}

    # ----- file system browser (USB sticks, music folders) -----

    @app.get("/api/fs/roots")
    def fs_roots():
        home = Path.home()
        roots = []
        for name, p in (("Music", home / "Music"), ("Downloads", home / "Downloads"), ("Desktop", home / "Desktop"), ("Home", home)):
            if p.is_dir():
                roots.append({"name": name, "path": str(p), "kind": "folder"})
        vols = Path("/Volumes")
        if vols.is_dir():
            for v in sorted(vols.iterdir(), key=lambda x: x.name.lower()):
                try:
                    if v.is_symlink() and os.path.realpath(v) == "/":
                        continue  # the system disk
                    if v.is_dir() and not v.name.startswith("."):
                        roots.append({"name": v.name, "path": str(v), "kind": "drive"})
                except OSError:
                    continue
        return {"roots": roots}

    @app.get("/api/fs/list")
    def fs_list(path: str):
        d = Path(path).expanduser()
        if not d.is_dir():
            raise HTTPException(404, f"Folder not found: {d}")
        dirs, files = [], []
        known = {t["path"]: t for t in lib.tracks()}
        try:
            entries = sorted(d.iterdir(), key=lambda x: x.name.lower())
        except PermissionError:
            raise HTTPException(403, f"No permission to read {d}")
        for e in entries:
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir():
                    dirs.append({"name": e.name, "path": str(e)})
                elif e.suffix.lower() in AUDIO_EXT:
                    t = known.get(str(e))
                    files.append({"name": e.name, "path": str(e), "size": e.stat().st_size,
                                  "track_id": t["id"] if t else None})
            except OSError:
                continue
        parent = str(d.parent) if d.parent != d else None
        return {"path": str(d), "parent": parent, "dirs": dirs, "files": files}

    @app.post("/api/fs/track")
    def fs_track(body: dict = Body(...)):
        """Adds a single file (e.g. loaded straight from a USB stick) and analyses it first."""
        f = Path(body["path"]).expanduser()
        if not f.is_file() or f.suffix.lower() not in AUDIO_EXT:
            raise HTTPException(400, f"Not an audio file: {f}")
        tid = lib.add_file(f)
        if lib.track(tid)["status"] != "ready":
            enqueue_analysis(tid, priority=0)
        return lib.track(tid)

    @app.post("/api/rekordbox/import")
    def rb_import():
        def run(progress):
            res = rb.import_collection(lib, progress=progress)
            enqueue_missing()
            return res
        return pub(jobs.submit("render", "rbimport", "Load Rekordbox collection", run, key="rbimport", priority=0))

    @app.post("/api/rekordbox/write")
    def rb_write(body: dict = Body(...)):
        ids = body.get("track_ids") or []
        tracks_ = [lib.track(i) for i in ids if lib.track(i)]
        pls = [(p["name"], lib.playlist_track_ids(p["id"])) for p in lib.playlists() if p["id"] in set(body.get("playlist_ids") or [])]
        for _, pids in pls:
            tracks_ += [lib.track(i) for i in pids if i not in ids and lib.track(i)]
        try:
            return rb.write_tracks(tracks_, pls, notation=body.get("notation", settings["notation"]),
                                   overwrite=bool(body.get("overwrite", True)), swap_processed=bool(body.get("swap_processed")))
        except RuntimeError as e:
            raise HTTPException(409, str(e))

    @app.post("/api/export/xml")
    def export_xml(body: dict = Body(...)):
        ids = list(body.get("track_ids") or [])
        pls = [(p["name"], lib.playlist_track_ids(p["id"])) for p in lib.playlists() if p["id"] in set(body.get("playlist_ids") or [])]
        for _, pids in pls:
            ids += [i for i in pids if i not in ids]
        if body.get("all"):
            ids = [t["id"] for t in lib.tracks()]
        tracks_ = [t for t in (lib.track(i) for i in ids) if t]
        xml = rb.build_xml(tracks_, pls, notation=body.get("notation", settings["notation"]),
                           use_processed=bool(body.get("use_processed")))
        out = Path.home() / "Music" / "Key Master" / "rekordbox-keymaster.xml"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(xml, encoding="utf-8")
        return {"path": str(out), "tracks": len(tracks_), "playlists": len(pls)}

    # ----- tags -----

    @app.post("/api/tags")
    def write_tags(body: dict = Body(...)):
        import mutagen

        done, failed = 0, []
        for tid in body.get("track_ids") or []:
            t = lib.track(tid)
            k = keys.parse((t or {}).get("key") or "")
            if not t or not k:
                continue
            try:
                f = mutagen.File(t["path"], easy=True)
                if f is None:
                    raise ValueError("Format without tags")
                if f.tags is None:
                    f.add_tags()
                comment = f"{k.camelot} - Energy {t.get('energy') or '-'}"
                for field, val in (("initialkey", k.camelot), ("bpm", str(int(round(t.get("bpm") or 0))))):
                    try:
                        f.tags[field] = val
                    except (KeyError, ValueError):
                        pass
                f.save()
                full = mutagen.File(t["path"])
                if hasattr(full, "tags") and full.tags is not None and full.tags.__class__.__name__ == "ID3":
                    from mutagen.id3 import COMM

                    full.tags.setall("COMM", [COMM(encoding=3, lang="eng", desc="", text=comment)])
                    full.save()
                elif full is not None and full.tags is not None:
                    try:
                        full.tags["comment"] = comment
                        full.save()
                    except Exception:  # noqa: BLE001
                        pass
                done += 1
            except Exception as e:  # noqa: BLE001
                failed.append(f"{t.get('title')}: {e}")
        return {"written": done, "failed": failed}

    # ----- volume processing (Platinum Notes style) -----

    @app.post("/api/process")
    def process(body: dict = Body(...)):
        preset = audio.PRESETS.get(body.get("preset") or settings["preset"])
        if not preset:
            raise HTTPException(400, "Unknown preset")
        repair = bool(body.get("repair", settings["repair"]))
        use_contrast = bool(body.get("contrast", settings["contrast"]))
        out_mode = body.get("out_mode", settings["out_mode"])
        out_folder = Path(body.get("out_folder") or settings["out_folder"]).expanduser()
        created = []
        for tid in body.get("track_ids") or []:
            t = lib.track(tid)
            if not t:
                continue

            def run(progress, tid=tid):
                t = lib.track(tid)
                src = Path(t["path"])
                x, sr = audio.load_stereo(src)
                progress(0.2)
                y, rep = audio.process(x, sr, preset, repair=repair, use_contrast=use_contrast)
                progress(0.85)
                if out_mode == "folder":
                    out_folder.mkdir(parents=True, exist_ok=True)
                    dest = out_folder / src.name
                else:
                    dest = src.with_name(f"{src.stem}_KM{src.suffix}")
                if dest.resolve() == src.resolve():
                    raise RuntimeError("Output would overwrite the original file")
                dest = audio.write(dest, y, sr)
                audio.copy_tags(src, dest)
                lib.update(tid, processed_path=str(dest))
                return rep | {"path": str(dest)}

            job = jobs.submit("render", "process", f"{preset.name}: {t.get('title')}", run,
                              key=f"p:{tid}:{preset.key}:{repair}:{use_contrast}", priority=3, track_id=tid)
            created.append(job["id"])
        return {"jobs": created}

    # ----- suggestions, playlists, mashups -----

    def pool_for(playlist_id: int | None, genre: str | None) -> list[dict]:
        ts = lib.tracks()
        if playlist_id:
            ids = set(lib.playlist_track_ids(playlist_id))
            ts = [t for t in ts if t["id"] in ids]
        if genre:
            ts = [t for t in ts if (t.get("genre") or "").lower() == genre.lower()]
        return ts

    @app.get("/api/suggest/{tid}")
    def suggestions(tid: int, mode: str = "mashup", playlist: int | None = None, genre: str | None = None,
                    max_shift: int = 2, shift: int = 0):
        a = dict(track_or_404(tid))
        if shift and a.get("key"):
            a["key"] = suggest.shift_camelot(a["key"], shift)
        pool = pool_for(playlist, genre)
        if mode == "mixout":
            return suggest.mixouts(a, pool)
        return suggest.mashups(a, pool, max_shift=max_shift)

    @app.post("/api/set/order")
    def set_order(body: dict = Body(...)):
        ts = [t for t in (lib.track(i) for i in body.get("track_ids") or []) if t]
        return {"order": suggest.order_set(ts, body.get("start_id"), body.get("curve", "rise"))}

    @app.post("/api/playlists")
    def save_playlist(body: dict = Body(...)):
        pid = lib.save_playlist(body["name"], [int(i) for i in body.get("track_ids") or []], pid=body.get("id"))
        return {"id": pid, "playlists": lib.playlists()}

    @app.get("/api/playlists/{pid}")
    def playlist(pid: int):
        return {"track_ids": lib.playlist_track_ids(pid)}

    @app.delete("/api/playlists/{pid}")
    def delete_playlist(pid: int):
        lib.delete_playlist(pid)
        return {"playlists": lib.playlists()}

    @app.post("/api/mashups")
    def save_mashup(body: dict = Body(...)):
        allowed = {"a_id", "b_id", "a_shift", "b_shift", "a_stem", "b_stem", "rating", "note"}
        mid = lib.save_mashup(**{k: v for k, v in body.items() if k in allowed})
        return {"id": mid, "mashups": lib.mashups()}

    @app.patch("/api/mashups/{mid}")
    def patch_mashup(mid: int, body: dict = Body(...)):
        lib.update_mashup(mid, **{k: v for k, v in body.items() if k in {"rating", "note"}})
        return {"mashups": lib.mashups()}

    @app.delete("/api/mashups/{mid}")
    def delete_mashup(mid: int):
        lib.delete_mashup(mid)
        return {"mashups": lib.mashups()}

    # ----- settings & jobs -----

    @app.patch("/api/settings")
    def patch_settings(body: dict = Body(...)):
        unknown = set(body) - set(DEFAULT_SETTINGS)
        if unknown:
            raise HTTPException(400, f"Unknown setting: {', '.join(unknown)}")
        settings.update(body)
        lib.set_settings(**body)
        return settings

    @app.get("/api/jobs")
    def job_list():
        return {"jobs": jobs.public(), "counts": jobs.counts()}

    @app.get("/api/changes")
    def changes(since: float = 0):
        """Tracks updated after `since` (epoch seconds), so the UI can refresh analysed rows cheaply."""
        return {"now": time.time(), "tracks": [t for t in lib.tracks() if (t.get("updated_at") or 0) > since]}

    return app


def run(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True) -> None:
    import uvicorn

    if open_browser:
        threading.Timer(1.2, lambda: subprocess.run(["open", f"http://{host}:{port}/"], check=False)).start()
    uvicorn.run(create_app(), host=host, port=port, log_level="warning")
