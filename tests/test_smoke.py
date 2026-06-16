"""Smoke tests: verify each route renders and the login flow works."""
import re

import pytest


def test_healthz(page, base_url):
    resp = page.request.get(f"{base_url}/healthz")
    assert resp.status == 200
    assert resp.json()["ok"] is True


def test_viewer_loads(page, base_url):
    page.goto(f"{base_url}/")
    assert "Viibestream" in page.title()
    # Player video element exists and the live indicator is rendered.
    assert page.locator("#player").count() == 1
    assert page.locator("#live-label").count() == 1


def test_login_page_renders(page, base_url):
    page.goto(f"{base_url}/auth/login")
    assert page.locator('input[name="username"]').is_visible()
    assert page.locator('input[name="password"]').is_visible()


def test_admin_requires_login(page, base_url):
    page.goto(f"{base_url}/admin/")
    # Redirected to /auth/login because of @login_required.
    page.wait_for_url(re.compile(r".*/auth/login.*"))


def test_admin_login_and_dashboard(admin_page, base_url):
    """admin_page fixture already logged us in — assert we landed on the dashboard."""
    assert admin_page.url.startswith(f"{base_url}/admin")
    assert admin_page.locator("h1").inner_text().strip() == "Dashboard"
    # Sidebar footer shows the username.
    assert admin_page.locator(".u-name").first.inner_text().strip() == "admin"


def test_settings_modal_opens(admin_page):
    """Click the gear in the sidebar footer → modal pops with blurred backdrop."""
    admin_page.locator(
        '.sidebar-footer [data-open-modal="settings-modal"]'
    ).first.click()
    modal = admin_page.locator("#settings-modal")
    modal.wait_for(state="visible")
    assert modal.locator(".modal-backdrop").count() == 1
    # Backdrop applies a blur — make sure the CSS is wired up.
    blur = admin_page.evaluate(
        "() => getComputedStyle(document.querySelector("
        "'#settings-modal .modal-backdrop'))['backdrop-filter']"
    )
    assert "blur" in (blur or "")


def test_theme_toggle_persists(admin_page):
    html = admin_page.locator("html")
    initial = html.get_attribute("data-theme")
    admin_page.locator("#theme-toggle").click()
    after = html.get_attribute("data-theme")
    assert after != initial
    # And it was persisted to localStorage so a reload keeps it.
    stored = admin_page.evaluate("() => localStorage.getItem('vbs-theme')")
    assert stored == after


def test_csrf_blocks_unauth_post(page, base_url):
    """A POST without a CSRF token must be rejected."""
    resp = page.request.post(
        f"{base_url}/auth/login",
        data={"username": "admin", "password": "admin"},
        fail_on_status_code=False,
    )
    assert resp.status == 400
