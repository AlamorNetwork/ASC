#!/usr/bin/env bash
#
# Brings ASC up on a fresh Debian or Ubuntu machine.
#
#   curl -fsSL https://raw.githubusercontent.com/AlamorNetwork/ASC/main/scripts/setup-server.sh | bash
#   # or, once the repo is cloned:
#   bash scripts/setup-server.sh
#
# Safe to run again: it installs what is missing and leaves what is there. It never
# touches an existing .env or data/asc.db, because those are the two things that are not
# in git and cannot be recreated.
#
# Installs 9router alongside, bound to localhost, as a gateway to pool provider keys.
# With a Cloudflare DNS token, also provisions the dashboard certificate and nginx on
# port 8443. ASC_SKIP_9ROUTER=1 leaves both out.
#
# It does not change the SSH port. That is what locked the last server, and a change
# worth making is worth making deliberately, with the console open.

set -euo pipefail

REPO="https://github.com/AlamorNetwork/ASC.git"
DIR="${ASC_DIR:-/root/ASC}"
SERVICE="/etc/systemd/system/asc.service"
DOMAIN="${ASC_DOMAIN:-router.alamornetwork.ir}"
DOMAIN_EMAIL="${ASC_DOMAIN_EMAIL:-}"
DOMAIN_PORT="${HTTPS_PORT:-8443}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# poppler-utils is what reads PDFs locally, for free, instead of paying a model to look
# at every page. sqlite3 is for taking a backup by hand if the bot is ever unreachable.
apt-get install -y -qq git curl ca-certificates poppler-utils sqlite3 ffmpeg

say "node"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  # node:sqlite and a built-in fetch are why this project has no npm dependencies at
  # all; both need 22 or newer.
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

if [ "${ASC_SKIP_9ROUTER:-0}" != "1" ]; then
  say "9router"
  # A local gateway to pool every provider key behind one endpoint, so a model running
  # out mid-investigation falls through to the next instead of ending the run.
  npm install -g 9router --silent

  # 9router refuses a remote login while its password is still the built-in 123456 —
  # its own login route checks `!storedHash && !INITIAL_PASSWORD && !isLocal` and turns
  # you away. On a server that means locked out until you tunnel in, so a real password
  # is generated here instead. Once you set one in the dashboard a hash is stored and
  # this value stops being consulted, which is why it is called initial.
  #
  # In its own file at 600, not in the unit: /etc/systemd/system is world-readable, and
  # a password sitting in it would be readable by every account on the machine.
  if [ ! -f /etc/9router.env ]; then
    PASS="${NINEROUTER_PASSWORD:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
    printf 'INITIAL_PASSWORD=%s\n' "$PASS" > /etc/9router.env
    chmod 600 /etc/9router.env
    NEW_PASS="$PASS"
  else
    chmod 600 /etc/9router.env
    echo "  keeping the existing /etc/9router.env"
  fi

  # Bound to 127.0.0.1 on purpose. Its default is 0.0.0.0, which on a public IP is an
  # open gateway to every key it holds — no auth, no rate limit, just a port. ASC runs
  # on this same machine, so it does not need to be reachable from anywhere else.
  cat > /etc/systemd/system/9router.service <<UNIT
[Unit]
Description=9router
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# --skip-update with no TTY puts it in background mode instead of the interactive menu.
ExecStart=$(command -v 9router) --host 127.0.0.1 --port 20128 --no-browser --skip-update
Restart=always
RestartSec=5
Environment=HOME=/root
EnvironmentFile=/etc/9router.env

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now 9router >/dev/null
  # Next.js needs time to start after systemd reports the process as active.
  # A fixed three-second sleep raced startup on a fresh server, so the domain
  # installer ran before 9router had bound its port and aborted the install.
  ROUTER_READY=0
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if curl -fsS --max-time 2 http://127.0.0.1:20128/v1/models >/dev/null 2>&1; then
      ROUTER_READY=1
      break
    fi
    sleep 2
  done
  if [ "$ROUTER_READY" = "1" ]; then
    echo "9router is up on 127.0.0.1:20128"
  else
    echo "9router did not answer after 60 seconds. Recent service output:"
    journalctl -u 9router -n 30 --no-pager || true
    exit 1
  fi

  if [ -n "${NEW_PASS:-}" ]; then
    cat <<TEXT

  ┌──────────────────────────────────────────────────────────┐
     Dashboard password:  $NEW_PASS

     Shown once. It is in /etc/9router.env (root only) if you
     lose it. Change it in the dashboard when you first log in —
     after that a hash is stored and this value is ignored.
  └──────────────────────────────────────────────────────────┘
TEXT
  fi

  cat <<'TEXT'
  Its dashboard is not exposed. Reach it from your own machine with a tunnel:
      ssh -L 20128:127.0.0.1:20128 root@THIS_SERVER
      # then open http://localhost:20128

  Add providers there, then point ASC at it in .env:
      ROUTER_BASE_URL=http://127.0.0.1:20128/v1
  Keep a direct provider as the last link of each chain, so the bot survives
  9router being down rather than gaining a single point of failure.
TEXT
fi

say "code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 20 "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"

# The domain installer lives in the repository, so cloning must happen first. A DNS
# challenge is required while Cloudflare's orange proxy is on. An existing, valid
# certificate is reused; no token is needed on subsequent installs.
if [ "${ASC_SKIP_9ROUTER:-0}" != "1" ] && [ "${ASC_SETUP_DOMAIN:-1}" = "1" ]; then
  if [ -z "${NEW_PASS:-}" ] && [ "${PASSWORD_CHANGED:-0}" != "1" ]; then
    cat <<TEXT

  Dashboard domain is pending: this 9router installation already existed.
  First confirm that its dashboard password is not the bundled default, then run:
    PASSWORD_CHANGED=1 bash $DIR/scripts/setup-server.sh
TEXT
  elif [ -n "${CF_TOKEN:-}" ] || [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    say "9router dashboard: $DOMAIN on port $DOMAIN_PORT"
    if [ -n "${NEW_PASS:-}" ]; then
      # This install generated a random initial password rather than the bundled
      # default. It is safe to expose its login page before the user changes it.
      PASSWORD_CHANGED=1 HTTPS_PORT="$DOMAIN_PORT" \
        bash "$DIR/scripts/setup-domain.sh" "$DOMAIN" "$DOMAIN_EMAIL"
    else
      # On an existing install we cannot infer whether the default dashboard
      # password was changed. setup-domain.sh checks this explicitly.
      HTTPS_PORT="$DOMAIN_PORT" \
        bash "$DIR/scripts/setup-domain.sh" "$DOMAIN" "$DOMAIN_EMAIL"
    fi
  else
    cat <<TEXT

  Dashboard domain is pending: Cloudflare proxy is on, and no certificate or
  CF_TOKEN was supplied. 9router itself is running privately on localhost.
  To finish HTTPS without turning off the proxy:
    read -rsp 'Cloudflare DNS token: ' CF_TOKEN; echo; export CF_TOKEN
    ASC_DOMAIN_EMAIL=you@example.com bash $DIR/scripts/setup-server.sh
    unset CF_TOKEN
  Then add a Cloudflare Origin Rule for $DOMAIN: destination port $DOMAIN_PORT.
TEXT
  fi
fi

say "configuration"
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  chmod 600 "$DIR/.env"
  echo "Created $DIR/.env from the example — fill it in before starting:"
  echo "  Bot_Token, ROUTER_KEY, ROUTER_BASE_URL"
  NEEDS_ENV=1
else
  chmod 600 "$DIR/.env"
  echo "Kept the existing .env."
fi

say "service"
cat > "$SERVICE" <<UNIT
[Unit]
Description=ASC
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
# A crash loop from a bad config should stop and be visible, not hammer the provider.
StartLimitIntervalSec=300
StartLimitBurst=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable asc >/dev/null

if [ "${NEEDS_ENV:-0}" = "1" ]; then
  cat <<TEXT

Not started: .env still needs filling in.

  nano $DIR/.env
  cd $DIR && node --check index.js && systemctl start asc

If you are moving from another machine, put its backup in place first — that file is
the only thing that is not in git:

  # send /backup to the old bot, download the .db, then:
  scp asc-*.db root@THIS_SERVER:$DIR/data/asc.db

TEXT
else
  say "checking"
  # The full self-check touches embedding and rerank endpoints. Even its default
  # mode can incur small provider charges, so a deployment only checks syntax.
  for source in "$DIR"/index.js "$DIR"/src/*.js "$DIR"/scripts/*.js; do
    node --check "$source"
  done
  systemctl restart asc
  sleep 2
  systemctl is-active asc && echo "running"
  cat <<TEXT

Once it answers on Telegram, take a backup straight away and keep taking them:

  /backup

TEXT
fi
