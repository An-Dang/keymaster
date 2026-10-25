# Key Master

Key, BPM, cue and loudness tool for DJs that works with your Rekordbox library. It comes in three parts:

- **Local app** (`keymaster app`): two decks side by side, library, mashup and mix ideas, set builder, volume leveling, export to Rekordbox.
- **Command line** (`keymaster analyze`, `keymaster rb …`): analysis and direct writes into the Rekordbox database.
- **Browser tool** `keymaster.html`: no install, analysis in the browser, Rekordbox XML export.

Everything runs on your own computer; no audio or library data leaves it.

> **Status:** early (0.x). Developed and tested on macOS with Rekordbox 7. Windows and Linux are untested.
> **Back up your Rekordbox library** before writing to it. Key Master makes its own backup before every write, but use it at your own risk.

## Requirements

- macOS (Apple Silicon recommended for stems)
- Python 3.11 or newer
- Rekordbox (only for the Rekordbox features)
- `ffmpeg` for M4A/AAC without essentia: `brew install ffmpeg`

## Setup

```bash
git clone https://github.com/An-Dang/keymaster.git
cd keymaster
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[app,beats,stems]"
```

| Extra | Adds | License |
| --- | --- | --- |
| `app` | Local app (FastAPI server, loudness, tags) | MIT / BSD; mutagen GPL-2.0+, soxr LGPL-2.1+ |
| `beats` | [Beat This!](https://github.com/CPJKU/beat_this) model for accurate beatgrids | MIT |
| `stems` | [Demucs](https://github.com/facebookresearch/demucs) stem separation | MIT |
| `essentia` | [essentia](https://essentia.upf.edu/) key/BPM engine (EDM key profile) | AGPL-3.0 |

Without `essentia`, everything runs on librosa. To add it: `pip install -e ".[essentia]"`.

The browser tool needs no setup: open `keymaster.html` in a browser.

## Local app

```bash
keymaster app
```

This opens `http://127.0.0.1:8765/` in your browser. The server only listens on your computer.
Library and caches live in `~/Library/Application Support/Key Master/`.
To start with a separate, empty library: `KEYMASTER_DATA=~/Music/"Key Master Test" keymaster app`.

| Area | What it does |
| --- | --- |
| Files | Browse USB sticks, drives and folders; load a file straight into deck A/B (it is added to the library and analyzed first) or add a whole folder (with or without subfolders). Added folders show up in the library sidebar as a tree with their subfolders (counts include deeper folders) and can be removed again (files stay on disk) |
| Background jobs | **Stop** in the header cancels all queued and running jobs (Rekordbox import, analyses, processing, stems) and pauses the background analysis until **Resume**; tracks loaded into a deck are still analysed. "Load Rekordbox" asks first. Selection → **Remove from library** takes tracks out of Key Master only |
| Waveforms | Zoomed waveforms of A and B stacked full width above the decks with one shared zoom in played time: decks at the same played BPM show identical beat spacing, the playhead line is shared; overview per deck |
| Decks A and B | Sample-accurate playback on one audio clock (Web Audio + Signalsmith Stretch): play, tempo ±8/16/50 %, key lock, SYNC (tempo and bar), ▶ A+B starts both decks at the same instant, QUANTIZE (cues and loops snap to the beat, hot cue jumps keep the beat phase, Play starts on the other deck's next beat; paused hot cues only move the playhead), beat jump ±1/4/16, arrow keys walk the grid like the browser tool (paused: ← / → land on the previous/next beat line, Shift = 4 beats; playing: jump keeping the phase; Home = start), loops of 1–32 beats, 8 hot cues (nameable; pressing an empty pad inside a running loop saves the loop as a loop cue), zoomed and overview waveform |
| Key shift | Per deck ± semitones, live, without changing tempo |
| Stems | Mix / vocals / instrumental with one click (Demucs, runs on the Apple GPU), export as FLAC with key shift to `~/Music/Key Master/Stems` |
| Beatgrid (GRID) | Move the grid in 5 ms or 1 ms steps (buttons or Alt+← / →) or drag it in the waveform, "1.1 here", BPM ±0.01/0.1 or type it in, ÷2/×2, TAP, metronome, reset |
| Mashup ideas | Tracks that fit deck A, including a key shift suggestion, filterable by playlist or genre; save and rate pairs |
| Mix ideas | Good next tracks by key, tempo and energy |
| Build set | Order a playlist or selection harmonically (rising, peak, steady) and save it as a playlist |
| Loudness | "Level volume" switch (during playback, files unchanged) with presets Official −12, Festival −9, Big Boost −7 LUFS; processed copies with clipping repair, optional contrast, true-peak limiter |
| Tags | Write key, BPM and "8A - Energy 8" into the file tags |
| Rekordbox | Load the collection (keys, beatgrids, cues, playlists); export straight into the database or as rekordbox.xml (including beatgrid); processed files can replace the original in Rekordbox |

All edits (grid, cues, key, ratings, playlists) are saved locally right away and go to Rekordbox when you export.
Rekordbox only takes the beatgrid via XML; keys, cues and playlists can also be written directly.
Your music files are never changed: processing writes copies (`_KM` suffix or an output folder).

## Commands

```bash
keymaster build                                  # build keymaster.html from ui.html + analysis.js + export.js
keymaster analyze ~/Music/New --cues             # show only, write nothing
keymaster rb analyze --playlist "Techno"         # dry run: shows what would be written
keymaster rb analyze --playlist "Techno" --write # actually write to Rekordbox
keymaster rb analyze --only-missing --playlist "New" --cues --write
keymaster rb import-xml ~/Downloads/rekordbox.xml --write   # take cues/keys from the browser tool
```

`python -m keymaster …` works as well.

Important options for `rb`:

| Option | Effect |
| --- | --- |
| `--write` | Without it, every run is a dry run. |
| `--overwrite` | Replace existing keys and hot cues. Default: only fill empty fields/pads. |
| `--notation classic` | Store keys as `Am` instead of Camelot `8A`. |
| `--cues` | Automatic phrase cues: A = first beat, B–G = drops/breaks on 8-bar boundaries, H = "Outro" 4-beat loop at the last full 8-bar phrase. |
| `--db PATH` | A different `master.db`, e.g. a copy for testing. |

## Safety

- **Rekordbox must be closed**, otherwise a write run stops.
- Before every write, `master.db` is copied to `~/Library/Pioneer/rekordbox/keymaster-backups/`.
  To go back: close Rekordbox and copy the backup back as `master.db`.
- The command line does **not** write BPM or beatgrid. They live in Rekordbox's analysis files, and Rekordbox's own grid is usually more accurate. The detected BPM is shown for comparison only.
- Hot cues are created without a color (Rekordbox default color).

## Layout

| File | Contents |
| --- | --- |
| `app/` | UI of the local app (HTML, CSS, JS) |
| `keymaster/server.py` | Local server of the app, background jobs |
| `keymaster/library.py` | Local library (SQLite) |
| `keymaster/audio.py` | Loudness, leveling, limiter, key shift, stems |
| `keymaster/suggest.py` | Mashup and mix ideas, set ordering |
| `ui.html`, `analysis.js`, `export.js` | Sources of the browser tool; `keymaster build` joins them at `/*ANALYSIS*/` and `/*EXPORT*/` |
| `keymaster/analysis.py` | Key (essentia EDM profile or librosa CQT chroma), BPM (whole-BPM preference), grid phase + downbeat (Beat This! model), energy 1–10, phrase cues |
| `app/vendor/SignalsmithStretch.js` | Time-stretch/pitch AudioWorklet (MIT) used by the decks |
| `keymaster/rekordbox.py` | Reading/writing `master.db` via [pyrekordbox](https://github.com/dylanljones/pyrekordbox), XML import/export |
| `keymaster/keys.py` | Camelot and Rekordbox notation |
| `keymaster/cli.py` | Command line |

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 An Dang

Key Master is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for details.

Third-party code and dependencies keep their own licenses:

- `app/vendor/SignalsmithStretch.js`: Signalsmith Stretch, MIT, © Geraint Luff / Signalsmith Audio
- Optional `essentia` extra: AGPL-3.0. If you install it and distribute or offer the result over a network, the AGPL terms apply to that combination.
- The UI loads the Archivo and IBM Plex Mono fonts from Google Fonts (SIL Open Font License).

## Disclaimer

Key Master is an independent project and is not affiliated with, endorsed by or sponsored by AlphaTheta Corporation or Pioneer DJ. Rekordbox is a trademark of AlphaTheta Corporation. Camelot is a trademark of Mixed In Key LLC.
