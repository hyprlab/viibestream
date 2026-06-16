"""Singleton Flask extension instances.

Keeping these in their own module avoids circular imports — blueprints,
models, and event handlers can all import from `app.extensions` without
pulling in the factory.
"""
from flask_login import LoginManager
from flask_socketio import SocketIO
from flask_sqlalchemy import SQLAlchemy
from flask_wtf.csrf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_migrate import Migrate


db = SQLAlchemy()
migrate = Migrate()
login_manager = LoginManager()
csrf = CSRFProtect()
limiter = Limiter(key_func=get_remote_address)
# async_mode is set at init_app time so we can pick eventlet in prod and
# threading in tests without bouncing imports.
socketio = SocketIO(cors_allowed_origins="*", async_mode="eventlet")
