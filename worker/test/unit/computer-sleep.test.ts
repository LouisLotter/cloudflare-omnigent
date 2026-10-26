// WorkspaceDO's controller: the fenced sleep's platform side (Lifecycle step 7), stop records,
// "stop without saving" (FH-35) and the rule that WorkspaceDO never stops a computer on its own.
import { describe, expect, it } from "vitest";
import { ComputerSim, Crash, HOST, live } from "../support/computer-sim.ts";

async function sleeping(sim: ComputerSim): Promise<string> {
  live(sim).runnerProcesses = 0;
  const request = sim.client.suspendRequest();
  const first = await sim.client.send(request);
  expect(first).toEqual({ operation: "suspend", outcome: "in_progress" });
  return request.operationId;
}

describe("suspend", () => {
  it("prepares the sleep, reports it in progress, then stopped; a repeat returns the outcome", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude");
    await sim.settle();
    live(sim).runnerProcesses = 0;
    const request = sim.client.suspendRequest();
    expect(await sim.client.send(request)).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    expect(await sim.client.send(request)).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    expect(await sim.call(sim.client.statusRequest())).toMatchObject({
      status: "stopping",
      running: true,
    });
    await sim.advance(10_000);
    expect(await sim.client.send(request)).toEqual({ operation: "suspend", outcome: "stopped" });
    await sim.restart();
    expect(await sim.client.send(request)).toEqual({ operation: "suspend", outcome: "stopped" });
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("asleep");
    expect(r.stop).toMatchObject({ generation: 1, reason: "sleep" });
    expect(r.stop?.confirmedAt).not.toBeNull();
    expect(r.unexpectedStopAt).toBeNull();
    // The sleep checkpoint and the final credential barrier ran before the stop.
    const types = sim.computer.supervisors[0]?.commands.map((c) => c.type) ?? [];
    expect(types.lastIndexOf("capture")).toBeLessThan(types.lastIndexOf("credential_snapshot"));
    expect(r.credential?.generation).toBe(1);
    expect(r.workspace).not.toBeNull();
    expect(sim.control.slots.size).toBe(0);
    expect(sim.check()).toEqual([]);
  });

  it("refuses while a capture runs, leaving the computer running", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).options.capturePolls = 10;
    await sim.call(sim.client.checkpointRequest());
    expect(sim.record().lifecycle.context.capturing).toBe(true);
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "capture_running",
    });
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(sim.computer.running).toBe(true);
  });

  it("refuses with the setup terminal open, leaving the computer running", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    await sim.controller.setTerminal(true);
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "terminal_open",
    });
    await sim.controller.setTerminal(false);
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
  });

  it("refuses with a runner process reported, checking through the supervisor now", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    live(sim).report();
    await sim.settle();
    live(sim).runnerProcesses = 1; // A runner launched since the last report.
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "runner_processes",
    });
    expect(sim.computer.running).toBe(true);
  });

  it("refuses when it cannot tell whether runner processes exist", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    sim.computer.dropRequests = { count: 100, when: "before" };
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "runner_processes",
    });
    sim.computer.dropRequests = { count: 0, when: "before" };
  });

  it("keeps the computer running when the final credential checkpoint cannot be published", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("codex");
    await sim.settle();
    live(sim).refreshUnpublished("codex");
    sim.bucket.blocked = true;
    const id = await sleeping(sim);
    await sim.advance(5 * 60_000);
    const refused = await sim.call({ ...sim.client.suspendRequest(id) });
    expect(refused).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "credentials_unpublished",
    });
    const r = sim.record();
    expect(r.lifecycle.context).toMatchObject({ state: "host_running", stopPrep: null });
    expect(sim.computer.running).toBe(true);
    expect(sim.computer.plannedStops()).toHaveLength(0);
    expect(r.refusedSleeps).toBe(1);
  });

  it("runs a resume that arrives while stopping once the stop is confirmed, and starts once", async () => {
    const sim = new ComputerSim();
    await sim.running();
    let open: () => void = () => undefined;
    sim.computer.destroyGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await sleeping(sim);
    await sim.until(() => sim.record().lifecycle.context.state === "stopping");
    // The slot is still held while stopping (VD-12 E: released only after the stop is confirmed).
    expect([...sim.control.slots]).toEqual([`${sim.computer.computerId}/1`]);
    expect(await sim.client.send(sim.client.resumeRequest())).toMatchObject({
      outcome: "after_stop",
      generation: 1,
    });
    expect(await sim.client.send(sim.client.resumeRequest())).toMatchObject({
      outcome: "after_stop",
    });
    sim.computer.destroyGate = null;
    open();
    await sim.advance(5_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("started_no_host");
    expect(r.lifecycle.generation).toBe(2);
    expect(sim.computer.starts.map((s) => s.env.CFO_GENERATION)).toEqual(["1", "2"]);
    expect([...sim.control.slots]).toEqual([`${sim.computer.computerId}/2`]);
    expect(sim.check()).toEqual([]);
  });

  it("goes to sleep when a queued wake finds the installation full", async () => {
    const sim = new ComputerSim();
    await sim.running();
    let open: () => void = () => undefined;
    sim.computer.destroyGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await sleeping(sim);
    await sim.until(() => sim.record().lifecycle.context.state === "stopping");
    await sim.client.send(sim.client.resumeRequest());
    sim.control.maxAwakeComputers = 1;
    sim.control.slots.add("cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/7");
    sim.computer.destroyGate = null;
    open();
    await sim.advance(5_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    expect(sim.computer.starts).toHaveLength(1);
  });

  it("stops after a crash between persisting the stop intent and the stop", async () => {
    const dry = new ComputerSim();
    await dry.running();
    await sleeping(dry);
    await dry.advance(5_000);
    const at = dry.stepLog.indexOf("destroy:before");
    expect(at).toBeGreaterThan(0);

    const sim = new ComputerSim();
    await sim.running();
    sim.crashAt = at + 1;
    await sleeping(sim);
    await sim.advance(5_000);
    expect(sim.instances).toBe(2);
    await sim.advance(60_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("asleep");
    expect(r.stop).toMatchObject({ reason: "sleep" });
    expect(r.unexpectedStopAt).toBeNull();
    expect(sim.computer.stops.map((s) => s.by)).toEqual(["destroy"]);
    expect(sim.check()).toEqual([]);
  });

  it("records a platform stop without a stop record as unexpected, and a later login as possibly lost", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude", "claude-login-canary-old");
    await sim.settle();
    // A sleep refused (its final credential checkpoint could not be published) leaves the old
    // generation running with a fresh login unpublished...
    live(sim).refreshUnpublished("claude");
    sim.bucket.blocked = true;
    await sleeping(sim);
    await sim.advance(5 * 60_000);
    expect(sim.record()).toMatchObject({
      refusedSleeps: 1,
      lifecycle: { context: { state: "host_running" } },
    });
    // ...which is then lost before the refresh is published.
    live(sim).outbox.length = 0;
    sim.bucket.blocked = false;
    live(sim).report();
    await sim.settle();
    sim.computer.stopByPlatform();
    await sim.advance(60_000);
    let r = sim.record();
    expect(r.lifecycle.context.state).toBe("stopped");
    expect(r.unexpectedStopAt).not.toBeNull();
    expect(r.signOut.loginPossiblyLost).toBe(true);
    expect(sim.control.slots.size).toBe(0);
    // The next wake restores the last published credentials (FH-11) and says the files were
    // restored to an earlier checkpoint.
    await sim.call(sim.client.resumeRequest());
    await sim.advance(5_000);
    r = sim.record();
    expect(r.lifecycle.context.state).toBe("started_no_host");
    expect(sim.sup?.credentials.get(".claude/.credentials.json")).toBe("claude-login-canary-old");
    expect(r.restoredTo).toBe(r.workspace?.cutAt ?? null);
  });

  it("offers and honours stopping without saving after three refused sleeps, still publishing credentials (FH-35)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const page = (action: "stop_without_saving", n: number) =>
      sim.controller.pages({
        interfaceVersion: 1,
        action,
        operationId: `op_0000000000000000000000000${n}`,
      });
    expect(await page("stop_without_saving", 1)).toEqual({
      action: "stop_without_saving",
      outcome: "refused",
      reason: "not_offered",
    });
    for (let i = 0; i < 3; i += 1) {
      live(sim).options.failCaptures = 1;
      const id = await sleeping(sim);
      await sim.advance(10_000);
      expect(await sim.client.send(sim.client.suspendRequest(id))).toEqual({
        operation: "suspend",
        outcome: "refused",
        reason: "checkpoint_failed",
      });
      await sim.advance(10 * 60_000);
    }
    const state = await sim.controller.pages({ interfaceVersion: 1, action: "state" });
    expect(state.action === "state" && state.computer).toMatchObject({
      refusedSleeps: 3,
      stopWithoutSavingOffered: true,
    });
    live(sim).signIn("codex");
    live(sim).options.failCaptures = 5;
    expect(await page("stop_without_saving", 2)).toEqual({
      action: "stop_without_saving",
      outcome: "accepted",
    });
    await sim.advance(10_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("asleep");
    expect(r.stop).toMatchObject({ reason: "without_saving" });
    expect(r.credential?.files[".codex/auth.json"].state).toBe("present");
    // A repeat of the page action returns its recorded outcome.
    expect(await page("stop_without_saving", 2)).toEqual({
      action: "stop_without_saving",
      outcome: "accepted",
    });
  });

  it("restarts from the page through the same checkpoints; Omnigent's next wake starts it (FH-30)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const restart = await sim.controller.pages({
      interfaceVersion: 1,
      action: "restart",
      operationId: "op_00000000000000000000000001",
    });
    expect(restart).toEqual({ action: "restart", outcome: "accepted" });
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "restart",
        operationId: "op_00000000000000000000000002",
      }),
    ).toEqual({ action: "restart", outcome: "refused", reason: "busy" });
    await sim.advance(10_000);
    expect(sim.record()).toMatchObject({
      stop: { reason: "restart" },
      lifecycle: { context: { state: "asleep" } },
    });
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "restart",
        operationId: "op_00000000000000000000000003",
      }),
    ).toEqual({ action: "restart", outcome: "refused", reason: "not_running" });
    expect(await sim.client.wake({ hostId: HOST, token: sim.token(2) })).toBe(2);
  });
});

describe("no autonomous stop (FH-31, VD-12 A and C)", () => {
  it("keeps a computer with live runners running for hours without launcher calls, saving and noting no contact", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 1; // A turn running, or an approval pending.
    live(sim).report();
    live(sim).write("work/notes.md", "v1");
    await sim.settle();
    // Omnigent decides the computer is idle and tries to sleep it: refused, nothing stops.
    for (let i = 0; i < 7; i += 1) {
      expect(await sim.call(sim.client.suspendRequest())).toMatchObject({
        outcome: "refused",
        reason: "runner_processes",
      });
      await sim.advance(60_000);
    }
    await sim.advance(2 * 3_600_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("host_running");
    expect(sim.computer.running).toBe(true);
    expect(sim.computer.stops).toHaveLength(0);
    // The backstop kept saving every 15 minutes, and admission stayed open.
    expect(r.workspace).not.toBeNull();
    expect(r.notSaved).toBeNull();
    const backstops = sim.logs.filter((l) => l.event === "workspace_published").length;
    expect(backstops).toBeGreaterThanOrEqual(1);
    expect(r.unchanged).not.toBeNull();
    const page = await sim.controller.pages({ interfaceVersion: 1, action: "state" });
    expect(page.action === "state" && page.computer).toMatchObject({
      noContact: true,
      status: "host_running",
    });
    // A crash anywhere is not a stop either.
    expect(await sim.guarded(async () => sim.restart())).not.toBeInstanceOf(Crash);
    await sim.advance(60_000);
    expect(sim.computer.running).toBe(true);
  });
});
