#!/bin/bash
# Spike S6: interrupt the local dry-run session (Ctrl-C, as SIGINT) at several points and check
# that cleanup always ends with a verified sign-out and nothing left behind.
#
#   bash spikes/s6/owner/interrupt-check.sh 9 13 17
set -uo pipefail
cd "$(dirname "$0")/../../.."
LOGDIR=$(mktemp -d)
status=0
for t in "$@"; do
  timeout -s INT "$t" python3 -I spikes/s6/owner/session_local.py --fake > "$LOGDIR/log-$t" 2>&1
  line=$(grep "cleanup:" "$LOGDIR/log-$t" | tail -1)
  echo "interrupt after ${t}s: ${line#*cleanup: }"
  case "$line" in *"'signed_out_verified': True"*"'computers': []"*"'minio': False"*) ;; *) status=1 ;; esac
done
rm -rf "$LOGDIR"
exit $status
