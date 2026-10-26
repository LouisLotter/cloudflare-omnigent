#!/usr/bin/env bash
# G2 sitting (test tooling, laptop only): the production Workers and the server image from this
# checkout, installed on staging by the bootstrap (scripts/bootstrap) with an R2 replica, then
# the sitting's harness (platform.ts, steps.ts) on the same platform Worker. Every deploy and
# secret change goes through the guarded staging tool. Names: cfo-stg-g2-sitting-*.
#
#   run.sh bucket     deploy the replica bucket's holder (cfo-stg-g2-sitting-r2, bucket
#                     cfo-stg-g2-sitting-r2-db), plan the installation (owner "owner", replica
#                     s3://cfo-stg-g2-sitting-r2-db/omnigent), generate the owner's password
#   run.sh token      [owner] paste the R2 token's two values (not echoed); starts the bootstrap
#                     in the background (log: $G2_DIR/bootstrap.log) and returns
#   run.sh follow     wait for the bootstrap to end; then the anonymous probe
#   run.sh harness    redeploy the platform Worker with the harness; replace-1 runs by itself
#   run.sh rotate     a new cookie secret (generated here, never shown); the step "rotate" checks
#                     that the session from before is refused once the watchdog restarted
#   run.sh status     the harness's and the watchdog's lines so far
#   run.sh probe      RC-01: anonymous requests, and the alternate URLs ([subdomain])
#   run.sh password   [owner] print the owner's generated password, for the sign-in form
#   run.sh rc07       the attachment URLs the owner opens (from replace-1's result)
#   run.sh replace    replace-2: the replacement after the owner's edits (the owner password is
#                     removed from the Worker in the same change)
#   run.sh recovery   optional: an empty replica prefix; the server must enter recovery mode
#   run.sh collect    every line of the run, redacted, into $G2_DIR/collected-<time>/
#   run.sh teardown   tear everything down (web, platform, holder), list and sweep, and remove
#                     the state and password files
#
# Output goes to $G2_DIR (default $HOME/.pt/g2-sitting), redacted with spikes/x1/scripts/redact.py
# (account, zone, owner address) before it leaves the laptop. Push images one at a time: run no
# other staging deploy while `token` (the bootstrap's image push) runs.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${G2_DIR:-$HOME/.pt/g2-sitting}"
state_dir="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
install_dir="${CFO_INSTALL_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/installations}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state_dir/config.json" -)
secrets="$out/owner-secrets.json"
bootstrap=(node "$root/scripts/bootstrap/bootstrap.ts")
stg=(pnpm -s --dir "$root" stg)
owner=G2-sitting
platform=cfo-stg-g2-sitting-platform
web=cfo-stg-g2-sitting-web
mkdir -p "$out"
chmod 700 "$out"

zone() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["zone"])' "$state_dir/config.json"; }
account() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state_dir/config.json"; }
now() { date +%s%3N; }

scrub() { # redact, plus the team domain, the owner pin and the AUD tag (as WP2.4)
  "${redact[@]}" | sed -E \
    -e 's#[a-z0-9-]+\.cloudflareaccess\.com#<team>#g' \
    -e 's#hmac-sha256:[A-Za-z0-9_:-]+#<owner-pin>#g' \
    -e 's#(ACCESS_AUD[^A-Za-z0-9]+)[A-Za-z0-9_-]{16,}#\1<aud>#g'
}

logged() { # name, command...: run, redact, keep the log
  local name="$1"; shift
  set +e
  ("$@") 2>&1 | scrub | tee "$out/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  echo "exit $status" >>"$out/$name.log"
  return "$status"
}

lines() { # worker, from: Workers Logs since then, redacted
  node "$here/logs.ts" "$1" "$2" "$(now)" | scrub
}

secret_change() { # JSON on stdin: one guarded secrets change on the platform Worker
  "${stg[@]}" secrets --suffix g2-sitting-platform --owner "$owner"
}

case "${1:-}" in
  bucket)
    now >"$out/t0"
    logged bucket "${stg[@]}" deploy --suffix g2-sitting-r2 --owner "$owner" \
      --config worker/test/staging/g2/bucket/wrangler.jsonc --days 1
    logged plan "${bootstrap[@]}" plan --staging g2-sitting --staging-owner "$owner" \
      --owner-username owner --replica-url s3://cfo-stg-g2-sitting-r2-db/omnigent \
      --replica-endpoint "https://$(account).r2.cloudflarestorage.com" --days 1
    if [ ! -f "$secrets" ]; then
      (umask 077; python3 -I -c 'import json,secrets; print(json.dumps({"ownerPassword": "cfo-stg-" + secrets.token_urlsafe(18)}))' >"$secrets")
    fi
    echo "Ready for the owner's R2 token: bucket cfo-stg-g2-sitting-r2-db."
    ;;
  token)
    [ -f "$secrets" ] || { echo "run.sh bucket first"; exit 2; }
    echo "Paste the R2 token's values (they are not shown). Bucket: cfo-stg-g2-sitting-r2-db"
    read -rp "Access Key ID: " key_id
    read -rsp "Secret Access Key: " key_secret
    echo
    now >"$out/token-at"
    # The values go from this shell's builtin printf, through a pipe, to Python and then to the
    # bootstrap's stdin: never on a command line, in an environment or in a file.
    printf '%s\n%s\n' "$key_id" "$key_secret" | python3 -I -c '
import json, sys
key_id = sys.stdin.readline().strip()
key_secret = sys.stdin.readline().strip()
if not key_id or not key_secret:
    sys.exit("both values are needed")
print(json.dumps({
    "ownerPassword": json.load(open(sys.argv[1]))["ownerPassword"],
    "replicaAccessKeyId": key_id,
    "replicaSecretAccessKey": key_secret,
}))' "$secrets" | setsid nohup bash -c '
      node "$1/scripts/bootstrap/bootstrap.ts" run --staging g2-sitting --secrets-stdin --wait-minutes 45 2>&1 |
        python3 -I "$1/spikes/x1/scripts/redact.py" "$2" - |
        sed -E -e "s#[a-z0-9-]+\.cloudflareaccess\.com#<team>#g" -e "s#hmac-sha256:[A-Za-z0-9_:-]+#<owner-pin>#g" >"$3"
      echo "exit ${PIPESTATUS[0]}" >>"$3"' _ "$root" "$state_dir/config.json" "$out/bootstrap.log" \
      >/dev/null 2>&1 &
    echo "$!" >"$out/bootstrap.pid"
    unset key_id key_secret
    echo "The bootstrap runs in the background (about 20 to 30 minutes). You can close this terminal."
    ;;
  follow)
    # Until the bootstrap's process ends (tail --pid), at most an hour.
    timeout 60m tail -n +1 -F --pid="$(cat "$out/bootstrap.pid")" "$out/bootstrap.log" 2>/dev/null || true
    last="$(tail -n 1 "$out/bootstrap.log")"
    [ "$last" = "exit 0" ] || { echo "the bootstrap ended with: $last"; exit 1; }
    "$0" probe-anonymous
    ;;
  probe-anonymous)
    z="$(zone)"
    for host in "$web.$z" "$platform.$z"; do
      for path in / /v1/info /health; do
        printf '%s %s ' "${host%%.*}" "$path"
        curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}\n' "https://$host$path" |
          sed -E 's#https://[a-z0-9-]+\.cloudflareaccess\.com/[^ ]*#<access-login>#'
      done
    done | tee "$out/probe-anonymous.log"
    ;;
  harness)
    now >"$out/harness-at"
    python3 -I -c 'import json,sys; print(json.dumps({"G2_OWNER_PASSWORD": json.load(open(sys.argv[1]))["ownerPassword"], "G2_STEP": "replace-1"}))' \
      "$secrets" | logged harness node "$here/deploy.ts" harness
    echo "replace-1 starts at the next cron tick once the object runs this version; follow it with run.sh status."
    ;;
  rotate)
    now >"$out/rotate-at"
    python3 -I -c 'import json,secrets; print(json.dumps({"SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET": secrets.token_hex(32), "G2_STEP": "rotate"}))' |
      logged rotate secret_change
    ;;
  replace)
    now >"$out/replace-at"
    echo '{"G2_STEP": "replace-2", "G2_OWNER_PASSWORD": null}' | logged replace secret_change
    echo "replace-2 starts at the next cron tick; run.sh status shows when the server answers again."
    ;;
  recovery)
    now >"$out/recovery-at"
    echo '{"G2_STEP": "recovery"}' | logged recovery node "$here/deploy.ts" recovery
    ;;
  status)
    from="$(cat "$out/harness-at" 2>/dev/null || cat "$out/t0")"
    lines "$platform" "$from" |
      grep -E '"cfo\\?":\\?"(g2_sitting|watchdog|bootstrap)' | cut -c1-600 | tail -${2:-30}
    ;;
  rc07)
    z="$(zone)"
    lines "$platform" "$(cat "$out/harness-at")" | python3 -I -c '
import json, sys
host = sys.argv[1]
for line in sys.stdin:
    source = json.loads(line).get("source")
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except ValueError:
            continue
    if not isinstance(source, dict) or source.get("event") != "step_done":
        continue
    record = source.get("record", {})
    for f in (record.get("rc07") or {}).get("files", []):
        print(f.get("filename"), "https://" + host + f.get("path", ""), json.dumps(f.get("headers")))
' "$web.$z"
    ;;
  password)
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerPassword"])' "$secrets"
    ;;
  probe)
    logged probe node "$here/probe.ts" "${2:-}"
    ;;
  collect)
    from="$(cat "$out/t0")"
    dir="$out/collected-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$dir"
    for worker in "$platform" "$web"; do lines "$worker" "$from" >"$dir/$worker.jsonl"; done
    cp "$out"/*.log "$dir/" 2>/dev/null || true
    ls -la "$dir"
    ;;
  teardown)
    logged teardown-web "${stg[@]}" teardown --suffix g2-sitting-web || true
    logged teardown-platform "${stg[@]}" teardown --suffix g2-sitting-platform || true
    logged teardown-bucket "${stg[@]}" teardown --suffix g2-sitting-r2 || true
    logged teardown-list "${stg[@]}" list
    logged teardown-sweep "${stg[@]}" sweep
    rm -f "$secrets" "$install_dir/$platform.json"
    # Lock files stay: deleting one would let two holders coexist (scripts/staging/lock.ts).
    ;;
  *) sed -n '2,31p' "$0"; exit 2 ;;
esac
