# Changelog

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The user-facing summary of each release lives in
[RELEASE_NOTES.md](RELEASE_NOTES.md); both files render in-app under
**Settings → About**.

## [Unreleased]

## [0.4.0] — 2026-08-22

### Added

- **Phone-first viewer layout** (`static/css/public.css`, viewer template).
  Under 48rem the page becomes an app-like frame: the page never scrolls;
  the video is a full-bleed stage that takes every pixel the chat doesn't;
  the control row rides ON the video over a bottom scrim (volume slider and
  latency/quality chips hidden — hardware volume + a compact `LIVE · N
  watching` readout); the chat is a bottom sheet with rounded top corners
  whose header doubles as a grab bar — tap it (or the chevron,
  `#chat-collapse-btn`) to collapse the sheet to its header and give the
  video the whole screen (persisted as `vbs-chat-collapsed`). The fold is
  animated: the sheet's height tweens between its expanded size and the
  bar (0.32s ease), the player glides into the freed space, and the
  sheet's contents — wrapped in `.chat-body` for this — fade out first so
  nothing squashes mid-animation (visibility flips after the fade;
  reduced-motion disables all of it). Safe-area insets respected top and
  bottom. Landscape phones (`max-height: 32rem`)
  get a tightened two-column grid with the same compact controls.
- **Burger menu** (`#menu-btn`, `body.menu-open`). On phones the header
  action row (`#public-actions` — Now Showing, connection status,
  Admin/Sign in, version) folds into a slide-down glass sheet under the
  burger; same elements and ids, CSS repositions them, so info.js and the
  status chip keep working unmodified.
- **iPhone fullscreen** (`stream-viewer.js`). Where the element-fullscreen
  API doesn't exist (iPhone), the fullscreen button falls back to the
  video's native `webkitEnterFullscreen()` — rotate-to-landscape works.
- **Real playback-capability reports** replace the codec-guessing
  "No Apple viewers" chip. Viewers emit `viewer:playback {ok}` when MSE
  accepts/rejects the broadcast mime (`stream-viewer.js`); the server
  tracks the can't-play set per broadcast (`state.py::set_playback_ok`,
  cleared on (re)start and viewer departure) and pushes
  `stream:playback_issues {count}` to broadcasters (`events.py`). The
  broadcaster chip now reads "⚠ N viewers can't play this" and only
  appears when someone is actually affected — WebKit's decode support
  moves too fast for UA/codec heuristics (Safari 18.4 even records WebM).

### Fixed

- **iOS focus zoom** (`public.css`). Safari zooms the page when a focused
  input's text renders under 16px, cropping the right edge of the layout.
  On phones every text input (chat join, compose, profile, lock code) now
  renders at 1rem/16px, which suppresses the zoom without resorting to
  `maximum-scale=1` (that hack breaks pinch-zoom on Android).

## [0.3.0] — 2026-08-22

### Added

- **Safari & iPhone/iPad playback** . The broadcast pipeline now prefers
  **fragmented MP4 (H.264/AAC)** — the one container every browser's MSE
  accepts — over WebM:
  - `static/js/stream-broadcaster.js::pickMime` tries
    `video/mp4;codecs=avc1…,mp4a.40.2` first (recordable in Chrome/Edge
    130+ and Safari 14.1+) and falls back to WebM (Firefox can't record
    MP4). Bare `video/mp4` sits *below* WebM: a recorder that accepts
    only the bare string (e.g. Chromium without licensed codecs) would
    fill it with VP9 — useless to Safari — and the codec-less mime
    breaks Chrome's own MSE. A ⚠ chip beside the Codec stat warns when
    a WebM-only browser is broadcasting, since Apple-device viewers
    can't play that. fMP4 recording sets
    `videoKeyFrameIntervalDuration: 1000` — mp4 fragments can only
    close on a keyframe, and without forced ~1s keyframes Chrome's
    muxer emits a chunk every ~7s or worse.
  - `app/stream/state.py` late-joiner buffer is now container-aware: for
    mp4 it walks length-prefixed top-level boxes and segments on `moof`
    fragments (ftyp+moov = init segment) instead of scanning for WebM
    Cluster IDs; partially-received boxes wait in `pending` and are
    appended to the late-joiner payload so it stays byte-continuous with
    the live chunk stream. Unit-tested at every possible chunk split
    (`tests/test_late_joiner_buffer.py`).
  - `static/js/stream-viewer.js` falls back to **ManagedMediaSource**
    where `MediaSource` is missing (iPhone, iOS 17.1+), setting
    `disableRemotePlayback` as WebKit requires; fMP4 SourceBuffers use
    the default `segments` mode (WebKit's `sequence` handling of fMP4 is
    unreliable), WebM keeps `sequence`.

### Changed

- **Adaptive live-sync cushion** (`stream-viewer.js`). Chrome's MP4
  muxer ignores the 250 ms timeslice and emits one chunk per keyframe
  (~6–7 s), which would starve a fixed 3 s cushion into a play/stall/seek
  loop. The viewer now sizes its behind-live target from the largest
  recent inter-chunk gap (floor 3 s, ceiling ~15 s + margins), so WebM
  and Safari-fMP4 broadcasts keep ~3 s latency while Chrome-fMP4
  broadcasts settle into a stable ~10 s. Watch-party sync (everyone at
  the same distance behind live) is preserved.
- **Stall auto-recovery** (`stream-viewer.js::syncToLive`). WebKit pauses
  the `<video>` on SourceBuffer underrun and never resumes by itself;
  since the viewer page has no pause control, a paused-but-live player
  is always a stall and is now nudged back into playback (falling back
  to muted play if the browser blocks unmuted autoplay).
- **Honest browser warning** (`browser-warning.js`, viewer template). The
  blanket "Safari may perform poorly" banner is gone. The banner now
  only appears when the browser has no MSE at all (iOS < 17.1), or —
  raised by the viewer with a format-specific message — when the active
  broadcast is a format the browser truly can't play (a WebM stream
  viewed from Safari).

## [0.2.4] — 2026-07-05

### Added

- **Broadcaster can rename a participant** (`app/chat/events.py`,
  `app/chat/state.py::rename`, `app/static/js/participants.js`). Each
  Participants row gains a pencil that turns the name into an inline input
  (Enter/blur commits, Escape cancels). A host-only `chat:moderate_rename`
  event validates the name (2–24 chars, unique) and, on success, pushes
  `chat:user_updated` to the chat room + a fresh `chat:roster` to the panel;
  the renamed viewer's own client updates its identity and localStorage so the
  name sticks across reconnects. Duplicate/invalid names surface a transient
  toast via `chat:mod_error`. No system message is posted — renaming is often
  used to clean up an offensive handle, so it's applied silently.

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
