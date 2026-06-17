"""Public viewer page served at /."""
import os

from flask import (
    Blueprint, Response, abort, current_app, jsonify, render_template, send_file,
)

from ..chat.state import CHAT_EMOJIS
from ..stream.info import stream_info
from ..stream.state import broadcast_state

bp = Blueprint("main", __name__)


@bp.route("/")
def viewer():
    return render_template(
        "public/viewer.html",
        broadcast=broadcast_state.snapshot(),
        chat_emojis=CHAT_EMOJIS,
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
