"""Public viewer page served at /."""
import os

from flask import (
    Blueprint, Response, abort, current_app, jsonify, render_template,
    send_file, url_for,
)

from ..chat.state import CHAT_EMOJIS
from ..stream.info import stream_info
from ..stream.state import broadcast_state

bp = Blueprint("main", __name__)

# OpenGraph descriptions get truncated by every platform anyway — cap ours
# so the meta tag doesn't carry the full 2000-char synopsis.
_OG_DESC_MAX = 300


def _viewer_og_context() -> dict:
    """OpenGraph overrides for the shared public link. When a Now Showing
    entry is set, the link preview carries the movie's title, description,
    and poster instead of the default branding; each field falls back
    independently (e.g. no poster → branding image, movie title kept).
    Returned kwargs override the context processor's defaults
    (app/__init__.py::_register_template_globals). Now Showing data is
    already public via /api/info and /poster, so this exposes nothing new."""
    info = stream_info.public()
    ctx: dict = {}
    title = (info.get("title") or "").strip()
    # Collapse whitespace/newlines — this lands inside a meta attribute.
    desc = " ".join((info.get("description") or "").split())
    if title:
        ctx["og_title"] = title
    if desc:
        if len(desc) > _OG_DESC_MAX:
            desc = desc[: _OG_DESC_MAX - 1].rstrip() + "…"
        ctx["og_description"] = desc
    if info.get("has_poster"):
        # v= mirrors the poster etag so platforms re-crawl a swapped poster.
        ctx["og_image_url"] = url_for(
            "main.poster", v=info.get("poster_etag") or "", _external=True,
        )
        # Tells _meta_og.html to drop the 1200×630 size hints (posters are
        # portrait) and to alt-text the image with the title.
        ctx["og_image_is_poster"] = True
    return ctx


@bp.route("/")
def viewer():
    return render_template(
        "public/viewer.html",
        broadcast=broadcast_state.snapshot(),
        chat_emojis=CHAT_EMOJIS,
        **_viewer_og_context(),
    )


# ── Stream metadata (Now Showing) ──────────────────────────────────────


@bp.route("/api/info")
def api_info():
    """Public JSON: title, description, IMDB URL, poster presence.
    Poster bytes themselves are served separately by /poster."""
    return jsonify(stream_info.public())


@bp.route("/og-image")
def og_image():
    """Serve the OpenGraph / social-share image. Returns the operator's
    uploaded image when one is set (Settings → Branding), otherwise the
    bundled default. The ``?v=`` query param is a cache-buster only — the
    response is the same regardless of its value."""
    from ..app_settings import get_settings

    row = get_settings()
    if row.og_image_bytes and row.og_image_mime:
        headers = {"Cache-Control": "public, max-age=300"}
        if row.og_image_etag:
            headers["ETag"] = '"' + row.og_image_etag + '"'
        return Response(row.og_image_bytes, mimetype=row.og_image_mime, headers=headers)

    path = os.path.join(current_app.static_folder, "img", "og-image.webp")
    if not os.path.exists(path):
        abort(404)
    return send_file(path, mimetype="image/webp", max_age=86400)


@bp.route("/poster")
def poster():
    data = stream_info.poster()
    if not data:
        abort(404)
    bytes_, mime, etag = data
    return Response(
        bytes_,
        mimetype=mime or "image/jpeg",
        headers={
            "ETag": '"' + etag + '"' if etag else "",
            # Short cache — the poster can be rotated mid-broadcast and
            # we surface that via the etag-changing URL in JS.
            "Cache-Control": "public, max-age=60",
        },
    )
