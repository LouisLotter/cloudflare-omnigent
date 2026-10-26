// WP3.18 staging soak: the RC-26 reconnect table from a collected run (laptop only):
//   node worker/test/staging/wp318/analyze.ts <run directory>
// The directory holds what run.sh collect wrote: events.json (the soak run's own events, from
// the results bucket), deploys.jsonl (the laptop's deploys) and logs.jsonl (the platform
// Worker's Workers Logs). Prints the table and writes verdict.json next to them. A controlled
// restart (`config_changed`, G2-SEC-001) during the soak fails it: no soak deploy changes the
// server's configuration, so one would be a restart nobody planned.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  configRestarts,
  type Disruption,
  type LogLine,
  reconnects,
  SOAK_MS,
  type SoakEventKind,
} from "./plan.ts";

const dir = process.argv[2];
if (dir === undefined) throw new Error("analyze.ts <run directory>");
const run = JSON.parse(readFileSync(join(dir, "events.json"), "utf8")) as {
  runId: string;
  t0: number;
  events: { kind: SoakEventKind; at: number }[];
};
const deploys = readFileSync(join(dir, "deploys.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map(
    (line) =>
      JSON.parse(line) as {
        kind: SoakEventKind;
        start: number;
        end: number;
        status: number;
        version: string;
      },
  );
const lines = readFileSync(join(dir, "logs.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LogLine);
const disruptions: Disruption[] = [
  ...run.events.filter((e) => e.kind !== "end").map((e) => ({ kind: e.kind, at: e.at })),
  ...deploys
    .filter((d) => d.status === 0)
    .map((d) => ({
      kind: d.kind,
      at: d.start,
      deployEndedAt: d.end,
      ...(d.version ? { version: d.version } : {}),
    })),
].sort((a, b) => a.at - b.at);
const results = reconnects(disruptions, lines);
for (const r of results) {
  const at = r.at === null ? "?" : `T0+${((r.at - run.t0) / 60_000).toFixed(1)}m`;
  const gap =
    r.gapMs === null
      ? "-"
      : r.lowerMs === undefined
        ? `${(r.gapMs / 1000).toFixed(1)} s`
        : `${(r.lowerMs / 1000).toFixed(1)}–${(r.gapMs / 1000).toFixed(1)} s`;
  console.log(
    `${r.ok ? "ok  " : "FAIL"} ${r.kind.padEnd(16)} ${at.padEnd(10)} ${r.computerId} ${gap} ${r.note ?? ""}`,
  );
}
const restarts = configRestarts(lines, run.t0, run.t0 + SOAK_MS);
for (const r of restarts) {
  const at = r.startedAt ?? r.endedAt;
  const when = at === null ? "?" : `T0+${((at - run.t0) / 60_000).toFixed(1)}m`;
  const length = r.durationMs === null ? "still open" : `${(r.durationMs / 1000).toFixed(1)} s`;
  console.log(
    `FAIL config_changed     ${when.padEnd(10)} a controlled restart during the soak, ${length}`,
  );
}
const verdict = {
  runId: run.runId,
  disruptions: disruptions.length,
  checks: results.length,
  failed: results.filter((r) => !r.ok).length + restarts.length,
  configRestarts: restarts,
  inconclusive: results.filter((r) => r.note?.startsWith("inconclusive")).length,
  failedDeploys: deploys.filter((d) => d.status !== 0).length,
  results,
};
writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify({ ...verdict, results: undefined }));
