#!/usr/bin/env bash
# The team-of-one rehearsal (WP8.11): the new server image's migrations and the move's checks on a
# throwaway copy of a database (cfo_drill.team). Nothing reaches the network: the container runs
# with --network none, and the copy is deleted afterwards, whatever the outcome.
#
#   scripts/restore-drill/team-rehearsal.sh DB_FILE OWNER_USERNAME [IMAGE]
#
# DB_FILE: a local SQLite file restored from the replica (the person running this restores it and
# deletes it; this script never reads R2). OWNER_USERNAME: the installation's named owner
# (`SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`). IMAGE: the server image to rehearse with,
# by default `cfo-server:rehearsal`, built from this checkout first:
#
#   docker build --platform linux/amd64 -f images/server/Dockerfile --target server -t cfo-server:rehearsal .
#
# Exit status: the report's, 0 every check passed, 1 one failed, 2 it could not run.
set -euo pipefail

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: $0 DB_FILE OWNER_USERNAME [IMAGE]" >&2
  exit 2
fi
source_db=$1
owner=$2
image=${3:-cfo-server:rehearsal}
here=$(cd "$(dirname "$0")" && pwd)
[[ -f "$source_db" ]] || { echo "no such database file: $source_db" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/cfo-team-rehearsal.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
chmod 0700 "$work"
cp -- "$source_db" "$work/omnigent.db"
for suffix in -wal -shm; do
  [[ -f "$source_db$suffix" ]] && cp -- "$source_db$suffix" "$work/omnigent.db$suffix"
done

status=0
docker run --rm --network none \
  --user "$(id -u):$(id -g)" \
  -v "$work:/rehearsal" \
  -v "$here/cfo_drill:/opt/drill/cfo_drill:ro" \
  -e PYTHONPATH=/opt/cfo:/opt/drill \
  -e HOME=/rehearsal \
  --entrypoint python \
  "$image" -m cfo_drill team-rehearsal /rehearsal/omnigent.db --owner "$owner" || status=$?
exit "$status"
