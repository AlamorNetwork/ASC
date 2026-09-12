#!/usr/bin/env bash
#
# Runs the embedding and reranking models on this machine.
#
#   bash scripts/setup-local-models.sh
#
# These two are the ones worth moving locally. They are small — about 560M parameters
# each — they run on a CPU, and they are called constantly: every question embeds a
# query, every retrieval reranks a pool. They are also the two that have been failing,
# first with UND_ERR_CONNECT_TIMEOUT across the border and then with "Workspace is not
# ACTIVE". Locally they cost nothing, answer in milliseconds, and cannot be switched off
# by someone else.
#
# Chat models are deliberately not included. A model large enough to plan or research is
# too slow on a CPU to be worth it, and those roles already have free remote options.
#
# llama.cpp serves both over an OpenAI-compatible API, so ASC needs no code changes —
# they become one more provider.

set -euo pipefail

DIR="${LOCAL_AI_DIR:-/opt/local-ai}"
EMBED_PORT="${EMBED_PORT:-8081}"
RERANK_PORT="${RERANK_PORT:-8082}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "how much room is there"
TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
AVAIL_MB=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
DISK=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "  RAM ${TOTAL_MB}MB total, ${AVAIL_MB}MB available now · swap ${SWAP_MB}MB · disk ${DISK}GB"
[ "${DISK:-0}" -lt 4 ] && { echo "  Under 4GB of disk free; the models need about 1.3GB."; exit 1; }

# What each actually costs resident: the weights plus its context. Measured rather than
# hoped for — this machine is also running the bot, 9router and a web server.
EMBED_MB=750
RERANK_MB=800

WANT_EMBED=1
WANT_RERANK=1
HEADROOM=$((AVAIL_MB - EMBED_MB - RERANK_MB))

if [ "$HEADROOM" -lt 250 ]; then
  # Embeddings first if only one fits. Without them semantic search is off entirely and
  # retrieval is keyword-only; without the reranker it still works, just less precisely.
  WANT_RERANK=0
  if [ $((AVAIL_MB - EMBED_MB)) -lt 250 ]; then
    echo ""
    echo "  ${AVAIL_MB}MB available is not enough for either without risking an"
    echo "  out-of-memory kill — and the thing killed would be whichever process the"
    echo "  kernel picks, quite possibly the bot."
    echo ""
    echo "  Give it swap first. These models sit idle between requests, so paging them"
    echo "  is a slower first answer rather than a slower machine:"
    echo ""
    echo "      fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile"
    echo "      swapon /swapfile"
    echo "      echo '/swapfile none swap sw 0 0' >> /etc/fstab"
    echo ""
    echo "  Then run this again."
    exit 1
  fi
  echo ""
  echo "  Only the embedding model fits. Running both would leave ${HEADROOM}MB, which is"
  echo "  an out-of-memory kill waiting for the first busy minute."
  echo "  Reranking stays remote — it costs precision, not answers."
  echo "  Add swap (see below) and re-run if you want both."
fi

mkdir -p "$DIR/bin" "$DIR/models"

say "llama.cpp"
if [ ! -x "$DIR/bin/llama-server" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq curl tar bc libgomp1
  # The plain CPU build. The rocm/sycl/vulkan variants in the same release are for GPUs
  # this machine does not have.
  TAG=$(curl -fsSL https://api.github.com/repos/ggml-org/llama.cpp/releases \
        | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "  release $TAG"
  curl -fL --progress-bar \
    "https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/llama-${TAG}-bin-ubuntu-x64.tar.gz" \
    -o /tmp/llama.tar.gz
  rm -rf /tmp/llama-extract && mkdir -p /tmp/llama-extract
  tar -xzf /tmp/llama.tar.gz -C /tmp/llama-extract

  # Copy the whole directory the binary sits in, not just the binary. It links against
  # libllama-common.so and friends that ship beside it, and taking the executable alone
  # produced "cannot open shared object file" at the first run.
  SRC=$(dirname "$(find /tmp/llama-extract -name llama-server -type f | head -1)")
  [ -z "$SRC" ] && { echo "  llama-server not found in the archive"; exit 1; }
  cp -a "$SRC"/. "$DIR/bin/"
  chmod +x "$DIR/bin/llama-server"
  rm -rf /tmp/llama.tar.gz /tmp/llama-extract
fi
# Its own directory is where those libraries are, so it has to be on the search path.
export LD_LIBRARY_PATH="$DIR/bin"
"$DIR/bin/llama-server" --version >/dev/null 2>&1 \
  || { echo "  the binary still will not run:"; "$DIR/bin/llama-server" --version 2>&1 | head -3; exit 1; }
"$DIR/bin/llama-server" --version 2>&1 | head -2 || true

say "models"
# Q8_0 for both. The full-precision copy would only matter if there were vectors from
# elsewhere to stay comparable with — embeddings are only meaningful against others from
# the same model at the same precision. Starting from an empty index there is nothing to
# match, so the smaller file wins, and on a 2GB machine that is the whole difference.
grab() {
  local file="$1" url="$2"
  if [ -f "$DIR/models/$file" ]; then echo "  have $file"; return; fi
  echo "  downloading $file"
  curl -fL --progress-bar "$url" -o "$DIR/models/$file.part"
  mv "$DIR/models/$file.part" "$DIR/models/$file"
}
grab multilingual-e5-large-q8_0.gguf \
  "https://huggingface.co/cstr/multilingual-e5-large-GGUF/resolve/main/multilingual-e5-large-q8_0.gguf"
[ "$WANT_RERANK" = "1" ] && grab bge-reranker-v2-m3-Q8_0.gguf \
  "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf"

say "services"
# Two processes: one server cannot do both, because embedding and reranking need
# different pooling. Both on loopback — nothing here has authentication, and it does not
# need any while it is only reachable from this machine.
unit() {
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=$1
After=network.target

[Service]
Type=simple
ExecStart=$2
Restart=always
RestartSec=5
Environment=LD_LIBRARY_PATH=$DIR/bin
# Small models, but two of them: keep one from taking the machine down with it.
MemoryMax=3G

[Install]
WantedBy=multi-user.target
UNIT
}

unit local-embed "$DIR/bin/llama-server --host 127.0.0.1 --port $EMBED_PORT \
  -m $DIR/models/multilingual-e5-large-q8_0.gguf --embedding --pooling mean \
  -c 512 -np 2 --threads $(nproc) --alias intfloat/multilingual-e5-large"

SERVICES="local-embed"
if [ "$WANT_RERANK" = "1" ]; then
  # A query plus one chunk. Chunks are about 1200 characters, so 1024 tokens is room
  # to spare, and the context is the part that grows with memory.
  unit local-rerank "$DIR/bin/llama-server --host 127.0.0.1 --port $RERANK_PORT \
    -m $DIR/models/bge-reranker-v2-m3-Q8_0.gguf --reranking \
    -c 1024 --threads $(nproc) --alias bge-reranker-v2-m3"
  SERVICES="$SERVICES local-rerank"
else
  systemctl disable --now local-rerank >/dev/null 2>&1 || true
fi

systemctl daemon-reload
# shellcheck disable=SC2086
systemctl enable --now $SERVICES >/dev/null
echo "  started ($SERVICES); giving them a moment to load"
sleep 12

say "does it work"
EMB=$(curl -sS -m 30 -X POST "http://127.0.0.1:$EMBED_PORT/v1/embeddings" \
  -H 'Content-Type: application/json' \
  -d '{"model":"intfloat/multilingual-e5-large","input":["آیین میترائیسم چه بود؟"]}' 2>/dev/null || echo '')
DIMS=$(printf '%s' "$EMB" | grep -o '[-0-9.eE]\+' | wc -l)
if printf '%s' "$EMB" | grep -q '"embedding"'; then
  echo "  ✅ embeddings answered (~$DIMS numbers; e5-large is 1024 per vector)"
else
  echo "  ✖ embeddings: $(printf '%s' "$EMB" | head -c 160)"
  echo "    journalctl -u local-embed -n 40"
fi

if [ "$WANT_RERANK" = "1" ]; then
  RR=$(curl -sS -m 30 -X POST "http://127.0.0.1:$RERANK_PORT/reranking" \
    -H 'Content-Type: application/json' \
    -d '{"model":"bge-reranker-v2-m3","query":"میترائیسم چیست؟","documents":["آیینی رازآمیز در امپراتوری روم","متنی درباره کشاورزی"]}' 2>/dev/null || echo '')
  if printf '%s' "$RR" | grep -q 'relevance_score\|"results"'; then
    echo "  ✅ reranking answered"
  else
    echo "  ✖ reranking: $(printf '%s' "$RR" | head -c 160)"
    echo "    journalctl -u local-rerank -n 40"
  fi
else
  echo "  ➖ reranking not installed — not enough memory for both"
fi

free -m | awk '/Mem:/ {printf "\n  memory now: %dMB used of %dMB, %dMB available\n", $3, $2, $7}'

cat <<TEXT

$(say "wiring it into ASC")

  In the bot — the key is ignored, these have no authentication:

      /provider add localembed http://127.0.0.1:$EMBED_PORT/v1 local
      /model embed intfloat/multilingual-e5-large@localembed
$( [ "$WANT_RERANK" = "1" ] && cat <<INNER

      /provider add localrerank http://127.0.0.1:$RERANK_PORT/v1 local
      /model rerank bge-reranker-v2-m3@localrerank
INNER
)
  Then: /doctor

  If you ever point embeddings at a different model, the vectors already stored stop
  being comparable — they are only meaningful against others from the same model. That
  is what this is for, and it is free now:

      node scripts/reembed.js          says what it would do
      node scripts/reembed.js --run

TEXT
