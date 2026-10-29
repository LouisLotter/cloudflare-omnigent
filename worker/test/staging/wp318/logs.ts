// WP3.18 staging soak: a deployment's Workers Logs events, read-only, as JSON lines on stdout
// (redact them with spikes/x1/scripts/redact.py before they leave the laptop):
//   node worker/test/staging/wp318/logs.ts <cfo-stg-wp318-…> <from ms> <to ms> [--raw]
// Each line keeps the event's time, version (13 characters), type and logged fields. `--raw`
// (WP3.33, for `run.sh scan`'s token pass only) prints each event whole, so that every field is
// scanned; its output goes only into scan.ts, which prints counts and positions, never a value.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryWorkerLogs } from "../../../../scripts/bootstrap/cloud.ts";
import { spawnRunner } from "../../../../scripts/staging/cloud.ts";
import { shortVersion } from "./plan.ts";

const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8")) as {
  accountId: string;
};
const [name, fromText, toText, mode] = process.argv.slice(2);
const raw = mode === "--raw";
if (mode !== undefined && !raw)
  throw new Error("logs.ts <cfo-stg-wp318-…> <from ms> <to ms> [--raw]");
const from = Number(fromText);
const to = Number(toText);
if (!name?.startsWith("cfo-stg-wp318-") || !Number.isFinite(from) || !Number.isFinite(to)) {
  throw new Error("logs.ts <cfo-stg-wp318-…> <from ms> <to ms>");
}
// Workers Logs answers at most a page per query: read the window in 10-minute slices.
const SLICE = 10 * 60_000;
for (let start = from; start < to; start += SLICE) {
  for (const found of queryWorkerLogs(
    spawnRunner(accountId),
    name,
    start,
    Math.min(to, start + SLICE),
  )) {
    if (raw) {
      console.log(JSON.stringify(found));
      continue;
    }
    const event = found as {
      timestamp?: number;
      $workers?: { scriptVersion?: { id?: unknown }; eventType?: unknown };
      source?: unknown;
    };
    console.log(
      JSON.stringify({
        timestamp: event.timestamp,
        version: shortVersion(event.$workers?.scriptVersion?.id),
        eventType: event.$workers?.eventType,
        source: event.source,
      }),
    );
  }
}
