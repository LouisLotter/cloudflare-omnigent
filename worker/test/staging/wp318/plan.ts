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
// tunnel was reopened at all (no drop). A WorkspaceDO reset is judged like a web deploy: host
// tunnels run through OmnigentServer, not WorkspaceDO, so it drops none (the 28 Oct sitting's
// reset dropped nothing; the analysis then measured 306.5 s to an unrelated later break). If a
// tunnel did reopen within the no-drop window, it must have done so within RC-21's bound.
//
// A computer counts for a disruption only if its host was connected before it. For a computer the
// window shows, that is seeded from its host-tunnel opens before the window too (`run.sh
// collect`'s presence.jsonl), so the first disruption is judged (on 28 Oct, T0+10's reset had no
// row: the host had connected before the window). A host seen only before the window, and a
// window with no host at all, are inconclusive rows: never a silent pass.
//
// A reset's time is the soak run's own record, taken just before it. A platform deploy's drop is
// OmnigentServer's own version switch (every host tunnel runs through that object), never read
// from a host's reconnect (Codex WP3.18 r1-3, r2-2): around each platform deploy the soak run
// asks OmnigentServer every 5 s to log a heartbeat, in whichever version that object runs, and
// the switch lies between its last heartbeat of another version and its first of the version the
// deploy printed (r2-3: never a later deployment's). A reconnect is judged against both ends:
// within the bound from the earlier one passes, beyond it from the later one fails, anything
// between is inconclusive, and a deploy whose version or heartbeats are missing is inconclusive.

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

/** The soak run's heartbeat around each platform deploy, which brackets its version switch. */
export const HEARTBEAT_MS = 5_000;
/** How long the heartbeats run after a platform deploy's time (the switch took about 5 min). */
export const HEARTBEAT_WINDOW_MS = 15 * MIN;

/** When the soak run's next heartbeat is due, or null once no platform deploy is left. */
export function nextHeartbeat(
  t0: number,
  now: number,
  schedule: readonly SoakEvent[] = SOAK_SCHEDULE,
): number | null {
  let next: number | null = null;
  for (const event of schedule) {
    if (event.kind !== "platform_deploy") continue;
    const start = t0 + event.at;
    const end = start + HEARTBEAT_WINDOW_MS;
    if (now >= start && now < end) return now + HEARTBEAT_MS;
    if (now < start && (next === null || start < next)) next = start;
  }
  return next;
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

/**
 * A Workers version ID as the soak's records keep it: its first 13 characters (`8-4` hex).
 * redact.py replaces whole UUIDs, so a full ID would reach the analysis as "<uuid>" for every
 * version. A deploy's record (run.sh) and the logs (`logs.ts`) cut it the same way.
 */
export function shortVersion(id: unknown): string | undefined {
  return typeof id === "string" && id !== "" ? id.slice(0, 13) : undefined;
}

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
  /** The version a platform deploy printed ("Current Version ID"); its switch is to this one. */
  readonly version?: string;
  /** The drop overlapped a capture pause (RC-21's longer bound). */
  readonly duringPause?: boolean;
}

// The host's ID as Workers Logs has it, or as redact.py leaves it in collected logs ("<hex32>"):
// opens are keyed by the computer's ID, which redaction keeps (the 28 Oct sitting's first analysis
// matched no open, so it checked nothing).
const HOST_TUNNEL = /^\/v1\/hosts\/(?:[0-9a-f]{32}|<hex32>)\/tunnel$/;

interface Open {
  readonly at: number;
  readonly version: string | undefined;
}

/** The computer whose host's tunnel this line opened (101), or null for any other line. */
export function hostTunnelOpen(line: LogLine): string | null {
  const s = typeof line.source === "object" && line.source !== null ? line.source : null;
  if (s === null || s.cfo !== "computer_route" || s.event !== "request") return null;
  if (s.status !== 101 || typeof s.path !== "string" || !HOST_TUNNEL.test(s.path)) return null;
  return typeof s.computerId === "string" ? s.computerId : null;
}

function openLines(lines: readonly LogLine[]): Map<string, Open[]> {
  const opens = new Map<string, Open[]>();
  for (const line of lines) {
    const computerId = hostTunnelOpen(line);
    if (computerId === null) continue;
    const list = opens.get(computerId) ?? [];
    list.push({ at: line.timestamp, version: line.version });
    opens.set(computerId, list);
  }
  for (const list of opens.values()) list.sort((a, b) => a.at - b.at);
  return opens;
}

/** Each computer's successful host-tunnel opens (101), in time order. */
export function tunnelOpens(lines: readonly LogLine[]): Map<string, number[]> {
  return new Map([...openLines(lines)].map(([id, list]) => [id, list.map((o) => o.at)]));
}

/** OmnigentServer's own heartbeat (soak.ts), with the version of the object that logged it. */
function isServerHeartbeat(line: LogLine): boolean {
  const s = typeof line.source === "object" && line.source !== null ? line.source : null;
  return (
    s !== null &&
    s.cfo === "soak" &&
    s.event === "heartbeat" &&
    s.from === "server" &&
    line.version !== undefined
  );
}

/**
 * Where OmnigentServer switched to the deployed `version`: after its last heartbeat of another
 * version, and at or before its first heartbeat of this one, from the deploy's start on. Null if
 * the version is unknown or the heartbeats do not bracket the switch.
 */
export function switchBracket(
  lines: readonly LogLine[],
  deploy: { readonly from: number; readonly version: string | undefined },
): { readonly lastOld: number; readonly firstNew: number; readonly version: string } | null {
  const version = deploy.version;
  if (version === undefined) return null;
  const beats = lines.filter(isServerHeartbeat).sort((a, b) => a.timestamp - b.timestamp);
  const first = beats.find((l) => l.timestamp >= deploy.from && l.version === version);
  if (first === undefined) return null;
  const old = beats.filter((l) => l.timestamp < first.timestamp && l.version !== version).at(-1);
  if (old === undefined) return null;
  return { lastOld: old.timestamp, firstNew: first.timestamp, version };
}

export interface Reconnect {
  readonly kind: SoakEventKind;
  /** When the drop happened at the earliest (the reset, or the switch's bracket start). */
  readonly at: number | null;
  readonly computerId: string;
  /** Until the host's tunnel opened again, at most; null if it never did. */
  readonly gapMs: number | null;
  /** For a version switch: the gap from the bracket's end, at least. */
  readonly lowerMs?: number;
  readonly boundMs: number;
  readonly ok: boolean;
  readonly note?: string;
}

/** Kinds that drop no host tunnel: none may reopen within the no-drop window (see the top). */
const NO_DROP: ReadonlySet<SoakEventKind> = new Set(["web_deploy", "workspace_reset"]);

/**
 * For every disruption and every computer seen in the logs: the reconnect (server resets and
 * platform deploys must reconnect within RC-21's bound) or the absence of one (a web deploy and
 * a WorkspaceDO reset must drop no computer's connection, or reconnect it within the bound).
 * `before`: lines from before the collected window, read only for each host's earlier opens. A
 * host seen only there, or no host at all, gives an inconclusive row (see below).
 */
export function reconnects(
  disruptions: readonly Disruption[],
  lines: readonly LogLine[],
  before: readonly LogLine[] = [],
): Reconnect[] {
  const opens = openLines(lines);
  // Earlier opens only date a host, and never count as its reconnect.
  const earlier = openLines(before);
  const results: Reconnect[] = [];
  // Hosts connected before the window and never seen in it (Codex WP3.27 r1-2): removed or asleep
  // before the soak, or never back after its first drop. The logs cannot tell which, so each is
  // one inconclusive row at the first disruption, never silently left out. Nothing seen at all
  // (no host-tunnel open, as in the 28 Oct sitting's first analysis) is the same: nothing checked.
  const first = disruptions.find((d) => d.kind !== "end");
  if (first !== undefined) {
    const unseen = [...earlier.keys()].filter((id) => !opens.has(id));
    if (opens.size === 0 && unseen.length === 0) unseen.push("(none)");
    for (const computerId of unseen) {
      results.push({
        kind: first.kind,
        at: first.at,
        computerId,
        gapMs: null,
        boundMs: first.duringPause ? RC21_PAUSE_MS : RC21_MS,
        ok: false,
        note:
          computerId === "(none)"
            ? "inconclusive: no host-tunnel open in the logs, so nothing was checked"
            : "inconclusive: its host connected before the window and never opened a tunnel in it (removed or asleep before the soak, or never reconnected)",
      });
    }
  }
  for (const d of disruptions) {
    if (d.kind === "end") continue;
    const bracket =
      d.kind === "platform_deploy"
        ? switchBracket(lines, { from: d.at, version: d.version })
        : null;
    const at = d.kind === "platform_deploy" ? (bracket?.lastOld ?? null) : d.at;
    const boundMs = d.duringPause ? RC21_PAUSE_MS : RC21_MS;
    for (const [computerId, list] of opens) {
      const times = list.map((o) => o.at);
      // Only a computer whose host was connected before the disruption can be dropped by it.
      const connected = [...(earlier.get(computerId) ?? []).map((o) => o.at), ...times];
      if (!connected.some((t) => t < d.at)) continue;
      if (NO_DROP.has(d.kind)) {
        const from = d.deployEndedAt ?? d.at;
        const reopened = times.find((t) => t >= d.at && t <= from + NO_DROP_WINDOW_MS);
        const gapMs = reopened === undefined ? null : reopened - d.at;
        // A web deploy must drop nothing; a WorkspaceDO reset drops nothing, or the host is back
        // within RC-21's bound.
        const ok = gapMs === null || (d.kind === "workspace_reset" && gapMs <= boundMs);
        results.push({
          kind: d.kind,
          at: d.at,
          computerId,
          gapMs,
          boundMs: d.kind === "web_deploy" ? 0 : boundMs,
          ok,
          ...(gapMs === null
            ? {}
            : {
                note: ok
                  ? "a host tunnel reopened within the bound"
                  : "a host tunnel reopened: a drop",
              }),
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
          note: "inconclusive: no switch to the deployed version bracketed by the server's heartbeats",
        });
        continue;
      }
      if (bracket !== null) {
        // The reconnect to the new version, judged against both ends of the switch's bracket.
        const next = list.find((o) => o.at >= bracket.lastOld && o.version === bracket.version);
        const upper = next === undefined ? null : next.at - bracket.lastOld;
        const lower = next === undefined ? undefined : Math.max(0, next.at - bracket.firstNew);
        const passed = upper !== null && upper <= boundMs;
        const failed = upper === null || (lower ?? 0) > boundMs;
        results.push({
          kind: d.kind,
          at,
          computerId,
          gapMs: upper,
          ...(lower === undefined ? {} : { lowerMs: lower }),
          boundMs,
          ok: passed,
          ...(passed || failed
            ? {}
            : {
                note: `inconclusive: the switch is known only within ${bracket.firstNew - bracket.lastOld} ms`,
              }),
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

// ---------------------------------------------------------------------------------------------
// The watchdog's controlled restarts (G2-SEC-001). A release that changes the server's
// configuration (the bootstrap's release, the launcher's key) or its image (WP3.19) is applied by
// one restart, logged as a `config_changed` outage. The sitting waits for each before it goes on;
// during the soak no deploy changes the server's configuration, and none its image (the staging
// tool builds every deploy of a deployment with one SOURCE_DATE_EPOCH, so the same sources give
// the same digest), so any such restart there is a finding.

/** One `config_changed` outage the watchdog logged: when it started and, once logged, ended. */
export interface ConfigRestart {
  readonly outageId: string;
  /** The `outage_started` line's time (ms), or null if only its end is in the window. */
  readonly startedAt: number | null;
  /** The `outage_ended` line's time (ms), or null while it lasts. */
  readonly endedAt: number | null;
  /** The outage's length as the watchdog recorded it (from the server's last answer). */
  readonly durationMs: number | null;
}

function sourceOf(line: LogLine): Readonly<Record<string, unknown>> | null {
  if (typeof line.source === "object" && line.source !== null) return line.source;
  if (typeof line.source !== "string") return null;
  try {
    const parsed = JSON.parse(line.source) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The watchdog's `config_changed` outages with a line in [from, to), in time order. */
export function configRestarts(
  lines: readonly LogLine[],
  from: number,
  to: number,
): ConfigRestart[] {
  const byId = new Map<string, ConfigRestart>();
  const sorted = [...lines].sort((a, b) => a.timestamp - b.timestamp);
  for (const line of sorted) {
    if (line.timestamp < from || line.timestamp >= to) continue;
    const s = sourceOf(line);
    if (s === null || s.cfo !== "watchdog" || s.cause !== "config_changed") continue;
    if (typeof s.outageId !== "string") continue;
    const known = byId.get(s.outageId) ?? {
      outageId: s.outageId,
      startedAt: null,
      endedAt: null,
      durationMs: null,
    };
    if (s.event === "outage_started") byId.set(s.outageId, { ...known, startedAt: line.timestamp });
    else if (s.event === "outage_ended") {
      byId.set(s.outageId, {
        ...known,
        endedAt: line.timestamp,
        durationMs: typeof s.durationMs === "number" ? s.durationMs : null,
      });
    }
  }
  return [...byId.values()].sort(
    (a, b) => (a.startedAt ?? a.endedAt ?? 0) - (b.startedAt ?? b.endedAt ?? 0),
  );
}

// ---------------------------------------------------------------------------------------------
// The server's measured restarts (WP3.19): the times of each `config_changed` restart, and the
// forced replacement's result. Both are the lead's records; neither needs the owner.

/** A controlled restart, with the watchdog's `server_ready` breakdown logged at its end. */
export interface RestartTimes extends ConfigRestart {
  /** From the replacement's last `start()` to its first answer: the start itself. */
  readonly lastStartToReadyMs: number | null;
  /** From its first `start()` (refused starts retried included) to its first answer. */
  readonly firstStartToReadyMs: number | null;
  /** Starts that failed before it answered (DC-37's refusals right after a stop). */
  readonly failedStarts: number | null;
}

/** The `server_ready` line logged with an outage's end: the same check, so seconds apart. */
const READY_WITH_END_MS = 10_000;

const numberOr = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** Each `config_changed` restart in [from, to), with its timings when its end was logged. */
export function restartTimes(lines: readonly LogLine[], from: number, to: number): RestartTimes[] {
  const ready = lines
    .map((line) => ({ at: line.timestamp, s: sourceOf(line) }))
    .filter(({ s }) => s?.cfo === "watchdog" && s.event === "server_ready")
    .sort((a, b) => a.at - b.at);
  return configRestarts(lines, from, to).map((restart) => {
    const end = restart.endedAt;
    const match =
      end === null
        ? undefined
        : ready.filter(({ at }) => at <= end && end - at <= READY_WITH_END_MS).at(-1);
    return {
      ...restart,
      lastStartToReadyMs: numberOr(match?.s?.lastStartToReadyMs),
      firstStartToReadyMs: numberOr(match?.s?.firstStartToReadyMs),
      failedStarts: numberOr(match?.s?.failedStarts),
    };
  });
}

/** The forced replacement (G2's `replace-2`, run by soak.ts), as its step lines report it. */
export interface ReplaceResult {
  readonly stage: "done" | "failed";
  readonly verdict: string | null;
  readonly problems: readonly string[];
  /** From the kill to the new boot's readiness (the app's own time when it reported one). */
  readonly answeredAfterKillS: number | null;
  /** Each entrypoint phase's first sight, seconds after the kill. */
  readonly phasesS: Readonly<Record<string, unknown>> | null;
  readonly replicaCaughtUpAfterS: number | null;
  /** The replacement runs this version's configuration, image and size, released. */
  readonly configPass: boolean | null;
  readonly failure: string | null;
}

const objectOr = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** The forced replacement's last outcome in the lines, or null while it has none. */
export function replaceResult(lines: readonly LogLine[]): ReplaceResult | null {
  const ended = [...lines]
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(sourceOf)
    .filter(
      (s) =>
        s?.cfo === "g2_sitting" &&
        s.step === "replace-2" &&
        (s.event === "step_done" || s.event === "step_failed"),
    )
    .at(-1);
  if (ended === undefined || ended === null) return null;
  const record = objectOr(ended.record);
  const problems = Array.isArray(ended.problems)
    ? ended.problems.filter((p): p is string => typeof p === "string")
    : [];
  return {
    stage: ended.event === "step_done" ? "done" : "failed",
    verdict:
      typeof ended.verdict === "string"
        ? ended.verdict
        : ended.event === "step_failed"
          ? "fail"
          : null,
    problems,
    answeredAfterKillS: numberOr(record?.answeredAfterKillS),
    phasesS: objectOr(record?.phasesS),
    replicaCaughtUpAfterS: numberOr(objectOr(record?.replica)?.caughtUpAfterS),
    configPass: (() => {
      const pass = objectOr(objectOr(record?.after)?.config)?.pass;
      return typeof pass === "boolean" ? pass : null;
    })(),
    failure: typeof ended.failure === "string" ? ended.failure : null,
  };
}
