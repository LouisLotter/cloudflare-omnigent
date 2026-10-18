#!/bin/bash
# Spike S6: inject failures into the local dry-run session and check that cleanup never removes
# the recovery material before a verified sign-out, reports the failure, and succeeds once the
# cause is gone.
#
#   bash spikes/s6/owner/failure-check.sh codex-logout capture store-stopped
#
# store-stopped (IR-014): the session stops signed in (a logout that always fails), then the
# checkpoint store is stopped. Cleanup must report the state as unknown, keep everything, exit
# non-zero and tell the owner to revoke the sessions; with the store back and the cause removed,
# --cleanup verifies the sign-out.
set -uo pipefail
cd "$(dirname "$0")/../../.."
SHM=/dev/shm/cfo-s6-owner
MINIO=cfo-s6-owner-minio
LOG=$(mktemp)
status=0
for action in "$@"; do
  inject=$action
  [ "$action" = store-stopped ] && inject=codex-logout
  python3 -I spikes/s6/owner/session_local.py --fake --inject-failure "$inject" > "$LOG" 2>&1
  rc=$?
  kept=$( [ -d "$SHM" ] && docker ps -q --filter "name=^$MINIO$" | grep -q . && echo yes || echo no )
  line=$(grep "cleanup:" "$LOG" | tail -1)
  echo "inject $action: session exit $rc; recovery material kept: $kept; ${line#*cleanup: }"
  [ "$rc" != 0 ] && [ "$kept" = yes ] || status=1
  if [ "$action" = store-stopped ]; then
    docker stop "$MINIO" > /dev/null
    python3 -I spikes/s6/owner/session_local.py --fake --cleanup > "$LOG" 2>&1
    rc=$?
    line=$(grep "cleanup:" "$LOG" | tail -1)
    warned=$(grep -qi "revoke" "$LOG" && echo yes || echo no)
    echo "  store stopped, --cleanup exit $rc; shm kept: $([ -d "$SHM" ] && echo yes || echo no); told to revoke: $warned; ${line#*cleanup: }"
    [ "$rc" != 0 ] && [ -d "$SHM" ] && [ "$warned" = yes ] || status=1
    docker start "$MINIO" > /dev/null
    # The store kept its checkpoints in memory, so it comes back empty: still unknown.
    rm -f "$SHM/fail-always-$inject"
    python3 -I spikes/s6/owner/session_local.py --fake --cleanup > "$LOG" 2>&1
    rc=$?
    echo "  store back but empty, --cleanup exit $rc; shm kept: $([ -d "$SHM" ] && echo yes || echo no)"
    [ "$rc" != 0 ] && [ -d "$SHM" ] || status=1
    # The owner revokes the sessions in the account settings, then abandons the material.
    python3 -I spikes/s6/owner/session_local.py --fake --abandon-after-revoking > "$LOG" 2>&1
    rc=$?
    left=$(docker ps -aq --filter "name=^cfo-s6-owner" | grep -c . ; true)
    echo "  after manual revocation, --abandon-after-revoking exit $rc; containers left: $left; shm left: $([ -d "$SHM" ] && echo yes || echo no)"
    [ "$rc" = 0 ] && [ "$left" = 0 ] && [ ! -d "$SHM" ] || status=1
    continue
  fi
  rm -f "$SHM/fail-always-$inject"
  python3 -I spikes/s6/owner/session_local.py --fake --cleanup > "$LOG" 2>&1
  rc=$?
  line=$(grep "cleanup:" "$LOG" | tail -1)
  echo "  after removing the cause, --cleanup exit $rc; ${line#*cleanup: }"
  [ "$rc" = 0 ] || status=1
done
rm -f "$LOG"
exit $status
