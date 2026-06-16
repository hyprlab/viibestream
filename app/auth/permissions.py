"""Authorization decorators used by HTTP routes and Socket.IO handlers."""
from functools import wraps

from flask import abort
from flask_login import current_user


def permission_required(perm: str):
    """Require an authenticated user with `perm`. Aborts 403 otherwise.

    Anonymous users are bounced to the login page by @login_required, which
    must be applied first (closer to the function). We don't combine them
    here so the order is explicit at each call site.
    """
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            if not current_user.is_authenticated:
                abort(401)
            if not current_user.is_active:
                abort(403)
            if not current_user.has_permission(perm):
                abort(403)
            return fn(*args, **kwargs)
        return wrapper
    return decorator


def admin_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not current_user.is_authenticated:
            abort(401)
        if not current_user.is_admin() or not current_user.is_active:
            abort(403)
        return fn(*args, **kwargs)
    return wrapper
