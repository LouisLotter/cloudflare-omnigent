// The M3 assembly in the Workers runtime (WP3.18): the real chain with only the container and the
// clocks simulated. The launcher's signed calls reach `platform.internal` (PlatformInternal), the
// real ControlDO and the real WorkspaceDO; WorkspaceDO starts its container through WP3.3's port
// with the intercepts registered first; the supervisor's messages come back through the
// `computer.internal` intercept; workspace layers move through the Sandbox SDK's real
// `DirectoryBackup` and the real fenced backup gateway into local R2, and credential bundles
// through the same gateway's `putCredential`.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CONTROL_OBJECT_NAME } from "../../src/shared/rpc.ts";
import {
  alarm,
  type Computer,
  currentProps,
  hostId,
  pageChange,
  provision,
  roomyControl,
  settle,
  sleep,
  wake,
} from "../support/assembled.ts";
import { testControl } from "../support/control-harness.ts";
import { stepsWithEviction } from "../support/eviction.ts";
import type { ControlDO } from "../support/platform-test-worker.ts";

const TOKEN = "cfo-canary-launch-token-assembly-0123456789";
const bucket = () => (env as unknown as { CHECKPOINTS: R2Bucket }).CHECKPOINTS;

async function keys(prefix: string): Promise<string[]> {
  return (await bucket().list({ prefix })).objects.map((o) => o.key).sort();
}

beforeAll(() => roomyControl());
afterEach(() => roomyControl());

/** The slots the production ControlDO holds, as `computer/generation`. */
async function slots(): Promise<string[]> {
  const control = env.CONTROL.getByName(
    CONTROL_OBJECT_NAME,
  ) as unknown as DurableObjectStub<ControlDO>;
  return runInDurableObject(control, (_i: ControlDO, state) =>
    state.storage.sql
      .exec<{ computer_id: string; generation: number }>(
        "SELECT computer_id, generation FROM slots ORDER BY computer_id, generation",
      )
      .toArray()
      .map((r) => `${r.computer_id}/${r.generation}`),
  );
}

describe("a computer through the assembled chain", () => {
  it("wakes with its intercepts registered before the start, at the capped size, and hands the host its start", async () => {
    const c: Computer = await provision();
    const host = hostId();
    const attempt = await wake(c, { hostId: host, token: TOKEN });
    expect(attempt).toBe(1);
    const [start] = c.container.startsSeen;
    expect(start).toMatchObject({
      instance: "standard-2",
      enableInternet: true,
      image: c.container.images.computer,
      env: { CFO_COMPUTER_ID: c.computerId, CFO_GENERATION: "1" },
    });
    expect(start?.interceptedBefore).toEqual(["computer.internal", "omnigent.internal"]);
    expect(c.container.sim.sup?.host).toMatchObject({ state: "running", attempt: 1 });
    expect(await c.client.send(c.client.statusRequest())).toMatchObject({
      status: "host_running",
      generation: 1,
    });
  });

  it("saves through DirectoryBackup and the fenced gateway into R2, sleeps, and restores the tree on the next wake", async () => {
    const c = await provision();
    const host = hostId();
    await wake(c, { hostId: host, token: TOKEN });
    const sup = c.container.sim.sup;
    if (sup === null) throw new Error("no supervisor");
    sup.write("work/notes.md", "saved on generation 1");
    sup.signIn("claude");
    await settle(c);
    expect(await keys(`credentials/${c.computerId}/`)).toHaveLength(1);
    const accepted = await c.client.send(c.client.checkpointRequest());
    expect(accepted).toMatchObject({ operation: "checkpoint", outcome: "accepted" });
    await settle(c);
    const layers = await keys(`workspace/${c.computerId}/`);
    expect(layers).toHaveLength(1);
    expect(c.container.shimRuns.filter((r) => r.startsWith("backup:"))).toHaveLength(1);
    expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(c.container.running).toBe(false);
    // The next wake restores the layer from R2 through the gateway, then the credentials.
    await wake(c, { hostId: host, token: TOKEN });
    const next = c.container.sim.sup;
    expect(next?.generation).toBe(2);
    expect(next?.tree.get("work/notes.md")).toBe("saved on generation 1");
    expect(next?.credentials.size).toBeGreaterThan(0);
    expect(c.container.shimRuns.filter((r) => r.startsWith("restore:"))).toHaveLength(1);
    await alarm(c, 60_000);
  });

  it("never starts above the installation's size cap, which comes with the grant (WP3.2 r1-1)", async () => {
    roomyControl("standard-1");
    const c = await provision();
    // A size chosen on the page above the cap applies at the next start, capped.
    await pageChange(c, {
      action: "set_size",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      operationId: "op_01hzy3m8k6q4t2v9w7x5r0s1n3",
      size: "standard-4",
    });
    await wake(c, { hostId: hostId(), token: TOKEN });
    expect(c.container.startsSeen.map((s) => s.instance)).toEqual(["standard-1"]);
  });

  it("re-registers its intercepts with the bound host after start_host, and in every new instance", async () => {
    const c = await provision();
    const host = hostId();
    await stepsWithEviction(c.stub, [
      () => c.client.send(c.client.resumeRequest()),
      () => settle(c),
      async () => {
        const claim = await c.client.send(c.client.claimRequest());
        if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim");
        await c.client.send(
          c.client.startRequest({ attempt: claim.startAttempt, token: TOKEN, hostId: host }),
        );
      },
      () => settle(c),
    ]);
    expect(c.container.sim.sup?.host).toMatchObject({ state: "running" });
    expect(currentProps(c)).toMatchObject({ generation: 1, hostId: host });
    // Every registration is one of the two computer hosts; the backup host only by DirectoryBackup.
    expect(new Set(c.container.registrations)).toEqual(
      new Set(["computer.internal", "omnigent.internal"]),
    );
    expect(c.container.startsSeen).toHaveLength(1);
  });

  it("holds its ControlDO slot while it runs and gives it back once it sleeps, reconciled against the real WorkspaceDO", async () => {
    const c = await provision();
    await wake(c, { hostId: hostId(), token: TOKEN });
    expect(await slots()).toContain(`${c.computerId}/1`);
    // ControlDO's reconciliation reads this computer's actual reservation and keeps the slot.
    const control = env.CONTROL.getByName(CONTROL_OBJECT_NAME);
    testControl.advance(120_000);
    await runDurableObjectAlarm(control);
    expect(await slots()).toContain(`${c.computerId}/1`);
    expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(await slots()).not.toContain(`${c.computerId}/1`);
  });
});
