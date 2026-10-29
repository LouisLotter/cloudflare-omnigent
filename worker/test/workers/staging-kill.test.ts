// WP3.33: WorkspaceDO's staging-only kill (the G3 sitting's step K) in the Workers runtime.
//   - Production: the assembled production class (WORKSPACE), whose environment has no
//     `CFO_STAGING_INSTALLATION`, as a production installation's never has: refused before
//     anything happens, its storage unchanged and its container running on.
//   - Staging: the controller under fakes (WORKSPACE_CONTROLLER) on a computer the harness marks
//     as staging (the RC-53 and keep-awake switches' seam): the container is destroyed with no
//     stop intent and nothing written; evicted, the next alarm finds it gone and records an
//     unexpected stop, and Omnigent's next wake starts a new generation.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ComputerId,
  type SupervisorMessage,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceObjectName } from "../../src/shared/rpc.ts";
import { alarm, provision, roomyControl, settle, wake } from "../support/assembled.ts";
import { FakeLauncherClient } from "../support/fake-launcher-client.ts";
import type { SimulatedComputer } from "../support/fake-supervisor.ts";
import type { WorkspaceUnderFakes } from "../support/platform-test-worker.ts";
import { testComputers } from "../support/workspace-harness.ts";

const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };
const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const logs: string[] = [];

beforeAll(() => roomyControl());
beforeEach(() => {
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

/** Every row of the object's storage, as text. */
function storage(stub: DurableObjectStub): Promise<string> {
  return runInDurableObject(stub, async (_i: unknown, state: DurableObjectState) =>
    JSON.stringify({
      rows: state.storage.sql.exec("SELECT key, value FROM workspace_kv ORDER BY key").toArray(),
      alarm: await state.storage.getAlarm(),
    }),
  );
}

const events = (event: string) => logs.filter((l) => l.includes(`"event":"${event}"`));

describe("WorkspaceDO.stagingKill on production", () => {
  it("is refused before anything happens: storage unchanged, the container running on", async () => {
    const c = await provision();
    await wake(c, { hostId: HOST, token: "cfo-canary-launch-token-wp333-0000000001" });
    await settle(c);
    const before = await storage(c.stub);
    expect(c.container.running).toBe(true);
    expect(await c.stub.stagingKill(call)).toEqual({ outcome: "refused", reason: "not_staging" });
    expect(await storage(c.stub)).toBe(before);
    expect(c.container.running).toBe(true);
    expect(c.container.sim.stops).toEqual([]);
    expect(events("staging_kill")).toEqual([]);
    // Evicted, the next heartbeat finds it running: no unexpected stop.
    await evictDurableObject(c.stub);
    await alarm(c, 61_000);
    expect(events("unexpected_stop")).toEqual([]);
    expect(c.container.running).toBe(true);
  });
});

describe("WorkspaceDO.stagingKill on staging", () => {
  type Stub = DurableObjectStub<WorkspaceUnderFakes>;
  const workspaces = (
    env as unknown as { WORKSPACE_CONTROLLER: DurableObjectNamespace<WorkspaceUnderFakes> }
  ).WORKSPACE_CONTROLLER;

  async function deliver(stub: Stub, computer: SimulatedComputer): Promise<void> {
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

  async function next(stub: Stub, computer: SimulatedComputer, ms: number): Promise<void> {
    await evictDurableObject(stub);
    testComputers.advance(ms);
    await runDurableObjectAlarm(stub);
    await deliver(stub, computer);
  }

  it("destroys the container with no stop intent; the next alarm records an unexpected stop", async () => {
    const computerId = "cmp_01hzy3m8k6q4t2v9w7x5s3k111" as ComputerId;
    testComputers.staging.add(computerId);
    const stub = workspaces.getByName(workspaceObjectName(computerId)) as Stub;
    const computer = testComputers.create(stub.id, computerId);
    const client = new FakeLauncherClient(computerId, (request) =>
      stub.launcher({ ...call, request }),
    );
    await client.send(client.provisionRequest("managed-wp333k1"));
    await client.send(client.resumeRequest());
    await deliver(stub, computer);
    const claim = await client.send(client.claimRequest());
    if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim refused");
    await client.send(
      client.startRequest({
        attempt: claim.startAttempt,
        token: "synthetic-launch-token-workers-wp333-000001",
        hostId: HOST,
      }),
    );
    await next(stub, computer, 2_000);
    expect(computer.sup?.host).toMatchObject({ state: "running" });

    const before = await storage(stub);
    expect(await stub.stagingKill(call)).toEqual({
      outcome: "killed",
      generation: 1,
      hostId: HOST,
    });
    // A crash: nothing recorded, the container gone, by the runtime's destroy.
    expect(await storage(stub)).toBe(before);
    expect(computer.running).toBe(false);
    expect(computer.stops).toHaveLength(1);
    expect(computer.stops[0]).toMatchObject({ by: "destroy", generation: "1" });
    expect(computer.stops[0]?.reason).toContain("staging kill");
    expect(events("staging_kill")).toHaveLength(1);
    expect(await stub.stagingKill(call)).toEqual({ outcome: "refused", reason: "not_running" });

    // A new instance's heartbeat finds it gone.
    await next(stub, computer, 61_000);
    expect(events("unexpected_stop")).toHaveLength(1);
    const record = await runInDurableObject(stub, (_i: unknown, state: DurableObjectState) =>
      JSON.parse(
        state.storage.sql
          .exec<{ value: string }>("SELECT value FROM workspace_kv WHERE key = 'computer'")
          .one().value,
      ),
    );
    expect(record.stop).toMatchObject({ generation: 1, reason: "unexpected" });
    expect(record.unexpectedStopAt).not.toBeNull();
    // Omnigent's next wake: a new generation on a fresh container.
    await client.send(client.resumeRequest());
    await next(stub, computer, 2_000);
    expect(computer.starts.at(-1)?.env.CFO_GENERATION).toBe("2");
    expect(computer.running).toBe(true);
  });
});
