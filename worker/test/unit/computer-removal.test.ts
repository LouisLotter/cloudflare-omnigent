// WorkspaceDO's controller: removal intents, sign-out runs and their verification, the resolved
// removal's deletions, and reconciliation after Omnigent's database loses writes (FH-29).
import { describe, expect, it } from "vitest";
import { ComputerSim, HOST, live } from "../support/computer-sim.ts";

const pageCall = (
  sim: ComputerSim,
  action: "sign_out" | "resolve_removal" | "record_revocation",
  n: number,
) =>
  sim.controller.pages({
    interfaceVersion: 1,
    action,
    operationId: `op_000000000000000000000000${String(n).padStart(2, "0")}`,
  });

const state = (sim: ComputerSim) => sim.page();

/** A running computer with both logins published and some saved work. */
async function signedIn(sim: ComputerSim): Promise<void> {
  await sim.running();
  live(sim).signIn("claude");
  live(sim).signIn("codex");
  live(sim).write("work/project.txt", "saved work");
  await sim.call(sim.client.checkpointRequest());
  await sim.settle();
}

describe("removal", () => {
  it("records a removal intent by terminate, stops through the checkpoints, and keeps the credentials", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
    await sim.advance(30_000);
    const r = sim.record();
    expect(r.lifecycle.context).toMatchObject({ state: "removal_pending", removalIntent: true });
    expect(r.stop).toMatchObject({ reason: "removal" });
    expect(sim.computer.running).toBe(false);
    expect(sim.control.slots.size).toBe(0);
    expect(r.credential?.files[".claude/.credentials.json"].state).toBe("present");
    expect(sim.bucket.objects.has(r.credential?.object.key ?? "")).toBe(true);
    // Every later wake and start is refused as gone, even if Omnigent's deletion rolled back.
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("gone");
    expect(await sim.client.refusal(sim.client.claimRequest())).toBe("gone");
    expect(
      await sim.client.refusal(
        sim.client.startRequest({ attempt: 9, token: sim.token(9), hostId: HOST }),
      ),
    ).toBe("gone");
    expect(await sim.client.refusal(sim.client.statusRequest())).toBe("gone");
    expect(await sim.client.refusal(sim.client.admissionRequest())).toBe("gone");
    expect(await sim.client.refusal(sim.client.checkpointRequest())).toBe("gone");
    // A sleep too (3.C, as the launcher expects): `gone`, not `stopped`, and a repeat of the same
    // operation gets the same recorded answer.
    const sleep = sim.client.suspendRequest();
    expect(await sim.client.refusal(sleep)).toBe("gone");
    expect(await sim.client.refusal(sleep)).toBe("gone");
    expect(sim.computer.starts).toHaveLength(1);
    expect(await state(sim)).toMatchObject({
      removal: { state: "pending", signOut: "none" },
      noContact: false,
    });
  });

  it("refuses to resolve while a login may remain, and resolves after a verified sign-out run", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    expect(await pageCall(sim, "resolve_removal", 1)).toEqual({
      action: "resolve_removal",
      outcome: "refused",
      reason: "unresolved",
    });
    // The sign-out run starts the computer for the CLIs' logouts only; Omnigent stays refused.
    expect(await pageCall(sim, "sign_out", 2)).toEqual({ action: "sign_out", outcome: "accepted" });
    await sim.advance(30_000);
    expect(await sim.client.refusal(sim.client.claimRequest())).toBe("gone");
    const types = sim.computer.supervisors[1]?.commands.map((c) => c.type) ?? [];
    expect(types).toContain("sign_out");
    expect(types).not.toContain("start_host");
    await sim.advance(2 * 60_000);
    let r = sim.record();
    expect(r.signOut.phase).toBe("verified");
    expect(r.lifecycle.context.state).toBe("removal_pending");
    expect(sim.computer.running).toBe(false);
    expect(r.credential?.files[".claude/.credentials.json"].state).toBe("tombstone");
    // Resolved: records, layers and bundles deleted, ControlDO forgets the computer.
    expect(await pageCall(sim, "resolve_removal", 3)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
    await sim.advance(5 * 60_000);
    r = sim.record();
    expect(r.lifecycle.context.state).toBe("removed");
    expect(r.deletion).toBeNull();
    expect(r.workspace).toBeNull();
    expect(r.credential).toBeNull();
    expect(sim.computer.layers.size).toBe(0);
    expect(sim.bucket.objects.size).toBe(0);
    expect(sim.control.calls.some((c) => c.method === "forget_computer")).toBe(true);
    expect(sim.store.keys("op:")).toEqual([]);
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "resolved",
    });
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("gone");
    expect(await state(sim)).toMatchObject({ removal: { state: "resolved" } });
    expect(sim.check()).toEqual([]);
  });

  it("refuses a sign-out run at the limit, and resolves on a recorded revocation instead", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    sim.control.maxAwakeComputers = 0;
    expect(await pageCall(sim, "sign_out", 1)).toEqual({
      action: "sign_out",
      outcome: "refused",
      reason: "at_capacity",
    });
    expect(await pageCall(sim, "record_revocation", 2)).toEqual({
      action: "record_revocation",
      recorded: true,
    });
    expect(await pageCall(sim, "resolve_removal", 3)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
  });

  it("keeps a removal unresolved when a login may have been lost unpublished, until revocation is recorded", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    live(sim).refreshUnpublished("codex");
    live(sim).report();
    await sim.settle();
    sim.computer.stopByPlatform();
    await sim.advance(60_000);
    await sim.call(sim.client.terminateRequest());
    expect(sim.record().signOut.loginPossiblyLost).toBe(true);
    // Even a verified sign-out does not settle it.
    await pageCall(sim, "sign_out", 1);
    await sim.advance(3 * 60_000);
    expect(sim.record().signOut.phase).toBe("verified");
    expect(await pageCall(sim, "resolve_removal", 2)).toEqual({
      action: "resolve_removal",
      outcome: "refused",
      reason: "unresolved",
    });
    await pageCall(sim, "record_revocation", 3);
    expect(await pageCall(sim, "resolve_removal", 4)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
  });

  it("resolves a computer that never held a login without a sign-out", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    expect(await pageCall(sim, "resolve_removal", 1)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
  });

  it("retries a removal stop whose checkpoint fails a heartbeat later, until it stops", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    live(sim).write("work/later.txt", "unsaved");
    live(sim).options.failCaptures = 3;
    await sim.call(sim.client.terminateRequest());
    await sim.settle();
    const captures = () =>
      (sim.computer.supervisors[0]?.commands ?? []).filter((c) => c.type === "capture").length;
    const first = captures();
    expect(sim.record().lifecycle.context).toMatchObject({ state: "host_running", stopPrep: null });
    await sim.advance(30_000);
    expect(captures()).toBe(first);
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
    expect(captures()).toBeLessThanOrEqual(first + 4);
    expect(sim.record().stop).toMatchObject({ reason: "removal" });
  });

  it("records a removal intent while waking: the start is fenced and stopped", async () => {
    const sim = new ComputerSim();
    await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
    sim.computer.refuseStarts = 1;
    await sim.call(sim.client.resumeRequest());
    expect(sim.record().lifecycle.context.state).toBe("waking");
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
    await sim.advance(60_000);
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
    expect(sim.computer.running).toBe(false);
    expect(sim.control.slots.size).toBe(0);
    expect(sim.computer.starts).toHaveLength(1);
  });
});

describe("after Omnigent's database loses writes (FH-29)", () => {
  it("refuses an earlier launch token: a stopped container's token is gone, and its late start is refused", async () => {
    const sim = new ComputerSim();
    const attempt = await sim.running();
    const stale = sim.client.startRequest({ attempt, token: sim.token(50), hostId: HOST });
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    expect(sim.store.get("launch-token")).toBeUndefined();
    expect(await sim.client.refusal(stale)).toBe("conflict");
    // The next wake needs a new claim; the old attempt's start stays refused after it.
    await sim.client.wake({ hostId: HOST, token: sim.token(51) });
    await sim.advance(10_000);
    expect(await sim.client.refusal({ ...stale, operationId: sim.client.operationId() })).toBe(
      "conflict",
    );
    expect(sim.sup?.token).toBe(sim.tokens.at(-1));
  });

  it("shows a computer Omnigent no longer calls as not connected after 60 minutes", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    expect((await state(sim)).noContact).toBe(false);
    await sim.advance(61 * 60_000);
    expect((await state(sim)).noContact).toBe(true);
    await sim.call(sim.client.statusRequest());
    expect((await state(sim)).noContact).toBe(false);
  });
});
