#!/bin/bash
# Dry run of the staging owner session with the fake CLIs, against `wrangler dev` (local) or a
# reachable deployment. Runs every phase in order with fake=1, keeps the masked stream, and
# fails unless every phase completes with every step passing, D is signed out, and the wipe
# leaves no stored object.
#
#   bash spikes/s6/staging/dryrun.sh http://127.0.0.1:18786 spikes/s6/results/staging-local-dryrun.jsonl
set -euo pipefail
BASE=${1:?base URL}
OUT=${2:?output file}
: > "$OUT"
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)
for phase in selftest start fake-sign-in after-sign-in restore-b restore-c-sign-out restore-d wipe; do
  echo "phase $phase" >&2
  curl -sS -X POST -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -H "X-S6-Intent: $TOKEN" "$BASE/api/phase?name=$phase&fake=1" --max-time 1800 > "$OUT.part"
  cat "$OUT.part" >> "$OUT"
  python3 -I - "$OUT.part" "$phase" <<'EOF'
import json, sys
lines = [json.loads(x) for x in open(sys.argv[1]) if x.strip()]
phase = sys.argv[2]
errors = [x for x in lines if "error" in x or x.get("ok") is False]
done = [x for x in lines if x.get("done")]
if errors or not done:
    print(f"phase {phase} FAILED: {errors[:1] or 'no completion line'}", file=sys.stderr)
    sys.exit(1)
if phase == "wipe":
    assert done[-1]["state"]["objects"] == 0, "objects left after wipe"
print(f"phase {phase} ok ({len(lines)} lines)", file=sys.stderr)
EOF
done
rm -f "$OUT.part"
# Refusals: a request from another origin, and one without the request-intent token.
code1=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://attacker.invalid" -H "X-S6-Intent: $TOKEN" "$BASE/api/phase?name=stop")
code2=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" "$BASE/api/phase?name=stop")
echo "{\"cross_origin_phase\": $code1, \"missing_token_phase\": $code2}" >&2
[ "$code1" = 403 ] && [ "$code2" = 403 ]
curl -sS "$BASE/api/state" >&2
echo >&2
