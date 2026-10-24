import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANSWERING,
  type EntrypointPhase,
  INITIAL_WATCHDOG_STATE,
  type Observation,
  step,
  WATCHDOG_TIMING as T,
  type WatchdogState,
} from "../../src/server/watchdog.ts";

const T0 = Date.parse("2026-10-24T00:00:00Z");
const REBOOT_MS = 60_000;
const LAST_RENEWAL = T0 + T.startRetryMs.length * REBOOT_MS;
const WHOLE_START =
  Math.max(T.restoreWaitMs, T.readinessWaitMs) + T.appStartWaitMs + T.readinessWaitMs;
const phases = ["starting", "restoring", "initializing", "running"] as const;
const observation = (phase: EntrypointPhase | null, boot: number): Observation => ({
  kind: "silent",
  entrypoint:
    phase === null ? null : { phase, bootId: boot.toString(16).padStart(32, "0"), recovery: null },
});
const advance = (state: WatchdogState, obs: Observation, at: number) =>
  step(state, obs, at, T, () => "out_00000000000000000000000001", "config-a");
const restored = (state: WatchdogState): WatchdogState => JSON.parse(JSON.stringify(state));
const budget = (phase: (typeof phases)[number]) =>
  phase === "initializing"
    ? T.appStartWaitMs
    : phase === "running"
      ? T.readinessWaitMs
      : T.restoreWaitMs;

/** Reach a start with the original boot and exactly the permitted four replacements. */
function lastPermittedBoot(phase: (typeof phases)[number]): WatchdogState {
  let state = advance(INITIAL_WATCHDOG_STATE, { kind: "stopped", exitCode: 0 }, T0).state;
  for (let boot = 0; boot <= T.startRetryMs.length; boot++) {
    const result = advance(state, observation(phase, boot), T0 + boot * REBOOT_MS);
    expect(result.effects.some((effect) => effect.type === "stop")).toBe(false);
    state = restored(result.state);
  }
  expect(state.failedStarts).toBe(T.startRetryMs.length);
  return state;
}

describe("watchdog: bounded unseen reboots (WP2.6 r2-1)", () => {
  it.each([0, 4, 5, 10, 100])(
    "gives a fresh ordinary retry all startup allowances after %i failed starts",
    (failures) => {
      const stopped: Observation = { kind: "stopped", exitCode: 0 };
      let at = T0;
      let state = advance(INITIAL_WATCHDOG_STATE, stopped, at).state;
      for (let attempt = 0; attempt < failures; attempt++) {
        const waiting = advance(state, stopped, ++at).state;
        expect(waiting.phase).toBe("waiting");
        expect(waiting.startDueAt).not.toBeNull();
        at = waiting.startDueAt ?? at;
        state = restored(advance(waiting, stopped, at).state);
      }
      expect(state.failedStarts).toBe(failures);
      // Use nearly every stage's allowance. Prior failed attempts must not shorten this start.
      const observations: [number, EntrypointPhase][] = [
        [at, "starting"],
        [at + T.restoreWaitMs - 1, "restoring"],
        [at + T.restoreWaitMs - 1, "initializing"],
        [at + T.restoreWaitMs + T.appStartWaitMs - 2, "initializing"],
        [at + T.restoreWaitMs + T.appStartWaitMs - 2, "running"],
        [at + WHOLE_START - 3, "running"],
      ];
      for (const [time, phase] of observations) {
        const result = advance(state, observation(phase, 0), time);
        expect(result.effects.some((effect) => effect.type === "stop")).toBe(false);
        state = restored(result.state);
      }
      const healthy = advance(state, ANSWERING, at + WHOLE_START - 2);
      expect(healthy.state).toMatchObject({ phase: "idle", failedStarts: 0 });
    },
  );

  it.each(phases)("keeps the full fourth renewal's %s allowance", (phase) => {
    const state = lastPermittedBoot(phase);
    const deadline = LAST_RENEWAL + budget(phase);
    expect(advance(state, observation(phase, 4), deadline - 1).state.phase).toBe("starting");
    expect(advance(state, observation(phase, 4), deadline).state.phase).toBe("stopping");
  });

  it.each(phases)("does not renew %s at or beyond the fifth unseen reboot", (phase) => {
    const state = lastPermittedBoot(phase);
    const exhausted = advance(state, observation(phase, 5), LAST_RENEWAL + REBOOT_MS);
    expect(exhausted.state.failedStarts).toBe(5);
    expect(exhausted.state.phaseSince).toBe(LAST_RENEWAL);
    const deadline = LAST_RENEWAL + budget(phase);
    const before = advance(restored(exhausted.state), observation(phase, 6), deadline - 1);
    expect(before.state.phase).toBe("starting");
    for (const at of [deadline, deadline + 1]) {
      const result = advance(restored(before.state), observation(phase, 7), at);
      expect(result.effects.some((effect) => effect.type === "stop")).toBe(true);
    }
  });

  it.each([...phases, null])(
    "caps a late first observation of %s after renewal exhaustion",
    (phase) => {
      const state = lastPermittedBoot("restoring");
      const exhausted = advance(state, observation("restoring", 5), LAST_RENEWAL + REBOOT_MS);
      const deadline = LAST_RENEWAL + WHOLE_START;
      // While unreadable, the app could legitimately still be using the remaining stages.
      const before = advance(restored(exhausted.state), observation(null, 5), deadline - 1);
      expect(before.state.phase).toBe("starting");
      for (const at of [deadline, deadline + 1]) {
        const result = advance(restored(before.state), observation(phase, 6), at);
        expect(result.effects.some((effect) => effect.type === "stop")).toBe(true);
      }
    },
  );

  it.each(["initializing", "running"] as const)(
    "keeps the %s deadline through a later boot phase",
    (phase) => {
      const state = lastPermittedBoot(phase);
      const reboot = advance(state, observation("starting", 5), LAST_RENEWAL + REBOOT_MS);
      // A later poll sees the replacement's app; the old phase clock must not have been cleared.
      const result = advance(
        restored(reboot.state),
        observation(phase, 5),
        LAST_RENEWAL + budget(phase),
      );
      expect(result.effects.some((effect) => effect.type === "stop")).toBe(true);
    },
  );

  it("bounds arbitrary phase changes and unreadable status after the renewals are exhausted", () => {
    const initial = advance(
      lastPermittedBoot("restoring"),
      observation("restoring", 5),
      LAST_RENEWAL + REBOOT_MS,
    ).state;
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...phases, null), { minLength: 200, maxLength: 200 }),
        (observations) => {
          let state = restored(initial);
          const start = LAST_RENEWAL + REBOOT_MS;
          for (const [index, phase] of observations.entries()) {
            const at = start + (index + 1) * 20_000;
            const result = advance(state, observation(phase, index + 6), at);
            if (result.effects.some((effect) => effect.type === "stop")) {
              return at <= LAST_RENEWAL + WHOLE_START + 20_000;
            }
            state = restored(result.state);
          }
          return false;
        },
      ),
      { seed: 20261024, numRuns: 1000 },
    );
  });

  it("still protects recovery mode and accepts a healthy answer after renewal exhaustion", () => {
    const exhausted = advance(
      lastPermittedBoot("restoring"),
      observation("restoring", 5),
      LAST_RENEWAL + REBOOT_MS,
    ).state;
    const late = LAST_RENEWAL + WHOLE_START + 1;
    const healthy = advance(exhausted, ANSWERING, late);
    expect(healthy.state).toMatchObject({ phase: "idle", failedStarts: 0 });
    expect(healthy.effects.some((effect) => effect.type === "stop")).toBe(false);
    const recovery = advance(
      exhausted,
      {
        kind: "silent",
        entrypoint: {
          phase: "recovery",
          bootId: "a".repeat(32),
          recovery: { reason: "replica_empty", transient: false },
        },
      },
      late,
    );
    const unreadable = advance(
      restored(recovery.state),
      observation(null, 6),
      late + 4 * 3_600_000,
    );
    expect(
      [...recovery.effects, ...unreadable.effects].some((effect) =>
        ["stop", "start", "destroy"].includes(effect.type),
      ),
    ).toBe(false);
  });
});
