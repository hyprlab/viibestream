"""Runtime, admin-managed application settings (DB-backed).

Currently this is the Cloudflare Turnstile login-captcha config. The row is
seeded once from the matching environment variables, then owned by the admin
UI (Settings → Security). The *effective* config is mirrored into
``app.config`` so the CSP, login route, and template — which all read
``app.config`` — reflect the current DB state without a per-request query.
"""
from flask import current_app

from .extensions import db
from .models import AppSettings


def get_settings() -> AppSettings:
    """Return the singleton AppSettings row, creating it (seeded from the
    Turnstile environment config) on first access."""
    row = db.session.get(AppSettings, 1)
    if row is None:
        site = (current_app.config.get("TURNSTILE_SITE_KEY") or "").strip()
        secret = (current_app.config.get("TURNSTILE_SECRET_KEY") or "").strip()
        row = AppSettings(
            id=1,
            turnstile_site_key=site,
            turnstile_secret_key=secret,
            turnstile_enabled=bool(site and secret),
        )
        db.session.add(row)
        db.session.commit()
    return row


def turnstile_active(row: AppSettings) -> bool:
    """Turnstile only counts as on when it's enabled AND fully keyed."""
    return bool(row.turnstile_enabled and row.turnstile_site_key and row.turnstile_secret_key)


def apply_turnstile_config() -> None:
    """Push the effective Turnstile config into ``app.config``. Blanked when
    disabled or incomplete, so the feature switches fully off."""
    row = get_settings()
    active = turnstile_active(row)
    current_app.config["TURNSTILE_SITE_KEY"] = row.turnstile_site_key if active else ""
    current_app.config["TURNSTILE_SECRET_KEY"] = row.turnstile_secret_key if active else ""
