#!/bin/bash
# Spike S6 follow-up: the Part 2 sequence with the fake CLIs, against `wrangler dev` with fault
# injection on (`--var S6_ALLOW_INJECTION:1`), including Cloudflare's refusal of a start right
# after a stop (DC-37) and the planned-stop record (DC-38), as on 19 Oct when computer B failed:
#
#   1. Start A, synthetic sign-in, After sign-in: the conversations for B to resume (VD-09) and
#      the key reports (DC-45) run.
#   2. Computer B with its first two starts refused: B starts on the third attempt, within the
#      design's retry budget, and resumes A's conversations from W1.
#   3. Computer C with every start refused: C fails as "could not start", after seven attempts,
#      and nothing is recorded as lost (19 Oct: "stopped unexpectedly", C, D and Wipe locked).
#   4. Computer C clicked again: it starts, signs out. D restores signed out. Wipe leaves nothing.
#
#   bash spikes/s6/staging/followup-dryrun.sh http://127.0.0.1:18786 spikes/s6/results/followup/followup-dryrun.jsonl
set -uo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)
failures=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; failures=$((failures + 1)); fi; }
phase() { # $1 name, $2 extra query; keeps the phase's lines in $LAST
  LAST=$(curl -sS -X POST -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -H "X-S6-Intent: $TOKEN" \
    "$BASE/api/phase?name=$1&fake=1$2" --max-time 1800)
  printf '%s\n' "$LAST" >> "$OUT"
}
done_ok() { printf '%s\n' "$LAST" | python3 -I -c 'import json,sys; ls=[json.loads(x) for x in sys.stdin if x.strip()]; sys.exit(0 if any(l.get("done") for l in ls) else 1)'; }
step_field() { # $1 step name, $2 python expression over the step line `s`
  printf '%s\n' "$LAST" | python3 -I -c "import json,sys
ls=[json.loads(x) for x in sys.stdin if x.strip()]
s=next((l for l in ls if l.get('step')=='''$1'''), None)
print(eval('''$2''') if s else 'missing')"
}
state_field() { curl -sS "$BASE/api/state" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(eval('''$1'''))"; }

phase start ""; check "start A" done_ok
phase fake-sign-in ""; check "synthetic sign-in" done_ok
phase after-sign-in ""; check "after sign-in" done_ok
check "A: three key reports (DC-45)" '[ "$(printf "%s\n" "$LAST" | grep -c "login values in other files, by key")" = 3 ]'
check "A: conversation for B to resume, Claude" '[ "$(step_field "claude request (a conversation for B to resume)" "s[\"ok\"]")" = True ]'
check "A: conversation for B to resume, Codex" '[ "$(step_field "codex request (a conversation for B to resume)" "s[\"ok\"]")" = True ]'

phase restore-b "&fail=refuse-start:2"; check "B with two refused starts completes" done_ok
check "B: started on the third attempt" '[ "$(step_field "start computer B" "len(s[\"attempts\"])")" = 3 ]'
check "B: within the design retry budget" '[ "$(step_field "start computer B" "s.get(\"within_design_retry_budget\")")" = True ]'
check "B: Claude resumed A's conversation from W1" '[ "$(step_field "claude resumes A'"'"'s conversation from W1" "s[\"ok\"]")" = True ]'
check "B: Codex resumed A's conversation from W1" '[ "$(step_field "codex resumes A'"'"'s conversation from W1" "s[\"ok\"]")" = True ]'

phase restore-c-sign-out "&fail=refuse-start:99"; check "C with every start refused fails" '! done_ok'
check "C: seven attempts" '[ "$(step_field "start computer C" "len(s[\"attempts\"])")" = 7 ]'
check "C: says nothing was lost" 'step_field "start computer C" "s[\"advice\"]" | grep -q "Nothing was lost"'
check "no credentials recorded as lost (DC-38)" '[ "$(state_field "d[\"credentials_may_be_lost\"]")" = False ]'
check "the stop before C is recorded with its checkpoint" '[ "$(state_field "d[\"last_stop\"][\"reason\"]")" = "before starting computer C" ]'

phase restore-c-sign-out ""; check "C clicked again completes" done_ok
phase restore-d ""; check "D restores signed out" done_ok
phase wipe ""; check "wipe" done_ok
check "nothing left after the wipe" '[ "$(state_field "d[\"objects\"]")" = 0 ]'
check "no revocation had to be recorded" '[ "$(state_field "len(d[\"revocations_confirmed\"])")" = 0 ]'
echo "failures: $failures"
[ "$failures" = 0 ]
