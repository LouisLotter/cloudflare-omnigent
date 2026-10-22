// WP2.6's staging run (worker/test/staging/wp26/plan.ts): the run's decisions, so the owner's
// one token is enough for a whole run, every stage ends, and the replica has one writer at a time.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Action,
  decide,
  INITIAL_RUN,
  LIMITS,
  type Observed,
  type RunState,
} from "../staging/wp26/plan.ts";

const T0 = Date.parse("2026-10-23T08:00:00.000Z");
const seen = (now: number, extra: Partial<Observed> = {}): Observed => ({
  now,
  tokenPresent: true,
  seederRunning: true,
  seedResult: null,
  serverLastAnsweredAt: null,
  outages: [],
  ...extra,
});
const types = (actions: readonly Action[]) => actions.map((a) => a.type);
const SEEDED = { ok: true, detail: "seeded and replicated", fields: { bytes: 1_258_291_200 } };

describe("the WP2.6 staging run", () => {
  it("waits for the owner's token, then seeds, starts the server, replaces it and writes the summary", () => {
    let state: RunState = INITIAL_RUN;
    const waiting = decide(state, seen(T0, { tokenPresent: false }));
    expect(types(waiting.actions)).toEqual(["log"]);
    expect(waiting.state).toBe(state);
    let step = decide(state, seen(T0));
    expect(types(step.actions)).toEqual(["log", "start_seeder"]);
    state = step.state;
    expect(state).toMatchObject({ stage: "seeding", t0: T0, seedStarts: 1 });
    expect(decide(state, seen(T0 + 60_000)).actions).toEqual([]); // seeding
    step = decide(state, seen(T0 + 300_000, { seedResult: SEEDED }));
    // The seeder goes before the production server starts: one writer at a time.
    expect(types(step.actions)).toEqual(["stop_seeder", "log", "ensure_server"]);
    state = step.state;
    expect(state).toMatchObject({ stage: "starting", firstStartAt: T0 + 300_000 });
    expect(types(decide(state, seen(T0 + 400_000)).actions)).toEqual(["ensure_server"]);
    step = decide(state, seen(T0 + 600_000, { serverLastAnsweredAt: T0 + 590_000 }));
    state = step.state;
    expect(state).toMatchObject({ stage: "healthy", firstAnsweredAt: T0 + 590_000 });
    step = decide(state, seen(T0 + 590_000 + LIMITS.healthyHoldMs));
    expect(types(step.actions)).toEqual(["log", "destroy_server"]);
    state = step.state;
    const requestedAt = T0 + 590_000 + LIMITS.healthyHoldMs;
    expect(state).toMatchObject({
      stage: "replacing",
      killRequestedAt: requestedAt,
      killedAt: null,
    });
    // Until the destroy returned (the driver records it), the destroy is sent again.
    expect(types(decide(state, seen(requestedAt + 15_000)).actions)).toEqual(["destroy_server"]);
    const killedAt = requestedAt + 2_000;
    state = { ...state, killedAt };
    // An answer from before the kill's outage is not the replacement's.
    const early = decide(state, seen(killedAt + 1_000, { serverLastAnsweredAt: killedAt + 500 }));
    expect(early.state.stage).toBe("replacing");
    step = decide(
      state,
      seen(killedAt + 400_000, {
        outages: [
          { detectedAt: T0 - 10_000, endedAt: T0 + 590_000 }, // the first start's
          { detectedAt: killedAt + 5_000, endedAt: killedAt + 380_000 },
        ],
      }),
    );
    expect(types(step.actions)).toEqual(["log", "log", "write_summary"]);
    expect(step.state).toMatchObject({
      stage: "done",
      failure: null,
      replacedAnsweredAt: killedAt + 380_000,
    });
    const written = { ...step.state, summaryWritten: true };
    expect(decide(written, seen(killedAt + 500_000)).actions).toEqual([]);
  });

  it("ends the run when the server cannot be destroyed", () => {
    const replacing: RunState = {
      ...INITIAL_RUN,
      stage: "replacing",
      runId: "run-x",
      killRequestedAt: T0,
      killedAt: null,
    };
    expect(decide(replacing, seen(T0 + LIMITS.startMs + 1)).state).toMatchObject({
      stage: "done",
      failure: "the server could not be destroyed",
    });
  });

  it("restarts a seeder that is not running, a bounded number of times", () => {
    let state = decide(INITIAL_RUN, seen(T0)).state;
    let now = T0;
    for (let start = 2; start <= LIMITS.maxSeedStarts; start += 1) {
      now += LIMITS.seedRestartAfterMs + 1;
      const step = decide(state, seen(now, { seederRunning: false }));
      expect(types(step.actions)).toEqual(["log", "start_seeder"]);
      state = step.state;
      expect(state.seedStarts).toBe(start);
    }
    now += LIMITS.seedRestartAfterMs + 1;
    const failed = decide(state, seen(now, { seederRunning: false }));
    expect(failed.state).toMatchObject({
      stage: "done",
      failure: "the seeder container would not run",
    });
  });

  it("never touches the server while seeding, and ends a failed seed with the seeder removed", () => {
    const seeding = decide(INITIAL_RUN, seen(T0)).state;
    const failed = decide(
      seeding,
      seen(T0 + 60_000, {
        seedResult: { ok: false, detail: "the replica never caught up", fields: {} },
      }),
    );
    expect(types(failed.actions)).toEqual(["stop_seeder", "log", "write_summary"]);
    expect(failed.state.failure).toContain("seeding failed");
  });

  it("ends every stage within its limit, and never starts the server before the seed is done", () => {
    const observed = fc.record({
      gap: fc.integer({ min: 1_000, max: 20 * 60_000 }),
      tokenPresent: fc.boolean(),
      seederRunning: fc.boolean(),
      seeded: fc.boolean(),
      answered: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(observed, { minLength: 1, maxLength: 120 }), (steps) => {
        let state: RunState = INITIAL_RUN;
        let now = T0;
        let seedDone = false;
        for (const o of steps) {
          now += o.gap;
          const step = decide(
            state,
            seen(now, {
              tokenPresent: o.tokenPresent,
              seederRunning: o.seederRunning,
              seedResult: o.seeded ? SEEDED : null,
              serverLastAnsweredAt: o.answered ? now - 1 : null,
              outages: o.answered ? [{ detectedAt: now - 2, endedAt: now - 1 }] : [],
            }),
          );
          const acts = types(step.actions);
          if (acts.includes("stop_seeder") && step.state.stage === "starting") seedDone = true;
          if ((acts.includes("ensure_server") || acts.includes("destroy_server")) && !seedDone) {
            return false;
          }
          // A stage that is not waiting for the owner ends within its limits.
          if (step.state.stage === "seeding" && now - (step.state.t0 ?? now) > LIMITS.seedMs * 5) {
            return false;
          }
          state = step.state;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
