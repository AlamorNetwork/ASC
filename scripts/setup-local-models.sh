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

# The ceiling each service gets. A cgroup limit below what the model needs to load does
# not protect anything, it just kills it during startup — which looks from outside like
# a crash with no explanation. So it is the larger of the budget and what the weights
# plus working space actually require, and never more than leaves the bot room.
RESERVE_MB=350          # bot, 9router, web server, kernel
# Weights plus working space. Not shrunk to fit the RAM available: a limit below what
# loading needs does not protect anything, it kills the service during startup, and from
# outside that is a crash with no message. If it does not fit, swap is the answer and
# the script says so rather than quietly setting a ceiling that cannot work.
ceiling() { echo $(( $1 + 450 )); }

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
fi

# Even one model can be tight once the bot, 9router and a web server have their share.
if [ $((AVAIL_MB - RESERVE_MB)) -lt 1050 ] && [ "$SWAP_MB" -eq 0 ]; then
  echo ""
  echo "  ⚠ ${AVAIL_MB}MB available, no swap. The embedding model needs about 1GB while"
  echo "    it loads, and there is roughly $((AVAIL_MB - RESERVE_MB))MB once the bot and"
  echo "    9router have theirs. It may be killed part-way through loading, which shows"
  echo "    up as ECONNREFUSED with nothing obviously wrong."
  echo ""
  echo "    Two gigabytes of swap fixes it. These models are idle between requests, so"
  echo "    paging them costs a slower first answer, not a slower machine:"
  echo ""
  echo "      fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile"
  echo "      swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab"
  echo ""
  echo "    Carrying on — it may well work. If it does not, that is why."
fi

mkdir -p "$DIR/bin" "$DIR/models"

say "llama.cpp"
# Whether it runs, not whether the file is there. The first attempt left a binary
# without its libraries, and testing for existence then skipped the very step that
# would have fixed it — the install "succeeded" every time while staying broken.
export LD_LIBRARY_PATH="$DIR/bin"
if ! "$DIR/bin/llama-server" --version >/dev/null 2>&1; then
  [ -e "$DIR/bin/llama-server" ] && echo "  the copy here does not run; replacing it"
  rm -rf "$DIR/bin"; mkdir -p "$DIR/bin"
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

  # Copy the whole directory the binary sits in, not just the binary: it links against
  # libllama-common.so and others that ship beside it, and taking the executable alone
  # is what produced "cannot open shared object file".
  FOUND=$(find /tmp/llama-extract -name llama-server -type f | head -1)
  # Checked before dirname, because dirname of nothing is "." — which exists, and would
  # have copied the wrong directory instead of reporting the problem.
  [ -n "$FOUND" ] || { echo "  llama-server is not in the archive"; exit 1; }
  cp -a "$(dirname "$FOUND")"/. "$DIR/bin/"

  # And any shared objects the archive keeps somewhere else, in case the layout differs.
  find /tmp/llama-extract -name 'lib*.so*' -type f -exec cp -n {} "$DIR/bin/" \; 2>/dev/null || true

  chmod +x "$DIR/bin/llama-server"
  echo "  $(find "$DIR/bin" -name 'lib*.so*' | wc -l) shared libraries alongside the binary"
  rm -rf /tmp/llama.tar.gz /tmp/llama-extract
fi
# Its own directory is where those libraries are, so it has to be on the search path —
# here, and in the unit files, since systemd does not inherit this shell's environment.
export LD_LIBRARY_PATH="$DIR/bin"
if ! "$DIR/bin/llama-server" --version >/dev/null 2>&1; then
  echo "  the binary still will not run:"
  "$DIR/bin/llama-server" --version 2>&1 | head -3
  echo ""
  echo "  What it is missing, if anything:"
  ldd "$DIR/bin/llama-server" 2>/dev/null | grep 'not found' | sed 's/^/    /' || true
  exit 1
fi
echo "  runs"
"$DIR/bin/llama-server" --version 2>&1 | head -2 || true

say "models"
# Q8_0 for both. The full-precision copy would only matter if there were vectors from
# elsewhere to stay comparable with — embeddings are only meaningful against others from
# the same model at the same precision. Starting from an empty index there is nothing to
# match, so the smaller file wins, and on a 2GB machine that is the whole difference.
# The architecture tag is the first thing llama.cpp reads and the one that decides
# whether it will load the file at all. A multilingual-e5-large GGUF converted as 'xlmr'
# downloaded and installed perfectly and then failed every start with "unknown model
# architecture", 344 restarts deep, looking for all the world like a memory problem.
# GGUF keeps that field in the first few hundred bytes, so it costs nothing to look.
arch_ok() {
  local file="$1"
  head -c 4096 "$file" | grep -aq 'bert' && return 0
  echo "  ✖ $(basename "$file") is not an architecture this llama.cpp build reads:"
  head -c 4096 "$file" | grep -ao 'general\.architecture.\{0,20\}' | head -1 | sed 's/^/      /'
  return 1
}

grab() {
  local file="$1" url="$2"
  if [ -f "$DIR/models/$file" ]; then
    arch_ok "$DIR/models/$file" || { echo "  removing it"; rm -f "$DIR/models/$file"; }
  fi
  if [ -f "$DIR/models/$file" ]; then echo "  have $file"; return; fi
  echo "  downloading $file"
  curl -fL --progress-bar "$url" -o "$DIR/models/$file.part"
  arch_ok "$DIR/models/$file.part" || { rm -f "$DIR/models/$file.part"; exit 1; }
  mv "$DIR/models/$file.part" "$DIR/models/$file"
}

# bge-m3, converted by the llama.cpp project itself. Same 1024 dimensions as e5-large,
# multilingual, and it loads — which the e5 conversions available as GGUF do not.
grab bge-m3-q8_0.gguf \
  "https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF/resolve/main/bge-m3-q8_0.gguf"
if [ "$WANT_RERANK" = "1" ]; then
  grab bge-reranker-v2-m3-Q8_0.gguf \
    "https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF/resolve/main/bge-reranker-v2-m3-Q8_0.gguf"
else
  echo "  skipping the reranker — not enough memory for both"
fi

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
# A real ceiling, not one above the machine's own memory. Under cgroups the kernel kills
# whatever is inside this limit when it is exceeded — which is the point: if this model
# is going to be killed, it should be this model and not the bot.
MemoryMax=$3M
MemorySwapMax=$(( $3 * 2 ))M

[Install]
WantedBy=multi-user.target
UNIT
}

unit local-embed "$DIR/bin/llama-server --host 127.0.0.1 --port $EMBED_PORT \
  -m $DIR/models/bge-m3-q8_0.gguf --embedding --pooling mean \
  -c 512 -np 2 --threads $(nproc) --alias bge-m3" \
  "$(ceiling "$(du -m "$DIR/models/bge-m3-q8_0.gguf" | cut -f1)")"

SERVICES="local-embed"
if [ "$WANT_RERANK" = "1" ]; then
  # A query plus one chunk. Chunks are about 1200 characters, so 1024 tokens is room
  # to spare, and the context is the part that grows with memory.
  unit local-rerank "$DIR/bin/llama-server --host 127.0.0.1 --port $RERANK_PORT \
    -m $DIR/models/bge-reranker-v2-m3-Q8_0.gguf --reranking \
    -c 1024 --threads $(nproc) --alias bge-reranker-v2-m3" \
    "$(ceiling "$(du -m "$DIR/models/bge-reranker-v2-m3-Q8_0.gguf" | cut -f1)")"
  SERVICES="$SERVICES local-rerank"
else
  systemctl disable --now local-rerank >/dev/null 2>&1 || true
fi

systemctl daemon-reload
# shellcheck disable=SC2086
systemctl enable --now $SERVICES >/dev/null
echo "  started ($SERVICES)"

# Wait for it rather than guess. A 573MB model read off disk on a shared CPU takes
# longer than any fixed sleep is willing to be, and llama-server answers 503
# "Loading model" until it is ready — which reads exactly like a failure if you stop
# asking too early.
wait_ready() {
  local name="$1" port="$2" waited=0
  printf '  %s: loading' "$name"
  while [ "$waited" -lt 300 ]; do
    if curl -fsS -m 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      printf ' ready after %ss\n' "$waited"; return 0
    fi
    # A process that died will never become ready, so stop waiting for it.
    if ! systemctl is-active --quiet "$name"; then
      printf ' the service stopped\n'
      journalctl -u "$name" -n 12 --no-pager | sed 's/^/      /'
      return 1
    fi
    sleep 5; waited=$((waited + 5)); printf '.'
  done
  printf ' still not ready after %ss\n' "$waited"
  return 1
}

for svc in $SERVICES; do
  case "$svc" in
    local-embed)  wait_ready local-embed "$EMBED_PORT" || true ;;
    local-rerank) wait_ready local-rerank "$RERANK_PORT" || true ;;
  esac
done

say "does it work"
EMB=$(curl -sS -m 30 -X POST "http://127.0.0.1:$EMBED_PORT/v1/embeddings" \
  -H 'Content-Type: application/json' \
  -d '{"model":"bge-m3","input":["آیین میترائیسم چه بود؟"]}' 2>/dev/null || echo '')
DIMS=$(printf '%s' "$EMB" | grep -o '[-0-9.eE]\+' | wc -l)
if printf '%s' "$EMB" | grep -q '"embedding"'; then
  echo "  ✅ embeddings answered (~$DIMS numbers; bge-m3 is 1024 per vector)"
elif printf '%s' "$EMB" | grep -q 'Loading model'; then
  # Not a failure, just not finished. Saying so beats printing an error for something
  # that will be working in a minute.
  echo "  ⏳ still loading the model. Give it a moment, then:"
  echo "     curl -s localhost:$EMBED_PORT/health"
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
      /model embed bge-m3@localembed
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
