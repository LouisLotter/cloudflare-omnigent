// WorkspaceDO's controller: workspace and credential checkpoints (D17, R-04, R-18, R-19, AR-25),
// in the simulation, where R2 holds each layer's files so every restore can be compared with
// what was published.

import { describe, expect, it } from "vitest";
import { RECORD_KEY } from "../../src/computer/record.ts";
import { SITTING_PART_FAILURE, sdkBackupError } from "../support/backup-errors.ts";
import { ComputerSim, HOST, live } from "../support/computer-sim.ts";

const page = (sim: ComputerSim) => sim.page();

/** Sleeps the computer, then wakes it with a new host token: a full restore. */
async function sleepAndWake(sim: ComputerSim): Promise<void> {
  live(sim).runnerProcesses = 0;
  await sim.call(sim.client.suspendRequest());
  await sim.advance(30_000);
  expect(sim.record().lifecycle.context.state).toBe("asleep");
  await sim.client.wake({ hostId: HOST, token: sim.token(sim.tokens.length + 1) });
  await sim.advance(30_000);
}

describe("workspace checkpoints", () => {
  it("captures for each request, folding requests during a capture into one follow-up", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).options.capturePolls = 2;
    live(sim).write("work/a.txt", "one");
    expect(await sim.call(sim.client.checkpointRequest())).toEqual({
      operation: "checkpoint",
      outcome: "accepted",
      folded: false,
    });
    expect((await page(sim)).saving).toBe(true);
    live(sim).write("work/b.txt", "two");
    expect(await sim.call(sim.client.checkpointRequest())).toEqual({
      operation: "checkpoint",
      outcome: "accepted",
      folded: true,
    });
    expect(await sim.call(sim.client.checkpointRequest("long_turn"))).toEqual({
      operation: "checkpoint",
      outcome: "accepted",
      folded: true,
    });
    await sim.advance(60_000);
    const captures = live(sim).commands.filter((c) => c.type === "capture");
    expect(captures).toHaveLength(2);
    const r = sim.record();
    expect(r.saveRequests).toEqual([]);
    expect(r.workspace?.layers.map((l) => l.kind)).toEqual(["base", "delta"]);
    const state = await page(sim);
    expect(state.saving).toBe(false);
    expect(state.lastSavedAt).toBe(r.workspace?.cutAt);
    // The follow-up's tree holds both files.
    await sleepAndWake(sim);
    expect(Object.fromEntries(live(sim).tree)).toEqual({
      "work/a.txt": "one",
      "work/b.txt": "two",
    });
  });

  it("refuses checkpoints of either kind before the generation's restore is confirmed (R-19)", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.refuseStarts = 1;
    await sim.call(sim.client.resumeRequest());
    expect(await sim.call(sim.client.checkpointRequest())).toEqual({
      operation: "checkpoint",
      outcome: "refused",
      reason: "not_running",
    });
    sim.computer.supervisorOptions = { restorePolls: 50 };
    await sim.advance(20_000);
    expect(sim.record().lifecycle.context.state).toBe("restoring");
    expect(await sim.call(sim.client.checkpointRequest())).toEqual({
      operation: "checkpoint",
      outcome: "refused",
      reason: "restoring",
    });
    live(sim).signIn("claude");
    const message = live(sim).outbox.pop();
    expect(await sim.deliver(message as never).catch((error: Error) => error.message)).toMatch(
      /^\[conflict\]/,
    );
    expect(sim.record().credential).toBeNull();
    expect(live(sim).commands.filter((c) => c.type === "capture")).toHaveLength(0);
    expect(await sim.call(sim.client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "restoring",
    });
  });

  it("publishes deltas only against the current checkpoint, takes a new base after 20, and deletes what no checkpoint needs", async () => {
    const sim = new ComputerSim();
    await sim.running();
    for (let i = 0; i < 22; i += 1) {
      live(sim).write(`work/file-${i % 3}.txt`, `version ${i}`);
      await sim.call(sim.client.checkpointRequest());
      await sim.advance(5_000);
    }
    const r = sim.record();
    expect(r.workspace?.layers.map((l) => l.kind)).toEqual(["base", "delta"]);
    // The old chain's 21 layers were deleted from R2; only the current two remain.
    await sim.advance(5 * 60_000);
    expect([...sim.computer.layers.keys()].sort()).toEqual(
      r.workspace?.layers.map((l) => l.backup.id).sort(),
    );
    expect(sim.record().orphans).toEqual([]);
    expect(sim.check()).toEqual([]);
    await sleepAndWake(sim);
    expect(live(sim).tree.get("work/file-0.txt")).toBe("version 21");
    expect(live(sim).tree.get("work/file-2.txt")).toBe("version 20");
  });

  it("restores a base and deltas with deletions exactly, layer by layer, base first", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/keep.txt", "k");
    live(sim).write("work/old/gone.txt", "g");
    await sim.call(sim.client.checkpointRequest());
    live(sim).remove("work/old/gone.txt");
    live(sim).write("work/new.txt", "n");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(5_000);
    const layers = sim.record().workspace?.layers ?? [];
    expect(layers).toHaveLength(2);
    await sleepAndWake(sim);
    expect(sim.computer.restores.slice(-2).map((x) => x.id)).toEqual(
      layers.map((l) => l.backup.id),
    );
    expect(Object.fromEntries(live(sim).tree)).toEqual({
      "work/keep.txt": "k",
      "work/new.txt": "n",
    });
    // The first save after a wake is a delta against the restored checkpoint.
    live(sim).write("work/after.txt", "a");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(5_000);
    expect(sim.record().workspace?.layers.map((l) => l.kind)).toEqual(["base", "delta", "delta"]);
  });

  it("fails a restore that is missing a layer, leaving the computer failed rather than blank", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/x.txt", "x");
    await sim.call(sim.client.checkpointRequest());
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    const layer = sim.record().workspace?.layers[0];
    sim.computer.layers.delete(layer?.backup.id ?? "");
    sim.computer.backups.delete(layer?.backup.id ?? "");
    await sim.call(sim.client.resumeRequest());
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("failed");
    expect(sim.logs.some((l) => l.event === "restore_failed")).toBe(true);
  });

  it("keeps the pointer when an upload fails, and re-runs the request until a save covers it (FH-10, R-18)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    const before = sim.record().workspace;
    live(sim).write("work/a.txt", "2");
    sim.computer.failBackups = 2;
    await sim.call(sim.client.checkpointRequest());
    expect(sim.record().workspace).toEqual(before);
    expect(sim.record().saveRequests).toHaveLength(1);
    // Retried after 1, then 2 minutes.
    await sim.advance(60_000);
    expect(sim.record().workspace).toEqual(before);
    await sim.advance(3 * 60_000);
    expect(sim.record().saveRequests).toEqual([]);
    expect(sim.record().workspace?.layers).toHaveLength(2);
    expect(sim.record().orphans).toEqual([]);
    expect(sim.check()).toEqual([]);
  });

  it("repeats an upload after a transient part failure within the save, publishing one layer (WP3.22)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    const before = sim.record().workspace;
    live(sim).write("work/a.txt", "2");
    sim.computer.backupErrors = [SITTING_PART_FAILURE()];
    const attempts = sim.computer.backupAttempts.length;
    await sim.call(sim.client.checkpointRequest());
    await sim.settle();
    const r = sim.record();
    // The same capture's layer, uploaded twice, published once: no save failed.
    const tried = sim.computer.backupAttempts.slice(attempts);
    expect(tried).toHaveLength(2);
    expect(new Set(tried).size).toBe(1);
    expect(r.workspace?.layers).toHaveLength((before?.layers.length ?? 0) + 1);
    expect(r.workspace?.layers.at(-1)?.layerId).toBe(tried[0]);
    expect(r.saveRequests).toEqual([]);
    expect(r.captureFailures).toBe(0);
    expect(r.orphans).toEqual([]);
    expect(sim.sleeps).toEqual([5_000]);
    expect(sim.logs.filter((l) => l.event === "upload_retry")).toEqual([
      {
        event: "upload_retry",
        fields: expect.objectContaining({ attempt: 1, delayMs: 5_000, generation: 1 }),
      },
    ]);
    expect(sim.logs.some((l) => l.event === "save_failed")).toBe(false);
    expect(sim.check()).toEqual([]);
  });

  it("gives an upload up after its last retry, keeping the pointer, and saves on the next request (WP3.22)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    const before = sim.record().workspace;
    live(sim).write("work/a.txt", "2");
    sim.computer.backupErrors = [1, 2, 3].map(() => SITTING_PART_FAILURE());
    const attempts = sim.computer.backupAttempts.length;
    await sim.call(sim.client.checkpointRequest());
    await sim.settle();
    expect(sim.computer.backupAttempts.length - attempts).toBe(3);
    expect(sim.sleeps).toEqual([5_000, 15_000]);
    expect(sim.record().workspace).toEqual(before);
    expect(sim.record().saveRequests).toHaveLength(1);
    expect(sim.logs.filter((l) => l.event === "save_failed").at(-1)?.fields).toMatchObject({
      reason: "upload",
    });
    // The failed saves' schedule takes over, as before.
    await sim.advance(2 * 60_000);
    expect(sim.record().saveRequests).toEqual([]);
    expect(sim.record().workspace?.layers).toHaveLength((before?.layers.length ?? 0) + 1);
    expect(sim.record().orphans).toEqual([]);
    expect(sim.check()).toEqual([]);
  });

  it("never repeats a permanent upload failure (WP3.22)", async () => {
    for (const error of [
      sdkBackupError("BACKUP_INTEGRITY", "R2 stored 10 bytes, but the container uploaded 12"),
      sdkBackupError(
        "BACKUP_TRANSFER",
        "gateway rejected the part upload with HTTP 403: the write fence refused this part",
      ),
      new Error("BACKUP_TRANSFER: a part upload failed"),
    ]) {
      const sim = new ComputerSim();
      await sim.running();
      live(sim).write("work/a.txt", "1");
      sim.computer.backupErrors = [error];
      await sim.call(sim.client.checkpointRequest());
      await sim.settle();
      expect(sim.computer.backupAttempts, error.message).toHaveLength(1);
      expect(sim.sleeps).toEqual([]);
      expect(sim.record().workspace).toBeNull();
      expect(sim.logs.some((l) => l.event === "upload_retry")).toBe(false);
    }
  });

  it("stops repeating an upload at its deadline (WP3.22)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    sim.computer.backupErrors = [SITTING_PART_FAILURE()];
    sim.computer.holdBackups = true;
    await sim.client.send(sim.client.checkpointRequest());
    await sim.until(() => sim.record().capture?.phase === "upload");
    sim.computer.holdBackups = false;
    sim.expire(600_000);
    await sim.settle();
    // The held attempt ended with the deadline: no retry after it.
    expect(sim.sleeps).toEqual([]);
    expect(sim.record().workspace).toBeNull();
    expect(sim.logs.filter((l) => l.event === "save_failed").at(-1)?.fields).toMatchObject({
      reason: "upload",
    });
  });

  it("keeps an accepted request across a crash at every step of its capture (R-18)", async () => {
    const dry = new ComputerSim();
    await dry.running();
    const from = dry.steps;
    live(dry).write("work/a.txt", "1");
    await dry.call(dry.client.checkpointRequest());
    await dry.advance(5_000);
    const to = dry.steps;
    expect(dry.record().workspace).not.toBeNull();
    for (let at = from + 1; at <= to; at += 1) {
      const sim = new ComputerSim();
      await sim.running();
      sim.crashAt = at;
      live(sim).write("work/a.txt", "1");
      await sim.client.send(sim.client.checkpointRequest()).catch(() => undefined);
      await sim.settle();
      await sim.advance(10 * 60_000);
      const r = sim.record();
      // Either the request was never accepted (the crash came first: Omnigent's call failed and
      // is retried), or it was saved.
      if (r.saveRequests.length > 0 || r.workspace === null) {
        expect(r.workspace === null && r.saveRequests.length === 0).toBe(true);
      }
      expect(sim.check(), `crash at step ${at}: ${sim.stepLog[at - 1]}`).toEqual([]);
      expect(r.lifecycle.context.capturing).toBe(false);
    }
  });

  it("aborts an upload at its deadline outside the alarm, and saves on the retry", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    sim.computer.holdBackups = true;
    await sim.client.send(sim.client.checkpointRequest());
    await sim.until(() => sim.record().capture?.phase === "upload");
    // The heartbeat alarm runs and returns while the upload is held.
    await sim.controller.alarm();
    expect(sim.record().capture?.phase).toBe("upload");
    expect(sim.deadlines.some((d) => d.ms === 600_000)).toBe(true);
    sim.computer.holdBackups = false;
    sim.expire(600_000);
    await sim.settle();
    expect(sim.record().workspace).toBeNull();
    expect(sim.record().saveRequests).toHaveLength(1);
    await sim.advance(2 * 60_000);
    expect(sim.record().workspace?.layers).toHaveLength(1);
  });

  it("saves as a backstop after 15 minutes without a request while runners exist, recording verified unchanged", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    live(sim).runnerProcesses = 1;
    live(sim).report();
    await sim.settle();
    const captures = () => live(sim).commands.filter((c) => c.type === "capture").length;
    const first = captures();
    await sim.advance(14 * 60_000);
    expect(captures()).toBe(first);
    await sim.advance(2 * 60_000);
    expect(captures()).toBe(first + 1);
    const r = sim.record();
    expect(r.unchanged).toMatchObject({
      generation: 1,
      parentCheckpointId: r.workspace?.checkpointId,
    });
    expect(r.verified?.how).toBe("unchanged");
    // Durable: it survives a new instance.
    await sim.restart();
    expect(sim.record().unchanged).toEqual(r.unchanged);
    // A file changed afterwards, with publication blocked, is not covered by it: admission closes
    // 30 minutes after that verification (ARR-008).
    live(sim).write("work/a.txt", "2");
    sim.computer.failBackups = 1000;
    const verifiedAt = r.verified?.at ?? 0;
    await sim.advance(verifiedAt + 30 * 60_000 - sim.now);
    expect(sim.record().notSaved).toBeNull();
    await sim.advance(2 * 60_000);
    expect(sim.record().notSaved).not.toBeNull();
    expect(await sim.call(sim.client.admissionRequest())).toMatchObject({
      admitting: false,
      reason: "not_saved",
    });
  });

  it("closes admission after 30 minutes unverified, retries after 1, 2, then 5 minutes, and reopens on a verified save (R-04)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    sim.computer.failBackups = 1000;
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(31 * 60_000);
    expect(sim.record().notSaved).not.toBeNull();
    const admission = await sim.call(sim.client.admissionRequest());
    expect(admission).toMatchObject({ admitting: false, reason: "not_saved" });
    const tries = () => live(sim).commands.filter((c) => c.type === "capture").length;
    const n = tries();
    await sim.advance(20 * 60_000);
    // 1, 2, then every 5 minutes: about 1 + 1 + 3 retries in 20 minutes, plus the backoff of the
    // failed saves themselves; never more than one every minute.
    expect(tries() - n).toBeGreaterThanOrEqual(4);
    expect(tries() - n).toBeLessThanOrEqual(20);
    sim.computer.failBackups = 0;
    await sim.advance(6 * 60_000);
    expect(sim.record().notSaved).toBeNull();
    expect(await sim.call(sim.client.admissionRequest())).toMatchObject({ admitting: true });
  });

  it("starts a woken computer with a fresh measure, and keeps admission open through an approval wait without changes", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a.txt", "1");
    await sim.call(sim.client.checkpointRequest());
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    // A long sleep.
    await sim.advance(10 * 3_600_000);
    await sim.client.wake({ hostId: HOST, token: sim.token(2) });
    await sim.advance(10_000);
    expect(sim.record().verified).toMatchObject({ generation: 2, how: "restore" });
    expect(sim.record().notSaved).toBeNull();
    // A turn waits on an approval for an hour: Omnigent asks for a long-turn save every 10 minutes,
    // nothing changed, each is verified unchanged.
    for (let i = 0; i < 6; i += 1) {
      await sim.advance(10 * 60_000);
      await sim.call(sim.client.checkpointRequest("long_turn"));
    }
    expect(sim.record().notSaved).toBeNull();
    expect(sim.record().verified?.how).toBe("unchanged");
  });

  it("raises the pause target to the hard budget for a workspace above about 2 GB (D25)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.checkpointRequest());
    const leases = () => live(sim).commands.flatMap((c) => (c.type === "capture" ? [c.lease] : []));
    expect(leases().at(-1)).toEqual({ targetMs: 20_000, hardMs: 40_000 });
    const raw = sim.store.get(RECORD_KEY) as Record<string, unknown>;
    sim.store.put(RECORD_KEY, { ...raw, workspaceBytes: 2_400_000_000 });
    live(sim).write("work/b", "b");
    await sim.call(sim.client.checkpointRequest());
    expect(leases().at(-1)).toEqual({ targetMs: 40_000, hardMs: 40_000 });
  });

  it("accepts a SIGTERM's save request once, by its operation ID", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).write("work/a", "a");
    live(sim).sigterm();
    const message = live(sim).outbox.at(-1);
    await sim.settle();
    expect(await sim.deliver(message as never)).toEqual({
      type: "save_request",
      outcome: "accepted",
    });
    expect(sim.record().workspace).not.toBeNull();
  });
});

describe("credential checkpoints", () => {
  it("publishes through the computer API into the bucket, never through DirectoryBackup", async () => {
    const sim = new ComputerSim();
    await sim.running();
    const backups = sim.computer.backups.size;
    live(sim).signIn("claude");
    await sim.settle();
    const r = sim.record();
    expect(r.credential?.files[".claude/.credentials.json"].state).toBe("present");
    expect(sim.computer.backups.size).toBe(backups);
    expect(sim.bucket.objects.has(r.credential?.object.key ?? "")).toBe(true);
    // The record holds the files' states, never their content.
    expect(sim.store.dump()).not.toContain("claude-login-canary");
    expect((await page(sim)).setupCards).toEqual([
      { provider: "claude", state: "signed_in" },
      { provider: "codex", state: "needs_sign_in", reason: "not_signed_in" },
    ]);
  });

  it("is retried until acknowledged while the bucket fails, then published (R-18)", async () => {
    const sim = new ComputerSim();
    await sim.running();
    sim.bucket.blocked = true;
    live(sim).signIn("codex");
    await sim.settle();
    expect(sim.record().credential).toBeNull();
    expect(live(sim).outbox).toHaveLength(1);
    sim.bucket.blocked = false;
    await sim.settle();
    expect(sim.record().credential?.files[".codex/auth.json"].state).toBe("present");
    expect(live(sim).outbox).toHaveLength(0);
  });

  it("answers a repeat with the recorded outcome, and supersedes older or pre-install copies", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).signIn("claude");
    const first = live(sim).outbox.at(-1);
    await sim.settle();
    const pointer = sim.record().credential;
    expect(await sim.deliver(first as never)).toEqual({
      type: "credential_checkpoint",
      outcome: "published",
      checkpointId: pointer?.checkpointId,
    });
    live(sim).signIn("codex");
    await sim.settle();
    expect(await sim.deliver(first as never)).toEqual({
      type: "credential_checkpoint",
      outcome: "superseded",
      checkpointId: null,
    });
    // The superseded bundle object is deleted; the pointer's is kept.
    await sim.advance(60_000);
    expect(sim.bucket.objects.size).toBe(1);
    expect(sim.bucket.objects.has(sim.record().credential?.object.key ?? "")).toBe(true);
  });
});
