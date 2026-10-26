#!/usr/bin/env bash
# G2 sitting (test tooling, laptop only): the production Workers and the server image from this
# checkout, installed on staging by the bootstrap (scripts/bootstrap) with an R2 replica, then
# the sitting's harness (platform.ts, steps.ts) on the same platform Worker. Every deploy and
# secret change goes through the guarded staging tool. Names: cfo-stg-g2-sitting-*.
#
#   run.sh bucket     deploy the replica bucket's holder (cfo-stg-g2-sitting-r2, bucket
#                     cfo-stg-g2-sitting-r2-db), plan the installation (owner "owner", replica
#                     s3://cfo-stg-g2-sitting-r2-db/omnigent), generate the owner's password;
#                     then deploy the 1 GB run (cfo-stg-g2-sitting-1gb, bucket
#                     cfo-stg-g2-sitting-1gb-db), which holds until `big`
#   run.sh token      [owner] paste the R2 token's two values (not echoed; one token for both
#                     buckets); sets them on the 1 GB run, starts the bootstrap in the background
#                     (log: $G2_DIR/bootstrap.log) and returns
#   run.sh follow     wait for the bootstrap to end; then the anonymous probe
#   run.sh resume     run the bootstrap again (exit 2 or 3 from follow: still waiting or not
#                     checked yet); it needs no secret once the first deploy is done
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
#   run.sh big        after the sitting: release the 1 GB run (VD-15 at 1 GB on `basic`, about
#                     35 minutes, unattended); big-status and big-collect follow it
#   run.sh teardown   tear everything down (web, platform, 1 GB run, holder), list and sweep,
#                     and remove the state and password files
#
# Output goes to $G2_DIR (default $HOME/.pt/g2-sitting), redacted with spikes/x1/scripts/redact.py
# (account, zone, owner address) before it leaves the laptop. Push images one at a time: run no
# other staging deploy while `token` (the bootstrap's image push) runs.
set -euo pipefail
# This script handles credentials (the owner's R2 token, the generated owner password, a new
# cookie secret): never trace it, even when started with `bash -x` (Codex G2 review, 1).
set +x
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
big=cfo-stg-g2-sitting-1gb
big_bucket=cfo-stg-g2-sitting-1gb-db
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

summarize() { # redacted Workers Logs lines on stdin: one compact line per harness event, with
  # each finished step's verdict and the fields its acceptance needs; "full" prints whole lines
  python3 -I -c '
import json, sys
from datetime import datetime, timezone
full = sys.argv[1] == "full"
keep = ("g2_sitting", "watchdog", "bootstrap", "wp26_staging", "wp26_seeder")
def pick(value, *keys):
    return {k: (value or {}).get(k) for k in keys}
for line in sys.stdin:
    try:
        event = json.loads(line)
    except ValueError:
        continue
    source = event.get("source")
    if isinstance(source, str):
        try:
            source = json.loads(source)
        except ValueError:
            continue
    if not isinstance(source, dict) or source.get("cfo") not in keep:
        continue
    if full:
        print(json.dumps(event))
        continue
    when = datetime.fromtimestamp((event.get("timestamp") or 0) / 1000, timezone.utc).strftime("%H:%M:%SZ")
    name = source.get("event")
    if name == "step_done":
        r = source.get("record") or {}
        after = r.get("after") or {}
        compact = {
            **pick(r, "step", "verdict", "problems", "answeredAfterKillS", "originFrom",
                   "observationLagS", "appliedBy", "appliedAfterSwitchS"),
            "probe": pick(r.get("probe"), "firstConfirmedWriteSentS",
                          "firstConfirmedWriteAnsweredS", "unconfirmedWritesBefore", "error"),
            "replica": r.get("replica"),
            "after": {
                **pick(after, "ownerLogin", "wrongPassword", "editMeKept", "health",
                       "sessionFromBeforeRestart", "keptForRotate"),
                "sharingManaged": (after.get("sharing") or {}).get("managed"),
                "configPass": (after.get("config") or {}).get("pass"),
            },
            "rotation": r.get("rotation"),
            "recovery": r.get("recovery"),
            "rc07": [
                {"file": f.get("filename"), "content": f.get("content"),
                 "disposition": (f.get("headers") or {}).get("content-disposition"),
                 "nosniff": (f.get("headers") or {}).get("x-content-type-options")}
                for f in ((r.get("rc07") or {}).get("files") or [])
            ],
        }
        compact = {k: v for k, v in compact.items() if v not in (None, {}, [])}
        print(when, "step_done", json.dumps(compact))
    else:
        rest = {k: v for k, v in source.items() if k not in ("cfo", "event")}
        print(when, source.get("cfo"), name, json.dumps(rest)[:300])
' "${1:-short}"
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
    # The 1 GB run (WP2.6's harness): the server image as the seeder's base, then its deploy
    # with generated secrets; it holds until the token and `big`.
    logged big-build docker build -q -f "$root/images/server/Dockerfile" -t cfo-g2-server:dev "$root"
    python3 -I -c '
import json, secrets, sys
account = json.load(open(sys.argv[1]))["accountId"]
print(json.dumps({
    "SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET": secrets.token_hex(32),
    "SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": "cfo-stg-" + secrets.token_urlsafe(18),
    "SERVER_ENV_CFO_REPLICA_ENDPOINT": f"https://{account}.r2.cloudflarestorage.com",
}))' "$state_dir/config.json" | logged big-deploy "${stg[@]}" deploy --suffix g2-sitting-1gb \
      --owner "$owner" --config worker/test/staging/g2/resnapshot/wrangler.jsonc --days 1 --secrets-stdin
    echo "Ready for the owner's R2 token: buckets cfo-stg-g2-sitting-r2-db and $big_bucket."
    ;;
  token)
    [ -f "$secrets" ] || { echo "run.sh bucket first"; exit 2; }
    echo "Paste the R2 token's values (they are not shown). Buckets: cfo-stg-g2-sitting-r2-db, $big_bucket"
    read -rsp "Access Key ID: " key_id
    echo
    read -rsp "Secret Access Key: " key_secret
    echo
    now >"$out/token-at"
    # The values go from this shell's builtin printf, through a pipe, to Python, and from it to
    # the staging tool's stdin (the 1 GB run) and the bootstrap's stdin: never on a command
    # line, in an environment or in a file.
    printf '%s\n%s\n' "$key_id" "$key_secret" | python3 -I -c '
import json, subprocess, sys
key_id = sys.stdin.readline().strip()
key_secret = sys.stdin.readline().strip()
if not key_id or not key_secret:
    sys.exit("both values are needed")
# The 1 GB run first; its output (names only) goes to the terminal, never to the bootstrap.
big = subprocess.run(
    ["node", "--no-warnings", sys.argv[2] + "/scripts/staging/stg.ts", "secrets",
     "--suffix", "g2-sitting-1gb", "--owner", "G2-sitting"],
    input=json.dumps({
        "SERVER_ENV_LITESTREAM_ACCESS_KEY_ID": key_id,
        "SERVER_ENV_LITESTREAM_SECRET_ACCESS_KEY": key_secret,
    }), text=True, cwd=sys.argv[2], stdout=sys.stderr, stderr=sys.stderr)
print("1 GB run: token " + ("set" if big.returncode == 0 else "NOT set (tell the lead)"), file=sys.stderr)
print(json.dumps({
    "ownerPassword": json.load(open(sys.argv[1]))["ownerPassword"],
    "replicaAccessKeyId": key_id,
    "replicaSecretAccessKey": key_secret,
}))' "$secrets" "$root" | setsid nohup bash -c '
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
  resume)
    logged resume "${bootstrap[@]}" run --staging g2-sitting --wait-minutes 30
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
    lines "$platform" "$from" | summarize "${2:-short}" | tail -n 40
    ;;
  rc07)
    z="$(zone)"
    # Read before the redaction, which would mask the session and file IDs (32 hex digits, like
    # an account ID; Codex G2 review, 9). The URLs go to this terminal only, for the owner.
    node "$here/logs.ts" "$platform" "$(cat "$out/harness-at")" "$(now)" | python3 -I -c '
import json, re, sys
host = sys.argv[1]
path_shape = re.compile(r"^/v1/sessions/[0-9a-f]{32}/resources/files/[0-9a-f]{32}/content$")
urls = {}
for line in sys.stdin:
    try:
        source = json.loads(line).get("source")
        if isinstance(source, str):
            source = json.loads(source)
    except ValueError:
        continue
    if not isinstance(source, dict) or source.get("event") != "step_done":
        continue
    record = source.get("record") or {}
    if record.get("step") != "replace-1":
        continue
    for f in (record.get("rc07") or {}).get("files") or []:
        path = f.get("path") or ""
        if path_shape.match(path):
            urls[f.get("filename")] = "https://" + host + path
for name, url in sorted(urls.items()):
    print(name, url)
if len(urls) != 2:
    sys.exit(f"expected the two attachment URLs from replace-1, found {len(urls)}")
' "$web.$z"
    ;;
  password)
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerPassword"])' "$secrets"
    ;;
  probe)
    # The account's workers.dev subdomain (the dashboard shows it) is not in the redaction list.
    sub="${2:-${CFO_WORKERS_DEV_SUBDOMAIN:-}}"
    set +e
    node "$here/probe.ts" "$sub" 2>&1 | scrub | sed -E "s#${sub:-^$}\.workers\.dev#<subdomain>.workers.dev#g" |
      tee "$out/probe.log"
    status=${PIPESTATUS[0]}
    set -e
    echo "exit $status" >>"$out/probe.log"
    exit "$status"
    ;;
  collect)
    from="$(cat "$out/t0")"
    dir="$out/collected-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$dir"
    for worker in "$platform" "$web"; do lines "$worker" "$from" >"$dir/$worker.jsonl"; done
    cp "$out"/*.log "$dir/" 2>/dev/null || true
    ls -la "$dir"
    ;;
  big)
    now >"$out/big-at"
    echo '{"WP26_GO": "go"}' | logged big "${stg[@]}" secrets --suffix g2-sitting-1gb --owner "$owner"
    echo "The 1 GB run starts within a minute and takes about 35 minutes; follow it with big-status."
    ;;
  big-status)
    lines "$big" "$(cat "$out/big-at")" | summarize "${2:-short}" | tail -n 40
    ;;
  big-collect)
    dir="$out/big-collected-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$dir"
    lines "$big" "$(cat "$out/big-at")" >"$dir/$big.jsonl"
    keys="$(CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects list --bucket-name "$big_bucket" \
      --prefix results/ | grep -oE 'results/[^" ]+/summary\.json' | sort -u)"
    for key in $keys; do
      CLOUDFLARE_ACCOUNT_ID="$(account)" pnpm -s --dir "$root/worker" exec wrangler r2 object get \
        "$big_bucket/$key" --remote --pipe 2>/dev/null >"$dir/raw.json"
      python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$dir/raw.json" ||
        { echo "could not read $key" >&2; rm -f "$dir/raw.json"; exit 1; }
      scrub <"$dir/raw.json" >"$dir/$(echo "$key" | tr / _)"
      rm -f "$dir/raw.json"
    done
    ls -la "$dir"
    ;;
  teardown)
    logged teardown-web "${stg[@]}" teardown --suffix g2-sitting-web || true
    logged teardown-platform "${stg[@]}" teardown --suffix g2-sitting-platform || true
    logged teardown-big "${stg[@]}" teardown --suffix g2-sitting-1gb || true
    logged teardown-bucket "${stg[@]}" teardown --suffix g2-sitting-r2 || true
    logged teardown-list "${stg[@]}" list
    logged teardown-sweep "${stg[@]}" sweep
    rm -f "$secrets" "$install_dir/$platform.json"
    docker image rm cfo-g2-server:dev >/dev/null 2>&1 || true
    # Lock files stay: deleting one would let two holders coexist (scripts/staging/lock.ts).
    ;;
  *) sed -n '2,40p' "$0"; exit 2 ;;
esac
