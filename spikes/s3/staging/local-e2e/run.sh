#!/usr/bin/env bash
# Local end-to-end run of the S3 staging campaign (see driver.mjs). Needs Docker,
# `npm ci --prefix spikes/s3/staging`, and the spike image built as cfo-s3-computer:stg:
#   python3 spikes/s3/bench/prepare_staging.py && docker build -t cfo-s3-computer:stg spikes/s3/image
#
#   spikes/s3/staging/local-e2e/run.sh <out-dir> [quick|full]
# Writes <out-dir>/log.jsonl (the Worker's log lines) and <out-dir>/results/*.json.
set -euo pipefail

OUTDIR=$(realpath -m "$1")
PLAN=${2:-quick}
HERE=$(cd "$(dirname "$0")" && pwd)
STAGING=$(dirname "$HERE")
NET=cfo-s3stg-e2e
GATEWAY_IMAGE=node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
IMAGE=${S3E2E_IMAGE:-cfo-s3-computer:stg}
TMPROOT=${S3E2E_TMP:-$HOME/.cache/cfo-s3-e2e}
mkdir -p "$TMPROOT" "$OUTDIR/results"
R2=$(mktemp -d "$TMPROOT/r2.XXXXXX")

cleanup() {
  docker rm -f cfo-s3stg-e2e-box cfo-s3stg-e2e-gateway >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  # The gateway container wrote part files as root; remove them from inside a container.
  docker run --rm -v "$R2:/r2" "$GATEWAY_IMAGE" rm -rf /r2/objects /r2/uploads /r2/grant.json /r2/holds.json \
    >/dev/null 2>&1 || true
  rm -rf "$R2"
}
trap cleanup EXIT
docker rm -f cfo-s3stg-e2e-box cfo-s3stg-e2e-gateway >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create "$NET" >/dev/null
docker run -d --name cfo-s3stg-e2e-gateway --network "$NET" --network-alias backups.sandbox.internal \
  -v "$STAGING:/s3:ro" -v "$R2:/r2" -e R2_ROOT=/r2 "$GATEWAY_IMAGE" \
  node --import /s3/local-e2e/hooks.mjs /s3/local-e2e/gateway-server.mjs >/dev/null

R2_ROOT=$R2 S3E2E_OUT="$OUTDIR/log.jsonl" S3E2E_PLAN=$PLAN S3E2E_NETWORK=$NET S3E2E_IMAGE=$IMAGE \
  node --import "$HERE/hooks.mjs" "$HERE/driver.mjs"
for f in "$R2"/objects/results%2F*; do
  [ -e "$f" ] || continue
  name=$(basename "$f" | sed 's/^results%2F[^%]*%2F//')
  cp "$f" "$OUTDIR/results/$name"
done
echo "gateway log:" >&2
docker logs --tail 20 cfo-s3stg-e2e-gateway >&2 || true
