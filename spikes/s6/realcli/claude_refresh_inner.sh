#!/bin/bash
# Inside the container for claude_refresh_offline.sh: an expired synthetic login, one request
# that makes Claude Code refresh it, and a masked record of what happened to the login file.
set -uo pipefail
OUT=${OUT:-/out}
S6=/opt/s6
WORK=$(mktemp -d)
AUDIT="python3 -I $S6/credsync/cli.py audit --home $HOME --state /var/lib/s6/audit-claude-refresh.json"
step() { echo "$(date +%s.%N) STEP $1" >> "$WORK/inotify.log"; }

python3 -I - <<'EOF'
import json, os, secrets, time
p = os.path.expanduser("~/.claude/.credentials.json")
os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
c = "CFO_" + "CANARY_"
data = {"claudeAiOauth": {"accessToken": c + "S6access" + secrets.token_hex(12), "refreshToken": c + "S6refresh" + secrets.token_hex(12),
        "expiresAt": int((time.time() - 60) * 1000), "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
        "subscriptionType": "max"}}
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(data).encode()); os.close(fd)
EOF
inotifywait -m -r -q --format '%T %e %w%f' --timefmt '%s' "$HOME" -o "$WORK/inotify.log" &
INOTIFY_PID=$!
sleep 1
$AUDIT --label "expired synthetic login" --out "$WORK/a0.json"
step request
timeout 90 claude -p "reply ok" > "$WORK/print.out" 2>&1
RC=$?
sleep 0.5
$AUDIT --label "after the request (refresh expected)" --out "$WORK/a1.json"
grep -rl --exclude-dir=.cache "CFO_""CANARY_" "$HOME" 2>/dev/null | sed "s|^$HOME|~|" > "$WORK/canary.txt"
step logout
timeout 60 claude auth logout > "$WORK/logout.out" 2>&1
LRC=$?
sleep 0.5
$AUDIT --label "after logout" --out "$WORK/a2.json"
grep -rl --exclude-dir=.cache "CFO_""CANARY_" "$HOME" 2>/dev/null | sed "s|^$HOME|~|" > "$WORK/canary2.txt"
step end
sleep 0.3
kill $INOTIFY_PID 2>/dev/null

python3 -I - "$WORK" "$OUT/claude-refresh-offline.json" <<EOF
import json, re, sys
work, out = sys.argv[1], sys.argv[2]
home = "$HOME"
def lines(p):
    try: return open(p, errors="replace").read().splitlines()
    except FileNotFoundError: return []
events = []
for l in lines(f"{work}/inotify.log"):
    if " STEP " in l:
        events.append({"step": l.split(" STEP ")[1]}); continue
    try: t, ev, path = l.split(" ", 2)
    except ValueError: continue
    path = path.replace(home, "~")
    if "/.claude/" not in path and not path.endswith(".claude.json"):
        continue
    if ev.startswith(("OPEN", "ACCESS", "CLOSE_NOWRITE")):
        continue
    if ".credentials.json" not in path and not any(k in ev for k in ("CREATE", "DELETE", "MOVED")):
        continue
    e = {"event": ev, "path": re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}", "<uuid>", path)}
    if events and {k: events[-1].get(k) for k in ("event", "path")} == e:
        events[-1]["repeat"] = events[-1].get("repeat", 1) + 1
    else:
        events.append(e)
res = {
  "claude_version": "$(claude --version 2>/dev/null)",
  "network": "internal Docker network; fake TLS server for Anthropic hostnames; throwaway CA",
  "request_exit_code": $RC,
  "request_output": [re.sub(r"https?://\S+", "<url>", x)[:200] for x in lines(f"{work}/print.out")][:6],
  "logout_exit_code": $LRC,
  "files_holding_canary_after_refresh": lines(f"{work}/canary.txt"),
  "files_holding_canary_after_logout": lines(f"{work}/canary2.txt"),
  "inotify": events,
  "audits": [json.load(open(f"{work}/a{i}.json")) for i in range(3)],
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print("wrote", out)
EOF
chown "${OUT_UID:-0}:${OUT_GID:-0}" "$OUT/claude-refresh-offline.json"
rm -rf "$WORK"
