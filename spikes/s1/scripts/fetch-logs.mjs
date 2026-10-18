// Reads the S1 Worker's result lines from Workers Logs with the `cf` CLI (read-only) and writes
// them as JSON lines, oldest first. The Worker logs one JSON object per event: {"s1": ...}.
//
//   node spikes/s1/scripts/fetch-logs.mjs <worker-name> <from ISO time> [to ISO time] > out.jsonl
//
// The staging account comes from the staging tool's state directory and is passed to `cf` in
// the environment only; it is never printed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [worker, fromText, toText] = process.argv.slice(2);
if (!worker || !fromText) throw new Error("usage: fetch-logs.mjs <worker> <from> [to]");
const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

const from = Date.parse(fromText);
const to = toText ? Date.parse(toText) : Date.now();
const seen = new Set();
const lines = [];

function query(windowFrom, windowTo, offset) {
  const body = {
    queryId: "s1-fetch",
    timeframe: { from: windowFrom, to: windowTo },
    view: "events",
    limit: 1000,
    ...(offset ? { offset } : {}),
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: worker }],
      needle: { value: '"s1":', isRegex: false, matchCase: true },
    },
  };
  const result = spawnSync("cf", ["o11y", "telemetry", "query", "--body", JSON.stringify(body)], {
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`cf failed: ${result.stderr.split("\n")[0]}`);
  const parsed = JSON.parse(result.stdout);
  return parsed.result ?? parsed;
}

// Query in 30-minute windows, paging within each, so no window exceeds the event limit.
for (let start = from; start < to; start += 30 * 60_000) {
  const end = Math.min(to, start + 30 * 60_000);
  let offset;
  for (let page = 0; page < 50; page++) {
    const result = query(start, end, offset);
    const events = result.events?.events ?? [];
    for (const event of events) {
      const message =
        event.source?.message ?? event.$metadata?.message ?? event.message ?? event.source;
      const text = typeof message === "string" ? message : JSON.stringify(message);
      const id = event.$metadata?.id ?? text;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        const parsed = typeof message === "string" ? JSON.parse(message) : message;
        if (parsed && typeof parsed === "object" && "s1" in parsed) lines.push(parsed);
      } catch {
        // Not one of the spike's JSON lines.
      }
    }
    if (events.length < 1000) break;
    offset = events.at(-1)?.$metadata?.id;
    if (!offset) break;
  }
}
lines.sort((a, b) => (a.wt ?? 0) - (b.wt ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
for (const line of lines) console.log(JSON.stringify(line));
console.error(`${lines.length} lines`);
