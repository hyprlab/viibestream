# Release Notes

User-friendly, scannable summary of every Viibestream version bump. The
deeper, version-by-version implementation log lives in
[CHANGELOG.md](CHANGELOG.md).

The same content appears in-app under **Settings → About** with the
release notes expanded by default and the changelog collapsed. Editing
this file is the only step needed to update that view.

## 0.2.0 — 2026-06-17 (latest) — Branding & link previews

- **Polished link previews.** Share the public link anywhere — chat apps, social media, messengers — and it now unfurls with a proper preview card (title, description, and a 1200×630 image) via OpenGraph and Twitter Card tags. The preview shows on the viewer, sign-in, and admin pages.
- **Brandable from the UI.** A new **Settings → Branding** tab (admins) lets you set the app title and upload your own share image — no file edits or redeploys. The title flows through the header, browser tab, and link previews; leave it blank to fall back to the default. A built-in default share image ships out of the box.
- **Swap or reset anytime.** Upload a JPEG, PNG, WebP, or GIF (up to 4 MB) and the new image goes live immediately, with cache-busting so social platforms re-fetch it. One click resets back to the bundled default.

## 0.1.0 — 2026-06-16 — First public release

- **Broadcast straight from your browser.** Sign in to the admin, point your camera and mic at the broadcaster page (or share a video file), and go live — no plugins, no native apps, no third-party services in the path.
- **Instant playback for viewers.** Anyone who opens the public page sees you live through MediaSource Extensions, with autoplay, mute/unmute, volume, fullscreen, a live viewer count, and a dark/light theme. Late-joiners get the stream's init segment first so they can join mid-flight.
- **Roles and user management.** Admin / streamer / viewer roles with a tight capability map. Admins manage users from **Settings → Users**; streamers can go live.
- **Secure by default.** bcrypt passwords, CSRF on every form, per-request Content-Security-Policy nonces, hardened session cookies, account lockout after repeated failed logins, and login rate limiting. An optional Cloudflare Turnstile captcha can be turned on from **Settings → Security**.
- **Docker-first.** Ships as a single Docker Compose service — one `docker compose up --build` and you're running.
