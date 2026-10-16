# Lessons

Patterns from user corrections, written as rules to avoid repeating mistakes.

- When saving a partial update from the UI, never merge the whole server row back into local state; unsaved local edits must win (grid edits were lost this way).
- Keep interactions the user already knows from the original browser tool (keymaster.html), e.g. arrow keys walking the beat grid. Before remapping a key or gesture, check how ui.html handled it.
