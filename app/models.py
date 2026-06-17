"""Database models + role / permission helpers."""
from __future__ import annotations

import enum
from datetime import datetime, timedelta, timezone

import bcrypt
from flask_login import UserMixin
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import validates

from .extensions import db


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, enum.Enum):
    """User roles, ordered loosely by privilege.

    - ADMIN can do everything (manage users, broadcast, change settings).
    - STREAMER can broadcast and adjust their own profile.
    - VIEWER is a signed-in viewer; public viewers do not need an account.
    """
    ADMIN = "admin"
    STREAMER = "streamer"
    VIEWER = "viewer"

    @property
    def label(self) -> str:
        return self.value.replace("_", " ").title()


# Capability matrix — kept as a dict so it's grep-able and easy to extend.
PERMISSIONS: dict[Role, set[str]] = {
    Role.ADMIN: {
        "stream.broadcast",
        "stream.control",
        "users.manage",
        "settings.manage",
    },
    Role.STREAMER: {
        "stream.broadcast",
        "stream.control",
    },
    Role.VIEWER: set(),
}


class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(254), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.LargeBinary(60), nullable=False)
    role = db.Column(
        SAEnum(Role, name="role", values_callable=lambda x: [e.value for e in x]),
        nullable=False,
        default=Role.VIEWER,
    )
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    last_login_at = db.Column(db.DateTime(timezone=True))
    failed_login_count = db.Column(db.Integer, default=0, nullable=False)
    locked_until = db.Column(db.DateTime(timezone=True))
    # When True, the user is forced to choose a fresh password before they
    # can use the admin area. Set on the bootstrap admin (and on any
    # pre-existing admin the first time this feature lands) so a weak
    # initial credential can never persist. Cleared the instant they
    # successfully change their password.
    must_change_password = db.Column(db.Boolean, default=False, nullable=False)
    # The host's chosen chat identity, persisted so the broadcaster keeps the
    # same name + avatar emoji across page refreshes and logins (the public
    # viewer persists its own identity in localStorage instead). Null until
    # the user first joins / customizes it.
    chat_name = db.Column(db.String(24), nullable=True)
    chat_emoji = db.Column(db.String(16), nullable=True)

    # ── Validation ──────────────────────────────────────────────────────────
    @validates("username")
    def _validate_username(self, _key, value):
        value = (value or "").strip()
        if not (3 <= len(value) <= 64):
            raise ValueError("username must be 3–64 chars")
        if not value.replace("_", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError("username may contain letters, digits, . _ -")
        return value

    @validates("email")
    def _validate_email(self, _key, value):
        value = (value or "").strip().lower()
        if "@" not in value or len(value) > 254:
            raise ValueError("invalid email")
        return value

    # ── Password handling ───────────────────────────────────────────────────
    # Password policy: at least 10 chars with a lowercase + uppercase letter,
    # a digit, and a special (non-alphanumeric) character. Enforced for
    # self-service changes; an admin can override it when setting passwords
    # from the Users tab (set_password(..., enforce_policy=False)).
    PASSWORD_MIN_LEN = 10

    @classmethod
    def password_policy_error(cls, password: str) -> str | None:
        """Return a human-readable reason the password fails the policy, or
        None if it satisfies it."""
        if not password or len(password) < cls.PASSWORD_MIN_LEN:
            return f"Password must be at least {cls.PASSWORD_MIN_LEN} characters."
        if not any(c.islower() for c in password):
            return "Password must include a lowercase letter."
        if not any(c.isupper() for c in password):
            return "Password must include an uppercase letter."
        if not any(c.isdigit() for c in password):
            return "Password must include a number."
        if not any(not c.isalnum() for c in password):
            return "Password must include a special character."
        return None

    def set_password(self, password: str, enforce_policy: bool = True) -> None:
        if not password:
            raise ValueError("Password is required.")
        # bcrypt has a hard 72-byte limit; always enforced (can't be overridden).
        if len(password.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 bytes.")
        if enforce_policy:
            err = self.password_policy_error(password)
            if err:
                raise ValueError(err)
        self.password_hash = bcrypt.hashpw(
            password.encode("utf-8"), bcrypt.gensalt(rounds=12)
        )

    def check_password(self, password: str) -> bool:
        if not password or not self.password_hash:
            return False
        try:
            return bcrypt.checkpw(password.encode("utf-8"), self.password_hash)
        except ValueError:
            return False

    # ── Authorization helpers ──────────────────────────────────────────────
    def has_permission(self, perm: str) -> bool:
        return perm in PERMISSIONS.get(self.role, set())

    def is_admin(self) -> bool:
        return self.role == Role.ADMIN

    def can_broadcast(self) -> bool:
        return self.has_permission("stream.broadcast") and self.is_active

    # ── Account-lockout helpers ────────────────────────────────────────────
    @property
    def is_locked(self) -> bool:
        # SQLite strips tzinfo on round-trip, so values from the DB are
        # naive even though we wrote them as aware. Normalize to UTC
        # before comparing, otherwise TypeError: can't compare offset-
        # naive and offset-aware datetimes.
        if not self.locked_until:
            return False
        locked = self.locked_until
        if locked.tzinfo is None:
            locked = locked.replace(tzinfo=timezone.utc)
        return locked > _utcnow()

    # 5 failed attempts locks the account for 24 hours. An admin can unlock
    # it early from the Users tab; otherwise it clears itself after the
    # window and the counter resets to give a fresh set of attempts.
    LOCKOUT_THRESHOLD = 5
    LOCKOUT_DURATION = timedelta(hours=24)

    def register_failed_login(self) -> None:
        self.failed_login_count = (self.failed_login_count or 0) + 1
        if self.failed_login_count >= self.LOCKOUT_THRESHOLD:
            self.locked_until = _utcnow() + self.LOCKOUT_DURATION

    def clear_expired_lock(self) -> None:
        """If a lock has elapsed, reset the window so the next attempt starts
        from zero rather than instantly re-locking. No-op while still locked
        or never locked."""
        if self.locked_until and not self.is_locked:
            self.failed_login_count = 0
            self.locked_until = None

    def unlock(self) -> None:
        """Admin action: clear the lock and reset the failed-attempt counter."""
        self.failed_login_count = 0
        self.locked_until = None

    def register_successful_login(self) -> None:
        self.failed_login_count = 0
        self.locked_until = None
        self.last_login_at = _utcnow()

    def __repr__(self) -> str:
        return f"<User {self.username} ({self.role.value})>"


# ── Saved showings (Now Showing presets) ─────────────────────────────


class SavedShowing(db.Model):
    """A preset of stream-info metadata the broadcaster can recall for
    a future showing. Stores everything Stream-Info holds: title,
    description, IMDB / trailer URLs, and (optionally) the poster
    bytes inline. SQLite handles small BLOBs cheaply — at our 4 MB
    poster cap and ~tens of presets, the database stays trivial."""

    __tablename__ = "saved_showings"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False, default="")
    description = db.Column(db.Text, nullable=False, default="")
    imdb_url = db.Column(db.String(500), nullable=False, default="")
    trailer_url = db.Column(db.String(500), nullable=False, default="")
    poster_bytes = db.Column(db.LargeBinary)         # nullable
    poster_mime = db.Column(db.String(64))           # nullable
    created_by_id = db.Column(
        db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, nullable=False
    )
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def public(self) -> dict:
        """JSON-safe summary used by the library list. Poster bytes
        are served separately by GET /admin/info/library/<id>/poster."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "imdb_url": self.imdb_url,
            "trailer_url": self.trailer_url,
            "has_poster": bool(self.poster_bytes),
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class NowShowing(db.Model):
    """Persistent store for the *currently published* Now-Showing info.

    The live values are served from the in-memory ``StreamInfo`` for
    speed, but they're mirrored here on every change and re-hydrated at
    startup so the Now Showing survives a worker restart / redeploy —
    it stays put until the broadcaster explicitly clears it. Single row,
    ``id == 1``."""

    __tablename__ = "now_showing"

    id = db.Column(db.Integer, primary_key=True)   # always 1
    title = db.Column(db.String(200), nullable=False, default="")
    description = db.Column(db.Text, nullable=False, default="")
    imdb_url = db.Column(db.String(500), nullable=False, default="")
    trailer_url = db.Column(db.String(500), nullable=False, default="")
    poster_bytes = db.Column(db.LargeBinary)        # nullable
    poster_mime = db.Column(db.String(64))          # nullable
    poster_etag = db.Column(db.String(128), nullable=False, default="")
    updated_at = db.Column(db.DateTime(timezone=True))


class StreamLock(db.Model):
    """Persistent store for the access-code lock (enabled + code). Kept
    in the DB so the lock survives a worker restart: viewers who already
    entered the code aren't re-prompted just because the backend
    restarted, and the server can validate the code immediately on boot
    without waiting for the broadcaster to reconnect. Single row,
    ``id == 1``."""

    __tablename__ = "stream_lock"

    id = db.Column(db.Integer, primary_key=True)   # always 1
    enabled = db.Column(db.Boolean, nullable=False, default=False)
    code = db.Column(db.String(5))                  # nullable when unlocked


class ChatSession(db.Model):
    """Persistent store for the live chat so the conversation survives a
    worker restart (viewers keep their history instead of the chat going
    blank). The participant roster is NOT persisted — those are tied to
    live sockets and rebuild as viewers reconnect. The chat is wiped when
    the broadcaster rotates the access code (a fresh session). Single
    row, ``id == 1``."""

    __tablename__ = "chat_session"

    id = db.Column(db.Integer, primary_key=True)    # always 1
    enabled = db.Column(db.Boolean, nullable=False, default=True)
    next_message_id = db.Column(db.Integer, nullable=False, default=1)
    messages_json = db.Column(db.Text, nullable=False, default="[]")


class AppSettings(db.Model):
    """Runtime-editable application settings managed from the admin UI
    (Settings → Security / Branding). Single row, ``id == 1``. Holds the
    Cloudflare Turnstile login-captcha configuration (seeded once from the
    matching environment variables) plus the operator-chosen branding: the
    app title and the OpenGraph share image. Owned by the admin interface."""

    __tablename__ = "app_settings"

    id = db.Column(db.Integer, primary_key=True)    # always 1
    turnstile_enabled = db.Column(db.Boolean, nullable=False, default=False)
    turnstile_site_key = db.Column(db.String(120), nullable=False, default="")
    turnstile_secret_key = db.Column(db.String(120), nullable=False, default="")

    # Branding ----------------------------------------------------------------
    # When ``app_title`` is blank the app falls back to ``APP_NAME_DEFAULT``
    # (the compiled-in default). The OpenGraph image is stored inline as a
    # small BLOB — like the Now-Showing poster — and served by /og-image;
    # ``og_image_etag`` doubles as a cache-busting version token so social
    # platforms re-crawl when the image changes. All null/blank → the bundled
    # default ``static/img/og-image.webp`` is served instead.
    app_title = db.Column(db.String(120), nullable=False, default="")
    # Short tagline / subheading — the description shown in link previews and
    # the page <meta description>. Blank falls back to a default built from
    # the effective app title.
    app_tagline = db.Column(db.String(300), nullable=False, default="")
    og_image_bytes = db.Column(db.LargeBinary)       # nullable
    og_image_mime = db.Column(db.String(64))         # nullable
    og_image_etag = db.Column(db.String(128), nullable=False, default="")
