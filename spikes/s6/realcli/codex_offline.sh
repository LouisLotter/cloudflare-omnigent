#!/bin/bash
# Real Codex binary, synthetic login, no network (spike S6).
#
# Runs inside the S6 image with --network none. A fake issuer on loopback stands in for
# auth.openai.com, so the unmodified Codex CLI performs its real device-code login, a real
# token refresh and a real logout, and we record exactly how it writes ~/.codex/auth.json.
# Output: /out/codex-offline.json (masked: paths, modes, sizes, key names, timestamps only).
set -euo pipefail
OUT=${OUT:-/out}
S6=/opt/s6
WORK=$(mktemp -d)
ISSUER=http://127.0.0.1:8765
AUDIT="python3 -I $S6/credsync/cli.py audit --home $HOME --state /var/lib/s6/audit-codex.json"

python3 -I "$S6/realcli/fake_openai_issuer.py" --port 8765 --log "$WORK/issuer.jsonl" --access-ttl 120 &
ISSUER_PID=$!
inotifywait -m -r -q --format '%T %e %w%f' --timefmt '%s' "$HOME" -o "$WORK/inotify.log" &
INOTIFY_PID=$!
sleep 1

export CODEX_REFRESH_TOKEN_URL_OVERRIDE=$ISSUER/oauth/token
export CODEX_REVOKE_TOKEN_URL_OVERRIDE=$ISSUER/oauth/revoke
step() { echo "$(date +%s.%N) STEP $1" >> "$WORK/inotify.log"; }

$AUDIT --label "before login" --out "$WORK/a0.json"

step login
set +e
timeout 60 codex login --device-auth --experimental_issuer "$ISSUER" > "$WORK/login.out" 2>&1
LOGIN_RC=$?
codex login status > "$WORK/status1.out" 2>&1
STATUS1_RC=$?
set -e
sleep 0.5
$AUDIT --label "after device-code login" --out "$WORK/a1.json"

# Refresh: the access token expires in 120 s, inside Codex's 5-minute refresh window, so the
# next authenticated command refreshes first. Model traffic goes to the fake issuer and fails.
step refresh
set +e
timeout 25 codex exec --skip-git-repo-check -c "chatgpt_base_url=\"$ISSUER/backend-api/\"" "reply ok" > "$WORK/exec.out" 2>&1
EXEC_RC=$?
set -e
sleep 0.5
$AUDIT --label "after refresh (codex exec)" --out "$WORK/a2.json"
grep -rl --exclude-dir=.cache "CFO_""CANARY_" "$HOME" 2>/dev/null | sed "s|^$HOME|~|" > "$WORK/canary-files-logged-in.txt" || true

# A forced refresh through the app-server, as the owner session will do with a real login.
step forced-refresh
set +e
python3 -I "$S6/realcli/codex_force_refresh.py" --timeout 30 > "$WORK/force.out" 2>&1
FORCE_RC=$?
set -e
sleep 0.5
$AUDIT --label "after forced refresh (app-server account/read)" --out "$WORK/a5.json"

step login-again
set +e
timeout 60 codex login --device-auth --experimental_issuer "$ISSUER" > "$WORK/login2.out" 2>&1
LOGIN2_RC=$?
set -e
sleep 0.5
$AUDIT --label "after second login (Codex logs out first)" --out "$WORK/a3.json"

step logout
set +e
codex logout > "$WORK/logout.out" 2>&1
LOGOUT_RC=$?
codex login status > "$WORK/status2.out" 2>&1
STATUS2_RC=$?
set -e
sleep 0.5
$AUDIT --label "after logout" --out "$WORK/a4.json"
# Which files hold login material? The synthetic tokens carry the canary prefix; list the files
# (names only) that contain it, anywhere under the home directory.
grep -rl --exclude-dir=.cache "CFO_""CANARY_" "$HOME" 2>/dev/null | sed "s|^$HOME|~|" > "$WORK/canary-files-binary.txt" || true
step end
sleep 0.3
kill $INOTIFY_PID $ISSUER_PID 2>/dev/null || true

python3 -I - "$WORK" "$OUT/codex-offline.json" <<EOF
import json, sys, re
work, out = sys.argv[1], sys.argv[2]
def lines(p):
    try: return open(p).read().splitlines()
    except FileNotFoundError: return []
home = "$HOME"
events = []
for l in lines(f"{work}/inotify.log"):
    if " STEP " in l:
        events.append({"step": l.split(" STEP ")[1]}); continue
    t, ev, path = l.split(" ", 2)
    path = path.replace(home, "~")
    if "/.codex" in path or path.endswith("~/.codex"):
        if not path.endswith("/auth.json") and not any(k in ev for k in ("CREATE", "DELETE", "MOVED")):
            continue  # keep every event on auth.json, and only creates, deletes and renames elsewhere
        if ev.startswith(("OPEN", "ACCESS", "CLOSE_NOWRITE")):
            continue  # reads
        e = {"event": ev, "path": path}
        if events and {k: events[-1].get(k) for k in ("event", "path")} == e:
            events[-1]["repeat"] = events[-1].get("repeat", 1) + 1
        else:
            events.append(e)
def first_line(p):
    l = lines(p)
    # Status lines only; never the device-code prompt's code or URL.
    return [re.sub(r"https?://\S+", "<url>", x) for x in l if "Logged in" in x or "Not logged in" in x or "Successfully" in x or "logged out" in x.lower()][:3]
res = {
  "codex_version": "$(codex --version 2>/dev/null)",
  "network": "none (loopback fake issuer only)",
  "exit_codes": {"login": $LOGIN_RC, "status_after_login": $STATUS1_RC, "exec_refresh": $EXEC_RC, "forced_refresh": $FORCE_RC, "login_again": $LOGIN2_RC, "logout": $LOGOUT_RC, "status_after_logout": $STATUS2_RC},
  "status_lines": {"after_login": first_line(f"{work}/status1.out"), "after_logout": first_line(f"{work}/status2.out"), "logout": first_line(f"{work}/logout.out")},
  "login_prompt_seen": any("one-time code" in x for x in lines(f"{work}/login.out")),
  "issuer_requests": [json.loads(x) for x in lines(f"{work}/issuer.jsonl")],
  "inotify": events,
  "files_holding_canary_while_logged_in": lines(f"{work}/canary-files-logged-in.txt"),
  "files_holding_canary_after_logout": lines(f"{work}/canary-files-binary.txt"),
  "forced_refresh_result": (lines(f"{work}/force.out") or [""])[-1],
  "audits": [json.load(open(f"{work}/a{i}.json")) for i in (0, 1, 2, 5, 3, 4)],
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print("wrote", out)
EOF
chown "${OUT_UID:-0}:${OUT_GID:-0}" "$OUT/codex-offline.json"
rm -rf "$WORK"
