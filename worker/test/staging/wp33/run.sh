#!/usr/bin/env bash
# WP3.3 staging checks (test tooling, laptop only). Deploys only through the guarded staging tool.
# No owner step: each deployment's cron trigger starts its run by itself.
#
#   worker/test/staging/wp33/run.sh deploy bench|platform|final   one stamped deploy
#   worker/test/staging/wp33/run.sh campaign platform|final <tag> wait for that deployment's run
#                                                           with this tag to start, redeploy it at
#                                                           T0+16 min (the version switch), wait
#                                                           for the end, collect it
#   worker/test/staging/wp33/run.sh collect bench|platform|final <run-id>
#   worker/test/staging/wp33/run.sh teardown                every wp33 deployment
#
# Results go to $WP33_RESULTS (default $HOME/.pt/wp33/staging), outside the repository; redact
# them with spikes/x1/scripts/redact.py before they leave the laptop.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
results="${WP33_RESULTS:-$HOME/.pt/wp33/staging}"
state="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state/config.json" -)
owner=WP3.3
days=1
mkdir -p "$results/deploys"

now_ms() { date +%s%3N; }

bucket_of() { echo "cfo-stg-wp33-$1-results"; }

current_run() {
  # "<t0> <runId> <status> <tag>" of a deployment's current run, or nothing.
  local account
  account=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state/config.json")
  CLOUDFLARE_ACCOUNT_ID="$account" cf r2 objects get runs/current.json --bucket-name "$(bucket_of "$1")" 2>/dev/null |
    python3 -I -c 'import json,sys
try:
    r = json.load(sys.stdin)
except ValueError:
    sys.exit(0)
print(r["t0"], r["runId"], r["status"], r["tag"])' || true
}

deploy_one() {
  local target="$1" config build log start end status
  case "$target" in
    platform) config=worker/test/staging/wp33/wrangler.platform.jsonc ;;
    bench) config=worker/test/staging/wp33/wrangler.bench.jsonc ;;
    final) config=worker/test/staging/wp33/wrangler.final.jsonc ;;
    *) echo "run.sh: unknown target $target" >&2; exit 2 ;;
  esac
  build="wp33-$(date -u +%Y%m%dT%H%M%SZ)-$target"
  log="$results/deploys/$build.log"
  printf '// Written by run.sh before a deploy; restored after it.\nexport const BUILD = { id: "%s" };\n' "$build" >"$here/build.ts"
  start=$(now_ms)
  set +e
  (cd "$root" && pnpm stg deploy --suffix "wp33-$target" --owner "$owner" --config "$config" --days "$days") 2>&1 |
    "${redact[@]}" | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  end=$(now_ms)
  git -C "$root" checkout -- worker/test/staging/wp33/build.ts
  printf '{"target":"%s","build":"%s","start":%s,"end":%s,"status":%s}\n' \
    "$target" "$build" "$start" "$end" "$status" >>"$results/deploys.jsonl"
  return "$status"
}

wait_until() {
  local at="$1" left
  left=$(( (at - $(now_ms)) / 1000 ))
  if [ "$left" -gt 0 ]; then sleep "$left"; fi
}

wait_for_run() {
  # Waits up to 10 minutes for the deployment's run with this tag; prints "<t0> <runId>".
  local target="$1" tag="$2" deadline t0 run_id status run_tag
  deadline=$(( $(now_ms) + 600000 ))
  while [ "$(now_ms)" -lt "$deadline" ]; do
    read -r t0 run_id status run_tag < <(current_run "$target") || true
    if [ "${run_tag:-}" = "$tag" ]; then echo "$t0 $run_id"; return 0; fi
    sleep 20
  done
  return 1
}

collect() {
  local target="$1" run_id="$2" out
  out="$results/$target-$run_id"
  mkdir -p "$out"
  python3 -I "$here/analyze.py" collect "$(bucket_of "$target")" "$run_id" "$out"
  python3 -I "$here/analyze.py" analyse "$out" "$results/deploys.jsonl" | tee "$out/summary.json"
}

case "${1:-}" in
  deploy) deploy_one "${2:?bench or platform}" ;;
  campaign)
    target="${2:-platform}"
    tag="${3:-diag-1}"
    read -r t0 run_id < <(wait_for_run "$target" "$tag") || { echo "run.sh: no run" >&2; exit 1; }
    echo "$target run $run_id started at $t0"
    wait_until $(( t0 + 16 * 60000 )); deploy_one "$target"
    wait_until $(( t0 + 34 * 60000 ))
    collect "$target" "$run_id"
    ;;
  collect) collect "${2:?bench or platform}" "${3:?run ID}" ;;
  teardown)
    # Each one even if another was never deployed (the tool exits 1 for an unknown name).
    for target in platform bench final; do
      (cd "$root" && pnpm stg teardown --suffix "wp33-$target") 2>&1 | "${redact[@]}" |
        tee "$results/teardown-$target.log" || true
    done
    ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
