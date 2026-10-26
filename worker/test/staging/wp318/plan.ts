// WP3.18 staging soak (RC-26), pure parts: the schedule of disruptions and the analysis of the
// platform Worker's Workers Logs. No runtime import, so they are tested in Node
// (test/unit/wp318-staging.test.ts).
//
// The soak runs for 3 hours from T0, the owner's Start click on the soak page, with a real host,
// runners and active work on one or two computers. The platform Worker itself (soak.ts) forces
// resets of OmnigentServer and of every WorkspaceDO at fixed times; the laptop (run.sh campaign)
// deploys the web Worker and the platform Worker at others. Every host tunnel the computer route
// answers with 101 is in the platform Worker's logs (`computer_route` `request`, path
// `/v1/hosts/<host id>/tunnel`), so the analysis measures, for each disruption that drops the
// live connection, how long each computer's host took to open its tunnel again (RC-21: 60 s,
// 100 s when the drop overlaps a capture pause), and, for a web Worker deploy, that no host
// tunnel was reopened at all (no drop).

export const MIN = 60_000;
/** The soak's length (RC-26). */
export const SOAK_MS = 180 * MIN;
/** RC-21's bound, and its bound when the drop overlaps a capture pause. */
export const RC21_MS = 60_000;
export const RC21_PAUSE_MS = 100_000;
/** After a web Worker deploy, how long no host tunnel may reopen (a drop would show within it). */
export const NO_DROP_WINDOW_MS = 120_000;

export type SoakEventKind =
  | "server_reset"
  | "workspace_reset"
  | "web_deploy"
  | "platform_deploy"
  | "end";

export interface SoakEvent {
  readonly kind: SoakEventKind;
  /** After T0. */
  readonly at: number;
  /** Who causes it: the platform Worker's soak run, or the laptop. */
  readonly by: "worker" | "laptop";
}

export const SOAK_SCHEDULE: readonly SoakEvent[] = [
  { kind: "server_reset", at: 10 * MIN, by: "worker" },
  { kind: "web_deploy", at: 30 * MIN, by: "laptop" },
  { kind: "platform_deploy", at: 50 * MIN, by: "laptop" },
  { kind: "server_reset", at: 80 * MIN, by: "worker" },
  { kind: "workspace_reset", at: 100 * MIN, by: "worker" },
  { kind: "platform_deploy", at: 120 * MIN, by: "laptop" },
  { kind: "web_deploy", at: 140 * MIN, by: "laptop" },
  { kind: "server_reset", at: 160 * MIN, by: "worker" },
  { kind: "end", at: SOAK_MS, by: "worker" },
];

/** The worker's events due at `now` and not yet done, by index into the schedule. */
export function dueEvents(
  t0: number,
  done: ReadonlySet<number>,
  now: number,
  schedule: readonly SoakEvent[] = SOAK_SCHEDULE,
): number[] {
  return schedule.flatMap((event, index) =>
    event.by === "worker" && !done.has(index) && now >= t0 + event.at ? [index] : [],
  );
}

/** The laptop's next event at or after `now`, or null. */
export function nextLaptopEvent(
  t0: number,
  now: number,
  schedule: readonly SoakEvent[] = SOAK_SCHEDULE,
): { readonly index: number; readonly at: number; readonly kind: SoakEventKind } | null {
  for (const [index, event] of schedule.entries()) {
    if (event.by === "laptop" && t0 + event.at >= now) {
      return { index, at: t0 + event.at, kind: event.kind };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The analysis.

/** One Workers Logs event, as `logs.ts` writes it: the time, the version, the parsed log line. */
export interface LogLine {
  readonly timestamp: number;
  readonly version?: string;
  readonly source?: Readonly<Record<string, unknown>> | string | null;
}

/** A disruption as it happened: its kind and when (absolute ms). */
export interface Disruption {
  readonly kind: SoakEventKind;
  readonly at: number;
  /** A deploy's upload ended here; its version switch is found in the logs. */
  readonly deployEndedAt?: number;
  /** The drop overlapped a capture pause (RC-21's longer bound). */
  readonly duringPause?: boolean;
}

const HOST_TUNNEL = /^\/v1\/hosts\/[0-9a-f]{32}\/tunnel$/;

/** Each computer's successful host-tunnel opens (101), in time order. */
export function tunnelOpens(lines: readonly LogLine[]): Map<string, number[]> {
  const opens = new Map<string, number[]>();
  for (const line of lines) {
    const s = typeof line.source === "object" && line.source !== null ? line.source : null;
    if (s === null || s.cfo !== "computer_route" || s.event !== "request") continue;
    if (s.status !== 101 || typeof s.path !== "string" || !HOST_TUNNEL.test(s.path)) continue;
    if (typeof s.computerId !== "string") continue;
    const list = opens.get(s.computerId) ?? [];
    list.push(line.timestamp);
    opens.set(s.computerId, list);
  }
  for (const list of opens.values()) list.sort((a, b) => a - b);
  return opens;
}

/**
 * When a deploy took effect: the first event after its upload ended that carries a version not
 * seen before it. Null if no such event (the switch was missed, or the logs end first).
 */
export function versionSwitch(lines: readonly LogLine[], deployEndedAt: number): number | null {
  const sorted = [...lines].sort((a, b) => a.timestamp - b.timestamp);
  const before = new Set(
    sorted.filter((l) => l.timestamp < deployEndedAt && l.version).map((l) => l.version),
  );
  if (before.size === 0) return null;
  const first = sorted.find(
    (l) => l.timestamp >= deployEndedAt && l.version !== undefined && !before.has(l.version),
  );
  return first?.timestamp ?? null;
}

export interface Reconnect {
  readonly kind: SoakEventKind;
  /** When the drop happened (a deploy's version switch, or the reset). */
  readonly at: number | null;
  readonly computerId: string;
  /** Until the host's tunnel opened again; null if it never did. */
  readonly gapMs: number | null;
  readonly boundMs: number;
  readonly ok: boolean;
  readonly note?: string;
}

/**
 * For every disruption and every computer seen in the logs: the reconnect (resets and platform
 * deploys must reconnect within RC-21's bound) or the absence of one (a web deploy must drop no
 * computer's connection).
 */
export function reconnects(
  disruptions: readonly Disruption[],
  lines: readonly LogLine[],
): Reconnect[] {
  const opens = tunnelOpens(lines);
  const results: Reconnect[] = [];
  for (const d of disruptions) {
    if (d.kind === "end") continue;
    const at = d.kind === "platform_deploy" ? versionSwitch(lines, d.deployEndedAt ?? d.at) : d.at;
    const boundMs = d.duringPause ? RC21_PAUSE_MS : RC21_MS;
    for (const [computerId, times] of opens) {
      // Only a computer whose host was connected before the disruption can be dropped by it.
      if (!times.some((t) => t < d.at)) continue;
      if (d.kind === "web_deploy") {
        const from = d.deployEndedAt ?? d.at;
        const reopened = times.find((t) => t >= d.at && t <= from + NO_DROP_WINDOW_MS);
        results.push({
          kind: d.kind,
          at: d.at,
          computerId,
          gapMs: reopened === undefined ? null : reopened - d.at,
          boundMs: 0,
          ok: reopened === undefined,
          ...(reopened === undefined ? {} : { note: "a host tunnel reopened: a drop" }),
        });
        continue;
      }
      if (at === null) {
        results.push({
          kind: d.kind,
          at,
          computerId,
          gapMs: null,
          boundMs,
          ok: false,
          note: "no version switch found",
        });
        continue;
      }
      const next = times.find((t) => t >= at);
      const gapMs = next === undefined ? null : next - at;
      results.push({
        kind: d.kind,
        at,
        computerId,
        gapMs,
        boundMs,
        ok: gapMs !== null && gapMs <= boundMs,
      });
    }
  }
  return results;
}
