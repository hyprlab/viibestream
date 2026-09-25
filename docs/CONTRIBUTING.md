# Contributing

The conventions anyone editing this repository follows, human or AI. Bug
reports, ideas and pull requests are all welcome, and a clear bug report is
often as useful as a patch.

## Setting up

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-dev.txt
git config core.hooksPath tools/git-hooks     # once per clone or worktree
tools/redeploy.sh                             # build and start the container
.venv/bin/python -m pytest                    # runs against http://localhost:8080
```

The hooks enforce the commit rules below and run the documentation check.
Without `core.hooksPath` they silently do nothing, so set it in every clone
and every worktree.

## Commits

**The history is the maintainer's.** Commits carry no AI tool attribution: no
`Co-Authored-By:` line for Claude or any other assistant, no "Generated with"
footer, no session line, in a commit, a tag message, a pull request body or a
release body. The [AI notice](../README.md#ai-notice) declares how the project
is built, once, for the whole repository. One stray trailer puts the tool on
GitHub's Contributors panel, and removing it again means rewriting history.

A `Co-Authored-By:` trailer is still how a **person** is credited, with the
GitHub noreply address that resolves to their profile (see
[Credit](#credit)).

Subjects follow [Conventional Commits](https://www.conventionalcommits.org):
`type(area): summary`, lower case after the colon, imperative, no full stop,
72 characters at most and ideally nearer 50.

- Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `build`, `ci`, `test`,
  `style`, `chore`, `revert`. A `!` after the type (`feat(stream)!:`) marks a
  breaking change. The type is not decoration: `tools/next-version.sh` reads
  it to decide the next version ([RELEASING.md](RELEASING.md)).
- The area is where the change lives: `stream`, `viewer`, `broadcaster`,
  `chat`, `voice`, `auth`, `admin`, `settings`, `lock`, `ui`, `docker`,
  `release`. Leave it out only when there is no single place.
- An issue number goes at the end: `fix(viewer): resume after a stall (#12)`.
- Releases: `chore(release): 0.5.0`.

The body is optional and short: why the change exists, never what the diff
already says. Past 100 words the detail belongs in `docs/` or `CHANGELOG.md`,
or the commit wants splitting. **Each body paragraph is one line, not
wrapped:** GitHub keeps every line break in a body, so text wrapped at 72
breaks a second time on a phone. Write it with `git commit -F -` and a heredoc.

No em dashes in commit messages: a colon, a comma or a full stop replaces
them.

`tools/git-hooks/commit-msg` refuses the attribution lines, em dashes, a
subject without a type, and an overlong subject or body. `pre-push` refuses to
publish any commit or tag carrying attribution. `pre-commit` refuses
`CLAUDE.md` and `.claude/`.

## CLAUDE.md and .claude/

Both are local only: listed in `.git/info/exclude`, not `.gitignore`, so the
repository never names the tool. Never `git add -f` them. A new worktree does
not get them: symlink `CLAUDE.md` into it before working there. What they used
to explain about the code is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Prose style

Documentation, the changelog, release notes, UI text and issue replies:

- Factual, plain language. Say what the app does, not what it enables you to
  do. No marketing, no superlatives, no "finally", no emoji.
- No em dashes in any Markdown file: a colon, a comma, parentheses or a full
  stop. `tools/check-docs.py` refuses them.
- American spelling in anything the app shows: color, behavior, canceled.
- Comments in code explain *why*, not *what*.

## Documentation

Before writing a word of documentation, decide where it goes: the table in
[docs/README.md](README.md) says. After touching any `.md`, run:

```sh
python3 tools/check-docs.py
```

It checks every relative link and anchor, that every `docs/*.md` is indexed,
that no Markdown carries an em dash, and the shape and version of
`CHANGELOG.md` and `RELEASE_NOTES.md`.

Every user-visible change adds an entry under the `Unreleased` heading of both
files: `RELEASE_NOTES.md` says what changed from the user's side, in a line or
two, and `CHANGELOG.md` records how. Give the release a short name in the
release notes' heading, `## Unreleased - Curtain countdown`; it becomes the
title the About section shows. Every release, patches included, gets a section
in both, and the About section renders them.

## Code

- Match what is there: the app factory, blueprints, per-route permission
  decorators, and the inline `current_user` checks in Socket.IO handlers
  ([ARCHITECTURE.md](ARCHITECTURE.md)).
- Inline scripts carry `nonce="{{ csp_nonce }}"`; prefer `static/js/`.
- Anything a user typed is rendered with Jinja's escaping or `textContent`,
  never `|safe` or `innerHTML`.
- User-facing failures say what happened and what to do, in a sentence.
- Rebuild and run the app (`tools/redeploy.sh`) and the tests before saying
  something works.

## Credit

Outside pull requests land as commits on `main` made by the maintainer,
crediting the author with a trailer that uses their GitHub noreply address:

```
Co-Authored-By: Jane Doe <12345678+janedoe@users.noreply.github.com>
```

Get the id with `gh api users/<login> --jq .id`. An address taken from their
own commit may not be linked to their account, and then they never appear as a
contributor; that can't be fixed after a tagged release without rewriting
history.

Add them, with their `@login`, to [CREDITS.md](CREDITS.md) along with what they
did. Close the pull request with a comment saying what was taken, what changed
and what was left out.

In release notes an `@` is for people whose code, art or translation is in the
release. Reporters and requesters are named without the `@`: an @ notifies
someone and reads as authorship. `tools/release-notes.sh` strips the @ from any
handle not in CREDITS.md.

## Issue replies

Every reply to an issue or pull request written by an agent begins with
`*Agentic reply:*` in italics, then a blank line, then the reply.

- A reply saying something is done is one or two sentences: what changed from
  the user's side, and which version carries it. How it was built is in the
  commit and the changelog.
- No thanks, no pleasantries, no em dashes. Plain, brief, human.
- Anything the user has to do (send a log, try something, check a setting) is
  a numbered list, one request per item.
- Reply once the release and its image are published, not before.

```
*Agentic reply:*

Fixed in 0.5.0: the viewer now resumes by itself after a network stall.

Update with `docker compose pull && docker compose up -d`.
```

Only a reply that asks for something or explains a decline runs longer.
