// WorkspaceDO's controller at the edges: lost containers mid-save, malformed or refused supervisor
// replies, lost credential objects, the order floor, journal retention and missing dependencies.
import { WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { WorkspaceController } from "../../src/computer/controller.ts";
import { TOKEN_KEY } from "../../src/computer/record.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { CMP, ComputerSim, HOST, live } from "../support/computer-sim.ts";
import { FakeControl } from "../support/fake-control.ts";
import { FakeLauncherClient } from "../support/fake-launcher-client.ts";
import { MemoryStore } from "../support/memory-store.ts";

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

describe("lost containers and lost replies", () => {
  it("deletes a layer uploaded by a capture its container did not outlive", async () => {
    const dry = new ComputerSim();
    await dry.running();
    live(dry).write("work/a.txt", "1");
    const from = dry.stepLog.length;
    await dry.call(dry.client.checkpointRequest());
    const upload = dry.stepLog.indexOf("backup:after", from);
    const recorded = dry.stepLog.indexOf("commit:after", upload);
    expect(recorded).toBeGreaterThan(upload);

    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    sim.crashAt = recorded + 1;
    sim.onCrash = () => sim.computer.stopByPlatform();
    await sim.client.send(sim.client.checkpointRequest());
    await sim.settle();
    await sim.advance(5 * 60_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("stopped");
    expect(r.workspace).toBeNull();
    expect(r.orphans).toEqual([]);
    expect(sim.computer.layers.size).toBe(0);
    expect(r.saveRequests).toHaveLength(1);
    expect(sim.check()).toEqual([]);
  });

  it("supersedes a credential copy taken before the restore installed the credentials (S6's cutoff)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude", "claude-login-canary-a");
    await sim.settle();
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    sim.computer.supervisorOptions = { restorePolls: 3 };
    await sim.call(sim.client.resumeRequest());
    // A copy taken while the restore runs (before the install): refused now, then stale.
    live(sim).signIn("claude", "claude-login-canary-stale");
    await sim.settle();
    expect(sim.record().credential?.generation).toBe(1);
    await sim.advance(30_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("started_no_host");
    expect(r.credentialFloor).toEqual({ generation: 2, floor: 1 });
    expect(r.credential?.generation).toBe(1);
    expect(live(sim).outbox).toHaveLength(0);
    expect(live(sim).credentials.get(".claude/.credentials.json")).toBe("claude-login-canary-a");
  });

  it("restores without a credential bundle that is missing from the bucket, and says a login may be lost", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("codex");
    await sim.settle();
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    sim.bucket.objects.clear();
    await sim.call(sim.client.resumeRequest());
    await sim.advance(30_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("started_no_host");
    expect(r.credential).toBeNull();
    expect(r.signOut.loginPossiblyLost).toBe(true);
    expect(live(sim).credentials.size).toBe(0);
  });

  it("fails a restore whose merged tree does not match the checkpoint's digest", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    const id = sim.record().workspace?.layers[0]?.backup.id ?? "";
    const layer = sim.computer.layers.get(id);
    if (layer === undefined) throw new Error("no layer");
    sim.computer.layers.set(id, { ...layer, files: new Map([["work/a.txt", "tampered"]]) });
    await sim.call(sim.client.resumeRequest());
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("failed");
    expect(sim.logs.find((l) => l.event === "restore_failed")?.fields).toMatchObject({
      reason: "tree digest mismatch",
    });
  });

  it("fails a restore after repeated malformed or refused supervisor replies", async () => {
    for (const reply of [
      () => new Response("not json"),
      () => Response.json({ type: "status" }),
      () =>
        Response.json(
          { error: { code: "unavailable", message: "busy", retryable: true } },
          { status: 503 },
        ),
      () => new Response("{}", { status: 500 }),
    ]) {
      const sim = new ComputerSim();
      await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
      sim.computer.supervisor = reply;
      await sim.call(sim.client.resumeRequest());
      await sim.advance(5 * 60_000);
      expect(sim.record().lifecycle.context.state).toBe("failed");
      expect(sim.computer.running).toBe(false);
      expect(sim.control.slots.size).toBe(0);
    }
  });

  it("treats a missing launch token at hand-out as a declined start, so the next claim supersedes it", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.supervisorOptions = { restorePolls: 5 };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    await sim.call(
      sim.client.startRequest({ attempt: claim.startAttempt, token: sim.token(1), hostId: HOST }),
    );
    expect(sim.store.get(TOKEN_KEY)).toBeDefined();
    sim.store.delete(TOKEN_KEY);
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("start_claimed");
    expect(live(sim).commands.filter((c) => c.type === "start_host")).toHaveLength(0);
    expect(sim.logs.some((l) => l.event === "start_parameters_missing")).toBe(true);
  });

  it("refuses a sleep when the final credential snapshot cannot be taken in time", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = async (request) => {
      const body = (await request.clone().json()) as { type: string };
      if (body.type === "credential_snapshot") {
        return Response.json(
          { error: { code: "unavailable", message: "busy", retryable: true } },
          { status: 503 },
        );
      }
      return handler ? handler(request) : new Response("{}");
    };
    live(sim).runnerProcesses = 0;
    const sleep = sim.client.suspendRequest();
    await sim.call(sleep);
    await sim.advance(5 * 60_000);
    expect(await sim.call(sleep)).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "credentials_unpublished",
    });
    expect(sim.computer.running).toBe(true);
  });

  it("gives a sign-out run up after its deadline, leaving the sign-out unverified", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude");
    await sim.settle();
    live(sim).options.holdCredentials = true;
    await sim.controller.pages({
      interfaceVersion: 1,
      action: "sign_out",
      operationId: "op_00000000000000000000000001",
    });
    await sim.advance(10 * 60_000);
    const r = sim.record();
    expect(r.signOut).toMatchObject({ phase: "requested", job: null });
    expect(sim.logs.some((l) => l.event === "sign_out_gave_up")).toBe(true);
  });
});

describe("messages and journals", () => {
  it("ignores a report older than one already applied, and one from another generation", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const sup = live(sim);
    sup.runnerProcesses = 3;
    const newer = sup.report();
    sup.runnerProcesses = 0;
    await sim.settle();
    const older = {
      ...newer,
      report: {
        ...(newer.type === "report" ? newer.report : ({} as never)),
        seq: 1,
        runnerProcesses: 9,
      },
    };
    expect(await sim.deliver(older as never)).toMatchObject({ type: "report" });
    expect(sim.record().report?.runnerProcesses).toBe(3);
  });

  it("refuses a SIGTERM save before the restore is confirmed", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.supervisorOptions = { restorePolls: 10 };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    const sup = live(sim);
    sup.sigterm();
    const message = sup.outbox.at(-1);
    expect(await sim.deliver(message as never)).toEqual({
      type: "save_request",
      outcome: "refused",
    });
    expect(await sim.deliver(message as never)).toEqual({
      type: "save_request",
      outcome: "refused",
    });
  });

  it("refuses an operation ID reused for another request, and forgets outcomes after the retention", async () => {
    const sim = new ComputerSim({ timing: { operationRecordMs: 10 * 60_000 } });
    await sim.running();
    const claim = sim.client.claimRequest();
    expect(await sim.call(claim)).toMatchObject({ granted: false, status: "host_running" });
    const reused = { ...sim.client.checkpointRequest(), operationId: claim.operationId };
    expect(await sim.client.refusal(reused)).toBe("conflict");
    expect(sim.store.keys("op:launcher:")).toContain(`op:launcher:${claim.operationId}`);
    await sim.advance(15 * 60_000);
    expect(sim.store.keys("op:launcher:")).not.toContain(`op:launcher:${claim.operationId}`);
    expect(await sim.call(reused)).toMatchObject({ operation: "checkpoint", outcome: "accepted" });
  });

  it("refuses provisioning a computer with a removal intent", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.terminateRequest());
    expect(await sim.client.refusal(sim.client.provisionRequest("managed-7f3c2a9e"))).toBe("gone");
  });
});

describe("without a container port, ControlDO's records or a bucket", () => {
  function bare() {
    const store = new MemoryStore();
    const control = new FakeControl();
    let now = Date.UTC(2026, 9, 25);
    const controller = new WorkspaceController({
      computerId: CMP,
      store,
      port: null,
      control,
      bucket: null,
      clock: () => now,
      alarm: { set: () => undefined, clear: () => undefined },
      newId: (prefix) => `${prefix}_${"0".repeat(25)}${(now++ % 10).toString()}`,
      deadline: () => ({ signal: new AbortController().signal, clear: () => undefined }),
      intercepts: () => [],
      log: () => undefined,
    });
    const client = new FakeLauncherClient(CMP, (request) =>
      controller.launcher({ interfaceVersion: WORKSPACE_INTERFACE_VERSION, request }),
    );
    return { controller, client, control };
  }

  it("answers reservation reads for an unknown computer, and an unknown container state", async () => {
    const { controller, client } = bare();
    expect(await controller.reservation({ interfaceVersion: 1 })).toBeNull();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    await client.send(client.resumeRequest());
    await controller.idle();
    expect(await controller.reservation({ interfaceVersion: 1 })).toMatchObject({
      phase: "reserved",
      containerRunning: null,
    });
    expect(
      await codeOf(controller.pages({ interfaceVersion: 1, action: "state" })),
    ).toBeUndefined();
  });

  it("refuses a credential checkpoint it could not store", async () => {
    const sim = new ComputerSim();
    await sim.running();
    // A controller on the same storage, without a bucket.
    const sup = live(sim);
    sup.signIn("claude");
    const message = sup.outbox.pop();
    const { controller } = bare();
    expect(
      await codeOf(
        controller.computer({
          interfaceVersion: 1,
          props: { propsVersion: 1, computerId: CMP, generation: 1, hostId: HOST },
          message,
        }),
      ),
    ).toBe("stale_generation");
  });
});

describe("more failure paths", () => {
  it("records an unexpected stop when the container dies during its restore", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.supervisorOptions = { restorePolls: 50 };
    await sim.call(sim.client.resumeRequest());
    await sim.advance(5_000);
    expect(sim.record().lifecycle.context.state).toBe("restoring");
    sim.computer.stopByPlatform();
    await sim.advance(5_000);
    expect(sim.record().lifecycle.context.state).toBe("stopped");
    expect(sim.record().unexpectedStopAt).not.toBeNull();
    expect(sim.control.slots.size).toBe(0);
  });

  it("treats a start that throws Cloudflare's refusal like one that never ran (DC-37)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.startThrows = 1;
    await sim.call(sim.client.resumeRequest());
    await sim.advance(60_000);
    expect(sim.computer.starts.map((s) => s.refused)).toEqual([true, false]);
    expect(sim.record().lifecycle.context.state).toBe("started_no_host");
  });

  it("keeps a computer whose supervisor keeps an earlier live host as host_running, never re-arming it", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1000);
    const handler = sim.computer.supervisor;
    sim.computer.supervisor = async (request) => {
      const body = (await request.clone().json()) as { type: string };
      if (body.type === "start_host")
        return Response.json({ type: "start_host", outcome: "refused_live_host" });
      return handler ? handler(request) : new Response("{}");
    };
    const claim = await sim.call(sim.client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    await sim.call(
      sim.client.startRequest({ attempt: claim.startAttempt, token: sim.token(1), hostId: HOST }),
    );
    await sim.advance(10_000);
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(sim.store.get(TOKEN_KEY)).toBeUndefined();
    expect(await sim.call(sim.client.claimRequest())).toMatchObject({
      granted: false,
      status: "host_running",
    });
  });

  it("refuses credential checkpoints while no bucket is bound, and still wakes and sleeps", async () => {
    const sim = new ComputerSim({ noBucket: true });
    await sim.running();
    live(sim).signIn("claude");
    await sim.settle();
    expect(sim.record().credential).toBeNull();
    expect(live(sim).outbox).toHaveLength(1);
    expect(await sim.deliver(live(sim).outbox[0] as never).catch((e: Error) => e.message)).toMatch(
      /^\[unavailable\]/,
    );
  });
});

describe("the WorkspaceDO fake's write fence (for WP3.3's gateway tests)", () => {
  it("allows only the running generation's writes under this computer's prefixes", async () => {
    const { FakeWorkspace } = await import("../support/fake-workspace.ts");
    const fake = new FakeWorkspace(CMP);
    const check = (
      generation: number,
      objectKey: string,
      kind: "credential" | "workspace" = "credential",
    ) => fake.writeAllowed({ interfaceVersion: 1, computerId: CMP, generation, kind, objectKey });
    expect(await check(0, `credentials/${CMP}/a.json`)).toEqual({
      allowed: false,
      reason: "stale_generation",
    });
    fake.fire("resume");
    fake.fire("container_running");
    expect(await check(1, `credentials/${CMP}/a.json`)).toEqual({ allowed: true });
    expect(await check(1, "credentials/cmp_01hzy3m8k6q4t2v9w7x5r0s1n4/a.json")).toEqual({
      allowed: false,
      reason: "foreign_key",
    });
    expect(await check(1, `workspace/${CMP}/l`, "workspace")).toEqual({ allowed: true });
    expect(
      await fake.writeAllowed({
        interfaceVersion: 1,
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4",
        generation: 1,
        kind: "workspace",
        objectKey: "x",
      }),
    ).toEqual({ allowed: false, reason: "unknown_computer" });
    fake.fire("terminate");
    // A removal intent alone does not refuse (a sign-out run may still publish); the stop does.
    expect(await check(1, `credentials/${CMP}/a.json`)).toEqual({ allowed: true });
    fake.fire("stop_prepared");
    fake.fire("container_stopped");
    expect(await check(1, `credentials/${CMP}/a.json`)).toEqual({
      allowed: false,
      reason: "stale_generation",
    });
    await expect(fake.writeAllowed({} as never)).rejects.toThrow(/bad_request/);
  });
});
