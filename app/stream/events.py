"""Socket.IO event handlers — the realtime fan-out for streaming.

Flow:
1. An authenticated broadcaster connects, joins the `broadcasters` room, and
   emits `bcast:start` with the MediaRecorder MIME type. The first chunk
   they send is treated as the WebM init segment (header + ftyp/moov) and
   cached so that late-joining viewers can rebuild their MediaSource.
2. Subsequent `bcast:chunk` payloads are broadcast as binary `stream:chunk`
   events to every socket in the `viewers` room.
3. A viewer connects (anonymous OK), joins the `viewers` room, and the
   server immediately replies with `stream:state` + (if available) the
   cached init segment so the viewer can start playback mid-stream.
"""
from __future__ import annotations

import time

from flask import current_app, request
from flask_login import current_user
from flask_socketio import disconnect, emit, join_room, leave_room

from ..extensions import socketio
from .state import broadcast_state


VIEWERS_ROOM = "viewers"            # every connected viewer (for state push)
AUTHED_VIEWERS_ROOM = "authed"      # subset that's allowed to receive chunks
BROADCASTERS_ROOM = "broadcasters"

# Floating video reactions a viewer can rain over the player. Server-side
# allow-list so only these can be broadcast (no arbitrary payloads).
VIDEO_REACTIONS = {
    "🤣", "♥️", "🫠", "👍", "😍", "💩",
    "💀", "💦", "🍆", "🤬", "🤩", "🏳️‍🌈", "👀", "😈",
}
_REACT_MIN_INTERVAL = 0.12          # seconds between reactions per viewer
_react_last: dict[str, float] = {}  # sid -> last reaction monotonic time


# ── Connection lifecycle ────────────────────────────────────────────────────


@socketio.on("connect")
def _on_connect():
    # Accept the connection; role is decided by the first join event.
    emit("stream:state", broadcast_state.snapshot())


@socketio.on("disconnect")
def _on_disconnect():
    sid = request.sid
    if broadcast_state.is_broadcaster(sid):
        broadcast_state.stop(sid)
        # Bans are scoped to the lifetime of a stream — clear them when
        # the broadcaster leaves so a future broadcast starts fresh.
        from ..chat.state import chat_state
        chat_state.clear_bans()
        chat_state.clear_mutes()
        broadcast_state.clear_auth_attempts()
        socketio.emit(
            "stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM
        )
        socketio.emit("bcast:ended", {"reason": "disconnected"}, to=BROADCASTERS_ROOM)
    else:
        new_count = broadcast_state.remove_viewer(sid)
        # Push the updated count to both the broadcaster (so their
        # session card stays accurate) AND every other viewer (so the
        # "N watching" indicator updates live).
        _broadcast_viewer_count(new_count)
    # Also drop the sid from the chat roster — runs for every kind of
    # connected socket, broadcaster or viewer.
    from ..chat.events import handle_disconnect
    handle_disconnect(sid)


# ── Viewer ──────────────────────────────────────────────────────────────────


@socketio.on("viewer:join")
def _viewer_join():
    sid = request.sid
    join_room(VIEWERS_ROOM)
    count = broadcast_state.add_viewer(sid)
    snap = broadcast_state.snapshot()
    emit("stream:state", snap)

    # If the stream is locked, gate the chunk delivery until the viewer
    # submits the right code via viewer:auth. Otherwise grant access
    # immediately and ship the late-joiner buffer.
    if snap.get("lock_enabled") and not broadcast_state.is_authorized(sid):
        emit("stream:locked", {})
    else:
        _grant_viewer_access(sid, snap)
    _broadcast_viewer_count(count)


@socketio.on("viewer:leave")
def _viewer_leave():
    sid = request.sid
    leave_room(VIEWERS_ROOM)
    leave_room(AUTHED_VIEWERS_ROOM)
    count = broadcast_state.remove_viewer(sid)
    _broadcast_viewer_count(count)


@socketio.on("viewer:react")
def _viewer_react(payload):
    """A viewer taps a reaction emoji — fan it out so it rains over every
    viewer's player (and skip the sender, who renders it locally for instant
    feedback). Validated against the allow-list and lightly rate-limited."""
    sid = request.sid
    emoji = (payload or {}).get("emoji")
    if emoji not in VIDEO_REACTIONS:
        return
    if not broadcast_state.reactions_enabled():
        return
    # Resolve the reactor's identity (name + chat avatar) so the reaction can
    # descend labelled. Chat participants are looked up by sid; an
    # authenticated broadcaster may react from the backend even if their
    # stream socket isn't the one registered in chat.
    from ..chat.state import chat_state, _color_for
    user = chat_state.user(sid)
    if user is not None:
        name, avatar, color = user.name, user.emoji, user.color
    elif current_user.is_authenticated and current_user.can_broadcast():
        name = current_user.chat_name or current_user.username or "Host"
        avatar = current_user.chat_emoji or "🎬"
        color = _color_for(name)
    else:
        return
    now = time.monotonic()
    if now - _react_last.get(sid, 0.0) < _REACT_MIN_INTERVAL:
        return
    _react_last[sid] = now
    # Bound the throttle map so disconnected sids can't accumulate forever.
    if len(_react_last) > 2000:
        _react_last.clear()
    data = {"emoji": emoji, "name": name, "avatar": avatar, "color": color}
    # Fan out to every viewer AND the broadcaster's preview, skipping the
    # sender so nobody sees their own reaction echoed back. (skip_sid applies
    # across both rooms — a broadcaster reacting won't see their own, and a
    # viewer reacting still sees only their local optimistic render.)
    socketio.emit("video:reaction", data, to=VIEWERS_ROOM, skip_sid=sid)
    socketio.emit("video:reaction", data, to=BROADCASTERS_ROOM, skip_sid=sid)


@socketio.on("viewer:auth")
def _viewer_auth(payload):
    sid = request.sid
    code = (payload or {}).get("code", "")
    ip = _viewer_ip()

    # Throttle BEFORE checking the code so an attacker doesn't get a
    # timing oracle on which codes "took longer".
    remaining = broadcast_state.auth_throttle_remaining(ip)
    if remaining > 0:
        emit("stream:auth_fail", {"reason": "rate_limited", "retry_after": remaining})
        return

    if not broadcast_state.check_code(code):
        backoff = broadcast_state.record_auth_failure(ip)
        if backoff > 0:
            emit("stream:auth_fail", {"reason": "rate_limited", "retry_after": backoff})
        else:
            emit("stream:auth_fail", {"reason": "wrong_code"})
        return

    broadcast_state.record_auth_success(ip)
    broadcast_state.authorize_viewer(sid)
    emit("stream:auth_ok", {})
    _grant_viewer_access(sid, broadcast_state.snapshot())


def _viewer_ip() -> str:
    """Real public client IP for ban/throttle purposes. Mirrors the
    chat module's helper — XFF leftmost is the original client when
    we're behind a reverse proxy."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    for h in ("CF-Connecting-IP", "True-Client-IP", "X-Real-IP"):
        v = request.headers.get(h, "").strip()
        if v:
            return v
    return request.remote_addr or "0.0.0.0"


def _grant_viewer_access(sid: str, snap: dict) -> None:
    """Add the viewer to the chunk-receiving room, tell them the door is
    open (so the lock screen hides), and replay the late-joiner buffer
    so their MSE can start playing immediately."""
    join_room(AUTHED_VIEWERS_ROOM)
    emit("stream:auth_ok", {})
    if not snap.get("live"):
        return
    payload = broadcast_state.late_joiner_payload()
    if payload:
        emit("stream:init", {"mime": snap.get("mime_type")})
        emit("stream:chunk", payload)


def _broadcast_viewer_count(count: int) -> None:
    """Push the current viewer count to the broadcaster AND every
    viewer, so the on-screen "N watching" indicator stays accurate
    on both sides without waiting for a stream:state full snapshot."""
    payload = {"count": count}
    socketio.emit("stream:viewers", payload, to=BROADCASTERS_ROOM)
    socketio.emit("stream:viewers", payload, to=VIEWERS_ROOM)


# ── Broadcaster ─────────────────────────────────────────────────────────────


def _require_broadcaster() -> bool:
    if not current_user.is_authenticated:
        emit("bcast:error", {"message": "Not signed in."})
        return False
    if not current_user.can_broadcast():
        emit("bcast:error", {"message": "Not authorized to broadcast."})
        return False
    return True


@socketio.on("bcast:start")
def _bcast_start(payload):
    if not _require_broadcaster():
        return
    sid = request.sid
    payload = payload or {}
    mime = payload.get("mime") or "video/webm"
    meta = payload.get("meta") or {}
    # Sanity-check the MIME type: only allow webm or mp4 fragments.
    if not (mime.startswith("video/webm") or mime.startswith("video/mp4")):
        emit("bcast:error", {"message": f"Unsupported MIME type: {mime}"})
        return
    if not broadcast_state.start(sid, current_user.username, mime, meta):
        emit("bcast:error", {"message": "Another broadcaster is already live."})
        return
    # Apply the broadcaster's saved lock payload. set_lock returns True
    # if anything actually changed since the last push, so we only kick
    # viewers when needed.
    lock = payload.get("lock") or {}
    lock_changed = broadcast_state.set_lock(bool(lock.get("enabled")), lock.get("code"))

    join_room(BROADCASTERS_ROOM)
    snap = broadcast_state.snapshot()
    emit("bcast:started", snap)
    socketio.emit("stream:state", snap, to=VIEWERS_ROOM)

    if lock_changed:
        _apply_lock_transition(snap)
    elif not snap.get("lock_enabled"):
        # Lock unchanged + still off — make sure any viewer that joined
        # while we were off-air is in the chunk room.
        for vsid in broadcast_state.viewer_sids():
            broadcast_state.authorize_viewer(vsid)
            try:
                socketio.server.enter_room(vsid, AUTHED_VIEWERS_ROOM, namespace="/")
            except Exception:
                pass

    # In every case: send authed viewers a fresh init segment so MSE
    # rebuilds against the new MediaRecorder. Locked-out viewers stay
    # on the lock screen and won't receive this.
    socketio.emit("stream:init", {"mime": mime}, to=AUTHED_VIEWERS_ROOM)

    current_app.logger.info(
        "Broadcast started by %s (mime=%s, %sx%s@%sfps, locked=%s)",
        current_user.username, mime,
        snap.get("width"), snap.get("height"), snap.get("frame_rate"),
        snap.get("lock_enabled"),
    )


def _apply_lock_transition(snap: dict) -> None:
    """Handle the side-effects of the lock state actually changing:
    kick everyone out of the chunk room and tell them to re-auth, or
    quietly grant everyone access and replay the buffer."""
    if snap.get("lock_enabled"):
        socketio.close_room(AUTHED_VIEWERS_ROOM)
        socketio.emit("stream:locked", {}, to=VIEWERS_ROOM)
        return
    # Unlocked: grant every viewer access and replay the late-joiner
    # buffer so their MSE picks up the stream without a manual refresh.
    for vsid in broadcast_state.viewer_sids():
        broadcast_state.authorize_viewer(vsid)
        try:
            socketio.server.enter_room(vsid, AUTHED_VIEWERS_ROOM, namespace="/")
        except Exception:
            pass
    if snap.get("live"):
        data = broadcast_state.late_joiner_payload()
        if data:
            socketio.emit("stream:init", {"mime": snap.get("mime_type")},
                          to=AUTHED_VIEWERS_ROOM)
            socketio.emit("stream:chunk", data, to=AUTHED_VIEWERS_ROOM)
    socketio.emit("stream:unlocked", {}, to=VIEWERS_ROOM)


@socketio.on("bcast:set_reactions")
def _bcast_set_reactions(payload):
    """Enable/disable viewer video reactions. Allowed for any broadcaster-
    capable user (pushed on connect + on toggle), and reflected to viewers
    via stream:state so their reaction button shows/hides."""
    if not current_user.is_authenticated or not current_user.can_broadcast():
        emit("bcast:error", {"message": "Not authorized."})
        return
    enabled = bool((payload or {}).get("enabled"))
    if broadcast_state.set_reactions_enabled(enabled):
        socketio.emit("stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM)


@socketio.on("bcast:set_alert")
def _bcast_set_alert(payload):
    """Show or clear the broadcaster alert banner. Allowed for any
    broadcaster-capable user (pushed on connect + on change), and reflected
    to viewers via stream:state so the banner drops down / retracts."""
    if not current_user.is_authenticated or not current_user.can_broadcast():
        emit("bcast:error", {"message": "Not authorized."})
        return
    message = (payload or {}).get("message", "")
    if broadcast_state.set_alert(message):
        socketio.emit("stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM)


@socketio.on("bcast:meta")
def _bcast_meta(payload):
    """Broadcaster-pushed metadata update mid-stream (device switch, etc.)."""
    sid = request.sid
    if not broadcast_state.is_broadcaster(sid):
        return
    if not broadcast_state.update_meta(sid, payload or {}):
        return
    socketio.emit("stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM)


@socketio.on("bcast:set_lock")
def _bcast_set_lock(payload):
    """Configure the access lock. Allowed for any broadcaster-capable
    user, NOT just the currently-live one — so the lock can be armed
    before going live and stay enforced between broadcasts."""
    if not current_user.is_authenticated or not current_user.can_broadcast():
        emit("bcast:error", {"message": "Not authorized."})
        return
    payload = payload or {}
    enabled = bool(payload.get("enabled"))
    code = payload.get("code")
    changed = broadcast_state.set_lock(enabled, code)
    # Mirror to the DB so the lock survives a restart (and so the
    # broadcaster reconnecting with the same code is a true no-op).
    from .state import persist_lock
    persist_lock()
    snap = broadcast_state.snapshot()
    socketio.emit("stream:state", snap, to=VIEWERS_ROOM)
    if changed:
        _apply_lock_transition(snap)


@socketio.on("bcast:paused")
def _bcast_paused(payload):
    """Broadcaster paused/resumed the video file. Relay to viewers so they
    can show a 'Paused' overlay while no chunks are flowing."""
    sid = request.sid
    paused = bool((payload or {}).get("paused"))
    if not broadcast_state.set_paused(sid, paused):
        return
    socketio.emit("stream:paused", {"paused": paused}, to=VIEWERS_ROOM)


@socketio.on("bcast:chunk")
def _bcast_chunk(data):
    sid = request.sid
    if not broadcast_state.is_broadcaster(sid):
        # Silently drop — don't reveal whether someone else is broadcasting.
        return
    if not isinstance(data, (bytes, bytearray, memoryview)):
        emit("bcast:error", {"message": "Chunk must be binary."})
        return
    chunk = bytes(data)
    # Update the late-joiner buffer (scans for Cluster boundaries), then
    # fan the chunk out only to viewers who are allowed to see it (every
    # viewer if no lock is set; only authed viewers if one is).
    broadcast_state.ingest_chunk(sid, chunk)
    socketio.emit("stream:chunk", chunk, to=AUTHED_VIEWERS_ROOM)


@socketio.on("bcast:stop")
def _bcast_stop():
    sid = request.sid
    if not broadcast_state.is_broadcaster(sid):
        return
    broadcast_state.stop(sid)
    from ..chat.state import chat_state
    chat_state.clear_bans()
    chat_state.clear_mutes()
    broadcast_state.clear_auth_attempts()
    leave_room(BROADCASTERS_ROOM)
    emit("bcast:ended", {"reason": "stopped"})
    socketio.emit("stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM)
    socketio.emit("stream:ended", {"reason": "stopped"}, to=VIEWERS_ROOM)


@socketio.on("bcast:kick")
def _bcast_kick():
    """Admin-only: forcibly end whoever is broadcasting."""
    if not current_user.is_authenticated or not current_user.is_admin():
        emit("bcast:error", {"message": "Not authorized."})
        return
    broadcast_state.stop()
    from ..chat.state import chat_state
    chat_state.clear_bans()
    chat_state.clear_mutes()
    broadcast_state.clear_auth_attempts()
    socketio.emit("bcast:ended", {"reason": "kicked"}, to=BROADCASTERS_ROOM)
    socketio.emit("stream:ended", {"reason": "kicked"}, to=VIEWERS_ROOM)
    socketio.emit("stream:state", broadcast_state.snapshot(), to=VIEWERS_ROOM)
