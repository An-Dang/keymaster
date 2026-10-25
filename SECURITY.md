# Security Policy

## Supported versions

Key Master is in early development (0.x). Only the latest version on `main` gets security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Report them privately:

- via GitHub: **Security** tab → **Report a vulnerability** (private vulnerability reporting), or
- by email to mail@andang.de with the subject "Key Master security".

Include what is affected, steps to reproduce and the impact you expect. You will get an answer within 7 days. Once a fix is out, you will be credited unless you prefer not to be.

## Scope

Key Master runs locally: the app server listens only on `127.0.0.1` and reads and writes the user's files and Rekordbox database. Relevant issues include, for example:

- Another website or local process can make the app server read, write or delete files (path traversal, missing origin checks, cross-site requests)
- Script injection through track metadata, file names or playlist names (XSS in the app or the browser tool)
- Writes to the Rekordbox database or to music files that bypass the dry run, the backup or the copy-only rule

Out of scope: problems that require an attacker who already controls the user's account, and vulnerabilities in dependencies without a working path through Key Master (report those upstream).
