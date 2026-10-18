#!/bin/bash
# Spike S6: inject failures into the local dry-run session and check that cleanup never removes
# the recovery material before a verified sign-out, reports the failure, and succeeds once the
# cause is gone.
#
#   bash spikes/s6/owner/failure-check.sh codex-logout capture
set -uo pipefail
cd "$(dirname "$0")/../../.."
SHM=/dev/shm/cfo-s6-owner
status=0
for action in "$@"; do
  python3 -I spikes/s6/owner/session_local.py --fake --inject-failure "$action" > /tmp/s6-failure-$$.log 2>&1
  rc=$?
  kept=$( [ -d "$SHM" ] && docker ps -q --filter name=^cfo-s6-owner-minio$ | grep -q . && echo yes || echo no )
  line=$(grep "cleanup:" /tmp/s6-failure-$$.log | tail -1)
  echo "inject $action: session exit $rc; recovery material kept: $kept; ${line#*cleanup: }"
  [ "$rc" != 0 ] && [ "$kept" = yes ] || status=1
  rm -f "$SHM/fail-always-$action"
  python3 -I spikes/s6/owner/session_local.py --fake --cleanup > /tmp/s6-failure-$$.log 2>&1
  rc=$?
  line=$(grep "cleanup:" /tmp/s6-failure-$$.log | tail -1)
  echo "  after removing the cause, --cleanup exit $rc; ${line#*cleanup: }"
  [ "$rc" = 0 ] || status=1
done
rm -f /tmp/s6-failure-$$.log
exit $status
