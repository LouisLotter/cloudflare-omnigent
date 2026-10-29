// WP3.33, the controller's part of the G3 sitting's tools: the staging-only kill (step K: VD-12 B
// and D, UJ6, RC-16) and the lines the wake-time table reads (`container_start`, `start_retry`,
// `stop_confirmed`, `start_delivered`'s generation).
import { WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { WorkspaceController } from "../../src/computer/controller.ts";
import { CMP, ComputerSim, HOST, live } from "../support/computer-sim.ts";
import { FakeControl } from "../support/fake-control.ts";
import { MemoryStore } from "../support/memory-store.ts";

const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };

function events(sim: ComputerSim, event: string) {
  return sim.logs.filter((l) => l.event === event).map((l) => l.fields);
}

describe("the staging kill (WP3.33)", () => {
  it("is refused on production before anything happens: nothing stored, the container runs on", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const before = sim.store.dump();
    const stops = sim.computer.stops.length;
    expect(await sim.controller.stagingKill(call)).toEqual({
      outcome: "refused",
      reason: "not_staging",
    });
    expect(sim.store.dump()).toBe(before);
    expect(sim.computer.running).toBe(true);
    expect(sim.computer.stops).toHaveLength(stops);
    expect(events(sim, "staging_kill")).toEqual([]);
    // The computer carries on: no unexpected stop at its next heartbeats.
    await sim.advance(5 * 60_000);
    expect(sim.record().unexpectedStopAt).toBeNull();
    expect(sim.record().lifecycle.context.state).toBe("host_running");
  });

  it("kills a staging computer's container as a crash would: no stop intent, no save, then an unexpected stop", async () => {
    const sim = new ComputerSim({ staging: true });
    await sim.running();
    const before = sim.store.dump();
    const saves = live(sim).commands.filter((c) => c.type === "capture").length;
    expect(await sim.controller.stagingKill(call)).toEqual({
      outcome: "killed",
      generation: 1,
      hostId: HOST,
    });
    // Nothing written: the runner has not seen it yet, exactly as after a real crash.
    expect(sim.store.dump()).toBe(before);
    expect(sim.computer.running).toBe(false);
    expect(sim.computer.stops.at(-1)).toMatchObject({ by: "destroy", generation: "1" });
    expect(sim.computer.stops.at(-1)?.reason).toContain("staging kill");
    expect(events(sim, "staging_kill")).toEqual([
      { computerId: CMP, generation: 1, state: "host_running" },
    ]);
    // No save was asked of the dying container.
    expect(sim.computer.supervisors[0]?.commands.filter((c) => c.type === "capture")).toHaveLength(
      saves,
    );
    // A second kill finds nothing to kill.
    expect(await sim.controller.stagingKill(call)).toEqual({
      outcome: "refused",
      reason: "not_running",
    });
    // The next heartbeat, in a new instance, finds the container gone: an unexpected stop.
    await sim.restart();
    await sim.advance(sim.timing.heartbeatMs + 1);
    const r = sim.record();
    expect(r.unexpectedStopAt).not.toBeNull();
    expect(r.stop).toMatchObject({ generation: 1, reason: "unexpected" });
    expect(events(sim, "unexpected_stop")).toHaveLength(1);
    expect(events(sim, "stop_confirmed")).toEqual([]);
    expect(sim.check()).toEqual([]);
  });

  it("is refused without a container port, and for an interface version it does not know", async () => {
    const controller = new WorkspaceController({
      computerId: CMP,
      store: new MemoryStore(),
      port: null,
      control: new FakeControl(),
      bucket: null,
      clock: () => Date.UTC(2026, 9, 29),
      alarm: { set: () => undefined, clear: () => undefined },
      newId: (prefix) => `${prefix}_${"0".repeat(26)}`,
      deadline: () => ({ signal: new AbortController().signal, clear: () => undefined }),
      intercepts: () => [],
      log: () => undefined,
      stagingChecks: true,
    });
    expect(await controller.stagingKill(call)).toEqual({
      outcome: "refused",
      reason: "no_container",
    });
    await expect(
      controller.stagingKill({ interfaceVersion: WORKSPACE_INTERFACE_VERSION + 1 }),
    ).rejects.toThrow(/interface version/);
  });

  it("is refused for a computer with no record, whose container cannot run", async () => {
    const sim = new ComputerSim({ staging: true });
    expect(await sim.controller.stagingKill(call)).toEqual({
      outcome: "refused",
      reason: "not_running",
    });
  });
});

describe("the wake table's lines (WP3.33)", () => {
  it("logs each container start, each start Cloudflare refused and retried, and the delivery's generation", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.refuseStarts = 2;
    await sim.call(sim.client.resumeRequest());
    await sim.advance(120_000);
    expect(events(sim, "container_start")).toEqual([
      { computerId: CMP, generation: 1, refusals: 0, size: "standard-2" },
      { computerId: CMP, generation: 1, refusals: 1, size: "standard-2" },
      { computerId: CMP, generation: 1, refusals: 2, size: "standard-2" },
    ]);
    expect(events(sim, "start_retry").map((f) => [f.generation, f.refusals])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    for (const retry of events(sim, "start_retry")) expect(retry.delayMs).toBeGreaterThan(0);
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim refused");
    await sim.call(
      sim.client.startRequest({ attempt: claim.startAttempt, token: sim.token(1), hostId: HOST }),
    );
    await sim.advance(sim.timing.pollMs);
    expect(events(sim, "start_delivered")).toEqual([
      { computerId: CMP, generation: 1, attempt: 1, outcome: "taken" },
    ]);
  });

  it("logs a confirmed stop with its generation and reason, once", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    expect(await sim.client.send(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    await sim.advance(10_000);
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    expect(events(sim, "stop_confirmed")).toEqual([
      { computerId: CMP, generation: 1, reason: "sleep" },
    ]);
  });
});
