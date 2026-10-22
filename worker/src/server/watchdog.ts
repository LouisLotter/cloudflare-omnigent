// The server watchdog's decisions, as a pure function (code-structure plan, principle 3). The
// OmnigentServer Durable Object observes its container, calls `step`, persists the new state and
// the outage records, then carries out the effects.
//
// The design's rules (hybrid-architecture.md, "Scheduling" and "Server restarts"; DC-37, DC-47),
// with the server image's facts (WP2.3, its evidence's "Container environment"):
//   - the server is always on: a container found stopped is started again, and the watchdog
//     itself never stops a server that answers;
//   - after each start it follows the entrypoint's phases (`GET :8001/status`) before it records
//     a failed start (AIR2-010): a boot and restore get the restore allowance from the start
//     (the restore deadline, the database check and Litestream's start); the app's
//     initialization (migrations, its construction, the owner check) gets the app-start budget
//     from its first sight; an app the entrypoint reports running, or a start the entrypoint
//     says nothing about, gets the readiness wait of at least 120 s. Every budget is finite;
//   - a server in the image's recovery mode is never restarted: it needs the owner, and the
//     entrypoint retries a transient cause itself;
//   - a restart stops the container with SIGTERM, so the entrypoint can confirm a final sync,
//     and kills it only after the stop's grace (about twice the final-sync timeout);
//   - an exit with code 78 (a setting missing or malformed) is not restarted until the
//     configuration changes;
//   - an outage record starts when the server was last known to answer, never later, so a notice
//     never understates the interval, and ends when it answers again; it carries the last exit
//     code seen;
//   - a start refused right after a stop (DC-37), or any start that stops before answering, is
//     retried with a bounded backoff, about a minute in all, then every minute.

import type { OutageRecord } from "@cfo/contracts";

export interface WatchdogTiming {
  /** The check cadence while the server answers ("a watchdog callback every few minutes"). */
  readonly intervalMs: number;
  /** The check cadence while it starts, stops, retries or is in an outage. */
  readonly pollMs: number;
  /**
   * How long a start may take to answer when the entrypoint does not say what it is doing (an
   * older image, or its status unreadable), and how long an app the entrypoint reports running
   * may take to answer the watchdog (DC-47: at least 120 s).
   */
  readonly readinessWaitMs: number;
  /**
   * How long a start may take, from `start()`, while the entrypoint reports its boot or a
   * restore: the restore deadline, the database check after it and Litestream's start (WP2.3).
   */
  readonly restoreWaitMs: number;
  /**
   * How long the app may take to answer from the first sight of the entrypoint reporting it
   * `initializing`: Python's imports, Omnigent's migrations, `create_app` and the owner check.
   * Qualified for a 1 GB database on `basic` (WP2.6); finite, so a hung start is restarted.
   */
  readonly appStartWaitMs: number;
  /** How long a running server may stay silent before it is restarted. */
  readonly hungAfterMs: number;
  /** How long a SIGTERM stop may take before the container is killed (WP2.3: final sync). */
  readonly stopGraceMs: number;
  /** Delays before each retry of a failed start, in order (DC-37: about a minute in all). */
  readonly startRetryMs: readonly number[];
  /** The delay between retries once `startRetryMs` is used up. */
  readonly slowRetryMs: number;
}

export const WATCHDOG_TIMING: WatchdogTiming = {
  intervalMs: 60_000,
  pollMs: 5_000,
  readinessWaitMs: 120_000,
  // CFO_RESTORE_DEADLINE_S (300) + the database check (DATABASE_CHECK_ALLOWANCE_S, 120) +
  // CFO_LITESTREAM_READY_TIMEOUT_S (60) + a minute's margin (server-env.ts computes it from the
  // settings the container runs with).
  restoreWaitMs: 540_000,
  appStartWaitMs: 300_000,
  hungAfterMs: 120_000,
  // 2 × CFO_FINAL_SYNC_TIMEOUT_S (300) + a minute's margin.
  stopGraceMs: 660_000,
  startRetryMs: [5_000, 10_000, 20_000, 20_000],
  slowRetryMs: 60_000,
};

/** The server image's exit code for a missing or malformed setting (WP2.3). */
export const EXIT_CONFIG = 78;

export type OutageCause = OutageRecord["cause"];

export interface OngoingOutage {
  readonly outageId: string;
  readonly cause: OutageCause;
  readonly startedAt: number;
  readonly detectedAt: number;
  readonly restarts: number;
  /** The last exit code seen during the outage. */
  readonly exitCode: number | null;
  /** The recovery reason last reported, so it is logged once per change. */
  readonly recovery: string | null;
}

/**
 * - `idle`: no start or stop in progress; the server answered last, has not been started yet,
 *   or is in recovery mode.
 * - `starting`: `start()` was called at `phaseSince`; waiting for the server to answer.
 * - `stopping`: the watchdog sent SIGTERM at `phaseSince`; waiting for the container to stop.
 * - `waiting`: the next `start()` is due at `startDueAt`.
 * - `held`: the server exited with 78; no start until the configuration's fingerprint differs
 *   from `heldConfig`.
 */
export type WatchdogPhase = "idle" | "starting" | "stopping" | "waiting" | "held";

export interface WatchdogState {
  readonly phase: WatchdogPhase;
  /** When the phase began: the last `start()` while `starting`, the SIGTERM while `stopping`. */
  readonly phaseSince: number | null;
  readonly startDueAt: number | null;
  /** Starts in a row that stopped, or never answered, before the server answered. */
  readonly failedStarts: number;
  /** The last time the server answered. Null until it first answers. */
  readonly lastAnsweredAt: number | null;
  /** The first `start()` since the server last answered (or ever): the breakdown's origin. */
  readonly startsSince: number | null;
  /** The configuration fingerprint an exit 78 was seen with, while `held`. */
  readonly heldConfig: string | null;
  /**
   * While `stopping`: when SIGTERM reached the container (or the platform's own stop was first
   * seen). Null while the stop is only intended: the grace counts from delivery, never before.
   */
  readonly signalledAt: number | null;
  /** While `stopping`: when the container was killed after the grace. */
  readonly killedAt: number | null;
  /** While `starting`: the last time the entrypoint reported a boot or a restore. */
  readonly bootSeenAt: number | null;
  /** While `starting`: when the entrypoint was first seen reporting the app `initializing`. */
  readonly initSeenAt: number | null;
  /** While `starting`: when the entrypoint was first seen reporting the app `running`. */
  readonly bootEndedAt: number | null;
  readonly outage: OngoingOutage | null;
}

export const INITIAL_WATCHDOG_STATE: WatchdogState = {
  phase: "idle",
  phaseSince: null,
  startDueAt: null,
  failedStarts: 0,
  lastAnsweredAt: null,
  startsSince: null,
  heldConfig: null,
  signalledAt: null,
  killedAt: null,
  bootSeenAt: null,
  initSeenAt: null,
  bootEndedAt: null,
  outage: null,
};

/**
 * The phases the server image's entrypoint reports on `GET :8001/status` (WP2.3), in order:
 * `starting`, then `restoring` (the restore, the database check and Litestream's start), then
 * `initializing` while the app starts and before it answers its health check (WP2.6; an older
 * image reports `running` from the app's start), then `running`; `recovery` instead of a start;
 * `stopping` and `stopped` at the end.
 */
export type EntrypointPhase =
  | "starting"
  | "restoring"
  | "recovery"
  | "initializing"
  | "running"
  | "stopping"
  | "stopped";

export interface EntrypointReport {
  readonly phase: EntrypointPhase;
  /** In recovery mode: why, and whether the entrypoint retries by itself. */
  readonly recovery: { readonly reason: string; readonly transient: boolean } | null;
}

/**
 * What the Durable Object saw: the container stopped (with its exit code, when the runtime
 * reported one); running and answering its health check; or running and not answering after a
 * retry, with what the entrypoint reports about itself, when it could be read.
 */
export type Observation =
  | { readonly kind: "answering" }
  | {
      readonly kind: "stopped";
      readonly exitCode: number | null;
      /** The configuration fingerprint the exited container was started with, when known. */
      readonly ranWith?: string | null;
    }
  | { readonly kind: "silent"; readonly entrypoint: EntrypointReport | null };

export const ANSWERING: Observation = { kind: "answering" };

export type WatchdogEventName =
  | "found_stopped"
  | "start"
  | "start_phase"
  | "start_stopped"
  | "start_not_ready"
  | "start_failing"
  | "not_answering"
  | "restart_silent"
  | "stop_done"
  | "stop_overdue"
  | "stop_cancelled"
  | "entrypoint_stopping"
  | "recovery_mode"
  | "config_error"
  | "config_changed"
  | "server_ready"
  | "outage_started"
  | "outage_ended";

export type EventFields = Readonly<Record<string, number | string | boolean | null>>;

export type Effect =
  | { readonly type: "start" }
  /** SIGTERM: the entrypoint stops the app, confirms a final sync, then exits. */
  | { readonly type: "stop"; readonly reason: string }
  /** Kill, after a stop's grace ran out. */
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
  // Kept in the contract's order whatever the stored times say, so a record always persists.
  return {
    outageId: outage.outageId,
    cause: outage.cause,
    startedAt: iso(Math.min(outage.startedAt, outage.detectedAt)),
    detectedAt: iso(outage.detectedAt),
    endedAt: endedAt === null ? null : iso(Math.max(endedAt, outage.detectedAt)),
    restarts: Math.min(outage.restarts, 1000),
    exitCode: outage.exitCode,
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
      exitCode: null,
      recovery: null,
    };
    this.event("outage_started", {
      outageId: this.outage.outageId,
      cause,
      startedAt: iso(this.outage.startedAt),
    });
  }

  /** Opens the outage a server that stopped answering is in: from its last answer, if any. */
  openFor(state: WatchdogState, cause: OutageCause, fallback: number): void {
    this.open(cause, state.lastAnsweredAt ?? state.startsSince ?? fallback);
  }

  update(fields: Partial<Pick<OngoingOutage, "cause" | "exitCode" | "recovery">>): void {
    if (this.outage !== null) this.outage = { ...this.outage, ...fields };
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

  done(state: WatchdogState, nextCheckAt: number, fields: Partial<WatchdogState> = {}): Step {
    return {
      state: { ...state, ...fields, outage: this.outage },
      effects: this.effects,
      nextCheckAt,
    };
  }
}

/**
 * One watchdog decision. Pure: the same state, observation, time, IDs and configuration give
 * the same step. `newOutageId` is called only when an outage opens. `config` is a fingerprint of
 * the server container's configuration, compared only while `held`.
 */
export function step(
  state: WatchdogState,
  observation: Observation,
  now: number,
  timing: WatchdogTiming = WATCHDOG_TIMING,
  newOutageId: () => string = () => {
    throw new Error("no outage ID source");
  },
  config = "",
): Step {
  const b = new Builder(state.outage, now, newOutageId);
  if (state.phase === "stopping") return stopping(state, observation, now, timing, b, config);
  switch (observation.kind) {
    case "answering":
      return answering(state, now, timing, b);
    case "silent":
      return silent(state, observation.entrypoint, now, timing, b);
    case "stopped":
      return stopped(state, observation.exitCode, now, timing, b, config, observation.ranWith);
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
      exitCode: state.outage.exitCode,
    });
  }
  b.outage = null;
  return b.done(INITIAL_WATCHDOG_STATE, now + timing.intervalMs, { lastAnsweredAt: now });
}

/**
 * The watchdog is stopping the server. The phase lasts until the container is seen stopped, so
 * no request is passed on meanwhile, the kill after the grace included.
 * - Intended but not yet delivered (`signalledAt` null: the instance was reset, or the signal
 *   failed): a server that answers, or is in recovery mode, is left running; otherwise SIGTERM
 *   is sent again.
 * - Delivered: wait for the final sync; past the grace, counted from delivery, kill it.
 */
function stopping(
  state: WatchdogState,
  observation: Observation,
  now: number,
  timing: WatchdogTiming,
  b: Builder,
  config: string,
): Step {
  const since = state.phaseSince ?? now;
  if (observation.kind === "stopped") {
    b.event("stop_done", { stopMs: now - since, exitCode: observation.exitCode });
    // Then as any stopped server: a restart after DC-37's first delay, unless it exited 78.
    const waiting: WatchdogState = {
      ...state,
      phase: "waiting",
      phaseSince: now,
      startDueAt: now + retryDelay(1, timing),
      signalledAt: null,
      killedAt: null,
    };
    if (observation.exitCode === EXIT_CONFIG) {
      return stopped(waiting, observation.exitCode, now, timing, b, config, observation.ranWith);
    }
    b.update({ exitCode: observation.exitCode ?? b.outage?.exitCode ?? null });
    b.recordOutage();
    return b.done(waiting, waiting.startDueAt ?? now);
  }
  const cleared: Partial<WatchdogState> = {
    phase: "idle",
    phaseSince: null,
    signalledAt: null,
    killedAt: null,
  };
  if (state.signalledAt === null) {
    if (observation.kind === "answering" || observation.entrypoint?.phase === "recovery") {
      // The stop never reached it, and it no longer needs one.
      b.event("stop_cancelled", { intendedMs: now - since });
      const resumed = { ...state, ...cleared };
      return observation.kind === "answering"
        ? answering(resumed, now, timing, b)
        : silent(resumed, observation.entrypoint, now, timing, b);
    }
    b.effects.push({ type: "stop", reason: "the stop was not delivered" });
    return b.done(state, now + timing.pollMs);
  }
  const delivered = state.signalledAt;
  if (now - delivered < timing.stopGraceMs) return b.done(state, now + timing.pollMs);
  // The stop outran its grace: kill it, and stay stopping until it is seen stopped.
  if (state.killedAt === null) b.event("stop_overdue", { stopMs: now - delivered });
  b.effects.push({ type: "destroy", reason: "the stop outran its grace" });
  return b.done(state, now + timing.pollMs, { killedAt: state.killedAt ?? now });
}

/** Starts a graceful restart: SIGTERM now, the start once the container stopped. */
function stopForRestart(
  state: WatchdogState,
  now: number,
  timing: WatchdogTiming,
  b: Builder,
  reason: string,
  failedStarts: number,
): Step {
  b.recordOutage();
  b.effects.push({ type: "stop", reason });
  // Delivery is recorded by the caller once the signal is sent (`signalled`).
  return b.done(state, now + timing.pollMs, {
    phase: "stopping",
    phaseSince: now,
    startDueAt: null,
    signalledAt: null,
    killedAt: null,
    failedStarts,
  });
}

function silent(
  state: WatchdogState,
  entrypoint: EntrypointReport | null,
  now: number,
  timing: WatchdogTiming,
  b: Builder,
): Step {
  const phase = entrypoint?.phase ?? null;

  if (phase === "recovery") {
    // Recovery mode: the database could not be restored safely. Never restarted: the owner
    // acts, or the entrypoint retries a transient cause itself.
    const reason = entrypoint?.recovery?.reason ?? "unknown";
    b.openFor(state, "recovery_mode", now);
    if (b.outage?.recovery !== reason) {
      b.event("recovery_mode", { reason, transient: entrypoint?.recovery?.transient ?? null });
    }
    b.update({ cause: "recovery_mode", recovery: reason });
    b.recordOutage();
    return b.done(state, now + timing.intervalMs, {
      phase: "idle",
      phaseSince: null,
      startDueAt: null,
      failedStarts: 0,
    });
  }

  if (phase === "stopping" || phase === "stopped") {
    // The entrypoint is going down: a platform stop or rollout sent SIGTERM. Never killed early:
    // it may be confirming a final sync. Wait as for a stop of our own.
    b.event("entrypoint_stopping", { phase });
    b.openFor(state, "container_stopped", now);
    b.recordOutage();
    // The platform signalled it: the grace counts from now.
    return b.done(state, now + timing.pollMs, {
      phase: "stopping",
      phaseSince: now,
      startDueAt: null,
      signalledAt: now,
      killedAt: null,
    });
  }

  const booting = phase === "starting" || phase === "restoring";
  const initializing = phase === "initializing";
  if (state.phase === "starting") {
    const since = state.phaseSince ?? now;
    const restoreAllowance = Math.max(timing.readinessWaitMs, timing.restoreWaitMs);
    // Each phase's first sight is logged once, so a start's progress shows in the logs.
    const progress = (seenBefore: number | null) => {
      if (seenBefore === null) b.event("start_phase", { phase, sinceStartMs: now - since });
    };
    let budget: "restore" | "app_start" | "readiness";
    if (booting) {
      // A boot and a restore may take the restore allowance, counted from the start.
      progress(state.bootSeenAt);
      budget = "restore";
      if (now - since < restoreAllowance) {
        return b.done(state, now + timing.pollMs, {
          bootSeenAt: now,
          initSeenAt: null,
          bootEndedAt: null,
        });
      }
    } else if (
      initializing ||
      (phase === null && state.initSeenAt !== null && state.bootEndedAt === null)
    ) {
      // The app is initializing: Python's imports, Omnigent's migrations, `create_app` and the
      // owner check. It gets the app-start budget from its first sight, also while its status
      // is unknown (AIR2-010).
      if (initializing) progress(state.initSeenAt);
      const initSeenAt = state.initSeenAt ?? now;
      budget = "app_start";
      if (now - initSeenAt < timing.appStartWaitMs) {
        return b.done(state, now + timing.pollMs, { initSeenAt });
      }
    } else if (phase === null && state.bootSeenAt !== null && state.bootEndedAt === null) {
      // Seen restoring, now unknown: keep the restore's allowance (Codex WP2.2 r4-3).
      budget = "restore";
      if (now - since < restoreAllowance) return b.done(state, now + timing.pollMs);
    } else {
      // The app is `running` (it answered the entrypoint's health check; an older image says so
      // from the app's start), or nothing was seen since the start. The readiness wait counts
      // from the first sight of `running` once the entrypoint was seen before it (Codex WP2.2
      // r3-4, r4-3), otherwise from the start.
      if (phase === "running") progress(state.bootEndedAt);
      const bootEndedAt = phase === "running" ? (state.bootEndedAt ?? now) : state.bootEndedAt;
      const seenBefore = state.bootSeenAt !== null || state.initSeenAt !== null;
      budget = "readiness";
      if (
        now - (seenBefore && bootEndedAt !== null ? bootEndedAt : since) <
        timing.readinessWaitMs
      ) {
        return b.done(state, now + timing.pollMs, { bootEndedAt });
      }
    }
    // Not answering within its budget: a failed start.
    const failedStarts = state.failedStarts + 1;
    b.openFor(state, "start_failed", since);
    b.event("start_not_ready", {
      waitedMs: now - since,
      failedStarts,
      entrypoint: phase,
      budget,
    });
    return stopForRestart(
      state,
      now,
      timing,
      b,
      `not ready within the ${budget} budget`,
      failedStarts,
    );
  }

  if (state.phase === "waiting" || state.phase === "held" || booting || initializing) {
    // A container runs that the watchdog did not just start (one it was waiting to start, or a
    // platform restart now booting or initializing): adopt it and wait for it to answer, with
    // the budgets of a start from now.
    if (state.lastAnsweredAt !== null) {
      b.openFor(state, "container_stopped", now);
      b.recordOutage();
    }
    return b.done(state, now + timing.pollMs, {
      phase: "starting",
      phaseSince: now,
      startDueAt: null,
      startsSince: state.startsSince ?? now,
      bootSeenAt: booting ? now : null,
      initSeenAt: initializing ? now : null,
      bootEndedAt: null,
    });
  }

  // Idle and silent while the app runs (or the entrypoint cannot say): it stopped answering.
  const opened = state.outage === null;
  b.openFor(state, "not_answering", now);
  if (opened) {
    b.event("not_answering", { lastAnsweredAt: iso(b.outage?.startedAt ?? now) });
    b.recordOutage();
  }
  const silentSince = state.lastAnsweredAt ?? b.outage?.detectedAt ?? now;
  // A server last seen in recovery mode is not restarted because its status could not be read.
  const inRecovery = b.outage?.cause === "recovery_mode";
  if (now - silentSince >= timing.hungAfterMs && !inRecovery) {
    b.event("restart_silent", { silentMs: now - silentSince });
    return stopForRestart(state, now, timing, b, "not answering", state.failedStarts);
  }
  return b.done(state, now + timing.pollMs);
}

function stopped(
  state: WatchdogState,
  exitCode: number | null,
  now: number,
  timing: WatchdogTiming,
  b: Builder,
  config: string,
  ranWith: string | null = null,
): Step {
  if (exitCode !== null) b.update({ exitCode });

  if (state.phase === "held") {
    if (config === state.heldConfig) {
      b.recordOutage();
      return b.done(state, now + timing.intervalMs);
    }
    b.event("config_changed");
    return start(
      { ...state, phase: "idle", heldConfig: null, failedStarts: 0 },
      now,
      timing,
      b,
      null,
    );
  }

  if (exitCode === EXIT_CONFIG) {
    // A setting is missing or malformed: restarting cannot help until the configuration
    // changes. The hold belongs to the configuration the container ran with; when that is
    // already not the current one, the corrected configuration is started (Codex WP2.2 r4-2).
    b.openFor(state, state.lastAnsweredAt === null ? "start_failed" : "container_stopped", now);
    b.update({ exitCode });
    b.event("config_error", { exitCode });
    const held = ranWith ?? config;
    if (held !== config) {
      b.event("config_changed");
      return start({ ...state, heldConfig: null }, now, timing, b, exitCode);
    }
    b.recordOutage();
    return b.done(state, now + timing.intervalMs, {
      phase: "held",
      phaseSince: now,
      startDueAt: null,
      heldConfig: held,
    });
  }

  if (state.phase === "starting") {
    // Started, then stopped before answering: a start Cloudflare refused (DC-37) or a crash.
    const since = state.phaseSince ?? now;
    const failedStarts = state.failedStarts + 1;
    if (state.lastAnsweredAt !== null) b.open("container_stopped", state.lastAnsweredAt);
    else if (now - (state.startsSince ?? since) >= timing.readinessWaitMs) {
      b.open("start_failed", state.startsSince ?? since);
    }
    b.update(exitCode === null ? {} : { exitCode });
    b.event("start_stopped", { sinceStartMs: now - since, failedStarts, exitCode });
    if (failedStarts === timing.startRetryMs.length + 1) {
      b.event("start_failing", {
        failedStarts,
        sinceFirstStartMs: now - (state.startsSince ?? since),
      });
    }
    b.recordOutage();
    const startDueAt = now + retryDelay(failedStarts, timing);
    return b.done(state, startDueAt, {
      phase: "waiting",
      phaseSince: now,
      startDueAt,
      failedStarts,
    });
  }
  // A due time further ahead than any retry delay (clock skew, a damaged record) counts as due.
  const longest = Math.max(timing.slowRetryMs, ...timing.startRetryMs);
  if (
    state.phase === "waiting" &&
    state.startDueAt !== null &&
    now < state.startDueAt &&
    state.startDueAt - now <= longest
  ) {
    b.recordOutage();
    return b.done(state, state.startDueAt);
  }
  if (state.phase === "idle" && state.lastAnsweredAt !== null)
    b.event("found_stopped", { exitCode });
  return start(state, now, timing, b, exitCode);
}

/** Starts the server. An outage opens if it had answered before, or has not within the wait. */
function start(
  state: WatchdogState,
  now: number,
  timing: WatchdogTiming,
  b: Builder,
  exitCode: number | null,
): Step {
  if (state.lastAnsweredAt !== null) b.open("container_stopped", state.lastAnsweredAt);
  else if (state.startsSince !== null && now - state.startsSince >= timing.readinessWaitMs) {
    b.open("start_failed", state.startsSince);
  }
  if (exitCode !== null) b.update({ exitCode });
  b.countRestart();
  b.recordOutage();
  b.event("start", { attempt: state.failedStarts + 1, restarts: b.outage?.restarts ?? 0 });
  b.effects.push({ type: "start" });
  return b.done(state, now + timing.pollMs, {
    phase: "starting",
    phaseSince: now,
    startDueAt: null,
    startsSince: state.startsSince ?? now,
    signalledAt: null,
    killedAt: null,
    bootSeenAt: null,
    initSeenAt: null,
    bootEndedAt: null,
  });
}

/**
 * The state once SIGTERM reached the container: the grace counts from now. A no-op unless the
 * watchdog is stopping the server and has not delivered the signal yet.
 */
export function signalled(state: WatchdogState, now: number): WatchdogState {
  return state.phase === "stopping" && state.signalledAt === null
    ? { ...state, signalledAt: now }
    : state;
}

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new `OutageId`: `out_` and 26 random Crockford base32 characters. */
export function randomOutageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = "out_";
  for (const byte of bytes) id += BASE32[byte % 32];
  return id;
}
