// WorkspaceDO in the Workers runtime (WP3.1): real Durable Object SQLite, alarms, RPC and
// eviction between persisted transitions, with a simulated computer, a fake ControlDO and an
// in-memory bucket (test/support/workspace-harness.ts).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ComputerId,
  LauncherResult,
  PagesResult,
  ReservationState,
  type SupervisorMessage,
  SupervisorReply,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { workspaceObjectName } from "../../src/shared/rpc.ts";
import { stepsWithEviction } from "../support/eviction.ts";
import { FakeLauncherClient } from "../support/fake-launcher-client.ts";
import type { SimulatedComputer } from "../support/fake-supervisor.ts";
import type { WorkspaceDO } from "../support/platform-test-worker.ts";
import { testComputers } from "../support/workspace-harness.ts";

type Stub = DurableObjectStub<WorkspaceDO>;
const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const TOKEN = "synthetic-launch-token-canary-workers-0001";
const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };

let serial = 0;

/** A fresh computer: its own object, named by a computer ID, with a simulated computer. */
function fresh(): {
  stub: Stub;
  computer: SimulatedComputer;
  computerId: ComputerId;
  client: FakeLauncherClient;
} {
  serial += 1;
  const computerId = `cmp_01hzy3m8k6q4t2v9w7x5r0${String(serial).padStart(4, "0")}` as ComputerId;
  const stub = env.WORKSPACE.getByName(workspaceObjectName(computerId)) as Stub;
  const computer = testComputers.create(stub.id, computerId);
  const client = new FakeLauncherClient(computerId, (request) =>
    stub.launcher({ ...call, request }),
  );
  return { stub, computer, computerId, client };
}

/** Delivers the supervisor's queued messages through the computer API, then settles. */
async function settle(stub: Stub, computer: SimulatedComputer): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await stub.settle();
    const sup = computer.sup;
    if (sup === null || sup.outbox.length === 0) return;
    await sup.flush((message: SupervisorMessage) =>
      stub.computer({
        ...call,
        props: {
          propsVersion: 1,
          computerId: computer.computerId,
          generation: message.generation,
          hostId: HOST,
        },
        message,
      }),
    );
  }
}

async function alarm(stub: Stub, computer: SimulatedComputer, ms: number): Promise<void> {
  testComputers.advance(ms);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await settle(stub, computer);
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

describe("WorkspaceDO", () => {
  it("wakes, restores and starts a host, carrying on from storage after every eviction", async () => {
    const { stub, computer, client } = fresh();
    const [provision, resume] = await stepsWithEviction(stub, [
      () => client.send(client.provisionRequest("managed-7f3c2a9e")),
      async () => {
        const result = await client.send(client.resumeRequest());
        await settle(stub, computer);
        return result;
      },
      () => settle(stub, computer),
    ]);
    LauncherResult.parse(provision);
    expect(resume).toMatchObject({ operation: "resume", outcome: "starting", generation: 1 });
    // A new instance after the start: it re-armed the timeout and re-registered the intercepts.
    expect(computer.inactivityTimeouts.length).toBeGreaterThanOrEqual(1);
    const [status, claim] = await stepsWithEviction(stub, [
      () => client.send(client.statusRequest()),
      () => client.send(client.claimRequest()),
    ]);
    expect(status).toMatchObject({ status: "started_no_host", running: true });
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    const start = client.startRequest({ attempt: claim.startAttempt, token: TOKEN, hostId: HOST });
    const [started, repeated] = await stepsWithEviction(stub, [
      async () => {
        const result = await client.send(start);
        await settle(stub, computer);
        return result;
      },
      () => client.send(start),
      () => settle(stub, computer),
    ]);
    expect(started).toEqual(repeated);
    expect(computer.sup?.host).toMatchObject({ state: "running", attempt: claim.startAttempt });
    expect(computer.starts).toHaveLength(1);
    // The token is not in storage once the supervisor has it.
    await runInDurableObject(stub, (_i: WorkspaceDO, state) => {
      const rows = state.storage.sql
        .exec<{ value: string }>("SELECT value FROM workspace_kv")
        .toArray();
      expect(rows.map((r) => r.value).join("\n")).not.toContain(TOKEN);
    });
  });

  it("returns a sleep's recorded outcome for a repeated operation ID across eviction", async () => {
    const { stub, computer, client } = fresh();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    await client.send(client.resumeRequest());
    await settle(stub, computer);
    if (computer.sup) computer.sup.runnerProcesses = 0;
    computer.sup?.write("work/a.txt", "saved");
    const sleep = client.suspendRequest();
    const outcomes = await stepsWithEviction(stub, [
      () => client.send(sleep),
      () => client.send(sleep),
      async () => {
        await settle(stub, computer);
        return client.send(sleep);
      },
      () => client.send(sleep),
    ]);
    expect(outcomes.map((o) => (o.operation === "suspend" ? o.outcome : null))).toEqual([
      "in_progress",
      "in_progress",
      "stopped",
      "stopped",
    ]);
    expect(computer.running).toBe(false);
    expect(await client.send(client.statusRequest())).toMatchObject({
      status: "stopped",
      running: false,
    });
  });

  it("runs the heartbeat from its alarm, renewing the inactivity timeout, and stops nothing on its own", async () => {
    const { stub, computer, client } = fresh();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    await client.send(client.resumeRequest());
    await settle(stub, computer);
    const claim = await client.send(client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
    await client.send(
      client.startRequest({ attempt: claim.startAttempt, token: TOKEN, hostId: HOST }),
    );
    await settle(stub, computer);
    if (computer.sup) computer.sup.runnerProcesses = 1;
    const before = computer.inactivityTimeouts.length;
    await stepsWithEviction(stub, [
      () => alarm(stub, computer, 60_000),
      () => alarm(stub, computer, 60_000),
      () => alarm(stub, computer, 60_000),
    ]);
    expect(computer.inactivityTimeouts.length).toBeGreaterThanOrEqual(before + 3);
    expect(computer.inactivityTimeouts.at(-1)).toBe(45 * 60_000);
    expect(computer.running).toBe(true);
    expect(computer.stops).toHaveLength(0);
    await runInDurableObject(stub, async (_i: WorkspaceDO, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  it("answers the computer API with the contract's replies, refusing an older generation", async () => {
    const { stub, computer, computerId, client } = fresh();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    await client.send(client.resumeRequest());
    await settle(stub, computer);
    const sup = computer.sup;
    if (sup === null) throw new Error("no supervisor");
    sup.signIn("claude");
    const message = sup.outbox.at(-1) as SupervisorMessage;
    const deliver = (m: SupervisorMessage, generation = m.generation) =>
      stub.computer({
        ...call,
        props: { propsVersion: 1, computerId, generation, hostId: null },
        message: m,
      });
    const [published, again] = await stepsWithEviction(stub, [
      () => deliver(message),
      () => deliver(message),
    ]);
    SupervisorReply.parse(published);
    expect(published).toMatchObject({ type: "credential_checkpoint", outcome: "published" });
    expect(again).toEqual(published);
    // A message whose bundle is another generation's is malformed; an older generation's hello is stale.
    expect(await code(deliver({ ...message, generation: 0 }, 0))).toBe("bad_request");
    const hello = {
      type: "hello" as const,
      protocolVersion: 1,
      computerId,
      generation: 0,
      operationId: "op_00000000000000000000000002",
      supervisorVersion: "old",
    };
    expect(await code(deliver(hello, 0))).toBe("stale_generation");
    expect(await code(stub.computer({ ...call, props: {}, message } as never))).toBe("bad_request");
    expect(await code(stub.computer({ interfaceVersion: 99, props: {}, message } as never))).toBe(
      "bad_request",
    );
  });

  it("serves the pages' state and journaled actions, and ControlDO's reservation reads", async () => {
    const { stub, computer, computerId, client } = fresh();
    expect(await stub.reservation(call)).toBeNull();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    const size = {
      ...call,
      action: "set_size" as const,
      operationId: "op_00000000000000000000000001",
      size: "standard-3" as const,
    };
    const [first, second, state] = await stepsWithEviction(stub, [
      () => stub.pages(size),
      () => stub.pages(size),
      () => stub.pages({ ...call, action: "state" }),
    ]);
    expect(first).toEqual({ action: "set_size", appliesAt: "next_start" });
    expect(second).toEqual(first);
    const page = PagesResult.parse(state);
    expect(page.action === "state" && page.computer).toMatchObject({
      computerId,
      nextSize: "standard-3",
      status: "stopped",
    });
    expect(await code(stub.pages({ ...size, size: "standard-4" }))).toBe("conflict");
    await client.send(client.resumeRequest());
    await settle(stub, computer);
    expect(computer.starts[0]?.instance).toBe("standard-3");
    const reservation = ReservationState.parse(await stub.reservation(call));
    expect(reservation).toMatchObject({
      computerId,
      generation: 1,
      phase: "running",
      fenced: false,
      containerRunning: true,
    });
    expect(await code(stub.reservation({ interfaceVersion: 99 }))).toBe("unsupported_version");
  });

  it("refuses everything when it is not named by a computer ID", async () => {
    const stub = env.WORKSPACE.get(env.WORKSPACE.newUniqueId()) as Stub;
    expect(await code(stub.reservation(call))).toBe("bad_request");
  });
});

describe("WorkspaceDO's production defaults", () => {
  it("has no container, bucket or intercepts until WP3.3 wires them, and the real clock", async () => {
    const { stub } = fresh();
    expect(await stub.defaults()).toEqual({
      port: null,
      bucket: null,
      intercepts: [],
      clockSkewMs: expect.any(Number),
      heartbeatMs: 60_000,
      control: "function",
    });
    expect((await stub.defaults()).clockSkewMs).toBeLessThan(5_000);
  });

  it("keeps its records in SQLite, one JSON value per key, in transactions", async () => {
    const { stub, client } = fresh();
    await client.send(client.provisionRequest("managed-7f3c2a9e"));
    await runInDurableObject(stub, async (_i: WorkspaceDO, state) => {
      const { SqlStore } = await import("../../src/computer/WorkspaceDO.ts");
      const store = new SqlStore(state.storage);
      expect(store.get("computer")).toMatchObject({ name: "managed-7f3c2a9e" });
      store.transaction(() => {
        store.put("x:1", { a: 1 });
        store.put("x:2", [2]);
        store.put("y:1", "y");
      });
      expect(store.keys("x:")).toEqual(["x:1", "x:2"]);
      expect(store.keys("x:", 1)).toEqual(["x:1"]);
      expect(() =>
        store.transaction(() => {
          store.delete("x:1");
          throw new Error("rolled back");
        }),
      ).toThrow("rolled back");
      expect(store.get("x:1")).toEqual({ a: 1 });
      store.delete("x:1");
      expect(store.get("x:1")).toBeUndefined();
    });
  });
});
