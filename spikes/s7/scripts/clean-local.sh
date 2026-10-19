#!/usr/bin/env bash
# Removes the local images the spike built (wrangler dev, the staging deploy's build and
# computer-local.sh). The pinned base image is kept. Containers and the volume are removed by
# server.sh purge and workers.sh stop.
set -uo pipefail
mapfile -t images < <(docker images --format '{{.Repository}}:{{.Tag}}' |
  grep -E '(^|/)cfo-stg-s7-managed-|^cloudflare-dev/(omnigentserver|computersim):|^cfo-s7-computer:')
if ((${#images[@]})); then docker image rm "${images[@]}" >/dev/null; fi
echo "removed ${#images[@]} local images"
docker ps -a --filter label=cfo.spike=s7 --format '{{.Names}}'
docker volume ls --filter name=cfo-s7 --format '{{.Name}}'
