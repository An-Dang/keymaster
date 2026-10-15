"""Key Master command line.

  keymaster app                           start the local app with 2 decks
  keymaster build                         build keymaster.html from ui.html + JS
  keymaster analyze PATH...               show key, BPM, energy (and cues)
  keymaster rekordbox analyze ...         analyze and write into the Rekordbox database
  keymaster rekordbox import-xml FILE     write keys/cues from the browser export into the database
"""

import argparse
import json
import sys
from pathlib import Path

from . import __version__


def _analysis_mod():
    # Imported lazily: librosa/essentia take a few seconds to load and "build" does not need them.
    from . import analysis
    return analysis


def cmd_app(args) -> int:
    from .server import run

    print(f"Key Master is running at http://127.0.0.1:{args.port}/  (stop with Ctrl+C)")
    run(port=args.port, open_browser=not args.no_browser)
    return 0


def cmd_build(args) -> int:
    from .build import build

    print(f"Built: {build()}")
    return 0


def cmd_analyze(args) -> int:
    an = _analysis_mod()
    from .rekordbox import audio_files

    results = []
    for f in audio_files(args.paths):
        try:
            r = an.analyze(f, args.engine, auto_cues=args.cues)
        except Exception as e:  # noqa: BLE001 - keep going with the other files
            print(f"  ERROR  {f.name}: {e}", file=sys.stderr)
            continue
        print(f"{r.key.camelot:>4} {r.key.classic:<4} {r.bpm:6.2f} BPM  E{r.energy:<2}  {f.name}")
        for c in r.cues:
            print(f"        {'ABCDEFGH'[c.slot]} {c.t:7.2f}s {c.name}")
        results.append({
            "path": str(f), "duration": round(r.duration, 2), "bpm": r.bpm, "firstBeat": round(r.first_beat, 3),
            "key": r.key.camelot, "keyClassic": r.key.classic, "keyStrength": round(r.key.strength, 3),
            "energy": r.energy, "cues": [{"slot": c.slot, "t": round(c.t, 3), "name": c.name} for c in r.cues],
        })
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"JSON: {args.json}")
    return 0


def _open_for(args):
    from . import rekordbox as rb

    live = rb.is_live_db(args.db or rb.default_db_path())
    if args.write and live and rb.rekordbox_running():
        sys.exit("Rekordbox is running. Please close Rekordbox and run again.")
    db, path = rb.open_db(args.db)
    return rb, db, path


def _report(changes, write: bool) -> None:
    n_keys = sum(1 for c in changes if c.new_key)
    n_cues = sum(len(c.cues) for c in changes)
    for ch in (c for c in changes if not c.empty):
        title = f"{ch.content.Title or ch.content.FileNameL}"
        parts = []
        if ch.new_key:
            parts.append(f"Key {ch.old_key or '–'} → {ch.new_key}")
        if ch.cues:
            parts.append("Cues: " + ", ".join(ch.cues))
        print(f"  {title}: " + "; ".join(parts))
    verb = "Written" if write else "Would write (dry run, use --write to write for real)"
    print(f"{verb}: {n_keys} keys, {n_cues} cues in {sum(1 for c in changes if not c.empty)} tracks")


def _commit(rb, db, path, changes, write: bool) -> None:
    _report(changes, write)
    if write and any(not c.empty for c in changes):
        print(f"Backup: {rb.backup(path)}")
        rb.commit(db, path)
    else:
        db.rollback()
    db.close()


def cmd_rb_analyze(args) -> int:
    an = _analysis_mod()
    rb, db, path = _open_for(args)
    if args.playlist:
        contents = rb.playlist_contents(db, args.playlist)
    elif args.paths:
        contents = []
        for f in rb.audio_files(args.paths):
            c = rb.content_for_path(db, f)
            if c is None:
                print(f"  not in the collection: {f}", file=sys.stderr)
            else:
                contents.append(c)
    else:
        sys.exit("Please pass --playlist NAME or files/folders.")
    if args.only_missing:
        contents = [c for c in contents if not c.Key]

    changes = []
    for i, c in enumerate(contents, 1):
        f = Path(c.FolderPath or "")
        print(f"[{i}/{len(contents)}] {c.Title or f.name}", flush=True)
        if not f.exists():
            print("  file missing, skipped", file=sys.stderr)
            continue
        try:
            r = an.analyze(f, args.engine, auto_cues=args.cues)
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR: {e}", file=sys.stderr)
            continue
        rb_bpm = (c.BPM or 0) / 100
        print(f"  {r.key.camelot} ({r.key.classic})  {r.bpm:.2f} BPM (Rekordbox {rb_bpm:.2f})  Energy {r.energy}")
        ch = rb.Change(c)
        if not args.no_keys:
            rb.set_key(db, c, r.key, args.notation, args.overwrite, ch)
        if args.cues:
            rb.set_cues(db, c, r.cues, [], args.overwrite, ch)
        changes.append(ch)
    _commit(rb, db, path, changes, args.write)
    return 0


def cmd_rb_import_xml(args) -> int:
    rb, db, path = _open_for(args)
    changes, missing = [], 0
    for t in rb.read_xml(args.file):
        c = rb.content_for_path(db, t.path, t.size)
        if c is None:
            missing += 1
            print(f"  not in the collection: {t.path}", file=sys.stderr)
            continue
        ch = rb.Change(c)
        if t.key and not args.no_keys:
            rb.set_key(db, c, t.key, args.notation, args.overwrite, ch)
        if not args.no_cues:
            rb.set_cues(db, c, t.cues, t.memory if args.memory_cues else [], args.overwrite, ch)
        changes.append(ch)
    if missing:
        print(f"{missing} tracks not found. Are they imported in Rekordbox, and is the path in the export right?",
              file=sys.stderr)
    _commit(rb, db, path, changes, args.write)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="keymaster", description="Key Master: key, BPM and cue analysis for Rekordbox")
    p.add_argument("--version", action="version", version=f"Key Master {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    ap = sub.add_parser("app", help="start the local Key Master app (2 decks, library, loudness)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="do not open the browser automatically")
    ap.set_defaults(fn=cmd_app)

    sub.add_parser("build", help="build keymaster.html from ui.html, analysis.js and export.js").set_defaults(fn=cmd_build)

    def engine_arg(sp):
        sp.add_argument("--engine", choices=["essentia", "librosa"],
                        help="analysis engine (default: essentia if installed)")

    a = sub.add_parser("analyze", help="analyze files/folders and show the result")
    a.add_argument("paths", nargs="+", type=Path)
    a.add_argument("--cues", action="store_true", help="suggest automatic phrase cues")
    a.add_argument("--json", help="also save the result as JSON")
    engine_arg(a)
    a.set_defaults(fn=cmd_analyze)

    r = sub.add_parser("rekordbox", aliases=["rb"], help="write straight into the Rekordbox database")
    rsub = r.add_subparsers(dest="rbcmd", required=True)

    def common(sp):
        sp.add_argument("--write", action="store_true", help="actually write (without: dry run only)")
        sp.add_argument("--overwrite", action="store_true", help="replace existing keys and hot cues")
        sp.add_argument("--notation", choices=["camelot", "classic"], default="camelot",
                        help="store keys as 8A (camelot, default) or Am (classic)")
        sp.add_argument("--no-keys", action="store_true", help="do not write keys")
        sp.add_argument("--db", type=Path, help="path to master.db (default: automatic)")

    ra = rsub.add_parser("analyze", help="analyze collection tracks and write keys/cues")
    ra.add_argument("paths", nargs="*", type=Path, help="files or folders (must be in the collection)")
    ra.add_argument("--playlist", help="all tracks of this playlist")
    ra.add_argument("--only-missing", action="store_true", help="only tracks without a key")
    ra.add_argument("--cues", action="store_true", help="write automatic phrase cues as hot cues")
    common(ra)
    engine_arg(ra)
    ra.set_defaults(fn=cmd_rb_analyze)

    rx = rsub.add_parser("import-xml", help="take keys and cues from rekordbox.xml (browser export)")
    rx.add_argument("file", type=Path)
    rx.add_argument("--no-cues", action="store_true", help="do not write cues")
    rx.add_argument("--memory-cues", action="store_true", help="also write memory cues from the XML")
    common(rx)
    rx.set_defaults(fn=cmd_rb_import_xml)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
