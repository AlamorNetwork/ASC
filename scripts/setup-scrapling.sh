#!/usr/bin/env bash
# Optional local browser for JavaScript pages; run as root on the ASC server.
set -euo pipefail
if [[ $(id -u) -ne 0 ]]; then echo 'Run as root.' >&2; exit 1; fi
apt-get update
apt-get install -y python3-venv
python3 -m venv /opt/asc-scrapling
/opt/asc-scrapling/bin/python -m pip install --upgrade pip
/opt/asc-scrapling/bin/python -m pip install 'scrapling[fetchers]==0.4.15'
/opt/asc-scrapling/bin/python -m playwright install --with-deps chromium
echo 'Scrapling ready. Add WEB_FETCH_FALLBACK=scrapling and SCRAPLING_PYTHON=/opt/asc-scrapling/bin/python to /root/ASC/.env.'
echo 'Optional: set SCRAPLING_ALLOWED_HOSTS for extra CDN hosts a page needs.'
