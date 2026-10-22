#!/bin/bash
# Spike S6, owner session: the steps that run inside a computer container.
# Called by session_local.py (docker exec) and by the staging Worker (container exec). Output is
# masked by construction: fixed text, exit codes, paths, modes, sizes, key names, states and
# timestamps only. No CLI output is passed through, and stderr is discarded.
#
#   inner.sh start-generation | audit <label> | audit-json <label> | copies <label> | lifetimes <label>
#          | login-values <label>
#          | capture <credential|workspace> | restore | watch-start | watch-stop
#          | claude-status | codex-status | signed-out-check
#          | claude-ask | codex-ask | claude-force-refresh | codex-force-refresh
#          | claude-remember | codex-remember | claude-resume | codex-resume
#          | claude-logout | codex-logout | leak-check [label]
# Exit status: 0 when the step did what it should; non-zero otherwise.
set -uo pipefail
S6=/opt/s6
# Local session: MinIO and a SQLite controller under /ctl. Staging uses only the local actions.
OUT=${S6_OUT:-/out}
CTL=${S6_CONTROLLER:-/ctl/controller.sqlite}
STORE=${S6_STORE:-s3}
COMPUTER=${S6_COMPUTER:-owner-pc}
HOME=${HOME:-/root}
CS="python3 -I $S6/credsync/cli.py"
GEN=${S6_GENERATION:-$(cat /ctl/generation 2>/dev/null || echo 0)}
mkdir -p "$OUT" /var/lib/s6
COMMON=(--store "$STORE" --controller "$CTL" --computer "$COMPUTER" --generation "$GEN" --home "$HOME")
CRED_FILES=("$HOME/.claude/.credentials.json" "$HOME/.claude/.device-keys.json" "$HOME/.codex/auth.json" "$HOME/.omnigent/auth_tokens.json")
FAKE=${S6_FAKE:-0}  # dry run with the fake CLIs (fakes/bin first on PATH)
slug() { echo "$1" | tr ' /' '__' | tr -cd 'A-Za-z0-9_.-'; }

claude_logged_in() { # prints true/false; never the CLI's own output
  timeout 60 claude auth status --json 2>/dev/null | python3 -I -c 'import json,sys
try: print("true" if json.load(sys.stdin).get("loggedIn") else "false")
except Exception: print("unknown")'
}
codex_logged_in() {
  local s
  s=$(timeout 60 codex login status 2>&1 | grep -o "Logged in using [A-Za-z]*\|Not logged in" | head -1)
  case "$s" in "Logged in"*) echo true ;; "Not logged in") echo false ;; *) echo unknown ;; esac
}
# VD-09 (S6 follow-up): computer A opens one conversation per CLI around a random code word;
# computer B, restored from A's workspace checkpoint, resumes each and must answer with the word.
# The word and the session ids live in the workspace ("work" is a workspace checkpoint root), so
# B finds them only if the workspace restore brought them back. The word is not a secret.
RESUME_DIR="$HOME/work/s6-resume"
RESUME_QUESTION="What is the code word I asked you to remember earlier in this conversation? Reply with the code word only."
claude_sessions() { find "$HOME/.claude/projects" -name '*.jsonl' -not -path '*/subagents/*' 2>/dev/null | wc -l; }
codex_rollouts() { find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' 2>/dev/null | wc -l; }
lines_of() { [ -f "$1" ] && wc -l < "$1" || echo 0; }
resume_report() { # name exit restored replied grew new_files; exit status: resumed and answered
  echo "{\"${1}_resume_exit\": $2, \"conversation_restored\": $3, \"replied_with_code_word\": $4, \"same_conversation_grew\": $5, \"new_conversation_files\": $6}" | tee -a "$OUT/requests.jsonl"
  [ "$2" = 0 ] && [ "$3" = true ] && [ "$4" = true ]
}

ask() { # $1 name; rest: command. Prints exit code and whether the reply contained OK.
  local name=$1; shift
  "$@" > /tmp/s6-ask.out 2>&1
  local rc=$?
  local ok=false
  grep -q OK /tmp/s6-ask.out && ok=true
  rm -f /tmp/s6-ask.out
  echo "{\"${name}_request_exit\": $rc, \"replied_ok\": $ok}" | tee -a "$OUT/requests.jsonl"
  [ "$rc" = 0 ] && [ "$ok" = true ]
}

# Dry runs only: a file /ctl/fail-always-<action> makes that action fail, to test recovery.
if [ "$FAKE" = 1 ] && [ -e "/ctl/fail-always-${1:-}" ]; then
  echo "{\"injected_failure\": \"${1:-}\"}"
  exit 1
fi

case "${1:-}" in
  start-generation)
    $CS start --controller "$CTL" --computer "$COMPUTER" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["generation"])' > /ctl/generation
    echo "generation $(cat /ctl/generation)" ;;
  audit|audit-json)
    f="$OUT/audit-$(slug "$2").json"
    $CS audit --home "$HOME" --label "$2" --state /var/lib/s6/audit-state.json --out "$f" || exit 1
    if [ "$1" = audit-json ]; then python3 -I -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))' "$f"; exit; fi
    python3 -I - "$f" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
for f in d["files"]:
    if f["path"] in (".claude/.credentials.json", ".codex/auth.json", ".omnigent/auth_tokens.json", ".claude/.device-keys.json", ".claude.json"):
        print(f"{f['path']:32} exists={f['exists']} mode={f.get('mode')} size={f.get('size')} "
              f"inode_changed={f.get('inode_changed')} changed={f.get('changed_keys')}")
EOF
    ;;
  copies)
    python3 -I "$S6/credsync/find_copies.py" --home "$HOME" "${CRED_FILES[@]}" | tee "$OUT/copies-$(slug "$2").json" ;;
  login-values)
    # DC-45: for each file holding a login value, which login file key it comes from, its class
    # and where it sits; never the value (credsync/login_values.py).
    python3 -I "$S6/credsync/login_values.py" --home "$HOME" "${CRED_FILES[@]}" | tee "$OUT/login-values-$(slug "$2").json"
    [ "${PIPESTATUS[0]}" = 0 ] ;;
  lifetimes)
    # Timestamps only: Claude's expiresAt, and the exp/iat claims of Codex's access token.
    python3 -I - <<'EOF' | tee "$OUT/lifetimes-$(slug "$2").json"
import base64, json, os, time
out = {"at": round(time.time())}
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
    $CS capture --kind "$2" "${COMMON[@]}" 2>/dev/null | tee -a "$OUT/captures.jsonl" ;;
  restore)
    $CS restore "${COMMON[@]}" --staging /var/lib/s6/cred-staging 2>/dev/null | tee -a "$OUT/restores.jsonl" ;;
  watch-start)
    # Ready only once the watcher has recorded the current files and said so in its log.
    log="$OUT/watch-gen$GEN.jsonl"
    before=$(grep -c '"event": "watching"' "$log" 2>/dev/null || true)
    nohup $CS watch "${COMMON[@]}" --settle-ms 500 --poll-ms 50 --log "$log" > /dev/null 2>&1 &
    echo $! > /var/lib/s6/watch.pid
    for _ in $(seq 1 150); do
      now=$(grep -c '"event": "watching"' "$log" 2>/dev/null || true)
      if [ "${now:-0}" -gt "${before:-0}" ] && kill -0 "$(cat /var/lib/s6/watch.pid)" 2>/dev/null; then
        echo "watcher ready"; exit 0
      fi
      kill -0 "$(cat /var/lib/s6/watch.pid)" 2>/dev/null || break
      sleep 0.1
    done
    echo "watcher failed to start"; exit 1 ;;
  watch-stop)
    pid=$(cat /var/lib/s6/watch.pid 2>/dev/null)
    if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then echo "watcher was not running"; exit 1; fi
    sleep 1.5  # let a pending change settle and publish first
    kill "$pid"; for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    rm -f /var/lib/s6/watch.pid
    echo "watcher stopped" ;;
  claude-status)
    s=$(claude_logged_in); echo "{\"claude_logged_in\": \"$s\"}" | tee -a "$OUT/status.jsonl"; [ "$s" != unknown ] ;;
  codex-status)
    s=$(codex_logged_in); echo "{\"codex_logged_in\": \"$s\"}" | tee -a "$OUT/status.jsonl"; [ "$s" != unknown ] ;;
  signed-out-check)
    c=$(claude_logged_in); x=$(codex_logged_in)
    present=$(for f in "${CRED_FILES[@]}"; do [ -e "$f" ] && echo -n "\"${f#"$HOME"/}\","; done | sed 's/,$//')
    echo "{\"claude_logged_in\": \"$c\", \"codex_logged_in\": \"$x\", \"declared_files_present\": [$present]}" | tee -a "$OUT/status.jsonl"
    [ "$c" = false ] && [ "$x" = false ] ;;
  claude-ask)
    if [ "$FAKE" = 1 ]; then ask claude bash -c 'claude use && echo OK'; exit; fi
    ask claude timeout 180 claude -p "Reply with the single word OK." ;;
  codex-ask)
    if [ "$FAKE" = 1 ]; then ask codex bash -c 'codex use && echo OK'; exit; fi
    ask codex timeout 300 codex exec --skip-git-repo-check "Reply with the single word OK." ;;
  claude-remember)
    mkdir -p "$RESUME_DIR"
    [ -s "$RESUME_DIR/word" ] || python3 -I -c 'import secrets; print("S6-" + secrets.token_hex(3).upper())' > "$RESUME_DIR/word"
    python3 -I -c 'import uuid; print(uuid.uuid4())' > "$RESUME_DIR/claude-session-id"
    word=$(cat "$RESUME_DIR/word"); id=$(cat "$RESUME_DIR/claude-session-id")
    if [ "$FAKE" = 1 ]; then
      mkdir -p "$HOME/.claude/projects/-root" && echo '{"fake": "conversation"}' > "$HOME/.claude/projects/-root/$id.jsonl"
      ask claude bash -c 'claude use && echo OK'; exit
    fi
    ask claude timeout 180 claude -p --session-id "$id" "Remember this code word for later in this conversation: $word. For now, reply with the single word OK." ;;
  codex-remember)
    mkdir -p "$RESUME_DIR"
    [ -s "$RESUME_DIR/word" ] || python3 -I -c 'import secrets; print("S6-" + secrets.token_hex(3).upper())' > "$RESUME_DIR/word"
    word=$(cat "$RESUME_DIR/word")
    before=$(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' 2>/dev/null | sort)
    if [ "$FAKE" = 1 ]; then
      d="$HOME/.codex/sessions/2026/01/01"; mkdir -p "$d"
      echo '{"fake": "rollout"}' > "$d/rollout-2026-01-01T00-00-00-$(python3 -I -c 'import uuid; print(uuid.uuid4())').jsonl"
      ask codex bash -c 'codex use && echo OK'; rc=$?
    else
      ask codex timeout 300 codex exec --skip-git-repo-check "Remember this code word for later in this conversation: $word. For now, reply with the single word OK."; rc=$?
    fi
    # The new rollout's thread id, for B: rollout-<time>-<thread uuid>.jsonl.
    new=$(comm -13 <(echo "$before") <(find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' 2>/dev/null | sort) | head -1)
    basename "$new" .jsonl | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' > "$RESUME_DIR/codex-session-id"
    [ "$rc" = 0 ] && [ -s "$RESUME_DIR/codex-session-id" ] ;;
  claude-resume)
    word=$(cat "$RESUME_DIR/word" 2>/dev/null); id=$(cat "$RESUME_DIR/claude-session-id" 2>/dev/null)
    f=$( [ -n "$id" ] && find "$HOME/.claude/projects" -name "$id.jsonl" 2>/dev/null | head -1)
    restored=false; [ -n "$word" ] && [ -n "$f" ] && restored=true
    n0=$(claude_sessions); l0=$(lines_of "$f")
    if [ "$FAKE" = 1 ]; then
      { claude use > /dev/null 2>&1 && [ "$restored" = true ] && echo "$word" && echo '{"fake": "resumed"}' >> "$f"; } > /tmp/s6-ask.out 2>&1; rc=$?
    else
      timeout 180 claude -p --resume "$id" "$RESUME_QUESTION" > /tmp/s6-ask.out 2>&1; rc=$?
    fi
    replied=false; [ -n "$word" ] && grep -qF "$word" /tmp/s6-ask.out && replied=true
    rm -f /tmp/s6-ask.out
    grew=false; [ "$(lines_of "$f")" -gt "$l0" ] && grew=true
    resume_report claude "$rc" "$restored" "$replied" "$grew" $(( $(claude_sessions) - n0 )) ;;
  codex-resume)
    word=$(cat "$RESUME_DIR/word" 2>/dev/null); id=$(cat "$RESUME_DIR/codex-session-id" 2>/dev/null)
    f=$( [ -n "$id" ] && find "$HOME/.codex/sessions" -name "rollout-*-$id.jsonl" 2>/dev/null | head -1)
    restored=false; [ -n "$word" ] && [ -n "$f" ] && restored=true
    n0=$(codex_rollouts); l0=$(lines_of "$f")
    if [ "$FAKE" = 1 ]; then
      { codex use > /dev/null 2>&1 && [ "$restored" = true ] && echo "$word" && echo '{"fake": "resumed"}' >> "$f"; } > /tmp/s6-ask.out 2>&1; rc=$?
    else
      timeout 300 codex exec resume --skip-git-repo-check "$id" "$RESUME_QUESTION" > /tmp/s6-ask.out 2>&1; rc=$?
    fi
    replied=false; [ -n "$word" ] && grep -qF "$word" /tmp/s6-ask.out && replied=true
    rm -f /tmp/s6-ask.out
    grew=false; [ "$(lines_of "$f")" -gt "$l0" ] && grew=true
    resume_report codex "$rc" "$restored" "$replied" "$grew" $(( $(codex_rollouts) - n0 )) ;;
  claude-force-refresh)
    if [ "$FAKE" = 1 ]; then claude refresh > /dev/null 2>&1; rc=$?; echo "{\"claude_refresh_exit\": $rc}"; exit $rc; fi
    # Set only the login's expiry timestamp in the past (atomic replace, mode 0600, nothing
    # printed), then make one small request: Claude Code refreshes before sending it.
    python3 -I - <<'EOF' || exit 1
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
    if [ "$FAKE" = 1 ]; then codex refresh > /dev/null 2>&1; rc=$?; echo "{\"codex_refresh_exit\": $rc}"; exit $rc; fi
    python3 -I "$S6/realcli/codex_force_refresh.py" --timeout 90 | tee -a "$OUT/requests.jsonl"
    # Success means the login file was rewritten by the refresh.
    tail -1 "$OUT/requests.jsonl" | grep -q '"auth_json_rewritten": true' ;;
  claude-logout)
    timeout 120 claude auth logout > /dev/null 2>&1; rc=$?; echo "{\"claude_logout_exit\": $rc}" | tee -a "$OUT/status.jsonl"; exit $rc ;;
  codex-logout)
    timeout 120 codex logout > /dev/null 2>&1; rc=$?; echo "{\"codex_logout_exit\": $rc}" | tee -a "$OUT/status.jsonl"; exit $rc ;;
  leak-check)
    # Inside the computer, while signed in: does any results file hold a login value?
    r=$(python3 -I "$S6/credsync/find_copies.py" --home "$OUT" "${CRED_FILES[@]}")
    echo "$r" | tee "$OUT/leak-check-$(slug "${2:-final}").json"
    echo "$r" | grep -q '"files_holding_a_copy": \[\]' ;;
  *)
    echo "unknown action: ${1:-}" >&2; exit 2 ;;
esac
