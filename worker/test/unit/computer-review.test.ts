// Regression tests for the independent review of WP3.1 (Codex, run 1): each reproduces a finding
// on the code before its fix.
import { describe, expect, it } from "vitest";
import { MAX_PENDING_RELEASES } from "../../src/computer/controller.ts";
import { TOKEN_KEY } from "../../src/computer/record.ts";
import { ComputerSim, Crash, HOST, live } from "../support/computer-sim.ts";
import { digestOf } from "../support/fake-supervisor.ts";

describe("Codex WP3.1 r1", () => {
  it("r1-1: leaves no credential object behind after a crash between its upload and the pointer", async () => {
    const dry = new ComputerSim();
    await dry.running();
    const from = dry.stepLog.length;
    live(dry).signIn("claude");
    await dry.settle();
    const put = dry.stepLog.indexOf("put:after", from);
    expect(put).toBeGreaterThan(0);

    const sim = new ComputerSim();
    await sim.running();
    sim.crashAt = put + 1;
    live(sim).signIn("claude");
    await sim.settle();
    expect(sim.instances).toBe(2);
    expect(sim.check()).toEqual([]);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    await sim.controller.pages({
      interfaceVersion: 1,
      action: "sign_out",
      operationId: "op_00000000000000000000000001",
    });
    await sim.advance(5 * 60_000);
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "resolve_removal",
        operationId: "op_00000000000000000000000002",
      }),
    ).toEqual({ action: "resolve_removal", outcome: "accepted" });
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removed");
    expect([...sim.bucket.objects.keys()]).toEqual([]);
  });

  it("r1-2: stays readable after many failed reservations, asking for none while releases are owed", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.control.unavailable = true;
    for (let i = 0; i < 101; i += 1) {
      expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("unavailable");
    }
    expect(sim.record().releases.length).toBe(MAX_PENDING_RELEASES);
    expect(sim.control.calls.filter((c) => c.method === "reserve")).toHaveLength(0);
    sim.control.unavailable = false;
    await sim.restart();
    await sim.advance(2 * 60_000);
    expect(sim.record().releases).toHaveLength(0);
    expect(await sim.call(sim.client.resumeRequest())).toMatchObject({ outcome: "starting" });
  });

  it("r1-3: records a page action with its effect, so a repeat after a crash never acts again", async () => {
    const sim = new ComputerSim();
    await sim.running();
    sim.crashAt = sim.steps + 2; // Right after the restart's transaction commits.
    const restart = {
      interfaceVersion: 1,
      action: "restart" as const,
      operationId: "op_00000000000000000000000001",
    };
    await expect(sim.controller.pages(restart)).rejects.toBeInstanceOf(Crash);
    // Recovery: the next event builds an instance, which completes the stop.
    expect(await sim.call(sim.client.statusRequest())).toMatchObject({ status: "stopping" });
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    await sim.client.wake({ hostId: HOST, token: sim.token(2) });
    await sim.advance(10_000);
    expect(sim.record()).toMatchObject({
      lifecycle: { generation: 2, context: { state: "host_running" } },
    });
    expect(await sim.controller.pages(restart)).toEqual({ action: "restart", outcome: "accepted" });
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("host_running");
  });

  it("r1-4: refuses a sleep when the supervisor cannot confirm now that no runner exists", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    live(sim).report();
    await sim.settle();
    expect(sim.record().report?.runnerProcesses).toBe(0);
    live(sim).runnerProcesses = 1;
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = async (request) => {
      const body = (await request.clone().json()) as { type: string };
      if (body.type === "status") {
        return Response.json(
          { error: { code: "unavailable", message: "busy", retryable: true } },
          { status: 503 },
        );
      }
      return handler ? handler(request) : new Response("{}");
    };
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "runner_processes",
    });
    expect(sim.computer.running).toBe(true);
  });

  it("r1-5: keeps a newer attempt's token when an older attempt's reply arrives late", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = sim.computer.supervisor;
    let holding = true;
    sim.computer.supervisor = async (request) => {
      const body = (await request.clone().json()) as { type: string; startAttempt?: number };
      const response = handler ? await handler(request) : new Response("{}");
      if (body.type === "start_host" && body.startAttempt === 1 && holding) {
        holding = false;
        await held;
      }
      return response;
    };
    const first = await sim.client.send(sim.client.claimRequest());
    if (first.operation !== "claim_start" || !first.granted) throw new Error("claim");
    await sim.client.send(
      sim.client.startRequest({ attempt: 1, token: sim.token(1), hostId: HOST }),
    );
    await sim.until(() => live(sim).host.attempt === 1);
    // Attempt 1's host is refused; Omnigent claims attempt 2 and starts it, while the reply to
    // attempt 1's hand-out is still on its way.
    live(sim).refuseHost();
    await sim.until(() => sim.record().lifecycle.context.state === "host_refused");
    const second = await sim.client.send(sim.client.claimRequest());
    if (second.operation !== "claim_start" || !second.granted) throw new Error("claim");
    await sim.client.send(
      sim.client.startRequest({ attempt: 2, token: sim.token(2), hostId: HOST }),
    );
    expect(sim.store.get(TOKEN_KEY)).toMatchObject({ attempt: 2 });
    release();
    await sim.advance(10_000);
    expect(sim.logs.some((l) => l.event === "start_parameters_missing")).toBe(false);
    expect(live(sim).host).toMatchObject({ state: "running", attempt: 2 });
    expect(live(sim).token).toBe(sim.tokens[1]);
  });

  it("r1-6: starts a wake queued during a stop at the limit of one awake computer", async () => {
    const sim = new ComputerSim();
    sim.control.maxAwakeComputers = 1;
    await sim.running();
    let open: () => void = () => undefined;
    sim.computer.destroyGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    live(sim).runnerProcesses = 0;
    await sim.client.send(sim.client.suspendRequest());
    await sim.until(() => sim.record().lifecycle.context.state === "stopping");
    expect(await sim.client.send(sim.client.resumeRequest())).toMatchObject({
      outcome: "after_stop",
    });
    sim.computer.destroyGate = null;
    open();
    await sim.advance(10_000);
    expect(sim.record()).toMatchObject({
      lifecycle: { generation: 2, context: { state: "started_no_host" } },
    });
    expect([...sim.control.slots]).toEqual([`${sim.computer.computerId}/2`]);
  });

  it("r1-7: enforces the start deadline on a stalled restore, which keeps an alarm and is aborted", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    sim.computer.holdRestores = true;
    await sim.client.send(sim.client.resumeRequest());
    await sim.until(
      () => sim.computer.sup !== null && sim.record().lifecycle.context.state === "restoring",
    );
    expect(sim.alarmAt).not.toBeNull();
    // Alarms keep firing while the transfer stalls; the 300 s deadline stops the computer.
    for (let i = 0; i < 160 && sim.record().lifecycle.context.state === "restoring"; i += 1) {
      sim.now = Math.max(sim.now, sim.alarmAt ?? sim.now);
      sim.alarmAt = null;
      await sim.controller.alarm();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(sim.now).toBeGreaterThanOrEqual(sim.record().noHostSince ?? 0);
    sim.computer.holdRestores = false;
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("failed");
    expect(sim.computer.running).toBe(false);
    expect(sim.control.slots.size).toBe(0);
  });

  it("r1-8: keeps a deferred deadline from spinning the alarm", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    await sim.controller.setTerminal(true, sim.now + 20 * 60_000);
    await sim.advance(6 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    const at = sim.alarmAt ?? 0;
    expect(at - sim.now).toBeGreaterThanOrEqual(1_000);
    await sim.settle();
    await sim.controller.alarm();
    await sim.settle();
    expect((sim.alarmAt ?? 0) - sim.now).toBeGreaterThanOrEqual(1_000);
  });
});

describe("Codex WP3.1 r2", () => {
  it("r2-1: sweeps a credential write that lands after its instance was reset, before the removal resolves", async () => {
    const sim = new ComputerSim();
    await sim.running();
    let land: () => void = () => undefined;
    sim.bucket.putGate = new Promise<void>((resolve) => {
      land = resolve;
    });
    live(sim).signIn("claude");
    const message = live(sim).outbox.pop();
    const pending = sim.deliver(message as never).catch(() => undefined);
    await sim.until(() => sim.bucket.puts.length === 1);
    expect(sim.record().credentialUploads).toHaveLength(1);
    // The instance is reset while its write is outstanding; the new one deletes the key...
    await sim.restart();
    await sim.settle();
    expect(sim.record().credentialUploads).toHaveLength(0);
    // ...and the old write lands afterwards.
    sim.bucket.putGate = null;
    land();
    await pending;
    expect(sim.bucket.objects.size).toBe(1);
    expect(sim.check()).toEqual([]);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    await sim.controller.pages({
      interfaceVersion: 1,
      action: "record_revocation",
      operationId: "op_00000000000000000000000001",
    });
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "resolve_removal",
        operationId: "op_00000000000000000000000002",
      }),
    ).toEqual({ action: "resolve_removal", outcome: "accepted" });
    await sim.advance(10 * 60_000);
    expect(sim.record().deletion).not.toBeNull();
    await sim.advance(60 * 60_000);
    expect(sim.record()).toMatchObject({
      deletion: null,
      lifecycle: { context: { state: "removed" } },
    });
    expect([...sim.bucket.objects.keys()]).toEqual([]);
  });

  it("r2-2: keeps a request made after the running capture's cut when the pending requests overflow", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "old");
    sim.computer.failBackups = 1;
    await sim.call(sim.client.checkpointRequest());
    // While saves back off, 100 requests pile up.
    for (let i = 0; i < 110; i += 1) await sim.client.send(sim.client.checkpointRequest());
    expect(sim.record().saveRequests.length).toBe(100);
    live(sim).options.capturePolls = 10;
    await sim.advance(61_000);
    expect(sim.record().capture?.covers.length).toBe(100);
    // A change after the cut, and its request: folded into a follow-up, never dropped.
    live(sim).write("work/a.txt", "new");
    expect(await sim.client.send(sim.client.checkpointRequest())).toMatchObject({
      outcome: "accepted",
      folded: true,
    });
    await sim.advance(5 * 60_000);
    const r = sim.record();
    expect(r.saveRequests).toEqual([]);
    expect(r.capture).toBeNull();
    // The published checkpoint is the tree after the change (a follow-up save ran), with no
    // sleep's checkpoint in between to hide a lost request.
    expect(r.workspace?.treeDigest).toBe(await digestOf(live(sim).tree));
  });

  it("r2-3: starts a queued wake after a crash right after ControlDO granted its slot", async () => {
    const dry = new ComputerSim();
    dry.control.maxAwakeComputers = 1;
    await dry.running();
    let open: () => void = () => undefined;
    dry.computer.destroyGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    live(dry).runnerProcesses = 0;
    await dry.client.send(dry.client.suspendRequest());
    await dry.until(() => dry.record().lifecycle.context.state === "stopping");
    await dry.client.send(dry.client.resumeRequest());
    const from = dry.stepLog.length;
    dry.computer.destroyGate = null;
    open();
    await dry.advance(10_000);
    // The grant of the queued wake's reserve: the second ControlDO call after the stop.
    const calls = dry.stepLog
      .map((label, i) => [label, i] as const)
      .filter(([label, i]) => i >= from && label === "control:after");
    const grant = calls.find(([, i]) => dry.control.calls.length > 0 && i > from);
    expect(grant).toBeDefined();

    for (const [, at] of calls) {
      const sim = new ComputerSim();
      sim.control.maxAwakeComputers = 1;
      await sim.running();
      let release: () => void = () => undefined;
      sim.computer.destroyGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      live(sim).runnerProcesses = 0;
      await sim.client.send(sim.client.suspendRequest());
      await sim.until(() => sim.record().lifecycle.context.state === "stopping");
      await sim.client.send(sim.client.resumeRequest());
      sim.crashAt = at + 1;
      sim.computer.destroyGate = null;
      release();
      await sim.advance(10_000);
      await sim.advance(2 * 60_000);
      const r = sim.record();
      expect(r.lifecycle.context.state, `crash after step ${at}`).toBe("started_no_host");
      expect(sim.control.slots.size, `crash after step ${at}`).toBe(1);
      expect(sim.check()).toEqual([]);
    }
  });

  it("migrates a record from before sleeps were kept as keys", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    const sleep = sim.client.suspendRequest();
    live(sim).options.holdCredentials = true;
    live(sim).refreshUnpublished("claude");
    expect(await sim.call(sleep)).toMatchObject({ outcome: "in_progress" });
    // Rewrite the record in the old shape: the sleep listed in `sleepOps`.
    const raw = sim.store.get("computer") as Record<string, unknown>;
    for (const key of sim.store.keys("sleep:")) sim.store.delete(key);
    sim.store.put("computer", { ...raw, sleepOps: [sleep.operationId] });
    await sim.restart();
    await sim.advance(5 * 60_000);
    expect(await sim.call(sleep)).toMatchObject({
      outcome: "refused",
      reason: "credentials_unpublished",
    });
  });
});
