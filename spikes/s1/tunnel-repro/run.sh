#!/usr/bin/env bash
# Local reproduction of S1's host tunnel problem and fix (2026-10-19). Local only: wrangler dev
# and Docker, nothing deployed. Needs the S1 computer image built as cfo-s1/computer:local
# (docker build -t cfo-s1/computer:local spikes/s1/computer) and `npm ci --prefix spikes/s1`.
#
#   export S1_REPRO_DIR=$(mktemp -d)        # logs; shared by the steps below
#   spikes/s1/tunnel-repro/run.sh dev min &      # minimal Worker on 127.0.0.1:18787
#   spikes/s1/tunnel-repro/run.sh min-direct     # 1. through the Worker's own fetch
#   spikes/s1/tunnel-repro/run.sh min-intercept  # 2. through workerd's egress listener
#   (stop wrangler dev)
#   spikes/s1/tunnel-repro/run.sh dev harness &  # the patched S1 Worker
#   spikes/s1/tunnel-repro/run.sh harness        # 3. the patched code, every tunnel mode
#   spikes/s1/tunnel-repro/run.sh fake-egress    # 4. what the real host does with bad 101s
#
# The laptop's firewall drops traffic from Docker's bridge to the laptop, so a container cannot
# reach workerd's egress listener there. relay.py does the egress sidecar's part from the laptop
# instead: an HTTP CONNECT with the X-Hostname hint, as cloudflare/proxy-everything sends it,
# then raw bytes. Clients run in the S1 computer image with --network host.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
WRANGLER=${WRANGLER:-$HERE/../../../worker/node_modules/.bin/wrangler}
LOGS=${S1_REPRO_DIR:?set S1_REPRO_DIR to a directory for logs, e.g. export S1_REPRO_DIR=\$(mktemp -d)}
BASE=http://127.0.0.1:18787
IMAGE=cfo-s1/computer:local
MODES_MIN="direct bridge bridge-clean direct-noext"
MODES_S1="fixed route-fixed bridge direct"

newid() { python3 -I -c 'import uuid; print(uuid.uuid4().hex)'; }

# Starts the real Omnigent host against $1 and polls the server's status for host $2 through
# the Worker until online or 60 s. Prints the time from `docker run` to online.
host_online() {
  local server=$1 id=$2 t0 status=none
  docker rm -f s1r-host >/dev/null 2>&1
  t0=$(date +%s%3N)
  docker run -d --name s1r-host --network host --add-host omnigent.internal:127.0.0.1 \
    -e OMNIGENT_HOST_ID="$id" -e OMNIGENT_HOST_NAME=s1-repro --entrypoint omnigent "$IMAGE" \
    host --server "$server" --non-interactive --no-open >/dev/null
  while [ $(($(date +%s%3N) - t0)) -lt 60000 ]; do
    status=$(curl -s -m 5 "$BASE/v1/hosts/$id" | python3 -I -c 'import json, sys
try: print(json.load(sys.stdin).get("status"))
except Exception: print("absent")')
    [ "$status" = online ] && break
    sleep 0.25
  done
  echo "real host: status=$status after $(($(date +%s%3N) - t0)) ms from docker run"
  docker exec s1r-host sh -c 'grep -h "Host tunnel disconnected" /root/.omnigent/logs/host/*.log 2>/dev/null | sed -E "s/^.*disconnected: //" | sort | uniq -c | head -3'
  docker rm -f s1r-host >/dev/null 2>&1
}

# Relays 127.0.0.1:18080 to the egress listener of the running container whose name contains $1.
start_relay() {
  local proxy port
  proxy=$(docker ps --filter "name=$1" --format '{{.Names}}' | grep -- '-proxy$' | head -1)
  # workerd tells the sidecar its egress port again after each reload; take the last.
  port=$(docker logs "$proxy" 2>&1 | grep -o 'updated shared egress port to [0-9]*' | tail -1 | grep -o '[0-9]*$')
  python3 -I "$HERE/relay.py" 18080 "172.17.0.1:$port" omnigent.internal >"$LOGS/relay.log" 2>&1 &
  RELAY=$!
  sleep 1
}

worker_lines() {
  tail -n +"$(($1 + 1))" "$LOGS/dev.log" |
    grep -o -E '"r":"upgrade-upstream"|"upstreamAcceptMatchesHostKey":(true|false)|"s1":"ws-upgrade[a-z-]*"|"mode":"[a-z-]+"' |
    sort | uniq -c
}

case ${1:-} in
  dev)
    cd "$HERE/$2" || exit 1
    WRANGLER_SEND_METRICS=false exec "$WRANGLER" dev --ip 127.0.0.1 --port 18787 \
      --inspector-port 19229 --log-level log >"$LOGS/dev.log" 2>&1
    ;;
  min-direct | min-intercept)
    echo "server up: $(curl -s -m 200 "$BASE/__up")"
    via=$BASE
    if [ "$1" = min-intercept ]; then
      echo "computer: $(curl -s -m 120 "$BASE/__computer/start")"
      sleep 3
      start_relay workerd-s1-tunnel-repro-Computer
      via=http://127.0.0.1:18080
    fi
    for mode in ${MODES:-$MODES_MIN}; do
      echo "=== mode $(curl -s -m 10 -X POST "$BASE/__mode?m=$mode") via $via"
      before=$(wc -l <"$LOGS/dev.log")
      docker run --rm --network host -v "$HERE/handshake-probe.py:/probe.py:ro" --entrypoint python3 \
        "$IMAGE" -I /probe.py "${via/http:/ws:}/v1/hosts/$(newid)/tunnel"
      host_online "${via/127.0.0.1/omnigent.internal}" "$(newid)"
      sleep 2
      worker_lines "$before"
    done
    if [ -n "${RELAY:-}" ]; then kill "$RELAY"; fi
    ;;
  harness)
    echo "server up: $(curl -s -m 200 "$BASE/__up")"
    for mode in ${MODES:-$MODES_S1}; do
      echo "=== deployment mode $(curl -s -m 120 "$BASE/__computer/start?mode=$mode")"
      sleep 3
      start_relay workerd-s1-harness-S1Computer
      before=$(wc -l <"$LOGS/dev.log")
      echo "tunnel probe (X-S1-WS-Mode: $mode):"
      docker run --rm --network host -v "$HERE/../computer/s1-tunnel-probe.py:/probe.py:ro" \
        --entrypoint python3 "$IMAGE" -I /probe.py "ws://127.0.0.1:18080/v1/hosts/$(newid)/tunnel" "$mode" |
        python3 -I -c 'import json, sys
p = json.load(sys.stdin); r = p["raw"]; l = p["lib"]
ext = [v for n, v in r["headers"] if n.lower() == "sec-websocket-extensions"]
print("  ok", p["ok"], "| raw:", r["status"], "acceptOk", r["acceptOk"], "extensions", ext)
print("  lib: accepted", l["accepted"], "error", l["error"], "reply", json.dumps(l["reply"])[:150])'
      host_online http://omnigent.internal:18080 "$(newid)"
      sleep 2
      worker_lines "$before"
      kill "$RELAY"
    done
    ;;
  fake-egress)
    for scenario in ${SCENARIOS:-bad-accept bad-extension drop-after-101 close-at-once}; do
      python3 -I "$HERE/fake-egress.py" 18090 "$scenario" >"$LOGS/fake-$scenario.log" 2>&1 &
      fake=$!
      sleep 1
      echo "=== scenario $scenario"
      docker rm -f s1r-host >/dev/null 2>&1
      docker run -d --name s1r-host --network host --add-host omnigent.internal:127.0.0.1 \
        -e OMNIGENT_HOST_ID="$(newid)" -e OMNIGENT_HOST_NAME=s1-repro --entrypoint omnigent "$IMAGE" \
        host --server http://omnigent.internal:18090 --non-interactive --no-open >/dev/null
      sleep 25
      head -12 "$LOGS/fake-$scenario.log"
      echo "host's reasons:"
      docker exec s1r-host sh -c 'grep -h "Host tunnel disconnected" /root/.omnigent/logs/host/*.log | sed -E "s/^.*disconnected: //" | sort | uniq -c | head -5'
      docker rm -f s1r-host >/dev/null 2>&1
      kill "$fake"
    done
    ;;
  *)
    sed -n '2,20p' "$0"
    exit 2
    ;;
esac
