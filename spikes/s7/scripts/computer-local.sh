#!/usr/bin/env bash
# Runs the staging computer image locally: the same replay.py and variants.json, from a container,
# against the emulated private route (the ENTRY=computer Worker on 127.0.0.1:8788).
#
#   bash spikes/s7/scripts/computer-local.sh <label>
#
# Writes spikes/s7/results/computer-local-<label>.json. Needs server.sh and workers.sh running.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HERE/.run"
LABEL="${1:-local}"
# shellcheck disable=SC1091
source "$RUN/secrets.env"

docker build --quiet --tag cfo-s7-computer:local "$HERE/server/computer" >/dev/null
umask 077
{
  echo "S7_LABEL=$LABEL"
  echo "S7_USERNAME=$S7_ADMIN_USERNAME"
  echo "S7_PASSWORD=$S7_ADMIN_PASSWORD"
  echo "S7_CONNECT=127.0.0.1:8788"
  echo "S7_RESULTS_URL=-"
} >"$RUN/computer.env"
docker run --rm --network host --label cfo.spike=s7 --env-file "$RUN/computer.env" \
  cfo-s7-computer:local >"$HERE/results/computer-local-$LABEL.json"
rm -f "$RUN/computer.env"
python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
print(f\"computer-local-{d['label']}: {d['passed']}/{d['total']} pass, error={d['error']!r}, final={d['finalState']}\")
for r in d['rows']:
    if not r['pass']:
        print('  FAIL', r['id'], r['status'], r['guard'], r['note'])
" "$HERE/results/computer-local-$LABEL.json"
