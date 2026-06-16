"""In-memory broadcast state + late-joiner buffer.

The hard problem of "let a viewer who joined mid-stream actually play
something" is that MediaSource Extensions need:

  1. the WebM/EBML header (Segment, Tracks, etc.) — call this the "init"
  2. a media segment that starts with a keyframe.

MediaRecorder emits a continuous byte stream where the FIRST chunk
contains the init + the start of the first cluster, and subsequent
chunks are continuations. So caching just "the first chunk" lets MSE
decode exactly one frame and then stall.

Fix: scan the incoming chunks for the Cluster EBML ID (0x1F43B675).
Each Cluster starts on a keyframe, so we can hand a late joiner:

    header_bytes + last_complete_cluster + current_cluster_so_far

and they'll catch up to live in a few seconds. After that, the normal
fan-out of live `bcast:chunk` events keeps them in sync.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone


# WebM (Matroska) EBML ID for a Cluster element. Each cluster begins
# with a keyframe, which is the only safe place for MSE to start.
CLUSTER_ID = b"\x1f\x43\xb6\x75"


@dataclass
class _State:
    live: bool = False
    paused: bool = False                 # broadcaster paused the source (file mode)
    broadcaster_sid: str | None = None
    broadcaster_username: str | None = None
    mime_type: str | None = None
    started_at: datetime | None = None
    viewer_sids: set[str] = field(default_factory=set)

    # Stream quality metadata reported by the broadcaster (actual values
    # negotiated by the camera, not the requested values).
    quality_label: str | None = None     # e.g. "1080p"
    width: int = 0
    height: int = 0
    frame_rate: int = 0
    bitrate: int = 0                     # configured encoder bitrate, bits/sec

    # Access lock: viewers must submit the code via `viewer:auth` before
    # they can receive any stream chunks. Stored in memory only; the
    # broadcaster's browser owns the canonical copy via localStorage.
    lock_enabled: bool = False
    access_code: str | None = None       # 5 uppercase alphanumeric, no 0/O/1/I/L
    # Whether viewers may rain emoji reactions over the video. Broadcaster-
    # controlled; owned by the broadcaster's browser (localStorage) and
    # pushed to the server on connect, like the lock.
    reactions_enabled: bool = True
    # A broadcaster alert banner that drops down over the top of every
    # viewer's video and stays up until the broadcaster clears it. Empty =
    # no banner. Owned by the broadcaster's browser and re-pushed on connect.
    alert_message: str = ""
    authed_viewer_sids: set[str] = field(default_factory=set)
    # Per-IP failed-auth tracking. Maps each viewer's IP to
    # { "count": int, "locked_until": datetime | None }. Wiped along
    # with the chat ban list when a broadcast stops.
    failed_code_attempts: dict = field(default_factory=dict)

    # Late-joiner buffer --------------------------------------------------
    header_bytes: bytes = b""            # EBML + Segment + Tracks (before 1st Cluster)
    last_complete_cluster: bytes = b""   # most recent fully-received cluster
    current_cluster: bytes = b""         # in-progress cluster
    has_seen_first_cluster: bool = False

    _lock: threading.RLock = field(default_factory=threading.RLock)


class BroadcastState:
    def __init__(self) -> None:
        self._s = _State()

    # ── Broadcaster lifecycle ──────────────────────────────────────────
    def start(
        self,
        sid: str,
        username: str,
        mime_type: str,
        meta: dict | None = None,
    ) -> bool:
        """Claim the broadcast slot. Returns False if already taken."""
        with self._s._lock:
            if self._s.live and self._s.broadcaster_sid != sid:
                return False
            self._s.live = True
            self._s.paused = False
            self._s.broadcaster_sid = sid
            self._s.broadcaster_username = username
            self._s.mime_type = mime_type
            self._s.started_at = datetime.now(timezone.utc)
            self._apply_meta_locked(meta or {})
            self._reset_buffer_locked()
            return True

    def set_paused(self, sid: str, paused: bool) -> bool:
        """Flag the live broadcast as paused/resumed (file source paused).
        Returns False if `sid` isn't the current broadcaster."""
        with self._s._lock:
            if not self._s.live or self._s.broadcaster_sid != sid:
                return False
            self._s.paused = bool(paused)
            return True

    def update_meta(self, sid: str, meta: dict) -> bool:
        """Update quality metadata mid-stream (e.g. if the camera
        renegotiates after a device switch)."""
        with self._s._lock:
            if not self._s.live or self._s.broadcaster_sid != sid:
                return False
            self._apply_meta_locked(meta or {})
            return True

    def _apply_meta_locked(self, meta: dict) -> None:
        try:
            self._s.width = int(meta.get("width") or 0)
            self._s.height = int(meta.get("height") or 0)
            self._s.frame_rate = int(round(float(meta.get("frameRate") or 0)))
            self._s.bitrate = int(meta.get("bitrate") or 0)
        except (TypeError, ValueError):
            self._s.width = self._s.height = self._s.frame_rate = 0
            self._s.bitrate = 0
        q = meta.get("quality")
        self._s.quality_label = q if isinstance(q, str) and q else None

    def stop(self, sid: str | None = None) -> None:
        with self._s._lock:
            if sid is not None and self._s.broadcaster_sid != sid:
                return
            self._s.live = False
            self._s.paused = False
            self._s.broadcaster_sid = None
            self._s.broadcaster_username = None
            self._s.mime_type = None
            self._s.started_at = None
            self._s.quality_label = None
            self._s.width = self._s.height = self._s.frame_rate = 0
            self._s.bitrate = 0
            # NOTE: lock state (lock_enabled / access_code / authed sids)
            # deliberately persists across broadcasts. Viewers should see
            # the lock screen even between streams, and viewers who
            # entered the code earlier shouldn't have to re-auth every
            # time the broadcaster goes live again.
            self._reset_buffer_locked()

    def _reset_buffer_locked(self) -> None:
        self._s.header_bytes = b""
        self._s.last_complete_cluster = b""
        self._s.current_cluster = b""
        self._s.has_seen_first_cluster = False

    # ── Access lock ────────────────────────────────────────────────────
    _CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"   # no 0/O/1/I/L

    @classmethod
    def _normalize_code(cls, code: str | None) -> str | None:
        if not code:
            return None
        upper = "".join(ch for ch in str(code).upper() if ch.isalnum())
        return upper[:5] if upper else None

    def set_lock(self, enabled: bool, code: str | None) -> bool:
        """Update the lock state independently of broadcast lifecycle.
        Returns True iff the lock-enabled flag or the code actually
        changed (the caller should kick + re-notify viewers in that
        case). Authorization is the caller's responsibility — events.py
        gates this via the Flask-Login current_user permission check.
        """
        with self._s._lock:
            new_enabled = bool(enabled)
            new_code = self._normalize_code(code) if new_enabled else None
            changed = (
                new_enabled != self._s.lock_enabled or
                new_code != self._s.access_code
            )
            self._s.lock_enabled = new_enabled
            self._s.access_code = new_code
            if changed:
                # Drop existing authorizations so everyone re-auths.
                self._s.authed_viewer_sids.clear()
            return changed

    def is_locked(self) -> bool:
        with self._s._lock:
            return bool(self._s.lock_enabled and self._s.access_code)

    def lock_state(self) -> tuple[bool, str | None]:
        """Current (enabled, code) — used to mirror the lock to the DB."""
        with self._s._lock:
            return (self._s.lock_enabled, self._s.access_code)

    def check_code(self, code: str) -> bool:
        with self._s._lock:
            if not self._s.lock_enabled or not self._s.access_code:
                return True   # not locked → everyone allowed
            return self._normalize_code(code) == self._s.access_code

    # ── Per-IP brute-force throttle ───────────────────────────────────
    #
    # Track failed attempts per source IP. After 5 wrong codes the
    # lockout begins at 30 s and roughly doubles each additional miss,
    # capped at 30 minutes. This is plenty to make the 31^5 ≈ 28 M code
    # space impractical to brute force while keeping a genuine typo
    # essentially zero-cost.
    AUTH_FAIL_GRACE = 4      # first N misses don't lock out at all
    AUTH_FAIL_BASE = 30      # seconds for the first lockout
    AUTH_FAIL_MAX = 30 * 60  # cap at 30 min

    def auth_throttle_remaining(self, ip: str) -> int:
        """Seconds left in the current lockout for `ip`, or 0 if not
        currently throttled. Side-effect: expires the lock cleanly so
        the next failure starts a fresh window without losing the
        accumulated count."""
        with self._s._lock:
            rec = self._s.failed_code_attempts.get(ip)
            if not rec:
                return 0
            locked_until = rec.get("locked_until")
            if not locked_until:
                return 0
            now = datetime.now(timezone.utc)
            if locked_until.tzinfo is None:
                locked_until = locked_until.replace(tzinfo=timezone.utc)
            delta = (locked_until - now).total_seconds()
            if delta <= 0:
                rec["locked_until"] = None
                return 0
            return int(delta) + 1

    def record_auth_failure(self, ip: str) -> int:
        """Increment failure counter and return new lockout duration in
        seconds (0 if we're still within the grace window)."""
        with self._s._lock:
            rec = self._s.failed_code_attempts.setdefault(
                ip, {"count": 0, "locked_until": None}
            )
            rec["count"] = int(rec.get("count", 0)) + 1
            if rec["count"] <= self.AUTH_FAIL_GRACE:
                return 0
            # 5th miss = base (30 s), 6th = 60, 7th = 120, … capped.
            exp = rec["count"] - self.AUTH_FAIL_GRACE - 1
            backoff = min(self.AUTH_FAIL_MAX, self.AUTH_FAIL_BASE * (2 ** exp))
            rec["locked_until"] = datetime.now(timezone.utc) + timedelta(seconds=backoff)
            return backoff

    def record_auth_success(self, ip: str) -> None:
        """Forgive failed attempts for an IP after a correct entry."""
        with self._s._lock:
            self._s.failed_code_attempts.pop(ip, None)

    def clear_auth_attempts(self) -> None:
        """Wipe the per-IP failure counters — called when a broadcast
        stops, mirroring chat_state.clear_bans()."""
        with self._s._lock:
            self._s.failed_code_attempts.clear()

    def authorize_viewer(self, sid: str) -> None:
        with self._s._lock:
            self._s.authed_viewer_sids.add(sid)

    def is_authorized(self, sid: str) -> bool:
        with self._s._lock:
            if not (self._s.lock_enabled and self._s.access_code):
                return True
            return sid in self._s.authed_viewer_sids

    def viewer_sids(self) -> list[str]:
        with self._s._lock:
            return list(self._s.viewer_sids)

    def is_broadcaster(self, sid: str) -> bool:
        with self._s._lock:
            return self._s.live and self._s.broadcaster_sid == sid

    # ── Late-joiner buffer ────────────────────────────────────────────
    def ingest_chunk(self, sid: str, chunk: bytes) -> None:
        """Scan a chunk for Cluster boundaries and update the late-joiner
        buffer accordingly. Called for every chunk the broadcaster sends,
        BEFORE the chunk is fanned out to viewers."""
        with self._s._lock:
            if not self._s.live or self._s.broadcaster_sid != sid:
                return
            i = 0
            n = len(chunk)
            while i < n:
                idx = chunk.find(CLUSTER_ID, i)
                if idx == -1:
                    # No more cluster IDs in this chunk; tail goes to
                    # whichever bucket is currently open.
                    tail = chunk[i:]
                    if self._s.has_seen_first_cluster:
                        self._s.current_cluster += tail
                    else:
                        self._s.header_bytes += tail
                    break
                # Bytes [i, idx) belong to whatever section was open.
                before = chunk[i:idx]
                if self._s.has_seen_first_cluster:
                    self._s.current_cluster += before
                    # current_cluster is now complete — promote it.
                    self._s.last_complete_cluster = self._s.current_cluster
                    self._s.current_cluster = b""
                else:
                    self._s.header_bytes += before
                    self._s.has_seen_first_cluster = True
                # The CLUSTER_ID bytes themselves start the new cluster.
                self._s.current_cluster = bytes(CLUSTER_ID)
                i = idx + 4

    def late_joiner_payload(self) -> bytes | None:
        """Concatenated bytes to send a late joiner so MSE can start playing.

        Returns None if no broadcast is live or no data has been received yet.
        Returns header_bytes alone if we haven't seen a complete cluster yet
        — the SourceBuffer can at least be initialized and the next live
        chunks will fill in the media.
        """
        with self._s._lock:
            if not self._s.live:
                return None
            parts: list[bytes] = []
            if self._s.header_bytes:
                parts.append(self._s.header_bytes)
            if self._s.has_seen_first_cluster:
                if self._s.last_complete_cluster:
                    parts.append(self._s.last_complete_cluster)
                if self._s.current_cluster:
                    parts.append(self._s.current_cluster)
            payload = b"".join(parts)
            return payload if payload else None

    # ── Viewer tracking ────────────────────────────────────────────────
    def add_viewer(self, sid: str) -> int:
        with self._s._lock:
            self._s.viewer_sids.add(sid)
            return len(self._s.viewer_sids)

    def remove_viewer(self, sid: str) -> int:
        with self._s._lock:
            self._s.viewer_sids.discard(sid)
            self._s.authed_viewer_sids.discard(sid)
            return len(self._s.viewer_sids)

    def viewer_count(self) -> int:
        with self._s._lock:
            return len(self._s.viewer_sids)

    # ── Read-only snapshot for templates / events ────────────────────
    def snapshot(self) -> dict:
        with self._s._lock:
            return {
                "live": self._s.live,
                "paused": self._s.paused,
                "broadcaster": self._s.broadcaster_username,
                "mime_type": self._s.mime_type,
                "viewers": len(self._s.viewer_sids),
                "started_at": (
                    self._s.started_at.isoformat() if self._s.started_at else None
                ),
                "has_init_segment": bool(self._s.header_bytes),
                "quality": self._s.quality_label,
                "width": self._s.width,
                "height": self._s.height,
                "frame_rate": self._s.frame_rate,
                "bitrate": self._s.bitrate,
                # The access code itself is NEVER included — viewers
                # only learn whether a lock is in place, not the value.
                "lock_enabled": bool(self._s.lock_enabled and self._s.access_code),
                "reactions_enabled": bool(self._s.reactions_enabled),
                "alert": self._s.alert_message,
            }

    # ── Viewer reactions ───────────────────────────────────────────────
    def reactions_enabled(self) -> bool:
        with self._s._lock:
            return bool(self._s.reactions_enabled)

    def set_reactions_enabled(self, enabled: bool) -> bool:
        """Returns True iff the flag actually changed."""
        with self._s._lock:
            new = bool(enabled)
            if new == self._s.reactions_enabled:
                return False
            self._s.reactions_enabled = new
            return True

    # ── Alert banner ───────────────────────────────────────────────────
    def get_alert(self) -> str:
        with self._s._lock:
            return self._s.alert_message

    def set_alert(self, message: str) -> bool:
        """Set (or clear, when empty) the broadcaster alert banner. Returns
        True iff the message actually changed."""
        with self._s._lock:
            msg = (message or "").strip()[:300]
            if msg == self._s.alert_message:
                return False
            self._s.alert_message = msg
            return True


broadcast_state = BroadcastState()


# ── Lock persistence ──────────────────────────────────────────────────
# The lock (enabled + code) lives in memory for fast checks, but is
# mirrored to a single-row `stream_lock` table so it survives a worker
# restart. db / model are imported lazily to avoid import cycles.

def persist_lock() -> None:
    """Write the current in-memory lock state to its DB singleton row."""
    from ..extensions import db
    from ..models import StreamLock

    enabled, code = broadcast_state.lock_state()
    row = db.session.get(StreamLock, 1)
    if row is None:
        row = StreamLock(id=1)
        db.session.add(row)
    row.enabled = bool(enabled)
    row.code = code
    db.session.commit()


def load_lock_from_db() -> None:
    """Hydrate the in-memory lock from the DB at startup so an existing
    code keeps working across restarts without a broadcaster reconnect."""
    from ..extensions import db
    from ..models import StreamLock

    row = db.session.get(StreamLock, 1)
    if row is None:
        return
    broadcast_state.set_lock(bool(row.enabled), row.code)
