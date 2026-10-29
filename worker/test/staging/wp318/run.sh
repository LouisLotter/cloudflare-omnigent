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
#                        buckets); or `run.sh token --create`: the owner's own `cf` login creates
#                        that token itself (a user API token, "Workers R2 Storage Bucket Item
#                        Write" on exactly the two buckets, expiring in a day; its S3 key pair is
#                        its ID and the SHA-256 of its value, as R2's docs give them), never shown,
#                        and teardown deletes it. Either way it starts the bootstrap in the
#                        background ($WP318_DIR/bootstrap.log),
#                        which sets them for the replica and for the artifacts under their own
#                        names, deploys both Workers with the server and computer images, waits
#                        for the durable owner, releases, and verifies that the watchdog's
#                        controlled restart (`config_changed`) applied the release; a push the
#                        registry times out on, or a deploy whose version went live before its
#                        `durable_object` container application was applied (Wrangler says to
#                        deploy again), is retried with the same values (3 attempts)
#   run.sh follow        wait for the bootstrap to end
#   run.sh resume        run the bootstrap again (no secret needed once its first deploy is done)
#   run.sh launcher-key  generate the launcher's signing key, set it on the platform Worker, then
#                        wait for the watchdog's `config_changed` restart that applies it
#   run.sh applied <since ms>
#                        wait (25 minutes at most) for a `config_changed` restart after <since>
#   run.sh soak-deploy   deploy the platform Worker with the soak module (soak.ts): the
#                        production code plus the staging-only soak page and resets
#   run.sh replace       [lead, before the owner's part A] the forced server replacement (WP3.19):
#                        sets the Worker secret M3_STEP=replace (not the server's: no restart of
#                        its own), and the soak module's cron runs G2's replace-2 on the server
#                        (the container destroyed, the watchdog's start under the durable_object
#                        policy, timed; then the configuration, /health, /v1/info, the replica);
#                        waits (40 minutes at most) and writes replace.json. Never once the soak
#                        has started
#   run.sh restarts      the `config_changed` restarts since `bucket`, each with the watchdog's
#                        start-to-ready times (restarts.json): #1 the bootstrap's release, #2 the
#                        launcher's key
#   run.sh web-deploy    deploy the web Worker once, now (WP3.5's FH-38 check before the soak)
#   run.sh password      [owner] the owner's generated Omnigent password, onto the clipboard
#   run.sh hostile <computer ID>
#                        WP3.5's hostile page for the owner's browser (http://127.0.0.1:8088/)
#   run.sh campaign      after the owner's Start click: the web and platform deploys at their
#                        times (plan.ts), then wait for the end and collect
#   run.sh collect       the soak run's events, the deploys and the platform Worker's logs, and
#                        each host's tunnel opens from the sitting's start (presence.jsonl)
#   run.sh analyze       the RC-26 reconnect table and verdict.json (a `config_changed` restart
#                        during the soak fails it)
#   run.sh scan [--file <logs.jsonl>]
#                        the log checks over the sitting, both Workers (scan.ts), counts and
#                        positions only: WP3.5's terminal canary and capability; WP3.33's token
#                        shapes over every field of every event (Claude, OpenAI and GitHub tokens,
#                        JWTs, 64-hex R2 secret keys, 43-character launch and runner tokens) and
#                        the R2 token's own ID; the terminal's and the pages' events with their
#                        close codes (4001, 4002, 4003, 1006 …) and instance IDs, per window; and
#                        every `instance_started`. `--file`: the same over collected logs instead
#   run.sh layers <computer ID>
#                        download the computer's workspace layers for the RC-53 laptop scan
#   run.sh status [minutes]
#                        WP3.23: the computers' `computer_status` events (default: the last 60
#                        minutes) from the platform Worker's logs, as each status changed, then each
#                        computer's latest (names, versions, outcomes, reasons and counts only)
#   run.sh teardown      tear everything down (web first, platform, the holder), sweep, and
#                        remove the local secrets and the installation's state file
#
# The G3 sitting's lead-run tools (WP3.33). The first four are one-shot commands: run.sh writes a
# command object into the results bucket with the lead's `cf` login; the soak module's cron runs it
# once, within about a minute, and records its outcome, which run.sh waits for (3 minutes at
# most) and prints. Each is refused while a soak run is active (but soak-start), and when it is
# more than 10 minutes old when it would run. The soak run runs them, and its own start, one at a
# time. `--dry-run` prints the object and writes nothing.
#   run.sh computer-kill <computer ID> [--dry-run]
#                        step K: WorkspaceDO's `stagingKill`, the computer's container killed at
#                        once (SIGKILL), with no stop intent and no save, as a crash would; refused
#                        unless the bootstrap marked the installation as staging
#   run.sh workspace-reset <computer ID> [--dry-run]
#                        T1: the computer's WorkspaceDO reset (ctx.abort); its container runs on
#   run.sh server-reset [--dry-run]
#                        OmnigentServer reset (ctx.abort), as the soak's own server_reset
#   run.sh soak-start [--dry-run]
#                        T6: the soak run started (T0 = then), instead of the owner's Start click;
#                        then `run.sh campaign`
#   run.sh limits [--dry-run]
#                        read-only: the limits ControlDO answers with now (runs during a soak too)
#   run.sh limit <n | default> [--dry-run]
#                        B6: CFO_MAX_AWAKE_COMPUTERS for the installation, checked with ControlDO's
#                        own rule, kept in $WP318_DIR/limit for every later platform deploy, and
#                        deployed once through the staging tool (no server restart: not a
#                        SERVER_ENV_ value; OmnigentServer's version switch drops and reconnects
#                        the hosts, as any platform deploy); then asks ControlDO for its limits
#                        (the read-only `limits` command) until it answers with the new one (15
#                        minutes at most). `default` leaves the variable out again
#   run.sh wakes [--file <logs.jsonl>] [<from ms> [<to ms>]]
#                        the wake-time table (wakes.ts): per wake, Omnigent's resume, ControlDO's
#                        grant, the container's start() and DC-37's retries, the restore, the host
#                        connected and the first turn dispatched, with the start-after-stop gap
#                        and any staging kill before it; and every wake refused at the limit.
#                        Default window: from `bucket` to now. `--file`: kept logs (28 Oct's
#                        run-*/logs.jsonl are redacted: no host prefix, and timed from the grant)
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
# The lead's limit of awake computers (`run.sh limit`), rendered by every platform deploy.
if [ -s "$out/limit" ]; then
  WP318_MAX_AWAKE="$(cat "$out/limit")"
  export WP318_MAX_AWAKE
fi

now_ms() { date +%s%3N; }

account() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["accountId"])' "$state_dir/config.json"; }
zone() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["zone"])' "$state_dir/config.json"; }

create_r2_token() { # the R2 token, made by the owner's `cf` login: its S3 key pair on stdout
  # A user API token with "Workers R2 Storage Bucket Item Write" (read, write and list objects:
  # the dashboard's "Object Read & Write") on exactly the two buckets, expiring in a day. R2's S3
  # key pair is the token's ID and the SHA-256 of its value. The value goes from `cf`'s stdout
  # through a pipe to Python, which prints only the key pair to the caller's command substitution;
  # the token's ID alone (not a secret) is kept for teardown's delete.
  local expires policies
  expires="$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"
  policies="$(cf user tokens permission-groups list | python3 -I -c '
import json, sys
groups = json.load(sys.stdin)
groups = groups.get("result", groups) if isinstance(groups, dict) else groups
write = [g["id"] for g in groups if g.get("name") == "Workers R2 Storage Bucket Item Write"]
if len(write) != 1:
    sys.exit("run.sh: the R2 bucket write permission group was not found")
account, *buckets = sys.argv[1:]
print(json.dumps([{
    "effect": "allow",
    "permission_groups": [{"id": write[0]}],
    "resources": {f"com.cloudflare.edge.r2.bucket.{account}_default_{b}": "*" for b in buckets},
}]))' "$(account)" "$replica_bucket" "$artifacts_bucket")" || return 1
  cf user tokens create --name "cfo-stg-wp318-r2 (until $expires)" --expires-on "$expires" \
    --policies "$policies" 2>"$out/token-create.err" | python3 -I -c '
import hashlib, json, sys
answer = json.load(sys.stdin)
token = answer.get("result", answer) if isinstance(answer, dict) else {}
token_id, value = token.get("id"), token.get("value")
if not token_id or not value:
    sys.exit("run.sh: cf created no token (see token-create.err)")
with open(sys.argv[1], "w") as kept:
    kept.write(token_id + "\n")
print(token_id)
print(hashlib.sha256(value.encode()).hexdigest())' "$out/r2-token-id"
}

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
  local kind="$1" at="$2" record="${3:-$out/deploys.jsonl}" start end status build raw version
  local left=$(( (at - $(now_ms)) / 1000 ))
  if [ "$left" -gt 0 ]; then sleep "$left"; fi
  build="wp318-$(date -u +%Y%m%dT%H%M%SZ)-$kind"
  # Wrangler's own output, unredacted (mode 600), kept only until the version is read from it.
  raw="$(mktemp "$out/deploys/.raw.XXXXXX")"
  start=$(now_ms)
  set +e
  if [ "$kind" = web_deploy ]; then
    node "$here/soak-config.ts" web 2>&1 | tee "$raw" | "${redact[@]}" | tee "$out/deploys/$build.log"
  else
    node "$here/soak-config.ts" platform "$build" 2>&1 | tee "$raw" | "${redact[@]}" |
      tee "$out/deploys/$build.log"
  fi
  status=${PIPESTATUS[0]}
  set -e
  end=$(now_ms)
  # The version this deploy made current, as Wrangler prints it, cut as logs.ts cuts it
  # (shortVersion: the redacted log has only "<uuid>"): the analysis brackets the switch to exactly
  # this version (never a later deployment's). A deploy without one is still recorded.
  version=$(grep -oE 'Current Version ID: [0-9a-f-]+' "$raw" | tail -1 | awk '{print substr($4, 1, 13)}' || true)
  rm -f "$raw"
  printf '{"kind":"%s","build":"%s","start":%s,"end":%s,"status":%s,"version":"%s"}\n' \
    "$kind" "$build" "$start" "$end" "$status" "$version" >>"$record"
}

scan_worker() { # worker, from, to: the log checks (scan.ts), counts and positions only
  local values=()
  # The R2 token's ID (its S3 access key ID; `token --create` keeps it for teardown): counted if
  # it appears in any line. The secret half has the 64-hex shape scan.ts counts anyway.
  if [ -s "$out/r2-token-id" ]; then values=(--value-file "r2_access_key_id=$out/r2-token-id"); fi
  node "$here/logs.ts" "$1" "$2" "$3" --raw | node "$here/scan.ts" "$1" "${values[@]}"
}

command_once() { # command, [computer], [--dry-run]: one of the soak module's one-shot commands
  local verb="$1" computer="" dry=0 made key body id deadline result
  shift
  for arg in "$@"; do
    case "$arg" in --dry-run) dry=1 ;; *) computer="$arg" ;; esac
  done
  made="$(node "$here/commands.ts" make "$verb" ${computer:+"$computer"})" || exit 2
  key="${made%%$'\n'*}"
  body="${made#*$'\n'}"
  if [ "$dry" = 1 ]; then
    echo "dry run: would write $key into $platform-results:"
    echo "$body"
    return 0
  fi
  id="$(basename "$key" .json)"
  CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects put "$key" --bucket-name "$platform-results" \
    --content-type application/json --body "$body" >/dev/null
  echo "$verb ${computer:+$computer }written ($id); the soak module's cron runs it within about a minute"
  deadline=$(( $(now_ms) + 180000 ))
  while true; do
    result="$(r2_get "soak/command-results/$id.json" 2>/dev/null || true)"
    # commands.ts show: exit 0 ran, 1 refused or failed, 3 no outcome for this command yet.
    set +e
    printf '%s\n' "$result" | node "$here/commands.ts" show "$id" | "${redact[@]}"
    status=${PIPESTATUS[1]}
    set -e
    if [ "$status" -ne 3 ]; then
      printf '%s\n' "$result" | "${redact[@]}" | tee "$out/last-command.json" >>"$out/commands.jsonl"
      return "$status"
    fi
    [ "$(now_ms)" -lt "$deadline" ] || {
      echo "run.sh: no outcome within 3 minutes (is the soak module deployed? run.sh soak-deploy); a command older than 10 minutes is refused, never run late" >&2
      return 1
    }
    sleep 15
  done
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
    if [ "${2:-}" = "--create" ]; then
      echo "Creating the R2 token with your cf login (buckets $replica_bucket, $artifacts_bucket; not shown)"
      pair="$(create_r2_token)" || { echo "run.sh: no token created; see $out/token-create.err" >&2; exit 1; }
      key_id="${pair%%$'\n'*}"
      key_secret="${pair#*$'\n'}"
      unset pair
    else
      echo "Paste the R2 token's values (they are not shown). Buckets: $replica_bucket, $artifacts_bucket"
      read -rsp "Access Key ID: " key_id
      echo
      read -rsp "Secret Access Key: " key_secret
      echo
    fi
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
          tail -n +"$((from + 1))" "$3" | grep -q -e "timeout awaiting response headers" \
            -e "could not finish applying its Durable Object-managed Container application"; then
          attempt=$((attempt + 1))
          echo "run.sh: a push timed out, or a container application was not applied; attempt $attempt of 3 in 30 s" >>"$3"
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
  replace)
    since=$(now_ms)
    echo "$since" >"$out/replace-at"
    echo '{"M3_STEP": "replace"}' | logged replace node "$root/scripts/staging/stg.ts" secrets \
      --suffix wp318-platform --owner "$owner"
    # The version switch (5 to 7 minutes), the next cron tick, the kill and the watch (G2's limit:
    # 20 minutes), then the checks after it.
    deadline=$(( $(now_ms) + 2400000 ))
    while true; do
      set +e
      node "$here/logs.ts" "$platform" "$since" "$(now_ms)" |
        node "$here/server-checks.ts" replaced >"$out/replace.json"
      status=${PIPESTATUS[1]}
      set -e
      if [ "$status" -eq 0 ]; then
        echo "the replacement ended: $(cat "$out/replace.json")"
        break
      fi
      [ "$(now_ms)" -lt "$deadline" ] || { echo "run.sh: the replacement did not end within 40 minutes" >&2; exit 1; }
      sleep 30
    done
    ;;
  restarts)
    from="$(cat "$out/t0")"
    node "$here/logs.ts" "$platform" "$from" "$(now_ms)" |
      node "$here/server-checks.ts" restarts "$from" | tee "$out/restarts.json"
    ;;
  web-deploy)
    deploy_at web_deploy "$(now_ms)" "$out/sitting-deploys.jsonl"
    tail -n 1 "$out/sitting-deploys.jsonl"
    ;;
  password)
    # Onto the owner's clipboard where there is one (nothing to copy by hand); printed otherwise.
    if command -v wl-copy >/dev/null 2>&1 || command -v xclip >/dev/null 2>&1; then
      python3 -I -c 'import json,sys; sys.stdout.write(json.load(open(sys.argv[1]))["ownerPassword"])' "$secrets" |
        { if command -v wl-copy >/dev/null 2>&1; then wl-copy; else xclip -selection clipboard; fi; }
      echo "The owner's Omnigent password is on your clipboard: paste it into Omnigent's sign-in page."
    else
      python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["ownerPassword"])' "$secrets"
    fi
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
    # The lead's one-shot commands' outcomes (WP3.33): the analysis counts their resets as planned.
    r2_get soak/commands.json 2>/dev/null | "${redact[@]}" >"$run_dir/commands.json" ||
      echo "[]" >"$run_dir/commands.json"
    [ -s "$run_dir/commands.json" ] || echo "[]" >"$run_dir/commands.json"
    cp "$out/deploys.jsonl" "$run_dir/deploys.jsonl" 2>/dev/null || : >"$run_dir/deploys.jsonl"
    node "$here/logs.ts" "$platform" "$(( t0 - 600000 ))" "$(( t0 + 3 * 3600000 + 600000 ))" |
      "${redact[@]}" >"$run_dir/logs.jsonl"
    # Each host's tunnel opens from the sitting's start to the window (WP3.27), so the first
    # disruption judges a host that connected before the window (28 Oct: T0+10 had no row).
    sitting="$(cat "$out/t0" 2>/dev/null || echo "$(( t0 - 600000 ))")"
    if [ "$sitting" -lt "$(( t0 - 600000 ))" ]; then
      node "$here/logs.ts" "$platform" "$sitting" "$(( t0 - 600000 ))" | node "$here/opens.ts" |
        "${redact[@]}" >"$run_dir/presence.jsonl"
    else
      : >"$run_dir/presence.jsonl"
    fi
    echo "collected into $run_dir"
    ;;
  analyze)
    t0="$(soak_t0)"
    node "$here/analyze.ts" "$out/run-$t0" | tee "$out/run-$t0/analysis.txt"
    ;;
  scan)
    if [ "${2:-}" = "--file" ]; then
      file="${3:?run.sh scan --file <logs.jsonl>}"
      node "$here/scan.ts" "$(basename "$file")" <"$file" | "${redact[@]}" | tee "$out/scan-file.jsonl"
      exit 0
    fi
    from="$(cat "$out/t0")"
    to=$(now_ms)
    for worker in "$platform" "$web"; do scan_worker "$worker" "$from" "$to"; done |
      "${redact[@]}" | tee "$out/scan.jsonl"
    ;;
  computer-kill|workspace-reset)
    [ -n "${2:-}" ] && [ "${2:-}" != "--dry-run" ] || { echo "run.sh $1 <computer ID> [--dry-run]" >&2; exit 2; }
    command_once "$@"
    ;;
  server-reset|soak-start|limits)
    command_once "$@"
    ;;
  limit)
    value="${2:?run.sh limit <n | default> [--dry-run]}"
    node "$here/limit.ts" check "$value" || exit 2
    if [ "${3:-}" = "--dry-run" ]; then
      echo "dry run: nothing kept or deployed"
      exit 0
    fi
    if [ "$value" = default ]; then
      rm -f "$out/limit"
      unset WP318_MAX_AWAKE
    else
      echo "$value" >"$out/limit"
      export WP318_MAX_AWAKE="$value"
    fi
    since=$(now_ms)
    deploy_at limit "$since" "$out/sitting-deploys.jsonl"
    record="$(tail -n 1 "$out/sitting-deploys.jsonl")"
    echo "$record"
    deployed="$(printf '%s' "$record" | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["status"])')"
    [ "$deployed" = 0 ] || { echo "run.sh: the deploy failed; the limit is kept for the next deploy" >&2; exit 1; }
    # ControlDO reads the limit from its environment, so it answers with the new one once it runs
    # the deployed version: asked with the read-only `limits` command until it does.
    deadline=$(( $(now_ms) + 900000 ))
    while true; do
      if command_once limits && node "$here/limit.ts" holds "$value" <"$out/last-command.json"; then
        break
      fi
      [ "$(now_ms)" -lt "$deadline" ] || { echo "run.sh: ControlDO did not answer with the limit within 15 minutes" >&2; exit 1; }
      sleep 30
    done
    ;;
  wakes)
    shift
    if [ "${1:-}" = "--file" ]; then
      file="${2:?run.sh wakes --file <logs.jsonl>}"
      node "$here/wakes.ts" <"$file" | "${redact[@]}" | tee "$out/wakes-file.txt"
      exit 0
    fi
    from="${1:-$(cat "$out/t0")}"
    to="${2:-$(now_ms)}"
    node "$here/logs.ts" "$platform" "$from" "$to" | node "$here/wakes.ts" | "${redact[@]}" |
      tee "$out/wakes.txt"
    ;;
  status)
    minutes="${2:-60}"
    case "$minutes" in *[!0-9]*|'') echo "run.sh: status [minutes]" >&2; exit 2 ;; esac
    to=$(now_ms)
    node "$here/logs.ts" "$platform" "$(( to - minutes * 60000 ))" "$to" |
      node "$here/status.ts" | "${redact[@]}" | tee "$out/status.jsonl"
    ;;
  layers)
    computer="${2:?run.sh layers <computer ID>}"
    case "$computer" in cmp_*) ;; *) echo "run.sh: not a computer ID" >&2; exit 2 ;; esac
    dir="$out/layers/$computer"
    mkdir -p "$dir"
    chmod 700 "$out/layers" "$dir"
    # The bucket as the bootstrap names it from the plan: tagged since D33 (WP3.30).
    checkpoints="$(node --no-warnings "$here/soak-config.ts" checkpoints)"
    CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects list --bucket-name "$checkpoints" \
      --prefix "workspace/$computer/" --per-page 1000 |
      python3 -I -c 'import json,sys
d = json.load(sys.stdin)
d = d.get("result", d) if isinstance(d, dict) else d
for o in d if isinstance(d, list) else d.get("objects", []):
    print(o["key"])' |
      while read -r key; do
        CLOUDFLARE_ACCOUNT_ID="$(account)" cf r2 objects get "$key" \
          --bucket-name "$checkpoints" >"$dir/$(basename "$key")"
      done
    ls -l "$dir"
    ;;
  teardown)
    logged teardown-web node "$root/scripts/staging/stg.ts" teardown --suffix wp318-web || true
    logged teardown-platform node "$root/scripts/staging/stg.ts" teardown --suffix wp318-platform || true
    logged teardown-bucket node "$root/scripts/staging/stg.ts" teardown --suffix wp318-r2 || true
    # The R2 token `run.sh token --create` made: deleted, not left to expire.
    if [ -s "$out/r2-token-id" ]; then
      logged teardown-token cf user tokens delete "$(cat "$out/r2-token-id")" --force &&
        rm -f "$out/r2-token-id" || true
    fi
    logged teardown-list node "$root/scripts/staging/stg.ts" list
    logged sweep node "$root/scripts/staging/stg.ts" sweep
    rm -f "${secrets:?}" "${launcher:?}" "${install_dir:?}/${platform:?}.json"
    # The lead's limit (`run.sh limit`) belongs to this installation: never to the next one.
    rm -f "${out:?}/limit" "${out:?}/last-command.json"
    rm -rf "${out:?}/layers"
    # Lock files stay: deleting one would let two holders coexist (scripts/staging/lock.ts).
    ;;
  *)
    sed -n '2,/^set -euo/p' "$0" | sed '$d'
    exit 2
    ;;
esac
