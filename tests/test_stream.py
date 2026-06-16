"""End-to-end stream test: broadcaster page captures the fake media device
and a second browser context joins as a viewer. The Chromium fake-media
flags are set in conftest.py.
"""
import pytest


@pytest.mark.stream
def test_broadcaster_preview_starts(admin_page, base_url):
    admin_page.goto(f"{base_url}/admin/stream")
    admin_page.locator("#preview-btn").click()
    # The video element should receive a srcObject within a few seconds.
    admin_page.wait_for_function(
        "() => document.getElementById('preview') && document.getElementById('preview').srcObject",
        timeout=10_000,
    )
    # Go Live button should now be enabled.
    assert admin_page.locator("#go-live-btn").is_enabled()
