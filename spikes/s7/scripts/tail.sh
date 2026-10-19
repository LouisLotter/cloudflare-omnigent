#!/usr/bin/env bash
# Captures the staging Worker's log lines while the owner runs the /__s7/ page.
#
#   bash spikes/s7/scripts/tail.sh            # runs until stopped; raw events in .run/tail.jsonl
#   bash spikes/s7/scripts/tail.sh extract    # writes the S7 log lines to results/staging-log.jsonl
#
# The raw tail holds request metadata (headers, client details), so it stays in the gitignored
# .run/ directory. Only the Worker's own console lines, which carry paths, statuses and
# results but no headers or credentials, are extracted into results/.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"

if [[ "${1:-}" == "extract" ]]; then
  node -e '
    const fs = require("node:fs");
    const out = [];
    // wrangler tail --format json pretty-prints each event, so an event spans many lines; each
    // one starts with "{" in the first column. A partial event at the end is skipped.
    for (const chunk of fs.readFileSync(process.argv[1], "utf8").split(/^(?=\{)/m)) {
      if (!chunk.trim()) continue;
      let event;
      try { event = JSON.parse(chunk); } catch { continue; }
      for (const log of event.logs ?? []) {
        for (const message of log.message ?? []) {
          if (typeof message !== "string" || !message.startsWith("{\"s7\"")) continue;
          out.push(JSON.stringify({ at: new Date(log.timestamp).toISOString(), ...JSON.parse(message) }));
        }
      }
    }
    fs.writeFileSync(process.argv[2], out.join("\n") + "\n");
    console.log(out.length + " S7 log lines");
  ' "$HERE/.run/tail.jsonl" "$HERE/results/staging-log.jsonl"
  exit 0
fi

CLOUDFLARE_ACCOUNT_ID="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).accountId)' "$STATE/config.json")"
export CLOUDFLARE_ACCOUNT_ID
cd "$ROOT/worker"
exec ./node_modules/.bin/wrangler tail cfo-stg-s7-managed --format json >>"$HERE/.run/tail.jsonl"
