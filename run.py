"""Gunicorn / dev entrypoint.

`gunicorn run:app` works because Flask-SocketIO patches the WSGI app so the
eventlet worker can handle both HTTP and websocket upgrades on the same port.
For local dev, `python run.py` uses the Socket.IO dev server.
"""
import os

from app import create_app, socketio

app = create_app()

if __name__ == "__main__":
    socketio.run(
        app,
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        debug=app.config.get("DEBUG", False),
        allow_unsafe_werkzeug=False,
    )
