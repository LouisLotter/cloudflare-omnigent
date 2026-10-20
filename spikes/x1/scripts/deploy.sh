#!/usr/bin/env bash
# Deploys X1 through the guarded staging tool, never around it. Each deploy stamps a new build ID
# into the target's src/build.js, so a redeploy changes only that stamp: a new Worker version with
# identical images (DC-36's fix: the staging tool builds images with its record's creation time).
#
#   spikes/x1/scripts/deploy.sh transport <label>   cfo-stg-x1-transport (deploy it first)
#   spikes/x1/scripts/deploy.sh ui <label>          cfo-stg-x1-ui (binds RunDO cross-script)
#   spikes/x1/scripts/deploy.sh both <label>        transport, then UI
#   spikes/x1/scripts/deploy.sh fingerprint         the images' layers, built locally (no deploy)
#
# Every output line gets a laptop timestamp (UTC ms) and is redacted (redact.py) before it is
# kept in $X1_RESULTS/deploys/<build>-<target>.log. One JSON line per deploy is appended to
# $X1_RESULTS/deploys.jsonl: the command's start, its "Uploaded" line, its end, its exit status,
# whether it pushed an image or changed a container application (deploylog.py), and, for the
# transport, the images' fingerprint and the staging record's creation time (the build epoch).
# $X1_RESULTS defaults to spikes/x1/results/run, which git ignores.
set -euo pipefail
x1="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$x1/../.." && pwd)"
results="${X1_RESULTS:-$x1/results/run}"
state="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
days="${X1_DAYS:-2}"
owner="${X1_OWNER:-X1}"

fingerprint() {
  # The layer digests of each image, built from the same Dockerfiles and contexts as Wrangler
  # builds them. Layers are rebuilt with new timestamps only if Docker's build cache lost them,
  # which would make a redeploy push new images and start a container rollout.
  local out="{" sep=""
  for image in server computer; do
    local id
    id=$(docker build -q --platform linux/amd64 "$x1/$image")
    local layers
    layers=$(docker image inspect "$id" --format '{{json .RootFS.Layers}}')
    out+="$sep\"$image\":$layers"
    sep=","
  done
  printf '%s}\n' "$out"
}

created_at() {
  # The staging record's creation time for a deployment: the images' build epoch.
  python3 -I -c 'import json,sys
d=[x for x in json.load(open(sys.argv[1]))["deployments"] if x["name"]==sys.argv[2]]
print(json.dumps(d[0]["createdAt"] if d else None))' "$state/resources.json" "$1"
}

check_flag() {
  # The single F7 build flag must agree with the manifest (src/flags.js explains both values).
  local flag token
  flag=$(sed -n 's/^export const PUBLIC_ROUTES = \(true\|false\);$/\1/p' "$x1/transport/src/flags.js")
  if grep -q '"serviceToken"[[:space:]]*:' "$x1/transport/staging.jsonc"; then token=true; else token=false; fi
  if [ "$flag" != "$token" ]; then
    echo "deploy.sh: PUBLIC_ROUTES is $flag but staging.jsonc's service token is $([ "$token" = true ] && echo present || echo absent); refusing" >&2
    exit 1
  fi
}

deploy_one() {
  local target="$1" label="$2" suffix config build start end status log
  case "$target" in
    transport) suffix=x1-transport ;;
    ui) suffix=x1-ui ;;
    *) echo "deploy.sh: unknown target $target" >&2; exit 2 ;;
  esac
  config="spikes/x1/$target/wrangler.jsonc"
  build="${label}-$(date -u +%H%M%S)"
  mkdir -p "$results/deploys"
  log="$results/deploys/$build-$target.log"
  cat >"$x1/$target/src/build.js" <<EOF
// Written by spikes/x1/scripts/deploy.sh before every deploy, so that a redeploy changes only
// this stamp.
export const BUILD = { id: "$build" };
EOF
  start=$(date +%s%3N)
  set +e
  (cd "$root" && pnpm stg deploy --suffix "$suffix" --owner "$owner" --config "$config" --days "$days") 2>&1 |
    while IFS= read -r line; do printf '%s %s\n' "$(date +%s%3N)" "$line"; done |
    python3 -I "$x1/scripts/redact.py" "$state/config.json" - | tee "$log"
  status=${PIPESTATUS[0]}
  set -e
  end=$(date +%s%3N)
  local parsed extra=""
  parsed=$(python3 -I "$x1/scripts/deploylog.py" "$log" "$target")
  if [ "$target" = transport ]; then
    extra=",\"fingerprint\":$(fingerprint),\"recordCreatedAt\":$(created_at "cfo-stg-$suffix")"
  fi
  printf '{"target":"%s","build":"%s","start":%s,"end":%s,"status":%s,"log":"%s","parsed":%s%s}\n' \
    "$target" "$build" "$start" "$end" "$status" "$(basename "$log")" "$parsed" "$extra" \
    >>"$results/deploys.jsonl"
  return "$status"
}

target="${1:?usage: deploy.sh transport|ui|both <label> | deploy.sh fingerprint}"
if [ "$target" = fingerprint ]; then
  fingerprint
  exit 0
fi
label="${2:?usage: deploy.sh transport|ui|both <label>}"
check_flag
case "$target" in
  both)
    deploy_one transport "$label"
    deploy_one ui "$label"
    ;;
  *) deploy_one "$target" "$label" ;;
esac
