// WP3.18 staging soak: the RC-26 reconnect table from a collected run (laptop only):
//   node worker/test/staging/wp318/analyze.ts <run directory>
// The directory holds what run.sh collect wrote: events.json (the soak run's own events, from
// the results bucket), deploys.jsonl (the laptop's deploys), logs.jsonl (the platform Worker's
// Workers Logs) and, from WP3.27, presence.jsonl (the host-tunnel opens before that window, so
// a host connected earlier is judged at the first disruption). Prints the table and writes
// verdict.json next to them. A controlled
// restart (`config_changed`, G2-SEC-001) during the soak fails it: no soak deploy changes the
// server's configuration or its image (WP3.19), so one would be a restart nobody planned.
// It also lists the Durable Object instance starts that no deploy or planned reset explains
// (instances.ts, WP3.33), with the lead's one-shot commands (commands.json, from `run.sh
// collect`) among the planned resets. They are measurements: they never fail the verdict.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandResult } from "./commands.ts";
import { instanceCounts, instanceStarts, type Planned } from "./instances.ts";
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
const jsonLines = (name: string): LogLine[] =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LogLine)
    : [];
// The window's logs are required (Codex WP3.27 r1-4): without them nothing is checked. Only
// presence.jsonl, which older collections lack, may be missing.
if (!existsSync(join(dir, "logs.jsonl"))) {
  throw new Error(`no logs.jsonl in ${dir}: run \`run.sh collect\` first`);
}
const lines = jsonLines("logs.jsonl");
const presence = jsonLines("presence.jsonl");
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
const results = reconnects(disruptions, lines, presence);
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
// The instance starts, against everything planned: the soak's resets, the deploys, and the lead's
// commands that ran (the soak refuses them while it runs, but the window opens before T0).
const commandsRead: unknown = (() => {
  try {
    return JSON.parse(readFileSync(join(dir, "commands.json"), "utf8")) as unknown;
  } catch {
    return []; // none collected (an older run), or not an outcome list
  }
})();
const commands = (Array.isArray(commandsRead) ? commandsRead : []) as CommandResult[];
const planned: Planned[] = [
  ...run.events.flatMap((e): Planned[] =>
    e.kind === "server_reset" || e.kind === "workspace_reset" ? [{ kind: e.kind, at: e.at }] : [],
  ),
  ...deploys.flatMap((d): Planned[] =>
    d.status === 0 && (d.kind === "platform_deploy" || d.kind === "web_deploy")
      ? [{ kind: d.kind, at: d.start, ...(d.version ? { version: d.version } : {}) }]
      : [],
  ),
  ...commands.flatMap((c): Planned[] =>
    c.outcome !== "ok"
      ? []
      : c.command === "server-reset"
        ? [{ kind: "server_reset", at: c.startedAt }]
        : c.command === "workspace-reset" && c.computerId !== null
          ? [{ kind: "workspace_reset", at: c.startedAt, computerId: c.computerId }]
          : [],
  ),
];
const starts = instanceStarts(lines, planned);
const unexplained = starts.filter((i) => i.cause === "unexplained");
for (const i of unexplained) {
  const when = `T0+${((i.at - run.t0) / 60_000).toFixed(1)}m`;
  console.log(
    `note instance_started   ${when.padEnd(10)} ${i.class} ${i.computerId ?? ""} ${i.instanceId} unexplained: ${i.note}`,
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
  instanceStarts: { counts: instanceCounts(starts), unexplained },
  results,
};
writeFileSync(join(dir, "verdict.json"), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(
  JSON.stringify({
    ...verdict,
    instanceStarts: { counts: verdict.instanceStarts.counts, unexplained: unexplained.length },
    results: undefined,
  }),
);
