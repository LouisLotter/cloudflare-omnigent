#!/usr/bin/env bash
# Local Omnigent server for spike S7, from the published image pinned by digest.
#
#   bash spikes/s7/scripts/server.sh start [standard|authoritative] [base-path]
#   bash spikes/s7/scripts/server.sh stop      # remove the container; the database volume stays
#   bash spikes/s7/scripts/server.sh replace [standard|authoritative]
#   bash spikes/s7/scripts/server.sh purge     # remove the container and the database volume
#   bash spikes/s7/scripts/server.sh logs
#
# Server replacement is emulated the way the design describes it: a new container with an empty
# disk, so the data directory (where Omnigent keeps its sharing override files) is gone, while the
# database survives on a volume, as a Litestream restore would give it.
#
# "standard" starts the image's own entrypoint: the settings come from environment variables and
# Omnigent reports them as editable. "authoritative" runs server/managed_entrypoint.py, which passes
# the same values to create_app as static resolvers, so Omnigent itself reports them as managed and
# refuses writes. That is the defense-in-depth layer the evidence recommends.
#
# Passwords and the cookie secret are generated on first use into spikes/s7/.run/ (gitignored).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HERE/.run"
IMAGE="ghcr.io/omnigent-ai/omnigent-server@sha256:dba491573ba16b42da7447a7ab6e978bfeb6f49876093cc925f8340abd010df6"
NAME="cfo-s7-omnigent"
VOLUME="cfo-s7-db"
PORT="${S7_SERVER_PORT:-18700}"
PUBLIC_ORIGIN="${S7_PUBLIC_ORIGIN:-http://localhost:8787}"

mkdir -p "$RUN"
chmod 700 "$RUN"
if [[ ! -f "$RUN/secrets.env" ]]; then
  umask 077
  {
    echo "S7_ADMIN_USERNAME=owner"
    echo "S7_ADMIN_PASSWORD=$(openssl rand -hex 16)"
    echo "S7_COOKIE_SECRET=$(openssl rand -hex 32)"
  } >"$RUN/secrets.env"
fi
# shellcheck disable=SC1091
source "$RUN/secrets.env"

wait_ready() {
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/health" 2>/dev/null ||
      curl -fsS -o /dev/null "http://127.0.0.1:$PORT/v1/info" 2>/dev/null; then
      echo "server ready on 127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  echo "server did not become ready" >&2
  docker logs --tail 50 "$NAME" >&2 || true
  return 1
}

start() {
  local mode="${1:-standard}"
  local base_path="${2:-}"
  docker volume create "$VOLUME" >/dev/null
  local args=(
    --detach --name "$NAME"
    --publish "127.0.0.1:$PORT:8000"
    --volume "$VOLUME:/data/db"
    --label "cfo.spike=s7"
    --env "DATABASE_URL=sqlite:////data/db/omnigent.db"
    --env "ARTIFACT_DIR=/data/artifacts"
    # Anchors Omnigent's data directory (sharing override files, admin list) at /data/state,
    # which lives on the container's own disk and is lost on replacement.
    --env "OMNIGENT_ADMIN_CREDENTIALS_PATH=/data/state/admin-credentials"
    --env "OMNIGENT_AUTH_PROVIDER=accounts"
    --env "OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME=$S7_ADMIN_USERNAME"
    --env "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD=$S7_ADMIN_PASSWORD"
    --env "OMNIGENT_ACCOUNTS_COOKIE_SECRET=$S7_COOKIE_SECRET"
    --env "OMNIGENT_ACCOUNTS_BASE_URL=$PUBLIC_ORIGIN"
    --env "OMNIGENT_WS_ALLOWED_ORIGINS=$PUBLIC_ORIGIN"
    # The deployment-managed values: restrictive, as the design asks.
    --env "OMNIGENT_SHARING_MODE=read_only"
    --env "OMNIGENT_PUBLIC_SHARING=off"
    --env "OMNIGENT_PUBLIC_SHARING_MAX_LEVEL=read"
    --env "OMNIGENT_DEFAULT_PUBLIC_SESSIONS=off"
  )
  if [[ -n "$base_path" ]]; then
    args+=(--env "OMNIGENT_WEB_BASE_PATH=$base_path")
  fi
  if [[ "$mode" == "authoritative" ]]; then
    args+=(--volume "$HERE/server/managed_entrypoint.py:/app/s7_managed_entrypoint.py:ro")
    docker run "${args[@]}" "$IMAGE" python /app/s7_managed_entrypoint.py >/dev/null
  else
    docker run "${args[@]}" "$IMAGE" >/dev/null
  fi
  echo "started $NAME ($mode${base_path:+, base path $base_path})"
  wait_ready
}

stop() {
  docker rm --force "$NAME" >/dev/null 2>&1 || true
  echo "removed $NAME"
}

case "${1:-}" in
start) start "${2:-standard}" "${3:-}" ;;
stop) stop ;;
replace)
  stop
  start "${2:-standard}" "${3:-}"
  ;;
purge)
  stop
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  echo "removed volume $VOLUME"
  ;;
logs) docker logs "$NAME" ;;
*)
  echo "usage: server.sh start|stop|replace|purge|logs" >&2
  exit 2
  ;;
esac
