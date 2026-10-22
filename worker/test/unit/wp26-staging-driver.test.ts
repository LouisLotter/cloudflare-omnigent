// WP2.6's staging run driver (worker/test/staging/wp26/driver.ts): one tick at a time however
// it is called (Codex WP2.6 r1-3), and a kill that counts only once its destroy returned
// (Codex WP2.6 r1-4).
import { describe, expect, it } from "vitest";
import { RunDriver, type RunPorts } from "../staging/wp26/driver.ts";
import { INITIAL_RUN, LIMITS, type Observed, type RunState } from "../staging/wp26/plan.ts";

const T0 = Date.parse("2026-10-23T08:00:00.000Z");

class FakeWorld {
  stored: RunState | undefined;
  clock = T0;
  destroys = 0;
  ensures = 0;
  failNextDestroy = false;
  observeDelayMs = 0;
  summaries: RunState[] = [];
  observed: Omit<Observed, "now"> = {
    tokenPresent: true,
    seederRunning: true,
    seedResult: null,
    serverLastAnsweredAt: null,
    outages: [],
  };

  ports(): RunPorts {
    return {
      load: async () => this.stored,
      save: async (state) => {
        this.stored = structuredClone(state);
      },
      observe: async () => {
        if (this.observeDelayMs > 0) await new Promise((r) => setTimeout(r, this.observeDelayMs));
        return this.observed;
      },
      now: () => this.clock,
      startSeeder: async () => undefined,
      stopSeeder: async () => undefined,
      ensureServer: async () => {
        this.ensures += 1;
      },
      destroyServer: async () => {
        this.destroys += 1;
        this.clock += 1_500; // the destroy takes its time
        if (this.failNextDestroy) {
          this.failNextDestroy = false;
          throw new Error("destroy failed");
        }
        return { wasRunning: true };
      },
      writeSummary: async (state) => {
        this.summaries.push(state);
      },
      log: () => undefined,
      scheduleNext: async () => undefined,
    };
  }
}

const healthyLongEnough = (): RunState => ({
  ...INITIAL_RUN,
  stage: "healthy",
  runId: "run-x",
  t0: T0 - 600_000,
  firstStartAt: T0 - 500_000,
  firstAnsweredAt: T0 - LIMITS.healthyHoldMs - 1,
});

describe("the WP2.6 staging run driver", () => {
  it("runs overlapping ticks one after the other, so the server is destroyed once (r1-3)", async () => {
    const world = new FakeWorld();
    world.stored = healthyLongEnough();
    world.observeDelayMs = 20;
    const driver = new RunDriver(world.ports());
    await Promise.all([driver.tick(), driver.tick(), driver.tick()]);
    expect(world.destroys).toBe(1);
    expect(world.stored).toMatchObject({ stage: "replacing", killedAt: T0 + 1_500 });
  });

  it("records the kill only once the destroy returned, and sends a failed one again (r1-4)", async () => {
    const world = new FakeWorld();
    world.stored = healthyLongEnough();
    world.failNextDestroy = true;
    const driver = new RunDriver(world.ports());
    await driver.tick();
    expect(world.destroys).toBe(1);
    expect(world.stored).toMatchObject({ stage: "replacing", killRequestedAt: T0, killedAt: null });
    world.clock += 15_000;
    await driver.tick();
    expect(world.destroys).toBe(2);
    const killedAt = world.stored?.killedAt;
    expect(killedAt).toBe(world.clock); // the second destroy's return, the measurement's origin
    // An answer that the kill's outage did not end is not the replacement's.
    world.observed = {
      ...world.observed,
      outages: [{ detectedAt: (killedAt ?? 0) - 10_000, endedAt: (killedAt ?? 0) - 5_000 }],
    };
    await driver.tick();
    expect(world.stored?.stage).toBe("replacing");
    world.observed = {
      ...world.observed,
      outages: [{ detectedAt: (killedAt ?? 0) + 5_000, endedAt: (killedAt ?? 0) + 300_000 }],
    };
    await driver.tick();
    expect(world.stored).toMatchObject({
      stage: "done",
      failure: null,
      replacedAnsweredAt: (killedAt ?? 0) + 300_000,
      summaryWritten: true,
    });
    expect(world.summaries).toHaveLength(1);
  });

  it("sends the destroy again after the object was reset around it", async () => {
    const world = new FakeWorld();
    // Stored before the destroy, which never returned: the object was reset meanwhile.
    world.stored = { ...healthyLongEnough(), stage: "replacing", killRequestedAt: T0 - 5_000 };
    await new RunDriver(world.ports()).tick(); // a new instance
    expect(world.destroys).toBe(1);
    expect(world.stored?.killedAt).toBe(T0 + 1_500);
  });

  it("does nothing more once the summary is written", async () => {
    const world = new FakeWorld();
    world.stored = { ...INITIAL_RUN, stage: "done", runId: "run-x", summaryWritten: true };
    await new RunDriver(world.ports()).tick();
    expect(world.ensures + world.destroys + world.summaries.length).toBe(0);
  });
});
