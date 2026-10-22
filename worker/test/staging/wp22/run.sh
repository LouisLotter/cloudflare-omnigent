#!/usr/bin/env bash
# WP2.2 staging cases (test tooling, laptop only). Deploys only through the guarded staging tool.
#
#   worker/test/staging/wp22/run.sh deploy                 platform harness, then the web Worker,
#                                                          then the web Worker again with
#                                                          WP2.1's ingress variables
#                                                          (config-web.ts)
#   worker/test/staging/wp22/run.sh campaign               after the owner's Start click: the two
#                                                          deploys at T0+16 and T0+24 min, then
#                                                          collect and analyse
#   worker/test/staging/wp22/run.sh redeploy web|platform  one stamped redeploy
#   worker/test/staging/wp22/run.sh collect <run-id>       copy and analyse a run
#   worker/test/staging/wp22/run.sh teardown               the web Worker, then the platform
#
# Results and logs go to $WP22_RESULTS (default /home/decay/.pt/wp22/staging), outside the
# repository; redact them with spikes/x1/scripts/redact.py before they leave the laptop.
# Every deploy stamps build.ts, so a redeploy is a new Worker version with identical images, and
# restores it afterwards.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
results="${WP22_RESULTS:-/home/decay/.pt/wp22/staging}"
state="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state/config.json" -)
bucket=cfo-stg-wp22-platform-results
owner=WP2.2
days=2
mkdir -p "$results/deploys"

now_ms() { date +%s%3N; }

t0_of_run() {
  # T0 of the active run, from runs/current.json, or nothing.
  local account
  account=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state/config.json")
  CLOUDFLARE_ACCOUNT_ID="$account" cf r2 objects get runs/current.json --bucket-name "$bucket" 2>/dev/null |
    python3 -I -c 'import json,sys
try:
    r = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
print(r["t0"], r["runId"], r["status"])' || true
}

deploy_one() {
  local target="$1" offset="${2:--1}" suffix config build log start end status
  case "$target" in
    platform) suffix=wp22-platform; config=worker/test/staging/wp22/wrangler.platform.jsonc ;;
    web)
      suffix=wp22-web
      config=worker/test/staging/wp22/wrangler.web.jsonc
      # With WP2.1's ingress variables once config-web.ts has written them.
      if [ -f "$here/generated/wrangler.web.staging.jsonc" ]; then
        config=worker/test/staging/wp22/generated/wrangler.web.staging.jsonc
      fi
      ;;
    *) echo "run.sh: unknown target $target" >&2; exit 2 ;;
  esac
  build="wp22-$(date -u +%Y%m%dT%H%M%SZ)-$target"
  log="$results/deploys/$build.log"
  printf '// Written by run.sh before a deploy; restored after it.\nexport const BUILD = { id: "%s" };\n' "$build" >"$here/build.ts"
  start=$(now_ms)
  set +e
  (cd "$root" && pnpm stg deploy --suffix "$suffix" --owner "$owner" --config "$config" --days "$days") 2>&1 |
    "${redact[@]}" | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  end=$(now_ms)
  git -C "$root" checkout -- worker/test/staging/wp22/build.ts
  printf '{"target":"%s","build":"%s","start":%s,"end":%s,"status":%s,"t0Offset":%s}\n' \
    "$target" "$build" "$start" "$end" "$status" "$offset" >>"$results/deploys.jsonl"
  return "$status"
}

wait_until() {
  local at="$1" left
  left=$(( (at - $(now_ms)) / 1000 ))
  if [ "$left" -gt 0 ]; then sleep "$left"; fi
}

collect() {
  local run_id="$1" out="$results/$1"
  mkdir -p "$out"
  python3 -I "$here/analyze.py" collect "$run_id" "$out"
  python3 -I "$here/analyze.py" analyse "$out" "$results/deploys.jsonl" | tee "$out/summary.json"
}

case "${1:-}" in
  deploy)
    rm -f "$here/generated/wrangler.web.staging.jsonc"
    deploy_one platform
    deploy_one web
    (cd "$root" && node worker/test/staging/wp22/config-web.ts)
    deploy_one web
    echo "Owner: open https://cfo-stg-wp22-platform.<zone>/ and click Start; then run: $0 campaign"
    ;;
  redeploy) deploy_one "${2:?web or platform}" ;;
  campaign)
    echo "waiting for the owner's Start click (up to 2 hours)"
    deadline=$(( $(now_ms) + 7200000 ))
    read -r t0 run_id status < <(t0_of_run) || true
    while [ "${status:-}" != active ] && [ "$(now_ms)" -lt "$deadline" ]; do
      sleep 20
      read -r t0 run_id status < <(t0_of_run) || true
    done
    [ "${status:-}" = active ] || { echo "run.sh: no run started" >&2; exit 1; }
    echo "run $run_id started at $t0"
    wait_until $(( t0 + 16 * 60000 )); deploy_one web $(( $(now_ms) - t0 ))
    wait_until $(( t0 + 24 * 60000 )); deploy_one platform $(( $(now_ms) - t0 ))
    wait_until $(( t0 + 48 * 60000 ))
    collect "$run_id"
    ;;
  collect) collect "${2:?run ID}" ;;
  teardown)
    (cd "$root" && pnpm stg teardown --suffix wp22-web) 2>&1 | "${redact[@]}" | tee "$results/teardown-web.log"
    (cd "$root" && pnpm stg teardown --suffix wp22-platform) 2>&1 | "${redact[@]}" | tee "$results/teardown-platform.log"
    rm -rf "$here/generated"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
