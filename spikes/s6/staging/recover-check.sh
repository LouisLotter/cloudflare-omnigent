#!/bin/bash
# Spike S6: check the failure path of the staging session with the fake CLIs. A session that
# stops after sign-in must refuse a new start and a wipe while a login remains, and Recover must
# sign out and verify it in a fresh computer, after which the wipe succeeds.
#
#   bash spikes/s6/staging/recover-check.sh http://127.0.0.1:18786 spikes/s6/results/staging-local-recover.jsonl
set -uo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
phase() { curl -sS -X POST -H "Origin: $BASE" -H "X-S6-Request: 1" "$BASE/api/phase?name=$1&fake=1" --max-time 1800 | tee -a "$OUT" | tail -1; }
last_ok() { python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get("done") else 1)'; }
fail() { echo "FAILED: $1" >&2; exit 1; }
phase start | last_ok || fail "start"
phase fake-sign-in | last_ok || fail "fake-sign-in"
phase after-sign-in | last_ok || fail "after-sign-in"
phase stop | last_ok || fail "stop"
# A login remains in the latest checkpoint: start and wipe must refuse.
phase start | last_ok && fail "start was allowed while signed in"
phase wipe | last_ok && fail "wipe was allowed while signed in"
phase recover | last_ok || fail "recover"
phase wipe | last_ok || fail "wipe after recover"
echo "recover check passed" >&2
