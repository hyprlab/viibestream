"""Backend admin pages — served under /admin."""
from flask import (
    Blueprint, abort, flash, jsonify, redirect, render_template, request, url_for,
)
from flask_login import current_user, login_required

from ..auth.forms import CreateUserForm, EditUserForm
from ..auth.permissions import admin_required, permission_required
from ..extensions import db, socketio
from flask import Response

from ..models import Role, SavedShowing, User
from ..stream import info as info_module
from ..stream.info import stream_info, ALLOWED_POSTER_MIMES, POSTER_MAX_BYTES
from ..stream.state import broadcast_state

bp = Blueprint("admin", __name__)


@bp.before_request
@login_required
def _require_login():
    # Inactive users can never access admin even if their session is valid.
    if not current_user.is_active:
        abort(403)
    # A user flagged for a forced password reset can't touch any admin
    # page until they've chosen a new password. The reset page lives in
    # the auth blueprint, so it isn't gated by this hook (no redirect loop).
    if getattr(current_user, "must_change_password", False):
        return redirect(url_for("auth.force_reset"))


@bp.route("/")
def dashboard():
    return render_template(
        "admin/dashboard.html",
        page="dashboard",
        broadcast=broadcast_state.snapshot(),
    )


@bp.route("/stream")
@permission_required("stream.broadcast")
def stream():
    from ..chat.state import CHAT_EMOJIS
    return render_template(
        "admin/stream.html",
        page="stream",
        broadcast=broadcast_state.snapshot(),
        chat_emojis=CHAT_EMOJIS,
    )


# ── User management ─────────────────────────────────────────────────────────


@bp.context_processor
def _inject_settings_users():
    """Feed the Users + Security tabs of the settings modal (included on
    every admin page via base_admin.html). Admins only — for everyone else
    the tabs are hidden, so no query runs."""
    if not (current_user.is_authenticated and current_user.is_admin()):
        return {}
    from ..app_settings import get_settings
    row = get_settings()
    return {
        "settings_users": User.query.order_by(User.created_at.asc()).all(),
        "settings_create_form": CreateUserForm(),
        "settings_turnstile": row,
        "settings_branding": row,
    }


@bp.route("/settings/turnstile", methods=["POST"])
@admin_required
def save_turnstile():
    """Persist the Cloudflare Turnstile login-captcha config from the
    Settings → Security tab and apply it live."""
    from ..app_settings import get_settings, apply_turnstile_config
    row = get_settings()
    row.turnstile_enabled = bool(request.form.get("turnstile_enabled"))
    row.turnstile_site_key = (request.form.get("turnstile_site_key") or "").strip()[:120]
    # Secret is write-only in the UI: only overwrite when a new value is given
    # (blank means "keep the current secret").
    secret = (request.form.get("turnstile_secret_key") or "").strip()
    if secret:
        row.turnstile_secret_key = secret[:120]
    db.session.commit()
    apply_turnstile_config()
    flash("Turnstile settings saved.", "success")
    return redirect(request.referrer or url_for("admin.dashboard"))


@bp.route("/settings/branding", methods=["POST"])
@admin_required
def save_branding():
    """Persist the app title and OpenGraph share image from the
    Settings → Branding tab and apply the new title live."""
    import hashlib
    from ..app_settings import get_settings, apply_branding_config

    row = get_settings()
    row.app_title = (request.form.get("app_title") or "").strip()[:120]

    if request.form.get("reset_og_image") == "1":
        # Drop the custom image — the bundled default takes over.
        row.og_image_bytes = None
        row.og_image_mime = None
        row.og_image_etag = ""
    else:
        f = request.files.get("og_image")
        if f and f.filename:
            data = f.read()
            if len(data) > POSTER_MAX_BYTES:
                flash(
                    f"Share image is larger than the "
                    f"{POSTER_MAX_BYTES // (1024 * 1024)} MB limit.",
                    "error",
                )
                return redirect(request.referrer or url_for("admin.dashboard"))
            mime = (f.mimetype or "").lower()
            if mime not in ALLOWED_POSTER_MIMES:
                flash("Share image must be JPEG, PNG, WebP, or GIF.", "error")
                return redirect(request.referrer or url_for("admin.dashboard"))
            row.og_image_bytes = data
            row.og_image_mime = mime
            # The etag doubles as the cache-busting version in the og:image URL.
            row.og_image_etag = hashlib.sha1(data).hexdigest()[:16]

    db.session.commit()
    apply_branding_config()
    flash("Branding saved.", "success")
    return redirect(request.referrer or url_for("admin.dashboard"))


def _users_redirect():
    """Return to the page the user action was triggered from (the settings
    modal lives on every admin page), falling back to the dashboard."""
    return redirect(request.referrer or url_for("admin.dashboard"))


@bp.route("/users/new", methods=["POST"])
@admin_required
def create_user():
    form = CreateUserForm()
    if not form.validate_on_submit():
        for errs in form.errors.values():
            for err in errs:
                flash(err, "error")
        return _users_redirect()

    username = form.username.data.strip()
    email = form.email.data.strip().lower()
    if User.query.filter(
        (User.username == username) | (User.email == email)
    ).first():
        flash("Username or email already in use.", "error")
        return _users_redirect()
    try:
        user = User(
            username=username,
            email=email,
            role=Role(form.role.data),
            is_active=True,
            must_change_password=bool(form.must_change_password.data),
        )
        user.set_password(form.password.data, enforce_policy=False)
        db.session.add(user)
        db.session.commit()
        flash(f"Created {user.username}.", "success")
    except ValueError as exc:
        db.session.rollback()
        flash(str(exc), "error")
    return _users_redirect()


@bp.route("/users/<int:user_id>", methods=["POST"])
@admin_required
def edit_user(user_id: int):
    user = db.session.get(User, user_id)
    if not user:
        abort(404)
    form = EditUserForm()
    if not form.validate_on_submit():
        for errs in form.errors.values():
            for err in errs:
                flash(err, "error")
        return _users_redirect()

    # Prevent self-demotion lockout: an admin editing themselves can't
    # downgrade their own role or deactivate themselves.
    if user.id == current_user.id:
        if form.role.data != Role.ADMIN.value or not form.is_active.data:
            flash("You can't change your own role or deactivate yourself.", "error")
            return _users_redirect()

    # Don't allow removing the last admin.
    if user.role == Role.ADMIN and form.role.data != Role.ADMIN.value:
        remaining = User.query.filter(
            User.role == Role.ADMIN, User.is_active.is_(True), User.id != user.id
        ).count()
        if remaining == 0:
            flash("Refusing to demote the last active admin.", "error")
            return _users_redirect()

    try:
        user.email = form.email.data.strip().lower()
        user.role = Role(form.role.data)
        user.is_active = bool(form.is_active.data)
        if form.new_password.data:
            user.set_password(form.new_password.data, enforce_policy=False)
        db.session.commit()
        flash(f"Updated {user.username}.", "success")
    except ValueError as exc:
        db.session.rollback()
        flash(str(exc), "error")
    return _users_redirect()


@bp.route("/users/<int:user_id>/unlock", methods=["POST"])
@admin_required
def unlock_user(user_id: int):
    """Clear a failed-login lockout so the user can sign in again."""
    user = db.session.get(User, user_id)
    if not user:
        abort(404)
    user.unlock()
    db.session.commit()
    flash(f"Unlocked {user.username}.", "success")
    return _users_redirect()


@bp.route("/users/<int:user_id>/delete", methods=["POST"])
@admin_required
def delete_user(user_id: int):
    user = db.session.get(User, user_id)
    if not user:
        abort(404)
    if user.id == current_user.id:
        flash("You can't delete your own account.", "error")
        return _users_redirect()
    if user.role == Role.ADMIN:
        remaining = User.query.filter(
            User.role == Role.ADMIN, User.is_active.is_(True), User.id != user.id
        ).count()
        if remaining == 0:
            flash("Refusing to delete the last active admin.", "error")
            return _users_redirect()
    db.session.delete(user)
    db.session.commit()
    flash(f"Deleted {user.username}.", "success")
    return _users_redirect()


# ── Stream info (Now Showing) ──────────────────────────────────────────────


@bp.route("/info", methods=["POST"])
@permission_required("stream.broadcast")
def update_info():
    """Update the title/description/IMDB URL and optionally swap the
    poster. Returns JSON so the broadcaster's JS can show inline
    feedback without a full page reload."""
    title = request.form.get("title", "")
    description = request.form.get("description", "")
    imdb_url = request.form.get("imdb_url", "")
    trailer_url = request.form.get("trailer_url", "")
    clear_poster = request.form.get("clear_poster") == "1"

    changed = stream_info.update_text(title, description, imdb_url, trailer_url)

    poster_changed = False
    if clear_poster:
        poster_changed = stream_info.clear_poster()
    else:
        poster_file = request.files.get("poster")
        if poster_file and poster_file.filename:
            data = poster_file.read()
            if len(data) > POSTER_MAX_BYTES:
                return jsonify({
                    "ok": False,
                    "error": f"Poster is larger than the {POSTER_MAX_BYTES // (1024 * 1024)} MB limit.",
                }), 400
            mime = (poster_file.mimetype or "").lower()
            if mime not in ALLOWED_POSTER_MIMES:
                return jsonify({
                    "ok": False,
                    "error": "Poster must be JPEG, PNG, WebP, or GIF.",
                }), 400
            poster_changed = stream_info.set_poster(data, mime)
            if not poster_changed:
                return jsonify({"ok": False, "error": "Could not store poster."}), 400

    info = stream_info.public()
    if changed or poster_changed:
        # Persist so it survives a restart, then push to viewers live.
        info_module.persist()
        socketio.emit("stream:info", info)
    return jsonify({"ok": True, "info": info})


@bp.route("/info/clear", methods=["POST"])
@permission_required("stream.broadcast")
def clear_info():
    """Explicitly clear the Now Showing — the only way it goes away.
    Wipes the in-memory state + the persisted row and tells viewers."""
    stream_info.clear()
    info_module.persist()
    info = stream_info.public()
    socketio.emit("stream:info", info)
    return jsonify({"ok": True, "info": info})


# ── Saved showings library ───────────────────────────────────────────


def _showing_or_404(showing_id: int) -> SavedShowing:
    s = db.session.get(SavedShowing, showing_id)
    if not s:
        abort(404)
    return s


def _apply_form_to(target_obj, *, accept_poster: bool):
    """Pull title/description/url fields off the multipart form and
    apply them to the given SavedShowing or to stream_info via the
    same code path used by /admin/info. Returns (ok, error_message)."""
    target_obj.title = (request.form.get("title", "") or "").strip()[:200]
    target_obj.description = (request.form.get("description", "") or "").strip()[:2000]
    raw_imdb = (request.form.get("imdb_url", "") or "").strip()
    raw_trailer = (request.form.get("trailer_url", "") or "").strip()
    target_obj.imdb_url = raw_imdb if raw_imdb.startswith(("http://", "https://")) else ""
    target_obj.trailer_url = raw_trailer if raw_trailer.startswith(("http://", "https://")) else ""

    if not accept_poster:
        return (True, None)

    if request.form.get("clear_poster") == "1":
        target_obj.poster_bytes = None
        target_obj.poster_mime = None
        return (True, None)

    f = request.files.get("poster")
    if f and f.filename:
        data = f.read()
        if len(data) > POSTER_MAX_BYTES:
            return (False, "Poster is larger than the 4 MB limit.")
        mime = (f.mimetype or "").lower()
        if mime not in ALLOWED_POSTER_MIMES:
            return (False, "Poster must be JPEG, PNG, WebP, or GIF.")
        target_obj.poster_bytes = data
        target_obj.poster_mime = mime
    return (True, None)


@bp.route("/info/library", methods=["GET"])
@permission_required("stream.broadcast")
def list_showings():
    """Return all saved Now-Showing presets, newest first."""
    items = (
        SavedShowing.query.order_by(SavedShowing.updated_at.desc()).all()
    )
    return jsonify({"items": [s.public() for s in items]})


@bp.route("/info/library", methods=["POST"])
@permission_required("stream.broadcast")
def save_showing():
    """Save a new preset from the multipart form data the broadcaster
    has in their Now Showing form. Returns the created row."""
    s = SavedShowing(created_by_id=current_user.id)
    ok, err = _apply_form_to(s, accept_poster=True)
    if not ok:
        return jsonify({"ok": False, "error": err}), 400

    # If the form didn't include a fresh poster AND the operator
    # didn't ask to clear it, snapshot the currently-published poster
    # into the preset. Otherwise "Save current" after a publish would
    # silently lose the image (the file input is cleared post-publish).
    if not s.poster_bytes and request.form.get("clear_poster") != "1":
        current = stream_info.poster()
        if current:
            data, mime, _ = current
            s.poster_bytes = data
            s.poster_mime = mime

    if not s.title:
        return jsonify({"ok": False, "error": "A preset needs a title."}), 400
    db.session.add(s)
    db.session.commit()
    return jsonify({"ok": True, "showing": s.public()})


@bp.route("/info/library/<int:showing_id>", methods=["PUT"])
@permission_required("stream.broadcast")
def update_showing(showing_id: int):
    """Update an existing preset with the current form contents.
    Same multipart-form shape as POST /info/library. Poster behavior:
    leaving the file input empty preserves the existing poster; passing
    clear_poster=1 removes it; uploading a new file replaces it."""
    s = _showing_or_404(showing_id)
    ok, err = _apply_form_to(s, accept_poster=True)
    if not ok:
        return jsonify({"ok": False, "error": err}), 400
    if not s.title:
        return jsonify({"ok": False, "error": "A preset needs a title."}), 400
    db.session.commit()
    return jsonify({"ok": True, "showing": s.public()})


@bp.route("/info/library/<int:showing_id>", methods=["DELETE"])
@permission_required("stream.broadcast")
def delete_showing(showing_id: int):
    s = _showing_or_404(showing_id)
    db.session.delete(s)
    db.session.commit()
    return jsonify({"ok": True})


@bp.route("/info/library/<int:showing_id>/poster", methods=["GET"])
@permission_required("stream.broadcast")
def showing_poster(showing_id: int):
    s = _showing_or_404(showing_id)
    if not s.poster_bytes:
        abort(404)
    return Response(
        s.poster_bytes,
        mimetype=s.poster_mime or "image/jpeg",
        headers={"Cache-Control": "private, max-age=300"},
    )


@bp.route("/info/library/<int:showing_id>/load", methods=["POST"])
@permission_required("stream.broadcast")
def load_showing(showing_id: int):
    """Apply a saved preset to the live StreamInfo so viewers see it."""
    s = _showing_or_404(showing_id)
    stream_info.update_text(s.title, s.description, s.imdb_url, s.trailer_url)
    if s.poster_bytes and s.poster_mime:
        stream_info.set_poster(s.poster_bytes, s.poster_mime)
    else:
        stream_info.clear_poster()
    info = stream_info.public()
    info_module.persist()
    socketio.emit("stream:info", info)
    # Include the preset's public snapshot so the broadcaster JS knows
    # which preset is now loaded (enables Update mode on the bottom
    # button).
    return jsonify({"ok": True, "info": info, "showing": s.public()})
