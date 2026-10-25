// WP3.3 staging: a deployment's Workers Logs events, read-only, as JSON lines on stdout (redact
// them with spikes/x1/scripts/redact.py before they leave the laptop):
//   node worker/test/staging/wp33/logs.ts <worker name> <from ms> <to ms>
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
const [name, fromText, toText] = process.argv.slice(2);
const from = Number(fromText);
const to = Number(toText);
if (!name?.startsWith("cfo-stg-wp33-") || !Number.isFinite(from) || !Number.isFinite(to)) {
  throw new Error("logs.ts <cfo-stg-wp33-…> <from ms> <to ms>");
}
for (const raw of queryWorkerLogs(spawnRunner(accountId), name, from, to)) {
  const event = raw as { timestamp?: number; $workers?: Record<string, unknown>; source?: unknown };
  console.log(
    JSON.stringify({
      timestamp: event.timestamp,
      eventType: event.$workers?.eventType,
      entrypoint: event.$workers?.entrypoint,
      outcome: event.$workers?.outcome,
      source: event.source,
    }),
  );
}
