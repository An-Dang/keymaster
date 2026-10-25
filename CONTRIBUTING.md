# Contributing to Key Master

Thanks for helping. Bug reports, ideas and pull requests are all welcome. By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Reporting bugs and ideas

Open an issue with the bug or feature template. For bugs, include:

- What you did, what you expected and what happened
- Key Master version (`pip show keymaster`), macOS version, Rekordbox version
- The file format if it is about analysis (MP3, FLAC, M4A, ...) and the server output from the terminal

Never attach your `master.db` or copyrighted audio. Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

```bash
git clone <repository-url> keymaster
cd keymaster
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[app,beats,stems]"
```

Run the app against a throwaway library so your real data stays untouched:

```bash
KEYMASTER_DATA=/tmp/km-test keymaster app --no-browser --port 8766
```

## Ground rules

These protect users' music and DJ libraries. Pull requests that break them are not merged.

- **Never write to a live Rekordbox database** while developing or testing. Copy `master.db` and use `--db /path/to/copy` (CLI) or `db_path` (code).
- **Never modify or delete music files.** Processing creates copies (`_KM` suffix or an output folder).
- **Keep the Rekordbox backup** that runs before every write.
- All user-facing text (UI, CLI, server messages, docs) is in English.

## Making changes

- Keep changes small and focused; one topic per pull request.
- Prefer the smallest complete change: reuse existing helpers, the standard library or installed dependencies before adding code. Do not add a dependency for a few lines. See [docs/agents/ponytail.md](docs/agents/ponytail.md) for the full style.
- Match the surrounding code: naming, comment density, idioms. In `app/`, escape every interpolated string with `esc()`.
- Keep accessibility: real buttons, `aria-*` labels, keyboard use.
- Update `README.md` when a user-facing feature changes.

### Project parts

| Part | Files | After changing |
| --- | --- | --- |
| Local app | `keymaster/server.py` and other `keymaster/*.py`, `app/` | restart `keymaster app` |
| Command line | `keymaster/cli.py` | |
| Browser tool | `ui.html`, `analysis.js`, `export.js` | run `keymaster build` and commit the rebuilt `keymaster.html` |

## Checks

There is no automated test suite yet. Before opening a pull request, run:

```bash
python -m compileall -q keymaster
node --check app/app.js
```

and verify UI changes in a browser against the throwaway library. Describe in the pull request how you tested.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, run the checks above.
3. Open a pull request using the template and link the related issue.

## AI coding agents

If you use an AI coding agent, point it to [AGENTS.md](AGENTS.md). It holds the same rules in agent form. You are responsible for every line you submit, so review generated code like your own.

## License

By contributing, you agree that your contributions are licensed under the [GNU General Public License v3.0 or later](LICENSE), the same license as the project.
