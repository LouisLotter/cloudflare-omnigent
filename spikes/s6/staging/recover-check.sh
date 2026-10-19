#!/bin/bash
# Spike S6: check the failure paths of the staging session with the fake CLIs.
#
#   1. Signed in, the watcher fails to start, then the first credential checkpoint fails: each
#      time the phase stops and the computer, which holds the only copy of the login, keeps
#      running. Start and Wipe refuse.
#   2. Recover with every logout failing: Recover stops without destroying anything.
#   3. Recover: signs out in the running computer, checkpoints that, and verifies the sign-out in
#      a fresh computer. Wipe then succeeds and leaves no object.
#   4. A session that stops after a successful checkpoint: Recover signs out from the checkpoint.
#
#   bash spikes/s6/staging/recover-check.sh http://127.0.0.1:18786 spikes/s6/results/staging-local-recover.jsonl
set -uo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)
phase() { # $1 name, $2 extra query; prints the last line
  curl -sS -X POST -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -H "X-S6-Intent: $TOKEN" "$BASE/api/phase?name=$1&fake=1$2" --max-time 1800 | tee -a "$OUT" | tail -1
}
done_ok() { python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read()); sys.exit(0 if d.get("done") else 1)'; }
running() { curl -sS "$BASE/api/state" | python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["running"] else 1)'; }
fail() { echo "FAILED: $1" >&2; exit 1; }

# 1
phase start "" | done_ok || fail "start"
phase fake-sign-in "" | done_ok || fail "fake-sign-in"
phase after-sign-in "&fail=watch" | done_ok && fail "after-sign-in should stop when the watcher does not start"
running || fail "the signed-in computer was destroyed after a watcher failure"
phase after-sign-in "&fail=capture" | done_ok && fail "after-sign-in should fail at its first checkpoint"
running || fail "the signed-in computer was destroyed after a failed checkpoint"
phase start "" | done_ok && fail "start allowed while a computer runs"
phase wipe "" | done_ok && fail "wipe allowed while a computer runs"
# 2
phase recover "&fail=logout" | done_ok && fail "recover should fail when logout fails"
running || fail "the signed-in computer was destroyed after a failed logout"
# 3
phase recover "" | done_ok || fail "recover"
running && fail "recover left a computer running"
phase wipe "" | done_ok || fail "wipe after recover"
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)  # a wipe creates a new token
# 4
phase start "" | done_ok || fail "start (second session)"
phase fake-sign-in "" | done_ok || fail "fake-sign-in (second session)"
phase after-sign-in "" | done_ok || fail "after-sign-in (second session)"
phase stop "" | done_ok || fail "stop"
phase start "" | done_ok && fail "start allowed while the checkpoint holds a login"
phase wipe "" | done_ok && fail "wipe allowed while the checkpoint holds a login"
phase recover "" | done_ok || fail "recover from the checkpoint"
phase wipe "" | done_ok || fail "wipe after the second recover"
curl -sS "$BASE/api/state" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d["objects"] == 0 and not d["running"] else 1)' \
  || fail "objects left or a computer running at the end"
echo "recover check passed" >&2
