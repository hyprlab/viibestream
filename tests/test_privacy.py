"""Verify the running app makes zero third-party requests.

Listens to every request the browser fires for the viewer, login, and
admin pages and fails the test if any of them target a host other than
ours.
"""
from urllib.parse import urlparse


def _own_host(base_url: str) -> str:
    return urlparse(base_url).hostname


def _record_third_party(page, base_url):
    own = _own_host(base_url)
    third_party: list[str] = []

    def _on_request(request):
        host = urlparse(request.url).hostname
        # data: / blob: / about: have no hostname — ignore.
        if host and host != own:
            third_party.append(request.url)

    page.on("request", _on_request)
    return third_party


def test_viewer_page_has_no_third_party_requests(page, base_url):
    third_party = _record_third_party(page, base_url)
    page.goto(f"{base_url}/", wait_until="networkidle")
    assert not third_party, f"Third-party requests on /: {third_party}"


def test_login_page_has_no_third_party_requests(page, base_url):
    third_party = _record_third_party(page, base_url)
    page.goto(f"{base_url}/auth/login", wait_until="networkidle")
    assert not third_party, f"Third-party requests on /auth/login: {third_party}"


def test_admin_dashboard_has_no_third_party_requests(admin_page, base_url):
    third_party: list[str] = []
    own = _own_host(base_url)

    def _on_request(request):
        host = urlparse(request.url).hostname
        if host and host != own:
            third_party.append(request.url)

    admin_page.on("request", _on_request)
    admin_page.goto(f"{base_url}/admin/", wait_until="networkidle")
    assert not third_party, f"Third-party requests on /admin/: {third_party}"


def test_broadcaster_page_has_no_third_party_requests(admin_page, base_url):
    third_party: list[str] = []
    own = _own_host(base_url)

    def _on_request(request):
        host = urlparse(request.url).hostname
        if host and host != own:
            third_party.append(request.url)

    admin_page.on("request", _on_request)
    admin_page.goto(f"{base_url}/admin/stream", wait_until="networkidle")
    assert not third_party, f"Third-party requests on /admin/stream: {third_party}"
