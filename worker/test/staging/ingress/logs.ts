// WP2.1 staging: reads the harness's own structured log lines from Workers Logs, read-only, so
// the owner's self-test result reaches this laptop without passing Access.
//
//   node worker/test/staging/ingress/logs.ts [minutes=60] [out.json]
//
// Keeps only the lines the harness and ingress wrote (`ingress_selftest`, `ingress_echo`,
// `ingress_refused`); none holds an assertion, an email or a cookie value. The hostname, team
// domain and AUD tag are redacted.

import { writeFileSync } from "node:fs";
import { cf, generated, NAME, redact, run, stagingConfig } from "./config.ts";

const EVENTS = new Set(["ingress_selftest", "ingress_echo", "ingress_refused"]);

function parse(source: unknown): unknown {
  // Workers Logs parses a JSON line into `source`, or delivers it as { level, message }.
  const raw =
    source &&
    typeof source === "object" &&
    typeof (source as { message?: unknown }).message === "string"
      ? (source as { message: string }).message
      : source;
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function main(): void {
  const minutes = Number(process.argv[2] ?? "60");
  const out = process.argv[3];
  const { accountId } = stagingConfig();
  const g = generated();
  const now = Date.now();
  const lines: { at: number; data: unknown }[] = [];
  let offset: string | undefined;
  for (let page = 0; page < 20; page++) {
    const body = {
      queryId: "wp21-ingress-adhoc",
      timeframe: { from: now - minutes * 60_000, to: now },
      view: "events",
      limit: 100,
      ...(offset ? { offset } : {}),
      parameters: {
        filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: NAME }],
      },
    };
    const answer = cf(
      ["o11y", "telemetry", "query", "--body", JSON.stringify(body)],
      accountId,
    ) as {
      events?: { events?: unknown[] };
    };
    const events = answer.events?.events ?? [];
    for (const e of events) {
      const event = e as {
        timestamp?: number;
        $workers?: { scriptName?: string };
        source?: unknown;
      };
      if (event.$workers?.scriptName !== NAME) continue;
      const data = parse(event.source);
      if (
        data &&
        typeof data === "object" &&
        EVENTS.has(String((data as { event?: unknown }).event))
      ) {
        lines.push({ at: event.timestamp ?? 0, data });
      }
    }
    const last = (events.at(-1) as { $metadata?: { id?: string } } | undefined)?.$metadata?.id;
    if (events.length < 100 || !last) break;
    offset = last;
  }
  lines.sort((a, b) => a.at - b.at);
  const text = redact(JSON.stringify(lines, null, 2), g);
  if (out) writeFileSync(out, `${text}\n`);
  console.log(text);
}

await run(main);
