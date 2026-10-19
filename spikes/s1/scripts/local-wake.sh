#!/usr/bin/env bash
# S1 local reference: time from `docker run` of the computer image to "host online" in a local
# Omnigent server, with the computer limited to one vCPU and 6 GiB like standard-2. With
# RESTORE=<size>, the container first restores that workspace archive (see restore-bench.sh)
# and only then starts the host, as the design orders the wake.
#
#   spikes/s1/scripts/local-wake.sh <runs> [image] > results.jsonl
#   RESTORE=medium WORK=/tmp/s1-restore spikes/s1/scripts/local-wake.sh 5 cfo-s1/restore-bench:local
set -euo pipefail

RUNS=${1:-10}
IMAGE=${2:-cfo-s1/computer:local}
NET=s1-wake-net
PORT=18102
SERVER=ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f s1-wake-server s1-wake-host s1-wake-http >/dev/null 2>&1 || true
cleanup() {
  docker rm -f s1-wake-server s1-wake-host s1-wake-http >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name s1-wake-server --network "$NET" -p "127.0.0.1:$PORT:8000" \
  -e DATABASE_URL=sqlite:////tmp/omnigent.db -e OMNIGENT_AUTH_ENABLED=0 "$SERVER" >/dev/null
until curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do sleep 0.5; done

CMD=(omnigent host --server http://s1-wake-server:8000 --non-interactive --no-open)
if [ -n "${RESTORE:-}" ]; then
  docker run -d --name s1-wake-http --network "$NET" -v "$WORK:/srv:ro" \
    "$IMAGE" python3 -m http.server 8080 --directory /srv >/dev/null
  sleep 2
  CMD=(/bin/bash -c "mkdir -p /restore.new && curl -fsS http://s1-wake-http:8080/ws-$RESTORE.tar.zst | zstd -q -d | tar -x -C /restore.new && mv /restore.new /restore && exec omnigent host --server http://s1-wake-server:8000 --non-interactive --no-open")
fi

host_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
for run in $(seq 1 "$RUNS"); do
  docker rm -f s1-wake-host >/dev/null 2>&1 || true
  # Wait until the server has noticed the previous host left.
  for _ in $(seq 1 120); do
    st=$(curl -fsS "http://127.0.0.1:$PORT/v1/hosts/$host_id" 2>/dev/null |
      python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null || echo absent)
    [ "$st" != online ] && break
    sleep 0.5
  done
  t0=$(date +%s%3N)
  docker run -d --name s1-wake-host --network "$NET" --cpus=1 --memory=6g \
    -e OMNIGENT_HOST_ID="$host_id" -e OMNIGENT_HOST_NAME=s1-local "$IMAGE" "${CMD[@]}" >/dev/null
  status=timeout
  while [ $(($(date +%s%3N) - t0)) -lt 180000 ]; do
    st=$(curl -fsS "http://127.0.0.1:$PORT/v1/hosts/$host_id" 2>/dev/null |
      python3 -c 'import sys,json; print(json.load(sys.stdin)["status"])' 2>/dev/null || echo absent)
    if [ "$st" = online ]; then status=online; break; fi
    sleep 0.1
  done
  t1=$(date +%s%3N)
  echo "{\"s1\":\"local-wake\",\"run\":$run,\"image\":\"$IMAGE\",\"restore\":\"${RESTORE:-none}\",\"cpus\":1,\"status\":\"$status\",\"onlineMs\":$((t1 - t0))}"
done
