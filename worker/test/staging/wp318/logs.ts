// WP3.18 staging soak: a deployment's Workers Logs events, read-only, as JSON lines on stdout
// (redact them with spikes/x1/scripts/redact.py before they leave the laptop):
//   node worker/test/staging/wp318/logs.ts <cfo-stg-wp318-…> <from ms> <to ms>
import { fileURLToPath } from "node:url";
import { queryWorkerLogs } from "../../../../scripts/bootstrap/cloud.ts";
import { spawnRunner } from "../../../../scripts/staging/cloud.ts";
import { shortVersion } from "./plan.ts";
import { soakInstallation } from "./soak-config.ts";

export function logQuery(args: readonly string[], allowedWorkers: readonly string[]) {
  const [name, fromText, toText] = args;
  const from = Number(fromText);
  const to = Number(toText);
  if (
    !name ||
    !allowedWorkers.includes(name) ||
    !fromText ||
    !toText ||
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from > to
  ) {
    throw new Error("logs.ts <selected platform or web Worker> <from ms> <to ms>");
  }
  return { name, from, to };
}

function main(): void {
  const { installation } = soakInstallation();
  const { name, from, to } = logQuery(process.argv.slice(2), [
    installation.platformWorker,
    installation.webWorker,
  ]);
  const { accountId } = installation;
  // Workers Logs answers at most a page per query: read the window in 10-minute slices.
  const SLICE = 10 * 60_000;
  for (let start = from; start < to; start += SLICE) {
    for (const raw of queryWorkerLogs(
      spawnRunner(accountId),
      name,
      start,
      Math.min(to, start + SLICE),
    )) {
      const event = raw as {
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
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
