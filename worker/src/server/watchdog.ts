// The server watchdog's decisions, as a pure function (code-structure plan, principle 3). The
// OmnigentServer Durable Object observes its container, calls `step`, persists the new state and
// the outage records, then carries out the effects.
//
// The design's rules (hybrid-architecture.md, "Scheduling" and "Server restarts"; DC-37, DC-47):
//   - the server is always on: a container found stopped is started again, and the watchdog
//     itself never stops a server that answers;
//   - after each start it waits at least 120 s for readiness before it records a failed start;
//   - an outage record starts when the server was last known to answer, never later, so a notice
//     never understates the interval, and ends when it answers again;
//   - a start refused right after a stop (DC-37), or any start that stops before answering, is
//     retried with a bounded backoff, about a minute in all, then every minute: the server is
//     never given up on;
//   - a server that runs but has not answered for the readiness wait is restarted.

import type { OutageRecord } from "@cfo/contracts";

export interface WatchdogTiming {
  /** The check cadence while the server answers ("a watchdog callback every few minutes"). */
  readonly intervalMs: number;
  /** The check cadence while it starts, retries or is in an outage. */
  readonly pollMs: number;
  /** How long a start may take to answer before it counts as failed (DC-47: at least 120 s). */
  readonly readinessWaitMs: number;
  /** How long a running server may stay silent before it is restarted. */
  readonly hungAfterMs: number;
  /** Delays before each retry of a failed start, in order (DC-37: about a minute in all). */
  readonly startRetryMs: readonly number[];
  /** The delay between retries once `startRetryMs` is used up. */
  readonly slowRetryMs: number;
}

export const WATCHDOG_TIMING: WatchdogTiming = {
  intervalMs: 60_000,
  pollMs: 5_000,
  readinessWaitMs: 120_000,
  hungAfterMs: 120_000,
  startRetryMs: [5_000, 10_000, 20_000, 20_000],
  slowRetryMs: 60_000,
};

export type OutageCause = OutageRecord["cause"];

export interface OngoingOutage {
  readonly outageId: string;
  readonly cause: OutageCause;
  readonly startedAt: number;
  readonly detectedAt: number;
  readonly restarts: number;
}

/**
 * - `idle`: no start in progress; the server answered last, or has not been started yet.
 * - `starting`: `start()` was called at `phaseSince`; waiting for the server to answer.
 * - `waiting`: a start failed, or the server was stopped to be restarted; the next `start()` is
 *   due at `startDueAt`.
 */
export type WatchdogPhase = "idle" | "starting" | "waiting";

export interface WatchdogState {
  readonly phase: WatchdogPhase;
  /** When the phase began: the time of the last `start()` while `starting`. */
  readonly phaseSince: number | null;
  readonly startDueAt: number | null;
  /** Starts in a row that stopped, or never answered, before the server answered. */
  readonly failedStarts: number;
  /** The last time the server answered. Null until it first answers. */
  readonly lastAnsweredAt: number | null;
  /** The first `start()` since the server last answered (or ever): the breakdown's origin. */
  readonly startsSince: number | null;
  readonly outage: OngoingOutage | null;
}

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  phase: "idle",
  phaseSince: null,
  startDueAt: null,
  failedStarts: 0,
  lastAnsweredAt: null,
  startsSince: null,
  outage: null,
};

/**
 * What the Durable Object saw: the container stopped; running and answering its health check;
 * or running and not answering, after a retry.
 */
export type Observation = "stopped" | "answering" | "silent";

export type WatchdogEventName =
  | "found_stopped"
  | "start"
  | "start_stopped"
  | "start_not_ready"
  | "start_failing"
  | "not_answering"
  | "restart_silent"
  | "server_ready"
  | "outage_started"
  | "outage_ended";

export type EventFields = Readonly<Record<string, number | string | boolean | null>>;

export type Effect =
  | { readonly type: "start" }
  | { readonly type: "destroy"; readonly reason: string }
  /** Insert or replace this outage record. */
  | { readonly type: "outage"; readonly record: OutageRecord }
  | { readonly type: "event"; readonly name: WatchdogEventName; readonly fields: EventFields };

export interface Step {
  readonly state: WatchdogState;
  readonly effects: readonly Effect[];
  /** When the watchdog should look again. */
  readonly nextCheckAt: number;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The outage as the contract records it; `endedAt` null while it lasts. */
export function outageRecord(outage: OngoingOutage, endedAt: number | null): OutageRecord {
  return {
    outageId: outage.outageId,
    cause: outage.cause,
    startedAt: iso(outage.startedAt),
    detectedAt: iso(outage.detectedAt),
    endedAt: endedAt === null ? null : iso(Math.max(endedAt, outage.detectedAt)),
    restarts: Math.min(outage.restarts, 1000),
  };
}

/** The delay before the retry that follows the `failedStarts`-th failed start in a row. */
export function retryDelay(failedStarts: number, timing: WatchdogTiming): number {
  return timing.startRetryMs[failedStarts - 1] ?? timing.slowRetryMs;
}

class Builder {
  readonly effects: Effect[] = [];
  outage: OngoingOutage | null;
  private readonly now: number;
  private readonly newOutageId: () => string;

  constructor(outage: OngoingOutage | null, now: number, newOutageId: () => string) {
    this.outage = outage;
    this.now = now;
    this.newOutageId = newOutageId;
  }

  event(name: WatchdogEventName, fields: EventFields = {}): void {
    this.effects.push({ type: "event", name, fields });
  }

  /** Opens an outage unless one is open. `startedAt` is clamped so the record stays ordered. */
  open(cause: OutageCause, startedAt: number): void {
    if (this.outage !== null) return;
    this.outage = {
      outageId: this.newOutageId(),
      cause,
      startedAt: Math.min(startedAt, this.now),
      detectedAt: this.now,
      restarts: 0,
    };
    this.event("outage_started", {
      outageId: this.outage.outageId,
      cause,
      startedAt: iso(this.outage.startedAt),
    });
  }

  countRestart(): void {
    if (this.outage !== null) this.outage = { ...this.outage, restarts: this.outage.restarts + 1 };
  }

  /** Records the outage as it now stands, if one is open. */
  recordOutage(endedAt: number | null = null): void {
    if (this.outage !== null) {
      this.effects.push({ type: "outage", record: outageRecord(this.outage, endedAt) });
    }
  }
}

/**
 * One watchdog decision. Pure: the same state, observation, time and IDs give the same step.
 * `newOutageId` is called only when an outage opens.
 */
export function step(
  state: WatchdogState,
  observation: Observation,
  now: number,
  timing: WatchdogTiming = WATCHDOG_TIMING,
  newOutageId: () => string = () => {
    throw new Error("no outage ID source");
  },
): Step {
  const b = new Builder(state.outage, now, newOutageId);
  switch (observation) {
    case "answering":
      return answering(state, now, timing, b);
    case "silent":
      return silent(state, now, timing, b);
    case "stopped":
      return stopped(state, now, timing, b);
  }
}

function answering(state: WatchdogState, now: number, timing: WatchdogTiming, b: Builder): Step {
  if (state.phase !== "idle" || state.outage !== null) {
    // The breakdown of a replacement's time (DC-47): detection, refused starts, the last start.
    const firstStart = state.startsSince;
    const lastStart = state.phase === "starting" ? state.phaseSince : null;
    b.event("server_ready", {
      failedStarts: state.failedStarts,
      firstStartAt: firstStart === null ? null : iso(firstStart),
      lastStartAt: lastStart === null ? null : iso(lastStart),
      lastStartToReadyMs: lastStart === null ? null : now - lastStart,
      firstStartToReadyMs: firstStart === null ? null : now - firstStart,
      detectedToReadyMs: state.outage === null ? null : now - state.outage.detectedAt,
    });
  }
  if (state.outage !== null) {
    b.recordOutage(now);
    b.event("outage_ended", {
      outageId: state.outage.outageId,
      cause: state.outage.cause,
      durationMs: now - state.outage.startedAt,
      restarts: state.outage.restarts,
    });
  }
  return {
    state: {
      phase: "idle",
      phaseSince: null,
      startDueAt: null,
      failedStarts: 0,
      lastAnsweredAt: now,
      startsSince: null,
      outage: null,
    },
    effects: b.effects,
    nextCheckAt: now + timing.intervalMs,
  };
}

function silent(state: WatchdogState, now: number, timing: WatchdogTiming, b: Builder): Step {
  if (state.phase === "starting") {
    const since = state.phaseSince ?? now;
    if (now - since < timing.readinessWaitMs) {
      return { state, effects: b.effects, nextCheckAt: now + timing.pollMs };
    }
    // Running, but not answering within the readiness wait: a failed start.
    const failedStarts = state.failedStarts + 1;
    b.open("start_failed", state.lastAnsweredAt ?? state.startsSince ?? since);
    b.event("start_not_ready", { waitedMs: now - since, failedStarts });
    b.recordOutage();
    b.effects.push({ type: "destroy", reason: "not ready within the readiness wait" });
    const startDueAt = now + retryDelay(failedStarts, timing);
    return {
      state: {
        ...state,
        phase: "waiting",
        phaseSince: now,
        startDueAt,
        failedStarts,
        outage: b.outage,
      },
      effects: b.effects,
      nextCheckAt: startDueAt,
    };
  }
  if (state.phase === "waiting") {
    // A container runs while a start is due: adopt it and wait for it to answer.
    return {
      state: { ...state, phase: "starting", phaseSince: now, startDueAt: null },
      effects: b.effects,
      nextCheckAt: now + timing.pollMs,
    };
  }
  // Idle and silent: the server stopped answering.
  const opened = state.outage === null;
  b.open("not_answering", state.lastAnsweredAt ?? now);
  if (opened) {
    b.event("not_answering", { lastAnsweredAt: iso(b.outage?.startedAt ?? now) });
    b.recordOutage();
  }
  const silentSince = state.lastAnsweredAt ?? b.outage?.detectedAt ?? now;
  if (now - silentSince >= timing.hungAfterMs) {
    b.event("restart_silent", { silentMs: now - silentSince });
    b.effects.push({ type: "destroy", reason: "not answering" });
    const startDueAt = now + retryDelay(1, timing);
    return {
      state: { ...state, phase: "waiting", phaseSince: now, startDueAt, outage: b.outage },
      effects: b.effects,
      nextCheckAt: startDueAt,
    };
  }
  return {
    state: { ...state, outage: b.outage },
    effects: b.effects,
    nextCheckAt: now + timing.pollMs,
  };
}

function stopped(state: WatchdogState, now: number, timing: WatchdogTiming, b: Builder): Step {
  if (state.phase === "starting") {
    // Started, then stopped before answering: a start Cloudflare refused (DC-37) or a crash.
    const since = state.phaseSince ?? now;
    const failedStarts = state.failedStarts + 1;
    if (state.lastAnsweredAt !== null) b.open("container_stopped", state.lastAnsweredAt);
    else if (now - (state.startsSince ?? since) >= timing.readinessWaitMs) {
      b.open("start_failed", state.startsSince ?? since);
    }
    b.event("start_stopped", { sinceStartMs: now - since, failedStarts });
    if (failedStarts === timing.startRetryMs.length + 1) {
      b.event("start_failing", {
        failedStarts,
        sinceFirstStartMs: now - (state.startsSince ?? since),
      });
    }
    b.recordOutage();
    const startDueAt = now + retryDelay(failedStarts, timing);
    return {
      state: {
        ...state,
        phase: "waiting",
        phaseSince: now,
        startDueAt,
        failedStarts,
        outage: b.outage,
      },
      effects: b.effects,
      nextCheckAt: startDueAt,
    };
  }
  // A due time further ahead than any retry delay (clock skew, a damaged record) counts as due.
  const longest = Math.max(timing.slowRetryMs, ...timing.startRetryMs);
  if (
    state.phase === "waiting" &&
    state.startDueAt !== null &&
    now < state.startDueAt &&
    state.startDueAt - now <= longest
  ) {
    return { state, effects: b.effects, nextCheckAt: state.startDueAt };
  }
  if (state.phase === "idle" && state.lastAnsweredAt !== null) b.event("found_stopped");
  // Start it. An outage opens if the server had answered before, or if it has not answered
  // within the readiness wait since its first start.
  if (state.lastAnsweredAt !== null) b.open("container_stopped", state.lastAnsweredAt);
  else if (state.startsSince !== null && now - state.startsSince >= timing.readinessWaitMs) {
    b.open("start_failed", state.startsSince);
  }
  b.countRestart();
  b.recordOutage();
  b.event("start", { attempt: state.failedStarts + 1, restarts: b.outage?.restarts ?? 0 });
  b.effects.push({ type: "start" });
  return {
    state: {
      ...state,
      phase: "starting",
      phaseSince: now,
      startDueAt: null,
      startsSince: state.startsSince ?? now,
      outage: b.outage,
    },
    effects: b.effects,
    nextCheckAt: now + timing.pollMs,
  };
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new `OutageId`: `out_` and 26 random Crockford base32 characters. */
export function randomOutageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = "out_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}
