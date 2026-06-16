# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Viibestream is a Flask + Socket.IO video streaming web app, packaged as a
single Docker Compose service. The admin captures camera/mic in the browser
and broadcasts WebM chunks via WebSocket; viewers on the public page
receive those chunks and play them back via MediaSource Extensions.

## Run it

```bash
cp .env.example .env             # set SECRET_KEY and INITIAL_ADMIN_PASSWORD
docker compose up --build        # http://localhost:8000
```

- Public viewer: `/`
- Admin login: `/auth/login`
- Admin dashboard: `/admin`
- Broadcaster page: `/admin/stream`
- Health probe: `/healthz`

The first time the container boots, if no admin user exists and
`INITIAL_ADMIN_PASSWORD` is set in `.env`, a bootstrap admin is seeded
from `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_EMAIL`. Remove those vars
after first sign-in.

Dev loop (no Docker):
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export FLASK_ENV=development SECRET_KEY=dev INITIAL_ADMIN_PASSWORD=devpassword123
python run.py
```

## Architecture

### Request paths
- **`/`** (`app/main/routes.py`) — public viewer page, anonymous OK.
- **`/auth/...`** (`app/auth/routes.py`) — login, logout, change password.
- **`/admin/...`** (`app/admin/routes.py`) — backend; requires login. All
  routes are gated by `@bp.before_request` + per-route permission
  decorators in `app/auth/permissions.py`.

### Streaming dataflow
1. Broadcaster page (`templates/admin/stream.html` +
   `static/js/stream-broadcaster.js`) calls `getUserMedia`, builds a
   `MediaRecorder` with a supported WebM mime, and emits the first
   blob (the WebM init segment) followed by ~250 ms chunks over
   `bcast:chunk` Socket.IO events.
2. `app/stream/events.py` validates the broadcaster's permissions,
   stashes the **init segment** in `BroadcastState` (`app/stream/state.py`),
   and fans every chunk out to the `viewers` Socket.IO room as
   `stream:chunk` binary events.
3. The viewer page (`templates/public/viewer.html` +
   `static/js/stream-viewer.js`) joins on connect; the server replies
   with `stream:state`, then (if live) `stream:init` and the cached
   init segment so MSE can rebuild a SourceBuffer mid-stream.

**Scaling note**: `BroadcastState` is in-process. The Dockerfile runs a
single eventlet worker (`-w 1`) for this reason. To scale horizontally,
swap `BroadcastState` for Redis-backed state and add a Socket.IO message
queue (`socketio.init_app(..., message_queue="redis://...")`).

### Auth / permissions
- `app/models.py` defines `Role` (`admin` / `streamer` / `viewer`) and
  the `PERMISSIONS` capability map. Passwords are bcrypt with a 12-char
  minimum and a 72-byte ceiling (the bcrypt limit).
- Failed logins increment `failed_login_count`; 5 failures lock the account
  for 24 hours via `locked_until`. The window resets once the lock elapses
  (`clear_expired_lock`), and an admin can clear it early from the Users tab
  (`admin.unlock_user` → `User.unlock`). Login also runs a dummy bcrypt for
  unknown usernames so timing can't reveal whether an account exists.
- HTTP routes use `@login_required` + `permission_required("…")` or
  `admin_required`. Socket.IO handlers check `current_user` directly
  inside the handler (see `_require_broadcaster` in `app/stream/events.py`).

### Security headers / CSRF
- `app/__init__.py::_register_security_headers` builds a per-request
  CSP with a nonce in `g.csp_nonce`. All inline `<script>` tags
  reference `{{ csp_nonce }}`. Adding a new inline script without a
  nonce will be blocked by CSP — either give it a nonce or move it to
  `static/js/`.
- CSRF is on globally via `Flask-WTF`. All forms include
  `{{ csrf_token() }}` (or use `form.csrf_token`); the logout button is
  a POST with a CSRF token.
- `BEHIND_HTTPS_PROXY=1` enables `Strict-Transport-Security`, marks
  session/remember cookies `Secure`, and trusts one hop of
  `X-Forwarded-*`.

## Conventions

- **Sizing**: all CSS dimensions are in `rem`. `1rem == 16px` (set on
  `html`). Don't introduce `px` for layout — use `rem` (or unitless
  `1.5` for `line-height`). Borders use `1px` (intentionally hairline).
- **Theme**: `data-theme="dark|light"` on `<html>`, switched by
  `static/js/theme.js`, persisted as `vbs-theme` in `localStorage`. Pre-paint
  bootstrap script in each base template prevents flash.
- **Sidebar**: three-zone flex layout — fixed brand at the top, scrollable
  `<nav>` in the middle, fixed `.sidebar-footer` at the bottom. Mirrors
  the pattern in `~/tspro`.
- **Modals**: any element with `data-open-modal="<id>"` opens
  `#<id>.modal-root`; close via `data-close-modal`, Escape, or backdrop
  click. Backdrop uses `backdrop-filter: blur()` for the dim/blur effect.
- **Inline scripts** must carry `nonce="{{ csp_nonce }}"` or CSP blocks
  them. Prefer external files in `static/js/`.

## Common edits

- **Add a permission**: extend `PERMISSIONS` in `app/models.py`, then
  gate routes with `@permission_required("your.perm")` and Socket.IO
  handlers with an inline `current_user.has_permission(...)` check.
- **Add a sidebar item**: edit `app/templates/_sidebar.html`. The active
  state is keyed on the `page` template variable each admin view passes
  to `render_template`.
- **Change stream chunk cadence**: `state.recorder.start(<ms>)` in
  `static/js/stream-broadcaster.js`. Lower = lower latency, more
  network chatter.
