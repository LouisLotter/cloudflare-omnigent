// The soak's analysis (WP3.33, the measurement half of WP3.29 item 2): which Durable Object
// instance starts no deploy or planned reset explains. Pure, tested in Node.
//
// Every new instance of WorkspaceDO, OmnigentServer and ControlDO logs `instance_started` with a
// random instance ID and the Worker version that runs it (WP3.27). Each start is given a cause:
//   - `deploy`: it runs another version than the object's instance before it, or (with none
//     before it in the window) the version a platform deploy made current shortly before;
//   - `planned_reset`: a reset of its class was asked for just before it (the soak's own
//     `server_reset` and `workspace_reset`, and the lead's `server-reset` and `workspace-reset`
//     commands, for their computer);
//   - `idle`: a WorkspaceDO or ControlDO start with nothing open in the instance before it. Both
//     objects are evicted when idle and start again at the next call, which is expected (on
//     28 Oct WorkspaceDO started afresh for about every 30-second report);
//   - `unexplained`: everything else: an OmnigentServer start (its 60-second alarm keeps it in
//     memory, so a new instance is a reset), or a WorkspaceDO start while the instance before it
//     held a terminal stream (FH-38's case).
// `analyze.ts` lists the unexplained ones; they are measurements, not a verdict.

import { type LogLine, sourceOf } from "./plan.ts";

/** How soon after a planned reset its object's new instance must start to be explained by it. */
export const RESET_WINDOW_MS = 2 * 60_000;
/** How long after a platform deploy an object's first instance on its version is explained. */
export const DEPLOY_WINDOW_MS = 20 * 60_000;

export type InstanceClass = "WorkspaceDO" | "OmnigentServer" | "ControlDO";

/** A disruption the sitting planned, as the analysis knows it. */
export interface Planned {
  readonly kind: "server_reset" | "workspace_reset" | "platform_deploy" | "web_deploy";
  readonly at: number;
  /** The version a platform deploy made current (13 characters, `shortVersion`). */
  readonly version?: string;
  /** A command's computer; none for the soak's `workspace_reset`, which resets them all. */
  readonly computerId?: string;
}

export interface InstanceStart {
  readonly at: number;
  readonly class: InstanceClass;
  readonly instanceId: string;
  readonly computerId: string | null;
  readonly version: string | null;
  readonly cause: "deploy" | "planned_reset" | "idle" | "unexplained";
  readonly note: string;
}

interface Started {
  readonly at: number;
  readonly class: InstanceClass;
  readonly instanceId: string;
  readonly computerId: string | null;
  readonly version: string | null;
}

const CLASSES: ReadonlySet<string> = new Set(["WorkspaceDO", "OmnigentServer", "ControlDO"]);
// A stream holds the computer's side open from its bridge (or reattach) to its end; a detached
// stream keeps that side open through its grace, waiting for a reattach.
const OPENS = new Set(["terminal_bridged", "terminal_reattached"]);
const CLOSES = new Set(["terminal_stream_ended"]);

/** The instance starts in the lines, each with its cause, in time order. */
export function instanceStarts(
  lines: readonly LogLine[],
  planned: readonly Planned[],
): InstanceStart[] {
  const sorted = [...lines].sort((a, b) => a.timestamp - b.timestamp);
  const started: Started[] = [];
  const streams: { at: number; instanceId: string; window: unknown; open: boolean }[] = [];
  for (const line of sorted) {
    const s = sourceOf(line);
    if (s === null) continue;
    if (s.event === "instance_started" && typeof s.class === "string" && CLASSES.has(s.class)) {
      if (typeof s.instanceId !== "string") continue;
      started.push({
        at: line.timestamp,
        class: s.class as InstanceClass,
        instanceId: s.instanceId,
        computerId: typeof s.computerId === "string" ? s.computerId : null,
        version: line.version ?? null,
      });
    } else if (typeof s.event === "string" && typeof s.instanceId === "string") {
      const open = OPENS.has(s.event);
      if (open || CLOSES.has(s.event)) {
        streams.push({ at: line.timestamp, instanceId: s.instanceId, window: s.window, open });
      }
    }
  }
  /** Whether the instance held a terminal stream just before `at`. */
  const streamOpen = (instanceId: string, at: number) => {
    const windows = new Set<unknown>();
    for (const e of streams) {
      if (e.instanceId !== instanceId || e.at >= at) continue;
      if (e.open) windows.add(e.window);
      else windows.delete(e.window);
    }
    return windows.size > 0;
  };

  // A planned reset explains one new instance of each object it reset: the first after it.
  const used = new Set<string>();
  return started.map((i, index) => {
    const object = (o: Started) =>
      o.class === i.class && (i.class !== "WorkspaceDO" || o.computerId === i.computerId);
    const objectKey = `${i.class}/${i.computerId ?? ""}`;
    const previous = started.slice(0, index).filter(object).at(-1) ?? null;
    const base = { ...i };
    if (previous !== null && i.version !== null && previous.version !== null) {
      if (i.version !== previous.version) {
        return { ...base, cause: "deploy", note: `version ${previous.version} → ${i.version}` };
      }
    } else if (i.version !== null) {
      const deploy = planned.find(
        (p) =>
          p.kind === "platform_deploy" &&
          p.version === i.version &&
          i.at >= p.at &&
          i.at - p.at <= DEPLOY_WINDOW_MS,
      );
      if (deploy !== undefined) {
        return { ...base, cause: "deploy", note: "the first instance seen on a deployed version" };
      }
    }
    const resetKind = i.class === "OmnigentServer" ? "server_reset" : "workspace_reset";
    const reset = planned.findIndex(
      (p, n) =>
        p.kind === resetKind &&
        i.class !== "ControlDO" &&
        i.at >= p.at &&
        i.at - p.at <= RESET_WINDOW_MS &&
        (p.computerId === undefined || p.computerId === i.computerId) &&
        !used.has(`${n}/${objectKey}`),
    );
    if (reset >= 0) {
      used.add(`${reset}/${objectKey}`);
      return { ...base, cause: "planned_reset", note: planned[reset]?.kind ?? "" };
    }
    if (i.class === "OmnigentServer") {
      return {
        ...base,
        cause: "unexplained",
        note:
          previous === null
            ? "no deploy or reset before it (and no earlier instance in the window)"
            : "no deploy or reset before it",
      };
    }
    if (i.class === "WorkspaceDO" && previous !== null && streamOpen(previous.instanceId, i.at)) {
      return {
        ...base,
        cause: "unexplained",
        note: "the instance before it held a terminal stream (FH-38's case)",
      };
    }
    return { ...base, cause: "idle", note: "nothing open in the instance before it" };
  });
}

/** Counts by class and cause, for the verdict. */
export function instanceCounts(
  starts: readonly InstanceStart[],
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const s of starts) {
    const byCause = out[s.class] ?? {};
    byCause[s.cause] = (byCause[s.cause] ?? 0) + 1;
    out[s.class] = byCause;
  }
  return out;
}
