// The G3 sitting's wake-time table (WP3.33, VD-16), from the platform Worker's Workers Logs lines
// (logs.ts's JSON lines, raw or as `run.sh collect` redacted them). Laptop only, test tooling.
//
//   node worker/test/staging/wp318/logs.ts cfo-stg-wp318-platform <from> <to> |
//     node worker/test/staging/wp318/wakes.ts
//
// One row per wake: a computer's generation that was granted a slot or started a container. Each
// row has, where the logs hold them:
//   - Omnigent's `resume` (the launcher call that began the wake, `launcher_api` `call`; computer
//     IDs on those lines since WP3.33),
//   - ControlDO's grant (`reserve_granted`),
//   - the container's `start()` (`container_start`, WP3.33) and the starts Cloudflare refused
//     and WorkspaceDO retried (`start_retry`, DC-37),
//   - the restore (`restore_confirmed`) and the host's start handed over (`start_delivered`),
//   - the host connected (its first tunnel open, 101, in this generation),
//   - the first turn dispatched (the first runner tunnel open after it, in this generation),
//   - the stop before it (`stop_confirmed`, `unexpected_stop`, or ControlDO's `released`), so the
//     start-after-stop gap, and a staging kill before that stop (`staging_kill`, step K).
// Logs from before WP3.33 lack the container start: such a row is timed from the grant, and says
// so. The host ID shows as its first 8 characters only (unredacted logs only).
//
// Prints a table, then one JSON line: {"wakes": [...], "refused": [...]}. `refused` lists every
// wake refused at the limit (a `resume` answered with an error, ControlDO's `reserve_refused`),
// for RC-18's step B6.

import { createInterface } from "node:readline";
import { type LogLine, sourceOf } from "./plan.ts";

type Fields = Readonly<Record<string, unknown>>;

const HOST_TUNNEL = /^\/v1\/hosts\/([0-9a-f]{32}|<hex32>)\/tunnel$/;
const RUNNER_TUNNEL = /^\/v1\/runners\/[^/]+\/tunnel$/;
/** How long before a wake its `resume` may be, to count as the call that began it. */
export const LAUNCHER_LOOKBACK_MS = 10 * 60_000;

export interface Wake {
  readonly computerId: string;
  readonly generation: number;
  /** The earliest line of this wake (the grant, the start or the restore). */
  readonly at: number;
  readonly resumeAt: number | null;
  readonly grantedAt: number | null;
  /** The first `start()`; null in logs from before WP3.33. */
  readonly startAt: number | null;
  /** The `start()` that ran (after DC-37's retries). */
  readonly lastStartAt: number | null;
  readonly retries: number;
  readonly restoredAt: number | null;
  readonly layers: number | null;
  readonly deliveredAt: number | null;
  readonly hostAt: number | null;
  /** The host ID's first 8 characters, when the logs are not redacted. */
  readonly host: string | null;
  readonly runnerAt: number | null;
  readonly stopBefore: {
    readonly at: number;
    readonly kind: "stop_confirmed" | "unexpected_stop" | "released";
    readonly reason: string | null;
  } | null;
  /** A staging kill (step K) before the stop before this wake. */
  readonly killAt: number | null;
  /** Durations (ms), null where an end is missing. */
  readonly ms: {
    /** From the container's start() (or the grant, see `timedFrom`) to the host connected. */
    readonly startToHost: number | null;
    readonly hostToRunner: number | null;
    /** As Omnigent sees it: from its `resume` to the first turn dispatched. */
    readonly resumeToRunner: number | null;
    readonly startToRestored: number | null;
    /** The start-after-stop gap: from the stop before to this wake's first start(). */
    readonly stopToStart: number | null;
    /** DC-37's retries: from the first start() to the one that ran. */
    readonly retrying: number | null;
    readonly killToStop: number | null;
    readonly killToHost: number | null;
  };
  readonly timedFrom: "start" | "grant" | "first line";
}

export interface RefusedWake {
  readonly at: number;
  readonly computerId: string | null;
  readonly kind: "resume_refused" | "reserve_refused";
  readonly detail: string;
}

interface Event {
  readonly at: number;
  readonly s: Fields;
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const diff = (from: number | null, to: number | null): number | null =>
  from === null || to === null ? null : to - from;

/** The wakes and the refused wakes in the lines, in time order. */
export function wakeTable(lines: readonly LogLine[]): {
  readonly wakes: Wake[];
  readonly refused: RefusedWake[];
} {
  const events: Event[] = [];
  for (const line of lines) {
    const s = sourceOf(line);
    if (s !== null && typeof line.timestamp === "number") events.push({ at: line.timestamp, s });
  }
  events.sort((a, b) => a.at - b.at);
  const of = (cfo: string, event: string) =>
    events.filter((e) => e.s.cfo === cfo && e.s.event === event);

  // Each wake's lines, by computer and generation.
  const keyed = new Map<string, { computerId: string; generation: number; lines: Event[] }>();
  const add = (e: Event, kind: string) => {
    const computerId = str(e.s.computerId);
    const generation = num(e.s.generation);
    if (computerId === null || generation === null) return;
    const key = `${computerId}/${generation}`;
    const entry = keyed.get(key) ?? { computerId, generation, lines: [] };
    entry.lines.push({ at: e.at, s: { ...e.s, kind } });
    keyed.set(key, entry);
  };
  for (const e of of("control", "reserve_granted")) add(e, "granted");
  for (const e of of("workspace", "container_start")) add(e, "start");
  for (const e of of("workspace", "start_retry")) add(e, "retry");
  for (const e of of("workspace", "restore_confirmed")) add(e, "restored");
  for (const e of of("workspace", "start_delivered")) add(e, "delivered");
  for (const e of of("computer_route", "request")) {
    if (e.s.status !== 101 || typeof e.s.path !== "string") continue;
    if (HOST_TUNNEL.test(e.s.path)) add(e, "host");
    else if (RUNNER_TUNNEL.test(e.s.path)) add(e, "runner");
  }

  const stops = [
    ...of("workspace", "stop_confirmed").map((e) => ({ e, kind: "stop_confirmed" as const })),
    ...of("workspace", "unexpected_stop").map((e) => ({ e, kind: "unexpected_stop" as const })),
    ...of("control", "released").map((e) => ({ e, kind: "released" as const })),
  ];
  const kills = of("workspace", "staging_kill");
  // A launcher call is logged when it ends, with its length (`ms`, since WP3.33): the call began
  // `ms` earlier (Codex WP3.33 r1-6). Older lines have no length.
  const resumes = of("launcher_api", "call")
    .filter((e) => e.s.operation === "resume")
    .map((e) => ({ at: e.at - (num(e.s.ms) ?? 0), s: e.s }))
    .sort((a, b) => a.at - b.at);
  // A `start_delivered` from before WP3.33 has no generation: it belongs to the computer's wake
  // that precedes it.
  const unnumbered = of("workspace", "start_delivered").filter((e) => num(e.s.generation) === null);

  const starts = [...keyed.values()].filter((w) =>
    w.lines.some((l) => ["granted", "start", "restored"].includes(String(l.s.kind))),
  );
  const wakes: Wake[] = [];
  for (const w of starts) {
    const first = (kind: string, after = Number.NEGATIVE_INFINITY) =>
      w.lines.find((l) => l.s.kind === kind && l.at >= after) ?? null;
    const anchor = Math.min(
      ...w.lines
        .filter((l) => ["granted", "start", "restored"].includes(String(l.s.kind)))
        .map((l) => l.at),
    );
    const startLines = w.lines.filter((l) => l.s.kind === "start");
    const startAt = startLines[0]?.at ?? null;
    const lastStartAt = startLines.at(-1)?.at ?? null;
    const grantedAt = first("granted")?.at ?? null;
    const restored = first("restored");
    const nextWake = starts
      .filter((o) => o.computerId === w.computerId && o.generation > w.generation)
      .flatMap((o) => o.lines.map((l) => l.at))
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
    const delivered =
      first("delivered") ??
      unnumbered.find(
        (e) => e.s.computerId === w.computerId && e.at >= anchor && e.at < nextWake,
      ) ??
      null;
    const host = first("host", anchor);
    const runner = host === null ? null : first("runner", host.at);
    const from = startAt ?? grantedAt ?? anchor;
    // The stop of the latest earlier generation: WorkspaceDO's own record of it, or ControlDO's
    // release of its slot (which follows the stop) when the logs predate `stop_confirmed`.
    const before = stops
      .filter(
        ({ e }) =>
          e.s.computerId === w.computerId &&
          (num(e.s.generation) ?? Number.POSITIVE_INFINITY) < w.generation &&
          e.at <= from,
      )
      .map(({ e, kind }) => ({
        at: e.at,
        kind,
        generation: num(e.s.generation) as number,
        reason: str(e.s.reason) ?? (kind === "unexpected_stop" ? "unexpected" : null),
      }));
    // The latest earlier generation's stop (Codex WP3.33 r1-4), by generation, not by kind;
    // within it, WorkspaceDO's own record before ControlDO's release.
    const latest = Math.max(Number.NEGATIVE_INFINITY, ...before.map((b) => b.generation));
    const ofLatest = before.filter((b) => b.generation === latest);
    const stopped = ofLatest.filter((b) => b.kind !== "released").at(-1) ?? ofLatest.at(-1) ?? null;
    const stopBefore =
      stopped === null ? null : { at: stopped.at, kind: stopped.kind, reason: stopped.reason };
    const kill =
      stopped === null
        ? null
        : (kills
            .filter(
              (e) =>
                e.s.computerId === w.computerId &&
                e.at <= stopped.at &&
                num(e.s.generation) === stopped.generation,
            )
            .at(-1) ?? null);
    const resume =
      resumes
        .filter(
          (e) =>
            e.s.computerId === w.computerId &&
            e.at <= from &&
            from - e.at <= LAUNCHER_LOOKBACK_MS &&
            (stopBefore === null || e.at >= stopBefore.at),
        )
        .at(-1) ?? null;
    const hostId = host === null ? null : (HOST_TUNNEL.exec(String(host.s.path))?.[1] ?? null);
    wakes.push({
      computerId: w.computerId,
      generation: w.generation,
      at: anchor,
      resumeAt: resume?.at ?? null,
      grantedAt,
      startAt,
      lastStartAt,
      retries: w.lines.filter((l) => l.s.kind === "retry").length,
      restoredAt: restored?.at ?? null,
      layers: num(restored?.s.layers),
      deliveredAt: delivered?.at ?? null,
      hostAt: host?.at ?? null,
      host: hostId === null || hostId === "<hex32>" ? null : hostId.slice(0, 8),
      runnerAt: runner?.at ?? null,
      stopBefore,
      killAt: kill?.at ?? null,
      ms: {
        startToHost: diff(from, host?.at ?? null),
        hostToRunner: diff(host?.at ?? null, runner?.at ?? null),
        resumeToRunner: diff(resume?.at ?? null, runner?.at ?? null),
        startToRestored: diff(from, restored?.at ?? null),
        stopToStart: diff(stopBefore?.at ?? null, from),
        retrying: diff(startAt, lastStartAt),
        killToStop: diff(kill?.at ?? null, kill === null ? null : (stopBefore?.at ?? null)),
        killToHost: diff(kill?.at ?? null, host?.at ?? null),
      },
      timedFrom: startAt !== null ? "start" : grantedAt !== null ? "grant" : "first line",
    });
  }
  wakes.sort((a, b) => a.at - b.at);

  const refused: RefusedWake[] = [
    ...resumes
      .filter((e) => typeof e.s.status === "number" && e.s.status !== 200)
      .map((e) => ({
        at: e.at,
        computerId: str(e.s.computerId),
        kind: "resume_refused" as const,
        detail: `status ${e.s.status}`,
      })),
    ...of("control", "reserve_refused").map((e) => ({
      at: e.at,
      computerId: str(e.s.computerId),
      kind: "reserve_refused" as const,
      detail: JSON.stringify({ reason: e.s.reason ?? null, limit: e.s.limit ?? null }),
    })),
  ].sort((a, b) => a.at - b.at);
  return { wakes, refused };
}

const seconds = (ms: number | null): string => (ms === null ? "-" : `${(ms / 1000).toFixed(1)}s`);

/** The table's lines, one per wake, then one per refused wake. */
export function describeWakes(table: ReturnType<typeof wakeTable>): string[] {
  const out = table.wakes.map((w) =>
    [
      new Date(w.at).toISOString(),
      w.computerId,
      `g${w.generation}`,
      `start→host ${seconds(w.ms.startToHost)}${w.timedFrom === "start" ? "" : ` (from the ${w.timedFrom})`}`,
      `host→turn ${seconds(w.ms.hostToRunner)}`,
      `resume→turn ${seconds(w.ms.resumeToRunner)}`,
      `stop→start ${seconds(w.ms.stopToStart)}${w.stopBefore ? ` (${w.stopBefore.kind}${w.stopBefore.reason ? `: ${w.stopBefore.reason}` : ""})` : ""}`,
      `retries ${w.retries}${w.retries > 0 ? ` over ${seconds(w.ms.retrying)}` : ""}`,
      ...(w.killAt === null
        ? []
        : [`kill→stop ${seconds(w.ms.killToStop)}`, `kill→host ${seconds(w.ms.killToHost)}`]),
      `host ${w.host ?? "-"}`,
    ].join("  "),
  );
  for (const r of table.refused) {
    out.push(
      `${new Date(r.at).toISOString()}  ${r.computerId ?? "?"}  REFUSED ${r.kind} ${r.detail}`,
    );
  }
  if (out.length === 0) out.push("no wake in these logs");
  return out;
}

export async function main(lines: AsyncIterable<string>, print: (text: string) => void) {
  const parsed: LogLine[] = [];
  for await (const text of lines) {
    if (text.trim() === "") continue;
    try {
      parsed.push(JSON.parse(text) as LogLine);
    } catch {
      // not a log line
    }
  }
  const table = wakeTable(parsed);
  for (const line of describeWakes(table)) print(line);
  print(JSON.stringify(table));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(createInterface({ input: process.stdin }), (text) => console.log(text));
}
