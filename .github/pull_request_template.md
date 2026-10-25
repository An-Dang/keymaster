## What and why

<!-- What does this change and why? Link the issue: Fixes #123 -->

## How tested

<!-- Steps you ran, files/formats you tried, screenshots for UI changes -->

## Checklist

- [ ] `python -m compileall -q keymaster` and `node --check app/app.js` pass
- [ ] UI changes checked in a browser against a throwaway library (`KEYMASTER_DATA=/tmp/km-test`)
- [ ] Changed `ui.html`, `analysis.js` or `export.js`: ran `keymaster build` and committed `keymaster.html`
- [ ] No writes to a live Rekordbox database, no changes to music files
- [ ] README updated if a user-facing feature changed
