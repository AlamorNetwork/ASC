#!/usr/bin/env bash
# Optional: replace Telegram's hosted 20 MB getFile limit with the official local Bot API.
# Run as root on the ASC server after obtaining api_id/api_hash at my.telegram.org.
set -euo pipefail

ASC_DIR="${ASC_DIR:-/root/ASC}"
DATA_DIR=/var/lib/asc-telegram-api
API_ENV=/etc/asc-telegram-api.env
PORT=8082

if [ "$(id -u)" -ne 0 ]; then echo 'Run as root.' >&2; exit 1; fi
if [ ! -f "$ASC_DIR/.env" ]; then echo "Missing $ASC_DIR/.env" >&2; exit 1; fi

if [ ! -f "$API_ENV" ]; then
  if [ -z "${TELEGRAM_API_ID:-}" ]; then read -rp 'Telegram api_id: ' TELEGRAM_API_ID; fi
  if [ -z "${TELEGRAM_API_HASH:-}" ]; then read -rsp 'Telegram api_hash: ' TELEGRAM_API_HASH; echo; fi
  if ! [[ "$TELEGRAM_API_ID" =~ ^[0-9]+$ && "$TELEGRAM_API_HASH" =~ ^[A-Fa-f0-9]{32}$ ]]; then
    echo 'Invalid api_id or api_hash. Obtain them from my.telegram.org.' >&2; exit 1
  fi
  install -m 600 /dev/null "$API_ENV"
  printf 'TELEGRAM_API_ID=%s\nTELEGRAM_API_HASH=%s\n' "$TELEGRAM_API_ID" "$TELEGRAM_API_HASH" > "$API_ENV"
fi

if ! command -v telegram-bot-api >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git cmake g++ gperf libssl-dev zlib1g-dev ca-certificates
  BUILD_DIR=/opt/telegram-bot-api-src
  if [ ! -d "$BUILD_DIR/.git" ]; then
    git clone --recursive --depth 1 --shallow-submodules https://github.com/tdlib/telegram-bot-api.git "$BUILD_DIR"
  fi
  cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local
  cmake --build "$BUILD_DIR/build" --target install --parallel 1
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
BOT_API_BIN="$(command -v telegram-bot-api)"
cat > /etc/systemd/system/asc-telegram-api.service <<UNIT
[Unit]
Description=ASC local Telegram Bot API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$API_ENV
ExecStart=$BOT_API_BIN --local --http-ip-address=127.0.0.1 --http-port=$PORT --dir=$DATA_DIR --files-dir=$DATA_DIR
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable asc-telegram-api
systemctl restart asc-telegram-api

for i in $(seq 1 30); do
  if (echo >/dev/tcp/127.0.0.1/$PORT) >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! (echo >/dev/tcp/127.0.0.1/$PORT) >/dev/null 2>&1; then
  echo 'Local Bot API did not start; see journalctl -u asc-telegram-api -n 40.' >&2
  exit 1
fi
if ! systemctl is-active --quiet asc-telegram-api; then
  echo 'Local Bot API service stopped; see journalctl -u asc-telegram-api -n 40.' >&2
  exit 1
fi

BOT_TOKEN="$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8"); const m=s.match(/^\s*(?:Bot_Token|BOT_TOKEN)\s*=\s*(.+)\s*$/m); if(m) process.stdout.write(m[1].trim().replace(/^["\x27]|["\x27]$/g,""))' "$ASC_DIR/.env")"
if ! [[ "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
  echo 'Bot token missing or malformed in .env.' >&2; exit 1
fi

if ! grep -Eq '^TELEGRAM_API_BASE_URL=http://127\.0\.0\.1:8082/?$' "$ASC_DIR/.env"; then
  # Telegram requires logOut on the hosted server before the local one takes over.
  systemctl stop asc
  if ! curl -fsS --max-time 20 -X POST "https://api.telegram.org/bot${BOT_TOKEN}/logOut" |
    node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{if(!JSON.parse(s).ok)process.exit(1)})'; then
    echo 'Hosted logOut failed. Restoring ASC without changing its config.' >&2
    systemctl start asc
    exit 1
  fi
  local_ready=0
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/bot${BOT_TOKEN}/getMe" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{try{if(!JSON.parse(s).ok)process.exit(1)}catch{process.exit(1)}})'; then
      local_ready=1
      break
    fi
    sleep 2
  done
  if [ "$local_ready" != 1 ]; then
    echo 'Local getMe did not answer after hosted logOut. Check journalctl -u asc-telegram-api -n 40, then rerun this script.' >&2
    exit 1
  fi
  node - "$ASC_DIR/.env" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let s = fs.readFileSync(file, 'utf8');
for (const [key, val] of Object.entries({
  TELEGRAM_API_BASE_URL: 'http://127.0.0.1:8082',
  TELEGRAM_LOCAL_FILES_DIR: '/var/lib/asc-telegram-api',
})) {
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  s = re.test(s) ? s.replace(re, `${key}=${val}`) : `${s.trimEnd()}\n${key}=${val}\n`;
}
fs.writeFileSync(file, s, { mode: 0o600 });
NODE
  chmod 600 "$ASC_DIR/.env"
fi

systemctl restart asc
if ! systemctl is-active --quiet asc; then
  echo 'ASC failed to start; see journalctl -u asc -n 40.' >&2; exit 1
fi
echo 'Local Telegram API is active on 127.0.0.1:8082. Send the PDF to the bot again.'
