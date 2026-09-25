"""RELEASE_NOTES.md and CHANGELOG.md headings parse into the About section.

The headings use ASCII hyphens as separators ("## 0.4.5 - 2026-08-23 -
Title"); a version like 0.4.5 must not swallow the date as a version range.
"""
import re
from pathlib import Path

from app import about_docs

ROOT = Path(__file__).resolve().parent.parent


def _headings(name, pattern):
    text = (ROOT / name).read_text(encoding="utf-8")
    return re.findall(pattern, text, re.M)


def test_every_release_note_parses():
    expected = _headings("RELEASE_NOTES.md", r"^##\s+(\d[\d.]*)\s")
    entries = about_docs.load_release_notes()
    assert [e.version for e in entries] == expected
    for e in entries:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", e.date), (e.version, e.date)
        assert e.title and "(latest)" not in e.title
    assert [e.is_latest for e in entries] == [True] + [False] * (len(entries) - 1)


def test_every_changelog_section_parses():
    expected = _headings("CHANGELOG.md", r"^##\s+\[(\d[^\]]*)\]")
    entries = about_docs.load_changelog()
    assert [e.version for e in entries] == expected
    for e in entries:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", e.date), (e.version, e.date)
