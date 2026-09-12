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
# It does not change the SSH port. That is what locked the last server, and a change
# worth making is worth making deliberately, with the console open.

set -euo pipefail

REPO="https://github.com/AlamorNetwork/ASC.git"
DIR="${ASC_DIR:-/root/ASC}"
SERVICE="/etc/systemd/system/asc.service"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# poppler-utils is what reads PDFs locally, for free, instead of paying a model to look
# at every page. sqlite3 is for taking a backup by hand if the bot is ever unreachable.
apt-get install -y -qq git curl ca-certificates poppler-utils sqlite3

say "node"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  # node:sqlite and a built-in fetch are why this project has no npm dependencies at
  # all; both need 22 or newer.
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

say "code"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 20 "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"

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
  cd $DIR && node scripts/check.js && systemctl start asc

If you are moving from another machine, put its backup in place first — that file is
the only thing that is not in git:

  # send /backup to the old bot, download the .db, then:
  scp asc-*.db root@THIS_SERVER:$DIR/data/asc.db

TEXT
else
  say "checking"
  cd "$DIR" && node scripts/check.js
  systemctl restart asc
  sleep 2
  systemctl is-active asc && echo "running"
  cat <<TEXT

Once it answers on Telegram, take a backup straight away and keep taking them:

  /backup

TEXT
fi
