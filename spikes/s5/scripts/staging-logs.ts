// Spike S5: reads the deployed Worker's own structured log lines from Workers Logs, read-only,
// so the results of an owner-triggered run reach this laptop without passing Access.
//
//   node spikes/s5/scripts/staging-logs.ts [minutes=60] [out.json]
//
// Only lines the Worker wrote as {"s5": ...} are kept; they hold no token or password.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(STATE, "config.json"), "utf8")) as {
  accountId: string;
};
const staging = JSON.parse(readFileSync(join(SPIKE, "generated", "staging.json"), "utf8")) as {
  hostname: string;
  team: string;
  aud: string;
};

const minutes = Number(process.argv[2] ?? "60");
const outFile = process.argv[3];
const now = Date.now();

function query(offset?: string): { events: unknown[]; last?: string } {
  const body = {
    queryId: "s5-adhoc",
    timeframe: { from: now - minutes * 60_000, to: now },
    view: "events",
    limit: 100,
    ...(offset ? { offset } : {}),
    parameters: {
      filters: [
        { key: "$workers.scriptName", operation: "eq", type: "string", value: "cfo-stg-s5-access" },
      ],
    },
  };
  const args = ["o11y", "telemetry", "query", "--body", JSON.stringify(body)];
  const out = execFileSync("cf", args, {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  // cf 1.0.0-beta.18 prints the query result itself ({ run, events, statistics }); older output
  // wrapped it in `result`. Accept both.
  const parsed = JSON.parse(out) as {
    result?: { events?: { events?: unknown[] } };
    events?: { events?: unknown[] };
  };
  const events = parsed.result?.events?.events ?? parsed.events?.events ?? [];
  const last = (events.at(-1) as { $metadata?: { id?: string } } | undefined)?.$metadata?.id;
  return { events, ...(last ? { last } : {}) };
}

const lines: { at: number; data: unknown }[] = [];
let offset: string | undefined;
for (let page = 0; page < 20; page++) {
  const { events, last } = query(offset);
  for (const e of events) {
    const event = e as {
      timestamp?: number;
      $workers?: { scriptName?: string };
      source?: unknown;
    };
    if (event.$workers?.scriptName !== "cfo-stg-s5-access") continue;
    // Workers Logs parses a JSON log line into `source`; it may also arrive as { level, message }
    // with the line as the message string.
    const raw = event.source as { message?: unknown } | string | undefined;
    const source =
      raw && typeof raw === "object" && typeof raw.message === "string" ? raw.message : raw;
    const data =
      typeof source === "string"
        ? (() => {
            try {
              return JSON.parse(source) as unknown;
            } catch {
              return source;
            }
          })()
        : source;
    if (data && typeof data === "object" && "s5" in data)
      lines.push({ at: event.timestamp ?? 0, data });
  }
  if (events.length < 100 || !last) break;
  offset = last;
}
lines.sort((a, b) => a.at - b.at);
const text = JSON.stringify(lines, null, 2)
  .replaceAll(staging.hostname, "<host>")
  .replaceAll(staging.team, "<team>")
  .replaceAll(staging.aud, "<aud>");
if (outFile) writeFileSync(outFile, `${text}\n`);
console.log(text);
