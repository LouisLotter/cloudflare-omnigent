#!/usr/bin/env bash
# The M3 sitting (test tooling, laptop only): WP3.18's RC-26 3-hour soak and WP3.4's real-account
# checks, with WP3.5's platform-page checks, on one assembled staging installation `wp318`
# (cfo-stg-wp318-platform and cfo-stg-wp318-web, owner WP3.18), installed by the bootstrap with an
# R2 replica and Omnigent's artifacts bucket (G2-DUR-001). Every deploy and secret change goes
# through the guarded staging tool. Runs only after Gate G2 is approved and the lead says go.
#
#   run.sh bucket        deploy the buckets' holder (cfo-stg-wp318-r2: buckets cfo-stg-wp318-r2-db
#                        and cfo-stg-wp318-r2-artifacts), plan the installation (owner "owner",
#                        replica s3://cfo-stg-wp318-r2-db/omnigent, artifacts
#                        s3://cfo-stg-wp318-r2-artifacts), check the buckets, and generate the
#                        owner's Omnigent password into $WP318_DIR (mode 600)
#   run.sh token         [owner] paste one R2 token's two values (not echoed; one token for both
#                        buckets); starts the bootstrap in the background ($WP318_DIR/bootstrap.log),
#                        which sets them for the replica and for the artifacts under their own
#                        names, deploys both Workers with the server and computer images, waits
#                        for the durable owner, releases, and verifies that the watchdog's
#                        controlled restart (`config_changed`) applied the release; a push the
#                        registry times out on is retried with the same values (3 attempts)
#   run.sh follow        wait for the bootstrap to end
#   run.sh resume        run the bootstrap again (no secret needed once its first deploy is done)
#   run.sh launcher-key  generate the launcher's signing key, set it on the platform Worker, then
#                        wait for the watchdog's `config_changed` restart that applies it
#   run.sh applied <since ms>
#                        wait (25 minutes at most) for a `config_changed` restart after <since>
#   run.sh soak-deploy   deploy the platform Worker with the soak module (soak.ts): the
#                        production code plus the staging-only soak page and resets
#   run.sh web-deploy    deploy the web Worker once, now (WP3.5's FH-38 check before the soak)
#   run.sh password      [owner] print the owner's generated Omnigent password
#   run.sh hostile <computer ID>
#                        WP3.5's hostile page for the owner's browser (http://127.0.0.1:8088/)
#   run.sh campaign      after the owner's Start click: the web and platform deploys at their
#                        times (plan.ts), then wait for the end and collect
#   run.sh collect       the soak run's events, the deploys and the platform Worker's logs
#   run.sh analyze       the RC-26 reconnect table and verdict.json (a `config_changed` restart
#                        during the soak fails it)
#   run.sh scan          WP3.5's log checks over the sitting, both Workers: no terminal canary
#                        and no capability in any line; the terminal's and the pages' events
#   run.sh layers <computer ID>
#                        download the computer's workspace layers for the RC-53 laptop scan
#   run.sh teardown      tear everything down (web first, platform, the holder), sweep, and
#                        remove the local secrets and the installation's state file
#
# Output goes to $WP318_DIR (default $HOME/.pt/wp318/staging), outside the repository, redacted
# with spikes/x1/scripts/redact.py (account, zone, owner address) before it leaves the laptop.
# Push images one at a time: run no other staging deploy while the bootstrap pushes its images.
set -euo pipefail
# This script handles credentials (the owner's R2 token, the generated owner password, the
# launcher's key): never trace it, even when started with `bash -x`.
set +x
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${WP318_DIR:-$HOME/.pt/wp318/staging}"
state_dir="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
install_dir="${CFO_INSTALL_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/installations}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state_dir/config.json" -)
platform=cfo-stg-wp318-platform
web=cfo-stg-wp318-web
owner=WP3.18
days=2
replica_bucket=cfo-stg-wp318-r2-db
artifacts_bucket=cfo-stg-wp318-r2-artifacts
secrets="$out/owner-secrets.json"
launcher="$out/launcher-secrets.json"
bootstrap=(node "$root/scripts/bootstrap/bootstrap.ts")
mkdir -p "$out/deploys"
chmod 700 "$out"

now_ms() { date +%s%3N; }

account() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state_dir/config.json"; }
zone() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["zone"])' "$state_dir/config.json"; }

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

deploy_at() { # kind, at (ms)[, record file]: wait until then, deploy, record it
  local kind="$1" at="$2" record="${3:-$out/deploys.jsonl}" start end status build
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
  # The version this deploy made current, as Wrangler prints it: the analysis brackets the switch
  # to exactly this version (never a later deployment's).
  version=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$out/deploys/$build.log" | tail -1 | awk '{print $4}')
  printf '{"kind":"%s","build":"%s","start":%s,"end":%s,"status":%s,"version":"%s"}\n' \
    "$kind" "$build" "$start" "$end" "$status" "$version" >>"$record"
}

scan_worker() { # worker, from, to: WP3.5's log checks, counts and event names only
  node "$here/logs.ts" "$1" "$2" "$3" | python3 -I -c '
import json, sys
canary = capability = 0
events = []
for line in sys.stdin:
    canary += line.count("cfo-canary-wp35-terminal")
    capability += line.count("cfo-capability.")
    try:
        event = json.loads(line)
        source = event.get("source")
        if isinstance(source, str):
            source = json.loads(source)
    except ValueError:
        continue
    name = source.get("event") if isinstance(source, dict) else None
    if isinstance(name, str) and (name.startswith("terminal_") or name == "page_change_refused"):
        events.append({"at": event.get("timestamp"), "event": name,
                       "reason": source.get("reason"), "window": source.get("window")})
print(json.dumps({"worker": sys.argv[1], "canaryHits": canary, "capabilityHits": capability,
                  "events": events}))' "$1"
}

case "${1:-}" in
  bucket)
    now_ms >"$out/t0"
    logged bucket node "$root/scripts/staging/stg.ts" deploy --suffix wp318-r2 --owner "$owner" \
      --config "$here/bucket/wrangler.jsonc" --days "$days"
    logged plan "${bootstrap[@]}" plan --staging wp318 --staging-owner "$owner" \
      --owner-username owner --replica-url "s3://$replica_bucket/omnigent" \
      --artifacts-url "s3://$artifacts_bucket" \
      --replica-endpoint "https://$(account).r2.cloudflarestorage.com" --days "$days"
    logged buckets "${bootstrap[@]}" buckets --staging wp318
    if [ ! -f "$secrets" ]; then
      (umask 077; python3 -I -c 'import json,secrets; print(json.dumps({"ownerPassword": "cfo-stg-" + secrets.token_urlsafe(18)}))' >"$secrets")
    fi
    echo "Ready for the owner's R2 token: buckets $replica_bucket and $artifacts_bucket."
    ;;
  token)
    [ -f "$secrets" ] || { echo "run.sh bucket first"; exit 2; }
    echo "Paste the R2 token's values (they are not shown). Buckets: $replica_bucket, $artifacts_bucket"
    read -rsp "Access Key ID: " key_id
    echo
    read -rsp "Secret Access Key: " key_secret
    echo
    now_ms >"$out/token-at"
    # The values go from this shell's builtin printf, through a pipe, to Python, and from it to
    # the bootstrap's stdin: never on a command line, in an environment or in a file. The
    # bootstrap sets them for the replica and, as the artifacts' default, for the artifacts.
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
      # The values stay in this unexported variable, so that a push the registry times out on
      # ("timeout awaiting response headers") is retried without the owner: at most 3 attempts.
      given="$(cat)"
      : >"$3"
      attempt=1
      while true; do
        from=$(wc -l <"$3")
        printf "%s" "$given" |
          node "$1/scripts/bootstrap/bootstrap.ts" run --staging wp318 --secrets-stdin --wait-minutes 45 2>&1 |
          python3 -I "$1/spikes/x1/scripts/redact.py" "$2" - |
          sed -E -e "s#[a-z0-9-]+\.cloudflareaccess\.com#<team>#g" -e "s#hmac-sha256:[A-Za-z0-9_:-]+#<owner-pin>#g" >>"$3"
        status=${PIPESTATUS[1]}
        if [ "$status" -eq 1 ] && [ "$attempt" -lt 3 ] &&
          tail -n +"$((from + 1))" "$3" | grep -q "timeout awaiting response headers"; then
          attempt=$((attempt + 1))
          echo "run.sh: the registry timed out on a push; attempt $attempt of 3 in 30 s" >>"$3"
          sleep 30
          continue
        fi
        break
      done
      unset given
      echo "exit $status" >>"$3"' _ "$root" "$state_dir/config.json" "$out/bootstrap.log" \
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
    ;;
  resume)
    logged resume "${bootstrap[@]}" run --staging wp318 --wait-minutes 30
    ;;
  launcher-key)
    if [ ! -f "$launcher" ]; then
      umask 077
      python3 -I -c 'import json,secrets,time; print(json.dumps({
  "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY": secrets.token_urlsafe(48),
  "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID": "k-wp318-" + time.strftime("%Y%m%d")}))' >"$launcher"
    fi
    since=$(now_ms)
    echo "$since" >"$out/launcher-at"
    logged launcher-key node "$root/scripts/staging/stg.ts" secrets --suffix wp318-platform \
      --owner "$owner" <"$launcher"
    # A secret release reaches the running server only through the watchdog's controlled restart
    # (G2-SEC-001): the version switch (5 to 7 minutes), the next alarm, then about 30 s.
    "$0" applied "$since"
    ;;
  applied)
    since="${2:?run.sh applied <since ms>}"
    deadline=$(( $(now_ms) + 1500000 ))
    while true; do
      set +e
      node "$here/logs.ts" "$platform" "$since" "$(now_ms)" | node "$here/restart.ts" "$since" >"$out/applied.json"
      status=${PIPESTATUS[1]}
      set -e
      if [ "$status" -eq 0 ]; then
        echo "applied by the watchdog's restart: $(cat "$out/applied.json")"
        break
      fi
      [ "$(now_ms)" -lt "$deadline" ] || { echo "run.sh: no config_changed restart ended within 25 minutes" >&2; exit 1; }
      sleep 30
    done
    ;;
  soak-deploy)
    logged soak-deploy node "$here/soak-config.ts" platform "wp318-$(date -u +%Y%m%dT%H%M%SZ)-soak"
    ;;
  web-deploy)
    deploy_at web_deploy "$(now_ms)" "$out/sitting-deploys.jsonl"
    tail -n 1 "$out/sitting-deploys.jsonl"
    ;;
  password)
    python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerPassword"])' "$secrets"
    ;;
  hostile)
    computer="${2:?run.sh hostile <computer ID>}"
    node "$root/worker/test/staging/wp35/hostile.ts" "$web.$(zone)" "$computer" "$out/hostile.json"
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
  scan)
    from="$(cat "$out/t0")"
    to=$(now_ms)
    for worker in "$platform" "$web"; do scan_worker "$worker" "$from" "$to"; done |
      "${redact[@]}" | tee "$out/scan.jsonl"
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
    logged teardown-platform node "$root/scripts/staging/stg.ts" teardown --suffix wp318-platform || true
    logged teardown-bucket node "$root/scripts/staging/stg.ts" teardown --suffix wp318-r2 || true
    logged teardown-list node "$root/scripts/staging/stg.ts" list
    logged sweep node "$root/scripts/staging/stg.ts" sweep
    rm -f "${secrets:?}" "${launcher:?}" "${install_dir:?}/${platform:?}.json"
    rm -rf "${out:?}/layers"
    # Lock files stay: deleting one would let two holders coexist (scripts/staging/lock.ts).
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d'
    exit 2
    ;;
esac
