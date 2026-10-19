#!/usr/bin/env bash
# Applies one hand-made mutant at a time to the host tunnel code in spikes/s1/src/index.js (the
# 101 headers, the mode plumbing and the tunnel-check phase), runs the S1 tests, and restores
# the file. Prints whether each mutant was killed (some test failed).
#   spikes/s1/scripts/tunnel-mutants.sh
cd "$(dirname "$0")/../../.." || exit 1
SRC=spikes/s1/src/index.js
BACKUP=$(mktemp)
cp "$SRC" "$BACKUP"
run() {
  local name=$1 from=$2 to=$3
  cp "$BACKUP" "$SRC"
  if ! python3 -I - "$SRC" "$from" "$to" <<'EOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
assert old in text, f"mutant anchor not found: {old!r}"
open(path, "w").write(text.replace(old, new, 1))
EOF
  then
    echo "ANCHOR MISSING: $name"
    return
  fi
  if pnpm exec vitest run --config spikes/s1/vitest.config.js >/dev/null 2>&1; then
    echo "SURVIVED: $name"
  else
    echo "killed:   $name"
  fi
}
run "Accept copied from the server's 101" \
  'await websocketAccept(requestHeaders.get("Sec-WebSocket-Key")),' \
  'upstreamHeaders?.get("Sec-WebSocket-Accept"),'
run "server's extension kept" \
  'if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);' \
  'if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  for (const [name, value] of upstreamHeaders ?? []) if (!headers.has(name)) headers.set(name, value);'
run "fixed answers with the server's headers" 'mode === "bridge"' 'mode !== "never"'
run "mode header passed on to the server" 'headers.delete(WS_MODE_HEADER);' ''
run "deployment mode ignored" '?? props?.wsMode ??' '??'
run "route-fixed not bridged again" 'if (mode !== "route-fixed") return response;' 'return response;'
run "probe without waiting for exec" '      await this.execText(["true"]);
      execReadyMs = Date.now() - t0;
      // A host ID' '      execReadyMs = Date.now() - t0;
      // A host ID'
run "host not held for the probe" '...(restore || probe ? { S1_HOLD_HOST: "1" } : {}),' '...(restore ? { S1_HOLD_HOST: "1" } : {}),'
run "chosen mode not registered before release" '      await this.ctx.storage.put("wsMode", chosen);
      await this.intercept(run, gen);' '      await this.ctx.storage.put("wsMode", chosen);'
run "last working mode chosen" 'results.find((probe) => probe.ok)' 'results.findLast((probe) => probe.ok)'
run "probe uses the real host ID" '/v1/hosts/${randomHex(16)}/tunnel' '/v1/hosts/${await this.ctx.storage.get("hostId")}/tunnel'
run "failed check keeps the queue" '    await this.ctx.storage.put("queue", []);
    await this.stopComputer();
    await this.record("tunnel-check-failed"' '    await this.stopComputer();
    await this.record("tunnel-check-failed"'
run "failed check leaves the computer running" '    await this.ctx.storage.put("queue", []);
    await this.stopComputer();' '    await this.ctx.storage.put("queue", []);'
run "check passes without the host online" 'if (result.ok) return { done: true, delayMs: 2000 };' 'return { done: true, delayMs: 2000 };'
run "host not released when no probe passes" '    let releasedMs = null;
    try {
      await this.execText(["touch", "/tmp/s1-host-release"]);' '    let releasedMs = null;
    if (!chosen) return { execReadyMs, probeError, probesOk: [], chosenMode: null, releasedMs };
    try {
      await this.execText(["touch", "/tmp/s1-host-release"]);'
# bare (added after the staging probe of 2026-10-19 showed the egress duplicating Upgrade).
run "bare sends Upgrade and Connection" \
  'if (mode === "bare") headers = bareHeaders(upstream.headers);' \
  'if (mode === "bare") headers = await upgradeHeaders(request.headers, upstream.headers);'
run "bare copies the server's headers" \
  'const headers = new Headers();
  const protocol' \
  'const headers = new Headers(upstreamHeaders);
  const protocol'
run "bare drops the server's subprotocol" \
  'if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  return headers;
}

/** The mode for one upgrade' \
  'return headers;
}

/** The mode for one upgrade'
run "fixed is the default again" 'const DEFAULT_WS_MODE = "bare";' 'const DEFAULT_WS_MODE = "fixed";'
run "bare not probed" 'const WS_MODES = ["bare", "fixed",' 'const WS_MODES = ["fixed",'
cp "$BACKUP" "$SRC"
cmp -s "$BACKUP" "$SRC" && echo "source restored"
