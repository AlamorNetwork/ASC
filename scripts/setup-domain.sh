#!/usr/bin/env bash
#
# Puts a domain and a certificate in front of 9router.
#
#   bash scripts/setup-domain.sh router.alamornetwork.ir you@example.com
#
# 9router listens on 127.0.0.1:20128 and stays there. This adds a reverse proxy in front
# of it, so the thing facing the internet is a web server doing TLS rather than the
# gateway itself.
#
# Exposing it is defensible because its own endpoints are already authenticated:
# /v1/chat/completions answers 401 without an API key, and every /api/ admin route
# answers 401 Unauthorized. Only /v1/models is public, and that is a catalogue.
# Set a strong API key in the dashboard before pointing anything at this.
#
# BEFORE RUNNING — Cloudflare:
#   Let's Encrypt has to reach this machine on port 80 to prove you own the name. With
#   Cloudflare's proxy on (orange cloud) that request lands on Cloudflare instead, and
#   if its SSL mode is Full it then tries to reach your origin over 443, which has no
#   certificate yet. That deadlock is the usual reason this fails.
#
#   So: set the record to DNS only (grey cloud), run this, then turn the proxy back on
#   and set SSL/TLS mode to Full (strict). Grey cloud for a few minutes, orange after.

set -euo pipefail

DOMAIN="${1:?usage: setup-domain.sh <domain> [email]}"
EMAIL="${2:-}"
UPSTREAM="127.0.0.1:20128"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "checking that $DOMAIN points here"
WANT=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || echo '')
GOT=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')
echo "  this server : ${WANT:-unknown}"
echo "  $DOMAIN resolves to: ${GOT:-nothing}"
if [ -n "$WANT" ] && [ -n "$GOT" ] && [ "$WANT" != "$GOT" ]; then
  echo "  They differ. That is expected while Cloudflare's proxy is on — and it is also"
  echo "  exactly what stops certbot working. Set the record to DNS only first."
fi

say "is 9router actually up"
curl -fsS -m 5 "http://$UPSTREAM/v1/models" >/dev/null \
  || { echo "9router is not answering on $UPSTREAM. Start it first: systemctl start 9router"; exit 1; }
echo "  yes"

# Whatever already owns 443 should keep owning it. Caddy does its own certificates, so
# if it is here there is nothing for certbot to do and two proxies fighting over the
# port would be the only result.
if systemctl is-active --quiet caddy 2>/dev/null; then
  say "caddy is already running — using it, no certbot needed"
  CADDYFILE=/etc/caddy/Caddyfile
  if grep -q "^$DOMAIN" "$CADDYFILE" 2>/dev/null; then
    echo "  $DOMAIN is already in $CADDYFILE, leaving it alone"
  else
    cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%s)" 2>/dev/null || true
    cat >> "$CADDYFILE" <<EOF

$DOMAIN {
	reverse_proxy $UPSTREAM {
		# Streamed completions arrive token by token; buffering them would hold the
		# whole reply back until it finished.
		flush_interval -1
	}
}
EOF
    systemctl reload caddy
    echo "  added and reloaded. Caddy gets the certificate by itself."
  fi
else
  say "installing nginx and certbot"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq nginx certbot python3-certbot-nginx

  cat > "/etc/nginx/sites-available/$DOMAIN" <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Streaming: without these, a token-by-token reply is held until it completes.
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        chunked_transfer_encoding off;

        # A long investigation can sit on one request for minutes.
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }

    client_max_body_size 64m;   # audio and documents go through here
}
EOF
  ln -sf "/etc/nginx/sites-available/$DOMAIN" "/etc/nginx/sites-enabled/$DOMAIN"
  nginx -t && systemctl reload nginx

  say "certificate"
  if [ -n "$EMAIL" ]; then
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect
  else
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect
  fi
  systemctl enable certbot.timer >/dev/null 2>&1 || true
  echo "  renewal is handled by certbot.timer; check it with: systemctl list-timers certbot*"
fi

say "trying it"
sleep 2
CODE=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$DOMAIN/v1/models" 2>/dev/null || echo 'failed')
echo "  https://$DOMAIN/v1/models -> $CODE"

cat <<TEXT

$( [ "$CODE" = "200" ] && echo "Working." || echo "Not answering yet. If Cloudflare's proxy is on, that is expected from outside; try again once it is set to Full (strict)." )

Now, in order:
  1. Cloudflare → set the record back to proxied (orange), SSL/TLS mode Full (strict).
  2. 9router dashboard → set a strong API key. The gateway is on the open internet now;
     that key is the only thing between a stranger and your balance.
  3. Point ASC at it, keeping a direct provider as the last link of every chain so the
     bot survives this going down:
       ROUTER_BASE_URL=https://$DOMAIN/v1
       ROUTER_KEY=<the key from the dashboard>

TEXT
