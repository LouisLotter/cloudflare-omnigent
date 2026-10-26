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

describe("Codex WP3.1 r2 and the lead's verification (r3)", () => {
  it("r2-1, r3-1: never retires a tombstone blind: a write landing after every deletion and the removal is deleted again", async () => {
    // Codex's late-completion sequence (lead's verification, r3): the upload is held through the
    // reset, the first deletion, a sweep and the resolved removal, then lands.
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
    await sim.restart();
    await sim.settle();
    expect(sim.record().credentialUploads).toHaveLength(0);
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
    expect(sim.record()).toMatchObject({
      deletion: null,
      lifecycle: { context: { state: "removed" } },
    });
    // A sweep runs (the second deletion) while the write is still held.
    const deletions = sim.bucket.deleted.length;
    await sim.advance(7 * 3_600_000);
    expect(sim.bucket.deleted.length).toBeGreaterThan(deletions);
    // The write lands now, after everything.
    land();
    await pending;
    expect(sim.bucket.objects.size).toBe(1);
    expect(sim.check()).toEqual([]);
    // The tombstone outlived the records, so the slow sweep deletes it, and keeps doing so.
    expect(sim.record().credentialSweeps).toHaveLength(1);
    await sim.advance(7 * 3_600_000);
    expect([...sim.bucket.objects.keys()]).toEqual([]);
    expect(sim.record().credentialSweeps).toHaveLength(1);
    expect(sim.alarmAt).not.toBeNull();
    expect(sim.check()).toEqual([]);
  }, 30_000);

  it("r3-1, r4-5: keeps an abandoned key fenced at the gateway, and its tombstone for good", async () => {
    const sim = new ComputerSim({ gateway: true });
    await sim.running();
    sim.bucket.failPuts = 1;
    live(sim).signIn("claude");
    const message = live(sim).outbox.pop();
    await expect(sim.deliver(message as never)).rejects.toThrow(/unavailable/);
    const upload = sim.record().credentialUploads[0];
    if (upload === undefined) throw new Error("no upload recorded");
    const key = `credentials/${sim.computer.computerId}/${upload.checkpointId}.json`;
    const check = (
      objectKey: string,
      generation = 1,
      kind: "credential" | "workspace" = "credential",
    ) =>
      sim.controller.writeAllowed({
        interfaceVersion: 1,
        computerId: sim.computer.computerId,
        generation,
        kind,
        objectKey,
      });
    // A pending upload may be written; once abandoned (a new instance), never again.
    expect(await check(key)).toEqual({ allowed: true });
    await sim.restart();
    await sim.settle();
    expect(await check(key)).toEqual({ allowed: false, reason: "not_pending" });
    expect(await check(key, 2)).toEqual({ allowed: false, reason: "stale_generation" });
    expect(await check(`workspace/${sim.computer.computerId}/x`, 1, "workspace")).toEqual({
      allowed: true,
    });
    expect(await check("workspace/cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/x", 1, "workspace")).toEqual({
      allowed: false,
      reason: "foreign_key",
    });
    expect(
      await sim.controller.writeAllowed({
        interfaceVersion: 1,
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4",
        generation: 1,
        kind: "credential",
        objectKey: key,
      }),
    ).toEqual({ allowed: false, reason: "unknown_computer" });
    // Version 1 never retires a tombstone: its key is deleted again every 6 hours.
    sim.sup?.write("work/a", "a");
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    const deletions = () => sim.bucket.deleted.filter((k) => k === key).length;
    const before = deletions();
    await sim.advance(13 * 3_600_000);
    expect(deletions()).toBeGreaterThanOrEqual(before + 2);
    expect(sim.record().credentialSweeps.map((x) => x.key)).toEqual([key]);
  }, 30_000);

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

describe("the lead's verification (r3)", () => {
  it("r3-2: keeps a queued wake through a failed recovery release, and starts it once ControlDO answers", async () => {
    // Codex's sequence: capacity one, a wake queued while stopping, a crash right after the new
    // slot was granted, then the first recovery release failing.
    const dry = new ComputerSim();
    dry.control.maxAwakeComputers = 1;
    await dry.running();
    let openDry: () => void = () => undefined;
    dry.computer.destroyGate = new Promise<void>((resolve) => {
      openDry = resolve;
    });
    live(dry).runnerProcesses = 0;
    await dry.client.send(dry.client.suspendRequest());
    await dry.until(() => dry.record().lifecycle.context.state === "stopping");
    await dry.client.send(dry.client.resumeRequest());
    const from = dry.stepLog.length;
    dry.computer.destroyGate = null;
    openDry();
    await dry.advance(10_000);
    const grants = dry.stepLog.flatMap((label, i) =>
      i >= from && label === "control:after" ? [i] : [],
    );
    expect(grants.length).toBeGreaterThanOrEqual(2);

    for (const at of grants) {
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
      await sim.client.send(sim.client.resumeRequest());
      sim.crashAt = at + 1;
      sim.onCrash = () => {
        sim.control.unavailable = true;
      };
      sim.computer.destroyGate = null;
      open();
      await sim.advance(10_000);
      await sim.advance(60_000);
      // While ControlDO cannot be reached, the wake stays queued: never a capacity refusal.
      const waiting = sim.record();
      if (waiting.lifecycle.context.state === "stopping") {
        expect(waiting.lifecycle.context.wakeQueued, `crash after step ${at}`).toBe(true);
      }
      sim.control.unavailable = false;
      await sim.advance(2 * 60_000);
      const r = sim.record();
      expect(r.lifecycle.context.state, `crash after step ${at}`).toBe("started_no_host");
      expect([...sim.control.slots], `crash after step ${at}`).toEqual([
        `${sim.computer.computerId}/${r.lifecycle.generation}`,
      ]);
      expect(sim.check()).toEqual([]);
    }
  });
});

describe("the lead's verification (r4)", () => {
  it("r4-1: reads a record whose tombstones predate fencedAt, keeping their cleanup", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const key = `credentials/${sim.computer.computerId}/ckp_0000000000000000000000old0.json`;
    const raw = sim.store.get("computer") as Record<string, unknown>;
    sim.store.put("computer", { ...raw, credentialSweeps: [{ key, at: sim.now + 60_000 }] });
    await sim.restart();
    await sim.settle();
    expect(sim.record().credentialSweeps).toEqual([
      { key, fencedAt: null, at: expect.any(Number) },
    ]);
    await sim.advance(2 * 60_000);
    expect(sim.bucket.deleted).toContain(key);
    expect(sim.record().credentialSweeps).toHaveLength(1);
  });

  it("r4-2: publishes a credential bundle through a gateway that checks writeAllowed during the upload", async () => {
    const sim = new ComputerSim({ gateway: true });
    await sim.running();
    live(sim).signIn("codex");
    await sim.settle();
    const r = sim.record();
    expect(r.credential?.files[".codex/auth.json"].state).toBe("present");
    expect(sim.gatewayChecks).toEqual([{ key: r.credential?.object.key, allowed: true }]);
    expect(r.credentialUploads).toEqual([]);
  });

  it("r4-3: lets a removal's sign-out run publish its tombstones through the gateway, end to end", async () => {
    const sim = new ComputerSim({ gateway: true });
    await sim.running();
    live(sim).signIn("claude");
    live(sim).signIn("codex");
    await sim.settle();
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "sign_out",
        operationId: "op_00000000000000000000000001",
      }),
    ).toEqual({ action: "sign_out", outcome: "accepted" });
    await sim.advance(3 * 60_000);
    const r = sim.record();
    expect(r.signOut.phase).toBe("verified");
    expect(r.credential?.generation).toBe(2);
    expect(sim.gatewayChecks.filter((c) => !c.allowed)).toEqual([]);
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "resolve_removal",
        operationId: "op_00000000000000000000000002",
      }),
    ).toEqual({ action: "resolve_removal", outcome: "accepted" });
    await sim.advance(10 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removed");
    expect(
      await sim.controller.writeAllowed({
        interfaceVersion: 1,
        computerId: sim.computer.computerId,
        generation: 2,
        kind: "credential",
        objectKey: "x",
      }),
    ).toEqual({ allowed: false, reason: "removed" });
  });

  it("r4-4: backs a deferred wake off during a ControlDO outage, without destroying the stopped container", async () => {
    const sim = new ComputerSim();
    await sim.running();
    let open: () => void = () => undefined;
    sim.computer.destroyGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    live(sim).runnerProcesses = 0;
    await sim.client.send(sim.client.suspendRequest());
    await sim.until(() => sim.record().lifecycle.context.state === "stopping");
    await sim.client.send(sim.client.resumeRequest());
    sim.control.unavailable = true;
    sim.computer.destroyGate = null;
    open();
    await sim.settle();
    const controlCalls = sim.control.calls.length;
    const destroys = sim.computer.ops.filter((op) => op === "destroy").length;
    const waits = sim.logs.filter((l) => l.event === "queued_wake_waits").length;
    // 200 polls, two seconds apart.
    for (let i = 0; i < 200; i += 1) {
      sim.now += sim.timing.pollMs;
      await sim.controller.alarm();
      await sim.settle();
    }
    expect(sim.record().lifecycle.context).toMatchObject({ state: "stopping", wakeQueued: true });
    expect(sim.computer.ops.filter((op) => op === "destroy").length).toBe(destroys);
    // FakeControl records only the calls it answers; count the attempts by the logs instead.
    const attempts = sim.logs.filter((l) => l.event === "queued_wake_waits").length - waits;
    expect(attempts).toBeLessThanOrEqual(20);
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(sim.control.calls.length).toBe(controlCalls);
    sim.control.unavailable = false;
    await sim.advance(2 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
    // The next queued wake does not inherit that backoff: it starts within a poll or two.
    let reopen: () => void = () => undefined;
    sim.computer.destroyGate = new Promise<void>((resolve) => {
      reopen = resolve;
    });
    live(sim).runnerProcesses = 0;
    await sim.client.send(sim.client.suspendRequest());
    await sim.until(() => sim.record().lifecycle.context.state === "stopping");
    await sim.client.send(sim.client.resumeRequest());
    sim.computer.destroyGate = null;
    reopen();
    await sim.advance(2 * sim.timing.pollMs);
    expect(sim.record().lifecycle).toMatchObject({
      generation: 3,
      context: { state: "started_no_host" },
    });
  }, 30_000);
});

describe("the lead's addendum (fence = no new admissions; late writes are cleaned up)", () => {
  it("sweeps a removed computer's prefixes every 6 hours, deleting objects that land after the removal", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    expect(
      await sim.controller.pages({
        interfaceVersion: 1,
        action: "resolve_removal",
        operationId: "op_00000000000000000000000001",
      }),
    ).toEqual({ action: "resolve_removal", outcome: "accepted" });
    await sim.advance(10 * 60_000);
    expect(sim.record()).toMatchObject({
      deletion: null,
      lifecycle: { context: { state: "removed" } },
    });
    const id = sim.computer.computerId;
    const late = (key: string) => sim.bucket.objects.set(key, new TextEncoder().encode("late"));
    // Late admitted writes land after the removal, under both prefixes.
    late(`workspace/${id}/late-layer`);
    late(`credentials/${id}/ckp_0000000000000000000000late.json`);
    late("credentials/cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/other.json");
    await sim.advance(6 * 3_600_000 + 60_000);
    expect([...sim.bucket.objects.keys()]).toEqual([
      "credentials/cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/other.json",
    ]);
    // And for the record's life.
    late(`workspace/${id}/later`);
    await sim.advance(6 * 3_600_000 + 60_000);
    expect(sim.bucket.objects.has(`workspace/${id}/later`)).toBe(false);
    expect(sim.alarmAt).not.toBeNull();
  }, 30_000);

  it("restores only what the record names: never a tombstoned key's object or an unreferenced backup", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude", "claude-login-canary-live");
    live(sim).write("work/a.txt", "published");
    await sim.call(sim.client.checkpointRequest());
    await sim.settle();
    // An upload abandoned by a reset, whose write then lands late at its tombstoned key.
    sim.bucket.failPuts = 1;
    live(sim).signIn("claude", "claude-login-canary-late");
    const message = live(sim).outbox.pop();
    await expect(sim.deliver(message as never)).rejects.toThrow(/unavailable/);
    await sim.restart();
    await sim.settle();
    const tombstoned = sim.record().credentialSweeps[0]?.key ?? "";
    expect(tombstoned).not.toBe("");
    sim.bucket.objects.set(tombstoned, new TextEncoder().encode("{}"));
    // And a late workspace backup no manifest references.
    sim.computer.layers.set("00000000-0000-4000-8000-00000000dead", {
      kind: "base",
      files: new Map([["work/a.txt", "late"]]),
      deleted: [],
    });
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    const r = sim.record();
    const named = r.workspace?.layers.map((l) => l.backup.id) ?? [];
    const restoresBefore = sim.computer.restores.length;
    const getsBefore = sim.bucket.gets.length;
    sim.bucket.objects.set(tombstoned, new TextEncoder().encode("{}"));
    await sim.client.wake({ hostId: HOST, token: sim.token(2) });
    await sim.advance(10_000);
    const restored = sim.computer.restores.slice(restoresBefore).map((x) => x.id);
    expect(restored).toEqual(named);
    // Credentials are read only by the pointer's key, never the tombstoned one.
    expect(r.credential?.object.key).not.toBe(tombstoned);
    expect(sim.bucket.gets.slice(getsBefore)).toEqual([r.credential?.object.key]);
    expect(live(sim).tree.get("work/a.txt")).toBe("published");
  });
});

describe("WP3.2 r1-1 (WP3.18): never above the size cap after a lost limits reply", () => {
  /** ControlDO's `limits` replies are all lost; everything else answers. */
  function loseLimits(sim: ComputerSim): void {
    const control = sim.control.control.bind(sim.control);
    sim.control.control = async (call) => {
      if (call.method === "limits") throw new Error("Network connection lost.");
      return control(call);
    };
  }

  it("starts at the cap the grant carries, with no limits call that could be lost", async () => {
    const sim = new ComputerSim();
    sim.control.maxInstanceSize = "standard-1"; // below the default size, standard-2
    loseLimits(sim);
    await sim.running();
    expect(sim.computer.starts.map((s) => s.instance)).toEqual(["standard-1"]);
    expect(sim.control.calls.map((c) => c.method)).not.toContain("limits");
    // A size chosen on the page above the cap still starts at the cap.
    await sim.controller.pages({
      interfaceVersion: 1,
      action: "set_size",
      operationId: "op_01hzy3m8k6q4t2v9w7x5r0s1n3",
      size: "standard-4",
    });
    live(sim).runnerProcesses = 0;
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({ operation: "suspend" });
    await sim.advance(30_000);
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1);
    expect(sim.computer.starts.map((s) => s.instance)).toEqual(["standard-1", "standard-1"]);
    sim.check();
  });

  it("asks for the limits when an older ControlDO's grant carries no cap, and starts within them", async () => {
    const sim = new ComputerSim();
    sim.control.grantsCarrySize = false;
    sim.control.maxInstanceSize = "standard-1";
    await sim.running();
    expect(sim.computer.starts.map((s) => s.instance)).toEqual(["standard-1"]);
    expect(sim.control.calls.map((c) => c.method)).toContain("limits");
    sim.check();
  });

  it("gives the slot back and starts nothing when no cap can be confirmed", async () => {
    const sim = new ComputerSim();
    sim.control.grantsCarrySize = false;
    loseLimits(sim);
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("unavailable");
    await sim.advance(60_000);
    expect(sim.computer.starts).toHaveLength(0);
    expect(sim.record().lifecycle.context.state).toBe("provisioned");
    // The slot granted to the abandoned generation is given back.
    expect(sim.control.slots.size).toBe(0);
    expect(sim.logs.map((l) => l.event)).toContain("size_cap_unconfirmed");
    // Once ControlDO answers again, the wake goes ahead within the cap.
    sim.control.grantsCarrySize = true;
    sim.control.maxInstanceSize = "standard-1";
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1);
    expect(sim.computer.starts.map((s) => s.instance)).toEqual(["standard-1"]);
    sim.check();
  });
});
