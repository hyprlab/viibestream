#!/usr/bin/env bash
# Say which version SemVer calls for, from the commits since the last release.
#
#   tools/next-version.sh           # the next version
#   tools/next-version.sh --why     # also list the commits that decided it
#
# The Conventional Commit types decide it: a "!" or a BREAKING CHANGE footer is
# MAJOR, a feat is MINOR, anything else (fix, perf, revert) is PATCH. Commits
# that change nothing a user sees (docs, test, ci, style, chore, build,
# refactor) do not force a release at all.
#
# While the version is 0.x (SemVer's initial development), a breaking change
# calls for the next MINOR and says so: going to 1.0.0 is the maintainer's
# decision, not the script's. docs/RELEASING.md has the judgment calls this
# cannot make: a schema change an older version can't read back is breaking
# however the commit was typed.
set -euo pipefail
cd "$(dirname "$0")/.."

WHY=0
for arg in "$@"; do
    case "$arg" in --why) WHY=1 ;; *) echo "unknown: $arg" >&2; exit 1 ;; esac
done

# The newest release tag reachable from here: on a stable-X.Y branch that is
# the line's own last release, not whatever main has shipped since.
last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' --exclude 'v*-*' HEAD 2>/dev/null || true)
if [ -z "$last" ]; then
    base=$(sed -nE 's/^\s*APP_VERSION = "(.*)"/\1/p' app/config.py | head -1)
    range="HEAD"
else
    base="${last#v}"
    range="$last..HEAD"
fi
IFS=. read -r MA MI PA <<<"${base%%-*}"

log=$(git log --no-merges --format='%s%x1f%b%x1e' $range 2>/dev/null || true)
level=none
while IFS=$'\x1f' read -r -d $'\x1e' subject body; do
    subject="${subject#$'\n'}"
    [ -z "$subject" ] && continue
    type=$(printf '%s' "$subject" | sed -nE 's/^([a-z]+)(\([^)]*\))?(!?):.*/\1\3/p')
    if [[ "$type" == *'!' ]] || printf '%s' "$body" | grep -q '^BREAKING[ -]CHANGE:'; then
        this=major
    elif [ "$type" = feat ]; then
        this=minor
    elif [[ "$type" =~ ^(fix|perf|revert)$ ]]; then
        this=patch
    else
        this=none
    fi
    case "$level:$this" in
        *:major) level=major ;;
        none:minor|patch:minor) level=minor ;;
        none:patch) level=patch ;;
    esac
    [ "$WHY" = 1 ] && [ "$this" != none ] && printf '  %-5s %s\n' "$this" "$subject" >&2
done <<<"$log"

if [ "$level" = major ] && [ "$MA" = 0 ]; then
    echo "A breaking change on 0.x: SemVer calls for the next minor. 1.0.0 is the maintainer's call." >&2
    level=minor
fi
case "$level" in
    major) next="$((MA + 1)).0.0" ;;
    minor) next="$MA.$((MI + 1)).0" ;;
    patch) next="$MA.$MI.$((PA + 1))" ;;
    none)  echo "Nothing since ${last:-the start} calls for a release." >&2; exit 2 ;;
esac
echo "$next"
