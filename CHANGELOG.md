# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The user-facing summary of each release lives in
[RELEASE_NOTES.md](RELEASE_NOTES.md); both files render in-app under
**Settings → About**.

## [Unreleased]

## [0.2.0] — 2026-06-17

### Added

- **OpenGraph / Twitter Card link previews** (`app/templates/_meta_og.html`,
  `app/main/routes.py`). A shared meta partial — included in the public viewer,
  sign-in, and admin `<head>`s — emits `og:*` + `twitter:card` tags so the link
  unfurls with a title, description, and 1200×630 image when posted to chat apps
  and social media. The `og:image` URL is absolute and version-stamped (`?v=`)
  so platforms re-crawl when the image changes. A new public `/og-image` route
  serves the operator's uploaded image or falls back to the bundled default
  (`static/img/og-image.webp`).
- **Branding settings** (`app/templates/_settings_modal.html`,
  `app/admin/routes.py::save_branding`). A new admin-only **Settings → Branding**
  tab to set the app title and upload a share image (JPEG/PNG/WebP/GIF, ≤4 MB)
  with a live preview and a reset-to-default option.

### Changed

- **`AppSettings` model** (`app/models.py`) gained `app_title` and
  `og_image_bytes` / `og_image_mime` / `og_image_etag` columns (added to existing
  DBs idempotently via `_ensure_schema`). The effective title is mirrored into
  `app.config["APP_NAME"]` at boot and on save — the same pattern used for the
  Turnstile config — so every `{{ app_name }}` reflects the current value with no
  per-request query (`app/app_settings.py::apply_branding_config`).

## [0.1.0] — 2026-06-16

### Added

- **Browser-based broadcaster** (`app/stream/`, `static/js/stream-broadcaster.js`).
  Captures camera/mic via `getUserMedia`, builds a `MediaRecorder` with a supported
  WebM mime, emits the WebM init segment followed by ~250 ms chunks over the
  `bcast:chunk` Socket.IO event. Video files can be shared in place of a live camera.
- **MediaSource-based viewer** (`static/js/stream-viewer.js`, `templates/public/viewer.html`).
  Anonymous viewers join the `viewers` room, receive `stream:state`, and — when live —
  the cached init segment plus subsequent `stream:chunk` binary events, rebuilding a
  `SourceBuffer` to join mid-stream. Autoplay (muted), mute/unmute, volume, fullscreen,
  and a live viewer count.
- **In-process broadcast state** (`app/stream/state.py`). Caches the init segment and
  fans chunks out to the viewers room. Single eventlet worker (`-w 1`); horizontal
  scaling notes in `CLAUDE.md`.
- **Auth & roles** (`app/models.py`, `app/auth/`). `admin` / `streamer` / `viewer`
  roles with a `PERMISSIONS` capability map. bcrypt passwords (12-char min, 72-byte
  ceiling). Failed-login lockout (5 strikes → 24 h via `locked_until`), early unlock
  from the Users tab, and a constant-time dummy hash for unknown usernames.
- **Admin UI** (`app/admin/`, `templates/admin/`). Login-gated dashboard, broadcaster
  page, and a settings modal (Profile / Users / Security / About) with a blurred
  backdrop. Three-zone sidebar and a dark/light theme with pre-paint flash prevention.
- **Security headers & CSRF** (`app/__init__.py`). Per-request CSP nonce in
  `g.csp_nonce`, global Flask-WTF CSRF, and `BEHIND_HTTPS_PROXY=1` to enable HSTS,
  `Secure` cookies, and one hop of `X-Forwarded-*` trust.
- **Optional Cloudflare Turnstile** login captcha, configurable from
  **Settings → Security**.
- **Centralized release notes / changelog** (`app/about_docs.py`). `RELEASE_NOTES.md`
  and `CHANGELOG.md` at the repo root are the single source of truth; parsed and cached
  by mtime, exposed to templates as `app_release_notes()` / `app_changelog()`, and
  rendered in the About modal.
- **AGPLv3 license**, Docker Compose deployment, and an HTTPS-reverse-proxy story.
