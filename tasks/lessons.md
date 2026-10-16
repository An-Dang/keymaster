# Lessons

Patterns from user corrections, written as rules to avoid repeating mistakes.

- When saving a partial update from the UI, never merge the whole server row back into local state; unsaved local edits must win (grid edits were lost this way).
- Keep interactions the user already knows from the original browser tool (keymaster.html), e.g. arrow keys walking the beat grid. Before remapping a key or gesture, check how ui.html handled it.
- "Feels off-beat" can be the data, not the code path: before tuning snapping or sync, measure the beatgrid against a reference (Rekordbox ANLZ grids) and measure real timing. Here both were wrong (off-beat grids, 50 ms late seeks).
- Verify third-party APIs against their source, not only the README: Signalsmith Stretch 1.3.2 expects `outputTime`, not `output`, and drops earlier pending changes on every schedule.
- MPS (Metal) aborts the process when two threads run GPU models at once; every torch model call goes through `GPU_LOCK`.
- Data migrations must be restartable: never mark one as done when the jobs are queued, only derive "needs work" from the data itself (here: `analyzed_at < GRID_SINCE`). The user often stops the app after a minute.
- Files on external drives/USB sticks come and go: never let a temporary "missing" state stop work for good; recheck existence and resume (the app polls every 20 s).
