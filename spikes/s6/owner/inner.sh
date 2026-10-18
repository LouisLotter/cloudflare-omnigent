#!/bin/bash
# Spike S6, owner session: the steps that run inside a computer container.
# Called by session_local.py through `docker exec`. Every output is masked: paths, modes, sizes,
# key names, states and timestamps only. Never prints login contents.
#
#   inner.sh start-generation | audit <label> | copies <label> | lifetimes <label>
#          | capture <credential|workspace> | restore | watch-start | watch-stop
#          | claude-status | codex-status | claude-ask | codex-ask
#          | claude-force-refresh | codex-force-refresh | leak-check
set -uo pipefail
S6=/opt/s6
# Local session: MinIO and a SQLite controller under /ctl. Staging: the computer API.
OUT=${S6_OUT:-/out}
CTL=${S6_CONTROLLER:-/ctl/controller.sqlite}
STORE=${S6_STORE:-s3}
COMPUTER=${S6_COMPUTER:-owner-pc}
HOME=${HOME:-/root}
CS="python3 -I $S6/credsync/cli.py"
GEN=${S6_GENERATION:-$(cat /ctl/generation 2>/dev/null || echo 0)}
mkdir -p "$OUT" /var/lib/s6
COMMON=(--store "$STORE" --controller "$CTL" --computer "$COMPUTER" --generation "$GEN" --home "$HOME")
CRED_FILES=("$HOME/.claude/.credentials.json" "$HOME/.codex/auth.json" "$HOME/.omnigent/auth_tokens.json")
FAKE=${S6_FAKE:-0}  # dry run with the fake CLIs (fakes/bin first on PATH)
slug() { echo "$1" | tr ' /' '__' | tr -cd 'A-Za-z0-9_.-'; }

case "${1:-}" in
  start-generation)
    $CS start --controller "$CTL" --computer "$COMPUTER" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["generation"])' > /ctl/generation
    echo "generation $(cat /ctl/generation)" ;;
  audit)
    $CS audit --home "$HOME" --label "$2" --state /var/lib/s6/audit-state.json --out "$OUT/audit-$(slug "$2").json"
    python3 -I - "$OUT/audit-$(slug "$2").json" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for f in d["files"]:
    if f["path"] in (".claude/.credentials.json", ".codex/auth.json", ".omnigent/auth_tokens.json", ".claude/.device-keys.json", ".claude.json"):
        print(f"  {f['path']:32} exists={f['exists']} mode={f.get('mode')} size={f.get('size')} "
              f"inode_changed={f.get('inode_changed')} changed={f.get('changed_keys')}")
EOF
    ;;
  copies)
    python3 -I "$S6/credsync/find_copies.py" --home "$HOME" "${CRED_FILES[@]}" | tee "$OUT/copies-$(slug "$2").json" ;;
  lifetimes)
    # Timestamps only: Claude's expiresAt, and the exp/iat claims of Codex's access token.
    python3 -I - <<'EOF' | tee "$OUT/lifetimes-$(slug "$2").json"
import base64, json, os, time
out = {"at": time.time()}
try:
    c = json.load(open(os.path.expanduser("~/.claude/.credentials.json")))["claudeAiOauth"]
    out["claude_access_expires_in_s"] = round(c["expiresAt"] / 1000 - time.time())
    out["claude_has_refreshTokenExpiresAt"] = "refreshTokenExpiresAt" in c
except Exception as e:
    out["claude"] = type(e).__name__
try:
    t = json.load(open(os.path.expanduser("~/.codex/auth.json")))["tokens"]["access_token"]
    p = t.split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    out["codex_access_lifetime_s"] = claims.get("exp", 0) - claims.get("iat", 0)
    out["codex_access_expires_in_s"] = round(claims.get("exp", 0) - time.time())
except Exception as e:
    out["codex"] = type(e).__name__
print(json.dumps(out))
EOF
    ;;
  capture)
    $CS capture --kind "$2" "${COMMON[@]}" | tee -a "$OUT/captures.jsonl" ;;
  restore)
    mkdir -p /var/lib/s6
    $CS restore "${COMMON[@]}" --staging /var/lib/s6/cred-staging | tee -a "$OUT/restores.jsonl" ;;
  watch-start)
    nohup $CS watch "${COMMON[@]}" --settle-ms 500 --poll-ms 50 --log "$OUT/watch-gen$GEN.jsonl" > /dev/null 2>&1 &
    echo $! > /var/lib/s6/watch.pid; echo "watcher started" ;;
  watch-stop)
    kill "$(cat /var/lib/s6/watch.pid 2>/dev/null)" 2>/dev/null; echo "watcher stopped" ;;
  claude-status)
    timeout 60 claude auth status --json 2>/dev/null | python3 -I -c 'import json,sys
try: d=json.load(sys.stdin); print(json.dumps({"loggedIn": d.get("loggedIn"), "authMethod": d.get("authMethod")}))
except Exception as e: print(json.dumps({"error": type(e).__name__}))' | tee -a "$OUT/status.jsonl" ;;
  codex-status)
    timeout 60 codex login status 2>&1 | grep -o "Logged in using [A-Za-z]*\|Not logged in" | head -1 | tee -a "$OUT/status.jsonl" ;;
  claude-ask)
    if [ "$FAKE" = 1 ]; then claude use > /tmp/claude-ask.out 2>&1 && echo OK >> /tmp/claude-ask.out; fi
    [ "$FAKE" = 1 ] || timeout 180 claude -p "Reply with the single word OK." > /tmp/claude-ask.out 2>&1; rc=$?
    echo "{\"claude_request_exit\": $rc, \"replied_ok\": $(grep -q OK /tmp/claude-ask.out && echo true || echo false)}" | tee -a "$OUT/requests.jsonl"
    rm -f /tmp/claude-ask.out ;;
  codex-ask)
    if [ "$FAKE" = 1 ]; then codex use > /tmp/codex-ask.out 2>&1 && echo OK >> /tmp/codex-ask.out; fi
    [ "$FAKE" = 1 ] || timeout 300 codex exec --skip-git-repo-check "Reply with the single word OK." > /tmp/codex-ask.out 2>&1; rc=$?
    echo "{\"codex_request_exit\": $rc, \"replied_ok\": $(grep -q OK /tmp/codex-ask.out && echo true || echo false)}" | tee -a "$OUT/requests.jsonl"
    rm -f /tmp/codex-ask.out ;;
  claude-force-refresh)
    if [ "$FAKE" = 1 ]; then claude refresh; exit; fi
    # Set only the login's expiry timestamp in the past (atomic replace, mode 0600, nothing
    # printed), then make one small request: Claude Code refreshes before sending it.
    python3 -I - <<'EOF'
import json, os, time
p = os.path.expanduser("~/.claude/.credentials.json")
d = json.load(open(p))
d["claudeAiOauth"]["expiresAt"] = int((time.time() - 60) * 1000)
tmp = p + ".s6edit"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, json.dumps(d).encode()); os.fsync(fd); os.close(fd)
os.replace(tmp, p)
print("expiry moved to the past")
EOF
    "$0" claude-ask ;;
  codex-force-refresh)
    if [ "$FAKE" = 1 ]; then codex refresh; exit; fi
    python3 -I "$S6/realcli/codex_force_refresh.py" --timeout 90 | tee -a "$OUT/requests.jsonl" ;;
  leak-check)
    # Inside the computer, while signed in: does any results file hold a login value?
    python3 -I "$S6/credsync/find_copies.py" --home "$OUT" "${CRED_FILES[@]}" | tee "$OUT/leak-check-$(slug "${2:-final}").json" ;;
  *)
    echo "unknown action: ${1:-}" >&2; exit 2 ;;
esac
