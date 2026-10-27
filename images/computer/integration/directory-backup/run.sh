#!/usr/bin/env bash
# Local DirectoryBackup round trip of the computer image's layers (see roundtrip.mjs).
# Needs Docker, the built image, and `npm ci --prefix images/computer/integration/directory-backup`.
#
#   images/computer/integration/directory-backup/run.sh <image> <result.json>
set -euo pipefail
IMAGE=$1
OUT=$(realpath -m "$2")
HERE=$(cd "$(dirname "$0")" && pwd)
TAG=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
NET=cfo-wp34-rt-$TAG
GATEWAY_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
SCRATCH=${RT_SCRATCH:-$HOME/.cache/cfo-wp34-rt}
mkdir -p "$SCRATCH"
R2=$(mktemp -d "$SCRATCH/r2.XXXXXX")
cleanup() {
  docker rm -f "cfo-wp34-rt-gw-$TAG" "cfo-wp34-rt-a-$TAG" "cfo-wp34-rt-b-$TAG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The gateway container wrote part files as root; remove them from inside a container.
  docker run --rm -v "$R2:/r2" "$GATEWAY_IMAGE" rm -rf /r2/objects /r2/uploads /r2/grant.json /r2/fail-parts >/dev/null 2>&1 || true
  rm -rf "$R2"
}
trap cleanup EXIT
docker network create "$NET" >/dev/null
docker run -d --name "cfo-wp34-rt-gw-$TAG" --network "$NET" --network-alias backups.sandbox.internal \
  -v "$HERE:/h:ro" -v "$R2:/r2" -e R2_ROOT=/r2 "$GATEWAY_IMAGE" \
  node --import /h/hooks.mjs /h/gateway-server.mjs >/dev/null
RT_IMAGE=$IMAGE RT_NETWORK=$NET RT_R2=$R2 RT_OUT=$OUT RT_TAG=$TAG \
  node --import "$HERE/hooks.mjs" "$HERE/roundtrip.mjs"
