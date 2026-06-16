"""Login / logout / password change."""
import json
import urllib.parse
import urllib.request

import bcrypt
from flask import (
    Blueprint, current_app, flash, redirect, render_template, request, url_for,
)
from flask_login import current_user, login_required, login_user, logout_user

from ..extensions import db, limiter
from ..models import User
from .forms import ChangePasswordForm, LoginForm

bp = Blueprint("auth", __name__)

# A throwaway bcrypt hash used to burn comparable CPU time when the submitted
# username doesn't exist, so an attacker can't tell "no such user" from "wrong
# password" by timing. Computed once at import (same cost factor as real
# password hashes).
_DUMMY_HASH = bcrypt.hashpw(b"timing-equalizer", bcrypt.gensalt(rounds=12))

_TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def _client_ip() -> str:
    """Leftmost X-Forwarded-For entry, else the socket peer."""
    xff = request.headers.get("X-Forwarded-For", "")
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return request.remote_addr or ""


def _verify_turnstile(token: str) -> bool:
    """Validate a Cloudflare Turnstile token server-side. Returns True when
    Turnstile isn't configured (feature off). Fails closed on any error."""
    secret = current_app.config.get("TURNSTILE_SECRET_KEY")
    if not secret:
        return True  # not configured — challenge disabled
    if not token:
        return False
    data = urllib.parse.urlencode({
        "secret": secret,
        "response": token,
        "remoteip": _client_ip(),
    }).encode()
    try:
        req = urllib.request.Request(_TURNSTILE_VERIFY_URL, data=data)
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = json.loads(resp.read().decode("utf-8"))
        return bool(result.get("success"))
    except Exception:  # network / parse error → fail closed
        current_app.logger.warning("Turnstile verification failed", exc_info=True)
        return False


def _safe_next(target: str | None) -> str | None:
    """Allow only same-host relative redirects to avoid open-redirect abuse."""
    if not target:
        return None
    # Must be a path on this host. Reject anything that looks absolute or
    # protocol-relative.
    if target.startswith(("http://", "https://", "//", "\\\\")):
        return None
    if not target.startswith("/"):
        return None
    return target


@bp.route("/login", methods=["GET", "POST"])
@limiter.limit("10 per minute; 50 per hour", methods=["POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("admin.dashboard"))

    site_key = current_app.config.get("TURNSTILE_SITE_KEY")

    form = LoginForm()
    if form.validate_on_submit():
        # Verify the Turnstile challenge before touching credentials (no-op
        # when Turnstile isn't configured).
        if not _verify_turnstile(request.form.get("cf-turnstile-response", "")):
            flash("Captcha verification failed. Please try again.", "error")
            return render_template("auth/login.html", form=form, turnstile_site_key=site_key)

        user = User.query.filter_by(username=form.username.data.strip()).first()

        # A lock that's already elapsed gets cleared here so the user starts a
        # fresh window of attempts instead of re-locking on the first try.
        if user:
            user.clear_expired_lock()

        # Lockout is checked first because a locked account should always say
        # "locked" rather than letting a brute-force learn from error timing.
        if user and user.is_locked:
            db.session.commit()
            flash(
                "Account locked after 5 failed attempts. Try again in 24 hours "
                "or ask an administrator to unlock it.",
                "error",
            )
        elif user and user.is_active and user.check_password(form.password.data):
            user.register_successful_login()
            db.session.commit()
            login_user(user, remember=form.remember.data)
            nxt = _safe_next(request.args.get("next"))
            return redirect(nxt or url_for("admin.dashboard"))
        else:
            if user:
                user.register_failed_login()
                db.session.commit()
            else:
                # No such user — still spend ~one bcrypt's worth of time so the
                # response timing matches the wrong-password path.
                bcrypt.checkpw(b"timing-equalizer", _DUMMY_HASH)
            flash("Invalid credentials.", "error")
    return render_template("auth/login.html", form=form, turnstile_site_key=site_key)


@bp.route("/logout", methods=["POST", "GET"])
@login_required
def logout():
    logout_user()
    return redirect(url_for("main.viewer"))


@bp.route("/password", methods=["POST"])
@login_required
def change_password():
    """Self-service password change from the Settings → Profile tab. Requires
    the current password; any signed-in user can change their own."""
    form = ChangePasswordForm()
    if form.validate_on_submit():
        if not current_user.check_password(form.current_password.data):
            flash("Current password is incorrect.", "error")
        else:
            try:
                current_user.set_password(form.new_password.data)
                current_user.must_change_password = False
                db.session.commit()
                flash("Password updated.", "success")
            except ValueError as exc:
                flash(str(exc), "error")
    else:
        for errs in form.errors.values():
            for err in errs:
                flash(err, "error")
    return redirect(request.referrer or url_for("admin.dashboard"))


@bp.route("/force-reset", methods=["GET", "POST"])
@login_required
def force_reset():
    """Full-page password reset shown the first time a flagged account
    (the bootstrap admin, or a pre-existing admin) signs in. The admin
    area redirects here until `must_change_password` is cleared."""
    # Nothing to do if they're not actually flagged — don't strand anyone
    # on this page.
    if not getattr(current_user, "must_change_password", False):
        return redirect(url_for("admin.dashboard"))

    form = ChangePasswordForm()
    if form.validate_on_submit():
        if not current_user.check_password(form.current_password.data):
            flash("Current password is incorrect.", "error")
        elif current_user.check_password(form.new_password.data):
            flash("Choose a password different from your current one.", "error")
        else:
            try:
                current_user.set_password(form.new_password.data)
                current_user.must_change_password = False
                db.session.commit()
                flash("Password updated. You're all set.", "success")
                return redirect(url_for("admin.dashboard"))
            except ValueError as exc:
                flash(str(exc), "error")
    else:
        for errs in form.errors.values():
            for err in errs:
                flash(err, "error")
    return render_template("auth/force_reset.html", form=form)
