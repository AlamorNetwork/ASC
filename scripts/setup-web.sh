#!/usr/bin/env bash
# Deploy ASC's private web workspace on a separate domain from 9router.
# Usage: bash scripts/setup-web.sh asc.alamornetwork.ir you@example.com
set -euo pipefail
trap 'echo "setup-web stopped at line $LINENO" >&2' ERR

DOMAIN="${1:-asc.alamornetwork.ir}"
EMAIL="${2:-}"
PORT="${WEB_HTTPS_PORT:-443}"
PUBLIC_PORT="${WEB_PUBLIC_PORT:-443}"
DIR="${ASC_DIR:-/root/ASC}"
CREDS=/etc/letsencrypt/cloudflare.ini
LIVE="/etc/letsencrypt/live/$DOMAIN"

if [ "$(id -u)" -ne 0 ]; then echo 'Run as root.' >&2; exit 1; fi
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ && "$PORT" =~ ^[0-9]+$ && "$PUBLIC_PORT" =~ ^[0-9]+$ ]]; then echo 'Invalid domain or port.' >&2; exit 1; fi
if [ ! -f "$DIR/.env" ]; then echo "Missing $DIR/.env" >&2; exit 1; fi

if [ ! -f "$LIVE/fullchain.pem" ] || ! openssl x509 -in "$LIVE/fullchain.pem" -noout -checkend 604800 >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-dns-cloudflare
  if [ -n "${CF_TOKEN:-}" ]; then
    install -d -m 755 /etc/letsencrypt
    umask 077
    printf 'dns_cloudflare_api_token = %s\n' "$CF_TOKEN" > "$CREDS"
  elif [ ! -f "$CREDS" ]; then
    echo 'Set CF_TOKEN or create /etc/letsencrypt/cloudflare.ini first.' >&2; exit 1
  fi
  chmod 600 "$CREDS"
  ACCOUNT=(--non-interactive --agree-tos)
  if [ -n "$EMAIL" ]; then ACCOUNT+=(-m "$EMAIL"); else ACCOUNT+=(--register-unsafely-without-email); fi
  certbot certonly --authenticator dns-cloudflare --dns-cloudflare-credentials "$CREDS" \
    --dns-cloudflare-propagation-seconds 30 -d "$DOMAIN" "${ACCOUNT[@]}"
fi

if [ "$PORT" = 443 ]; then
  HOLDER=$(ss -tlnpH 'sport = :443' 2>/dev/null || true)
  if [ -n "$HOLDER" ] && ! printf '%s' "$HOLDER" | grep -q nginx; then
    echo "Port 443 belongs to another service: $HOLDER" >&2
    echo 'Keep that service; rerun with WEB_HTTPS_PORT=2053 and configure a Cloudflare Origin Rule for this hostname.' >&2
    exit 1
  fi
fi

node - "$DIR/.env" "$DOMAIN" "$PUBLIC_PORT" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const [file, domain, port] = process.argv.slice(2);
let text = fs.readFileSync(file, 'utf8');
const existing = /^WEB_PASSWORD=(.*)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '');
const password = existing || crypto.randomBytes(24).toString('hex');
for (const [key, value] of Object.entries({ WEB_PASSWORD: password,
  WEB_ORIGIN: `https://${domain}${port === '443' ? '' : `:${port}`}`, WEB_PORT: '3000' })) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
}
fs.writeFileSync(file, text, { mode: 0o600 });
if (!existing) console.log(`Web password (shown once): ${password}`);
NODE
chmod 600 "$DIR/.env"

echo '==> checking ASC web configuration'
if ! (cd "$DIR" && NODE_ENV=production node --input-type=module -e "import('./src/web.js').then(m => m.createWebServer())"); then
  echo 'Fix the setting named in the error above in /root/ASC/.env, then rerun this command.' >&2
  exit 1
fi

cat > /etc/systemd/system/asc-web.service <<UNIT
[Unit]
Description=ASC Web Workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=/usr/bin/node web.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable asc-web
systemctl restart asc-web
sleep 2
if ! systemctl is-active --quiet asc-web; then
  echo 'asc-web failed; recent service errors:' >&2
  journalctl -u asc-web -n 20 --no-pager -o cat >&2 || true
  exit 1
fi

if [ "$PUBLIC_PORT" = 443 ]; then HTTPS_TARGET='https://$host$request_uri'; else HTTPS_TARGET="https://\$host:$PUBLIC_PORT\$request_uri"; fi
cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location / { return 301 $HTTPS_TARGET; }
}
server {
    listen $PORT ssl;
    listen [::]:$PORT ssl;
    server_name $DOMAIN;
    ssl_certificate $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 110m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 300s;
        proxy_request_buffering off;
    }
}
EOF
ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
if ! nginx -T 2>/dev/null | grep -F "server_name $DOMAIN" >/dev/null; then
  printf 'include /etc/nginx/sites-enabled/*;\n' > /etc/nginx/conf.d/000-sites-enabled.conf
fi
nginx -t
systemctl restart nginx
if ! ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -q nginx; then
  echo "nginx did not bind port $PORT; see journalctl -u nginx -n 30" >&2; exit 1
fi
curl -fkS --resolve "$DOMAIN:$PORT:127.0.0.1" "https://$DOMAIN:$PORT/" -o /dev/null
if [ "$PUBLIC_PORT" = 443 ]; then echo "ASC Web is on https://$DOMAIN"; else echo "ASC Web is on https://$DOMAIN:$PUBLIC_PORT"; fi
