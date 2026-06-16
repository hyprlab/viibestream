"""Public viewer page served at /."""
from flask import Blueprint, Response, abort, jsonify, render_template

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
