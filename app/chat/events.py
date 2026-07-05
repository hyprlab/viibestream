"""Socket.IO handlers for the viewer chat panel + broadcaster moderation."""
from __future__ import annotations

from flask import current_app, request
from flask_login import current_user
from flask_socketio import emit, join_room, leave_room

from ..extensions import socketio
from .state import chat_state, persist_chat


CHAT_ROOM = "chat"
BROADCASTERS_ROOM = "broadcasters"


def _client_ip() -> str:
    """Real client IP for ban-list purposes.

    We MUST end up with the viewer's public IP, not the docker bridge
    address or nginx-proxy-manager's LAN IP — otherwise the broadcaster
    would ban the proxy itself and lock everyone out.

    Order of preference:
      1. X-Forwarded-For header (leftmost entry = original client).
         When BEHIND_HTTPS_PROXY=1 the ProxyFix middleware already
         rewrites remote_addr from this same header, but reading it
         directly is robust even if ProxyFix isn't wired up.
      2. CF-Connecting-IP / True-Client-IP (set by Cloudflare and a
         few other CDNs when they're terminating in front).
      3. request.remote_addr — last-resort fallback, will be a docker
         or LAN address in proxied deployments.
    """
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


def _persist_host_identity(name: str, emoji: str) -> None:
    """Save the broadcaster's chat name + emoji on their user record so it
    persists across refreshes and logins. No-op for non-host users."""
    if not (current_user.is_authenticated and current_user.can_broadcast()):
        return
    from ..extensions import db
    from ..models import User

    row = db.session.get(User, current_user.id)
    if row is None:
        return
    changed = False
    if name and row.chat_name != name:
        row.chat_name = name
        changed = True
    if emoji and row.chat_emoji != emoji:
        row.chat_emoji = emoji
        changed = True
    if changed:
        db.session.commit()


# ── Viewer events ─────────────────────────────────────────────────────


@socketio.on("chat:watch")
def _chat_watch(_payload=None):
    """Subscribe a viewer to the chat as a read-only spectator.

    Anyone can *read* the chat without picking a name. We add the socket
    to the chat room (so it receives live `chat:message`, roster, and
    enabled-state pushes) and reply with the current history snapshot.
    The spectator is NOT registered as a participant — no name, not
    counted in the roster — until they pick a name via `chat:join`.

    Banned IPs are refused so a kick can't be shrugged off with a reload.
    """
    if chat_state.is_banned(_client_ip()):
        emit("chat:watching", {"banned": True})
        return
    join_room(CHAT_ROOM)
    emit("chat:watching", {"state": chat_state.snapshot_public()})


@socketio.on("chat:join")
def _chat_join(payload):
    sid = request.sid
    ip = _client_ip()
    payload = payload or {}
    name = payload.get("name", "")
    # `resume` = a reconnecting viewer re-registering their existing name
    # (e.g. after a backend restart). It reclaims the name silently — no
    # "joined" announcement — so reconnects don't spam the chat.
    resume = bool(payload.get("resume"))
    emoji = payload.get("emoji")
    # Broadcaster-capable users are the host: they may join + post even when
    # chat is disabled, so they can keep talking to read-only viewers.
    is_host = current_user.is_authenticated and current_user.can_broadcast()

    # The host's identity is account-scoped, not localStorage-scoped: prefer
    # the name/emoji saved on their user record so it survives refreshes and
    # logins. Falls back to the client-sent username + a random emoji the
    # first time (which we then remember below).
    if is_host:
        if current_user.chat_name:
            name = current_user.chat_name
        if not emoji and current_user.chat_emoji:
            emoji = current_user.chat_emoji

    user, err = chat_state.join(sid, ip, name, resume=resume, emoji=emoji, is_host=is_host)
    if err:
        emit("chat:join_failed", {"reason": err})
        return

    # Remember whatever identity the host ended up with so the next refresh
    # reuses it (this is what makes the first random emoji "stick").
    if is_host:
        _persist_host_identity(user.name, user.emoji)

    join_room(CHAT_ROOM)
    emit("chat:joined", {"you": user.public(), "state": chat_state.snapshot_public()})

    # Always refresh the live count + broadcaster roster. Doing this on every
    # join (reloads included) balances the user_left a reload fires on the way
    # out, so the "N in chat" count doesn't drift.
    socketio.emit("chat:user_joined", user.public(), to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)

    # Announce the arrival — unless this join is just a reconnect (a leave was
    # pending for this name within the grace window, i.e. a page reload), or
    # it's the host (their presence is implied by the broadcast).
    returning = _cancel_pending_leave(user.name)
    if returning or is_host:
        return
    msg = chat_state.system(f"{user.name} joined the chat")
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    persist_chat()


@socketio.on("chat:send")
def _chat_send(payload):
    sid = request.sid
    payload = payload or {}
    text = payload.get("text", "")
    reply_to_raw = payload.get("reply_to")
    reply_to: int | None = None
    if reply_to_raw is not None:
        try:
            reply_to = int(reply_to_raw)
        except (TypeError, ValueError):
            reply_to = None
    msg = chat_state.post(sid, text, reply_to=reply_to)
    if not msg:
        return
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    socketio.emit("chat:message", msg.public(), to=BROADCASTERS_ROOM)
    persist_chat()


_REACTION_MAX_LEN = 24


def _valid_reaction(emoji) -> bool:
    """Light validation so reactions can be any palette emoji but never
    arbitrary text: non-empty, length-bounded, no whitespace, and no ASCII
    letters/digits (emojis are non-ASCII symbols)."""
    if not isinstance(emoji, str):
        return False
    emoji = emoji.strip()
    if not emoji or len(emoji) > _REACTION_MAX_LEN:
        return False
    for ch in emoji:
        if ch.isspace():
            return False
        if ch.isascii() and ch.isalnum():
            return False
    return True


@socketio.on("chat:react")
def _chat_react(payload):
    """Toggle the caller's emoji reaction on a message. Anyone subscribed to
    the chat may react while it's enabled; the host may always react."""
    sid = request.sid
    payload = payload or {}
    try:
        msg_id = int(payload.get("id"))
    except (TypeError, ValueError):
        return
    emoji = payload.get("emoji", "")
    if not _valid_reaction(emoji):
        return
    emoji = emoji.strip()
    is_host = current_user.is_authenticated and current_user.can_broadcast()
    if not chat_state.is_enabled() and not is_host:
        return
    msg = chat_state.toggle_reaction(msg_id, sid, emoji)
    if msg is None:
        return
    out = {"id": msg_id, "reactions": msg.reactions_public()}
    socketio.emit("chat:reactions", out, to=CHAT_ROOM)
    socketio.emit("chat:reactions", out, to=BROADCASTERS_ROOM)
    persist_chat()


@socketio.on("chat:update_profile")
def _chat_update_profile(payload):
    """A joined viewer renames themselves and/or picks a new emoji."""
    sid = request.sid
    payload = payload or {}
    name = payload.get("name", "")
    emoji = payload.get("emoji", "")
    user, err, old_name = chat_state.update_profile(sid, name, emoji)
    if err:
        emit("chat:profile_failed", {"reason": err})
        return
    # Persist the host's chosen identity so it sticks across refreshes/logins.
    _persist_host_identity(user.name, user.emoji)
    emit("chat:profile_updated", {"you": user.public()})
    # Tell everyone so rosters, avatars and @-mention directories update.
    socketio.emit("chat:user_updated", user.public(), to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)
    if old_name and old_name != user.name:
        msg = chat_state.system(f"{old_name} is now {user.name}")
        socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
        socketio.emit("chat:message", msg.public(), to=BROADCASTERS_ROOM)
        persist_chat()


# ── Join / leave announcements (reconnect-grace) ──────────────────────
# A page reload is a disconnect immediately followed by a resume-reconnect.
# To avoid spamming "X left" / "X joined" on every refresh, a disconnect's
# leave message waits out a short grace window; if the same name reconnects
# within it, the leave is cancelled and the rejoin stays silent. Genuine
# joins and leaves still announce.
_LEAVE_GRACE_SECONDS = 6
_pending_leaves: dict[str, int] = {}   # name (lowercased) -> latest leave token
_leave_token = 0


def _cancel_pending_leave(name: str) -> bool:
    """Clear any scheduled leave for this name. Returns True if one was
    pending — i.e. this join is a reconnect/return, not a new arrival."""
    return _pending_leaves.pop(name.lower(), None) is not None


def _announce_leave(name: str) -> None:
    msg = chat_state.system(f"{name} left the chat")
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    persist_chat()


def _schedule_leave_announcement(name: str) -> None:
    """Announce '<name> left the chat' after the grace window, unless they
    reconnect (cancelling it) or a newer leave for the same name supersedes
    this one."""
    global _leave_token
    key = name.lower()
    _leave_token += 1
    token = _leave_token
    _pending_leaves[key] = token
    app = current_app._get_current_object()

    def _finalize():
        socketio.sleep(_LEAVE_GRACE_SECONDS)
        if _pending_leaves.get(key) != token:
            return                      # reconnected, or a newer leave won
        _pending_leaves.pop(key, None)
        with app.app_context():
            _announce_leave(name)

    socketio.start_background_task(_finalize)


@socketio.on("chat:leave")
def _chat_leave():
    # Explicit "Leave chat" — a deliberate exit, so announce immediately.
    _leave_chat(request.sid, grace=False)


def _leave_chat(sid: str, grace: bool = True) -> None:
    """Shared cleanup used by chat:leave and the disconnect teardown in
    app/stream/events.py. `grace=True` (a disconnect, which might be a reload)
    waits out the reconnect window before announcing; `grace=False` (an
    explicit leave) announces right away."""
    user = chat_state.leave(sid)
    if not user:
        return
    try:
        socketio.server.leave_room(sid, CHAT_ROOM, namespace="/")
    except Exception:
        pass
    # Count + roster update immediately so the departure shows at once.
    socketio.emit("chat:user_left", {"sid": sid}, to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)
    # The host's presence isn't announced — only real participants get lines.
    if user.is_host:
        return
    if grace:
        _schedule_leave_announcement(user.name)
    else:
        _cancel_pending_leave(user.name)
        _announce_leave(user.name)


def handle_disconnect(sid: str) -> None:
    """Called from app/stream/events.py's `_on_disconnect`. A disconnect may
    just be a page reload, so the leave uses the reconnect grace window."""
    _leave_chat(sid, grace=True)


# ── Broadcaster moderation ────────────────────────────────────────────


def _require_moderator() -> bool:
    if not current_user.is_authenticated:
        emit("chat:mod_error", {"message": "Not signed in."})
        return False
    if not current_user.can_broadcast():
        emit("chat:mod_error", {"message": "Not authorized."})
        return False
    return True


@socketio.on("chat:moderate_state")
def _chat_moderate_state(_payload=None):
    """Broadcaster asks for the current roster + enabled flag and
    subscribes to ongoing moderation events. We add them to the
    broadcasters room here so they receive chat:roster / chat:message
    pushes even before they're actively live."""
    if not _require_moderator():
        return
    join_room(BROADCASTERS_ROOM)
    emit("chat:roster", chat_state.roster_admin())
    emit("chat:state", chat_state.snapshot_public())
    emit("talk:audio_state", {"enabled": chat_state.is_audio_enabled()})


@socketio.on("chat:moderate_clear")
def _chat_moderate_clear(_payload=None):
    """Wipe the chat history — a host-triggered fresh start. Tells every
    chat client to clear its view, then drops a short system note."""
    if not _require_moderator():
        return
    chat_state.clear_messages()
    msg = chat_state.system("Chat cleared by the host.")
    persist_chat()
    socketio.emit("chat:cleared", {}, to=CHAT_ROOM)
    socketio.emit("chat:cleared", {}, to=BROADCASTERS_ROOM)
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    socketio.emit("chat:message", msg.public(), to=BROADCASTERS_ROOM)


@socketio.on("chat:moderate_delete")
def _chat_moderate_delete(payload):
    """Remove a single chat message for everyone, leaving a tombstone in
    its place that keeps the author. Host-only."""
    if not _require_moderator():
        return
    raw = (payload or {}).get("id")
    try:
        msg_id = int(raw)
    except (TypeError, ValueError):
        return
    if not chat_state.remove_message(msg_id):
        return
    persist_chat()
    socketio.emit("chat:message_removed", {"id": msg_id}, to=CHAT_ROOM)
    socketio.emit("chat:message_removed", {"id": msg_id}, to=BROADCASTERS_ROOM)


_RENAME_ERRORS = {
    "not_joined": "That participant is no longer here.",
    "invalid_name": "Enter a name of at least 2 characters.",
    "name_taken": "That name is already taken.",
}


@socketio.on("chat:moderate_rename")
def _chat_moderate_rename(payload):
    """Broadcaster renames a participant. Host-only.

    We deliberately do NOT post a "renamed" system line: a common reason to
    rename someone is to clean up an offensive handle, and echoing it back to
    the room would defeat the point. The change propagates silently via
    chat:user_updated (which also refreshes the participant's own identity and
    their saved localStorage name) and the broadcaster roster."""
    if not _require_moderator():
        return
    payload = payload or {}
    target_sid = payload.get("sid")
    name = payload.get("name", "")
    if not target_sid:
        return
    user, err, old_name = chat_state.rename(target_sid, name)
    if err:
        emit("chat:mod_error", {"message": _RENAME_ERRORS.get(err, "Could not rename.")})
        return
    socketio.emit("chat:user_updated", user.public(), to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)
    current_app.logger.info("Host renamed %s to %s", old_name, user.name)


@socketio.on("chat:moderate_enable")
def _chat_moderate_enable(payload):
    if not _require_moderator():
        return
    enabled = bool((payload or {}).get("enabled"))
    changed = chat_state.set_enabled(enabled)
    if not changed:
        return
    snap = chat_state.snapshot_public()
    socketio.emit("chat:enabled_changed", {"enabled": enabled}, to=CHAT_ROOM)
    socketio.emit("chat:enabled_changed", {"enabled": enabled}, to=BROADCASTERS_ROOM)
    msg = chat_state.system(
        "Chat enabled by the host." if enabled else "Chat disabled by the host."
    )
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    socketio.emit("chat:message", msg.public(), to=BROADCASTERS_ROOM)
    persist_chat()


# ── Voice / talk ──────────────────────────────────────────────────────
#
# Participants who've joined the chat can speak: their browser captures the
# mic, does voice-activity detection, downsamples to 16 kHz mono PCM and
# emits `talk:frame` binary frames. The server fans every frame out to the
# whole chat room (skipping the sender) and the clients mix all speakers
# through one Web Audio context — the same relay-through-the-worker pattern
# the video uses, so no WebRTC/SFU is needed.
#
# Mute is server-authoritative: a muted participant's frames are dropped
# here, so a tampered client can never be heard. Only the broadcaster can
# (un)mute, and there's no viewer-side unmute.

# ~1s of 16 kHz mono int16 — a frame should be far smaller (one
# ScriptProcessor block ≈ 85 ms); this is just an upper bound so a bad
# client can't push huge buffers through the fan-out.
TALK_MAX_FRAME = 32000


@socketio.on("talk:frame")
def _talk_frame(data):
    """Relay one PCM voice frame to every other chat participant. Dropped
    silently if the sender isn't a joined participant or has been muted."""
    sid = request.sid
    user = chat_state.user(sid)
    if user is None:
        return
    # The host's voice is an always-on channel: it rides through even when the
    # host has disabled participant audio for everyone, and the host can't be
    # muted. For everyone else the global gate and individual mute apply.
    if not user.is_host:
        if not chat_state.is_audio_enabled():
            return
        if user.muted:
            return
    # Frames arrive as a raw binary ArrayBuffer; tolerate a {data: …} wrapper.
    if isinstance(data, dict):
        data = data.get("data")
    if not isinstance(data, (bytes, bytearray, memoryview)):
        return
    buf = bytes(data)
    if not buf or len(buf) > TALK_MAX_FRAME:
        return
    socketio.emit("talk:frame", {"sid": sid, "data": buf}, to=CHAT_ROOM, skip_sid=sid)


@socketio.on("talk:mic")
def _talk_mic(payload):
    """A participant turned their own mic on/off. Relay the state to the
    broadcaster panel so its per-row icon mirrors the viewer's exactly."""
    sid = request.sid
    on = bool((payload or {}).get("on"))
    user = chat_state.set_mic(sid, on)
    if user is None:
        return
    socketio.emit("talk:mic", {"sid": sid, "on": on}, to=BROADCASTERS_ROOM)


@socketio.on("talk:speaking")
def _talk_speaking(payload):
    """A participant's voice-activity state flipped. Relay to the broadcaster
    so the participants panel can highlight whoever's talking. A muted user
    is never reported as speaking."""
    sid = request.sid
    user = chat_state.user(sid)
    if user is None:
        return
    speaking = bool((payload or {}).get("speaking")) and not user.muted
    socketio.emit(
        "talk:speaking",
        {"sid": sid, "name": user.name, "speaking": speaking},
        to=BROADCASTERS_ROOM,
    )


def _emit_roster() -> None:
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)


def _do_request_unmute(target_sid: str) -> None:
    """Ask one muted participant to unmute. The host can't lift the mute — we
    only prompt the participant (privacy) and show 'waiting' on the panel."""
    user = chat_state.request_unmute(target_sid)
    if user is None:
        return
    socketio.emit("talk:unmute_request", {}, to=target_sid)
    socketio.emit(
        "talk:unmute_pending", {"sid": target_sid, "pending": True},
        to=BROADCASTERS_ROOM,
    )
    _emit_roster()
    current_app.logger.info("Asked %s to unmute (IP %s)", user.name, user.ip)


@socketio.on("talk:mute")
def _talk_mute(payload):
    """Broadcaster mutes a participant. Host-only and at the host's
    discretion. An `muted: false` is NOT honoured as a force-unmute — it's
    redirected into an unmute *request* the participant must accept."""
    if not _require_moderator():
        return
    payload = payload or {}
    target_sid = payload.get("sid")
    if not target_sid:
        return
    if not bool(payload.get("muted", True)):
        _do_request_unmute(target_sid)
        return
    user = chat_state.set_muted(target_sid, True)
    if user is None:
        return
    socketio.emit("talk:muted", {"sid": target_sid, "muted": True}, to=CHAT_ROOM)
    socketio.emit(
        "talk:speaking", {"sid": target_sid, "speaking": False}, to=BROADCASTERS_ROOM
    )
    _emit_roster()
    current_app.logger.info("Muted %s (IP %s)", user.name, user.ip)


@socketio.on("talk:request_unmute")
def _talk_request_unmute(payload):
    """Host asks a muted participant to unmute (per-row). Host-only."""
    if not _require_moderator():
        return
    target_sid = (payload or {}).get("sid")
    if target_sid:
        _do_request_unmute(target_sid)


@socketio.on("talk:request_unmute_all")
def _talk_request_unmute_all(_payload=None):
    """Host asks every muted participant to unmute. Host-only."""
    if not _require_moderator():
        return
    asked = chat_state.request_unmute_all()
    for sid in asked:
        socketio.emit("talk:unmute_request", {}, to=sid)
        socketio.emit("talk:unmute_pending", {"sid": sid, "pending": True}, to=BROADCASTERS_ROOM)
    if asked:
        _emit_roster()
        current_app.logger.info("Asked %d participant(s) to unmute", len(asked))


@socketio.on("talk:self_unmute")
def _talk_self_unmute(_payload=None):
    """A participant unmutes their own mic. Always allowed while participant
    audio is on — the viewer keeps control of their mic. When audio is off
    (the host's global gate) this is a no-op, so that's the one state where
    no one can unmute."""
    if not chat_state.is_audio_enabled():
        return
    sid = request.sid
    user = chat_state.set_muted(sid, False)
    if user is None:
        return
    socketio.emit("talk:muted", {"sid": sid, "muted": False}, to=CHAT_ROOM)
    _emit_roster()


@socketio.on("talk:unmute_accept")
def _talk_unmute_accept(_payload=None):
    """Participant consented to the host's unmute request — lift the mute.
    Only works while a request is pending, so a muted viewer can never
    unmute themselves at will."""
    sid = request.sid
    user = chat_state.accept_unmute(sid)
    if user is None:
        return
    socketio.emit("talk:muted", {"sid": sid, "muted": False}, to=CHAT_ROOM)
    _emit_roster()
    current_app.logger.info("%s accepted the unmute request", user.name)


@socketio.on("talk:unmute_decline")
def _talk_unmute_decline(_payload=None):
    """Participant declined the host's unmute request — they stay muted."""
    sid = request.sid
    user = chat_state.decline_unmute(sid)
    if user is None:
        return
    socketio.emit(
        "talk:unmute_declined", {"sid": sid, "name": user.name}, to=BROADCASTERS_ROOM
    )
    socketio.emit("talk:unmute_pending", {"sid": sid, "pending": False}, to=BROADCASTERS_ROOM)
    _emit_roster()


@socketio.on("talk:mute_all")
def _talk_mute_all(payload):
    """Broadcaster mutes/unmutes every participant at once. Distinct from
    `talk:set_audio`: the audio feature stays on, individuals are just muted
    (red), and the host can still unmute one at a time. Host-only."""
    if not _require_moderator():
        return
    muted = bool((payload or {}).get("muted"))
    if not muted:
        # "Unmute all" can't be forced either — ask everyone instead.
        _talk_request_unmute_all()
        return
    chat_state.set_mute_all(True)
    # One broadcast the joined viewers apply to themselves (stop capturing +
    # lock their mic), then refresh the broadcaster roster/panel.
    socketio.emit("talk:mute_all", {"muted": True}, to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)
    current_app.logger.info("Host muted all participants")


@socketio.on("talk:set_audio")
def _talk_set_audio(payload):
    """Broadcaster turns participant audio on/off for everyone at once. When
    off, no one can talk and no viewer can unmute. Host-only."""
    if not _require_moderator():
        return
    enabled = bool((payload or {}).get("enabled"))
    chat_state.set_audio_enabled(enabled)
    out = {"enabled": enabled}
    # To the whole chat room: viewers grey out their mic + stop capturing.
    socketio.emit("talk:audio_state", out, to=CHAT_ROOM)
    socketio.emit("talk:audio_state", out, to=BROADCASTERS_ROOM)
    current_app.logger.info(
        "Participant audio %s by the host", "enabled" if enabled else "disabled"
    )


@socketio.on("chat:moderate_kick")
def _chat_moderate_kick(payload):
    if not _require_moderator():
        return
    target_sid = (payload or {}).get("sid")
    if not target_sid:
        return
    user = chat_state.kick(target_sid)
    if not user:
        return
    # Tell the kicked user privately, then announce to everyone else.
    socketio.emit("chat:kicked", {"reason": "removed by host"}, to=target_sid)
    try:
        socketio.server.leave_room(target_sid, CHAT_ROOM, namespace="/")
    except Exception:
        pass
    msg = chat_state.system(f"{user.name} was removed by the host")
    socketio.emit("chat:user_left", {"sid": target_sid}, to=CHAT_ROOM)
    socketio.emit("chat:message", msg.public(), to=CHAT_ROOM)
    socketio.emit("chat:roster", chat_state.roster_admin(), to=BROADCASTERS_ROOM)
    socketio.emit("chat:message", msg.public(), to=BROADCASTERS_ROOM)
    persist_chat()
    current_app.logger.info("Kicked chat user %s (IP %s)", user.name, user.ip)
