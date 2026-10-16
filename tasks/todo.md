
## Off-beat feel + play both decks together (2026-10-16)

Findings (measured): grids were wrong (10 of 27 tracks half a beat off vs Rekordbox, others 20–45 ms early, some non-whole BPM),
and `<audio>` seeks landed ~50 ms late (SYNC only corrected slowly).

- [x] Grid phase + downbeat from Beat This! (`beat-this`), whole-BPM preference. 60 tracks vs Rekordbox: BPM 59/60, phase median −0.6 ms, 45/59 within 25 ms, 4 half-beat errors (was ~1 in 4)
- [x] Re-grid of tracks analysed before the new detection (`GRID_SINCE`, repeats each start until done); hand-edited/Rekordbox grids and named cues stay
- [x] GPU lock (Metal crashed with beat model + Demucs in parallel)
- [x] New deck engine: server-decoded PCM in Signalsmith Stretch nodes on one AudioContext clock; live key shift; key lock via semitones
- [x] Play A+B (same audio-clock instant); quantized start on the other deck's next beat; paused hot cues only move the playhead
- [x] Verified: offline render — start/jump/tempo land within 0.3–2.5 ms of the model, loop regular; app — Play A+B same instant, phase 0.02 ms after hot cue jump, B started on A's beat 100.0000, stems swap 0.6 s, key 10B+2 = 12B

### Review

- Root causes were the grids and the `<audio>` element, not QUANTIZE itself.
- Not checked: listening by ear; long sessions (memory: decoded track ~50–100 MB per deck); AIFF/ALAC playback now goes through server decoding (untested with a real AIFF in the browser).
- Known limit: actions are audible after the stretcher latency (~120 ms), but they land on the beat.
