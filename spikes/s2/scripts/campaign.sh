#!/usr/bin/env bash
# The whole S2 measurement, after the deployment exists and the owner has opened /s2/start:
#   1. wait for the Omnigent host's first hello through the private route;
#   2. soak: SOAK_S seconds (default 2 h) with no deploys;
#   3. redeploys: four with intercept re-registration, one without, one with again, GAP_S
#      seconds apart (default 5 min);
#   4. collect the Workers Logs and summarise them into results/run/.
# Teardown stays a separate, checked step (see docs/verification/spike-s2.md).
#
#   spikes/s2/scripts/campaign.sh <kickoff-ms>
set -euo pipefail
s2="$(cd "$(dirname "$0")/.." && pwd)"
results="${S2_RESULTS:-$s2/results/run}"
soak_s="${SOAK_S:-7200}"
gap_s="${GAP_S:-300}"
kickoff="${1:?usage: campaign.sh <kickoff-ms>}"
mkdir -p "$results"
note() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$results/campaign.log"; }

note "waiting for the host's first hello since $kickoff"
python3 -I "$s2/scripts/wait_for.py" host-hello "$kickoff" 900
python3 -I "$s2/scripts/wait_for.py" conv-turn "$kickoff" 600
soak_from=$(date +%s%3N)
note "soak from $soak_from for $soak_s s"
sleep "$soak_s"
soak_to=$(date +%s%3N)
note "soak to $soak_to"
printf '{"kickoff":%s,"soakFrom":%s,"soakTo":%s}\n' "$kickoff" "$soak_from" "$soak_to" \
  >"$results/window.json"

for step in "r1 true" "r2 true" "r3 true" "r4 true" "r5-noreregister false" "r6 true"; do
  set -- $step
  note "redeploy $1 (reregister=$2)"
  S2_RESULTS="$results" "$s2/scripts/deploy.sh" "$1" "$2" >/dev/null
  sleep "$gap_s"
done

end=$(date +%s%3N)
note "collecting $((kickoff - 60000))..$end"
python3 -I "$s2/scripts/collect.py" "$((kickoff - 60000))" "$end" "$results/records.jsonl"
python3 -I "$s2/scripts/analyze.py" "$results/records.jsonl" "$results/deploys.jsonl" \
  "$soak_from" "$soak_to" >"$results/summary.json"
note "summary in $results/summary.json"
