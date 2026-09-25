# Documentation

The README is the front door. Everything else lives here, and every file in
this directory is listed below; `tools/check-docs.py` fails if one is not.

| File | What is in it |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How the pieces fit together, the streaming dataflow, and the code conventions |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Commits, prose style, code, credit, issue replies |
| [RELEASING.md](RELEASING.md) | SemVer and the release procedure |
| [CREDITS.md](CREDITS.md) | Who contributed what |

## Where a new piece of documentation goes

| What you have | Where it goes |
| --- | --- |
| How to install, configure or run it | The [README](../README.md) |
| A design decision and its reasoning | [ARCHITECTURE.md](ARCHITECTURE.md) |
| A convention for anyone editing the repository | [CONTRIBUTING.md](CONTRIBUTING.md) |
| A change to how releases are made | [RELEASING.md](RELEASING.md) |
| Credit for somebody's work | [CREDITS.md](CREDITS.md) |
| What changed in a release, for users | [RELEASE_NOTES.md](../RELEASE_NOTES.md) |
| What changed in a release, in detail | [CHANGELOG.md](../CHANGELOG.md) |

A new `docs/*.md` must be added to the first table and linked from somewhere
it will be found.
