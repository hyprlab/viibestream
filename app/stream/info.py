"""Mutable metadata about what's currently being broadcast — title,
description, IMDB link, and an optional poster image. The broadcaster
sets this from their UI; viewers fetch it via /api/info and render it
inside a header-mounted modal.

All state is in-memory (single eventlet worker) and survives the
broadcaster going on/off air. Resets only when the Flask app process
restarts.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone


# Roughly the maximum size we want sitting in process memory for a
# poster. 4 MB is comfortably more than a typical 2:3 JPEG at 2x retina,
# and well under any worker memory budget.
POSTER_MAX_BYTES = 4 * 1024 * 1024

ALLOWED_POSTER_MIMES = frozenset({
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
})


@dataclass
class _State:
    title: str = ""
    description: str = ""
    imdb_url: str = ""
    trailer_url: str = ""
    poster_bytes: bytes = b""
    poster_mime: str = ""
    poster_etag: str = ""        # bumped on each upload so caches refresh
    updated_at: datetime | None = None
    _lock: threading.RLock = field(default_factory=threading.RLock)


class StreamInfo:
    TITLE_MAX = 200
    DESC_MAX = 2000
    URL_MAX = 500

    def __init__(self) -> None:
        self._s = _State()

    # ── Mutators ──────────────────────────────────────────────────────
    @staticmethod
    def _sanitize_url(url: str | None) -> str:
        url = (url or "").strip()
        if url and not (url.startswith("http://") or url.startswith("https://")):
            return ""
        return url

    def update_text(
        self,
        title: str | None,
        description: str | None,
        imdb_url: str | None,
        trailer_url: str | None,
    ) -> bool:
        """Update text fields. Returns True if anything changed."""
        with self._s._lock:
            new_title = (title or "").strip()[: self.TITLE_MAX]
            new_desc = (description or "").strip()[: self.DESC_MAX]
            new_imdb = self._sanitize_url(imdb_url)[: self.URL_MAX]
            new_trailer = self._sanitize_url(trailer_url)[: self.URL_MAX]

            changed = (
                new_title != self._s.title or
                new_desc != self._s.description or
                new_imdb != self._s.imdb_url or
                new_trailer != self._s.trailer_url
            )
            self._s.title = new_title
            self._s.description = new_desc
            self._s.imdb_url = new_imdb
            self._s.trailer_url = new_trailer
            if changed:
                self._s.updated_at = datetime.now(timezone.utc)
            return changed

    def set_poster(self, data: bytes, mime: str) -> bool:
        with self._s._lock:
            if mime not in ALLOWED_POSTER_MIMES:
                return False
            if not data or len(data) > POSTER_MAX_BYTES:
                return False
            self._s.poster_bytes = bytes(data)
            self._s.poster_mime = mime
            # Cheap deterministic etag — length + first/last 8 bytes
            # hex. We don't need cryptographic strength, just cache-
            # busting on poster swap.
            tag = "%d-%s-%s" % (
                len(data),
                data[:8].hex() if len(data) >= 8 else "",
                data[-8:].hex() if len(data) >= 8 else "",
            )
            self._s.poster_etag = tag
            self._s.updated_at = datetime.now(timezone.utc)
            return True

    def clear_poster(self) -> bool:
        with self._s._lock:
            if not self._s.poster_bytes:
                return False
            self._s.poster_bytes = b""
            self._s.poster_mime = ""
            self._s.poster_etag = ""
            self._s.updated_at = datetime.now(timezone.utc)
            return True

    def clear(self) -> bool:
        """Wipe everything — used by the broadcaster's "Clear Now Showing".
        Returns True if there was anything to clear."""
        with self._s._lock:
            had = bool(
                self._s.title or self._s.description or self._s.imdb_url or
                self._s.trailer_url or self._s.poster_bytes
            )
            self._s.title = ""
            self._s.description = ""
            self._s.imdb_url = ""
            self._s.trailer_url = ""
            self._s.poster_bytes = b""
            self._s.poster_mime = ""
            self._s.poster_etag = ""
            self._s.updated_at = datetime.now(timezone.utc)
            return had

    def hydrate(
        self, *, title, description, imdb_url, trailer_url,
        poster_bytes, poster_mime, poster_etag, updated_at,
    ) -> None:
        """Replace all in-memory state from a persisted snapshot. Used at
        startup; performs no persistence side effects."""
        with self._s._lock:
            self._s.title = title or ""
            self._s.description = description or ""
            self._s.imdb_url = imdb_url or ""
            self._s.trailer_url = trailer_url or ""
            self._s.poster_bytes = bytes(poster_bytes or b"")
            self._s.poster_mime = poster_mime or ""
            self._s.poster_etag = poster_etag or ""
            self._s.updated_at = updated_at

    def snapshot_full(self) -> dict:
        """Complete snapshot INCLUDING poster bytes — for DB persistence."""
        with self._s._lock:
            return {
                "title": self._s.title,
                "description": self._s.description,
                "imdb_url": self._s.imdb_url,
                "trailer_url": self._s.trailer_url,
                "poster_bytes": self._s.poster_bytes,
                "poster_mime": self._s.poster_mime,
                "poster_etag": self._s.poster_etag,
                "updated_at": self._s.updated_at,
            }

    # ── Readers ───────────────────────────────────────────────────────
    def has_poster(self) -> bool:
        with self._s._lock:
            return bool(self._s.poster_bytes)

    def poster(self) -> tuple[bytes, str, str] | None:
        with self._s._lock:
            if not self._s.poster_bytes:
                return None
            return (self._s.poster_bytes, self._s.poster_mime, self._s.poster_etag)

    def public(self) -> dict:
        """JSON-safe snapshot. Never includes the poster bytes —
        viewers fetch those via GET /poster."""
        with self._s._lock:
            return {
                "title": self._s.title,
                "description": self._s.description,
                "imdb_url": self._s.imdb_url,
                "trailer_url": self._s.trailer_url,
                "has_poster": bool(self._s.poster_bytes),
                "poster_etag": self._s.poster_etag,
                "updated_at": (
                    self._s.updated_at.isoformat()
                    if self._s.updated_at else None
                ),
            }


stream_info = StreamInfo()


# ── Database persistence ──────────────────────────────────────────────
# The live values live in memory (above) for fast reads, but we mirror
# them to a single-row `now_showing` table so they survive a worker
# restart. db / model are imported lazily to avoid import cycles.

def persist() -> None:
    """Write the current in-memory Now Showing to its DB singleton row."""
    from ..extensions import db
    from ..models import NowShowing

    s = stream_info.snapshot_full()
    row = db.session.get(NowShowing, 1)
    if row is None:
        row = NowShowing(id=1)
        db.session.add(row)
    row.title = s["title"]
    row.description = s["description"]
    row.imdb_url = s["imdb_url"]
    row.trailer_url = s["trailer_url"]
    row.poster_bytes = s["poster_bytes"] or None
    row.poster_mime = s["poster_mime"] or None
    row.poster_etag = s["poster_etag"]
    row.updated_at = s["updated_at"]
    db.session.commit()


def load_from_db() -> None:
    """Hydrate the in-memory Now Showing from the DB at startup."""
    from ..extensions import db
    from ..models import NowShowing

    row = db.session.get(NowShowing, 1)
    if row is None:
        return
    stream_info.hydrate(
        title=row.title,
        description=row.description,
        imdb_url=row.imdb_url,
        trailer_url=row.trailer_url,
        poster_bytes=row.poster_bytes or b"",
        poster_mime=row.poster_mime or "",
        poster_etag=row.poster_etag or "",
        updated_at=row.updated_at,
    )
