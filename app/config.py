"""Application configuration.

Values come from environment variables (see .env.example). The factory in
app/__init__.py picks a config class based on FLASK_ENV.
"""
import os
import secrets
from datetime import timedelta


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


class BaseConfig:
    # Secrets -----------------------------------------------------------------
    SECRET_KEY = os.environ.get("SECRET_KEY") or secrets.token_urlsafe(64)

    # Database ----------------------------------------------------------------
    SQLALCHEMY_DATABASE_URI = os.environ.get(
        "DATABASE_URL", "sqlite:///viibestream.db"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

    # Session / cookie hardening ---------------------------------------------
    BEHIND_HTTPS_PROXY = os.environ.get("BEHIND_HTTPS_PROXY", "0") == "1"
    TLS_ENABLE = os.environ.get("TLS_ENABLE", "0") == "1"
    # Cookies are marked Secure whenever the page is served over HTTPS,
    # whether that's terminated by the app itself (TLS_ENABLE) or by a
    # reverse proxy (BEHIND_HTTPS_PROXY).
    _SERVED_OVER_HTTPS = BEHIND_HTTPS_PROXY or TLS_ENABLE
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = _SERVED_OVER_HTTPS
    REMEMBER_COOKIE_HTTPONLY = True
    REMEMBER_COOKIE_SAMESITE = "Lax"
    REMEMBER_COOKIE_SECURE = _SERVED_OVER_HTTPS
    PERMANENT_SESSION_LIFETIME = timedelta(days=7)

    # CSRF --------------------------------------------------------------------
    WTF_CSRF_TIME_LIMIT = 60 * 60 * 8  # 8 hours
    # SSL-strict checks the Referer matches https://<host>. In production
    # this is desirable. In local dev (curl, Playwright hitting plain
    # http://localhost while BEHIND_HTTPS_PROXY=1 is on for cookie
    # security) the referer is http and the check fails. Set
    # WTF_CSRF_SSL_STRICT=0 in .env to opt out.
    WTF_CSRF_SSL_STRICT = (
        os.environ.get("WTF_CSRF_SSL_STRICT", "1" if _SERVED_OVER_HTTPS else "0")
        == "1"
    )

    # Socket.IO ---------------------------------------------------------------
    # Comma-separated allowlist of origins permitted to open Socket.IO
    # connections. An origin that isn't on this list gets a 400 "Not an
    # accepted origin" and the realtime socket silently never connects
    # (the page loads, but stream / chat / lock are dead) — so this must
    # list EVERY domain the app is served from.
    PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", "http://localhost:8000")
    SOCKETIO_CORS_ALLOWED_ORIGINS = _split_csv(PUBLIC_ORIGIN) or "*"
    # Cap a single MediaRecorder chunk; we use ~250ms chunks so 8 MB is generous.
    SOCKETIO_MAX_HTTP_BUFFER_SIZE = 8 * 1024 * 1024

    # Streaming policy --------------------------------------------------------
    # Only one active broadcaster at a time. The first authorized user who
    # claims the slot holds it until they disconnect or stop.
    MAX_BROADCASTERS = 1

    # Initial admin bootstrap (only used if no admin exists yet)
    INITIAL_ADMIN_USERNAME = os.environ.get("INITIAL_ADMIN_USERNAME", "admin")
    INITIAL_ADMIN_EMAIL = os.environ.get("INITIAL_ADMIN_EMAIL", "admin@example.com")
    INITIAL_ADMIN_PASSWORD = os.environ.get("INITIAL_ADMIN_PASSWORD")

    # Cloudflare Turnstile (login captcha) ------------------------------------
    # Both keys must be set to enable the challenge on the sign-in form. When
    # either is blank, Turnstile is skipped entirely (dev / self-hosted).
    TURNSTILE_SITE_KEY = os.environ.get("TURNSTILE_SITE_KEY", "")
    TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "")

    # Rate limiting -----------------------------------------------------------
    RATELIMIT_STORAGE_URI = "memory://"
    RATELIMIT_HEADERS_ENABLED = True
    RATELIMIT_DEFAULT = "200 per minute"

    # Misc --------------------------------------------------------------------
    APP_NAME = "Viibestream"
    APP_VERSION = "0.2.1"
    MAX_CONTENT_LENGTH = 16 * 1024 * 1024  # 16 MB request cap


class DevelopmentConfig(BaseConfig):
    DEBUG = True
    TEMPLATES_AUTO_RELOAD = True


class ProductionConfig(BaseConfig):
    DEBUG = False
    TESTING = False
    # Production refuses to start without an explicit SECRET_KEY.
    @classmethod
    def validate(cls) -> None:
        if not os.environ.get("SECRET_KEY"):
            raise RuntimeError(
                "SECRET_KEY must be set in the environment for production"
            )


def get_config() -> type[BaseConfig]:
    env = os.environ.get("FLASK_ENV", "production").lower()
    if env in ("dev", "development"):
        return DevelopmentConfig
    ProductionConfig.validate()
    return ProductionConfig
