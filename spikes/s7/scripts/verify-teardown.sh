#!/usr/bin/env bash
# Read-only checks that the S7 staging deployment is gone: Worker, container applications,
# registry images, Access application, registry record and hostname. Writes a sanitized summary
# (no account ID, no zone) to spikes/s7/results/staging-teardown.txt.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
NAME="cfo-stg-s7-managed"
read_config() { node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]])' "$STATE/config.json" "$1"; }
CLOUDFLARE_ACCOUNT_ID="$(read_config accountId)"
export CLOUDFLARE_ACCOUNT_ID
ZONE="$(read_config zone)"
HOST="$NAME.$ZONE"
OUT="$HERE/results/staging-teardown.txt"

sanitize() { sed -e "s/$CLOUDFLARE_ACCOUNT_ID/<account>/g" -e "s/$ZONE/<zone>/g"; }
{
  echo "checked $(date -u +%FT%TZ)"
  echo "-- Worker: cf workers get $NAME"
  cf workers get "$NAME" 2>&1 | head -3
  for app in "$NAME-server" "$NAME-computer"; do
    echo "-- container application $app: cf containers applications list --name $app"
    cf containers applications list --name "$app" 2>&1 | head -3
  done
  echo "-- registry images: cf containers images list (total entries, then entries matching $NAME)"
  cf containers images list 2>&1 | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const a = JSON.parse(s); console.log(`valid listing: ${a.length} entries; ${a.filter((e) => JSON.stringify(e).includes(process.argv[1])).length} matching`); }
      catch { console.log("listing was not JSON"); }
    });' "$NAME"
  echo "-- Access applications on $NAME.<zone>: cf zero-trust access applications list --domain … --exact"
  cf zero-trust access applications list --domain "$HOST" --exact 2>&1 | head -3
  echo "-- staging registry record: pnpm stg list | grep $NAME"
  (cd "$ROOT" && pnpm -s stg list 2>&1 | grep -c "$NAME") || true
  echo "-- hostname: curl https://$NAME.<zone>/"
  curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 "https://$HOST/" 2>&1 || echo "no response"
} 2>&1 | sanitize | tee "$OUT"
