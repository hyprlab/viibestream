#!/usr/bin/env bash
# Set the version and turn the Unreleased sections into that version's.
#
#   tools/bump-version.sh 0.5.0
#
# Edits APP_VERSION in app/config.py, CHANGELOG.md ("## [Unreleased]" becomes
# "## [0.5.0] - date") and RELEASE_NOTES.md ("## Unreleased - Title" becomes
# "## 0.5.0 - date (latest) - Title", and the previous "(latest)" goes), then
# runs check-docs. It does not commit, tag or push: docs/RELEASING.md is the
# procedure around it.
set -euo pipefail
cd "$(dirname "$0")/.."

CURRENT=$(sed -nE 's/^\s*APP_VERSION = "(.*)"/\1/p' app/config.py)
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
    echo "usage: tools/bump-version.sh X.Y.Z   (current: $CURRENT)" >&2
    exit 1
fi

python3 - "$CURRENT" "$VERSION" <<'PY'
import re, sys, datetime, pathlib, importlib.util
current, version = sys.argv[1], sys.argv[2]

spec = importlib.util.spec_from_file_location("check_docs", "tools/check-docs.py")
cd = importlib.util.module_from_spec(spec); spec.loader.exec_module(cd)
if not cd.SEMVER.match(version):
    sys.exit(f"'{version}' is not a SemVer version (https://semver.org/).")
if cd.sort_key(version) <= cd.sort_key(current):
    sys.exit(f"{version} is not newer than {current}. A version never counts backwards.")
today = datetime.date.today().isoformat()

def unreleased(name):
    path = pathlib.Path(name)
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^##\s+\[?Unreleased\]?(?:\s+-\s+(.*?))?[ \t]*\n(.*?)(?=^## |\Z)", text, re.M | re.S | re.I)
    if not m:
        sys.exit(f"{name} has no '## Unreleased' section.")
    if not m.group(2).strip():
        sys.exit(f"{name}'s Unreleased section is empty. Write the entries before bumping.")
    return path, text, m

path, text, m = unreleased("CHANGELOG.md")
new = f"## [Unreleased]\n\n## [{version}] - {today}\n\n{m.group(2).strip()}\n\n"
path.write_text(text[:m.start()] + new + text[m.end():], encoding="utf-8")

path, text, m = unreleased("RELEASE_NOTES.md")
title = (m.group(1) or "").strip()
if not title:
    sys.exit("RELEASE_NOTES.md: name the release in its heading: '## Unreleased - Short title'.")
new = f"## Unreleased\n\n## {version} - {today} (latest) - {title}\n\n{m.group(2).strip()}\n\n"
rest = re.sub(r"^(##\s+\d.*?)\s*\(latest\)", r"\1", text[m.end():], flags=re.M | re.I)
path.write_text(text[:m.start()] + new + rest, encoding="utf-8")
PY

sed -i -E "s/^(\s*APP_VERSION = )\".*\"/\1\"$VERSION\"/" app/config.py
echo "$CURRENT -> $VERSION (app/config.py, CHANGELOG.md, RELEASE_NOTES.md)"
python3 tools/check-docs.py
