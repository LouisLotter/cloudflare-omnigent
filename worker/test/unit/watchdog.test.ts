import { OutageId, OutageRecord } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Effect,
  INITIAL_WATCHDOG_STATE,
  type Observation,
  randomOutageId,
  retryDelay,
  type Step,
  step,
  WATCHDOG_TIMING as T,
  type WatchdogState,
} from "../../src/server/watchdog.ts";
import { defined, gaps } from "../support/defined.ts";

const T0 = Date.parse("2026-10-22T03:00:00.000Z");
let ids = 0;
const nextId = () => `out_${String(++ids).padStart(26, "0")}`;

const types = (s: Step) => s.effects.map((e) => e.type);
const events = (s: Step) =>
  s.effects.flatMap((e) => (e.type === "event" ? [e.name] : [])) as string[];
const outages = (s: Step) =>
  s.effects.flatMap((e) => (e.type === "outage" ? [e.record] : [])) as OutageRecord[];

/** Runs observations in order, each at its time; returns every step. */
function run(start: WatchdogState, seq: readonly [number, Observation][]): Step[] {
  const steps: Step[] = [];
  let state = start;
  for (const [at, obs] of seq) {
    const s = step(state, obs, at, T, nextId);
    steps.push(s);
    state = s.state;
  }
  return steps;
}

const answered = (at: number): WatchdogState => ({ ...INITIAL_WATCHDOG_STATE, lastAnsweredAt: at });

describe("watchdog: first start", () => {
  it("starts a server that was never started, without recording an outage", () => {
    const s = step(INITIAL_WATCHDOG_STATE, "stopped", T0, T, nextId);
    expect(types(s)).toEqual(["event", "start"]);
    expect(s.state).toMatchObject({
      phase: "starting",
      phaseSince: T0,
      startsSince: T0,
      outage: null,
    });
    expect(s.nextCheckAt).toBe(T0 + T.pollMs);
  });

  it("waits the full readiness wait for a first start, then records it as failed", () => {
    const [, waiting, failed] = run(INITIAL_WATCHDOG_STATE, [
      [T0, "stopped"],
      [T0 + T.readinessWaitMs - 1, "silent"],
      [T0 + T.readinessWaitMs, "silent"],
    ]);
    expect(waiting?.effects).toEqual([]);
    expect(failed && types(failed)).toEqual(["event", "event", "outage", "destroy"]);
    expect(failed && events(failed)).toEqual(["outage_started", "start_not_ready"]);
    expect(failed && outages(failed)[0]).toMatchObject({
      cause: "start_failed",
      startedAt: new Date(T0).toISOString(),
      endedAt: null,
    });
    expect(failed?.state).toMatchObject({ phase: "waiting", failedStarts: 1 });
    expect(failed?.nextCheckAt).toBe(T0 + T.readinessWaitMs + retryDelay(1, T));
  });
});

describe("watchdog: a healthy server", () => {
  it("records nothing and checks again after the interval", () => {
    const s = step(answered(T0), "answering", T0 + 60_000, T, nextId);
    expect(s.effects).toEqual([]);
    expect(s.state.lastAnsweredAt).toBe(T0 + 60_000);
    expect(s.nextCheckAt).toBe(T0 + 60_000 + T.intervalMs);
  });

  it("never stops or restarts a server that answers", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (offset) => {
        const s = step(answered(T0), "answering", T0 + offset, T, nextId);
        return !types(s).includes("destroy") && !types(s).includes("start");
      }),
    );
  });
});

describe("watchdog: found stopped (maintenance or a deploy's rollout)", () => {
  it("opens an outage from the last answer, restarts, and closes it when the server answers", () => {
    const steps = run(answered(T0), [
      [T0 + 50_000, "stopped"],
      [T0 + 55_000, "silent"],
      [T0 + 70_000, "answering"],
    ]);
    const [found, booting, ready] = steps;
    expect(found && events(found)).toEqual(["found_stopped", "outage_started", "start"]);
    expect(found && outages(found)[0]).toMatchObject({
      cause: "container_stopped",
      startedAt: new Date(T0).toISOString(),
      detectedAt: new Date(T0 + 50_000).toISOString(),
      endedAt: null,
      restarts: 1,
    });
    expect(booting?.effects).toEqual([]);
    expect(ready && events(ready)).toEqual(["server_ready", "outage_ended"]);
    const ended = ready && outages(ready)[0];
    expect(ended).toMatchObject({ endedAt: new Date(T0 + 70_000).toISOString(), restarts: 1 });
    expect(OutageRecord.safeParse(ended).success).toBe(true);
    expect(ready?.state.outage).toBeNull();
  });

  it("reports where a replacement's time went (DC-47)", () => {
    const steps = run(answered(T0), [
      [T0 + 10_000, "stopped"],
      [T0 + 15_000, "stopped"], // refused (DC-37)
      [T0 + 20_000, "stopped"], // retry due
      [T0 + 32_000, "answering"],
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
    let state = step(answered(T0), "stopped", T0, T, nextId).state;
    let now = T0;
    const startTimes: number[] = [T0];
    for (let failure = 1; failure <= 7; failure += 1) {
      now += T.pollMs;
      const refused = step(state, "stopped", now, T, nextId);
      expect(events(refused)).toContain("start_stopped");
      expect(refused.state.failedStarts).toBe(failure);
      const due = now + retryDelay(failure, T);
      expect(refused.nextCheckAt).toBe(due);
      // A check before the retry is due starts nothing.
      const early = step(refused.state, "stopped", due - 1, T, nextId);
      expect(types(early)).not.toContain("start");
      expect(early.nextCheckAt).toBe(due);
      const retry = step(refused.state, "stopped", due, T, nextId);
      expect(types(retry)).toContain("start");
      startTimes.push(due);
      state = retry.state;
      now = due;
    }
    expect(gaps(startTimes)).toEqual([10_000, 15_000, 25_000, 25_000, 65_000, 65_000, 65_000]);
    expect(state.outage?.restarts).toBe(8);
  });

  it("says once that starts keep failing, after the backoff is used up", () => {
    let state = step(answered(T0), "stopped", T0, T, nextId).state;
    const said: number[] = [];
    let now = T0;
    for (let failure = 1; failure <= 8; failure += 1) {
      now += T.pollMs;
      const refused = step(state, "stopped", now, T, nextId);
      if (events(refused).includes("start_failing")) said.push(failure);
      now = refused.nextCheckAt;
      state = step(refused.state, "stopped", now, T, nextId).state;
    }
    expect(said).toEqual([T.startRetryMs.length + 1]);
  });
});

describe("watchdog: a server that stops answering", () => {
  it("opens a not_answering outage from the last answer and restarts it after the wait", () => {
    const steps = run(answered(T0), [
      [T0 + 60_000, "silent"],
      [T0 + 100_000, "silent"],
      [T0 + T.hungAfterMs, "silent"],
    ]);
    const [opened, waiting, restarting] = steps.map((s) => defined(s));
    expect(events(defined(opened))).toEqual(["outage_started", "not_answering"]);
    expect(outages(defined(opened))[0]).toMatchObject({
      cause: "not_answering",
      startedAt: new Date(T0).toISOString(),
    });
    expect(types(defined(waiting))).toEqual([]);
    const hung = defined(restarting);
    expect(types(hung)).toEqual(["event", "destroy"]);
    expect(hung.state).toMatchObject({ phase: "waiting" });
    const restart = step(hung.state, "stopped", hung.nextCheckAt, T, nextId);
    expect(types(restart)).toContain("start");
    expect(restart.state.outage?.cause).toBe("not_answering");
    expect(restart.state.outage?.restarts).toBe(1);
  });

  it("adopts a container that runs while a start is due, rather than stopping it", () => {
    const waiting: WatchdogState = { ...answered(T0), phase: "waiting", startDueAt: T0 + 9_000 };
    const s = step(waiting, "silent", T0 + 1_000, T, nextId);
    expect(types(s)).toEqual([]);
    expect(s.state).toMatchObject({ phase: "starting", phaseSince: T0 + 1_000 });
  });

  it("clamps an outage that would start after its detection", () => {
    const s = step(answered(T0 + 5_000), "stopped", T0, T, nextId);
    const record = outages(s)[0];
    expect(record?.startedAt).toBe(new Date(T0).toISOString());
    expect(OutageRecord.safeParse(record).success).toBe(true);
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
// platform stops, refused starts, slow boots and hangs, driven by the watchdog at the times it
// asks for. Invariants hold for every run.

interface SimServer {
  running: boolean;
  /** When a started server begins to answer. */
  answersAt: number | null;
  hung: boolean;
  refusalsLeft: number;
}

const faultArb = fc.oneof(
  fc.record({
    kind: fc.constant("platform_stop" as const),
    at: fc.integer({ min: 0, max: 3_600_000 }),
    refusals: fc.integer({ min: 0, max: 6 }),
  }),
  fc.record({ kind: fc.constant("hang" as const), at: fc.integer({ min: 0, max: 3_600_000 }) }),
  fc.record({ kind: fc.constant("none" as const), at: fc.integer({ min: 0, max: 3_600_000 }) }),
);

describe("watchdog simulation", () => {
  it("keeps the server on and records every outage without understating it", () => {
    const seen = { downIntervals: 0, refusedStarts: 0, restarts: 0 };
    fc.assert(
      fc.property(
        fc.array(faultArb, { maxLength: 6 }),
        fc.integer({ min: 1_000, max: 200_000 }),
        (faults, bootMs) => {
          const sorted = [...faults].sort((a, b) => a.at - b.at);
          const server: SimServer = {
            running: false,
            answersAt: null,
            hung: false,
            refusalsLeft: 0,
          };
          let state = INITIAL_WATCHDOG_STATE;
          let now = T0;
          let fault = 0;
          // When the simulated server truly stopped answering, and every recorded outage.
          let currentDown: { from: number; to: number | null } | null = null;
          let everAnswered = false;
          const records = new Map<string, OutageRecord>();
          const downIntervals: { from: number; to: number | null }[] = [];
          const end = T0 + 5 * 3_600_000;
          let startsWhileRunning = 0;

          const answering = (at: number) =>
            server.running && !server.hung && server.answersAt !== null && at >= server.answersAt;

          while (now < end) {
            for (let f = sorted[fault]; f !== undefined && T0 + f.at <= now; f = sorted[fault]) {
              if (f.kind === "platform_stop") {
                server.running = false;
                server.answersAt = null;
                server.hung = false;
                server.refusalsLeft = f.refusals;
              } else if (f.kind === "hang" && server.running) server.hung = true;
              fault += 1;
            }
            const isUp = answering(now);
            if (everAnswered && !isUp && currentDown === null) {
              // The truth: the server stopped answering no earlier than its last answer.
              currentDown = { from: state.lastAnsweredAt ?? now, to: null };
              downIntervals.push(currentDown);
            }
            const obs: Observation = !server.running ? "stopped" : isUp ? "answering" : "silent";
            const s = step(state, obs, now, T, nextId);
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
                  server.answersAt = now + bootMs;
                }
              }
              if (effect.type === "destroy") {
                server.running = false;
                server.answersAt = null;
              }
            }
            if (obs === "answering") {
              everAnswered = true;
              if (currentDown !== null) currentDown.to = now;
              currentDown = null;
            }
            state = s.state;
            expect(s.nextCheckAt).toBeGreaterThan(now);
            expect(s.nextCheckAt - now).toBeLessThanOrEqual(T.intervalMs);
            now = s.nextCheckAt;
          }

          seen.downIntervals += downIntervals.length;
          // Never started over a running container.
          expect(startsWhileRunning).toBe(0);
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
          // The server is on at the end unless a fault came within the last few minutes.
          const lastFault = sorted.at(-1);
          if (lastFault === undefined || T0 + lastFault.at < end - 30 * 60_000) {
            expect(state.outage === null || bootMs > T.readinessWaitMs).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
    // The runs exercised what they claim to.
    expect(seen.downIntervals).toBeGreaterThan(100);
    expect(seen.refusedStarts).toBeGreaterThan(100);
    expect(seen.restarts).toBeGreaterThan(100);
  });
});

describe("watchdog: any stored state", () => {
  // The state comes back from storage: whatever combination it holds, a step stays safe.
  const time = fc.integer({ min: T0 - 3_600_000, max: T0 + 3_600_000 });
  const maybe = <V>(arb: fc.Arbitrary<V>) => fc.option(arb, { nil: null });
  const stateArb: fc.Arbitrary<WatchdogState> = fc.record({
    phase: fc.constantFrom("idle", "starting", "waiting"),
    phaseSince: maybe(time),
    startDueAt: maybe(time),
    failedStarts: fc.integer({ min: 0, max: 20 }),
    lastAnsweredAt: maybe(time),
    startsSince: maybe(time),
    outage: maybe(
      fc.record({
        outageId: fc.constant("out_00000000000000000000000000"),
        cause: fc.constantFrom("container_stopped", "not_answering", "start_failed"),
        startedAt: time,
        detectedAt: time,
        restarts: fc.integer({ min: 0, max: 2000 }),
      }),
    ),
  });
  const observationArb = fc.constantFrom<Observation>("stopped", "answering", "silent");

  it("never starts a running container, never stops an answering one, and always looks again", () => {
    fc.assert(
      fc.property(stateArb, observationArb, time, (state, observation, now) => {
        const s = step(state, observation, now, T, nextId);
        if (observation !== "stopped" && types(s).includes("start")) return false;
        if (observation !== "silent" && types(s).includes("destroy")) return false;
        if (observation === "answering" && s.state.outage !== null) return false;
        const longest = Math.max(T.intervalMs, T.slowRetryMs, ...T.startRetryMs);
        return s.nextCheckAt > now && s.nextCheckAt - now <= longest;
      }),
      { numRuns: 3000 },
    );
  });

  it("writes only records the contract accepts, whose start the state's last answer bounds", () => {
    fc.assert(
      fc.property(stateArb, observationArb, time, (state, observation, now) => {
        const s = step(state, observation, now, T, nextId);
        return outages(s).every((record) => {
          if (state.outage !== null && record.outageId === state.outage.outageId) {
            return true; // an older record: its times were the earlier step's
          }
          const parsed = OutageRecord.safeParse(record);
          const bound = Math.min(state.lastAnsweredAt ?? now, now);
          return parsed.success && Date.parse(record.startedAt) <= Math.max(bound, now);
        });
      }),
      { numRuns: 3000 },
    );
  });

  it("uses the design's timing by default, and needs an ID source only to open an outage", () => {
    expect(step(answered(T0), "answering", T0 + 1).nextCheckAt).toBe(T0 + 1 + T.intervalMs);
    expect(() => step(answered(T0), "stopped", T0 + 1)).toThrow("no outage ID source");
  });
});
