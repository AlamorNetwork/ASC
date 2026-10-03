"""One-page dynamic rendering bridge. JSON on stdout, errors on stderr."""
import ipaddress
import fcntl
import json
import socket
import sys
from pathlib import Path
from urllib.parse import urlparse


def permitted(value, allowed):
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or host not in allowed or parsed.username or parsed.password:
        return False
    try:
        return all(ipaddress.ip_address(result[4][0]).is_global
                   for result in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80)))
    except (OSError, ValueError):
        return False


def main():
    url = sys.argv[1]
    allowed = set(sys.argv[2].split(','))
    allowed.add((urlparse(url).hostname or '').lower())
    if not permitted(url, allowed):
        raise ValueError("URL is not an allowed public site")

    from scrapling.fetchers import DynamicFetcher

    captured = {}

    def before(page):
        def route_request(route):
            if permitted(route.request.url, allowed):
                route.continue_()
            else:
                route.abort()
        page.route("**/*", route_request)

    def after(page):
        captured["url"] = page.url
        captured["html"] = page.content()

    with open(Path(sys.prefix) / 'asc-browser.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError('local browser is busy; retry this page later') from exc
        DynamicFetcher.fetch(url, headless=True, timeout=15000, wait=1000,
                             disable_resources=True, google_search=False,
                             page_setup=before, page_action=after)
    if not permitted(captured.get("url", ""), allowed):
        raise ValueError("browser left the allowed site")
    print(json.dumps(captured, ensure_ascii=False))


if __name__ == "__main__":
    main()
