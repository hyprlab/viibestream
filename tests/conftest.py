"""Shared Playwright fixtures.

Run against the already-running Docker container by default
(http://localhost:8080). Override with BASE_URL=... in the env.
"""
import os
import pytest


@pytest.fixture(scope="session")
def base_url() -> str:
    return os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")


@pytest.fixture(scope="session")
def admin_credentials() -> tuple[str, str]:
    return (
        os.environ.get("ADMIN_USERNAME", "admin"),
        os.environ.get("ADMIN_PASSWORD", "admin"),
    )


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """Default context: emulate a desktop viewport.

    `extra_http_headers` injects the X-Forwarded-Proto header on every
    request so the app's ProxyFix treats the test traffic as HTTPS.
    Without this, BEHIND_HTTPS_PROXY=1 + CSRF SSL strict would reject
    our form posts with 400 even though we're talking to plain http.
    """
    return {
        **browser_context_args,
        "viewport": {"width": 1280, "height": 800},
        "ignore_https_errors": True,
        "extra_http_headers": {
            "X-Forwarded-Proto": "https",
            "X-Forwarded-For": "127.0.0.1",
        },
    }


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args):
    """Inject fake camera/mic so broadcaster tests work headless.

    Chromium honors --use-fake-ui-for-media-stream (auto-grants the prompt)
    and --use-fake-device-for-media-stream (a built-in test pattern + tone).
    Firefox uses media.navigator.streams.fake via the prefs context arg
    — see test_stream.py for that case.
    """
    return {
        **browser_type_launch_args,
        "args": [
            *(browser_type_launch_args.get("args") or []),
            "--use-fake-ui-for-media-stream",
            "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
        ],
    }


@pytest.fixture
def admin_page(page, base_url, admin_credentials):
    """Log in as admin and return the authenticated page."""
    username, password = admin_credentials
    page.goto(f"{base_url}/auth/login")
    page.fill('input[name="username"]', username)
    page.fill('input[name="password"]', password)
    page.click('button[type="submit"]')
    page.wait_for_url(f"{base_url}/admin/**", timeout=10_000)
    return page
