# AGENTS.md

Instructions for AI coding agents working on Key Master.

## Workflow Orchestration

### 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents liberally to keep the main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until the mistake rate drops
- Review lessons at session start for the relevant project

### 4. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First:** Write the plan to `tasks/todo.md` with checkable items
2. **Verify Plan:** Check in before starting implementation
3. **Track Progress:** Mark items complete as you go
4. **Explain Changes:** High-level summary at each step
5. **Document Results:** Add a review section to `tasks/todo.md`
6. **Capture Lessons:** Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First:** Make every change as simple as possible. Impact minimal code.
- **No Laziness:** Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact:** Changes should only touch what's necessary. Avoid introducing bugs.

## Coding Style: Ponytail

Follow the rules in [`docs/agents/ponytail.md`](docs/agents/ponytail.md): solve the whole task with the least new code
(does it need to exist → existing code → standard library → installed dependency → one line → minimal new code),
never cut validation, data-loss protection, security or accessibility, and end replies with what was skipped or unchecked.

## Project: Key Master

Key, BPM, cue and loudness tool for DJs. See `README.md` for features.

- **Parts:** local app (`keymaster/server.py` + `app/`), CLI (`keymaster/cli.py`), browser tool (`ui.html` + `analysis.js` + `export.js`, built into `keymaster.html`).
- **Environment:** Python venv in `.venv` (`.venv/bin/keymaster`, `.venv/bin/python`). Dependencies: `pip install -e ".[essentia,app,stems]"`.
- **Build the browser tool:** `.venv/bin/keymaster build` after changing `ui.html`, `analysis.js` or `export.js`. Commit the rebuilt `keymaster.html`.
- **Run the app for testing:** use a throwaway library so the user's data stays untouched:
  `KEYMASTER_DATA=/tmp/km-test .venv/bin/keymaster app --no-browser --port 8766`
- **Shell output:** commands run through [rtk](https://github.com/rtk-ai/rtk) (global Claude Code hook) to keep output compact; `rtk gain` shows the token savings.
- **Checks:** `.venv/bin/python -m compileall -q keymaster` and `node --check app/app.js`; verify UI changes in a browser.
- **Language:** all user-facing text (UI, CLI, server messages, docs) is English.

### Safety rules

- Never write to the live Rekordbox database (`~/Library/Pioneer/rekordbox/master.db`) during development or tests. Test writes against a copy via `--db` / `db_path`. Only write the live database when the user explicitly asks.
- Never modify or delete the user's music files. Processing creates copies (`_KM` suffix or output folder).
- Do not delete the user's Key Master library (`~/Library/Application Support/Key Master/`) unless asked.
