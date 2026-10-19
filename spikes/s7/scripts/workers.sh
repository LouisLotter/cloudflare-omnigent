#!/usr/bin/env bash
# Starts or stops the two local Worker entry points with the pinned Wrangler.
#
#   bash spikes/s7/scripts/workers.sh start [strict|naive|off] [base-path]
#   bash spikes/s7/scripts/workers.sh stop
#
# 8787 is the browser entry; 8788 runs the same code with ENTRY=computer, which hands every
# request to the ComputerRoute entrypoint with synthetic props, standing in for the container's
# interception of omnigent.internal. Logs go to spikes/s7/.run/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WRANGLER="$ROOT/worker/node_modules/.bin/wrangler"
RUN="$HERE/.run"
mkdir -p "$RUN"

stop() {
  for entry in browser computer; do
    if [[ -f "$RUN/wrangler-$entry.pid" ]]; then
      kill "$(cat "$RUN/wrangler-$entry.pid")" 2>/dev/null || true
      rm -f "$RUN/wrangler-$entry.pid"
    fi
  done
  # wrangler dev leaves workerd children behind when its parent is killed.
  pkill -f "wrangler.*dev.*spikes/s7/wrangler.jsonc" 2>/dev/null || true
  sleep 1
  echo "stopped local Workers"
}

start() {
  local mode="${1:-strict}"
  local base="${2:-}"
  stop >/dev/null
  local port=8787 inspector=9329
  for entry in browser computer; do
    nohup "$WRANGLER" dev --config "$HERE/wrangler.jsonc" --port "$port" --ip 127.0.0.1 \
      --inspector-port "$inspector" --persist-to "$RUN/state-$entry" --var "ENTRY:$entry" --var "GUARD_MODE:$mode" \
      --var "BASE_PATH:$base" --log-level log >"$RUN/wrangler-$entry.log" 2>&1 &
    echo $! >"$RUN/wrangler-$entry.pid"
    port=$((port + 1))
    inspector=$((inspector + 1))
  done
  for port in 8787 8788; do
    for _ in $(seq 1 60); do
      if curl -s -o /dev/null "http://127.0.0.1:$port/v1/info"; then break; fi
      sleep 1
    done
  done
  echo "browser entry 127.0.0.1:8787, computer entry 127.0.0.1:8788 (guard $mode${base:+, base path $base})"
}

case "${1:-}" in
start) start "${2:-strict}" "${3:-}" ;;
stop) stop ;;
*)
  echo "usage: workers.sh start [strict|naive|off] [base-path] | stop" >&2
  exit 2
  ;;
esac
