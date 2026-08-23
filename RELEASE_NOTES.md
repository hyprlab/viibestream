# Release Notes

User-friendly, scannable summary of every Viibestream version bump. The
deeper, version-by-version implementation log lives in
[CHANGELOG.md](CHANGELOG.md).

The same content appears in-app under **Settings → About** with the
release notes expanded by default and the changelog collapsed. Editing
this file is the only step needed to update that view.

## 0.4.1 — 2026-08-23 (latest) — Now Showing link previews

- **Share what's playing.** When a Now Showing entry is set, sharing the viewer link now unfurls with the movie's poster, title, and description — so the invite itself says what tonight's film is. Clear Now Showing (or skip the poster) and the preview falls back to your regular branding image.

## 0.4.0 — 2026-08-22 — Beautiful on phones

- **A real phone experience.** On small screens the viewer is now an app, not a shrunken web page: the video runs edge to edge, the controls sit on the video itself in a slim translucent strip, and the chat lives in a bottom sheet — tap its header to collapse it and give the movie the whole screen (your choice is remembered).
- **Tidy top bar.** On phones the header collapses into a burger menu holding Now Showing, your connection status, the sign-in link, and the version — just the logo and one button up top.
- **Fullscreen on iPhone.** The fullscreen button now works on iPhones too, using the native player — rotate your phone for full-screen landscape.
- **An honest warning for the host.** The "No Apple viewers" guess is gone. The broadcast page now shows "⚠ N viewers can't play this" only when actual viewers report they can't decode the stream — real data from real browsers, and it clears the moment they can.

## 0.3.0 — 2026-08-22 — Safari & iPhone support

- **Watch from any Apple device.** Streams now play in Safari on Mac and in every browser on iPhone and iPad (iOS 17.1 or later). Broadcasts are sent as MP4 (H.264/AAC) — the format Apple devices can actually play — whenever the broadcasting browser supports it: that's Chrome, Edge, and Safari. Firefox can only broadcast WebM, so if you stream from Firefox a small ⚠ chip next to the Codec stat reminds you that Apple-device viewers can't tune in.
- **Smarter live sync.** The player now adapts how far behind live it sits to how the broadcast actually arrives, so MP4 streams from Chrome (which sends bigger, less frequent chunks) play smoothly instead of stuttering. WebM and Safari broadcasts keep the same snappy ~3-second latency as before.
- **No more false Safari warning.** The old "video may perform poorly in Safari" banner is gone. You'll only see a warning when playback genuinely isn't possible — an outdated browser, or a WebM broadcast viewed from Safari — and it says exactly what to do about it.

## 0.2.4 — 2026-07-05 — Rename participants

- **Rename anyone in the room.** As the broadcaster, hover a participant in the **Participants** panel and click the pencil to give them a new screen name — handy for tidying up duplicates or cleaning up an inappropriate handle. The new name updates everywhere and sticks for that person even if they reload.

## 0.2.3 — 2026-07-05 — Group voice & broadcast audio

- **Talk while you watch — always on.** Voice chat no longer depends on the video: you and your viewers can keep talking whether the file is playing, paused, or stopped. Pausing the stream no longer cuts the conversation.
- **You're in the room too.** The broadcaster now appears at the top of the **Participants** panel with their own mic button, and the row lights up when you're speaking — just like everyone else. (Use headphones so your mic doesn't echo the movie.)
- **Control how loud the movie is.** A new volume slider and mute button sit next to the scrubber so you can turn the shared file down when it's drowning out people's microphones. This sets how loud it goes out to everyone — each viewer still controls their own volume on top.
- **Sound on by default.** Viewers now start with the stream unmuted (with a one-click "sound" prompt if their browser blocks autoplay audio), and the volume slider finally shows *down* when it's actually muted.
- **Friendlier reactions.** The reaction control is now a clear **🤣 Reactions** button on both the viewer and broadcaster.

## 0.2.2 — 2026-07-04 — Hyprlab rebrand

- **New home.** The project has moved to the **Hyprlab** account on both GitHub and Docker Hub (`hyprlab/viibestream`) — update your image and clone URLs accordingly.
- **Refreshed About credit.** The **Settings → About** tab now shows the Hyprlab logo and links to [hyprlab.co](https://hyprlab.co).

## 0.2.1 — 2026-06-17 — Editable subheading

- **Editable subheading.** The **Settings → Branding** tab now has a *Subheading* field, so admins can set the short description that appears beneath the title in link previews and as the page description — no longer fixed text. Leave it blank to use the default.
- **Refreshed default subheading.** The out-of-the-box description is now "Self-hosted live streaming platform for watch parties."

## 0.2.0 — 2026-06-17 — Branding & link previews

- **Polished link previews.** Share the public link anywhere — chat apps, social media, messengers — and it now unfurls with a proper preview card (title, description, and a 1200×630 image) via OpenGraph and Twitter Card tags. The preview shows on the viewer, sign-in, and admin pages.
- **Brandable from the UI.** A new **Settings → Branding** tab (admins) lets you set the app title and upload your own share image — no file edits or redeploys. The title flows through the header, browser tab, and link previews; leave it blank to fall back to the default. A built-in default share image ships out of the box.
- **Swap or reset anytime.** Upload a JPEG, PNG, WebP, or GIF (up to 4 MB) and the new image goes live immediately, with cache-busting so social platforms re-fetch it. One click resets back to the bundled default.

## 0.1.0 — 2026-06-16 — First public release

- **Broadcast straight from your browser.** Sign in to the admin, point your camera and mic at the broadcaster page (or share a video file), and go live — no plugins, no native apps, no third-party services in the path.
- **Instant playback for viewers.** Anyone who opens the public page sees you live through MediaSource Extensions, with autoplay, mute/unmute, volume, fullscreen, a live viewer count, and a dark/light theme. Late-joiners get the stream's init segment first so they can join mid-flight.
- **Roles and user management.** Admin / streamer / viewer roles with a tight capability map. Admins manage users from **Settings → Users**; streamers can go live.
- **Secure by default.** bcrypt passwords, CSRF on every form, per-request Content-Security-Policy nonces, hardened session cookies, account lockout after repeated failed logins, and login rate limiting. An optional Cloudflare Turnstile captcha can be turned on from **Settings → Security**.
- **Docker-first.** Ships as a single Docker Compose service — one `docker compose up --build` and you're running.
