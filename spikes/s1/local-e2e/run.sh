#!/usr/bin/env bash
# Local end-to-end run of S1's backup and restore-wake phases (see driver.mjs). Needs Docker,
# `npm ci --prefix spikes/s1`, and the computer image built as cfo-s1/computer:local:
#   docker build -t cfo-s1/computer:local spikes/s1/computer
#
#   spikes/s1/local-e2e/run.sh <out.jsonl> [S1_COMMAND]
#   e.g. spikes/s1/local-e2e/run.sh spikes/s1/results/local-e2e-restore.jsonl \
#          e2e:backup-small,rwake-small=3,backup-medium,rwake-medium=5
set -euo pipefail

OUT=$(realpath -m "$1")
COMMAND=${2:-e2e:backup-small,rwake-small=3,backup-medium,rwake-medium=5}
HERE=$(cd "$(dirname "$0")" && pwd)
S1=$(dirname "$HERE")
NET=s1-e2e
PORT=18104
R2=$(mktemp -d /tmp/s1-e2e-r2.XXXXXX)
SERVER=ghcr.io/omnigent-ai/omnigent-server:v0.17.0@sha256:101474ecb299d45aacf49cb01051cc2cc5392ee6a6d30879d72c55bf346af3c3
IMAGE=${S1E2E_IMAGE:-cfo-s1/computer:local}

cleanup() {
  docker rm -f s1-e2e-computer s1-e2e-gateway s1-e2e-server >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The gateway container wrote part files as root; remove them from inside a container.
  docker run --rm -v "$R2:/r2" "$IMAGE" rm -rf /r2/objects /r2/uploads >/dev/null 2>&1 || true
  rm -rf "$R2"
}
trap cleanup EXIT
cleanup_start() { docker rm -f s1-e2e-computer s1-e2e-gateway s1-e2e-server >/dev/null 2>&1 || true; }
cleanup_start
docker network create "$NET" >/dev/null

docker run -d --name s1-e2e-server --network "$NET" --network-alias omnigent.internal \
  -p "127.0.0.1:$PORT:80" -e DATABASE_URL=sqlite:////tmp/omnigent.db \
  -e OMNIGENT_AUTH_ENABLED=0 -e PORT=80 "$SERVER" >/dev/null
docker run -d --name s1-e2e-gateway --network "$NET" --network-alias backups.sandbox.internal \
  -v "$S1:/s1:ro" -v "$R2:/r2" -e R2_ROOT=/r2 "$IMAGE" \
  node --import /s1/local-e2e/hooks.mjs /s1/local-e2e/gateway-server.mjs >/dev/null
until curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do sleep 0.5; done

R2_ROOT=$R2 S1E2E_SERVER_URL="http://127.0.0.1:$PORT" S1E2E_COMMAND=$COMMAND \
  S1E2E_OUT=$OUT S1E2E_NETWORK=$NET S1E2E_IMAGE=$IMAGE \
  node --import "$HERE/hooks.mjs" "$HERE/driver.mjs"
echo "gateway log:" >&2
docker logs --tail 20 s1-e2e-gateway >&2 || true
