#!/usr/bin/env bash
# Anonymous requests to the spike's public hostname must be redirected to Access, never
# served. Prints the status and the redirect's host, redacted.
set -euo pipefail
s2="$(cd "$(dirname "$0")/.." && pwd)"
state="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
zone="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["zone"])' "$state/config.json")"
for path in /s2/status /s2/start /_s2/whoami /_s2/report /v1/hosts; do
  curl -s -o /dev/null -w "$(date -u +%FT%TZ) GET $path -> %{http_code} %{redirect_url}\n" \
    "https://cfo-stg-s2-route.$zone$path" |
    python3 -I "$s2/scripts/redact.py" "$state/config.json" |
    python3 -I -c 'import re,sys; [print(re.sub(r"\?.*", "?…", re.sub(r"https://[^/]+\.cloudflareaccess\.com", "https://<team>.cloudflareaccess.com", l)), end="") for l in sys.stdin]'
done
