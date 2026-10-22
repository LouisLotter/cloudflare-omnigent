import { OutageId, OutageRecord } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANSWERING,
  type Effect,
  type EntrypointPhase,
  EXIT_CONFIG,
  INITIAL_WATCHDOG_STATE,
  type Observation,
  randomOutageId,
  retryDelay,
  type Step,
  signalled,
  step,
  WATCHDOG_TIMING as T,
  type WatchdogState,
} from "../../src/server/watchdog.ts";
import { defined, gaps } from "../support/defined.ts";

const T0 = Date.parse("2026-10-22T03:00:00.000Z");
let ids = 0;
const nextId = () => `out_${String(++ids).padStart(26, "0")}`;

const STOPPED: Observation = { kind: "stopped", exitCode: null };
const exited = (exitCode: number): Observation => ({ kind: "stopped", exitCode });
const SILENT: Observation = { kind: "silent", entrypoint: null };
const entrypoint = (phase: EntrypointPhase, transient = false): Observation => ({
  kind: "silent",
  entrypoint: {
    phase,
    recovery: phase === "recovery" ? { reason: "replica_empty", transient } : null,
  },
});

const types = (s: Step) => s.effects.map((e) => e.type);
/** What the step does, besides logging: starts, stops, kills and outage records. */
const actions = (s: Step) => types(s).filter((t) => t !== "event");
const events = (s: Step) =>
  s.effects.flatMap((e) => (e.type === "event" ? [e.name] : [])) as string[];
const outages = (s: Step) =>
  s.effects.flatMap((e) => (e.type === "outage" ? [e.record] : [])) as OutageRecord[];

/** Runs observations in order, each at its time; returns every step. */
function run(
  start: WatchdogState,
  seq: readonly [number, Observation][],
  config = "config-a",
): Step[] {
  const steps: Step[] = [];
  let state = start;
  for (const [at, obs] of seq) {
    const s = step(state, obs, at, T, nextId, config);
    steps.push(s);
    state = s.state;
  }
  return steps;
}

const answered = (at: number): WatchdogState => ({ ...INITIAL_WATCHDOG_STATE, lastAnsweredAt: at });

describe("watchdog: first start", () => {
  it("starts a server that was never started, without recording an outage", () => {
    const s = step(INITIAL_WATCHDOG_STATE, STOPPED, T0, T, nextId);
    expect(types(s)).toEqual(["event", "start"]);
    expect(s.state).toMatchObject({
      phase: "starting",
      phaseSince: T0,
      startsSince: T0,
      outage: null,
    });
    expect(s.nextCheckAt).toBe(T0 + T.pollMs);
  });

  it("dates a failed first start from the first start, through refused retries", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED], // first start
      [T0 + 5_000, STOPPED], // refused: retry due in 5 s
      [T0 + 10_000, STOPPED], // second start
      [T0 + 10_000 + T.readinessWaitMs, SILENT], // never ready
    ]);
    const record = outages(defined(steps[3]))[0];
    expect(record).toMatchObject({ cause: "start_failed", startedAt: new Date(T0).toISOString() });
  });

  it("waits the full readiness wait for a first start, then stops it to start again", () => {
    const [, waiting, failed] = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + T.readinessWaitMs - 1, SILENT],
      [T0 + T.readinessWaitMs, SILENT],
    ]);
    expect(waiting?.effects).toEqual([]);
    expect(failed && types(failed)).toEqual(["event", "event", "outage", "stop"]);
    expect(failed && events(failed)).toEqual(["outage_started", "start_not_ready"]);
    expect(failed && outages(failed)[0]).toMatchObject({
      cause: "start_failed",
      startedAt: new Date(T0).toISOString(),
      endedAt: null,
    });
    expect(failed?.state).toMatchObject({ phase: "stopping", failedStarts: 1 });
    expect(failed?.nextCheckAt).toBe(T0 + T.readinessWaitMs + T.pollMs);
  });

  it("counts the app's readiness from its first sight past the boot, and keeps the restore's allowance while unknown (Codex r4-3)", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 180_000, entrypoint("restoring")],
      [T0 + 240_000, SILENT], // unknown: still within the restore's allowance
      [T0 + 300_000, entrypoint("running")], // first seen past the boot
      [T0 + 300_000 + T.readinessWaitMs - 1, entrypoint("running")],
      [T0 + 300_000 + T.readinessWaitMs, entrypoint("running")],
    ]);
    for (const s of steps.slice(1, 5)) expect(actions(s)).toEqual([]);
    expect(defined(steps[3]).state.bootEndedAt).toBe(T0 + 300_000);
    expect(types(defined(steps[5]))).toContain("stop");
    // Unknown after a restore, with no sight past it: the restore's allowance, then a stop.
    const unknown = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 60_000, entrypoint("restoring")],
      [T0 + T.restoreWaitMs - 1, SILENT],
      [T0 + T.restoreWaitMs, SILENT],
    ]);
    expect(actions(defined(unknown[2]))).toEqual([]);
    expect(types(defined(unknown[3]))).toContain("stop");
  });

  it("gives the app a full readiness wait after a long restore (Codex r3-4)", () => {
    const restoredAt = T0 + 180_000;
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [restoredAt, entrypoint("restoring")],
      [restoredAt + 5_000, entrypoint("running")], // the app is starting
      [restoredAt + 5_000 + T.readinessWaitMs - 1, SILENT],
      [restoredAt + 5_000 + T.readinessWaitMs, entrypoint("running")],
    ]);
    for (const s of steps.slice(1, 4)) expect(actions(s)).toEqual([]);
    expect(types(defined(steps[4]))).toContain("stop");
  });

  it("waits out a restore the entrypoint reports, then counts the start failed (WP2.3)", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + T.readinessWaitMs + 1, entrypoint("restoring")],
      [T0 + T.restoreWaitMs - 1, entrypoint("restoring")],
      [T0 + T.restoreWaitMs, entrypoint("restoring")],
    ]);
    expect(actions(defined(steps[1]))).toEqual([]);
    expect(types(defined(steps[2]))).toEqual([]);
    expect(types(defined(steps[3]))).toContain("stop");
    expect(T.restoreWaitMs).toBeGreaterThan(T.readinessWaitMs);
  });
});

describe("watchdog: the app's initialization has its own budget (AIR2-010)", () => {
  const initializing = entrypoint("initializing");
  const restoring = entrypoint("restoring");
  const running = entrypoint("running");
  const stops = (steps: Step[]) => steps.filter((s) => types(s).includes("stop"));

  it("never stops a large-database start while the app initializes within its budget (Codex's startup probe)", () => {
    // Codex pass 13's probe: restore seen at 5 and 85 s, the app past the restore at 90 s, no
    // health answer through 210 s. The entrypoint now says `initializing` until the app answers.
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 5_000, restoring],
      [T0 + 85_000, restoring],
      [T0 + 90_000, initializing],
      [T0 + 205_000, initializing],
      [T0 + 210_000, initializing],
      [T0 + 90_000 + T.appStartWaitMs - 1, initializing],
    ]);
    expect(stops(steps)).toEqual([]);
    expect(steps.flatMap(events).filter((e) => e === "start_phase")).toHaveLength(2);
    // An older image says `running` from the app's start: only the readiness wait (unchanged).
    const older = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 5_000, restoring],
      [T0 + 85_000, restoring],
      [T0 + 90_000, running],
      [T0 + 210_000, running],
    ]);
    expect(types(defined(older[4]))).toContain("stop");
  });

  it("takes WP2.5's 1 GB start on basic once the image's start is cut, and not the uncut one", () => {
    // WP2.5's run 2 on basic: the restore and the entrypoint's check end at 167 s, the app is
    // past it from 168 s. With the image's fixes its start is the imports, migrations and
    // create_app without the second check and the compile (about 100 s there); before them it
    // took 377 s more and answered at 554 s.
    const timeline = (answersAt: number): [number, Observation][] => {
      const seq: [number, Observation][] = [[T0, STOPPED]];
      for (let at = T0 + 5_000; at <= T0 + 600_000; at += T.pollMs) {
        if (at >= answersAt) {
          seq.push([at, ANSWERING]);
          break;
        }
        seq.push([at, at < T0 + 167_000 ? restoring : initializing]);
      }
      return seq;
    };
    const fixed = run(INITIAL_WATCHDOG_STATE, timeline(T0 + 290_000));
    expect(stops(fixed)).toEqual([]);
    const ready = defined(fixed.at(-1)).effects.find(
      (e): e is Extract<Effect, { type: "event" }> =>
        e.type === "event" && e.name === "server_ready",
    );
    expect(ready?.fields).toMatchObject({ failedStarts: 0, lastStartToReadyMs: 290_000 });
    const phases = fixed.flatMap((s) =>
      s.effects.flatMap((e) => (e.type === "event" && e.name === "start_phase" ? [e.fields] : [])),
    );
    expect(phases).toEqual([
      { phase: "restoring", sinceStartMs: 5_000 },
      { phase: "initializing", sinceStartMs: 170_000 },
    ]);
    // The uncut start (answering at 554 s) runs out of the app-start budget at 170 + 300 s.
    const uncut = run(INITIAL_WATCHDOG_STATE, timeline(T0 + 554_000));
    const [stop] = stops(uncut);
    expect(stop?.effects).toContainEqual(
      expect.objectContaining({
        type: "event",
        name: "start_not_ready",
        fields: expect.objectContaining({ budget: "app_start", waitedMs: 470_000 }),
      }),
    );
  });

  it("restarts a hung initialization once its budget is used up, and counts the failed start", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 30_000, restoring],
      [T0 + 60_000, initializing], // first sight: the budget counts from here
      [T0 + 60_000 + T.appStartWaitMs - 1, initializing],
      [T0 + 60_000 + T.appStartWaitMs, initializing],
    ]);
    expect(actions(defined(steps[3]))).toEqual([]);
    const failed = defined(steps[4]);
    expect(types(failed)).toContain("stop");
    expect(failed.state).toMatchObject({ phase: "stopping", failedStarts: 1 });
    expect(outages(failed)[0]).toMatchObject({ cause: "start_failed" });
    // The restart follows the stop, after DC-37's first delay.
    const sent = signalled(failed.state, T0 + 60_000 + T.appStartWaitMs);
    const stopped = step(sent, exited(0), T0 + 400_000, T, nextId);
    expect(stopped.state.phase).toBe("waiting");
    expect(types(step(stopped.state, STOPPED, stopped.nextCheckAt, T, nextId))).toContain("start");
  });

  it("keeps the app-start budget while the status is unreadable, neither shorter nor longer", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 20_000, initializing],
      [T0 + 20_000 + T.readinessWaitMs + 1, SILENT], // past the readiness wait: still waits
      [T0 + 20_000 + T.appStartWaitMs - 1, SILENT],
      [T0 + 20_000 + T.appStartWaitMs, SILENT],
    ]);
    expect(actions(defined(steps[2]))).toEqual([]);
    expect(actions(defined(steps[3]))).toEqual([]);
    expect(types(defined(steps[4]))).toContain("stop");
  });

  it("gives an app the entrypoint reports running the readiness wait from that sight", () => {
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 20_000, initializing],
      [T0 + 250_000, running], // it answered the entrypoint, not yet the watchdog
      [T0 + 250_000 + T.readinessWaitMs - 1, SILENT],
      [T0 + 250_000 + T.readinessWaitMs, running],
    ]);
    expect(actions(defined(steps[3]))).toEqual([]);
    const failed = defined(steps[4]);
    expect(types(failed)).toContain("stop");
    expect(failed.effects).toContainEqual(
      expect.objectContaining({
        name: "start_not_ready",
        fields: expect.objectContaining({ budget: "readiness" }),
      }),
    );
  });

  it("adopts a container it finds initializing, with the app-start budget from then", () => {
    const found = step(answered(T0), initializing, T0 + 60_000, T, nextId);
    expect(found.state).toMatchObject({
      phase: "starting",
      phaseSince: T0 + 60_000,
      initSeenAt: T0 + 60_000,
    });
    expect(outages(found)[0]).toMatchObject({ cause: "container_stopped" });
    const later = step(found.state, initializing, T0 + 60_000 + T.appStartWaitMs - 1, T, nextId);
    expect(actions(later)).toEqual([]);
    expect(
      types(step(later.state, initializing, T0 + 60_000 + T.appStartWaitMs, T, nextId)),
    ).toContain("stop");
  });

  it("never stops a start whose phases each end within their budget, however its status reads", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: T.restoreWaitMs - 3 * T.pollMs }),
        fc.integer({ min: 0, max: T.appStartWaitMs - 3 * T.pollMs }),
        fc.integer({ min: 0, max: T.readinessWaitMs - 3 * T.pollMs }),
        fc.array(fc.boolean(), { minLength: 400, maxLength: 400 }),
        (restoreMs, appMs, runningMs, readable) => {
          let state = step(INITIAL_WATCHDOG_STATE, STOPPED, T0, T, nextId).state;
          let lastUnreadable = false;
          for (let k = 1; k < 400; k += 1) {
            const at = T0 + k * T.pollMs;
            const t = at - T0;
            let obs: Observation;
            if (t >= restoreMs + appMs + runningMs) obs = ANSWERING;
            else if (k > 1 && !lastUnreadable && !readable[k])
              obs = SILENT; // never twice in a row
            else if (t < restoreMs) obs = restoring;
            else if (t < restoreMs + appMs) obs = initializing;
            else obs = running;
            lastUnreadable = obs === SILENT;
            const s = step(state, obs, at, T, nextId);
            if (types(s).includes("stop")) return false;
            state = s.state;
            if (obs.kind === "answering") return state.phase === "idle";
          }
          return false;
        },
      ),
      { numRuns: 500 },
    );
  });

  it("always stops an initialization that never ends, within a poll of its budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: T.restoreWaitMs - 3 * T.pollMs }),
        fc.boolean(),
        (restoreMs, unreadableAfter) => {
          let state = step(INITIAL_WATCHDOG_STATE, STOPPED, T0, T, nextId).state;
          let firstInit: number | null = null;
          for (let k = 1; k < 1000; k += 1) {
            const at = T0 + k * T.pollMs;
            const inRestore = at - T0 < restoreMs;
            if (!inRestore && firstInit === null) firstInit = at;
            const obs = inRestore
              ? restoring
              : unreadableAfter && firstInit !== null && at > firstInit
                ? SILENT
                : initializing;
            const s = step(state, obs, at, T, nextId);
            if (types(s).includes("stop")) {
              return (
                firstInit !== null &&
                at - firstInit >= T.appStartWaitMs &&
                at - firstInit < T.appStartWaitMs + T.pollMs
              );
            }
            state = s.state;
          }
          return false;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("watchdog: a healthy server", () => {
  it("records nothing and checks again after the interval", () => {
    const s = step(answered(T0), ANSWERING, T0 + 60_000, T, nextId);
    expect(s.effects).toEqual([]);
    expect(s.state.lastAnsweredAt).toBe(T0 + 60_000);
    expect(s.nextCheckAt).toBe(T0 + 60_000 + T.intervalMs);
  });

  it("never stops or restarts a server that answers", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (offset) => {
        const s = step(answered(T0), ANSWERING, T0 + offset, T, nextId);
        return types(s).every((t) => !["stop", "destroy", "start"].includes(t));
      }),
    );
  });
});

describe("watchdog: found stopped (maintenance or a deploy's rollout)", () => {
  it("opens an outage from the last answer, restarts, and closes it when the server answers", () => {
    const steps = run(answered(T0), [
      [T0 + 50_000, exited(0)],
      [T0 + 55_000, SILENT],
      [T0 + 70_000, ANSWERING],
    ]);
    const [found, booting, ready] = steps;
    expect(found && events(found)).toEqual(["found_stopped", "outage_started", "start"]);
    expect(found && outages(found)[0]).toMatchObject({
      cause: "container_stopped",
      startedAt: new Date(T0).toISOString(),
      detectedAt: new Date(T0 + 50_000).toISOString(),
      endedAt: null,
      restarts: 1,
      exitCode: 0,
    });
    expect(booting?.effects).toEqual([]);
    expect(ready && events(ready)).toEqual(["server_ready", "outage_ended"]);
    const ended = ready && outages(ready)[0];
    expect(ended).toMatchObject({ endedAt: new Date(T0 + 70_000).toISOString(), restarts: 1 });
    expect(OutageRecord.safeParse(ended).success).toBe(true);
    expect(ready?.state.outage).toBeNull();
  });

  it("keeps the last exit code on the record: an unconfirmed final sync (75) shows", () => {
    const steps = run(answered(T0), [
      [T0 + 10_000, exited(75)],
      [T0 + 15_000, exited(71)], // the restart's app exited
      [T0 + 20_000, STOPPED], // retry due, no code reported
    ]);
    expect(outages(defined(steps[0]))[0]?.exitCode).toBe(75);
    expect(outages(defined(steps[1]))[0]?.exitCode).toBe(71);
    expect(outages(defined(steps[2]))[0]?.exitCode).toBe(71);
  });

  it("reports where a replacement's time went (DC-47)", () => {
    const steps = run(answered(T0), [
      [T0 + 10_000, STOPPED],
      [T0 + 15_000, STOPPED], // refused (DC-37)
      [T0 + 20_000, STOPPED], // retry due
      [T0 + 32_000, ANSWERING],
    ]);
    const ready = defined(steps[3]).effects.find(
      (e): e is Extract<Effect, { type: "event" }> =>
        e.type === "event" && e.name === "server_ready",
    );
    expect(ready?.fields).toMatchObject({
      failedStarts: 1,
      firstStartToReadyMs: 22_000,
      lastStartToReadyMs: 12_000,
      detectedToReadyMs: 22_000,
    });
  });
});

describe("watchdog: a start refused right after a stop (DC-37)", () => {
  it("retries with the bounded backoff, never early, then every minute, and never gives up", () => {
    let state = step(answered(T0), STOPPED, T0, T, nextId).state;
    let now = T0;
    const startTimes: number[] = [T0];
    for (let failure = 1; failure <= 7; failure += 1) {
      now += T.pollMs;
      const refused = step(state, STOPPED, now, T, nextId);
      expect(events(refused)).toContain("start_stopped");
      expect(refused.state.failedStarts).toBe(failure);
      const due = now + retryDelay(failure, T);
      expect(refused.nextCheckAt).toBe(due);
      // A check before the retry is due starts nothing.
      const early = step(refused.state, STOPPED, due - 1, T, nextId);
      expect(types(early)).not.toContain("start");
      expect(early.nextCheckAt).toBe(due);
      const retry = step(refused.state, STOPPED, due, T, nextId);
      expect(types(retry)).toContain("start");
      startTimes.push(due);
      state = retry.state;
      now = due;
    }
    expect(gaps(startTimes)).toEqual([10_000, 15_000, 25_000, 25_000, 65_000, 65_000, 65_000]);
    expect(state.outage?.restarts).toBe(8);
  });

  it("says once that starts keep failing, after the backoff is used up", () => {
    let state = step(answered(T0), STOPPED, T0, T, nextId).state;
    const said: number[] = [];
    let now = T0;
    for (let failure = 1; failure <= 8; failure += 1) {
      now += T.pollMs;
      const refused = step(state, STOPPED, now, T, nextId);
      if (events(refused).includes("start_failing")) said.push(failure);
      now = refused.nextCheckAt;
      state = step(refused.state, STOPPED, now, T, nextId).state;
    }
    expect(said).toEqual([T.startRetryMs.length + 1]);
  });
});

describe("watchdog: restarts stop gracefully (WP2.3's final sync)", () => {
  it("stops a silent server with SIGTERM after the wait, starts it once it stopped", () => {
    const steps = run(answered(T0), [
      [T0 + 60_000, SILENT],
      [T0 + 100_000, SILENT],
      [T0 + T.hungAfterMs, SILENT],
    ]);
    const [opened, waiting, restarting] = steps.map((s) => defined(s));
    expect(events(defined(opened))).toEqual(["outage_started", "not_answering"]);
    expect(outages(defined(opened))[0]).toMatchObject({
      cause: "not_answering",
      startedAt: new Date(T0).toISOString(),
    });
    expect(types(defined(waiting))).toEqual([]);
    const hung = defined(restarting);
    expect(types(hung)).toEqual(["event", "outage", "stop"]);
    expect(hung.state).toMatchObject({
      phase: "stopping",
      phaseSince: T0 + T.hungAfterMs,
      signalledAt: null,
    });
    // The Durable Object records the delivery; the grace counts from it.
    const sent = signalled(hung.state, T0 + T.hungAfterMs);
    expect(sent.signalledAt).toBe(T0 + T.hungAfterMs);
    // Still running while it confirms its final sync: no start, no kill.
    const syncing = step(sent, SILENT, T0 + T.hungAfterMs + 30_000, T, nextId);
    expect(types(syncing)).toEqual([]);
    const done = step(syncing.state, exited(0), T0 + T.hungAfterMs + 60_000, T, nextId);
    expect(events(done)).toEqual(["stop_done"]);
    expect(done.state.phase).toBe("waiting");
    const restart = step(done.state, STOPPED, done.nextCheckAt, T, nextId);
    expect(types(restart)).toContain("start");
    expect(restart.state.outage).toMatchObject({
      cause: "not_answering",
      restarts: 1,
      exitCode: 0,
    });
  });

  it("kills a stop only once it outruns its grace from delivery, and stays stopping until it stopped", () => {
    const stopping: WatchdogState = {
      ...answered(T0),
      phase: "stopping",
      phaseSince: T0 - 600_000, // intended long before: the grace counts from delivery
      signalledAt: T0,
    };
    expect(types(step(stopping, ANSWERING, T0 + T.stopGraceMs - 1, T, nextId))).toEqual([]);
    const overdue = step(stopping, SILENT, T0 + T.stopGraceMs, T, nextId);
    expect(types(overdue)).toEqual(["event", "destroy"]);
    // Still stopping: no request is passed on until the container is seen stopped.
    expect(overdue.state).toMatchObject({ phase: "stopping", killedAt: T0 + T.stopGraceMs });
    const again = step(overdue.state, ANSWERING, T0 + T.stopGraceMs + T.pollMs, T, nextId);
    expect(types(again)).toEqual(["destroy"]);
    const gone = step(again.state, exited(137), T0 + T.stopGraceMs + 2 * T.pollMs, T, nextId);
    expect(events(gone)).toEqual(["stop_done"]);
    expect(gone.state).toMatchObject({ phase: "waiting", killedAt: null, signalledAt: null });
  });

  it("never kills on a stop that was never delivered: calls it off, or sends it again (Codex r3-2)", () => {
    const intended: WatchdogState = {
      ...answered(T0),
      phase: "stopping",
      phaseSince: T0,
      signalledAt: null,
      outage: {
        outageId: "out_00000000000000000000000000",
        cause: "not_answering",
        startedAt: T0 - 120_000,
        detectedAt: T0 - 60_000,
        restarts: 0,
        exitCode: null,
        recovery: null,
      },
    };
    const later = T0 + T.stopGraceMs * 3;
    const healthy = step(intended, ANSWERING, later, T, nextId);
    expect(types(healthy)).not.toContain("destroy");
    expect(events(healthy)).toEqual(["stop_cancelled", "server_ready", "outage_ended"]);
    expect(healthy.state.phase).toBe("idle");
    const silentAgain = step(intended, SILENT, later, T, nextId);
    expect(types(silentAgain)).toEqual(["stop"]);
    expect(silentAgain.state.phase).toBe("stopping");
    const recovery = step(intended, entrypoint("recovery"), later, T, nextId);
    expect(types(recovery).some((t) => t === "stop" || t === "destroy")).toBe(false);
    expect(recovery.state.outage?.cause).toBe("recovery_mode");
  });

  it("waits for a stop the platform began, rather than killing it", () => {
    const s = step(answered(T0), entrypoint("stopping"), T0 + 10_000, T, nextId);
    expect(types(s)).not.toContain("destroy");
    expect(types(s)).not.toContain("stop");
    expect(s.state).toMatchObject({ phase: "stopping", phaseSince: T0 + 10_000 });
    expect(s.state.outage?.cause).toBe("container_stopped");
  });

  it("adopts a container that runs while a start is due, rather than stopping it", () => {
    const waiting: WatchdogState = { ...answered(T0), phase: "waiting", startDueAt: T0 + 9_000 };
    const s = step(waiting, SILENT, T0 + 1_000, T, nextId);
    expect(types(s)).toEqual(["event", "outage"]);
    expect(s.state).toMatchObject({ phase: "starting", phaseSince: T0 + 1_000 });
  });

  it("clamps an outage that would start after its detection", () => {
    const s = step(answered(T0 + 5_000), STOPPED, T0, T, nextId);
    const record = outages(s)[0];
    expect(record?.startedAt).toBe(new Date(T0).toISOString());
    expect(OutageRecord.safeParse(record).success).toBe(true);
  });
});

describe("watchdog: recovery mode and settings (WP2.3)", () => {
  it("never restarts a server in recovery mode, transient or not, and says why once", () => {
    for (const transient of [false, true]) {
      const steps = run(answered(T0), [
        [T0 + 60_000, entrypoint("recovery", transient)],
        [T0 + 400_000, entrypoint("recovery", transient)],
        [T0 + 4_000_000, SILENT], // its status could not be read this time
        [T0 + 4_100_000, entrypoint("recovery", transient)],
      ]);
      for (const s of steps) {
        expect(types(s).some((t) => ["stop", "destroy", "start"].includes(t))).toBe(false);
      }
      expect(steps.flatMap(events).filter((e) => e === "recovery_mode")).toHaveLength(1);
      expect(outages(defined(steps[3]))[0]).toMatchObject({
        cause: "recovery_mode",
        endedAt: null,
      });
      expect(defined(steps[3]).nextCheckAt - (T0 + 4_100_000)).toBe(T.intervalMs);
    }
  });

  it("records a recovery the restart ran into, and its end when the server answers", () => {
    const steps = run(answered(T0), [
      [T0 + 10_000, STOPPED], // restart
      [T0 + 30_000, entrypoint("recovery", true)], // the restore failed: the entrypoint retries
      [T0 + 100_000, ANSWERING], // its retry worked
    ]);
    expect(outages(defined(steps[1]))[0]).toMatchObject({ cause: "recovery_mode", restarts: 1 });
    expect(defined(steps[1]).state.phase).toBe("idle");
    expect(outages(defined(steps[2]))[0]?.endedAt).toBe(new Date(T0 + 100_000).toISOString());
  });

  it("holds a server that exited 78 until its configuration changes", () => {
    const held = run(
      answered(T0),
      [
        [T0 + 10_000, exited(EXIT_CONFIG)],
        [T0 + 70_000, STOPPED],
        [T0 + 3_600_000, STOPPED],
      ],
      "config-a",
    );
    expect(events(defined(held[0]))).toContain("config_error");
    expect(held.flatMap(types)).not.toContain("start");
    expect(defined(held[2]).state).toMatchObject({ phase: "held", heldConfig: "config-a" });
    expect(outages(defined(held[2]))[0]).toMatchObject({ exitCode: EXIT_CONFIG, endedAt: null });
    const changed = step(defined(held[2]).state, STOPPED, T0 + 3_700_000, T, nextId, "config-b");
    expect(events(changed)).toEqual(["config_changed", "start"]);
    expect(changed.state).toMatchObject({ phase: "starting", heldConfig: null });
  });

  it("holds the configuration that exited 78, and starts a corrected one at once (Codex r4-2)", () => {
    const ranWithA: Observation = { kind: "stopped", exitCode: EXIT_CONFIG, ranWith: "config-a" };
    const corrected = step(answered(T0), ranWithA, T0 + 10_000, T, nextId, "config-b");
    expect(events(corrected)).toEqual(
      expect.arrayContaining(["config_error", "config_changed", "start"]),
    );
    expect(corrected.state.phase).toBe("starting");
    const same = step(answered(T0), ranWithA, T0 + 10_000, T, nextId, "config-a");
    expect(same.state).toMatchObject({ phase: "held", heldConfig: "config-a" });
    expect(types(same)).not.toContain("start");
  });

  it("holds a first start that exits 78 too, recording it as a failed start", () => {
    const [first, found] = run(INITIAL_WATCHDOG_STATE, [
      [T0, STOPPED],
      [T0 + 5_000, exited(EXIT_CONFIG)],
    ]);
    expect(first && types(first)).toContain("start");
    expect(found?.state.phase).toBe("held");
    expect(found && outages(found)[0]).toMatchObject({ cause: "start_failed", exitCode: 78 });
  });

  it("holds after a graceful stop that ended in 78", () => {
    const stopping: WatchdogState = { ...answered(T0), phase: "stopping", phaseSince: T0 };
    const s = step(stopping, exited(EXIT_CONFIG), T0 + 1_000, T, nextId, "config-a");
    expect(s.state).toMatchObject({ phase: "held", heldConfig: "config-a" });
  });
});

describe("watchdog: leaving recovery mode (AIR2-009)", () => {
  const recovery = entrypoint("recovery", true);
  const stops = (steps: Step[]) => steps.filter((s) => types(s).includes("stop")).length;

  it("restarts an app that stays silent after recovery mode, seen running with no boot between (Codex's probe)", () => {
    // Codex pass 13: recovery seen at 1 s, then `running` at 61, 181, 601 and 3,601 s, never an
    // answer. The outage keeps its recovery_mode cause; the start that followed gets a budget.
    const steps = run(INITIAL_WATCHDOG_STATE, [
      [T0 + 1_000, recovery],
      [T0 + 61_000, entrypoint("running")],
      [T0 + 61_000 + T.readinessWaitMs - 1, entrypoint("running")],
      [T0 + 61_000 + T.readinessWaitMs, entrypoint("running")],
    ]);
    expect(events(defined(steps[1]))).toContain("recovery_left");
    expect(defined(steps[1]).state).toMatchObject({ phase: "starting", recoverySince: null });
    expect(actions(defined(steps[2]))).toEqual([]);
    const restart = defined(steps[3]);
    expect(types(restart)).toContain("stop");
    expect(restart.state.outage?.cause).toBe("recovery_mode"); // the record's cause is kept
  });

  it("keeps protecting a container whose status turns unreadable in recovery mode", () => {
    const seq: [number, Observation][] = [[T0 + 1_000, recovery]];
    for (let at = T0 + 61_000; at < T0 + 4 * 3_600_000; at += 60_000) seq.push([at, SILENT]);
    const steps = run(answered(T0), seq);
    expect(stops(steps)).toBe(0);
    expect(steps.flatMap(types).some((t) => t === "destroy" || t === "start")).toBe(false);
    expect(defined(steps.at(-1)).state.recoverySince).toBe(T0 + 1_000);
  });

  it("follows recovery, then a boot, then running, with the budgets of a start", () => {
    const answers = run(answered(T0), [
      [T0 + 1_000, recovery],
      [T0 + 61_000, entrypoint("restoring")], // the entrypoint's own retry
      [T0 + 70_000, entrypoint("initializing")],
      [T0 + 100_000, entrypoint("running")],
      [T0 + 105_000, ANSWERING],
    ]);
    expect(stops(answers)).toBe(0);
    expect(defined(answers[1]).state).toMatchObject({ phase: "starting", bootSeenAt: T0 + 61_000 });
    const ended = defined(answers[4]);
    expect(events(ended)).toEqual(["server_ready", "outage_ended"]);
    expect(outages(ended)[0]).toMatchObject({ cause: "recovery_mode" });
    // The same, never answering: stopped once the app-start budget is used up.
    const hung = run(answered(T0), [
      [T0 + 1_000, recovery],
      [T0 + 61_000, entrypoint("restoring")],
      [T0 + 70_000, entrypoint("initializing")],
      [T0 + 70_000 + T.appStartWaitMs, entrypoint("initializing")],
    ]);
    expect(types(defined(hung[3]))).toContain("stop");
  });

  it("ends the outage and forgets recovery mode when the server answers", () => {
    const steps = run(answered(T0), [
      [T0 + 1_000, recovery],
      [T0 + 61_000, ANSWERING],
      [T0 + 61_000 + T.hungAfterMs, SILENT], // a later silence is an ordinary one
    ]);
    expect(events(defined(steps[1]))).toEqual(["server_ready", "outage_ended"]);
    expect(defined(steps[1]).state.recoverySince).toBeNull();
    expect(events(defined(steps[2]))).toContain("restart_silent");
    expect(types(defined(steps[2]))).toContain("stop");
  });

  it("forgets recovery mode when the container stops, and starts it again", () => {
    const steps = run(answered(T0), [
      [T0 + 1_000, recovery],
      [T0 + 61_000, STOPPED],
    ]);
    expect(types(defined(steps[1]))).toContain("start");
    expect(defined(steps[1]).state.recoverySince).toBeNull();
  });

  it("never stops, kills or starts a container while it reports recovery mode or nothing", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 600_000 }), fc.boolean()), {
          minLength: 1,
          maxLength: 60,
        }),
        fc.option(fc.constantFrom(T0 - 60_000, T0 - 3_600_000), { nil: null }),
        (gaps, lastAnswer) => {
          let state: WatchdogState = { ...INITIAL_WATCHDOG_STATE, lastAnsweredAt: lastAnswer };
          let at = T0;
          state = step(state, recovery, at, T, nextId).state;
          for (const [gap, readable] of gaps) {
            at += gap;
            const s = step(state, readable ? recovery : SILENT, at, T, nextId);
            if (types(s).some((t) => t === "stop" || t === "destroy" || t === "start")) {
              return false;
            }
            state = s.state;
          }
          return state.recoverySince === T0;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("randomOutageId", () => {
  it("makes valid, distinct outage IDs", () => {
    const made = Array.from({ length: 200 }, randomOutageId);
    expect(made.every((id) => OutageId.safeParse(id).success)).toBe(true);
    expect(new Set(made).size).toBe(made.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Simulation (the plan's "simulation" layer for this package): a simulated server under random
// platform stops, refused starts, slow boots, restores, recovery mode, hangs and slow stops,
// driven by the watchdog at the times it asks for. Invariants hold for every run.

interface SimServer {
  running: boolean;
  /** When a started server begins to answer. */
  answersAt: number | null;
  hung: boolean;
  refusalsLeft: number;
  /** Until when its entrypoint reports a restore. */
  restoringUntil: number;
  /** Whether its app has answered since its start; until then the entrypoint says `initializing`. */
  ready: boolean;
  recovery: boolean;
  /** When a SIGTERM stop completes, while stopping. */
  stopsAt: number | null;
  lastExit: number | null;
}

const faultArb = fc.oneof(
  fc.record({
    kind: fc.constant("platform_stop" as const),
    at: fc.integer({ min: 0, max: 3_600_000 }),
    refusals: fc.integer({ min: 0, max: 6 }),
    exitCode: fc.constantFrom(0, 70, 71, 75),
  }),
  fc.record({ kind: fc.constant("hang" as const), at: fc.integer({ min: 0, max: 3_600_000 }) }),
  fc.record({
    kind: fc.constant("recovery" as const),
    at: fc.integer({ min: 0, max: 3_600_000 }),
    lastsMs: fc.integer({ min: 60_000, max: 1_800_000 }),
    // After its own retry restored the database the app starts again, and may hang (AIR2-009).
    hangAfter: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("none" as const), at: fc.integer({ min: 0, max: 3_600_000 }) }),
);

describe("watchdog simulation", () => {
  it("keeps the server on, records every outage without understating it, and never fights recovery", () => {
    const seen = {
      downIntervals: 0,
      refusedStarts: 0,
      restarts: 0,
      recoveries: 0,
      stops: 0,
      hungAfterRecovery: 0,
      liveness: 0,
    };
    fc.assert(
      fc.property(
        fc.array(faultArb, { maxLength: 6 }),
        fc.integer({ min: 1_000, max: 400_000 }),
        fc.integer({ min: 0, max: 600_000 }),
        fc.integer({ min: 0, max: 900_000 }),
        // An older image reports `running` from the app's start (WP2.3), a newer `initializing`.
        fc.boolean(),
        (faults, bootMs, restoreMs, stopMs, olderImage) => {
          const sorted = [...faults].sort((a, b) => a.at - b.at);
          const server: SimServer = {
            running: false,
            answersAt: null,
            hung: false,
            refusalsLeft: 0,
            restoringUntil: 0,
            ready: false,
            recovery: false,
            stopsAt: null,
            lastExit: null,
          };
          let recoveryEndsAt = 0;
          let hangAfterRecovery = false;
          let lastDisturbance = T0;
          let state = INITIAL_WATCHDOG_STATE;
          let now = T0;
          let fault = 0;
          let currentDown: { from: number; to: number | null } | null = null;
          let everAnswered = false;
          const records = new Map<string, OutageRecord>();
          const downIntervals: { from: number; to: number | null }[] = [];
          const end = T0 + 5 * 3_600_000;
          let startsWhileRunning = 0;
          let stoppedInRecovery = 0;

          const answering = (at: number) =>
            server.running &&
            !server.hung &&
            !server.recovery &&
            server.stopsAt === null &&
            server.answersAt !== null &&
            at >= server.answersAt;

          while (now < end) {
            for (let f = sorted[fault]; f !== undefined && T0 + f.at <= now; f = sorted[fault]) {
              if (f.kind === "platform_stop") {
                server.running = false;
                server.answersAt = null;
                server.hung = false;
                server.recovery = false;
                server.stopsAt = null;
                server.refusalsLeft = f.refusals;
                server.lastExit = f.exitCode;
              } else if (f.kind === "hang" && server.running) server.hung = true;
              else if (f.kind === "recovery" && server.running && server.stopsAt === null) {
                server.recovery = true;
                recoveryEndsAt = now + f.lastsMs;
                hangAfterRecovery = f.hangAfter;
                seen.recoveries += 1;
              }
              fault += 1;
              lastDisturbance = now;
            }
            if (server.recovery && now >= recoveryEndsAt) {
              // The entrypoint's retry restored the database: the app starts from scratch.
              server.recovery = false;
              server.ready = false;
              server.answersAt = now + bootMs;
              server.hung = hangAfterRecovery;
              if (hangAfterRecovery) seen.hungAfterRecovery += 1;
              lastDisturbance = now;
            }
            if (server.stopsAt !== null && now >= server.stopsAt) {
              server.running = false;
              server.stopsAt = null;
              server.answersAt = null;
              server.lastExit = 0;
            }
            const isUp = answering(now);
            if (isUp) server.ready = true;
            if (everAnswered && !isUp && currentDown === null) {
              // The truth: the server stopped answering no earlier than its last answer.
              currentDown = { from: state.lastAnsweredAt ?? now, to: null };
              downIntervals.push(currentDown);
            }
            let obs: Observation;
            if (!server.running) obs = { kind: "stopped", exitCode: server.lastExit };
            else if (isUp) obs = ANSWERING;
            else {
              const phase: EntrypointPhase = server.recovery
                ? "recovery"
                : server.stopsAt !== null
                  ? "stopping"
                  : now < server.restoringUntil
                    ? "restoring"
                    : server.ready || olderImage
                      ? "running"
                      : "initializing";
              obs = entrypoint(phase, true);
            }
            // Recovery as the watchdog sees it, before a stop of its own began.
            const inRecovery = server.recovery && state.phase !== "stopping";
            const s = step(state, obs, now, T, nextId, "config-a");
            if (obs.kind === "stopped") server.lastExit = null;
            for (const effect of s.effects) {
              if (effect.type === "outage") records.set(effect.record.outageId, effect.record);
              if (effect.type === "start") {
                if (server.running) startsWhileRunning += 1;
                if (state.lastAnsweredAt !== null) seen.restarts += 1;
                if (server.refusalsLeft > 0) {
                  server.refusalsLeft -= 1;
                  seen.refusedStarts += 1;
                } else {
                  server.running = true;
                  server.hung = false;
                  server.ready = false;
                  server.recovery = false;
                  server.restoringUntil = now + restoreMs;
                  server.answersAt = now + restoreMs + bootMs;
                }
              }
              if (effect.type === "stop") {
                seen.stops += 1;
                if (inRecovery) stoppedInRecovery += 1;
                server.stopsAt = now + stopMs;
              }
              if (effect.type === "destroy") {
                if (inRecovery) stoppedInRecovery += 1;
                server.running = false;
                server.answersAt = null;
                server.stopsAt = null;
              }
            }
            if (obs.kind === "answering") {
              everAnswered = true;
              if (currentDown !== null) currentDown.to = now;
              currentDown = null;
            }
            // The Durable Object records a delivered SIGTERM.
            state = s.effects.some((e) => e.type === "stop") ? signalled(s.state, now) : s.state;
            expect(s.nextCheckAt).toBeGreaterThan(now);
            expect(s.nextCheckAt - now).toBeLessThanOrEqual(T.intervalMs);
            now = s.nextCheckAt;
          }

          seen.downIntervals += downIntervals.length;
          // Liveness: once nothing disturbs it for an hour, a server whose start fits the budgets
          // answers again, whatever happened before: a hang after recovery mode included.
          const fits =
            restoreMs <= T.restoreWaitMs - 3 * T.pollMs &&
            bootMs <= (olderImage ? T.readinessWaitMs : T.appStartWaitMs) - 3 * T.pollMs;
          if (fits && end - lastDisturbance >= 3_600_000 && !server.recovery) {
            seen.liveness += 1;
            expect(answering(now)).toBe(true);
          }
          expect(startsWhileRunning).toBe(0);
          expect(stoppedInRecovery).toBe(0);
          // Every record satisfies the contract, and at most one is ongoing.
          const all = [...records.values()];
          for (const r of all) expect(OutageRecord.safeParse(r).success).toBe(true);
          expect(all.filter((r) => r.endedAt === null).length).toBeLessThanOrEqual(1);
          // Every interval in which an answered server was down lies inside one record that
          // starts no later than it (no understatement) and ends no earlier.
          for (const down of downIntervals) {
            const covering = all.find(
              (r) =>
                Date.parse(r.startedAt) <= down.from &&
                (r.endedAt === null || (down.to !== null && Date.parse(r.endedAt) >= down.to)),
            );
            expect(covering).toBeDefined();
          }
        },
      ),
      { numRuns: 300 },
    );
    // The runs exercised what they claim to.
    expect(seen.downIntervals).toBeGreaterThan(100);
    expect(seen.refusedStarts).toBeGreaterThan(100);
    expect(seen.restarts).toBeGreaterThan(100);
    expect(seen.recoveries).toBeGreaterThan(20);
    expect(seen.stops).toBeGreaterThan(20);
    expect(seen.hungAfterRecovery).toBeGreaterThan(10);
    expect(seen.liveness).toBeGreaterThan(30);
    // 300 simulated hours take a few seconds; CI runners are slower than the default 5 s allows.
  }, 60_000);
});

describe("watchdog: any stored state", () => {
  // The state comes back from storage: whatever combination it holds, a step stays safe.
  const time = fc.integer({ min: T0 - 3_600_000, max: T0 + 3_600_000 });
  const maybe = <V>(arb: fc.Arbitrary<V>) => fc.option(arb, { nil: null });
  const stateArb: fc.Arbitrary<WatchdogState> = fc.record({
    phase: fc.constantFrom("idle", "starting", "stopping", "waiting", "held"),
    phaseSince: maybe(time),
    startDueAt: maybe(time),
    failedStarts: fc.integer({ min: 0, max: 20 }),
    lastAnsweredAt: maybe(time),
    startsSince: maybe(time),
    heldConfig: maybe(fc.constantFrom("config-a", "config-b")),
    signalledAt: maybe(time),
    killedAt: maybe(time),
    bootSeenAt: maybe(time),
    initSeenAt: maybe(time),
    bootEndedAt: maybe(time),
    recoverySince: maybe(time),
    outage: maybe(
      fc.record({
        outageId: fc.constant("out_00000000000000000000000000"),
        cause: fc.constantFrom(
          "container_stopped",
          "not_answering",
          "start_failed",
          "recovery_mode",
        ),
        startedAt: time,
        detectedAt: time,
        restarts: fc.integer({ min: 0, max: 2000 }),
        exitCode: maybe(fc.constantFrom(0, 70, 71, 75, 78)),
        recovery: maybe(fc.constant("replica_empty")),
      }),
    ),
  });
  const observationArb: fc.Arbitrary<Observation> = fc.oneof(
    fc.constant(ANSWERING),
    fc.record({
      kind: fc.constant("stopped" as const),
      exitCode: maybe(fc.constantFrom(0, 70, 71, 75, 78)),
    }),
    fc.constant(SILENT),
    fc
      .constantFrom<EntrypointPhase>(
        "starting",
        "restoring",
        "recovery",
        "initializing",
        "running",
        "stopping",
        "stopped",
      )
      .map((phase) => entrypoint(phase)),
  );
  const configArb = fc.constantFrom("config-a", "config-b");

  it("never starts a running container, never stops one in recovery or that answers, and always looks again", () => {
    fc.assert(
      fc.property(stateArb, observationArb, time, configArb, (state, observation, now, config) => {
        const s = step(state, observation, now, T, nextId, config);
        if (observation.kind !== "stopped" && types(s).includes("start")) return false;
        const recovery =
          observation.kind === "silent" && observation.entrypoint?.phase === "recovery";
        // A stop the watchdog began earlier may still be killed after its grace.
        const ownStop = state.phase === "stopping";
        if (recovery && !ownStop && types(s).some((t) => t === "stop" || t === "destroy")) {
          return false;
        }
        if (observation.kind === "answering" && types(s).includes("stop")) return false;
        if (
          observation.kind === "stopped" &&
          types(s).some((t) => t === "stop" || t === "destroy")
        ) {
          return false;
        }
        // A kill only after a delivered stop outran its grace (Codex r3-2).
        if (
          types(s).includes("destroy") &&
          !(
            state.phase === "stopping" &&
            state.signalledAt !== null &&
            now - state.signalledAt >= T.stopGraceMs
          )
        ) {
          return false;
        }
        const releasing = state.phase === "held" && config !== state.heldConfig;
        if (
          observation.kind === "stopped" &&
          observation.exitCode === EXIT_CONFIG &&
          !releasing &&
          types(s).includes("start")
        ) {
          return false;
        }
        if (state.phase === "held" && config === state.heldConfig && types(s).includes("start")) {
          return false;
        }
        const longest = Math.max(T.intervalMs, T.slowRetryMs, ...T.startRetryMs);
        return s.nextCheckAt > now && s.nextCheckAt - now <= longest;
      }),
      { numRuns: 5000 },
    );
  });

  it("writes only records the contract accepts, whose start the state's last answer bounds", () => {
    fc.assert(
      fc.property(stateArb, observationArb, time, (state, observation, now) => {
        const s = step(state, observation, now, T, nextId);
        return outages(s).every((record) => {
          if (!OutageRecord.safeParse(record).success) return false;
          if (state.outage !== null && record.outageId === state.outage.outageId) {
            return true; // an older record: its times were the earlier step's
          }
          // A new outage starts no later than the last answer, nor than now.
          const bound = Math.min(state.lastAnsweredAt ?? now, now);
          return Date.parse(record.startedAt) <= bound;
        });
      }),
      { numRuns: 5000 },
    );
  });

  it("uses the design's timing by default, and needs an ID source only to open an outage", () => {
    expect(step(answered(T0), ANSWERING, T0 + 1).nextCheckAt).toBe(T0 + 1 + T.intervalMs);
    expect(() => step(answered(T0), STOPPED, T0 + 1)).toThrow("no outage ID source");
  });
});
