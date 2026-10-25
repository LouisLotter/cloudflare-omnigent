// WP2.6 staging: the run's Workers Logs events, read-only, as JSON lines on stdout (redact them
// with spikes/x1/scripts/redact.py before they leave the laptop):
//   node worker/test/staging/wp26/collect.ts <from ms> <to ms>
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryWorkerLogs } from "../../../../scripts/bootstrap/cloud.ts";
import { spawnRunner } from "../../../../scripts/staging/cloud.ts";

const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as {
  accountId: string;
};
const [from, to] = process.argv.slice(2).map(Number);
if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
  throw new Error("collect.ts <from ms> <to ms>");
}
const events = queryWorkerLogs(spawnRunner(accountId), "cfo-stg-wp26-restore", from, to);
// Only what the run needs: time, the invocation's kind and the structured line.
for (const raw of events) {
  const event = raw as { timestamp?: number; $workers?: Record<string, unknown>; source?: unknown };
  console.log(
    JSON.stringify({
      timestamp: event.timestamp,
      eventType: event.$workers?.eventType,
      entrypoint: event.$workers?.entrypoint,
      source: event.source,
    }),
  );
}
