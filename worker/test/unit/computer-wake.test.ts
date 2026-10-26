// WorkspaceDO's controller: waking a computer, its start claims and generation fencing (WP3.1).
// Run whole in the simulation: the real controller, a simulated computer and supervisor, a fake
// ControlDO, and Omnigent's launcher client.
import { describe, expect, it } from "vitest";
import { CMP, ComputerSim, HOST, live, propsOf } from "../support/computer-sim.ts";

const OTHER_HOST = "0123456789abcdef0123456789abcdef";

describe("waking a computer", () => {
  it("records a computer at the default size, idempotently by name", async () => {
    const sim = new ComputerSim();
    const first = await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    const again = await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    expect(first).toEqual({ operation: "provision", computerId: CMP });
    expect(again).toEqual(first);
    expect(sim.record().size).toBe("standard-2");
    expect(await sim.client.refusal(sim.client.provisionRequest("managed-00000000"))).toBe(
      "conflict",
    );
  });

  it("answers an unprovisioned computer: not found, and terminate as absent", async () => {
    const sim = new ComputerSim();
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("not_found");
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "absent",
    });
  });

  it("restores, then confirms, then hands the host its start once, in that order", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const commands = sim.sup?.commands.map((c) => c.type) ?? [];
    expect(commands.indexOf("restore_workspace")).toBeLessThan(
      commands.indexOf("install_credentials"),
    );
    expect(commands.indexOf("install_credentials")).toBeLessThan(commands.indexOf("start_host"));
    expect(commands.filter((c) => c === "start_host")).toHaveLength(1);
    // Intercepts before the start, with the generation in their props; refreshed once the host ID
    // is known.
    const ops = sim.computer.ops;
    expect(ops.indexOf("intercept:computer.internal")).toBeLessThan(ops.indexOf("start"));
    const props = sim.computer.intercepts.map(
      (i) => (i.target as unknown as { props: unknown }).props,
    );
    expect(props[0]).toEqual({ propsVersion: 1, computerId: CMP, generation: 1, hostId: null });
    expect(props.at(-1)).toEqual({ propsVersion: 1, computerId: CMP, generation: 1, hostId: HOST });
    expect(sim.computer.starts).toEqual([
      {
        instance: "standard-2",
        env: { CFO_COMPUTER_ID: CMP, CFO_GENERATION: "1" },
        refused: false,
      },
    ]);
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(sim.check()).toEqual([]);
  });

  it("answers a resume while starting or up without a second start, and reports the typed status", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    expect(await sim.call(sim.client.statusRequest())).toEqual({
      operation: "status",
      running: false,
      status: "stopped",
      generation: 0,
    });
    const first = await sim.call(sim.client.resumeRequest());
    expect(first).toEqual({ operation: "resume", outcome: "starting", generation: 1 });
    expect(await sim.call(sim.client.resumeRequest())).toEqual({
      operation: "resume",
      outcome: "running",
      generation: 1,
    });
    expect(await sim.call(sim.client.statusRequest())).toEqual({
      operation: "status",
      running: true,
      status: "started_no_host",
      generation: 1,
    });
    expect(await sim.call(sim.client.admissionRequest())).toEqual({
      operation: "admission",
      admitting: true,
      status: "started_no_host",
      generation: 1,
    });
    expect(sim.computer.starts).toHaveLength(1);
    expect(sim.control.calls.filter((c) => c.method === "reserve")).toHaveLength(1);
  });

  it("retries a start refused right after a stop under one generation and reservation (DC-37, FH-21)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.refuseStarts = 3;
    await sim.call(sim.client.resumeRequest());
    await sim.advance(120_000);
    expect(sim.computer.starts.map((s) => [s.env.CFO_GENERATION, s.refused])).toEqual([
      ["1", true],
      ["1", true],
      ["1", true],
      ["1", false],
    ]);
    expect(sim.control.calls.filter((c) => c.method === "reserve")).toHaveLength(1);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    expect(sim.record().reservation).toMatchObject({
      generation: 1,
      phase: "running",
      fenced: false,
    });
    // The retries came after 5, 10 and 20 s, each after the 10 s detection window.
    expect(sim.logs.filter((l) => l.event === "unexpected_stop")).toHaveLength(0);
  });

  it("gives a start up after its retries, fences it, releases its slot and records no unexpected stop (FH-22)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.refuseForever = true;
    await sim.call(sim.client.resumeRequest());
    await sim.advance(300_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("failed");
    expect(sim.computer.starts).toHaveLength(5);
    expect(r.reservation).toBeNull();
    expect(sim.control.slots.size).toBe(0);
    expect(r.unexpectedStopAt).toBeNull();
    expect(sim.logs.some((l) => l.event === "start_failed")).toBe(true);
    // A late container of the fenced generation is destroyed, never used (FH-03).
    sim.computer.refuseForever = false;
    sim.computer.running = true;
    const hello = {
      type: "hello" as const,
      protocolVersion: 1,
      computerId: CMP,
      generation: 1,
      operationId: "op_00000000000000000000000009",
      supervisorVersion: "late",
    };
    await expect(sim.deliver(hello)).rejects.toThrow(/stale_generation/);
    await sim.settle();
    expect(sim.computer.running).toBe(false);
    expect(sim.check()).toEqual([]);
    // The next wake starts a new generation.
    expect(await sim.call(sim.client.resumeRequest())).toMatchObject({
      outcome: "starting",
      generation: 2,
    });
  });

  it("refuses a wake at the limit at once with a readable reason, starting nothing (FH-20, R-20)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.control.maxAwakeComputers = 0;
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("at_capacity");
    expect(sim.computer.starts).toHaveLength(0);
    expect(sim.record().lifecycle.context.state).toBe("provisioned");
    sim.control.maxAwakeComputers = 2;
    expect(await sim.call(sim.client.resumeRequest())).toMatchObject({ outcome: "starting" });
    expect(sim.check()).toEqual([]);
  });

  it("fails a wake visibly while ControlDO is unavailable, and releases what it may have taken (FH-37)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.control.unavailable = true;
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("unavailable");
    expect(sim.record().releases).toHaveLength(1);
    sim.control.unavailable = false;
    await sim.advance(60_000);
    expect(sim.record().releases).toHaveLength(0);
    expect(sim.control.calls.filter((c) => c.method === "release")).toHaveLength(1);
    expect(await sim.call(sim.client.resumeRequest())).toMatchObject({
      outcome: "starting",
      generation: 2,
    });
  });

  it("keeps an awake computer running while ControlDO is unavailable, retrying its release after a stop (FH-37)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    sim.control.unavailable = true;
    sim.computer.stopByPlatform();
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("stopped");
    expect(sim.record().releases).toHaveLength(1);
    await sim.advance(5 * 60_000);
    expect(sim.record().releases).toHaveLength(1);
    sim.control.unavailable = false;
    await sim.advance(60_000);
    expect(sim.record().releases).toHaveLength(0);
    expect(sim.control.slots.size).toBe(0);
  });

  it("starts at the chosen size, within the installation's maximum", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    const set = await sim.controller.pages({
      action: "set_size",
      interfaceVersion: 1,
      operationId: "op_00000000000000000000000001",
      size: "standard-4",
    });
    expect(set).toEqual({ action: "set_size", appliesAt: "next_start" });
    sim.control.maxInstanceSize = "standard-3";
    await sim.call(sim.client.resumeRequest());
    expect(sim.computer.starts[0]?.instance).toBe("standard-3");
    expect(sim.record()).toMatchObject({
      size: "standard-3",
      nextSize: null,
      maxSize: "standard-3",
    });
  });

  it("stops a container still without a host after the 300 s start deadline, as a planned stop", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(299_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    await sim.advance(5_000);
    await sim.advance(60_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("asleep");
    expect(r.stop).toMatchObject({ reason: "start_deadline" });
    expect(r.unexpectedStopAt).toBeNull();
    expect(sim.computer.running).toBe(false);
    expect(sim.control.slots.size).toBe(0);
    // It saved first: the sleep checkpoints ran.
    expect(sim.sup).toBeNull();
    expect(sim.computer.supervisors[0]?.commands.map((c) => c.type)).toContain(
      "credential_snapshot",
    );
  });

  it("leaves a computer without a host running past the deadline while its setup terminal is open", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    await sim.controller.setTerminal(true, sim.now + 20 * 60_000);
    await sim.advance(10 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    await sim.advance(15 * 60_000);
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
  });

  it("fails a start whose restore fails, stopping the container (FH-07's restore side)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.checkpointRequest());
    const sleep = sim.client.suspendRequest();
    live(sim).runnerProcesses = 0;
    await sim.call(sleep);
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    sim.computer.supervisorOptions = { failRestores: 1 };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("failed");
    expect(sim.computer.running).toBe(false);
    expect(sim.record().unexpectedStopAt).toBeNull();
    sim.computer.supervisorOptions = {};
    await sim.call(sim.client.resumeRequest());
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    expect(sim.check()).toEqual([]);
  });
});

describe("start claims (G1BR-005)", () => {
  it("grants a claim only from the parked states, refusing it from host_running and stopping", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    expect(await sim.call(sim.client.claimRequest())).toEqual({
      operation: "claim_start",
      granted: false,
      status: "stopped",
    });
    await sim.running();
    expect(await sim.call(sim.client.claimRequest())).toEqual({
      operation: "claim_start",
      granted: false,
      status: "host_running",
    });
    live(sim).refuseHost();
    await sim.settle();
    expect(sim.record().lifecycle.context.state).toBe("host_refused");
    expect(await sim.call(sim.client.statusRequest())).toMatchObject({ status: "host_refused" });
    const claim = await sim.call(sim.client.claimRequest());
    expect(claim).toEqual({ operation: "claim_start", granted: true, startAttempt: 2 });
    // Supersede it, then try to sleep: a sleep being prepared refuses claims as stopping.
    live(sim).runnerProcesses = 0;
    live(sim).options.holdCredentials = true;
    await sim.call(sim.client.suspendRequest());
    expect(await sim.call(sim.client.claimRequest())).toEqual({
      operation: "claim_start",
      granted: false,
      status: "stopping",
    });
  });

  it("returns a repeated claim's recorded attempt, also after the controller restarts", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    const request = sim.client.claimRequest();
    const first = await sim.call(request);
    await sim.restart();
    expect(await sim.call(request)).toEqual(first);
    expect(sim.record().lifecycle.attempt).toBe(1);
    // An operation ID reused for another request is refused.
    expect(
      await sim.client.refusal({
        ...sim.client.statusRequest(),
        operation: "claim_start",
        operationId: request.operationId,
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4",
      } as never),
    ).toBe("bad_request");
  });

  it("refuses a delayed start_host for a superseded attempt, in either order", async () => {
    for (const order of ["old-first", "new-first"] as const) {
      const sim = new ComputerSim();
      await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
      await sim.call(sim.client.resumeRequest());
      await sim.advance(1000);
      const old = await sim.call(sim.client.claimRequest());
      const fresh = await sim.call(sim.client.claimRequest());
      if (
        old.operation !== "claim_start" ||
        !old.granted ||
        fresh.operation !== "claim_start" ||
        !fresh.granted
      )
        throw new Error("claims");
      const oldStart = sim.client.startRequest({
        attempt: old.startAttempt,
        token: sim.token(1),
        hostId: HOST,
      });
      const newStart = sim.client.startRequest({
        attempt: fresh.startAttempt,
        token: sim.token(2),
        hostId: HOST,
      });
      if (order === "old-first") {
        expect(await sim.client.refusal(oldStart)).toBe("conflict");
        expect(await sim.call(newStart)).toMatchObject({ operation: "start_host" });
      } else {
        expect(await sim.call(newStart)).toMatchObject({ operation: "start_host" });
        expect(await sim.client.refusal(oldStart)).toBe("conflict");
      }
      await sim.settle();
      expect(sim.sup?.host).toMatchObject({ state: "running", attempt: fresh.startAttempt });
      expect(sim.sup?.token).toBe(sim.tokens[1]);
      expect(sim.sup?.commands.filter((c) => c.type === "start_host")).toHaveLength(1);
      expect(sim.check()).toEqual([]);
    }
  });

  it("counts handed-out parameters as a live incarnation until the supervisor declines or refuses them", async () => {
    const sim = new ComputerSim();
    const attempt = await sim.running();
    // A report showing no attempt (sent before the parameters arrived) changes nothing.
    live(sim).host = { state: "not_started", attempt: null, restarts: 0 };
    live(sim).report();
    await sim.settle();
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    // A report about an older attempt is ignored too.
    live(sim).host = { state: "refused", attempt: attempt - 1 || 99, restarts: 0 };
    live(sim).report();
    await sim.settle();
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    // The current attempt refused: parked, claimable.
    live(sim).host = { state: "running", attempt, restarts: 0 };
    live(sim).refuseHost();
    await sim.settle();
    expect(sim.record().lifecycle.context.state).toBe("host_refused");
  });

  it("treats a declined start as unclaimed: the next claim supersedes it", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.supervisorOptions = { declineStarts: 1 };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    await sim.call(
      sim.client.startRequest({ attempt: claim.startAttempt, token: sim.token(1), hostId: HOST }),
    );
    expect(sim.record().lifecycle.context.state).toBe("start_claimed");
    expect(sim.store.get("launch-token")).toBeUndefined();
    const again = await sim.call(sim.client.claimRequest());
    if (again.operation !== "claim_start" || !again.granted) throw new Error("claim");
    await sim.call(
      sim.client.startRequest({ attempt: again.startAttempt, token: sim.token(2), hostId: HOST }),
    );
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(sim.sup?.host.attempt).toBe(again.startAttempt);
  });

  it("refuses a start for another host ID: two hosts never share a computer", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).refuseHost();
    await sim.settle();
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    expect(
      await sim.client.refusal(
        sim.client.startRequest({
          attempt: claim.startAttempt,
          token: sim.token(9),
          hostId: OTHER_HOST,
        }),
      ),
    ).toBe("conflict");
    expect(sim.record().hostId).toBe(HOST);
  });

  it("keeps the launch token only until the supervisor has it, and never in the journal or logs", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    const token = sim.token(1);
    // Before the restore is confirmed the parameters wait, the token under its own key only.
    await sim.client.send(
      sim.client.startRequest({ attempt: claim.startAttempt, token, hostId: HOST }),
    );
    expect(sim.store.dump()).toContain(token);
    expect(sim.check()).toEqual([]);
    await sim.advance(10_000);
    expect(sim.sup?.token).toBe(token);
    expect(sim.store.dump()).not.toContain(token);
    expect(JSON.stringify(sim.logs)).not.toContain(token);
  });
});

describe("generations and new instances", () => {
  it("refuses computer API calls from another computer or an older generation", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const old = {
      type: "hello" as const,
      protocolVersion: 1,
      computerId: CMP,
      generation: 0,
      operationId: "op_00000000000000000000000009",
      supervisorVersion: "x",
    };
    const call = (props: object, message: object) =>
      sim.controller.computer({
        interfaceVersion: 1,
        props: { propsVersion: 1, computerId: CMP, generation: 1, hostId: HOST, ...props },
        message,
      });
    await expect(call({ generation: 0 }, old)).rejects.toThrow(/stale_generation/);
    await expect(call({}, old)).rejects.toThrow(/stale_generation/);
    await expect(
      call({ computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" }, { ...old, generation: 1 }),
    ).rejects.toThrow(/stale_generation/);
    await expect(call({ propsVersion: 2 }, { ...old, generation: 1 })).rejects.toThrow(
      /unsupported_version/,
    );
    await expect(call({}, { ...old, generation: 1, protocolVersion: 2 })).rejects.toThrow(
      /unsupported_version/,
    );
    await expect(
      sim.controller.computer({ interfaceVersion: 2, props: {}, message: {} }),
    ).rejects.toThrow(/bad_request/);
    await expect(call({}, { ...old, generation: 1 })).resolves.toEqual({
      type: "hello",
      protocolVersion: 1,
    });
  });

  it("re-arms the inactivity timeout and re-registers the intercepts in every new instance", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const before = sim.computer.intercepts.length;
    const timeouts = sim.computer.inactivityTimeouts.length;
    await sim.restart();
    await sim.settle();
    expect(sim.computer.inactivityTimeouts.length).toBe(timeouts + 1);
    expect(sim.computer.inactivityTimeouts.at(-1)).toBe(45 * 60_000);
    expect(sim.computer.intercepts.length).toBe(before + 2);
    expect(propsOf(sim.computer.intercepts.at(-1))).toEqual({
      propsVersion: 1,
      computerId: CMP,
      generation: 1,
      hostId: HOST,
    });
    // And 45 minutes ahead at every heartbeat.
    await sim.advance(3 * 60_000);
    expect(sim.computer.inactivityTimeouts.length).toBeGreaterThanOrEqual(timeouts + 4);
    expect(sim.computer.running).toBe(true);
  });

  it("repeats a command after 'Network connection lost.' and carries on (S3)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.dropRequests = { count: 2, when: "after" };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    const types = sim.sup?.commands.map((c) => c.type) ?? [];
    expect(types.filter((t) => t === "restore_workspace").length).toBeGreaterThanOrEqual(2);
    sim.computer.dropRequests = { count: 2, when: "before" };
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    await sim.call(
      sim.client.startRequest({ attempt: claim.startAttempt, token: sim.token(1), hostId: HOST }),
    );
    await sim.advance(5000);
    expect(sim.sup?.host.state).toBe("running");
  });

  it("refuses calls for another computer and unsupported versions before any effect", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    const resume = sim.client.resumeRequest();
    await expect(sim.controller.launcher({ interfaceVersion: 2, request: resume })).rejects.toThrow(
      /unsupported_version/,
    );
    await expect(
      sim.controller.launcher({ interfaceVersion: 1, request: { ...resume, protocolVersion: 2 } }),
    ).rejects.toThrow(/unsupported_version/);
    await expect(
      sim.controller.launcher({
        interfaceVersion: 1,
        request: { ...resume, computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" },
      }),
    ).rejects.toThrow(/bad_request/);
    await expect(
      sim.controller.launcher({ interfaceVersion: 1, request: { operation: "resume" } }),
    ).rejects.toThrow(/bad_request/);
    expect(sim.computer.starts).toHaveLength(0);
    expect(
      await sim.call({
        operation: "prepare",
        protocolVersion: 1,
        operationId: sim.client.operationId(),
      }),
    ).toEqual({ operation: "prepare", supportedProtocolVersions: [1] });
  });
});
