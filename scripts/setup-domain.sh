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
# TWO WAYS TO PROVE YOU OWN THE NAME, and which one you want depends on Cloudflare.
#
#   Without CF_TOKEN, Let's Encrypt proves it by fetching a file over port 80. With the
#   proxy on (orange cloud) that request lands on Cloudflare, which then fetches from
#   your origin the way its SSL mode says — and on Full that means over 443, which has
#   no certificate yet. That deadlock is the usual reason this fails, so the proxy has
#   to go grey for a few minutes and orange again afterwards.
#
#   With CF_TOKEN, it is proved by writing a DNS record instead, so nothing ever has to
#   reach port 80 and the proxy stays on the whole time. Renewals keep working without
#   anyone remembering to flip the cloud. This is the better path when Cloudflare is
#   already holding the zone:
#
#     CF_TOKEN=... PASSWORD_CHANGED=1 bash scripts/setup-domain.sh router.example.ir you@example.com
#
#   Make the token at dash.cloudflare.com → My Profile → API Tokens → Create Token →
#   Edit zone DNS, scoped to this one zone. It is written to /etc/letsencrypt/ as 0600
#   because certbot needs it again at every renewal; a token that can edit one zone's
#   DNS is the least it can be given.

set -euo pipefail

DOMAIN="${1:?usage: setup-domain.sh <domain> [email]}"
EMAIL="${2:-}"
UPSTREAM="127.0.0.1:20128"
CF_TOKEN="${CF_TOKEN:-}"
CF_CREDS=/etc/letsencrypt/cloudflare.ini

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# 9router ships with the dashboard password "123456" — it is a constant in its own CLI
# source. Publishing a login page that still accepts it hands over every provider key
# the gateway holds to anyone who finds the name.
#
# This cannot be checked from here: /api/auth/status reports hasPassword true either way,
# and trying the default would spend one of the five attempts before it locks you out of
# your own dashboard. So it is an explicit acknowledgement instead.
if [ "${PASSWORD_CHANGED:-0}" != "1" ]; then
  cat <<TEXT

  Change the dashboard password first.

  9router's default is 123456. Reach it privately, from your own machine:

      ssh -L 20128:127.0.0.1:20128 root@$(hostname -I 2>/dev/null | awk '{print $1}')
      # then open http://localhost:20128 and change the password

  Then run this again, saying so:

      PASSWORD_CHANGED=1 bash scripts/setup-domain.sh $DOMAIN ${EMAIL:-you@example.com}

  Nothing has been changed. The dashboard is not published yet.

TEXT
  exit 1
fi

say "checking that $DOMAIN points here"
WANT=$(curl -fsS -m 10 https://api.ipify.org 2>/dev/null || echo '')
GOT=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || echo '')
echo "  this server : ${WANT:-unknown}"
echo "  $DOMAIN resolves to: ${GOT:-nothing}"
if [ -n "$WANT" ] && [ -n "$GOT" ] && [ "$WANT" != "$GOT" ]; then
  if [ -n "$CF_TOKEN" ]; then
    echo "  They differ, which is what a proxied record looks like. Fine — the DNS"
    echo "  challenge does not care where the name points."
  else
    echo "  They differ. That is expected while Cloudflare's proxy is on — and it is also"
    echo "  exactly what stops the port 80 challenge working. Either set the record to"
    echo "  DNS only first, or re-run with CF_TOKEN=... and leave the proxy alone."
  fi
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
  if [ -n "$CF_TOKEN" ]; then
    apt-get install -y -qq python3-certbot-dns-cloudflare
  fi

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
  # The account identity is the same either way; only how ownership is proved differs.
  ACCOUNT=(--non-interactive --agree-tos --redirect)
  if [ -n "$EMAIL" ]; then
    ACCOUNT+=(-m "$EMAIL")
  else
    ACCOUNT+=(--register-unsafely-without-email)
  fi

  if [ -n "$CF_TOKEN" ]; then
    # Written before it is used and only readable by root: certbot re-reads this file at
    # every renewal, so the token lives here for as long as the certificate does.
    install -d -m 0755 /etc/letsencrypt
    umask 077
    printf 'dns_cloudflare_api_token = %s\n' "$CF_TOKEN" > "$CF_CREDS"
    chmod 600 "$CF_CREDS"
    umask 022
    echo "  proving ownership through DNS, so port 80 is not involved and the proxy can stay on"
    # Two authorities have to agree the record exists, and Cloudflare's own resolvers
    # publish it before the rest of the world sees it. Waiting is cheaper than a failed
    # issuance that counts against the rate limit.
    certbot --authenticator dns-cloudflare \
      --dns-cloudflare-credentials "$CF_CREDS" \
      --dns-cloudflare-propagation-seconds 30 \
      --installer nginx -d "$DOMAIN" "${ACCOUNT[@]}"
  else
    certbot --nginx -d "$DOMAIN" "${ACCOUNT[@]}"
  fi
  systemctl enable certbot.timer >/dev/null 2>&1 || true
  echo "  renewal is handled by certbot.timer; check it with: systemctl list-timers certbot*"
fi

# Three layers can answer, and testing only through the domain cannot tell them apart.
# The first version did exactly that and reported a 404 as "expected while the proxy is
# on, until SSL mode is Full" — which is wrong twice over: a 404 means something
# answered and did not have the path, while an SSL mismatch at Cloudflare is 525/526 and
# an unreachable origin is 521/522. So each layer is now asked separately.
#
# --resolve sends the request to this machine while still presenting the real name in
# SNI and Host, which is what nginx selects the server block on. Without it there is no
# way to ask nginx what it would say without Cloudflare in front.
say "trying it, one layer at a time"
sleep 2
code() { curl -skS -m 15 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 'failed'; }

UP=$(code "http://$UPSTREAM/v1/models")
ORIGIN_ROOT=$(code --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/")
ORIGIN_API=$(code --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/v1/models")
EDGE_ROOT=$(code "https://$DOMAIN/")
EDGE_API=$(code "https://$DOMAIN/v1/models")

echo "  1. 9router itself   http://$UPSTREAM/v1/models -> $UP   (want 200)"
echo "  2. nginx, no CDN    https://$DOMAIN/           -> $ORIGIN_ROOT   (want 200)"
echo "                      https://$DOMAIN/v1/models  -> $ORIGIN_API   (want 403)"
echo "  3. through Cloudflare  https://$DOMAIN/        -> $EDGE_ROOT   (want 200)"
echo "                         https://$DOMAIN/v1/models -> $EDGE_API   (want 403)"

if [ "$UP" != "200" ]; then
  echo "
  Layer 1. 9router is not answering on $UPSTREAM, so nothing above it can work.
      systemctl status 9router"
elif [ "$ORIGIN_API" = "404" ] || [ "$ORIGIN_ROOT" = "404" ]; then
  # This block returns 403 for /v1/ unconditionally, so a 404 there proves the request
  # never reached it — some other server block took the name first.
  echo "
  Layer 2. nginx answered, but not from this site's block: /v1/ here is a hard 403,
  so a 404 means another server block claimed the name. Find which:
      nginx -T | grep -n 'server_name\\|listen' | head -40
      ls -l /etc/nginx/sites-enabled/"
elif [ "$ORIGIN_API" != "403" ] || [ "$ORIGIN_ROOT" != "200" ]; then
  echo "
  Layer 2. nginx is reachable but not saying what it should. Look at the block:
      cat /etc/nginx/sites-enabled/$DOMAIN"
elif [ "$EDGE_API" = "200" ]; then
  echo "
  ⚠ The API answered over the domain. It should not. Right now anyone who finds the
  name can spend your balance. Do not put a key in it until this is 403."
elif [ "$ORIGIN_ROOT" = "200" ] && [ "$EDGE_ROOT" != "200" ]; then
  echo "
  Layer 3. The origin is correct and Cloudflare is not passing it through, so the
  problem is in the dashboard, not on this machine:
    $EDGE_ROOT of 521/522  -> Cloudflare cannot reach the origin; check the firewall on 443
    $EDGE_ROOT of 525/526  -> SSL/TLS mode; set it to Full (strict)
    $EDGE_ROOT of 404/403  -> something at Cloudflare is claiming this hostname before
                              the origin is asked: a Worker route, a Pages project, a
                              Page Rule, or the record pointing somewhere else entirely.
                              Check DNS → the record for ${DOMAIN%%.*}, and Workers Routes."
elif [ "$EDGE_ROOT" = "200" ] && [ "$EDGE_API" = "403" ]; then
  echo "
  That is the shape you asked for: the settings page reachable, the spending
  endpoint not, and the bot still able to use it from here."
fi

cat <<TEXT

Now, in order:
  1. Cloudflare → record proxied (orange), SSL/TLS mode Full (strict). With CF_TOKEN
     the record never left the proxy, so only the SSL mode needs checking.
  2. Check that https://$DOMAIN does NOT accept 123456. If it does, the password was
     not actually changed and every provider key in the gateway is one guess away.
  3. Leave ASC pointing at localhost — it is on this machine, so it does not need the
     domain and should not depend on it:
       ROUTER_BASE_URL=http://127.0.0.1:20128/v1

  Cloudflare can narrow it further if you want: Zero Trust → Access → a policy on
  $DOMAIN limiting it to your own email. Then the login page is not public either.

TEXT
