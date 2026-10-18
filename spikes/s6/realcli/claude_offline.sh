#!/bin/bash
# Real Claude Code binary, no sign-in, no network (spike S6).
#
# Runs inside the S6 image with --network none. Records which files Claude Code creates, whether
# `claude auth login --claudeai` offers the paste-code prompt in a container, and how logout and
# a failed refresh treat ~/.claude/.credentials.json. The login file used here is synthetic: it
# carries canary values, not a real login. Output: /out/claude-offline.json (masked).
set -uo pipefail
OUT=${OUT:-/out}
S6=/opt/s6
WORK=$(mktemp -d)
AUDIT="python3 -I $S6/credsync/cli.py audit --home $HOME --state /var/lib/s6/audit-claude.json"
step() { echo "$(date +%s.%N) STEP $1" >> "$WORK/inotify.log"; }
canary_files() { grep -rl --exclude-dir=.cache "CFO_""CANARY_" "$HOME" 2>/dev/null | sed "s|^$HOME|~|" > "$WORK/canary-$1.txt"; }

synthetic_login() { # $1: expiresAt offset in seconds; $2: "mcp" to add an MCP OAuth entry
  python3 -I - "$1" "${2:-}" <<'EOF'
import json, os, secrets, sys, time
p = os.path.expanduser("~/.claude/.credentials.json")
os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
c = "CFO_" + "CANARY_"
data = {"claudeAiOauth": {"accessToken": c + "S6access" + secrets.token_hex(12), "refreshToken": c + "S6refresh" + secrets.token_hex(12),
        "expiresAt": int((time.time() + float(sys.argv[1])) * 1000), "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
        "subscriptionType": "max"}}
if sys.argv[2] == "mcp":
    data["mcpOAuth"] = {"synthetic|0": {"serverName": "synthetic", "accessToken": c + "S6mcp" + secrets.token_hex(8)}}
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(data).encode()); os.close(fd)
EOF
}

auth_status() { # keep only loggedIn and authMethod: the JSON can carry account details
  timeout 30 claude auth status --json 2>/dev/null | python3 -I -c 'import json,sys
try: d=json.load(sys.stdin); print(json.dumps({"loggedIn": d.get("loggedIn"), "authMethod": d.get("authMethod")}))
except Exception as e: print(json.dumps({"error": type(e).__name__}))'
}

inotifywait -m -r -q --format '%T %e %w%f' --timefmt '%s' "$HOME" -o "$WORK/inotify.log" &
INOTIFY_PID=$!
sleep 1
$AUDIT --label "fresh home" --out "$WORK/a0.json"

step version
claude --version > "$WORK/version.out" 2>&1
step status-logged-out
auth_status > "$WORK/status0.json"
$AUDIT --label "after --version and auth status" --out "$WORK/a1.json"

step login-help
timeout 30 claude auth login --help > "$WORK/login-help.out" 2>&1

# The paste-code prompt: run the real login with a pseudo-terminal and no network, for 20 s.
# Nobody pastes a code; nothing signs in. Only whether the prompt appears is kept.
step login-prompt
timeout 20 script -qfec "claude auth login --claudeai" /dev/null > "$WORK/login.out" 2>&1 < /dev/null
LOGIN_RC=$?
$AUDIT --label "after unfinished login attempt" --out "$WORK/a2.json"

step synthetic-login
synthetic_login 28800
sleep 0.3
auth_status > "$WORK/status1.json"
$AUDIT --label "synthetic login file, after auth status" --out "$WORK/a3.json"
canary_files logged-in

step logout
timeout 60 claude auth logout > "$WORK/logout.out" 2>&1
LOGOUT_RC=$?
sleep 0.3
auth_status > "$WORK/status2.json"
$AUDIT --label "after claude auth logout" --out "$WORK/a4.json"
canary_files after-logout

step logout-with-mcp
synthetic_login 28800 mcp
timeout 60 claude auth logout > "$WORK/logout2.out" 2>&1
LOGOUT2_RC=$?
sleep 0.3
$AUDIT --label "after logout with an MCP OAuth entry present" --out "$WORK/a5.json"
canary_files after-logout-mcp
rm -f "$HOME/.claude/.credentials.json"

step failed-refresh
synthetic_login -60
$AUDIT --label "expired synthetic login" --out "$WORK/a6.json"
timeout 45 claude -p "reply ok" > "$WORK/print.out" 2>&1
PRINT_RC=$?
sleep 0.3
$AUDIT --label "after a request that needed a refresh, offline" --out "$WORK/a7.json"
canary_files after-failed-refresh
step end
sleep 0.3
kill $INOTIFY_PID 2>/dev/null

python3 -I - "$WORK" "$OUT/claude-offline.json" <<EOF
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
    interesting = ".credentials.json" in path or path.endswith("/.claude.json") or "device-keys" in path
    if not interesting and not any(k in ev for k in ("CREATE", "DELETE", "MOVED")):
        continue
    if ev.startswith(("OPEN", "ACCESS", "CLOSE_NOWRITE")):
        continue
    e = {"event": ev, "path": re.sub(r"[0-9a-f]{8}-[0-9a-f-]{27}", "<uuid>", path)}
    if events and {k: events[-1].get(k) for k in ("event", "path")} == e:
        events[-1]["repeat"] = events[-1].get("repeat", 1) + 1
    else:
        events.append(e)
login_text = "\n".join(lines(f"{work}/login.out"))
res = {
  "claude_version": " ".join(lines(f"{work}/version.out")[:1]),
  "network": "none",
  "status": {k: json.loads((lines(f"{work}/{k}.json") or ["{}"])[0]) for k in ("status0", "status1", "status2")},
  "login_help": [x for x in lines(f"{work}/login-help.out") if x.strip()][:40],
  "login_attempt": {
    "exit_code": $LOGIN_RC,
    "printed_authorize_url": bool(re.search(r"https://\S*oauth/authorize", login_text)),
    "paste_prompt_seen": "Paste code" in login_text,
    "masked_tail": [re.sub(r"https?://\S+", "<url>", x)[:160] for x in login_text.splitlines() if x.strip()][-8:],
  },
  "logout": {"exit_code": $LOGOUT_RC, "text": [re.sub(r"https?://\S+", "<url>", x)[:200] for x in lines(f"{work}/logout.out")][:5]},
  "logout_with_mcp": {"exit_code": $LOGOUT2_RC},
  "print_with_expired_login": {"exit_code": $PRINT_RC, "text": [re.sub(r"https?://\S+", "<url>", x)[:200] for x in lines(f"{work}/print.out")][:5]},
  "files_holding_canary": {k: lines(f"{work}/canary-{k}.txt") for k in ("logged-in", "after-logout", "after-logout-mcp", "after-failed-refresh")},
  "inotify": events,
  "audits": [json.load(open(f"{work}/a{i}.json")) for i in range(8)],
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print("wrote", out)
EOF
chown "${OUT_UID:-0}:${OUT_GID:-0}" "$OUT/claude-offline.json"
rm -rf "$WORK"
