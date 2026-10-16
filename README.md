# Key Master

Key, BPM, cue and loudness tool for DJs, in three parts:

- **Local app** (`keymaster app`): two decks side by side, library, mashup and mix ideas, set builder, volume leveling, export to Rekordbox.
- **Command line** (`keymaster analyze`, `keymaster rb …`): analysis and direct writes into the Rekordbox database.
- **Browser tool** `keymaster.html`: no install, analysis in the browser, Rekordbox XML export.

## Local app

```bash
.venv/bin/keymaster app
```

Opens `http://127.0.0.1:8765/` in your browser. The app only runs on your computer.
Library and caches live in `~/Library/Application Support/Key Master/`.
To start with a separate, empty library: `KEYMASTER_DATA=~/Music/"Key Master Test" .venv/bin/keymaster app`.

| Area | What it does |
| --- | --- |
| Files | Browse USB sticks, drives and folders; load a file straight into deck A/B (it is added to the library and analyzed first) or add a whole folder (with or without subfolders). Added folders show up as filters in the library sidebar and can be removed again (files stay on disk) |
| Waveforms | Zoomed waveforms of A and B stacked full width above the decks with one shared zoom in played time: decks at the same played BPM show identical beat spacing, the playhead line is shared; overview per deck |
| Decks A and B | Sample-accurate playback on one audio clock (Web Audio + Signalsmith Stretch): play, tempo ±8/16/50 %, key lock, SYNC (tempo and bar), ▶ A+B starts both decks at the same instant, QUANTIZE (cues and loops snap to the beat, hot cue jumps keep the beat phase, Play starts on the other deck's next beat; paused hot cues only move the playhead), beat jump ±1/4/16, arrow keys walk the grid like the browser tool (paused: ← / → land on the previous/next beat line, Shift = 4 beats; playing: jump keeping the phase; Home = start), loops of 1–32 beats, 8 hot cues (nameable), zoomed and overview waveform |
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

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[essentia,app,stems,beats]"
```

Without `[essentia]` everything runs on librosa. For M4A/AAC, librosa also needs `ffmpeg` (`brew install ffmpeg`); essentia reads these formats itself.

## Commands

```bash
keymaster build                                  # build keymaster.html from ui.html + analysis.js + export.js
keymaster analyze ~/Music/New --cues             # show only, write nothing
keymaster rb analyze --playlist "Techno"         # dry run: shows what would be written
keymaster rb analyze --playlist "Techno" --write # actually write to Rekordbox
keymaster rb analyze --only-missing --playlist "New" --cues --write
keymaster rb import-xml ~/Downloads/rekordbox.xml --write   # take cues/keys from the browser tool
```

(`keymaster` lives in `.venv/bin/`; alternatively `python -m keymaster …`.)

Important options for `rb`:

| Option | Effect |
| --- | --- |
| `--write` | Without it, every run is a dry run. |
| `--overwrite` | Replace existing keys and hot cues. Default: only fill empty fields/pads. |
| `--notation classic` | Store keys as `Am` instead of `8A`. Your collection mostly uses `8A` so far. |
| `--cues` | Automatic phrase cues: A = first beat, B–H = drops/breaks on 8-bar boundaries. |
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
| `keymaster/rekordbox.py` | Reading/writing `master.db` via pyrekordbox, XML import/export |
| `keymaster/keys.py` | Camelot and Rekordbox notation |
| `keymaster/cli.py` | Command line |
