#!/bin/bash
# Dry run of the staging owner session with the fake CLIs, against `wrangler dev` (local) or a
# reachable deployment. Runs every phase in order with fake=1 and keeps the masked stream.
#
#   bash spikes/s6/staging/dryrun.sh http://127.0.0.1:18786 spikes/s6/results/staging-local-dryrun.jsonl
set -euo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
for phase in selftest start fake-sign-in after-sign-in restore-b restore-c-sign-out restore-d wipe; do
  echo "phase $phase" >&2
  curl -sS -X POST "$BASE/api/phase?name=$phase&fake=1" --max-time 1800 >> "$OUT"
done
curl -sS "$BASE/api/state" >&2
echo >&2
