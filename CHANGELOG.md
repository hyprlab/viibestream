# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The user-facing summary of each release lives in
[RELEASE_NOTES.md](RELEASE_NOTES.md); both files render in-app under
**Settings → About**.

## [Unreleased]

## [0.2.3] — 2026-07-05

### Added

- **Group voice is now an always-on channel** independent of the file stream
  (`app/static/js/talk.js`, `app/chat/events.py`). The broadcaster joins the
  voice channel as a participant: their mic control moved out of the preview
  pane into its own **Host** row at the top of the Participants panel, with the
  same reactive "speaking" highlight as everyone else. Host voice frames bypass
  the participant-audio gate and can't be muted (`_talk_frame`), and the host
  captures with echo-cancellation off (headphones expected). The broadcaster's
  mic no longer runs through the file mixer, so talking works whether or not a
  file is playing/paused/stopped.
- **Broadcast file-audio level + mute** beside the scrubber
  (`templates/admin/stream.html`, `stream-broadcaster.js`). A Web Audio gain on
  the file's captured audio lets the broadcaster set how loud the shared file
  goes out — independent of each viewer's own volume — because `captureStream()`
  ignores the media element's `volume`/`muted`. The gain is built inside the
  Go-Live click so its `AudioContext` starts *running* (one created off a
  gesture starts suspended and renders silence), with a gesture-based resume
  safety net. The broadcaster's own monitor is set to the same level.

### Changed

- **Pausing the stream no longer mutes the viewer's audio**
  (`stream-viewer.js::setPaused`). The "Paused" overlay + video blank remain,
  but the player is no longer force-muted, so voice conversations continue
  while the file is paused.
- **The viewer stream now defaults to unmuted** (`templates/public/viewer.html`,
  `stream-viewer.js`). The `<video>` drops the `muted` attribute; `tryAutoplay`
  attempts sound first and falls back to muted playback + the "click for sound"
  badge only if the browser blocks autoplay-with-sound. The volume slider now
  honestly reads **down** when muted.
- **The reaction control is a labelled "🤣 Reactions" button** (brand-yellow
  outline on a transparent background) on both the viewer control bar and the
  broadcaster preview. Shared styles moved to `chat.css`.
- **A stray media-element pause no longer blips the broadcast to "Paused"**
  (`stream-broadcaster.js`). Toggling the mic can make the OS reinitialise the
  audio device and briefly pause the file element; the broadcaster now
  distinguishes a deliberate Pause from a stray one and transparently resumes
  the latter.

### Removed

- **The "Mute file audio on this device" (local monitor-mute) button**
  (`templates/admin/stream.html`, `stream-broadcaster.js`). The broadcaster
  monitors at the same level they broadcast, so a separate local mute is no
  longer needed.

## [0.2.2] — 2026-07-04

### Changed

- **Rebranded from Viibeware to Hyprlab.** The GitHub and Docker Hub repos now
  live under the `hyprlab` account (`hyprlab/viibestream`); `README.md`
  install/clone/pull instructions point there. The **Settings → About** credit
  now reads "Built by Hyprlab", links to `https://hyprlab.co`, and uses the new
  `static/img/icon_hyprlab.png` logo (24 px tall, ±3 px horizontal margin, name
  set in `font-weight: 800` / `0.865rem` with no letter-spacing). The old
  `viibeware.svg` asset and `.viibeware-*` CSS classes were removed
  (`app/templates/_settings_modal.html`, `app/static/css/admin.css`).

## [0.2.1] — 2026-06-17

### Added

- **Editable subheading** in the **Settings → Branding** tab
  (`app/templates/_settings_modal.html`, `app/admin/routes.py::save_branding`).
  A new `app_tagline` column on `AppSettings` (added idempotently via
  `_ensure_schema`) drives the page `<meta description>` and the
  `og`/`twitter` description, mirrored into `app.config["APP_DESCRIPTION"]` at
  boot/save. Blank falls back to the default.

### Changed

- **Default subheading** is now "Self-hosted live streaming platform for watch
  parties" (`app/app_settings.py::DEFAULT_APP_TAGLINE`), replacing the previous
  "Watch the live stream on …" text.

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
