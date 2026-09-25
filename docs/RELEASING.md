# Releasing

How versions are numbered, when releases happen, and the exact steps.

## Versions: strict SemVer

Every release follows [Semantic Versioning 2.0.0](https://semver.org/). For an
app, the "public API" is whatever an existing install and its users depend on:
the data volume, the `.env` configuration, the URLs, and the features.

| Bump | When | Examples |
| --- | --- | --- |
| **MAJOR** `1.0.0` | Anything an existing install can't take without help | A migration an older version can't read back; a removed feature or setting; a renamed or removed environment variable; a changed URL other things link to; a changed volume path or port |
| **MINOR** `0.5.0` | New, backward-compatible functionality, or a deprecation | A new feature, setting, page or control; a new optional environment variable |
| **PATCH** `0.4.7` | Backward-compatible fixes only | A bug fix, a performance fix, a security fix with no behavior change |

**While the version is 0.x**, SemVer calls it initial development: a breaking
change bumps the MINOR instead, and the release notes say plainly what an
existing install has to do. Moving to `1.0.0` is the maintainer's decision.

`tools/next-version.sh` reads the Conventional Commit types since the last
release tag and says which bump they call for: `!` or a `BREAKING CHANGE:`
footer is major (minor on 0.x), `feat` is minor, `fix`, `perf` and `revert` are
patch. `tools/prepare-release.sh` refuses a version that disagrees unless told
`FORCE_VERSION=1`. The tool cannot see everything, so read the commits too: a
`fix` that changes the schema irreversibly is still breaking.

**Before any release, say plainly if the requested version does not fit** what
the commits since the last tag contain, and what SemVer calls for instead. The
maintainer decides; a mismatch has to be a decision, not an accident. A batch
with no features is a patch, not a minor.

One release, one version, one tag. Several releases are never folded into one
commit or tag (as `v0.4.2` to `v0.4.5` once were), and a version is never
skipped. A version never counts backwards, and a released version is never
reused. The version lives in one place, `APP_VERSION` in `app/config.py`, and
the newest sections of `CHANGELOG.md` and `RELEASE_NOTES.md` must match it
(`tools/check-docs.py`).

## When

1. **Work lands on `main`.** Commits stay local until the maintainer says to
   push or ship. Every user-visible change adds entries under `Unreleased`
   ([CONTRIBUTING.md](CONTRIBUTING.md#documentation)).
2. **A release happens only when the maintainer says "ship it".** Nothing is
   pushed, tagged on GitHub, released or published to Docker Hub before that.
   A request to change something "on GitHub" does not authorize pushing main:
   ask how.
3. **Urgent patches** (a crash, data loss, a security hole, an instance that
   can't start or can't sign anyone in) can ship while main carries unreleased
   work; see [Urgent patches](#urgent-patches).

## Before any release

- `python3 tools/check-docs.py` passes. A release does not go out while it fails.
- The unit tests pass (`prepare-release.sh` runs both), and the browser suite
  passes against the rebuilt container: `tools/redeploy.sh && .venv/bin/python -m pytest`.
- The `Unreleased` entries are written in the project's prose style
  ([CONTRIBUTING.md](CONTRIBUTING.md#prose-style)), and the release notes'
  heading names the release: `## Unreleased - Short title`.
- Every contributor in the release is in [CREDITS.md](CREDITS.md) **before**
  the notes are generated, or `tools/release-notes.sh` strips their @.
- `git log origin/main..main --format=%B | grep -iE 'anthropic|claude'` prints
  nothing. The `pre-push` hook checks the same thing.

## Ship it

On `main`:

```sh
tools/next-version.sh --why            # what SemVer calls for, and why
tools/prepare-release.sh               # or: tools/prepare-release.sh 0.5.0
```

That checks the tree and hooks, runs the checks, turns both `Unreleased`
sections into the version's sections, moves `(latest)`, sets `APP_VERSION`,
commits `chore(release): X.Y.Z`, tags `vX.Y.Z` (the tag message is the version
and nothing else), and stops. Then publish:

```sh
git push origin main vX.Y.Z
tools/release-notes.sh X.Y.Z > /tmp/notes.md
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md
tools/publish-image.sh X.Y.Z
tools/redeploy.sh                      # the maintainer's own instance
```

**The release title is the version and nothing else:** no name, no tagline,
no em dash. The body is that version's `RELEASE_NOTES.md` section, the list of
commits since the previous release, a compare link and the Docker pull line.
Never hand `CHANGELOG.md` or `RELEASE_NOTES.md` itself to `gh release`: every
release page would carry the whole history.

Then reply to and close every issue the release fixes
([CONTRIBUTING.md](CONTRIBUTING.md#issue-replies)).

## Urgent patches

1. Fix it on `main` first, in its own commit, so it cherry-picks cleanly.
2. Cut the branch lazily, from the last release tag, never from main:
   `git branch stable-X.Y vX.Y.Z` (skip if it exists).
3. `git checkout stable-X.Y && git cherry-pick <sha>`, add the entries under
   `Unreleased`, then `tools/prepare-release.sh X.Y.Z+1`.
4. Publish as above, pushing `stable-X.Y` instead of `main`.
5. Merge `stable-X.Y` back into `main`, so the changelog entries survive.
6. Never delete a `stable-X.Y` branch: patch commits may exist only there.

## Docker images

`tools/publish-image.sh` builds from the tag with `git archive`, not from the
working tree, so the image is exactly what was released, and pushes
`hyprlab/viibestream:X.Y.Z`, `:X.Y` and `:latest`. It builds `linux/amd64`
only; set `PLATFORMS=linux/amd64,linux/arm64` once the host's buildx has an
arm64 builder. Docker image tags are never deleted: someone may have pinned
one.
