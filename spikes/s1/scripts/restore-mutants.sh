#!/usr/bin/env bash
# Applies one hand-made mutant at a time to the restore path in spikes/s1/src/index.js, runs the
# S1 tests, and restores the file. Prints whether each mutant was killed (some test failed).
#   spikes/s1/scripts/restore-mutants.sh
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
run "host not held" '...(restore || probe ? { S1_HOLD_HOST: "1" } : {}),' '...(probe ? { S1_HOLD_HOST: "1" } : {}),'
run "no restore" 'await this.makeBackups().restore(stored.record);' ''
run "release before restore" '      await this.execText(["true"]);
      execReadyMs = Date.now() - t0;
      await this.makeBackups().restore(stored.record);' '      await this.execText(["true"]);
      execReadyMs = Date.now() - t0;
      await this.execText(["touch", "/tmp/s1-host-release"]);
      await this.makeBackups().restore(stored.record);'
run "no release after a failed restore" '    } catch (error) {
      restoreError = errorText(error);
    }' '    } catch (error) {
      restoreError = errorText(error);
      return { execReadyMs, restoreMs: null, restoredMs, releasedMs, restoreError };
    }'
run "restore without waiting for exec" '      await this.execText(["true"]);
      execReadyMs = Date.now() - t0;
      await this.makeBackups().restore(stored.record);' '      execReadyMs = Date.now() - t0;
      await this.makeBackups().restore(stored.record);'
run "verification always matches" 'restoredMatches: bytes === stored.bytes && files === stored.files,' 'restoredMatches: true,'
run "rwake without a backup starts anyway" '    if (!stored) {' '    if (false) {'
run "failed restore counted ok" 'ok: status === "online" && (restored === null || restored.restoreError === null),' 'ok: status === "online",'
cp "$BACKUP" "$SRC"
cmp -s "$BACKUP" "$SRC" && echo "source restored"
