#!/usr/bin/env bash
# Deploy ASC's private web workspace on a separate domain from 9router.
# Usage: bash scripts/setup-web.sh asc.alamornetwork.ir you@example.com
set -euo pipefail
trap 'echo "setup-web stopped at line $LINENO" >&2' ERR

DOMAIN="${1:-asc.alamornetwork.ir}"
EMAIL="${2:-}"
PORT="${WEB_HTTPS_PORT:-2083}"
PUBLIC_PORT="${WEB_PUBLIC_PORT:-443}"
DIR="${ASC_DIR:-/root/ASC}"
CREDS=/etc/letsencrypt/cloudflare.ini
LIVE="/etc/letsencrypt/live/$DOMAIN"

if [ "$(id -u)" -ne 0 ]; then echo 'Run as root.' >&2; exit 1; fi
if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ && "$PORT" =~ ^[0-9]+$ && "$PUBLIC_PORT" =~ ^[0-9]+$ ]] ||
   (( 10#$PORT < 1 || 10#$PORT > 65535 || 10#$PUBLIC_PORT < 1 || 10#$PUBLIC_PORT > 65535 )); then
  echo 'Invalid domain or port.' >&2; exit 1
fi
if [ ! -f "$DIR/.env" ]; then echo "Missing $DIR/.env" >&2; exit 1; fi
if ! command -v ss >/dev/null; then echo 'ss (iproute2) is required for port preflight.' >&2; exit 1; fi
HOLDER=$(ss -tlnpH "sport = :$PORT")
if [ -n "$HOLDER" ] && ! printf '%s' "$HOLDER" | grep -q 'users:(("nginx"'; then
  echo "Port $PORT belongs to another service: $HOLDER" >&2
  echo 'Choose a free WEB_HTTPS_PORT; existing listeners will not be changed.' >&2
  exit 1
fi

if ! command -v nginx >/dev/null || ! command -v certbot >/dev/null ||
   ! dpkg-query -W -f='${Status}' python3-certbot-dns-cloudflare 2>/dev/null | grep -q 'install ok installed'; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-dns-cloudflare
fi

if [ ! -f "$LIVE/fullchain.pem" ] || ! openssl x509 -in "$LIVE/fullchain.pem" -noout -checkend 604800 >/dev/null 2>&1; then
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

SITE="/etc/nginx/sites-available/$DOMAIN"
ENABLED="/etc/nginx/sites-enabled/$DOMAIN"
INCLUDE=/etc/nginx/conf.d/000-sites-enabled.conf
BACKUP=$(mktemp -d)
for name in SITE ENABLED INCLUDE; do
  path="${!name}"
  if [ -e "$path" ] || [ -L "$path" ]; then cp -a "$path" "$BACKUP/$name"; fi
done
restore_nginx() {
  for name in SITE ENABLED INCLUDE; do
    path="${!name}"
    if [ -e "$BACKUP/$name" ] || [ -L "$BACKUP/$name" ]; then
      rm -f "$path"
      cp -a "$BACKUP/$name" "$path"
    else
      rm -f "$path"
    fi
  done
}
cat > "$SITE" <<EOF
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
install -d /etc/nginx/sites-enabled
ln -sf "$SITE" "$ENABLED"
if ! nginx -T 2>/dev/null | grep -F "# configuration file /etc/nginx/sites-enabled/$DOMAIN:" >/dev/null; then
  if [ -e "$INCLUDE" ] && ! grep -Fxq 'include /etc/nginx/sites-enabled/*;' "$INCLUDE"; then
    echo "Existing $INCLUDE does not include sites-enabled; inspect it before retrying." >&2
    restore_nginx
    rm -rf "$BACKUP"
    exit 1
  fi
  if [ ! -e "$INCLUDE" ]; then
    printf 'include /etc/nginx/sites-enabled/*;\n' > "$INCLUDE"
  fi
fi
if ! nginx -t; then
  restore_nginx
  rm -rf "$BACKUP"
  exit 1
fi
if ! systemctl reload-or-restart nginx; then
  restore_nginx
  nginx -t && systemctl reload-or-restart nginx || true
  rm -rf "$BACKUP"
  exit 1
fi
rm -rf "$BACKUP"
if ! ss -tlnpH "sport = :$PORT" | grep -q 'users:(("nginx"'; then
  echo "nginx did not bind port $PORT; see journalctl -u nginx -n 30" >&2; exit 1
fi
systemctl enable asc-web
systemctl restart asc-web
for ((attempt = 1; attempt <= 15; attempt++)); do
  if systemctl is-active --quiet asc-web &&
     curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:3000/" -o /dev/null &&
     curl --noproxy '*' -fsS --max-time 3 --resolve "$DOMAIN:$PORT:127.0.0.1" "https://$DOMAIN:$PORT/" -o /dev/null; then
    READY=1
    break
  fi
  sleep 2
done
if [ "${READY:-0}" != 1 ]; then
  echo 'ASC web did not pass local HTTP and HTTPS checks; recent service errors:' >&2
  journalctl -u asc-web -n 20 --no-pager -o cat >&2 || true
  exit 1
fi
echo "ASC Web origin is healthy on local HTTPS port $PORT."
if [ "$PORT" != "$PUBLIC_PORT" ]; then
  echo "For the public URL, proxy $DOMAIN in Cloudflare and set an Origin Rule rewriting its destination port to $PORT."
  echo "The public route has not been verified by this local check."
fi
if [ "$PUBLIC_PORT" = 443 ]; then echo "Intended public URL: https://$DOMAIN"; else echo "Intended public URL: https://$DOMAIN:$PUBLIC_PORT"; fi
