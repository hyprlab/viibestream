"""Runtime, admin-managed application settings (DB-backed).

Currently this is the Cloudflare Turnstile login-captcha config. The row is
seeded once from the matching environment variables, then owned by the admin
UI (Settings → Security). The *effective* config is mirrored into
``app.config`` so the CSP, login route, and template — which all read
``app.config`` — reflect the current DB state without a per-request query.
"""
import os

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


# ── Branding (app title + OpenGraph image) ─────────────────────────────────


def effective_app_name(row: AppSettings) -> str:
    """The operator's chosen app title, or the compiled-in default when blank."""
    title = (row.app_title or "").strip()
    return title or current_app.config.get("APP_NAME_DEFAULT") or current_app.config["APP_NAME"]


def default_og_version() -> str:
    """Cache-busting token for the bundled default OG image (its mtime), so
    the og:image URL changes if the shipped default is ever replaced."""
    try:
        path = os.path.join(current_app.static_folder, "img", "og-image.webp")
        return str(int(os.stat(path).st_mtime))
    except OSError:
        return "0"


def apply_branding_config() -> None:
    """Mirror the effective branding into ``app.config`` so templates (which
    read ``app_name`` / build the og:image URL) reflect the current DB state
    without a per-request query — the same pattern used for Turnstile."""
    row = get_settings()
    current_app.config["APP_NAME"] = effective_app_name(row)
    current_app.config["OG_IMAGE_VERSION"] = row.og_image_etag or default_og_version()
