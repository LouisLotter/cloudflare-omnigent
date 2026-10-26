#!/usr/bin/env bash
# WP3.18 staging: RC-26's 3-hour soak and WP3.4's real-account checks on the assembled platform
# (test tooling, laptop only). Runs only after Gate G2 is approved and the lead says go. Every
# deploy goes through the guarded staging tool, as the staging installation `wp318`
# (cfo-stg-wp318-platform and cfo-stg-wp318-web, owner WP3.18), installed by the bootstrap.
#
#   run.sh plan          plan the installation (owner "owner", a file replica: staging only)
#   run.sh bootstrap     generate the owner's password into $WP318_DIR (mode 600) and install:
#                        deploy both Workers, wait for the durable owner, release, check
#   run.sh launcher-key  generate the launcher's signing key and set it on the platform Worker
#                        (no deployment tool sets it yet; docs/secrets.md)
#   run.sh soak-deploy   deploy the platform Worker with the soak module (soak.ts): the
#                        production code plus the staging-only soak page and resets
#   run.sh campaign      after the owner's Start click: the web and platform deploys at their
#                        times (plan.ts), then wait for the end and collect
#   run.sh collect       the soak run's events, the deploys and the platform Worker's logs
#   run.sh analyze       the RC-26 reconnect table and verdict.json
#   run.sh layers <computer ID>
#                        download the computer's workspace layers for the RC-53 laptop scan
#   run.sh teardown      tear both down (web first), sweep, remove the local secrets
#
# Output goes to $WP318_DIR (default $HOME/.pt/wp318/staging), outside the repository; redact
# it with spikes/x1/scripts/redact.py before it leaves the laptop.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${WP318_DIR:-$HOME/.pt/wp318/staging}"
state_dir="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state_dir/config.json" -)
platform=cfo-stg-wp318-platform
web=cfo-stg-wp318-web
owner=WP3.18
days=2
secrets="$out/owner-secrets.json"
launcher="$out/launcher-secrets.json"
bootstrap=(node "$root/scripts/bootstrap/bootstrap.ts")
mkdir -p "$out/deploys"
chmod 700 "$out"

now_ms() { date +%s%3N; }

account() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state_dir/config.json"; }

logged() { # name, command...: run, redact, keep the log
  local name="$1"; shift
  set +e
  ("$@") 2>&1 | "${redact[@]}" | sed -E \
    -e 's#[a-z0-9-]+\.cloudflareaccess\.com#<team>#g' \
    -e 's#hmac-sha256:[A-Za-z0-9_:-]+#<owner-pin>#g' \
    -e 's#(ACCESS_AUD[^A-Za-z0-9]+)[A-Za-z0-9_-]{16,}#\1<aud>#g' | tee "$out/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  echo "exit $status" >>"$out/$name.log"
  return "$status"
}

r2_get() { # key: an object of the results bucket, on stdout
  CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects get "$1" --bucket-name "$platform-results"
}

soak_t0() { # the soak run's T0 (ms), or nothing before the Start click
  r2_get soak/current.json 2>/dev/null |
    python3 -I -c 'import json,sys
try:
    print(json.load(sys.stdin)["t0"])
except (ValueError, KeyError):
    pass' || true
}

deploy_at() { # kind, at (ms): wait until then, deploy, record it
  local kind="$1" at="$2" start end status build
  local left=$(( (at - $(now_ms)) / 1000 ))
  if [ "$left" -gt 0 ]; then sleep "$left"; fi
  build="wp318-$(date -u +%Y%m%dT%H%M%SZ)-$kind"
  start=$(now_ms)
  set +e
  if [ "$kind" = web_deploy ]; then
    node "$here/soak-config.ts" web 2>&1 | "${redact[@]}" | tee "$out/deploys/$build.log"
  else
    node "$here/soak-config.ts" platform "$build" 2>&1 | "${redact[@]}" | tee "$out/deploys/$build.log"
  fi
  status=${PIPESTATUS[0]}
  set -e
  end=$(now_ms)
  printf '{"kind":"%s","build":"%s","start":%s,"end":%s,"status":%s}\n' \
    "$kind" "$build" "$start" "$end" "$status" >>"$out/deploys.jsonl"
}

case "${1:-}" in
  plan)
    logged plan "${bootstrap[@]}" plan --staging wp318 --staging-owner "$owner" \
      --owner-username owner --replica-url file:///replica --days "$days"
    ;;
  bootstrap)
    if [ ! -f "$secrets" ]; then
      umask 077
      python3 -I -c 'import json,secrets; print(json.dumps({"ownerPassword": "cfo-stg-" + secrets.token_urlsafe(18)}))' >"$secrets"
    fi
    logged bootstrap "${bootstrap[@]}" run --staging wp318 --secrets-stdin --wait-minutes 30 <"$secrets"
    ;;
  launcher-key)
    if [ ! -f "$launcher" ]; then
      umask 077
      python3 -I -c 'import json,secrets,time; print(json.dumps({
  "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY": secrets.token_urlsafe(48),
  "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID": "k-wp318-" + time.strftime("%Y%m%d")}))' >"$launcher"
    fi
    logged launcher-key node "$root/scripts/staging/stg.ts" secrets --suffix wp318-platform \
      --owner "$owner" <"$launcher"
    ;;
  soak-deploy)
    logged soak-deploy node "$here/soak-config.ts" platform "wp318-$(date -u +%Y%m%dT%H%M%SZ)-soak"
    ;;
  campaign)
    t0=""
    deadline=$(( $(now_ms) + 3600000 ))
    while [ -z "$t0" ] && [ "$(now_ms)" -lt "$deadline" ]; do
      t0="$(soak_t0)"
      [ -n "$t0" ] || sleep 30
    done
    [ -n "$t0" ] || { echo "run.sh: no Start click within an hour" >&2; exit 1; }
    echo "soak T0 $t0"
    : >"$out/deploys.jsonl"
    while read -r kind at; do
      deploy_at "$kind" "$at"
    done < <(node -e '
      const { SOAK_SCHEDULE } = await import(process.argv[1]);
      for (const e of SOAK_SCHEDULE) if (e.by === "laptop") console.log(e.kind, Number(process.argv[2]) + e.at);
    ' "$here/plan.ts" "$t0")
    end=$(( t0 + 3 * 3600000 + 120000 ))
    left=$(( (end - $(now_ms)) / 1000 ))
    if [ "$left" -gt 0 ]; then sleep "$left"; fi
    "$0" collect
    ;;
  collect)
    t0="$(soak_t0)"
    [ -n "$t0" ] || { echo "run.sh: no soak run" >&2; exit 1; }
    run_dir="$out/run-$t0"
    mkdir -p "$run_dir"
    r2_get soak/current.json >"$run_dir/events.json"
    cp "$out/deploys.jsonl" "$run_dir/deploys.jsonl" 2>/dev/null || : >"$run_dir/deploys.jsonl"
    node "$here/logs.ts" "$platform" "$(( t0 - 600000 ))" "$(( t0 + 3 * 3600000 + 600000 ))" |
      "${redact[@]}" >"$run_dir/logs.jsonl"
    echo "collected into $run_dir"
    ;;
  analyze)
    t0="$(soak_t0)"
    node "$here/analyze.ts" "$out/run-$t0" | tee "$out/run-$t0/analysis.txt"
    ;;
  layers)
    computer="${2:?run.sh layers <computer ID>}"
    case "$computer" in cmp_*) ;; *) echo "run.sh: not a computer ID" >&2; exit 2 ;; esac
    dir="$out/layers/$computer"
    mkdir -p "$dir"
    chmod 700 "$out/layers" "$dir"
    CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects list --bucket-name "$platform-checkpoints" \
      --prefix "workspace/$computer/" --per-page 1000 |
      python3 -I -c 'import json,sys
d = json.load(sys.stdin)
d = d.get("result", d) if isinstance(d, dict) else d
for o in d if isinstance(d, list) else d.get("objects", []):
    print(o["key"])' |
      while read -r key; do
        CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects get "$key" \
          --bucket-name "$platform-checkpoints" >"$dir/$(basename "$key")"
      done
    ls -l "$dir"
    ;;
  teardown)
    logged teardown-web node "$root/scripts/staging/stg.ts" teardown --suffix wp318-web || true
    logged teardown-platform node "$root/scripts/staging/stg.ts" teardown --suffix wp318-platform
    logged sweep node "$root/scripts/staging/stg.ts" sweep
    rm -f "$secrets" "$launcher"
    rm -rf "$out/layers"
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d'
    exit 2
    ;;
esac
