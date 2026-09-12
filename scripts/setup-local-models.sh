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

say "checking there is room"
RAM=$(awk '/MemTotal/ {printf "%.1f", $2/1024/1024}' /proc/meminfo)
DISK=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
echo "  RAM ${RAM}GB · free disk ${DISK}GB"
# Two models resident, plus context. Under 2GB of RAM this will thrash or be killed.
if (( $(echo "$RAM < 1.9" | bc -l 2>/dev/null || echo 0) )); then
  echo "  Under 2GB of RAM. Run only the reranker (skip the embedding service), or"
  echo "  keep embeddings remote. Stopping here rather than leaving you with an"
  echo "  out-of-memory kill at the first question."
  exit 1
fi
[ "${DISK:-0}" -lt 4 ] && { echo "  Under 4GB of disk free; the models need about 2GB."; exit 1; }

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
  tar -xzf /tmp/llama.tar.gz -C /tmp
  find /tmp -name 'llama-server' -type f -exec cp {} "$DIR/bin/" \; -quit
  find /tmp -name 'lib*.so*' -type f -exec cp {} "$DIR/bin/" \; 2>/dev/null || true
  chmod +x "$DIR/bin/llama-server"
  rm -rf /tmp/llama.tar.gz
fi
"$DIR/bin/llama-server" --version 2>&1 | head -2 || true

say "models"
# The unquantised e5-large on purpose. Vectors already in the database came from this
# model at full precision through Liara; a quantised copy would return slightly
# different vectors for the same text, and the old and new would not sit together
# cleanly in one index.
grab() {
  local file="$1" url="$2"
  if [ -f "$DIR/models/$file" ]; then echo "  have $file"; return; fi
  echo "  downloading $file"
  curl -fL --progress-bar "$url" -o "$DIR/models/$file.part"
  mv "$DIR/models/$file.part" "$DIR/models/$file"
}
grab multilingual-e5-large.gguf \
  "https://huggingface.co/cstr/multilingual-e5-large-GGUF/resolve/main/multilingual-e5-large.gguf"
grab bge-reranker-v2-m3-Q8_0.gguf \
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
  -m $DIR/models/multilingual-e5-large.gguf --embedding --pooling mean \
  -c 512 -np 4 --threads $(nproc) --alias intfloat/multilingual-e5-large"

unit local-rerank "$DIR/bin/llama-server --host 127.0.0.1 --port $RERANK_PORT \
  -m $DIR/models/bge-reranker-v2-m3-Q8_0.gguf --reranking \
  -c 2048 --threads $(nproc) --alias bge-reranker-v2-m3"

systemctl daemon-reload
systemctl enable --now local-embed local-rerank >/dev/null
echo "  started; giving them a moment to load"
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

RR=$(curl -sS -m 30 -X POST "http://127.0.0.1:$RERANK_PORT/reranking" \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-reranker-v2-m3","query":"میترائیسم چیست؟","documents":["آیینی رازآمیز در امپراتوری روم","متنی درباره کشاورزی"]}' 2>/dev/null || echo '')
if printf '%s' "$RR" | grep -q 'relevance_score\|"results"'; then
  echo "  ✅ reranking answered"
else
  echo "  ✖ reranking: $(printf '%s' "$RR" | head -c 160)"
  echo "    journalctl -u local-rerank -n 40"
fi

cat <<TEXT

$(say "wiring it into ASC")

  In the bot — the key is ignored, these have no authentication:

      /provider add localembed  http://127.0.0.1:$EMBED_PORT/v1   local
      /provider add localrerank http://127.0.0.1:$RERANK_PORT/v1  local

      /model embed  intfloat/multilingual-e5-large@localembed
      /model rerank bge-reranker-v2-m3@localrerank

  Then: /doctor

  One thing to know about the vectors already in the database. They were made by the
  same model, but through Liara at full precision; these come from a local copy of it.
  They are close enough to sit in one index, but not identical. Now that embedding is
  free, the clean answer is to redo them:

      node scripts/reembed.js          says what it would do
      node scripts/reembed.js --run

  That also picks up every chunk that never got a vector because the remote call timed
  out, which on this corpus is not a small number.

TEXT
