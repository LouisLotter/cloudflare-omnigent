// G2 sitting (test tooling, read-only): a Worker's Workers Logs events between two times, as
// JSON lines on stdout. Redact them with spikes/x1/scripts/redact.py before they leave the
// laptop (run.sh does).
//
//   node worker/test/staging/g2/logs.ts <worker> <from ms> <to ms>

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
const [worker, from, to] = process.argv.slice(2);
const fromMs = Number(from);
const toMs = Number(to);
if (
  !worker?.startsWith("cfo-stg-g2-sitting-") ||
  !Number.isFinite(fromMs) ||
  !Number.isFinite(toMs)
) {
  throw new Error("logs.ts <cfo-stg-g2-sitting-… worker> <from ms> <to ms>");
}
const events = queryWorkerLogs(spawnRunner(accountId), worker, fromMs, toMs);
// Oldest first; only the time, the invocation's kind and the structured line.
const lines = events.map((raw) => {
  const event = raw as { timestamp?: number; $workers?: Record<string, unknown>; source?: unknown };
  return {
    timestamp: event.timestamp,
    eventType: event.$workers?.eventType,
    entrypoint: event.$workers?.entrypoint,
    source: event.source,
  };
});
lines.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
for (const line of lines) console.log(JSON.stringify(line));
