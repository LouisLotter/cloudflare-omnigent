#!/usr/bin/env bash
# WP2.6 staging (test tooling, laptop only): the 1 GB restore through the production
# OmnigentServer watchdog and the final server image, on `basic`, against R2 (harness.ts).
#
#   run.sh deploy     build the server image, then deploy cfo-stg-wp26-restore with the guarded
#                     staging tool; the cookie secret and bootstrap password are generated here,
#                     the R2 endpoint comes from the staging config; nothing runs until the token
#   run.sh token      [owner] read the R2 token's Access Key ID and Secret Access Key from this
#                     terminal (not echoed) and set them on the Worker; the run starts within a
#                     minute and takes about 30 minutes
#   run.sh status     the run's lines in Workers Logs so far
#   run.sh collect    the summary from R2 and every Workers Logs line of the run, redacted, into
#                     $WP26_DIR/<run>/
#   run.sh teardown   tear down, list and sweep (the bucket may wait for R2's multipart cleanup)
#
# Output goes to $WP26_DIR (default $HOME/.pt/wp26/staging), redacted with
# spikes/x1/scripts/redact.py (account, zone, owner address) before it leaves the laptop.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${WP26_DIR:-$HOME/.pt/wp26/staging}"
state_dir="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state_dir/config.json" -)
suffix=wp26-restore
bucket=cfo-stg-wp26-restore-db
mkdir -p "$out"
chmod 700 "$out"

logged() { # name, command...: run, redact, keep the log
  local name="$1"; shift
  set +e
  ("$@") 2>&1 | "${redact[@]}" | tee "$out/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  echo "exit $status" >>"$out/$name.log"
  return "$status"
}

deploy_secrets() { # the generated secrets and the endpoint, as JSON, never on argv or disk
  python3 -I -c '
import json, secrets, sys
account = json.load(open(sys.argv[1]))["accountId"]
print(json.dumps({
    "SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET": secrets.token_hex(32),
    "SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD": "cfo-stg-" + secrets.token_urlsafe(18),
    "SERVER_ENV_CFO_REPLICA_ENDPOINT": f"https://{account}.r2.cloudflarestorage.com",
}))' "$state_dir/config.json"
}

case "${1:-}" in
  deploy)
    logged build docker build -q -f "$root/images/server/Dockerfile" -t cfo-wp26-server:dev "$root"
    date +%s%3N >"$out/deployed-at"
    deploy_secrets | logged deploy pnpm -s --dir "$root" stg deploy --suffix "$suffix" \
      --owner WP2.6 --config worker/test/staging/wp26/wrangler.jsonc --days 2 --secrets-stdin
    ;;
  token)
    echo "Paste the R2 token's values (they are not shown). Bucket: $bucket"
    read -rp "Access Key ID: " key_id
    read -rsp "Secret Access Key: " key_secret
    echo
    KEY_ID="$key_id" KEY_SECRET="$key_secret" python3 -I -c '
import json, os
print(json.dumps({
    "SERVER_ENV_LITESTREAM_ACCESS_KEY_ID": os.environ["KEY_ID"],
    "SERVER_ENV_LITESTREAM_SECRET_ACCESS_KEY": os.environ["KEY_SECRET"],
}))' | pnpm -s --dir "$root" stg secrets --suffix "$suffix" --owner WP2.6
    unset key_id key_secret
    date +%s%3N >"$out/token-at"
    echo "Set. The run starts within a minute and takes about 30 minutes."
    ;;
  status)
    from="$(cat "$out/deployed-at")"
    node "$root/worker/test/staging/wp26/collect.ts" "$from" "$(date +%s%3N)" |
      grep -E '"cfo":"(wp26_staging|wp26_seeder|watchdog)"' | "${redact[@]}" | tail -40
    ;;
  collect)
    from="$(cat "$out/deployed-at")"
    dir="$out/collected-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$dir"
    node "$root/worker/test/staging/wp26/collect.ts" "$from" "$(date +%s%3N)" |
      "${redact[@]}" >"$dir/workers-logs.jsonl"
    account="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' \
      "$state_dir/config.json")"
    keys="$(CLOUDFLARE_ACCOUNT_ID="$account" cf r2 objects list --bucket-name "$bucket" \
      --prefix results/ | grep -oE 'results/[^" ]+/summary\.json' | sort -u)"
    for key in $keys; do
      # Wrangler, like cf, needs the account named when the login sees more than one; without
      # it the read failed quietly and left an empty file (the collect of 26 Oct).
      CLOUDFLARE_ACCOUNT_ID="$account" pnpm -s --dir "$root/worker" exec wrangler r2 object get \
        "$bucket/$key" --remote --pipe 2>/dev/null >"$dir/raw.json"
      python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$dir/raw.json" ||
        { echo "could not read $key" >&2; rm -f "$dir/raw.json"; exit 1; }
      "${redact[@]}" <"$dir/raw.json" >"$dir/$(echo "$key" | tr / _)"
      rm -f "$dir/raw.json"
    done
    ls -la "$dir"
    ;;
  teardown)
    logged teardown pnpm -s --dir "$root" stg teardown --suffix "$suffix" || true
    logged teardown-list pnpm -s --dir "$root" stg list
    logged teardown-sweep pnpm -s --dir "$root" stg sweep
    ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
