#!/usr/bin/env bash
# Prepare a release commit and tag, locally. Pushes nothing.
#
#   tools/prepare-release.sh [VERSION]    # on main, or on stable-X.Y for a patch
#
# VERSION defaults to what tools/next-version.sh says SemVer calls for. If one
# is given and it disagrees, the script stops and says why: the version is the
# maintainer's call, but a mismatch has to be a decision, not an accident.
# Set FORCE_VERSION=1 to go ahead with a version that disagrees.
#
# Afterwards: review, then the publish steps in docs/RELEASING.md.
set -euo pipefail
cd "$(dirname "$0")/.."

# Tests that need no running container. The browser suite runs against the
# local container: tools/redeploy.sh && .venv/bin/python -m pytest
UNIT_TESTS="tests/test_late_joiner_buffer.py tests/test_about_docs.py"

WANT="${1:-}"

[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "The working tree has uncommitted changes." >&2; exit 1; }
[ "$(git config core.hooksPath)" = "tools/git-hooks" ] || { echo "Run: git config core.hooksPath tools/git-hooks" >&2; exit 1; }

branch=$(git symbolic-ref --short HEAD)
[[ "$branch" = main || "$branch" == stable-* ]] || { echo "A release ships from main or stable-X.Y (you are on $branch)." >&2; exit 1; }

SUGGESTED=$(tools/next-version.sh)
VERSION="${WANT:-$SUGGESTED}"
if [ "$VERSION" != "$SUGGESTED" ] && [ "${FORCE_VERSION:-0}" != 1 ]; then
    echo "SemVer calls for $SUGGESTED, not $VERSION. The commits that decide it:" >&2
    tools/next-version.sh --why >/dev/null || true
    echo "Rerun with FORCE_VERSION=1 if $VERSION is deliberate." >&2
    exit 1
fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "v$VERSION already exists." >&2
    exit 1
fi

echo "==> docs and tests"
python3 tools/check-docs.py
# shellcheck disable=SC2086
if [ -x .venv/bin/python ]; then .venv/bin/python -m pytest -q $UNIT_TESTS; else python3 -m pytest -q $UNIT_TESTS; fi

tools/bump-version.sh "$VERSION"

git add CHANGELOG.md RELEASE_NOTES.md app/config.py
git commit -q -m "chore(release): $VERSION"
git tag -a "v$VERSION" -m "$VERSION"
echo
echo "==> v$VERSION committed and tagged on $branch. Nothing is pushed."
echo "    Review: git show --stat HEAD && tools/release-notes.sh $VERSION"
echo "    Then follow docs/RELEASING.md from \"Publish\"."
