#!/bin/bash
# Inside the container for login_values_offline.sh (S6 follow-up, DC-45): the real Claude Code and
# Codex binaries sign in, make a request, refresh, resume and sign out against fakes, with
# synthetic logins. After each step, credsync/login_values.py reports which login file key each
# value found in another file comes from, never the value. Masked output only.
set -uo pipefail
OUT=${OUT:-/out}
S6=/opt/s6
WORK=$(mktemp -d)
ISSUER=http://127.0.0.1:8765
CRED_FILES=("$HOME/.claude/.credentials.json" "$HOME/.claude/.device-keys.json" "$HOME/.codex/auth.json" "$HOME/.codex/.credentials.json")
report() { # $1 label
  python3 -I "$S6/credsync/login_values.py" --home "$HOME" "${CRED_FILES[@]}" \
    | python3 -I -c 'import json,sys; d=json.load(sys.stdin); d["label"]=sys.argv[1]; print(json.dumps(d))' "$1" >> "$WORK/reports.jsonl"
}
exits=()
note() { exits+=("\"$1\": $2"); }

python3 -I "$S6/realcli/fake_openai_issuer.py" --port 8765 --log "$WORK/issuer.jsonl" --access-ttl 120 &
python3 -I "$S6/realcli/fake_openai_responses.py" --port 8766 --log "$WORK/responses.jsonl" &
sleep 1
export CODEX_REFRESH_TOKEN_URL_OVERRIDE=$ISSUER/oauth/token CODEX_REVOKE_TOKEN_URL_OVERRIDE=$ISSUER/oauth/revoke
# Codex 0.162.1 sends a ChatGPT login's requests to chatgpt.com whatever OPENAI_BASE_URL says, so
# the request goes to the fake through a provider entry that uses the same ChatGPT login.
FAKE_PROVIDER=(-c model_provider=s6fake -c 'model_providers.s6fake={name="s6fake",base_url="http://127.0.0.1:8766/v1",wire_api="responses",requires_openai_auth=true}')
cd /root || exit 1

# Claude Code: sign-in through the terminal, a request, a forced refresh, a resumed request.
python3 -I "$S6/realcli/pty_claude_login.py" --timeout 90 > "$WORK/claude-login.json"; note claude_login $?
report "claude: after sign-in"
SID=$(python3 -I -c 'import uuid; print(uuid.uuid4())')
timeout 120 claude -p --session-id "$SID" "Remember the word S6. Reply OK." > /dev/null 2>&1; note claude_request $?
report "claude: after a request"
python3 -I - <<'EOF'
import json, os, time
p = os.path.expanduser("~/.claude/.credentials.json")
d = json.load(open(p))
d["claudeAiOauth"]["expiresAt"] = int((time.time() - 60) * 1000)
tmp = p + ".s6edit"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, json.dumps(d).encode()); os.close(fd)
os.replace(tmp, p)
EOF
timeout 120 claude -p --resume "$SID" "Reply OK." > /dev/null 2>&1; note claude_refresh_and_resume $?
report "claude: after a refresh and a resumed request"

# Codex: device-code sign-in, a request, a forced refresh, a resumed request.
timeout 60 codex login --device-auth --experimental_issuer "$ISSUER" > /dev/null 2>&1; note codex_login $?
report "codex and claude: after Codex sign-in"
timeout 120 codex exec --skip-git-repo-check "${FAKE_PROVIDER[@]}" "Reply OK." > /dev/null 2>&1; note codex_request $?
report "codex and claude: after a Codex request"
python3 -I "$S6/realcli/codex_force_refresh.py" --timeout 30 > "$WORK/force.json" 2>/dev/null; note codex_forced_refresh $?
timeout 120 codex exec resume --last --skip-git-repo-check "${FAKE_PROVIDER[@]}" "Reply OK." > /dev/null 2>&1; note codex_resume $?
report "codex and claude: after a forced refresh and a resumed request"

# Sign out of both, then one last report (no login file left to compare against).
timeout 60 claude auth logout > /dev/null 2>&1; note claude_logout $?
timeout 60 codex logout > /dev/null 2>&1; note codex_logout $?
present=$(for f in "${CRED_FILES[@]}"; do [ -e "$f" ] && echo -n "\"${f#"$HOME"/}\","; done | sed 's/,$//')

python3 -I - "$WORK" "$OUT/login-values-offline.json" "{$(IFS=,; echo "${exits[*]}")}" "[$present]" <<EOF
import json, sys
work, out, exits, present = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), json.loads(sys.argv[4])
lines = lambda p: [json.loads(x) for x in open(p) if x.strip()] if __import__("os").path.exists(p) else []
res = {
  "claude_version": "$(claude --version 2>/dev/null)",
  "codex_version": "$(codex --version 2>/dev/null)",
  "network": "internal Docker network: fake TLS server for the Anthropic hostnames (throwaway CA); fake OpenAI issuer and Responses endpoint on loopback",
  "exit_codes": exits,
  "claude_login": (lines(f"{work}/claude-login.json") or [{}])[-1],
  "codex_forced_refresh": (lines(f"{work}/force.json") or [{}])[-1],
  "responses_requests": [{k: r.get(k) for k in ("method", "path", "status")} for r in lines(f"{work}/responses.jsonl")],
  "declared_files_present_after_sign_out": present,
  "reports": lines(f"{work}/reports.jsonl"),
}
open(out, "w").write(json.dumps(res, indent=1) + "\n")
print("wrote", out)
EOF
chown "${OUT_UID:-0}:${OUT_GID:-0}" "$OUT/login-values-offline.json"
rm -rf "$WORK"
