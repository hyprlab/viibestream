"""Flask application factory.

Wires extensions, blueprints, security headers, the Socket.IO server, and
seeds the initial admin user on first boot.
"""
from __future__ import annotations

import os
import secrets

from flask import Flask, g, render_template, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

from .config import get_config
from .extensions import (
    csrf,
    db,
    limiter,
    login_manager,
    migrate,
    socketio,
)


def create_app(config_class=None) -> Flask:
    app = Flask(
        __name__,
        instance_relative_config=True,
        static_folder="static",
        template_folder="templates",
    )
    app.config.from_object(config_class or get_config())

    os.makedirs(app.instance_path, exist_ok=True)

    # Trust X-Forwarded-* exactly one hop (the reverse proxy in front of us).
    if app.config.get("BEHIND_HTTPS_PROXY"):
        app.wsgi_app = ProxyFix(
            app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1
        )

    _init_extensions(app)
    _register_blueprints(app)
    _register_security_headers(app)
    _register_static_cache_busting(app)
    _register_error_handlers(app)
    _register_template_globals(app)
    _register_socketio_events(app)
    _register_health_routes(app)

    with app.app_context():
        db.create_all()
        _ensure_schema(app)
        _bootstrap_admin(app)
        # Load admin-managed settings (Turnstile) into app.config; seeds the
        # row from the env vars on first boot, then the UI owns it.
        from .app_settings import apply_turnstile_config
        apply_turnstile_config()
        # Capture the compiled-in app name before branding can override it,
        # so a blank app_title always falls back to it. Then mirror the
        # operator's branding (title + OG image version) into app.config.
        app.config.setdefault("APP_NAME_DEFAULT", app.config["APP_NAME"])
        from .app_settings import apply_branding_config
        apply_branding_config()
        # Restore the persisted Now Showing so it survives restarts.
        from .stream.info import load_from_db as _load_now_showing
        _load_now_showing()
        # Restore the access-code lock so viewers aren't re-prompted just
        # because the backend restarted.
        from .stream.state import load_lock_from_db as _load_lock
        _load_lock()
        # Restore the live chat so the conversation survives a restart.
        from .chat.state import load_chat_from_db as _load_chat
        _load_chat()

    return app


# ── Init helpers ────────────────────────────────────────────────────────────


def _init_extensions(app: Flask) -> None:
    db.init_app(app)
    migrate.init_app(app, db)

    csrf.init_app(app)

    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    login_manager.session_protection = "strong"
    login_manager.refresh_view = "auth.login"
    login_manager.needs_refresh_message_category = "info"

    limiter.init_app(app)

    socketio.init_app(
        app,
        cors_allowed_origins=app.config["SOCKETIO_CORS_ALLOWED_ORIGINS"],
        max_http_buffer_size=app.config["SOCKETIO_MAX_HTTP_BUFFER_SIZE"],
        async_mode="eventlet",
        manage_session=False,
    )

    from .models import User  # noqa: WPS433  (avoid circular at import time)

    @login_manager.user_loader
    def _load_user(user_id: str):
        try:
            return db.session.get(User, int(user_id))
        except (TypeError, ValueError):
            return None


def _register_blueprints(app: Flask) -> None:
    from .auth.routes import bp as auth_bp
    from .admin.routes import bp as admin_bp
    from .main.routes import bp as main_bp

    app.register_blueprint(main_bp)
    app.register_blueprint(auth_bp, url_prefix="/auth")
    app.register_blueprint(admin_bp, url_prefix="/admin")


def _register_security_headers(app: Flask) -> None:
    """Generate a CSP nonce per request and set hardened security headers."""

    @app.before_request
    def _csp_nonce() -> None:
        g.csp_nonce = secrets.token_urlsafe(16)

    @app.after_request
    def _headers(resp):
        nonce = getattr(g, "csp_nonce", "")
        # Strict self-only policy — no third-party origins. Socket.IO,
        # fonts, and ffmpeg.wasm are all vendored under /static. The
        # only outbound thing the page does is open a WebSocket back to
        # itself. 'wasm-unsafe-eval' is required for WebAssembly module
        # compilation (used by the in-browser transcoder for unsupported
        # file formats like MKV).
        # Cloudflare Turnstile (login captcha) loads a script + renders an
        # iframe from challenges.cloudflare.com — allow it only when the
        # operator has actually configured Turnstile, otherwise keep the
        # policy strictly self-only.
        cf = "https://challenges.cloudflare.com"
        ts = bool(app.config.get("TURNSTILE_SITE_KEY"))
        script_cf = f" {cf}" if ts else ""
        connect_cf = f" {cf}" if ts else ""
        frame_src = f"frame-src 'self' {cf}; " if ts else ""
        csp = (
            "default-src 'self'; "
            "base-uri 'self'; "
            "object-src 'none'; "
            "frame-ancestors 'none'; "
            "form-action 'self'; "
            f"script-src 'self' 'wasm-unsafe-eval' 'nonce-{nonce}'{script_cf}; "
            "style-src 'self' 'unsafe-inline'; "
            "font-src 'self'; "
            "img-src 'self' data: blob:; "
            "media-src 'self' blob:; "
            f"{frame_src}"
            f"connect-src 'self' ws: wss:{connect_cf}; "
            "worker-src 'self' blob:;"
        )
        resp.headers.setdefault("Content-Security-Policy", csp)
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        resp.headers["Permissions-Policy"] = (
            "camera=(self), microphone=(self), geolocation=(), interest-cohort=()"
        )
        if app.config.get("BEHIND_HTTPS_PROXY") or app.config.get("TLS_ENABLE"):
            resp.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        return resp


def _register_static_cache_busting(app: Flask) -> None:
    """Stamp every static asset URL with a ``?v=<mtime>`` version param.

    ``url_for('static', filename='css/base.css')`` becomes
    ``/static/css/base.css?v=1780059312``. When a CSS/JS/image file
    changes, its modification time changes, so the URL changes too — the
    browser treats it as a brand-new resource and downloads it on the
    next *normal* page load. No hard refresh, and it's immune to any
    revalidation quirk in the browser or the reverse proxy. Unchanged
    files keep a stable URL, so they stay cacheable.

    We stat on each call (a handful of files per page, ~microseconds
    each) rather than caching, so edits are picked up live in dev without
    a server restart. Docker's COPY preserves source mtimes, so the stamp
    also moves across image rebuilds whenever the file actually changed.
    """

    @app.url_defaults
    def _stamp_static(endpoint, values):
        if endpoint != "static":
            return
        filename = values.get("filename")
        if not filename:
            return
        try:
            mtime = os.stat(os.path.join(app.static_folder, filename)).st_mtime
        except OSError:
            # File missing / unreadable — emit the bare URL rather than
            # blowing up url_for at render time.
            return
        values["v"] = int(mtime)


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(403)
    def _403(_):
        return render_template("errors/403.html"), 403

    @app.errorhandler(404)
    def _404(_):
        return render_template("errors/404.html"), 404

    @app.errorhandler(500)
    def _500(_):
        app.logger.exception("Unhandled 500")
        return render_template("errors/500.html"), 500


def _register_template_globals(app: Flask) -> None:
    @app.context_processor
    def _inject():
        app_name = app.config["APP_NAME"]
        return {
            "app_name": app_name,
            "app_version": app.config["APP_VERSION"],
            "csp_nonce": getattr(g, "csp_nonce", ""),
            # OpenGraph / Twitter-card values for the shared link. The image
            # URL is absolute (so crawlers can fetch it) and version-stamped
            # (so platforms re-crawl when the operator swaps the image).
            "og_title": app_name,
            "og_description": f"Watch the live stream on {app_name}.",
            "og_image_url": url_for(
                "main.og_image",
                v=app.config.get("OG_IMAGE_VERSION", ""),
                _external=True,
            ),
        }

    # Release Notes + Changelog: editing RELEASE_NOTES.md / CHANGELOG.md at
    # the repo root is the only step needed to update the in-app About view.
    # See app/about_docs.py (parses + caches by mtime).
    from . import about_docs as _about_docs

    app.jinja_env.globals["app_release_notes"] = _about_docs.load_release_notes
    app.jinja_env.globals["app_changelog"] = _about_docs.load_changelog


def _register_socketio_events(app: Flask) -> None:
    # Imported for side effects: the @socketio.on(...) decorators register
    # handlers on the singleton SocketIO instance.
    from .stream import events  # noqa: F401,WPS433
    from .chat import events as chat_events  # noqa: F401,WPS433


def _register_health_routes(app: Flask) -> None:
    @app.route("/healthz")
    @limiter.exempt
    def _healthz():
        return {"ok": True, "version": app.config["APP_VERSION"]}, 200


# ── Lightweight schema reconciliation ────────────────────────────────────────


def _ensure_schema(app: Flask) -> None:
    """Bring an existing DB up to date with columns added after first boot.

    The app provisions its schema with ``db.create_all()``, which creates
    missing tables but never alters existing ones. When we add a column to
    a model, older databases (e.g. the SQLite file in the deployed volume)
    won't have it, so we add it here idempotently.

    Adding ``users.must_change_password`` also flags every pre-existing
    admin for a forced reset: when this feature first lands, current
    admins may still be on a weak bootstrap password, so we make them
    rotate it on their next sign-in. (New rows default to False.)
    """
    from sqlalchemy import inspect as sa_inspect, text

    inspector = sa_inspect(db.engine)
    if "users" not in inspector.get_table_names():
        return  # fresh DB — create_all() already built it with the columns
    columns = {c["name"] for c in inspector.get_columns("users")}

    if "must_change_password" not in columns:
        db.session.execute(text(
            "ALTER TABLE users ADD COLUMN must_change_password "
            "BOOLEAN NOT NULL DEFAULT 0"
        ))
        result = db.session.execute(text(
            "UPDATE users SET must_change_password = 1 WHERE role = 'admin'"
        ))
        db.session.commit()
        app.logger.info(
            "Added users.must_change_password; flagged %s existing admin(s) "
            "for a forced password reset.", result.rowcount,
        )

    # Persistent chat identity for the broadcaster (added after first boot).
    for col in ("chat_name", "chat_emoji"):
        if col not in columns:
            db.session.execute(text(f"ALTER TABLE users ADD COLUMN {col} VARCHAR"))
            db.session.commit()
            app.logger.info("Added users.%s for persistent chat identity.", col)

    # Branding columns on app_settings (added after first boot): the app
    # title and the OpenGraph share image. Each ALTER is idempotent.
    if "app_settings" in inspector.get_table_names():
        settings_cols = {c["name"] for c in inspector.get_columns("app_settings")}
        branding_ddl = {
            "app_title": "ALTER TABLE app_settings ADD COLUMN app_title VARCHAR(120) NOT NULL DEFAULT ''",
            "og_image_bytes": "ALTER TABLE app_settings ADD COLUMN og_image_bytes BLOB",
            "og_image_mime": "ALTER TABLE app_settings ADD COLUMN og_image_mime VARCHAR(64)",
            "og_image_etag": "ALTER TABLE app_settings ADD COLUMN og_image_etag VARCHAR(128) NOT NULL DEFAULT ''",
        }
        for col, ddl in branding_ddl.items():
            if col not in settings_cols:
                db.session.execute(text(ddl))
                db.session.commit()
                app.logger.info("Added app_settings.%s for branding.", col)


# ── First-boot bootstrap ────────────────────────────────────────────────────


def _bootstrap_admin(app: Flask) -> None:
    """Seed an initial admin if none exists and INITIAL_ADMIN_PASSWORD is set."""
    from .models import User, Role

    if User.query.filter(User.role == Role.ADMIN).first():
        return
    password = app.config.get("INITIAL_ADMIN_PASSWORD")
    if not password:
        app.logger.warning(
            "No admin user exists and INITIAL_ADMIN_PASSWORD is unset — "
            "create one manually or set it in .env and restart."
        )
        return
    username = app.config["INITIAL_ADMIN_USERNAME"]
    email = app.config["INITIAL_ADMIN_EMAIL"]
    if User.query.filter(
        (User.username == username) | (User.email == email)
    ).first():
        app.logger.warning(
            "Initial admin bootstrap skipped: a user with that username or "
            "email already exists but is not an admin."
        )
        return
    # Force the freshly-seeded admin to set their own password on first
    # sign-in, so the bootstrap credential is single-use and never lingers
    # as a usable login.
    user = User(
        username=username, email=email, role=Role.ADMIN, is_active=True,
        must_change_password=True,
    )
    # Bootstrap bypasses the password policy so an operator can seed a quick
    # admin; must_change_password forces a policy-compliant reset on first
    # sign-in. Regular self-service changes still enforce the policy.
    try:
        user.set_password(password, enforce_policy=False)
    except ValueError:
        import bcrypt as _bcrypt
        user.password_hash = _bcrypt.hashpw(
            password.encode("utf-8")[:72], _bcrypt.gensalt(rounds=12)
        )
        app.logger.warning(
            "Bootstrap password could not be hashed cleanly. "
            "Sign in and change it immediately."
        )
    db.session.add(user)
    db.session.commit()
    app.logger.info("Bootstrapped initial admin user: %s", username)
