// Reads the S3 staging Worker's result lines from Workers Logs with the `cf` CLI (read-only)
// and writes them as JSON lines, oldest first. The Worker logs one JSON object per event:
// {"s3": "<event>", "wt": <ms>, ...}. Adapted from spikes/s1/scripts/fetch-logs.mjs.
//
//   node spikes/s3/staging/fetch-logs.mjs <from ISO time> [to ISO time] > spikes/s3/results/staging-log.jsonl
//
// The staging account comes from the staging tool's state directory and is passed to `cf` in
// the environment only; it is never printed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKER = "cfo-stg-s3-capture";
const [fromText, toText] = process.argv.slice(2);
if (!fromText) throw new Error("usage: fetch-logs.mjs <from> [to]");
const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };

const from = Date.parse(fromText);
const to = toText ? Date.parse(toText) : Date.now();
const seen = new Set();
const lines = [];
const errors = [];

function query(windowFrom, windowTo, offset) {
  const body = {
    queryId: "s3-fetch",
    timeframe: { from: windowFrom, to: windowTo },
    view: "events",
    limit: 1000,
    ...(offset ? { offset } : {}),
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: WORKER }],
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

// 30-minute windows, paged, so no window exceeds the event limit.
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
        if (parsed && typeof parsed === "object" && "s3" in parsed) lines.push(parsed);
        else if (event.$metadata?.error || event.$workers?.outcome === "exception")
          errors.push(event);
      } catch {
        // Not one of the spike's JSON lines: keep runtime errors (DC-46: collect every event).
        if (/error|exception/i.test(text)) errors.push({ text: text.slice(0, 2000) });
      }
    }
    if (events.length < 1000) break;
    offset = events.at(-1)?.$metadata?.id;
    if (!offset) break;
  }
}
lines.sort((a, b) => (a.wt ?? 0) - (b.wt ?? 0));
for (const line of lines) console.log(JSON.stringify(line));
for (const error of errors) console.log(JSON.stringify({ s3: "runtime_error", event: error }));
console.error(`${lines.length} lines, ${errors.length} runtime errors`);
