#!/bin/bash
# Spike S6, IR-013: an ordinary Stop must not destroy a computer whose final credential
# checkpoint failed. With the fake CLIs, signed in, inject each failure into Stop's final
# checkpoint (before export, export, upload, publication) and check that the phase fails, the
# computer keeps running and the state says what to do. Then the controls: a Stop without a
# failure stops; a force-stop stops but records that credentials may be lost.
#
#   bash spikes/s6/staging/stop-capture-check.sh http://127.0.0.1:18786 spikes/s6/results/ir013-stop-check.jsonl
set -uo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)
phase() { # $1 name, $2 extra query; prints the last line
  curl -sS -X POST -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -H "X-S6-Request: 1" -H "X-S6-Intent: $TOKEN" \
    "$BASE/api/phase?name=$1&fake=1$2" --max-time 1800 | tee -a "$OUT" | tail -1
}
done_ok() { python3 -I -c 'import json,sys; d=json.loads(sys.stdin.read() or "{}"); sys.exit(0 if d.get("done") else 1)'; }
running() { curl -sS "$BASE/api/state" | python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["running"] else 1)'; }
state_field() { curl -sS "$BASE/api/state" | python3 -I -c "import json,sys; print(json.load(sys.stdin).get('$1'))"; }
failures=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }

phase start "" | done_ok || { echo "setup: start failed"; exit 2; }
phase fake-sign-in "" | done_ok || { echo "setup: sign-in failed"; exit 2; }
for f in capture export store publish; do
  r=$(phase stop "&fail=$f")
  check "stop with a failed final checkpoint ($f) is refused" '! echo "$r" | done_ok'
  check "the computer keeps running after the refused stop ($f)" 'running'
  check "the state names the unsaved computer ($f)" '[ "$(state_field unsaved_computer)" = "True" ]'
done
r=$(phase stop "")
check "a stop with a published final checkpoint succeeds" 'echo "$r" | done_ok'
check "and the computer is stopped" '! running'
check "and the state no longer reports an unsaved computer" '[ "$(state_field unsaved_computer)" != "True" ]'
# The saved login must be signed out (Recover) and wiped before a new computer may start.
phase recover "" > /dev/null
phase wipe "" > /dev/null
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)  # new after a wipe
phase start "" > /dev/null
phase fake-sign-in "" > /dev/null
check "a signed-in computer runs before the force-stop" 'running'
r=$(phase force-stop "&confirm=credentials-may-be-lost")
check "force-stop stops the computer" 'echo "$r" | done_ok && ! running'
check "force-stop records that credentials may be lost" '[ "$(state_field credentials_may_be_lost)" = "True" ]'
r=$(phase force-stop "")
check "force-stop without its confirmation is refused" '! echo "$r" | done_ok'
phase recover "" > /dev/null
phase wipe "" > /dev/null
echo "failures: $failures"
[ "$failures" = 0 ]
