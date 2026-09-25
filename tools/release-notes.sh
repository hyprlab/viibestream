#!/usr/bin/env bash
# Print the GitHub release body for one version.
#
#   tools/release-notes.sh 0.5.0 > /tmp/notes.md
#
# The body is that version's RELEASE_NOTES.md section (the user-facing
# summary) and nothing else from the files: never hand CHANGELOG.md or
# RELEASE_NOTES.md itself to `gh release create`, or every release page carries
# the whole history.
#
# With the tag present, it appends a "What's changed" list against the previous
# release tag, a compare link, and the Docker pull line.
#
# GitHub keeps every line break in a release body, so paragraphs and list items
# are unwrapped to one line each. An @handle keeps its @ only if the person is
# listed in docs/CREDITS.md: an @ notifies someone and reads as authorship, so
# it is for people whose work is in the release, not whoever reported the bug.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: tools/release-notes.sh X.Y.Z}"
TAG="v$VERSION"

{
python3 - "$VERSION" <<'PY'
import re, sys, pathlib
version = sys.argv[1]
text = pathlib.Path("RELEASE_NOTES.md").read_text(encoding="utf-8")
m = re.search(r"^##\s+" + re.escape(version) + r"\s[^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
if not m:
    sys.exit(f"RELEASE_NOTES.md has no section for {version}.")
out, buf = [], []
def flush():
    if buf:
        out.append(" ".join(buf)); buf.clear()
for line in m.group(1).strip().splitlines():
    s = line.strip()
    if not s:
        flush(); out.append("")
    elif re.match(r"^([-*]|\d+\.|#+)\s", s):
        flush(); buf.append(s)
    else:
        buf.append(s)
flush()
print(re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip())
PY

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    prev=$(git tag -l 'v*' --sort=-v:refname | grep -vE -- '-' | grep -vx "$TAG" \
           | while read -r t; do git merge-base --is-ancestor "$t" "$TAG" && { echo "$t"; break; }; done || true)
    if [ -n "$prev" ]; then
        echo
        echo "### What's changed"
        echo
        git log --no-merges --format='- %s' "$prev..$TAG" | grep -v '^- chore(release)' || true
        repo=$(git remote get-url origin 2>/dev/null | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/]+)$#\1#' || true)
        if [ -n "$repo" ]; then
            echo
            echo "**Full changes:** https://github.com/$repo/compare/$prev...$TAG"
        fi
    fi
fi
echo
echo "**Docker:** \`docker pull hyprlab/viibestream:$VERSION\`"
} | python3 -c '
import re, sys, pathlib
p = pathlib.Path("docs/CREDITS.md")
known = set(m.lower() for m in re.findall(r"@([A-Za-z0-9-]+)", p.read_text(encoding="utf-8"))) if p.exists() else set()
text = sys.stdin.read()
text = re.sub(r"(?<![\w/])@([A-Za-z0-9-]+)",
              lambda m: m.group(0) if m.group(1).lower() in known else m.group(1), text)
sys.stdout.write(text)
'
