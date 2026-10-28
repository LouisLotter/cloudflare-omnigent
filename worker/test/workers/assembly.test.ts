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
import { SandboxBackupError } from "@cloudflare/sandbox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isTransientUploadError } from "../../src/computer/upload-errors.ts";
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
import { assembly } from "../support/assembly-harness.ts";
import { SITTING_PART_FAILURE, sdkBackupError } from "../support/backup-errors.ts";
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

/** WorkspaceDO's `workspace` log events of one kind, from the console. */
function events(spy: { readonly mock: { readonly calls: unknown[][] } }, event: string) {
  return spy.mock.calls
    .map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : null))
    .filter((e) => e?.cfo === "workspace" && e.event === event);
}

describe("a transient part failure during a save (WP3.22)", () => {
  afterEach(() => {
    assembly.failParts = 0;
    assembly.loseCompletions = 0;
    vi.restoreAllMocks();
  });

  it("is the SDK's own error shape, and the only kind repeated", () => {
    expect(SandboxBackupError.is(SITTING_PART_FAILURE())).toBe(true);
    expect(isTransientUploadError(SITTING_PART_FAILURE())).toBe(true);
    const integrity = sdkBackupError("BACKUP_INTEGRITY", "R2 stored 1 bytes, but 2 were uploaded");
    expect(SandboxBackupError.is(integrity)).toBe(true);
    expect(isTransientUploadError(integrity)).toBe(false);
  });

  it("uploads the layer again within the same save: one object in R2, restored on the next wake, after evictions", async () => {
    const c = await provision();
    const host = hostId();
    await wake(c, { hostId: host, token: TOKEN });
    c.container.sim.sup?.write("work/notes.md", "saved after a lost part");
    const log = vi.spyOn(console, "log");
    assembly.failParts = 1;
    const parts = assembly.partsSeen;
    const [accepted, , status] = await stepsWithEviction(
      c.stub,
      [
        () => c.client.send(c.client.checkpointRequest()),
        () => settle(c),
        () => c.client.send(c.client.statusRequest()),
      ],
      { evictAfterLast: true },
    );
    expect(accepted).toMatchObject({ operation: "checkpoint", outcome: "accepted" });
    expect(status).toMatchObject({ running: true });
    expect(assembly.partsSeen - parts).toBe(2);
    expect(c.container.shimRuns.filter((r) => r.startsWith("backup:"))).toHaveLength(2);
    // The real SDK's error, through the real gateway's 502, as on staging; then the second
    // attempt published. No save failed, and R2 holds the one completed layer.
    const [retry] = events(log, "upload_retry");
    expect(retry).toMatchObject({ attempt: 1, generation: 1 });
    expect(retry.error).toMatch(
      /^SandboxBackupError: backup '\/var\/cfo\/staged\/lyr_[0-9a-z]+': gateway rejected the part upload with HTTP 502: Network connection lost\.$/,
    );
    expect(events(log, "save_failed")).toEqual([]);
    expect(events(log, "workspace_published")).toHaveLength(1);
    expect(await keys(`workspace/${c.computerId}/`)).toHaveLength(1);
    expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
    await wake(c, { hostId: host, token: TOKEN });
    expect(c.container.sim.sup?.tree.get("work/notes.md")).toBe("saved after a lost part");
  });

  it("fails the save after its last attempt with nothing in R2, and the next save publishes, after evictions", async () => {
    const c = await provision();
    await wake(c, { hostId: hostId(), token: TOKEN });
    c.container.sim.sup?.write("work/notes.md", "v1");
    const log = vi.spyOn(console, "log");
    assembly.failParts = 3;
    const parts = assembly.partsSeen;
    const [, , failed] = await stepsWithEviction(
      c.stub,
      [
        () => c.client.send(c.client.checkpointRequest()),
        () => settle(c),
        async () => {
          const objects = await keys(`workspace/${c.computerId}/`);
          return { objects, status: await c.client.send(c.client.statusRequest()) };
        },
        // The failed saves' schedule: the next attempt a minute later publishes.
        () => alarm(c, 61_000),
        () => c.client.send(c.client.statusRequest()),
      ],
      { evictAfterLast: true },
    );
    expect(failed.objects).toEqual([]);
    expect(assembly.partsSeen - parts).toBe(4);
    expect(events(log, "upload_retry").map((e) => e.attempt)).toEqual([1, 2]);
    expect(events(log, "save_failed")).toEqual([
      expect.objectContaining({ reason: "upload", generation: 1 }),
    ]);
    expect(events(log, "workspace_published")).toHaveLength(1);
    expect(await keys(`workspace/${c.computerId}/`)).toHaveLength(1);
  });

  it("never repeats an upload whose completion reply was lost: no second object for one save (Codex r1-3)", async () => {
    const c = await provision();
    await wake(c, { hostId: hostId(), token: TOKEN });
    c.container.sim.sup?.write("work/notes.md", "v1");
    const log = vi.spyOn(console, "log");
    assembly.loseCompletions = 1;
    const runs = c.container.shimRuns.filter((r) => r.startsWith("backup:")).length;
    const [, , after] = await stepsWithEviction(
      c.stub,
      [
        () => c.client.send(c.client.checkpointRequest()),
        () => settle(c),
        async () => ({
          objects: await keys(`workspace/${c.computerId}/`),
          status: await c.client.send(c.client.statusRequest()),
        }),
        () => alarm(c, 61_000),
        () => c.client.send(c.client.statusRequest()),
      ],
      { evictAfterLast: true },
    );
    // One attempt for the failed save: the object R2 completed is the only one it wrote. It is
    // not referenced (a pre-existing leak: the record died with the reply), never published.
    expect(after.objects).toHaveLength(1);
    expect(events(log, "upload_retry")).toEqual([]);
    expect(events(log, "save_failed")).toEqual([
      expect.objectContaining({ reason: "upload", generation: 1 }),
    ]);
    // The failed saves' schedule: the next save publishes its own object.
    expect(c.container.shimRuns.filter((r) => r.startsWith("backup:")).length - runs).toBe(2);
    expect(events(log, "workspace_published")).toHaveLength(1);
    expect(await keys(`workspace/${c.computerId}/`)).toHaveLength(2);
  });
});
