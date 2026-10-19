// Reads one S1 container application's stdout and stderr from Workers Logs (the "containers"
// dataset), read-only, oldest first: the Omnigent server's access log and tunnel lines, or the
// computer's entrypoint output. The account comes from the staging tool's state directory and is
// passed to `cf` in the environment only; it is redacted from the output.
//
//   node spikes/s1/scripts/container-logs.mjs <application name> <from ISO> <to ISO> [regex]
//   e.g. node spikes/s1/scripts/container-logs.mjs cfo-stg-s1-life-server \
//          2026-10-19T10:00:00Z 2026-10-19T10:10:00Z 'tunnel|WebSocket|disconnected'

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [name, fromText, toText, pattern] = process.argv.slice(2);
if (!name?.startsWith("cfo-stg-s1-") || !fromText || !toText) {
  throw new Error("usage: container-logs.mjs <cfo-stg-s1-… application> <from> <to> [regex]");
}
const state =
  process.env.CFO_STAGING_DIR ??
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "cloudflare-omnigent", "staging");
const { accountId } = JSON.parse(readFileSync(join(state, "config.json"), "utf8"));
const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
const redact = (text) => String(text).replaceAll(accountId, "<account>");

function cf(args) {
  const result = spawnSync("cf", args, { encoding: "utf8", env, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`cf failed: ${redact(result.stderr.split("\n")[0])}`);
  const parsed = JSON.parse(result.stdout);
  return parsed.result ?? parsed;
}

const app = cf(["containers", "applications", "list"]).find((a) => a.name === name);
if (!app) throw new Error(`no container application named ${name}`);
// Logs name the application by its ID in the dashed UUID form.
const hex = app.id.replaceAll("-", "");
const service = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

const re = pattern ? new RegExp(pattern, "i") : null;
const out = [];
const seen = new Set();
for (let start = Date.parse(fromText); start < Date.parse(toText); start += 10 * 60_000) {
  const end = Math.min(Date.parse(toText), start + 10 * 60_000);
  let offset;
  for (let page = 0; page < 20; page++) {
    const body = {
      queryId: "s1-container-logs",
      timeframe: { from: start, to: end },
      view: "events",
      limit: 1000,
      ...(offset ? { offset } : {}),
      parameters: {
        datasets: ["containers"],
        filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: service }],
      },
    };
    const events =
      cf(["o11y", "telemetry", "query", "--body", JSON.stringify(body)]).events?.events ?? [];
    for (const event of events) {
      const id = event.$metadata?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      const message = event.$metadata?.message ?? event.source?.message ?? event.source;
      const text = typeof message === "string" ? message : JSON.stringify(message);
      if (!re || re.test(text)) out.push([event.timestamp ?? 0, text]);
    }
    if (events.length < 1000) break;
    offset = events.at(-1)?.$metadata?.id;
    if (!offset) break;
  }
}
out.sort((a, b) => a[0] - b[0]);
for (const [t, text] of out) console.log(new Date(t).toISOString(), redact(text).slice(0, 500));
console.error(`${out.length} lines`);
