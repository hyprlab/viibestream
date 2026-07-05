"""In-memory chat state for the viewer page.

Holds the list of participants, recent messages, and the set of banned
IPs. Lives in the same single eventlet worker as BroadcastState — if
this ever needs to scale to multiple workers, both stores would need a
Redis backend.
"""
from __future__ import annotations

import collections
import hashlib
import random
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone


# Curated emoji palette — visually distinct, friendly, render well as a
# round chat avatar on both dark and light backgrounds. Avoid emojis
# whose default presentation is text (e.g. some flags / symbols).
CHAT_EMOJIS: list[str] = [
    # Faces & people
    "😀", "😎", "🤩", "🥳", "😇", "🤠", "🤓", "🧐", "🙂", "😺",
    "😻", "🤖", "👻", "👽", "🤡", "💩", "🦸", "🦹", "🧙", "🧚",
    "🧛", "🧜", "🧝", "🧞", "🧟", "🥷", "🤴", "👸", "🎅", "🤶",
    # Animals
    "🦊", "🐼", "🐨", "🦁", "🐯", "🦄", "🐙", "🦋", "🦉", "🦖",
    "🐢", "🐳", "🦒", "🦅", "🐝", "🐶", "🐱", "🐭", "🐹", "🐰",
    "🐻", "🐸", "🐵", "🐔", "🐧", "🦆", "🦃", "🦇", "🐺", "🐗",
    "🐴", "🦓", "🦌", "🐮", "🐷", "🐑", "🐐", "🐫", "🦘", "🦔",
    "🐲", "🦕", "🦂", "🦀", "🦞", "🐡", "🐠", "🐬", "🦈", "🐊",
    # Nature & space
    "🌟", "🌈", "🍀", "🌸", "🌺", "🌻", "🌼", "🌷", "🌹", "🌵",
    "🍄", "🌿", "🍁", "🍂", "🪐", "🌙", "☀️", "⭐", "❄️", "🔥",
    "🌊", "⚡", "🌪️", "🌋", "🏔️", "🌍", "🌜", "🌞", "💫", "✨",
    # Food & drink
    "🍓", "🍕", "🍔", "🌮", "🍜", "🍩", "🧁", "🍰", "🍦", "🍪",
    "🍫", "🍿", "🍎", "🍊", "🍋", "🍉", "🍇", "🍒", "🥑", "🌶️",
    "☕", "🍵", "🧋", "🍺", "🍷", "🥤", "🍭", "🍬", "🥨", "🧀",
    # Activities & objects
    "🎨", "🎭", "🚀", "🎸", "🎮", "🏆", "⛵", "🎬", "🎯", "🎪",
    "🎲", "🎧", "📚", "🎤", "🥁", "🎹", "🎺", "🎻", "🪀", "🛹",
    "⚽", "🏀", "🏈", "🎾", "🏐", "🥊", "🎳", "🏓", "🎱", "🕹️",
    "💎", "👑", "🎩", "🧩", "🪁", "🛸", "🚲", "🏎️", "✈️", "🚁",
]

# Vibrant, AA-on-dark name colors. Stable hash → palette index keeps the
# same person the same color for the life of the stream.
CHAT_COLORS: list[str] = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
    "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
    "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
    "#ec4899", "#f43f5e",
]


def _color_for(name: str) -> str:
    h = hashlib.md5(name.lower().encode("utf-8")).digest()
    return CHAT_COLORS[h[0] % len(CHAT_COLORS)]


# Allowed characters in a display name. Strip control chars, allow
# letters / digits / spaces / a small set of marks. Final result is
# also length-bounded.
_NAME_CLEAN_RE = re.compile(r"[^\w\s\-_'.]", flags=re.UNICODE)

# @-mention tokenizer. We accept anything that looks like the cleaned
# name set (letters/digits/. _ -), case-insensitively, after an
# unescaped "@". Names with spaces aren't matchable here — they'd
# need explicit quoting which is too heavy for casual chat.
_MENTION_RE = re.compile(r"@([A-Za-z0-9_.\-]{2,24})")

# Reply snippets shown above the new message are truncated so a long
# parent doesn't dominate the child's bubble.
_REPLY_SNIPPET_MAX = 140


@dataclass
class ChatUser:
    sid: str
    name: str
    emoji: str
    color: str
    ip: str
    joined_at: datetime
    is_host: bool = False     # broadcaster-capable: may post even when chat is off
    muted: bool = False       # host-muted: the server drops this user's voice frames
    # The host has asked this (muted) participant to unmute. The host can't
    # lift the mute themselves — only the participant can, by accepting. This
    # flag drives the "waiting…" state on the broadcaster panel.
    unmute_pending: bool = False
    # Whether the participant's mic is actually live (capturing). Mirrored to
    # the broadcaster panel so a participant whose mic is simply off shows the
    # same red/slashed icon there as on their own screen.
    mic_on: bool = False

    def public(self) -> dict:
        return {
            "sid": self.sid,
            "name": self.name,
            "emoji": self.emoji,
            "color": self.color,
            "muted": self.muted,
        }


@dataclass
class ChatMessage:
    id: int
    sid: str
    name: str
    emoji: str
    color: str
    text: str
    kind: str            # "msg" | "system"
    timestamp: datetime
    # Sids of users called out by @-mention in this message. The
    # client highlights the whole bubble for any viewer whose sid
    # appears here.
    mentions: list = field(default_factory=list)
    # Parent message id this message is replying to, if any.
    reply_to: int | None = None
    # Denormalized snippet of the parent so the client can render the
    # reply quote without keeping the full message history in memory.
    reply_to_meta: dict | None = None
    # Host removed this message. The author (name/emoji/color) is kept so
    # the client can show a "Message removed by broadcaster" tombstone in
    # its place; the original text is dropped so it can't leak on reload.
    removed: bool = False
    # Emoji reactions: emoji -> set of reactor sids. Serialized to a list of
    # {emoji, count, reactors} so the client can show counts + highlight the
    # current viewer's own reactions and toggle them.
    reactions: dict = field(default_factory=dict)

    def public(self) -> dict:
        return {
            "id": self.id,
            "sid": self.sid,
            "name": self.name,
            "emoji": self.emoji,
            "color": self.color,
            "text": self.text,
            "kind": self.kind,
            "ts": self.timestamp.isoformat(),
            "mentions": list(self.mentions),
            "reply_to": self.reply_to,
            "reply_to_meta": self.reply_to_meta,
            "removed": self.removed,
            "reactions": self.reactions_public(),
        }

    def reactions_public(self) -> list:
        return [
            {"emoji": emoji, "count": len(sids), "reactors": list(sids)}
            for emoji, sids in self.reactions.items()
        ]


@dataclass
class _State:
    enabled: bool = True
    # Global participant-audio gate. When False no one may talk and no viewer
    # can unmute themselves — the host has turned off participant mics for
    # everyone (distinct from the per-user `muted` flag).
    audio_enabled: bool = True
    users: dict = field(default_factory=dict)            # sid -> ChatUser
    messages: collections.deque = field(
        default_factory=lambda: collections.deque(maxlen=200)
    )
    banned_ips: set = field(default_factory=set)
    # IPs the host has muted. Kept alongside the live roster so a muted
    # viewer who reconnects (new sid) comes back muted instead of silently
    # regaining their mic. Cleared per-stream, like banned_ips.
    muted_ips: set = field(default_factory=set)
    next_message_id: int = 1
    _lock: threading.RLock = field(default_factory=threading.RLock)


class ChatState:
    NAME_MIN = 2
    NAME_MAX = 24
    TEXT_MAX = 500
    # Cap distinct emojis per message so a single message can't be turned
    # into an unbounded reaction store.
    MAX_REACTION_KINDS = 30

    def __init__(self) -> None:
        self._s = _State()

    # ── Predicates ─────────────────────────────────────────────────────
    def is_enabled(self) -> bool:
        with self._s._lock:
            return self._s.enabled

    def is_banned(self, ip: str) -> bool:
        with self._s._lock:
            return ip in self._s.banned_ips

    def user(self, sid: str) -> ChatUser | None:
        with self._s._lock:
            return self._s.users.get(sid)

    def is_muted(self, sid: str) -> bool:
        """True if this participant has been muted by the host. Used to drop
        their voice frames on the server so a tampered client can't keep
        broadcasting audio after being muted."""
        with self._s._lock:
            u = self._s.users.get(sid)
            return bool(u and u.muted)

    def set_muted(self, sid: str, muted: bool) -> ChatUser | None:
        """Mute/unmute a participant. Returns the affected user, or None if
        the sid isn't a (non-host) participant. The host can't be muted —
        their audio is the broadcast itself. Mirrors the mute to muted_ips
        so it survives the viewer reconnecting. Any pending unmute request is
        cleared either way."""
        with self._s._lock:
            u = self._s.users.get(sid)
            if not u or u.is_host:
                return None
            u.muted = bool(muted)
            u.unmute_pending = False
            if u.muted:
                u.mic_on = False     # muting stops their capture
                self._s.muted_ips.add(u.ip)
            else:
                self._s.muted_ips.discard(u.ip)
            return u

    def set_mic(self, sid: str, on: bool) -> ChatUser | None:
        """Record whether a participant's mic is live. Returns the user, or
        None if the sid isn't a (non-host) participant."""
        with self._s._lock:
            u = self._s.users.get(sid)
            if not u or u.is_host:
                return None
            u.mic_on = bool(on)
            return u

    def request_unmute(self, sid: str) -> ChatUser | None:
        """Host invites a participant to turn their mic on — whether they're
        host-muted or simply have their mic off. Flags the request on the
        muted ones (so their accept lifts the mute) and drives the panel's
        'waiting' state. Returns the user, or None for the host / someone
        already live."""
        with self._s._lock:
            u = self._s.users.get(sid)
            if not u or u.is_host or u.mic_on:
                return None
            if u.muted:
                u.unmute_pending = True
            return u

    def request_unmute_all(self) -> list[str]:
        """Invite every participant who isn't already live to turn their mic
        on — both host-muted people and those who simply have their mic off.
        Sets the pending flag on the muted ones (so their accept lifts the
        mute) and returns every sid asked. Skips anyone already talking."""
        with self._s._lock:
            asked: list[str] = []
            for u in self._s.users.values():
                if u.is_host or u.mic_on:
                    continue
                if u.muted:
                    u.unmute_pending = True
                asked.append(u.sid)
            return asked

    def accept_unmute(self, sid: str) -> ChatUser | None:
        """The participant consented to the host's unmute request. Lifts the
        mute. Returns the user, or None if there was no pending request (so a
        muted participant can't unmute themselves at will)."""
        with self._s._lock:
            u = self._s.users.get(sid)
            if not u or not u.muted or not u.unmute_pending:
                return None
            u.muted = False
            u.unmute_pending = False
            self._s.muted_ips.discard(u.ip)
            return u

    def decline_unmute(self, sid: str) -> ChatUser | None:
        """The participant declined the host's unmute request — stays muted,
        request cleared. Returns the user (so the host can be told), or None."""
        with self._s._lock:
            u = self._s.users.get(sid)
            if not u or not u.unmute_pending:
                return None
            u.unmute_pending = False
            return u

    def is_audio_enabled(self) -> bool:
        """True if participants are allowed to talk at all. When False the
        server drops every voice frame and viewers can't unmute."""
        with self._s._lock:
            return self._s.audio_enabled

    def set_audio_enabled(self, enabled: bool) -> bool:
        """Flip the global participant-audio gate. Returns True iff it
        actually changed."""
        with self._s._lock:
            new = bool(enabled)
            if new == self._s.audio_enabled:
                return False
            self._s.audio_enabled = new
            return True

    def set_mute_all(self, muted: bool) -> list[str]:
        """Mute or unmute every (non-host) participant at once. Returns the
        sids whose state actually changed. Muting adds their IPs to muted_ips
        so reconnects stay muted; unmuting clears every mute."""
        muted = bool(muted)
        with self._s._lock:
            if not muted:
                self._s.muted_ips.clear()
            changed: list[str] = []
            for u in self._s.users.values():
                if u.is_host:
                    continue
                if u.muted != muted:
                    changed.append(u.sid)
                u.muted = muted
                u.unmute_pending = False
                if muted:
                    u.mic_on = False
                    self._s.muted_ips.add(u.ip)
            return changed

    def all_muted(self) -> bool:
        """True if there's at least one participant and every one is muted —
        lets the panel show 'Unmute all' instead of 'Mute all'."""
        with self._s._lock:
            members = [u for u in self._s.users.values() if not u.is_host]
            return bool(members) and all(u.muted for u in members)

    def clear_mutes(self) -> None:
        """Drop all mutes — called when a broadcast ends (mutes are scoped
        per-stream, like bans)."""
        with self._s._lock:
            self._s.muted_ips.clear()
            for u in self._s.users.values():
                u.muted = False
                u.unmute_pending = False

    # ── Mutations ─────────────────────────────────────────────────────
    def set_enabled(self, enabled: bool) -> bool:
        """Returns True iff the flag actually changed."""
        with self._s._lock:
            new = bool(enabled)
            if new == self._s.enabled:
                return False
            self._s.enabled = new
            return True

    @classmethod
    def _clean_name(cls, name: str) -> str:
        name = (name or "").strip()
        name = _NAME_CLEAN_RE.sub("", name)
        name = re.sub(r"\s+", " ", name).strip()
        return name[: cls.NAME_MAX]

    def join(
        self, sid: str, ip: str, name: str, resume: bool = False,
        emoji: str | None = None, is_host: bool = False,
    ) -> tuple[ChatUser | None, str]:
        """Add a participant. Returns (user, error_code). On success
        error_code is "". On failure user is None and error_code is one
        of: "banned", "disabled", "invalid_name", "name_taken".

        `resume=True` is used when a viewer's socket reconnects (e.g. the
        backend restarted): instead of rejecting the name as taken, we
        reclaim it for the new sid — keeping the same emoji/color — so
        they silently re-join the same session without a duplicate."""
        with self._s._lock:
            # The host (broadcaster) may always join, even with chat off,
            # so they can keep posting to viewers who can only read.
            if not self._s.enabled and not is_host:
                return (None, "disabled")
            if ip in self._s.banned_ips:
                return (None, "banned")
            clean = self._clean_name(name)
            if len(clean) < self.NAME_MIN:
                return (None, "invalid_name")
            # Find any existing participant using this name (case-insensitive).
            dup_sid = None
            for esid, u in self._s.users.items():
                if u.name.lower() == clean.lower():
                    dup_sid = esid
                    break
            if dup_sid is not None and not resume:
                return (None, "name_taken")
            # A caller-supplied emoji (restored from the viewer's
            # localStorage, or chosen in the picker) wins as long as it's
            # one of ours; otherwise fall back to the reclaimed/random one.
            want_emoji = emoji if emoji in CHAT_EMOJIS else None
            if dup_sid is not None:
                # Reclaim the name: drop the stale entry, keep its look.
                old = self._s.users.pop(dup_sid)
                chosen_emoji = want_emoji or old.emoji
                color, joined_at = old.color, old.joined_at
            else:
                chosen_emoji = want_emoji or random.choice(CHAT_EMOJIS)
                color = _color_for(clean)
                joined_at = datetime.now(timezone.utc)
            self._s.users.pop(sid, None)   # clear any prior entry for this sid
            user = ChatUser(
                sid=sid, name=clean, emoji=chosen_emoji, color=color,
                ip=ip, joined_at=joined_at, is_host=bool(is_host),
                # A previously-muted viewer stays muted across reconnects (the
                # host never has to re-mute them just because they refreshed).
                muted=(not is_host) and ip in self._s.muted_ips,
            )
            self._s.users[sid] = user
            return (user, "")

    def leave(self, sid: str) -> ChatUser | None:
        with self._s._lock:
            return self._s.users.pop(sid, None)

    def update_profile(
        self, sid: str, name: str, emoji: str
    ) -> tuple[ChatUser | None, str, str]:
        """Rename and/or re-emoji an already-joined participant. Returns
        (user, error_code, old_name). error_code is "" on success; on
        failure it's one of "not_joined", "invalid_name", "name_taken",
        "invalid_emoji". old_name lets the caller announce a rename."""
        with self._s._lock:
            user = self._s.users.get(sid)
            if not user:
                return (None, "not_joined", "")
            clean = self._clean_name(name)
            if len(clean) < self.NAME_MIN:
                return (None, "invalid_name", "")
            for esid, u in self._s.users.items():
                if esid != sid and u.name.lower() == clean.lower():
                    return (None, "name_taken", "")
            if emoji not in CHAT_EMOJIS:
                return (None, "invalid_emoji", "")
            old_name = user.name
            user.name = clean
            user.color = _color_for(clean)
            user.emoji = emoji
            return (user, "", old_name)

    def rename(self, sid: str, name: str) -> tuple[ChatUser | None, str, str]:
        """Host renames a participant (name only; the name-derived color is
        refreshed, the emoji is kept). Returns (user, error_code, old_name).
        error_code is "" on success; on failure one of "not_joined",
        "invalid_name", "name_taken"."""
        with self._s._lock:
            user = self._s.users.get(sid)
            if not user:
                return (None, "not_joined", "")
            clean = self._clean_name(name)
            if len(clean) < self.NAME_MIN:
                return (None, "invalid_name", "")
            for esid, u in self._s.users.items():
                if esid != sid and u.name.lower() == clean.lower():
                    return (None, "name_taken", "")
            old_name = user.name
            user.name = clean
            user.color = _color_for(clean)
            return (user, "", old_name)

    def post(self, sid: str, text: str, reply_to: int | None = None) -> ChatMessage | None:
        with self._s._lock:
            user = self._s.users.get(sid)
            if not user:
                return None
            # Chat off → only the host may still post (viewers read-only).
            if not self._s.enabled and not user.is_host:
                return None
            text = (text or "").strip()[: self.TEXT_MAX]
            if not text:
                return None

            # Resolve @-mentions to a list of currently-connected sids.
            mention_sids = self._mention_sids_locked(text)
            # Resolve the reply-to id to a denormalized snippet so the
            # client can render the quote header without holding a full
            # history. Fall back to a plain message if the parent has
            # been trimmed out of the deque or isn't a regular message.
            reply_meta = None
            if reply_to is not None:
                parent = self._find_message_locked(int(reply_to))
                if parent and parent.kind == "msg":
                    reply_meta = {
                        "id":    parent.id,
                        "name":  parent.name,
                        "color": parent.color,
                        "emoji": parent.emoji,
                        "text":  parent.text[:_REPLY_SNIPPET_MAX],
                    }

            msg = ChatMessage(
                id=self._s.next_message_id,
                sid=sid,
                name=user.name,
                emoji=user.emoji,
                color=user.color,
                text=text,
                kind="msg",
                timestamp=datetime.now(timezone.utc),
                mentions=mention_sids,
                reply_to=(reply_meta["id"] if reply_meta else None),
                reply_to_meta=reply_meta,
            )
            self._s.next_message_id += 1
            self._s.messages.append(msg)
            return msg

    def _mention_sids_locked(self, text: str) -> list[str]:
        """Find every @word in `text` whose token matches a current
        chat user's name (case-insensitive), and return the sids of
        those users. Caller must hold the lock."""
        found: list[str] = []
        for match in _MENTION_RE.finditer(text):
            name = match.group(1).lower()
            for u in self._s.users.values():
                if u.name.lower() == name and u.sid not in found:
                    found.append(u.sid)
                    break
        return found

    def _find_message_locked(self, msg_id: int) -> ChatMessage | None:
        """Look up a message by id within the recent-history deque."""
        for m in reversed(self._s.messages):
            if m.id == msg_id:
                return m
        return None

    def system(self, text: str) -> ChatMessage:
        """Append a system message (joins/leaves/etc.)."""
        with self._s._lock:
            msg = ChatMessage(
                id=self._s.next_message_id,
                sid="",
                name="",
                emoji="",
                color="",
                text=text,
                kind="system",
                timestamp=datetime.now(timezone.utc),
            )
            self._s.next_message_id += 1
            self._s.messages.append(msg)
            return msg

    def kick(self, sid: str) -> ChatUser | None:
        """Remove a participant and ban their IP for the rest of the
        stream. Returns the removed user (with .ip set), or None if
        the sid wasn't a participant."""
        with self._s._lock:
            user = self._s.users.pop(sid, None)
            if user:
                self._s.banned_ips.add(user.ip)
            return user

    def clear_bans(self) -> None:
        """Called when a broadcast ends — bans are scoped per-stream."""
        with self._s._lock:
            self._s.banned_ips.clear()

    def remove_message(self, msg_id: int) -> ChatMessage | None:
        """Mark a single message as removed by the host: keep the author so
        the client can show a tombstone in its place, but drop the content
        (text/mentions/reply) so it can't leak. Returns the message, or None
        if not found, not a regular message, or already removed."""
        with self._s._lock:
            for m in self._s.messages:
                if m.id == msg_id and m.kind == "msg" and not m.removed:
                    m.removed = True
                    m.text = ""
                    m.mentions = []
                    m.reply_to = None
                    m.reply_to_meta = None
                    m.reactions = {}
                    return m
            return None

    def toggle_reaction(
        self, msg_id: int, sid: str, emoji: str
    ) -> ChatMessage | None:
        """Add or remove `sid`'s reaction `emoji` on a message. Returns the
        message (with updated reactions) or None if it's missing, a system
        message, removed, or the distinct-emoji cap would be exceeded."""
        with self._s._lock:
            msg = None
            for m in self._s.messages:
                if m.id == msg_id:
                    msg = m
                    break
            if msg is None or msg.kind != "msg" or msg.removed:
                return None
            sids = msg.reactions.get(emoji)
            if sids is None:
                if len(msg.reactions) >= self.MAX_REACTION_KINDS:
                    return None
                sids = set()
                msg.reactions[emoji] = sids
            if sid in sids:
                sids.discard(sid)
                if not sids:
                    del msg.reactions[emoji]
            else:
                sids.add(sid)
            return msg

    def clear_messages(self) -> None:
        """Wipe the message history and reset the id counter — used when
        the broadcaster rotates the access code (a fresh chat session).
        Participants/bans are left alone."""
        with self._s._lock:
            self._s.messages.clear()
            self._s.next_message_id = 1

    # ── Persistence helpers ───────────────────────────────────────────
    def snapshot_full(self) -> dict:
        """Everything needed to restore the chat after a restart (the
        roster is intentionally omitted — sids are per-connection)."""
        with self._s._lock:
            return {
                "enabled": self._s.enabled,
                "next_message_id": self._s.next_message_id,
                "messages": [m.public() for m in self._s.messages],
            }

    def hydrate(self, enabled: bool, next_message_id: int, messages: list) -> None:
        """Restore message history + flags from a persisted snapshot."""
        with self._s._lock:
            self._s.enabled = bool(enabled)
            self._s.next_message_id = int(next_message_id or 1)
            self._s.messages.clear()
            for d in messages or []:
                try:
                    self._s.messages.append(ChatMessage(
                        id=int(d["id"]),
                        sid=d.get("sid", ""),
                        name=d.get("name", ""),
                        emoji=d.get("emoji", ""),
                        color=d.get("color", ""),
                        text=d.get("text", ""),
                        kind=d.get("kind", "msg"),
                        timestamp=datetime.fromisoformat(d["ts"]),
                        mentions=list(d.get("mentions") or []),
                        reply_to=d.get("reply_to"),
                        reply_to_meta=d.get("reply_to_meta"),
                        removed=bool(d.get("removed", False)),
                        reactions={
                            r["emoji"]: set(r.get("reactors") or [])
                            for r in (d.get("reactions") or [])
                            if r.get("emoji")
                        },
                    ))
                except (KeyError, ValueError, TypeError):
                    continue

    # ── Snapshots ─────────────────────────────────────────────────────
    def snapshot_public(self) -> dict:
        """State payload safe to send to viewers."""
        with self._s._lock:
            return {
                "enabled": self._s.enabled,
                "audio_enabled": self._s.audio_enabled,
                "users": [u.public() for u in self._s.users.values()],
                "messages": [m.public() for m in self._s.messages],
            }

    def roster_admin(self) -> list[dict]:
        """Per-participant detail for the broadcaster — includes IP. Hosts
        (the broadcaster themselves and any other broadcaster-capable user)
        are omitted: you can't IP-ban yourself."""
        with self._s._lock:
            return [
                {
                    **u.public(),
                    "ip": u.ip,
                    "joined_at": u.joined_at.isoformat(),
                    "muted": u.muted,
                    "unmute_pending": u.unmute_pending,
                    "mic_on": u.mic_on,
                }
                for u in self._s.users.values()
                if not u.is_host
            ]


chat_state = ChatState()


# ── Database persistence ──────────────────────────────────────────────
# The chat lives in memory for speed but is mirrored to a single-row
# `chat_session` table so the conversation survives a worker restart.
# db / model are imported lazily to avoid import cycles.

def persist_chat() -> None:
    """Write the current chat history + enabled flag to the DB."""
    import json
    from ..extensions import db
    from ..models import ChatSession

    snap = chat_state.snapshot_full()
    row = db.session.get(ChatSession, 1)
    if row is None:
        row = ChatSession(id=1)
        db.session.add(row)
    row.enabled = bool(snap["enabled"])
    row.next_message_id = int(snap["next_message_id"])
    row.messages_json = json.dumps(snap["messages"])
    db.session.commit()


def load_chat_from_db() -> None:
    """Hydrate the in-memory chat from the DB at startup."""
    import json
    from ..extensions import db
    from ..models import ChatSession

    row = db.session.get(ChatSession, 1)
    if row is None:
        return
    try:
        messages = json.loads(row.messages_json or "[]")
    except (ValueError, TypeError):
        messages = []
    chat_state.hydrate(row.enabled, row.next_message_id, messages)
