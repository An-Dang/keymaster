# Todo

Current plan with checkable items. Add a "Review" section when a task is done.

## Beat jump & quantized cues (2026-10-16)

Goal: keep the mix on the grid. Builds on the existing grid (`bpm`, `first_beat`), `Deck.quantize()` and SYNC.

- [x] Global QUANTIZE toggle in the mixer, saved as setting `quantize` (default on)
- [x] `Deck.quantize()` respects the toggle (affects setting hot cues, CUE and loop start)
- [x] Hot cue jump while playing keeps the beat phase (target = cue + current offset to the nearest beat), so a synced deck stays in sync
- [x] Beat jump buttons per deck: ◀16 ◀4 ◀1 1▶ 4▶ 16▶; an active loop moves with the jump
- [x] Keyboard: ← / → jump 1 beat, with Shift 4 beats (grid mode keeps arrows for grid shifting)
- [x] Verify in the browser: jump distances, phase kept after hot cue jump with SYNC, quantize off sets cues unsnapped

### Review

- QUANTIZE toggle in the mixer (setting `quantize`, default on). Off: cues, CUE and loop start use the exact position.
- Hot cue jump while playing keeps the offset to the nearest beat (tested: −152.0 ms before, −151.6 ms after), so SYNC stays locked.
- Beat jump ◀16 ◀4 ◀1 1▶ 4▶ 16▶ and ←/→ (Shift = 4 beats). Tested: +4 = 4.00 beats, −16 = −16.00 beats; an active loop moves along.
- Fix found in testing: a jump past the track start/end is ignored instead of clamped, because clamping broke the beat phase.
- Stems moved to their own row so Loop + Jump fit on one line.
- Not checked: by-ear listening, behaviour on very short tracks with variable tempo (grid is constant-tempo only).
