#!/usr/bin/env bash
# Connects this machine to a cloudflare-omnigent installation as an Omnigent host (WP3.43, owner
# decisions D47 and D48): the machine reaches https://<host> through the Cloudflare One Client
# (formerly WARP), signed in to the installation's Zero Trust team as the owner, and runs
# Omnigent's own host there, so agents run on it and the owner manages them from the web UI.
# Nothing here opens a port, a tunnel or a public route; no Omnigent server runs on this machine.
#
#   scripts/host/omnigent-host.sh setup --server https://<host> [--team <team name>]
#   scripts/host/omnigent-host.sh status
#   scripts/host/omnigent-host.sh remove [--yes]
#
# `setup`, idempotent, run again at any time (also after an update of this checkout):
#   1. checks the Cloudflare One Client: installed, its service running, registered with the
#      installation's team (it runs `warp-cli registration new <team>`, and the person signs in
#      in the browser that opens; it waits for that) and connected. It accepts the client's terms
#      of service for the person who installed it (`warp-cli --accept-tos`), which the client
#      otherwise asks for in a terminal and refuses everything until then; then that Access lets this machine through to
#      Omnigent (the installation's `bootstrap.ts devices` step must have run);
#   2. installs the Omnigent build the installation's images pin (images/computer/Dockerfile:
#      the fork's commit; its uv.lock exported with hashes, installed from wheels only with
#      --require-hashes; Omnigent's own three packages built without build isolation, with the
#      hash-pinned backends in build-requirements.txt and without the server's web UI; and the
#      images' certifi pin), side by side with any other Omnigent: its own virtual environment,
#      data and configuration, under the command `omnigent-cfo`. Each build is a directory named
#      for everything that went into it, never changed once complete. It never touches another
#      `omnigent` command, ~/.omnigent or an `omnigent-host.service`;
#   3. signs that command line in to the installation, unless the installation accepts the one it
#      has: Omnigent asks for the owner's Omnigent username and password, in this terminal or, when
#      standard input is not a terminal, as its first two lines (so a password can be piped in
#      from a file, never put on a command line), and keeps its session in its own store. Nothing
#      here reads, prints or keeps a password or a token;
#   4. installs `omnigent-cfo-host.service`, a systemd user service that runs Omnigent's host for
#      https://<host>, with Omnigent's product analytics off in it, its runners and the
#      `omnigent-cfo` command (D49), and restarts it whenever it stops (a reboot, a dropped connection, a lapsed
#      client session), checks that the process it runs is the build installed in step 2, and
#      waits until the installation lists this machine's host as online.
# Exit status: 0 ready; 3 the service runs but the host is not online yet (run `status` again);
# 1 something to fix, named on the last line.
#
# `status` shows each of those checks without changing anything. `remove` stops and removes the
# service, the `omnigent-cfo` command, its build, its sign-in and its configuration; it leaves
# the Cloudflare One Client and its registration alone (`warp-cli registration delete`).

set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DOCKERFILE="$ROOT/images/computer/Dockerfile"
BUILD_PINS="$ROOT/scripts/host/build-requirements.txt"
# The way a build is made: a change here makes a new build directory.
RECIPE=2
NAME=omnigent-cfo
UNIT=omnigent-cfo-host.service
MARKER="# omnigent-cfo, written by cloudflare-omnigent's scripts/host/omnigent-host.sh"
DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
CFO_HOME="$DATA_HOME/$NAME"
CFO_CONFIG="$CONFIG_HOME/$NAME"
CFO_DATA="$CFO_HOME/data"
BIN_DIR=${XDG_BIN_HOME:-$HOME/.local/bin}
WRAPPER="$BIN_DIR/$NAME"
UNIT_DIR="$CONFIG_HOME/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT"
SERVER_FILE="$CFO_CONFIG/server"
# Where the running service's command line is read (a test points it elsewhere).
PROC=${CFO_HOST_PROC:-/proc}
# How long `setup` waits, in seconds, for the client to connect, the service to start and the
# host to come online (a test shortens them).
CONNECT_WAIT=${CFO_HOST_CONNECT_WAIT:-20}
# How long `setup` waits for the browser sign-in that registers the client (a test shortens it).
REGISTER_WAIT=${CFO_HOST_REGISTER_WAIT:-600}
SERVICE_WAIT=${CFO_HOST_SERVICE_WAIT:-10}
ONLINE_WAIT=${CFO_HOST_ONLINE_WAIT:-90}

say() { printf 'omnigent-host: %s\n' "$*"; }
fail() {
  printf 'omnigent-host: %s\n' "$*" >&2
  exit 1
}

usage() {
  grep '^#   scripts/host/omnigent-host.sh' "${BASH_SOURCE[0]}" | sed 's/^# *//' >&2
  exit 1
}

need() {
  local missing=()
  for cmd in "$@"; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
  if ((${#missing[@]} > 0)); then
    fail "this machine lacks ${missing[*]}: install them with its package manager (on Arch: sudo pacman -S ${missing[*]}; uv also from https://docs.astral.sh/uv/), then run this again"
  fi
}

# A path written into the service and the wrapper: plain characters only.
plain_path() {
  case "$1" in
  *[\"\'\\%\$\`]* | *$'\n'*) fail "the path $1 holds a character this setup does not write into a service file; use a plainer HOME or XDG directory" ;;
  esac
}

# --- The pinned build, from the images' Dockerfile ---------------------------------------------

read_pins() {
  [[ -f $DOCKERFILE ]] || fail "run this from a checkout of cloudflare-omnigent: $DOCKERFILE is missing"
  REPO=$(sed -n 's/^ARG OMNIGENT_REPO=\(.*\)$/\1/p' "$DOCKERFILE" | head -n1)
  COMMIT=$(sed -n 's/^ARG OMNIGENT_COMMIT=\([0-9a-f]\{40\}\)$/\1/p' "$DOCKERFILE" | head -n1)
  CERTIFI_PIN=$(sed -n 's/^ARG CERTIFI_PIN="\(certifi==[^"]*--hash=sha256:[0-9a-f]\{64\}[^"]*\)"$/\1/p' "$DOCKERFILE" | head -n1)
  [[ $REPO =~ ^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\.git$ ]] || fail "could not read the Omnigent repository from $DOCKERFILE"
  [[ -n $COMMIT ]] || fail "could not read the pinned Omnigent commit from $DOCKERFILE"
  [[ -n $CERTIFI_PIN ]] || fail "could not read the certifi pin from $DOCKERFILE"
  [[ -f $BUILD_PINS ]] || fail "run this from a checkout of cloudflare-omnigent: $BUILD_PINS is missing"
  # Everything that goes into a build names it: the commit, the trust pin, the build backends
  # and this recipe. A build directory is complete once and never changed afterwards.
  BUILD_ID="$COMMIT-$({ printf '%s\n%s\n' "$RECIPE" "$CERTIFI_PIN"; cat "$BUILD_PINS"; } | sha256sum | cut -c1-12)"
  BUILD="$CFO_HOME/venvs/$BUILD_ID"
}

# --- The installation ---------------------------------------------------------------------------

parse_server() {
  [[ $1 =~ ^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}/?$ ]] || fail "--server takes the installation's address, https://<host>, without a path"
  SERVER=${1%/}
  HOST=${SERVER#https://}
}

load_server() {
  [[ -f $SERVER_FILE ]] || fail "this machine is not set up yet: run setup --server https://<host>"
  parse_server "$(head -n1 "$SERVER_FILE")"
}

# --- The Cloudflare One Client ------------------------------------------------------------------

# The client's command line. A fresh install refuses every command until its terms of service
# are accepted, which it asks for only in a terminal.
warp() { warp-cli --accept-tos "$@"; }

client_state() {
  CLIENT_STATUS=$(warp status 2>&1) || return 1
  return 0
}

client_registered() {
  local shown
  CONSUMER=0
  shown=$(warp registration show 2>&1) || return 1
  grep -qi 'missing' <<<"$shown" && return 1
  # A Zero Trust registration, not the consumer WARP app's.
  if grep -qi 'account type' <<<"$shown" && ! grep -qi 'account type: *team' <<<"$shown"; then
    CONSUMER=1
    return 1
  fi
  return 0
}

client_connected() {
  client_state || return 1
  grep -qi 'status update: *connected' <<<"$CLIENT_STATUS"
}

# The team the installation's Access sends a sign-in to, read from Access's redirect for a
# machine it does not know yet.
discover_team() {
  local location
  location=$(curl -sS -o /dev/null --max-time 20 -H 'Accept: text/html' -w '%{redirect_url}' "$SERVER/" 2>/dev/null || true)
  sed -n 's#^https://\([a-z0-9][a-z0-9-]*\)\.cloudflareaccess\.com/.*#\1#p' <<<"$location"
}

ensure_client() {
  if ! command -v warp-cli >/dev/null 2>&1; then
    fail "install the Cloudflare One Client first: on Arch, the AUR package cloudflare-warp-bin (for example yay -S cloudflare-warp-bin); elsewhere https://pkg.cloudflareclient.com/. Then start its service (sudo systemctl enable --now warp-svc) and run this again"
  fi
  client_state || fail "the Cloudflare One Client's service is not running: sudo systemctl enable --now warp-svc, then run this again"
  say "Cloudflare One Client: $(warp-cli --version 2>/dev/null | head -n1)$(package_version)"
  if ! client_registered; then
    ((CONSUMER == 0)) || fail "the Cloudflare One Client is registered for the consumer WARP service, not a Zero Trust team: warp-cli registration delete, then run this again"
    local team=${TEAM:-}
    [[ -n $team ]] || team=$(discover_team)
    [[ $team =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "could not tell the installation's Zero Trust team from $SERVER: run setup again with --team <team name> (the first part of <team>.cloudflareaccess.com)"
    say "registering the Cloudflare One Client with the team $team: sign in with your email in the browser that opens"
    warp registration new "$team" || fail "warp-cli registration new $team failed (above); run this again"
    if ! client_registered; then
      say "waiting for the sign-in in the browser (choose Open Link at the end)"
      local waited
      for ((waited = 0; waited < REGISTER_WAIT; waited += 2)); do
        client_registered && break
        sleep 2
      done
      client_registered || fail "the Cloudflare One Client is not registered with $team yet: finish the sign-in in the browser (choose Open Link at the end), then run this again"
    fi
    say "the Cloudflare One Client is registered with $team"
  fi
  if ! client_connected; then
    say "connecting the Cloudflare One Client"
    warp connect >/dev/null || fail "warp-cli connect failed (above)"
    local i
    for ((i = 0; i < CONNECT_WAIT; i++)); do
      client_connected && break
      sleep 1
    done
    client_connected || fail "the Cloudflare One Client does not connect: $(head -n1 <<<"$CLIENT_STATUS"); see warp-cli status"
  fi
  say "the Cloudflare One Client is connected"
}

package_version() {
  if command -v pacman >/dev/null 2>&1; then
    local v
    v=$(pacman -Q cloudflare-warp-bin 2>/dev/null || true)
    [[ -n $v ]] && printf ' (package %s)' "$v"
  fi
  return 0
}

# Whether Access lets this machine through to Omnigent: Omnigent's own answer to an unsigned
# request is a 401 with its login address. Sets ACCESS to ok, login, lapsed, refused or other.
probe_access() {
  local body code location
  body=$(mktemp)
  code=$(curl -sS -o "$body" --max-time 20 -H 'Accept: application/json' -w '%{http_code} %{redirect_url}' "$SERVER/v1/me" 2>/dev/null) || code="000 "
  location=${code#* }
  code=${code%% *}
  case $code in
  200) ACCESS=ok ;;
  401) if grep -q '"login_url"' "$body"; then ACCESS=ok; else ACCESS=lapsed; fi ;;
  301 | 302 | 303 | 307 | 308)
    if [[ $location == https://*.cloudflareaccess.com/* ]]; then ACCESS=login; else ACCESS="other $code"; fi
    ;;
  403) ACCESS=refused ;;
  *) ACCESS="other $code" ;;
  esac
  rm -f "$body"
}

ensure_access() {
  probe_access
  case $ACCESS in
  ok) say "Access lets this machine through to Omnigent at $SERVER" ;;
  login) fail "Access asks this machine to sign in instead of using the Cloudflare One Client: run bootstrap.ts devices for the installation (it routes $HOST through the client and lets the client's session in), then on this machine warp-cli disconnect && warp-cli connect, and run this again" ;;
  lapsed) fail "Access refused the Cloudflare One Client's session (401): it has lapsed or was revoked; sign in again (warp-cli registration new <team>, or the client's re-authenticate prompt), then run this again" ;;
  refused) fail "the installation refused this machine (403): the Cloudflare One Client is signed in as someone other than the installation's owner; register it with the owner's email (warp-cli registration delete, then run this again)" ;;
  *) fail "could not reach Omnigent at $SERVER through Access ($ACCESS); check warp-cli status and the address" ;;
  esac
}

# --- The pinned Omnigent, side by side ----------------------------------------------------------

# The build the `venv` link names, as its record says: its ID, or nothing.
venv_build() { [[ -f $CFO_HOME/venv/cfo-build ]] && sed -n 's/^build=//p' "$CFO_HOME/venv/cfo-build"; }

ensure_build() {
  local src="$CFO_HOME/src/$COMMIT" stage
  BUILT=0
  if [[ ! -f $BUILD/cfo-build ]] || ! "$BUILD/bin/python" -I -c 'import omnigent.host.service_entry' >/dev/null 2>&1; then
    say "installing Omnigent ${COMMIT:0:12} from its lock file (a few minutes the first time)"
    if [[ ! -f $src/.cfo-fetched ]]; then
      rm -rf "$src"
      mkdir -p "$src"
      git init -q "$src"
      git -C "$src" fetch -q --depth 1 "$REPO" "$COMMIT" || fail "could not fetch Omnigent $COMMIT from $REPO"
      git -C "$src" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
      [[ $(git -C "$src" rev-parse HEAD) == "$COMMIT" ]] || fail "the fetched Omnigent is not commit $COMMIT"
      : >"$src/.cfo-fetched"
    fi
    rm -rf "$BUILD"
    stage=$(mktemp -d)
    # The lock's dependencies, without Omnigent's own packages (built below), with their hashes.
    (cd "$src" && uv export --frozen --no-dev --no-emit-project --no-emit-workspace --no-emit-local --no-editable -o "$stage/requirements.txt" >/dev/null) ||
      fail "uv could not export Omnigent's locked dependencies"
    printf '%s\n' "$CERTIFI_PIN" >"$stage/trust-pins.txt"
    uv venv -q --python 3.12 "$BUILD" || fail "uv could not make a Python 3.12 environment"
    uv pip install -q --python "$BUILD/bin/python" --require-hashes --only-binary :all: -r "$stage/requirements.txt" ||
      fail "installing Omnigent's locked dependencies failed (above)"
    uv pip install -q --python "$BUILD/bin/python" --require-hashes --only-binary :all: -r "$BUILD_PINS" ||
      fail "installing the pinned build backends failed (above)"
    # Omnigent's own packages, from the fetched commit, with those backends and no other download;
    # a host has no use for the server's web UI, whose build needs Node.
    OMNIGENT_SKIP_WEB_UI=true uv pip install -q --python "$BUILD/bin/python" --no-deps --no-build-isolation \
      "$src" "$src/sdks/python-client" "$src/sdks/ui" || fail "installing Omnigent failed (above)"
    uv pip install -q --python "$BUILD/bin/python" --no-deps --require-hashes --only-binary :all: -r "$stage/trust-pins.txt" ||
      fail "installing the certifi pin failed (above)"
    "$BUILD/bin/python" -I -c 'import omnigent.host.connect, omnigent.host.service_entry' ||
      fail "the installed Omnigent does not load (above)"
    # What was installed: the lock's export (with its hashes) and what the environment holds.
    cp "$stage/requirements.txt" "$BUILD/cfo-requirements.txt"
    uv pip freeze -q --python "$BUILD/bin/python" >"$BUILD/cfo-freeze.txt"
    "$BUILD/bin/python" -I -c 'import platform; print(platform.python_version())' >"$BUILD/cfo-python"
    rm -rf "$stage"
    # Written last: the build is complete.
    printf 'build=%s\ncommit=%s\nrepository=%s\ncertifi=%s\n' "$BUILD_ID" "$COMMIT" "$REPO" "${CERTIFI_PIN%% *}" >"$BUILD/cfo-build"
    BUILT=1
  fi
  ln -sfn "venvs/$BUILD_ID" "$CFO_HOME/venv"
  say "Omnigent $COMMIT is installed: $BUILD"
}

# Removes builds other than the current one, once the service runs on it.
prune_builds() {
  local dir
  for dir in "$CFO_HOME"/venvs/* "$CFO_HOME"/src/*; do
    [[ -e $dir ]] || continue
    case $(basename "$dir") in "$BUILD_ID" | "$COMMIT") continue ;; esac
    rm -rf "$dir"
  done
}

ensure_wrapper() {
  plain_path "$CFO_HOME"
  plain_path "$CFO_CONFIG"
  if [[ -e $WRAPPER ]] && ! grep -qF "$MARKER" "$WRAPPER"; then
    fail "$WRAPPER exists and was not written by this setup; move it away, then run this again"
  fi
  mkdir -p "$BIN_DIR" "$CFO_DATA" "$CFO_CONFIG"
  local tmp="$WRAPPER.tmp.$$"
  cat >"$tmp" <<EOF
#!/bin/sh
$MARKER
# The Omnigent build of $SERVER, side by side with any other Omnigent on this machine.
export OMNIGENT_DATA_DIR='$CFO_DATA'
export OMNIGENT_CONFIG_HOME='$CFO_CONFIG'
export OMNIGENT_WRAPPER_COMMAND=$NAME
# Omnigent's product analytics off (D49).
export OMNIGENT_ANALYTICS=0
exec '$BUILD/bin/omnigent' "\$@"
EOF
  chmod 0755 "$tmp"
  mv -f "$tmp" "$WRAPPER"
  printf '%s\n' "$SERVER" >"$SERVER_FILE"
  case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on your PATH; run $WRAPPER, or add $BIN_DIR to PATH" ;;
  esac
}

# The command line's sign-in, as the installation judges it (signin-check.py): ok; absent,
# expired or rejected (sign in again); or unknown (it did not answer). The token stays in Python.
signin_state() {
  OMNIGENT_DATA_DIR=$CFO_DATA OMNIGENT_CONFIG_HOME=$CFO_CONFIG \
    "$BUILD/bin/python" -I "$ROOT/scripts/host/signin-check.py" "$SERVER" 2>/dev/null || echo unknown
}

ensure_signin() {
  local state
  state=$(signin_state)
  [[ $state != unknown* ]] || fail "could not ask $SERVER whether this machine's sign-in is good ($state); run this again"
  if [[ $state != ok ]]; then
    say "signing Omnigent's command line in to $SERVER: Omnigent asks for your Omnigent username and password (the ones for the web page, not your email's)"
    "$WRAPPER" login "$SERVER" || fail "the sign-in did not finish (above); run this again"
    state=$(signin_state)
    [[ $state == ok ]] || fail "the command line is still not signed in ($state); run this again"
  fi
  say "Omnigent's command line is signed in to $SERVER"
}

# The service's PATH: the setup's own, without entries a service file cannot hold.
service_path() {
  local out="" entry
  local IFS=:
  for entry in $PATH; do
    [[ $entry == /* ]] || continue
    case "$entry" in *[\"\'\\%\$\`]*) continue ;; esac
    out=${out:+$out:}$entry
  done
  printf '%s' "$out"
}

unit_text() {
  cat <<EOF
# Written by cloudflare-omnigent's scripts/host/omnigent-host.sh: Omnigent's host for $SERVER.
[Unit]
Description=Omnigent host for $SERVER (cloudflare-omnigent)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
Environment="OMNIGENT_DATA_DIR=$CFO_DATA"
Environment="OMNIGENT_CONFIG_HOME=$CFO_CONFIG"
Environment="OMNIGENT_WRAPPER_COMMAND=$NAME"
# Omnigent's product analytics off (D49), in the host and, through Omnigent's own passthrough
# (its runners get only an allowlist of the host's environment), in every runner it starts.
Environment="OMNIGENT_ANALYTICS=0"
Environment="OMNIGENT_RUNNER_ENV_PASSTHROUGH=OMNIGENT_ANALYTICS"
Environment="PATH=$(service_path)"
ExecStart="$BUILD/bin/python" -P -m omnigent.host.service_entry --server "$SERVER"
# Omnigent's host stops for good (exit 0) on a refusal it cannot fix itself, such as a lapsed
# client session at start; it is started again until the person fixes it.
Restart=always
RestartSec=30s

[Install]
WantedBy=default.target
EOF
}

ensure_service() {
  local text changed=0
  text=$(unit_text)
  mkdir -p "$UNIT_DIR"
  if [[ ! -f $UNIT_FILE ]] || [[ $(cat "$UNIT_FILE") != "$text" ]]; then
    printf '%s\n' "$text" >"$UNIT_FILE.tmp.$$"
    mv -f "$UNIT_FILE.tmp.$$" "$UNIT_FILE"
    changed=1
  fi
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || fail "systemctl --user enable --now $UNIT failed: see systemctl --user status $UNIT"
  # A changed unit or build, or a process from before them (an earlier run stopped in between).
  if ((changed || BUILT)) || ! running_build; then
    systemctl --user restart "$UNIT"
  fi
  say "the service $UNIT runs, and starts with your session"
}

# Whether the service runs the build installed here: its command line is exactly the unit's,
# with this build's own interpreter (a directory never changed once complete).
running_build() {
  local pid argv
  pid=$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)
  [[ $pid =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r $PROC/$pid/cmdline ]] || return 1
  argv=$(tr '\0' '\n' <"$PROC/$pid/cmdline")
  [[ $argv == "$(printf '%s\n' "$BUILD/bin/python" -P -m omnigent.host.service_entry --server "$SERVER")" ]] || return 1
  [[ -f $BUILD/cfo-build ]]
}

host_online() {
  "$WRAPPER" host status --server "$SERVER" --json 2>/dev/null | grep -Eq '"host_status": *"online"'
}

wait_online() {
  local i
  for ((i = 0; i < ONLINE_WAIT; i += 3)); do
    host_online && return 0
    sleep 3
  done
  host_online
}

setup() {
  local team=""
  while (($# > 0)); do
    case $1 in
    --server) parse_server "${2:-}"; shift 2 ;;
    --team) team=${2:-}; shift 2 ;;
    *) usage ;;
    esac
  done
  [[ -n ${SERVER:-} ]] || usage
  TEAM=$team
  [[ $(uname -s) == Linux ]] || fail "this setup is for Linux with systemd; on a Mac, Omnigent's own omnigent host enable does the service part"
  [[ $EUID -ne 0 ]] || fail "run this as yourself, not as root: the host runs your agents as you"
  need git uv curl systemctl
  read_pins
  plain_path "$HOME"
  ensure_client
  ensure_access
  ensure_build
  ensure_wrapper
  ensure_signin
  ensure_service
  local i
  for ((i = 0; i < SERVICE_WAIT; i++)); do
    running_build && break
    sleep 1
  done
  running_build || fail "the service does not run the Omnigent build installed here ($BUILD): see systemctl --user status $UNIT"
  say "the service runs Omnigent $COMMIT from $BUILD"
  prune_builds
  if wait_online; then
    say "ready: this machine is an Omnigent host of $SERVER. Open $SERVER to start agents on it."
    return 0
  fi
  say "the service runs, but $SERVER does not list this machine's host as online yet: check again with status, and see journalctl --user -u $UNIT"
  return 3
}

status() {
  load_server
  read_pins
  local line
  if command -v warp-cli >/dev/null 2>&1; then
    line="installed: $(warp-cli --version 2>/dev/null | head -n1)$(package_version)"
    if client_registered; then line="$line; registered"; else line="$line; not registered"; fi
    if client_connected; then line="$line; connected"; else line="$line; not connected"; fi
  else
    line="not installed"
  fi
  say "Cloudflare One Client: $line"
  probe_access
  say "Access to $SERVER: $ACCESS"
  local installed
  installed=$(venv_build || true)
  if [[ -z $installed ]]; then
    say "Omnigent build: not installed"
  elif [[ $installed == "$BUILD_ID" ]]; then
    say "Omnigent build: $installed, as pinned ($BUILD; its locked dependencies in cfo-requirements.txt)"
  else
    say "Omnigent build: $installed; this checkout makes $BUILD_ID (run setup to update)"
  fi
  [[ -x $BUILD/bin/python ]] && say "command line sign-in: $(signin_state)"
  say "service: $(systemctl --user is-active "$UNIT" 2>/dev/null || true)$(running_build && printf ', running the installed build')"
  if [[ -x $WRAPPER ]] && host_online; then say "host: online"; else say "host: not online"; fi
}

remove() {
  local yes=0
  while (($# > 0)); do
    case $1 in
    --yes) yes=1; shift ;;
    *) usage ;;
    esac
  done
  if ((yes == 0)); then
    [[ -t 0 ]] || fail "remove deletes this machine's Omnigent host, its build and its sign-in: run it with --yes"
    local answer
    read -r -p "omnigent-host: remove this machine's Omnigent host, its build and its sign-in? [y/N] " answer
    [[ $answer == y || $answer == Y ]] || fail "nothing removed"
  fi
  if [[ -f $UNIT_FILE ]]; then
    systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload || true
  fi
  if [[ -e $WRAPPER ]] && grep -qF "$MARKER" "$WRAPPER"; then rm -f "$WRAPPER"; fi
  rm -rf "$CFO_HOME" "$CFO_CONFIG"
  say "removed. The Cloudflare One Client stays registered; warp-cli registration delete removes this machine from the team. In Omnigent, the host stays listed as offline until you remove it there."
}

main() {
  local command=${1:-}
  [[ $# -gt 0 ]] && shift
  case $command in
  setup) setup "$@" ;;
  status) status "$@" ;;
  remove) remove "$@" ;;
  *) usage ;;
  esac
}

# Run, unless sourced (a manual check of one step).
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
