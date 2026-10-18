#!/usr/bin/env bash
# Applies one hand-made mutant at a time to spikes/s1/src/index.js, runs the IR-017 tests, and
# restores the file. Prints whether each mutant was killed (some test failed). Run from anywhere:
#   spikes/s1/scripts/ir017-mutants.sh
cd "$(dirname "$0")/../../.." || exit 1
SRC=spikes/s1/src/index.js
BACKUP=$(mktemp)
cp "$SRC" "$BACKUP"
run() {
  local name=$1 from=$2 to=$3
  cp "$BACKUP" "$SRC"
  python3 -I - "$SRC" "$from" "$to" <<'EOF'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
assert old in text, f"mutant anchor not found: {old!r}"
open(path, "w").write(text.replace(old, new, 1))
EOF
  if pnpm exec vitest run --config spikes/s1/vitest.config.js >/dev/null 2>&1; then
    echo "SURVIVED: $name"
  else
    echo "killed:   $name"
  fi
}
run "no origin check" 'const refused = originRefusal(request, url);' 'const refused = null;'
run "null origin accepted" 'origin === null || origin === "null" || origin !== url.origin' 'origin === null || origin !== url.origin && origin !== "null"'
run "missing origin accepted" 'origin === null || origin === "null" || origin !== url.origin' '(origin !== null && origin !== url.origin) || origin === "null"'
run "Sec-Fetch-Site ignored" 'site !== null && site !== "same-origin"' 'false'
run "token not checked" 'intent === null || !(await controls.consume(control.purpose, intent))' 'false'
run "token not single-use" 'await this.ctx.storage.delete(key);
    return true;' 'return true;'
run "token purpose ignored" 'const key = `intent:${purpose}`;
    const current = await this.ctx.storage.get(key);
    if (!current || current.expiresAt <= Date.now()) return false;' 'const key = "intent:start";
    const current = await this.ctx.storage.get(key);
    if (!current || current.expiresAt <= Date.now()) return false;'
run "token never expires" 'if (!current || current.expiresAt <= Date.now()) return false;' 'if (!current) return false;'
run "alarm ignores arming" 'if (!(await this.armed())) {' 'if (false) {'
run "no stop on disarm" 'if (running) await this.ctx.container.destroy();' ''
run "arming not capped" 'Math.min(armedUntil, Date.now() + MAX_ARM_HOURS * 3_600_000)' 'armedUntil'
run "GET starts campaign" 'const token = await controls.issue(control.purpose);' 'const token = await controls.issue(control.purpose); await env.COMPUTER.get(env.COMPUTER.idFromName(COMPUTER_NAME)).kickoff({ armedUntil: Date.now() + 1 });'
cp "$BACKUP" "$SRC"
cmp -s "$BACKUP" "$SRC" && echo "source restored"
