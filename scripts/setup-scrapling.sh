#!/usr/bin/env bash
# Optional local browser for JavaScript pages; run as root on the ASC server.
set -euo pipefail
if [[ $(id -u) -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
apt-get update
apt-get install -y python3-venv
python3 -m venv /opt/asc-scrapling
/opt/asc-scrapling/bin/python -m pip install --upgrade pip
/opt/asc-scrapling/bin/python -m pip install 'scrapling[fetchers]==0.4.15'
/opt/asc-scrapling/bin/python -m playwright install-deps chromium
# The Playwright Chromium CDN can return a regional 403. Its Chrome installer
# downloads Google's official Ubuntu/Debian package instead.
if ! command -v google-chrome-stable >/dev/null 2>&1 &&
   ! command -v chromium >/dev/null 2>&1; then
  /opt/asc-scrapling/bin/python -m playwright install chrome
fi
browser=$(command -v google-chrome-stable || command -v chromium || true)
if [[ -z "$browser" ]]; then
  echo 'No usable browser was installed. Scrapling cannot render JavaScript pages.' >&2
  exit 1
fi
"$browser" --version
/opt/asc-scrapling/bin/python - "$browser" <<'PY'
import sys
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=sys.argv[1])
    page = browser.new_page()
    page.goto('data:text/html,<title>ASC browser check</title>')
    assert page.title() == 'ASC browser check'
    browser.close()
print('Browser launch check passed.')
PY
echo 'Scrapling browser installed. Add WEB_FETCH_FALLBACK=scrapling and SCRAPLING_PYTHON=/opt/asc-scrapling/bin/python to /root/ASC/.env.'
echo 'Then restart asc and asc-web. Native HTTP fetching still runs first.'
echo 'Optional: set SCRAPLING_ALLOWED_HOSTS for extra CDN hosts a page needs.'
