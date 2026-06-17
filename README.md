# Viibestream

A self-hosted, browser-native live video streaming app. Sign in to the
admin, point your browser camera/mic at it (or share a video file), and
anyone who hits the public page sees you live — no plugins, no native
apps, no third-party services in the path. Just browser capture +
MediaSource playback over Socket.IO.

> **License:** Viibestream is free software released under the
> [GNU Affero General Public License v3.0](#license) (AGPLv3).

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install with the pre-built image](#install-with-the-pre-built-image)
  - [1. Create the Compose file](#1-create-the-compose-file)
  - [2. Create your `.env`](#2-create-your-env)
  - [3. Choose an HTTPS strategy](#3-choose-an-https-strategy)
  - [4. Pull and run](#4-pull-and-run)
  - [5. First sign-in](#5-first-sign-in)
- [Build from source instead](#build-from-source-instead)
- [Configuration reference (`.env`)](#configuration-reference-env)
- [Production behind a reverse proxy](#production-behind-a-reverse-proxy)
- [Operating the container](#operating-the-container)
- [Updating](#updating)
- [Release notes & changelog](#release-notes--changelog)
- [Development (without Docker)](#development-without-docker)
- [Tech](#tech)
- [License](#license)

## Features

### Watching

- **Public viewer at `/`** — autoplay (muted by default), mute/unmute,
  volume, fullscreen, and a live viewer count. No account needed to
  watch.
- **"Now Showing" panel** — the broadcaster can label the stream with a
  title, description, IMDB link, and a poster image; viewers open it
  from the player and it updates live as the host changes it.
- **Light & dark theme** — a polished, responsive interface that
  remembers your theme choice, with no flash on load.

### Live chat

- **Real-time chat panel** alongside the stream — slides in from the
  edge, with a live participant count and a message history for
  late-joiners.
- **Pick a name and emoji avatar** — viewers join with a display name
  and a fun emoji from a curated palette; profiles are editable on the
  fly.
- **Replies, @-mentions, and emoji reactions** — reply to a specific
  message, mention other participants from an autocomplete menu, and
  react to messages with emoji. Pin the panel open or mute it as you
  like.
- **Join / leave announcements** with a short grace period so quick
  reconnects don't spam the room.

### Voice talk-back

- **Viewers can talk back** — joined viewers can speak so the whole room
  hears them. The mic is captured, run through voice-activity detection,
  downsampled, and streamed over the same Socket.IO connection; every
  page mixes all speakers through one Web Audio context, so several
  people can talk at once.

### Broadcasting & moderation

- **Broadcast from the browser** — capture camera + mic, or share a
  video file, and go live in one click. No plugins or native apps.
- **Broadcaster console at `/admin/stream`** — go live, edit the "Now
  Showing" metadata, and watch the chat in real time.
- **Live participants panel** — a roster of everyone in the chat with
  per-person mute/unmute, a "mute all" control, and a mic indicator
  that highlights whoever is speaking. Disruptive viewers can be banned
  by IP.

### Administration & security

- **Admin dashboard at `/admin`** — login-gated, with a fixed-header /
  scrollable-middle / fixed-footer sidebar and a settings modal (Profile
  / Users / Security / About) over a blurred backdrop.
- **Roles & permissions** — admin / streamer / viewer with a tight
  capability map. Admins manage users from Settings → Users; streamers
  can go live.
- **Secure by default** — bcrypt passwords, CSRF on all forms, hardened
  session cookies, per-request CSP nonces, account-lockout on brute
  force, login rate limiting, and an optional Cloudflare Turnstile
  captcha. ProxyFix support for HTTPS-terminating reverse proxies.
- **Docker-first** — runs as a single container; image published on
  [Docker Hub](https://hub.docker.com/r/viibeware/viibestream).

## How it works

The admin's browser captures camera + mic via `getUserMedia`, encodes
WebM with `MediaRecorder`, and ships ~250 ms chunks over a Socket.IO
WebSocket to the server. The server caches the first chunk (the WebM
init segment) and fans every chunk out to the `viewers` room. Each
viewer's browser uses MediaSource Extensions to append chunks to a
`SourceBuffer`, so late-joiners receive the cached init segment first
and join the stream mid-flight. See [`CLAUDE.md`](CLAUDE.md) for the
full architecture map.

## Requirements

- **Docker Engine 20.10+** and the **Docker Compose v2** plugin
  (`docker compose`, not the legacy `docker-compose`). Check with:
  ```bash
  docker --version
  docker compose version
  ```
- A modern browser for broadcasting. Browsers only expose
  `getUserMedia` (camera/mic) on `http://localhost` or over **HTTPS** —
  see [step 3](#3-choose-an-https-strategy).

## Install with the pre-built image

The fastest path: run the published image from
[`viibeware/viibestream`](https://hub.docker.com/r/viibeware/viibestream)
— no clone, no build. You just need an empty folder for your Compose
file and your `.env`.

```bash
mkdir viibestream && cd viibestream
```

### 1. Create the Compose file

Create `docker-compose.yml` in that folder, pointing at the published
image:

```yaml
# docker-compose.yml
services:
  viibestream:
    image: viibeware/viibestream:latest   # or pin a version, e.g. :0.2.0
    container_name: viibestream
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - FLASK_ENV=production
    ports:
      # host PORT → container INTERNAL_PORT (8000 plain / 8443 with TLS)
      - "0.0.0.0:${PORT:-8080}:${INTERNAL_PORT:-8000}"
    volumes:
      - viibestream_data:/app/instance   # SQLite DB persists here
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETGID
      - SETUID

volumes:
  viibestream_data:
```

### 2. Create your `.env`

All configuration lives in a `.env` file next to `docker-compose.yml`.
Grab the annotated template from the repo and copy it to `.env`:

```bash
curl -fsSL https://raw.githubusercontent.com/viibeware/viibestream/main/.env.example -o .env
```

`.env` holds secrets and must **never** be committed to git. Open it in
your editor and set the values below.

**Generate a `SECRET_KEY`.** It signs session cookies and CSRF tokens
and must be a long, random, secret string:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(64))"
# no Python on the host? use OpenSSL:
openssl rand -base64 64 | tr -d '\n'; echo
```

Paste the output into `.env`:

```env
SECRET_KEY=<paste the long random string here>
```

> Treat `SECRET_KEY` like a password. Changing it later invalidates all
> existing sessions (everyone is logged out) — which is exactly what you
> want if it ever leaks.

**Set the bootstrap admin password.** On first boot, if no admin exists
yet, Viibestream seeds one from these values:

```env
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_EMAIL=admin@example.com
INITIAL_ADMIN_PASSWORD=<a strong one-time password>
```

`INITIAL_ADMIN_PASSWORD` is used only to create that first account.
After you sign in and change your password (Settings → Profile), blank
the line so the bootstrap can't run again:

```env
INITIAL_ADMIN_PASSWORD=
```

### 3. Choose an HTTPS strategy

Browsers refuse to expose camera/microphone capture on any non-localhost
HTTP origin, so pick **one** strategy in `.env`:

| Strategy | When | `.env` |
|---|---|---|
| **A — Reverse proxy** (recommended for real domains) | Caddy / nginx / Traefik / Cloudflare terminates TLS in front of the container | `BEHIND_HTTPS_PROXY=1`, `TLS_ENABLE=0` |
| **B — In-container self-signed TLS** | LAN / quick demos; the container serves HTTPS on `:8443` and browsers warn once per device | `BEHIND_HTTPS_PROXY=0`, `TLS_ENABLE=1`, `TLS_HOSTS=localhost,127.0.0.1,<your-LAN-IP>`, `PORT=8443` |
| **C — HTTP on localhost** | single-machine dev only | `BEHIND_HTTPS_PROXY=0`, `TLS_ENABLE=0` |

Also set `PUBLIC_ORIGIN` to every origin a browser will load the page
from (comma-separated) — Socket.IO rejects WebSocket handshakes from
origins not in this list. For a public domain include the `https://`
form, e.g. `PUBLIC_ORIGIN=https://stream.example.com`.

### 4. Pull and run

```bash
docker compose pull
docker compose up -d
```

By default the service publishes host port **`8080`** (override with
`PORT` in `.env`). Watch the logs and health:

```bash
docker compose logs -f          # follow startup logs (Ctrl-C to stop)
curl -fsS http://localhost:8080/healthz   # -> {"ok": true, "version": "..."}
```

### 5. First sign-in

1. Open **http://localhost:8080** — the public viewer (no stream yet).
2. Go to **http://localhost:8080/auth/login** and sign in with
   `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD`.
3. Change your password under **Settings → Profile**, then blank
   `INITIAL_ADMIN_PASSWORD` in `.env` (see [step 2](#2-create-your-env)).
4. Open **http://localhost:8080/admin/stream** and go live.

## Build from source instead

Prefer to build the image yourself? Clone the repo — it ships its own
`docker-compose.yml` with `build: .`:

```bash
git clone https://github.com/viibeware/viibestream.git
cd viibestream
cp .env.example .env            # then edit as in step 2 above
docker compose up --build -d
```

The `.env` setup is identical to
[step 2](#2-create-your-env) and [step 3](#3-choose-an-https-strategy)
above; the only difference is `docker compose up --build` compiles the
image locally instead of pulling it.

## Configuration reference (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | — (**required**) | Signs session cookies and CSRF tokens. Long random string. |
| `INITIAL_ADMIN_USERNAME` | `admin` | Username for the bootstrap admin (first boot only). |
| `INITIAL_ADMIN_EMAIL` | `admin@example.com` | Email for the bootstrap admin. |
| `INITIAL_ADMIN_PASSWORD` | — | One-time bootstrap password. Blank it after first sign-in. |
| `BEHIND_HTTPS_PROXY` | `0` | `1` enables HSTS, `Secure` cookies, and trusts one hop of `X-Forwarded-*`. |
| `TLS_ENABLE` | `0` | `1` makes the container serve self-signed HTTPS on `:8443`. |
| `TLS_HOSTS` | `localhost,127.0.0.1` | SANs baked into the self-signed cert when `TLS_ENABLE=1`. |
| `PUBLIC_ORIGIN` | `http://localhost:8080` | Allowed browser origin(s) for the Socket.IO CORS check (comma-separated). |
| `PORT` | `8080` | Host port published by Docker Compose. |
| `INTERNAL_PORT` | `8000` | Container listen port (`8000` plain / `8443` with TLS). |
| `DATABASE_URL` | `sqlite:////app/instance/viibestream.db` | SQLAlchemy database URL (SQLite on the `instance` volume by default). |
| `TURNSTILE_SITE_KEY` | — | Optional: seeds the Cloudflare Turnstile site key on first boot. |
| `TURNSTILE_SECRET_KEY` | — | Optional: seeds the Turnstile secret key. Manage from Settings → Security after. |

## Production behind a reverse proxy

For a real domain, terminate TLS at a reverse proxy and forward plain
HTTP to the container. In `.env`:

```env
SECRET_KEY=...long random token...
PUBLIC_ORIGIN=https://stream.example.com
BEHIND_HTTPS_PROXY=1
TLS_ENABLE=0
```

Your proxy must:

- Send `X-Forwarded-Proto: https` and `X-Forwarded-For` (ProxyFix
  expects exactly **1** hop).
- Proxy WebSocket upgrades for Socket.IO (`/socket.io/*`).
- Forward `Host` so cookie domains match.

Example nginx fragment:

```nginx
location / {
    proxy_pass         http://viibestream:8000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

Caddy needs almost no config — it terminates TLS and proxies WebSockets
automatically:

```caddy
stream.example.com {
    reverse_proxy viibestream:8000
}
```

## Operating the container

```bash
docker compose ps                 # status
docker compose logs -f            # follow logs
docker compose restart            # restart the service
docker compose down               # stop and remove the container
docker compose down -v            # ALSO delete the data volume (wipes the DB!)
```

The SQLite database lives in the named Docker volume `viibestream_data`
(mounted at `/app/instance`), so it **survives rebuilds and restarts**.
Only `docker compose down -v` removes it.

## Updating

**Pre-built image:**

```bash
docker compose pull
docker compose up -d
```

**Built from source:**

```bash
git pull
docker compose up --build -d
```

Either way, your `.env` and the `viibestream_data` volume are preserved.

## Release notes & changelog

Both live at the repo root and are the **single source of truth**:

- [`RELEASE_NOTES.md`](RELEASE_NOTES.md) — user-friendly summary of each version.
- [`CHANGELOG.md`](CHANGELOG.md) — the full implementation log.

These same files render in-app under **Settings → About** (release notes
expanded, changelog collapsed). Editing the Markdown is the only step
needed to update both the docs and the in-app view — see
[`app/about_docs.py`](app/about_docs.py).

## Development (without Docker)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export FLASK_ENV=development SECRET_KEY=dev INITIAL_ADMIN_PASSWORD=devpassword123
python run.py            # http://localhost:8000
```

## Tech

Flask 3, Flask-SocketIO (eventlet), Flask-Login, Flask-WTF,
Flask-Limiter, Flask-Migrate, SQLAlchemy + SQLite, bcrypt, Markdown,
vanilla JS + MediaRecorder + MediaSource Extensions, Gunicorn, Docker
Compose.

## License

Copyright (C) 2026 VIIBEWARE.

Viibestream is free software: you can redistribute it and/or modify it
under the terms of the **GNU Affero General Public License** as published
by the Free Software Foundation, either version 3 of the License, or (at
your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

The full license text is in [`LICENSE`](LICENSE). As an AGPLv3 work, if
you run a modified version of Viibestream as a network service, you must
make the modified source available to its users.
