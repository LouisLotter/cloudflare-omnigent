#!/bin/bash
# Spike S6, review s6-r3 findings 2 and 3, end to end with Docker, MinIO and the fake CLIs.
#
#   3. An earlier session's leftover (a store configuration in /dev/shm, which no marker of this
#      mode accounts for) makes startup refuse without writing a marker, and --cleanup keeps it
#      as unknown and says to revoke.
#   2. A session stops signed in (a logout that always fails), and its computer is then stopped
#      with `docker stop`. With the cause removed, --cleanup starts that computer again, signs out
#      in it, checkpoints the sign-out, verifies in a fresh computer and removes everything.
#
#   bash spikes/s6/owner/r3-local-check.sh
#
# It writes into spikes/s6/results/owner-session-fake-dryrun/ like any dry run; restore that
# folder from git afterwards if its committed run should stay.
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2
SHM=/dev/shm/cfo-s6-owner
OUTDIR=spikes/s6/results/owner-session-fake-dryrun
MARKER=$OUTDIR/session-state.json
S=spikes/s6/owner/session_local.py
LOG=$(mktemp)
status=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; status=1; fi; }
if docker ps -aq --filter "name=^cfo-s6-owner" | grep -q . || [ -e "$SHM" ]; then
  echo "something of an earlier local session is left; not running"
  exit 2
fi

# ------------------------------------------------------------------ finding 3
mkdir -m 700 "$SHM"
printf '{"user": "earlier", "password": "earlier-session"}' > "$SHM/s3.json"
before_marker=$(cat "$MARKER" 2> /dev/null || echo none)
python3 -I "$S" --fake > "$LOG" 2>&1
rc=$?
check "startup with an earlier session's store configuration refuses" '[ "$rc" != 0 ] && grep -q "not closed" "$LOG"'
check "and writes no marker" '[ "$(cat "$MARKER" 2> /dev/null || echo none)" = "$before_marker" ]'
check "and leaves that configuration as it was" 'grep -q earlier-session "$SHM/s3.json"'
python3 -I "$S" --fake --cleanup > "$LOG" 2>&1
rc=$?
check "--cleanup keeps it as unknown and says to revoke" '[ "$rc" != 0 ] && grep -q earlier-session "$SHM/s3.json" && grep -qi revoke "$LOG"'
rm -rf "$SHM" # this check's own synthetic leftover

# ------------------------------------------------------------------ finding 2
python3 -I "$S" --fake --inject-failure codex-logout > "$LOG" 2>&1
rc=$?
pc=$(docker ps --filter "name=^cfo-s6-owner-pc" --format '{{.Names}}' | head -1)
check "a session that cannot sign out stops and keeps its computer ($pc)" '[ "$rc" != 0 ] && [ -n "$pc" ]'
docker stop -t 1 "$pc" > /dev/null
check "that computer is now stopped, not removed" '[ "$(docker inspect -f "{{.State.Running}}" "$pc")" = false ]'
rm -f "$SHM/fail-always-codex-logout"
n0=$(wc -l < "$OUTDIR/session-log.jsonl") # the log is appended across runs: judge only this cleanup
python3 -I "$S" --fake --cleanup > "$LOG" 2>&1
rc=$?
NEW=$(mktemp)
tail -n +"$((n0 + 1))" "$OUTDIR/session-log.jsonl" > "$NEW"
line=$(grep "cleanup:" "$LOG" | tail -1)
echo "  cleanup: ${line#*cleanup: }"
check "--cleanup started the stopped computer again" "grep -q '\"step\": \"computer-restarted\", \"computer\": \"$pc\", \"exit\": 0' $NEW"
check "and signed out in it" "grep -q '\"computer\": \"$pc\", \"action\": \"codex-logout\", \"exit\": 0' $NEW"
rm -f "$NEW"
check "then verified the sign-out in a fresh computer and removed everything" '[ "$rc" = 0 ] && echo "$line" | grep -q "verified in a fresh computer" && ! docker ps -aq --filter "name=^cfo-s6-owner" | grep -q . && [ ! -e "$SHM" ]'
rm -f "$LOG"
echo "status: $status"
exit $status
