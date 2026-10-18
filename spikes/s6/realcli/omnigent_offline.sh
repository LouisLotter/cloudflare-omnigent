#!/bin/bash
# Real Omnigent CLI login against a local Omnigent server in accounts mode, no network (spike S6).
#
# Runs inside the S6 image with --network none. The server uses its own home and data directory,
# a synthetic admin and a random password generated here, so no real account is involved.
# Records how `omnigent login`, a token refresh and clear_token write ~/.omnigent/auth_tokens.json.
# Output: /out/omnigent-offline.json (masked).
set -uo pipefail
OUT=${OUT:-/out}
S6=/opt/s6
WORK=$(mktemp -d)
SERVER=http://127.0.0.1:6767
PY=/opt/venv/bin/python
AUDIT="python3 -I $S6/credsync/cli.py audit --home $HOME --state /var/lib/s6/audit-omnigent.json"
step() { echo "$(date +%s.%N) STEP $1" >> "$WORK/inotify.log"; }
copies() { python3 -I "$S6/credsync/find_copies.py" --home "$HOME" "$HOME/.omnigent/auth_tokens.json" > "$WORK/copies-$1.json"; }
PASSWORD=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')

mkdir -p /srv/omni
HOME=/srv/omni OMNIGENT_DATA_DIR=/srv/omni/.omnigent OMNIGENT_AUTH_PROVIDER=accounts \
  OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME=admin OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD="$PASSWORD" \
  omnigent server --host 127.0.0.1 --port 6767 > "$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 90); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$SERVER/v1/me" || true)
  [ "$code" = "401" ] && break
  sleep 1
done

inotifywait -m -r -q --format '%T %e %w%f' --timefmt '%s' "$HOME" -o "$WORK/inotify.log" &
INOTIFY_PID=$!
sleep 1
$AUDIT --label "before login" --out "$WORK/a0.json"

step login
printf 'admin\n%s\n' "$PASSWORD" | timeout 60 omnigent login "$SERVER" > "$WORK/login.out" 2>&1
LOGIN_RC=$?
sleep 0.3
$AUDIT --label "after omnigent login" --out "$WORK/a1.json"
copies after-login

# Refresh: make the stored access token look nearly expired (only its expires_at timestamp is
# changed), then call the CLI's own refresh path, as the host does before its token runs out.
step refresh
$PY -I - "$SERVER" <<'EOF'
import json, os, sys, time
p = os.path.expanduser("~/.omnigent/auth_tokens.json")
d = json.load(open(p))
d[sys.argv[1]]["expires_at"] = time.time() + 30
json.dump(d, open(p, "w"))
from omnigent.cli_auth import refresh_stored_token
print("refreshed" if refresh_stored_token(sys.argv[1]) else "not refreshed")
EOF
sleep 0.3
$AUDIT --label "after refresh" --out "$WORK/a2.json"
copies after-refresh

step clear-token
$PY -I -c "import sys; from omnigent.cli_auth import clear_token; clear_token(sys.argv[1])" "$SERVER"
sleep 0.3
$AUDIT --label "after clear_token (no logout command exists)" --out "$WORK/a3.json"
step end
sleep 0.3
kill $INOTIFY_PID $SERVER_PID 2>/dev/null

python3 -I - "$WORK" "$OUT/omnigent-offline.json" <<EOF
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
    if "/.omnigent" not in path or ev.startswith(("OPEN", "ACCESS", "CLOSE_NOWRITE")):
        continue
    if "auth_tokens" not in path and not any(k in ev for k in ("CREATE", "DELETE", "MOVED")):
        continue
    e = {"event": ev, "path": re.sub(r"\.auth_tokens\.json\.[^/]+\.tmp", ".auth_tokens.json.<random>.tmp", path)}
    if events and {k: events[-1].get(k) for k in ("event", "path")} == e:
        events[-1]["repeat"] = events[-1].get("repeat", 1) + 1
    else:
        events.append(e)
res = {
  "omnigent_version": "$(omnigent --version 2>/dev/null | tail -1)",
  "network": "none (local Omnigent server on loopback, synthetic admin)",
  "login_exit_code": $LOGIN_RC,
  "login_output": [x for x in lines(f"{work}/login.out") if "Logged in" in x or "Login" in x or "rror" in x][:4],
  "copies": {k: json.load(open(f"{work}/copies-{k}.json")) for k in ("after-login", "after-refresh")},
  "inotify": events,
  "audits": [json.load(open(f"{work}/a{i}.json")) for i in range(4)],
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print("wrote", out)
EOF
chown "${OUT_UID:-0}:${OUT_GID:-0}" "$OUT/omnigent-offline.json"
rm -rf "$WORK"
