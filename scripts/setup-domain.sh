#!/usr/bin/env bash
#
# Puts a domain and a certificate in front of 9router.
#
#   bash scripts/setup-domain.sh router.alamornetwork.ir you@example.com
#
# 9router listens on 127.0.0.1:20128 and stays there. What this publishes is the
# dashboard only — the part you need a browser for. The inference API is blocked at the
# proxy and stays reachable only from the machine itself.
#
# That split is the point. /v1/ is where money is spent; nothing outside this server has
# any reason to reach it, and ASC talks to 127.0.0.1:20128 directly. The dashboard does
# need to be reachable, and it has its own password — the running instance reports
# {"requireLogin":true,"authMode":"password"} — so a public login page is the only
# surface, and a strong password is what stands on it.
#
# One consequence worth knowing: a dashboard feature that calls /v1/ from your browser
# (testing a model, say) will not work over the domain, because that is exactly what is
# blocked. Use the SSH tunnel for that.
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
	# The dashboard, and nothing else. /v1/ is where spending happens and it has no
	# business being reachable from outside this machine.
	handle /v1/* {
		respond "not exposed — use 127.0.0.1:20128 from the server" 403
	}
	handle {
		reverse_proxy $UPSTREAM
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

    # The dashboard, and nothing else. /v1/ is where spending happens and it has no
    # business being reachable from outside this machine — ASC reaches it on localhost.
    location /v1/ {
        return 403 "not exposed - use 127.0.0.1:20128 from the server\n";
    }

    location / {
        proxy_pass http://$UPSTREAM;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # The dashboard streams logs, so buffering would make them arrive in lumps.
        proxy_buffering off;
        proxy_set_header Connection '';
        proxy_read_timeout 120s;
    }

    client_max_body_size 16m;
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
LOGIN=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$DOMAIN/login" 2>/dev/null || echo 'failed')
API=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "https://$DOMAIN/v1/models" 2>/dev/null || echo 'failed')
LOCAL=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "http://$UPSTREAM/v1/models" 2>/dev/null || echo 'failed')

echo "  dashboard   https://$DOMAIN/login    -> $LOGIN   (want 200)"
echo "  api, public https://$DOMAIN/v1/models -> $API   (want 403)"
echo "  api, local  http://$UPSTREAM/v1/models -> $LOCAL   (want 200)"

if [ "$LOGIN" = "200" ] && [ "$API" = "403" ] && [ "$LOCAL" = "200" ]; then
  echo "
  That is the shape you asked for: the settings page reachable, the spending
  endpoint not, and the bot still able to use it from here."
elif [ "$API" = "200" ]; then
  echo "
  ⚠ The API answered over the domain. It should not. Check the proxy config before
  putting a key in it — right now anyone who finds the name can spend your balance."
else
  echo "
  Not there yet. With Cloudflare's proxy on, this is expected from outside until the
  SSL/TLS mode is Full (strict)."
fi

cat <<TEXT

Now, in order:
  1. Cloudflare → set the record back to proxied (orange), SSL/TLS mode Full (strict).
  2. Open https://$DOMAIN and set a strong dashboard password. That login page is on
     the open internet; the password is the whole of what protects it.
  3. Leave ASC pointing at localhost — it is on this machine, so it does not need the
     domain and should not depend on it:
       ROUTER_BASE_URL=http://127.0.0.1:20128/v1

  Cloudflare can narrow it further if you want: Zero Trust → Access → a policy on
  $DOMAIN limiting it to your own email. Then the login page is not public either.

TEXT
