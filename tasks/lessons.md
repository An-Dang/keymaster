# Lessons

Patterns from user corrections, written as rules to avoid repeating mistakes.

- When saving a partial update from the UI, never merge the whole server row back into local state; unsaved local edits must win (grid edits were lost this way).
