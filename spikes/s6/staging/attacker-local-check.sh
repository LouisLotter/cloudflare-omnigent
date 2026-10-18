#!/bin/bash
# Spike S6: run the qualification attacker page in headless Chromium against `wrangler dev`, to
# check the page's mechanics before the owner uses it on the deployment. A synthetic computer is
# started, the browser first visits the S6 page (so it holds the terminal cookie, as the owner's
# would), then the attacker page; the boundary log and the state must show only refusals.
# Locally there is no Access in front, so this does not replace the deployed qualification.
#
#   bash spikes/s6/staging/attacker-local-check.sh http://127.0.0.1:18786 http://127.0.0.1:8086 out.json
set -uo pipefail
BASE=${1:?S6 base URL}
ATTACKER=${2:?attacker page base URL}
OUT=${3:?output file}
PROFILE=$(mktemp -d)
CHROME=$(command -v chromium || command -v google-chrome-stable)
TOKEN=$(curl -sS "$BASE/" | grep -o 'data-intent="[0-9a-f]*"' | head -1 | cut -d'"' -f2)
post() { curl -sS -X POST -H "Origin: $BASE" -H "Sec-Fetch-Site: same-origin" -H "X-S6-Intent: $TOKEN" "$BASE/api/phase?name=$1&fake=1" | tail -1; }
post start > /dev/null
before=$(curl -sS "$BASE/api/state")
"$CHROME" --headless=new --no-first-run --disable-gpu --user-data-dir="$PROFILE" --virtual-time-budget=4000 --dump-dom "$BASE/" > /dev/null 2>&1
"$CHROME" --headless=new --no-first-run --disable-gpu --user-data-dir="$PROFILE" --virtual-time-budget=8000 --dump-dom "$ATTACKER/#$BASE" > "$PROFILE/attacker.html" 2>/dev/null
"$CHROME" --headless=new --no-first-run --disable-gpu --user-data-dir="$PROFILE" --virtual-time-budget=4000 --dump-dom "$BASE/api/phase?name=stop&fake=1&case=foreign-top-level-get" > "$PROFILE/confirm.html" 2>/dev/null
after=$(curl -sS "$BASE/api/state")
boundary=$(curl -sS "$BASE/api/boundary")
python3 -I - "$PROFILE/attacker.html" "$PROFILE/confirm.html" "$OUT" "$before" "$after" "$boundary" <<'EOF'
import html, json, re, sys
attacker, confirm, out, before, after, boundary = sys.argv[1:7]
page = open(attacker).read()
attempts = [html.unescape(x) for x in re.findall(r"<li>([^<]*)</li>", page.split('id="log"', 1)[-1])]
b, a = json.loads(before), json.loads(after)
same = all(b[k] == a[k] for k in ("running", "generation", "pointers", "objects"))
res = {
    "attacker_page_log": attempts,
    "top_level_get_showed_confirmation": "changes nothing" in open(confirm).read(),
    "state_unchanged": same,
    "running": a["running"],
    "boundary_log": [{k: r[k] for k in ("method", "path", "case_tag", "origin", "fetch_site", "reason")} for r in json.loads(boundary)],
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print(json.dumps({"attempts": len(attempts), "refusals_logged": len(res["boundary_log"]), "state_unchanged": same,
                  "top_level_get_showed_confirmation": res["top_level_get_showed_confirmation"]}))
# Seven tagged attempts reach a local Worker (no Access in front); all must be refused.
sys.exit(0 if same and res["top_level_get_showed_confirmation"] and len(res["boundary_log"]) >= 7 else 1)
EOF
rc=$?
post recover > /dev/null
post wipe > /dev/null
rm -rf "$PROFILE"
exit $rc
