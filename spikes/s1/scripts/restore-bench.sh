#!/usr/bin/env bash
# S1 local restore measurement: the directory-backup format (tar + zstd, SHA-256 checked) restored
# into the S1 computer image, limited to one vCPU and 6 GiB like standard-2. The archive is served
# over HTTP from a second local container, standing in for the R2 gateway; local transfer is far
# faster than the gateway can be, so these numbers are the extraction floor, not the cloud time.
#
#   spikes/s1/scripts/restore-bench.sh <repo-copy> <work-dir> <runs> [sizes...] > results.jsonl
#
# Needs Docker and the image cfo-s1/computer:local (docker build spikes/s1/computer).
set -euo pipefail

REPO=$1
WORK=$2
RUNS=${3:-5}
shift 3 || true
SIZES=("${@:-small medium large}")
[ ${#SIZES[@]} -eq 1 ] && read -r -a SIZES <<<"${SIZES[0]}"
HERE=$(cd "$(dirname "$0")" && pwd)
NET=s1-restore-net
CPUS=${CPUS:-1}

mkdir -p "$WORK"
docker build -q -t cfo-s1/restore-bench:local -f - "$HERE" >/dev/null <<'EOF'
FROM cfo-s1/computer:local
RUN apt-get update && apt-get install -y --no-install-recommends zstd && rm -rf /var/lib/apt/lists/*
EOF

docker network create "$NET" >/dev/null 2>&1 || true
docker rm -f s1-restore-http >/dev/null 2>&1 || true
docker run -d --name s1-restore-http --network "$NET" -v "$WORK:/srv:ro" \
  cfo-s1/restore-bench:local python3 -m http.server 8080 --directory /srv >/dev/null
trap 'docker rm -f s1-restore-http >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1' EXIT

for size in "${SIZES[@]}"; do
  src="$WORK/ws-$size"
  archive="$WORK/ws-$size.tar.zst"
  if [ ! -d "$src" ]; then
    python3 -I "$HERE/make-workspace.py" "$REPO" "$src" "$size"
  fi
  if [ ! -f "$archive" ]; then
    t0=$(date +%s%3N)
    tar -C "$src" -cf - . | zstd -q -3 -T0 -o "$archive"
    t1=$(date +%s%3N)
    echo "{\"s1\":\"archive\",\"size\":\"$size\",\"createMs\":$((t1 - t0))}" >&2
  fi
  raw=$(du -sb "$src" | cut -f1)
  files=$(find "$src" -type f | wc -l)
  packed=$(stat -c %s "$archive")
  sum=$(sha256sum "$archive" | cut -d' ' -f1)
  for run in $(seq 1 "$RUNS"); do
    out=$(docker run --rm --network "$NET" --cpus="$CPUS" --memory=6g \
      -e URL="http://s1-restore-http:8080/ws-$size.tar.zst" -e SUM="$sum" \
      --entrypoint /bin/bash cfo-s1/restore-bench:local -c '
        set -euo pipefail
        mkdir -p /restore.new
        t0=$(date +%s%3N)
        curl -fsS "$URL" -o /tmp/ws.tar.zst
        t1=$(date +%s%3N)
        echo "$SUM  /tmp/ws.tar.zst" | sha256sum -c --quiet
        t2=$(date +%s%3N)
        zstd -q -d -c /tmp/ws.tar.zst | tar -x -C /restore.new
        mv /restore.new /restore
        t3=$(date +%s%3N)
        echo "$((t1 - t0)) $((t2 - t1)) $((t3 - t2))"')
    read -r download verify extract <<<"$out"
    echo "{\"s1\":\"restore\",\"size\":\"$size\",\"run\":$run,\"cpus\":$CPUS,\"rawBytes\":$raw,\"files\":$files,\"archiveBytes\":$packed,\"downloadMs\":$download,\"verifyMs\":$verify,\"extractMs\":$extract,\"totalMs\":$((download + verify + extract))}"
  done
done
