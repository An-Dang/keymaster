
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

## Loop cues + Outro loop (2026-10-16)

- [x] Empty pad pressed inside a running loop saves the loop as a loop cue (`{t, end}`); triggering it switches the loop on (beat-phase kept while playing)
- [x] Auto cues: "Outro" on pad H = 4-beat loop at the start of the last full 8-bar phrase; drops/breaks use B–G
- [x] Existing tracks: one synchronous pass adds the Outro on H when H is free or automatic (user cues untouched; a deleted Outro stays deleted)
- [x] Rekordbox: XML `Type="4"` with `End`; direct write sets `OutMsec/OutFrame`; import keeps loop ends
- [x] Verified: migration (Outro on beats 896/320/512 = phrase starts, own H cue kept), XML, DB copy write + re-import, browser save/trigger loop cue and Outro loop
- Not checked: how Rekordbox itself shows the loop cues after import (only the data was checked)

## Stop background work + folder tree (2026-10-17)

- [x] Jobs can be cancelled: queued dropped, running stop at their next progress step (analysis puts the track back to "new")
- [x] Header **Stop** (cancel all + pause analysis) / **Resume**; watcher and Rekordbox import respect the pause; deck loads still analyse
- [x] "Load Rekordbox" confirmation; selection action **Remove from library** (files/Rekordbox untouched)
- [x] Sidebar folder tree: each added folder with its subfolders, expandable, recursive counts, click filters by path; new folders open expanded
- [x] Verified in browser with Trance:Bouncy (90 real files, 84 ._ junk files ignored): tree 2025-10/2026-01/2026-08/2026-10; Stop → 0 jobs, 85 cancelled, no track stuck "analyzing"; Resume → 83 queued; confirm + Cancel starts no import; removing 2026-01 kept the files
- Not checked: stopping a running stem separation mid-way (cancel happens at Demucs' next progress callback)
