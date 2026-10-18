#!/usr/bin/env bash
# Stamps the build, then deploys through the guarded staging tool. Every output line gets a
# laptop timestamp (UTC ms), so the moment the new Worker version went live can be read from
# the log. The account ID, zone and owner email are redacted before the log is kept.
#
#   spikes/s2/scripts/deploy.sh <label> [reregister=true|false]
#
# Results go to $S2_RESULTS (default spikes/s2/results/run): deploys.jsonl and deploys/<build>.log.
set -euo pipefail
s2="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$s2/../.." && pwd)"
label="${1:?usage: deploy.sh <label> [true|false]}"
reregister="${2:-true}"
id="${label}-$(date -u +%H%M%S)"
results="${S2_RESULTS:-$s2/results/run}"
mkdir -p "$results/deploys"

cat >"$s2/src/build.js" <<EOF
// Written by spikes/s2/scripts/deploy.sh before every deploy, so that each deploy is a new
// Worker version and every log line names the version that wrote it.
export const BUILD = { id: "$id", reregister: $reregister };
EOF

state="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact() {
  python3 -I "$s2/scripts/redact.py" "$state/config.json"
}

start=$(date +%s%3N)
set +e
(cd "$root" && pnpm stg deploy --suffix s2-route --owner S2 --config spikes/s2/wrangler.jsonc --days 2) 2>&1 |
  while IFS= read -r line; do printf '%s %s\n' "$(date +%s%3N)" "$line"; done |
  redact | tee "$results/deploys/$id.log"
status=${PIPESTATUS[0]}
set -e
end=$(date +%s%3N)
printf '{"build":"%s","reregister":%s,"start":%s,"end":%s,"status":%s}\n' \
  "$id" "$reregister" "$start" "$end" "$status" >>"$results/deploys.jsonl"
exit "$status"
