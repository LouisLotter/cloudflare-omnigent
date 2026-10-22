#!/usr/bin/env bash
# WP2.4 staging (test tooling, laptop only): the real platform, the web Worker, the platform
# Worker and the server image, installed by the bootstrap script (scripts/bootstrap) through the
# guarded staging tool, as cfo-stg-wp24-platform and cfo-stg-wp24-web.
#
#   run.sh plan        plan the installation (owner "owner", a file replica: staging tests only)
#   run.sh bootstrap   generate the owner's password into $WP24_DIR/owner-secrets.json (mode 600),
#                      then run the bootstrap: deploy, wait for the durable owner, release, check
#   run.sh probe       anonymous requests to both hostnames: each must stop at Access
#   run.sh again       run the bootstrap again (must change nothing) and show the watchdog's lines
#   run.sh teardown    tear both down (web first), list and sweep, remove the state and password
#
# Output goes to $WP24_DIR (default $HOME/.pt/wp24/staging) and is redacted with
# spikes/x1/scripts/redact.py (account, zone, owner address) before it leaves the laptop.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
out="${WP24_DIR:-$HOME/.pt/wp24/staging}"
state_dir="${CFO_STAGING_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/staging}"
redact=(python3 -I "$root/spikes/x1/scripts/redact.py" "$state_dir/config.json" -)
secrets="$out/owner-secrets.json"
bootstrap=(node "$root/scripts/bootstrap/bootstrap.ts")
mkdir -p "$out"
chmod 700 "$out"

zone() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["zone"])' "$state_dir/config.json"; }

logged() { # name, command...: run, redact, keep the log
  local name="$1"; shift
  set +e
  ("$@") 2>&1 | "${redact[@]}" | sed -E \
    -e 's#[a-z0-9-]+\.cloudflareaccess\.com#<team>#g' \
    -e 's#hmac-sha256:[A-Za-z0-9_:-]+#<owner-pin>#g' \
    -e 's#(ACCESS_AUD[^A-Za-z0-9]+)[A-Za-z0-9_-]{16,}#\1<aud>#g' | tee "$out/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  echo "exit $status" >>"$out/$name.log"
  return "$status"
}

case "${1:-}" in
  plan)
    logged plan "${bootstrap[@]}" plan --staging wp24 --staging-owner WP2.4 \
      --owner-username owner --replica-url file:///replica --days 1
    ;;
  bootstrap)
    if [ ! -f "$secrets" ]; then
      umask 077
      python3 -I -c 'import json,secrets; print(json.dumps({"ownerPassword": "cfo-stg-" + secrets.token_urlsafe(18)}))' >"$secrets"
    fi
    logged bootstrap "${bootstrap[@]}" run --staging wp24 --secrets-stdin --wait-minutes 30 <"$secrets"
    ;;
  probe)
    z="$(zone)"
    for host in "cfo-stg-wp24-web.$z" "cfo-stg-wp24-platform.$z"; do
      for path in / /v1/info /health; do
        printf '%s %s ' "${host%%.*}" "$path"
        curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}\n' "https://$host$path" |
          sed -E 's#https://[a-z0-9-]+\.cloudflareaccess\.com/[^ ]*#<access-login>#'
      done
    done | tee "$out/probe.log"
    ;;
  again)
    logged again "${bootstrap[@]}" run --staging wp24 --wait-minutes 0
    logged status "${bootstrap[@]}" status --staging wp24 --logs
    ;;
  teardown)
    logged teardown-web pnpm -s --dir "$root" stg teardown --suffix wp24-web || true
    logged teardown-platform pnpm -s --dir "$root" stg teardown --suffix wp24-platform
    logged teardown-list pnpm -s --dir "$root" stg list
    logged teardown-sweep pnpm -s --dir "$root" stg sweep
    rm -f "$secrets" "${CFO_INSTALL_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/installations}/cfo-stg-wp24-platform.json"
    rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/cloudflare-omnigent/bootstrap-locks/"*.cfo-stg-wp24-*.lock*
    ;;
  *) sed -n '2,17p' "$0"; exit 2 ;;
esac
