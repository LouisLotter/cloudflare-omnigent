// WorkspaceDO's controller: removal intents, sign-out runs and their verification, the resolved
// removal's deletions, and reconciliation after Omnigent's database loses writes (FH-29).
import { describe, expect, it } from "vitest";
import { holdsLogin } from "../../src/computer/checkpoints.ts";
import { removalFactsOf, removeOffered } from "../../src/computer/ownership.ts";
import {
  type ComputerRecord,
  MEMBER_REMOVAL_KEY,
  RECORD_KEY,
  SIGN_OUT_FAILED_KEY,
} from "../../src/computer/record.ts";
import { computerView } from "../../src/pages/view.ts";
import { ComputerSim, HOST, live } from "../support/computer-sim.ts";

const pageCall = (
  sim: ComputerSim,
  action:
    | "sign_out"
    | "resolve_removal"
    | "record_revocation"
    | "delete_without_sign_out"
    | "stop_without_saving",
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

describe("a sleep's outcome across a removal (Codex WP3.18 r1-2)", () => {
  it("keeps an earlier suspend's recorded outcome after the removal is resolved and wiped", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    const sleep = sim.client.suspendRequest();
    await sim.call(sleep);
    await sim.advance(30_000);
    expect(await sim.call(sleep)).toEqual({ operation: "suspend", outcome: "stopped" });
    // Another sleep, asked for while asleep: recorded `stopped` at once.
    const asleep = sim.client.suspendRequest();
    expect(await sim.call(asleep)).toEqual({ operation: "suspend", outcome: "stopped" });
    // The first one's record left in progress (as a reset before its settlement would leave it).
    const key = `op:launcher:${sleep.operationId}`;
    sim.store.put(key, { ...(sim.store.get(key) as object), outcome: null });
    expect(await sim.call(sleep)).toEqual({ operation: "suspend", outcome: "in_progress" });
    const stuck = sim.client.suspendRequest();
    const terminate = await sim.call(sim.client.terminateRequest());
    expect(terminate).toEqual({ operation: "terminate", removal: "pending" });
    expect(await sim.client.refusal(stuck)).toBe("gone");
    // Never held a login: the removal resolves at once, and the records are wiped.
    expect(await pageCall(sim, "resolve_removal", 1)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removed");
    expect(sim.record().deletion).toBeNull();
    // Only the sleeps' records survive the wipe (with their time entries, so they still expire).
    expect(sim.store.keys("op:")).toHaveLength(2);
    expect(sim.store.keys("opt:")).toHaveLength(2);
    // The same operations still learn their outcome (the one left in progress ended with the
    // confirmed stop); a new one, and the gone one, are gone.
    expect(await sim.call(sleep)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(await sim.call(asleep)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(await sim.client.refusal(stuck)).toBe("gone");
    expect(await sim.client.refusal(sim.client.suspendRequest())).toBe("gone");
    await sim.advance(8 * 24 * 3_600_000);
    expect(await sim.client.refusal(sleep)).toBe("gone");
    sim.check();
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

  it("never counts an asleep computer as not connected: no status, notice, restart or removal", async () => {
    const sim = new ComputerSim();
    await sim.running();
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    await sim.advance(61 * 60_000);
    const asleep = await state(sim);
    expect(asleep).toMatchObject({ lifecycle: "asleep", noContact: false });
    for (const access of ["owner", "admin"] as const) {
      const view = computerView({ ...asleep, access }, Date.now());
      expect(view).toMatchObject({
        status: "Asleep",
        notConnected: false,
        offerRestart: false,
        offerRemove: false,
      });
      expect(view.notices.map((n) => n.kind)).not.toContain("not_connected");
    }
    expect(removeOffered(removalFactsOf(asleep))).toBe(false);
  });

  it("counts an awake computer Omnigent no longer calls as a lost host: notice, restart, removal", async () => {
    const sim = new ComputerSim();
    await sim.running();
    await sim.advance(61 * 60_000);
    const lost = await state(sim);
    expect(lost).toMatchObject({ lifecycle: "host_running", noContact: true });
    for (const access of ["owner", "admin"] as const) {
      const view = computerView({ ...lost, access }, Date.now());
      expect(view).toMatchObject({
        status: "Not connected to Omnigent",
        notConnected: true,
        offerRestart: true,
        offerRemove: true,
      });
      expect(view.notices.find((n) => n.kind === "not_connected")?.text).toContain(
        "Omnigent has not called this computer since",
      );
    }
    // Any launcher call is contact again.
    await sim.call(sim.client.statusRequest());
    expect((await state(sim)).noContact).toBe(false);
  });
});

describe("a sign-out run's phase (WP3.27, the 28 Oct sitting's B3)", () => {
  const runSignOut = async (sim: ComputerSim) => {
    expect(await pageCall(sim, "sign_out", 1)).toEqual({ action: "sign_out", outcome: "accepted" });
    const phases: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await sim.advance(5_000);
      phases.push(sim.record().signOut.phase);
    }
    return phases;
  };

  it("reaches verified when the CLIs log out one after the other, never passing through none", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { staggeredLogouts: true };
    await signedIn(sim);
    const phases = await runSignOut(sim);
    expect(phases).not.toContain("none");
    expect(phases.at(-1)).toBe("verified");
    expect(sim.record().signOut.job).toBeNull();
    // Both bundles of the run were published: the in-between one did not undo it.
    expect(sim.logs.filter((l) => l.event === "credentials_published").length).toBeGreaterThan(3);
    const status = await sim.controller.computerStatus();
    expect(status.signOut).toEqual({ phase: "verified", running: false });
    expect(await state(sim)).toMatchObject({ removal: { signOut: "verified", settled: true } });
  });

  it("ends undone when a logout leaves its login: the run's snapshot decides", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { staggeredLogouts: true, failedLogout: "codex" };
    await signedIn(sim);
    const phases = await runSignOut(sim);
    expect(phases.at(-1)).toBe("none");
    expect(sim.record().signOut.job).toBeNull();
    expect(sim.record().credential?.files[".codex/auth.json"].state).toBe("present");
    expect(sim.logs.find((l) => l.event === "sign_out_ran")?.fields).toMatchObject({
      claude: "ok",
      codex: "failed",
    });
    expect(await state(sim)).toMatchObject({ removal: { settled: false } });
  });

  // Codex WP3.27 r1-1: a run started from `verified` or `tombstoned` (the table keeps both at
  // `requested`) must not keep claiming them once a login is published between its logouts.
  const runToEnd = async (sim: ComputerSim, n: number) => {
    expect(await pageCall(sim, "sign_out", n)).toEqual({ action: "sign_out", outcome: "accepted" });
    const phases: string[] = [];
    for (let i = 0; i < 90 && (i === 0 || sim.record().signOut.job !== null); i += 1) {
      await sim.advance(5_000);
      const r = sim.record();
      phases.push(r.signOut.phase);
      // Never a claim with a login in the pointer, and never a removal it would let through.
      if (r.credential !== null && holdsLogin(r.credential.files)) {
        expect(["none", "requested"]).toContain(r.signOut.phase);
        expect(await state(sim)).toMatchObject({ removal: { settled: false } });
      }
    }
    expect(sim.record().signOut.job).toBeNull();
    return phases;
  };

  for (const start of ["verified", "tombstoned"] as const) {
    for (const codexLogout of ["ok", "failed"] as const) {
      it(`a login written after a sign-out that ended ${start}, then a run whose Codex logout is ${codexLogout}`, async () => {
        const sim = new ComputerSim();
        sim.computer.supervisorOptions = { staggeredLogouts: true };
        await signedIn(sim);
        // The first run: verified, or tombstoned when its read-back never succeeds (given up).
        if (start === "tombstoned") sim.bucket.failGets = 1_000;
        await runToEnd(sim, 1);
        sim.bucket.failGets = 0;
        expect(sim.record().signOut.phase).toBe(start);
        const reads = sim.bucket.gets.length;
        // Codex writes a login again; nothing has published it when the next run starts, so the
        // first bundle holding it is published between that run's logouts.
        live(sim).credentials.set(".codex/auth.json", "codex-login-canary-again");
        live(sim).options.failedLogout = codexLogout === "failed" ? "codex" : null;
        // Every record write, not only the samples: the run's steps can all land in one pass.
        const claims: string[] = [];
        const put = sim.store.put.bind(sim.store);
        sim.store.put = (key: string, value: unknown) => {
          put(key, value);
          const r = key === RECORD_KEY ? (value as ComputerRecord) : null;
          if (r?.credential != null && holdsLogin(r.credential.files)) {
            if (r.signOut.phase === "tombstoned" || r.signOut.phase === "verified") {
              claims.push(r.signOut.phase);
            }
          }
        };
        const phases = await runToEnd(sim, 2);
        expect(claims).toEqual([]);
        if (codexLogout === "ok") {
          // The run's own tombstones, read back again, are what it now claims (the run takes one
          // runner pass here, so the samples see only its end).
          expect(phases.at(-1)).toBe("verified");
          expect(sim.bucket.gets.length).toBeGreaterThan(reads);
          expect(await state(sim)).toMatchObject({ removal: { settled: true } });
        } else {
          expect(phases.at(-1)).toBe("none");
          expect(sim.record().credential?.files[".codex/auth.json"].state).toBe("present");
          expect(await state(sim)).toMatchObject({ removal: { settled: false } });
        }
      });
    }
  }
});

describe("deleting a removed computer without a sign-out (WP8.9)", () => {
  /** A removal whose computer stopped again, with both logins saved. */
  async function removing(sim: ComputerSim): Promise<void> {
    await signedIn(sim);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
  }

  /** Runs a sign-out to its end and waits for the computer to stop again. */
  async function signOutRun(sim: ComputerSim, n: number): Promise<void> {
    expect(await pageCall(sim, "sign_out", n)).toEqual({ action: "sign_out", outcome: "accepted" });
    for (let i = 0; i < 90 && (i === 0 || sim.record().signOut.job !== null); i += 1) {
      await sim.advance(5_000);
    }
    await sim.advance(2 * 60_000);
    expect(sim.record().signOut.job).toBeNull();
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
  }

  it("refuses it while a sign-out was never tried, and once one settles", async () => {
    const sim = new ComputerSim();
    await removing(sim);
    expect(await pageCall(sim, "delete_without_sign_out", 1)).toEqual({
      action: "delete_without_sign_out",
      outcome: "refused",
      reason: "not_offered",
    });
    await signOutRun(sim, 2);
    expect(sim.record().signOut.phase).toBe("verified");
    expect(await state(sim)).toMatchObject({ removal: { settled: true, signOutFailed: false } });
    expect(await pageCall(sim, "delete_without_sign_out", 3)).toMatchObject({
      outcome: "refused",
    });
    expect(sim.record().lifecycle.context.state).toBe("removal_pending");
  });

  it("deletes after a sign-out was tried and failed, saying nothing was revoked", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { staggeredLogouts: true, failedLogout: "codex" };
    await removing(sim);
    await signOutRun(sim, 1);
    // The failed logout leaves the phase at none: only the marker says it was tried.
    expect(sim.record().signOut.phase).toBe("none");
    expect(sim.store.get(SIGN_OUT_FAILED_KEY)).toBeDefined();
    expect(await state(sim)).toMatchObject({ removal: { settled: false, signOutFailed: true } });
    expect(await pageCall(sim, "resolve_removal", 2)).toMatchObject({ outcome: "refused" });

    expect(await pageCall(sim, "delete_without_sign_out", 3)).toEqual({
      action: "delete_without_sign_out",
      outcome: "accepted",
    });
    expect(sim.logs.some((l) => l.event === "removal_resolved_unsigned")).toBe(true);
    await sim.advance(5 * 60_000);
    const r = sim.record();
    expect(r.lifecycle.context.state).toBe("removed");
    expect(r.credential).toBeNull();
    expect(sim.bucket.objects.size).toBe(0);
    expect(sim.store.get(SIGN_OUT_FAILED_KEY)).toBeUndefined();
  });

  it("deletes a computer whose login may have changed after its last save, with no run", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    live(sim).refreshUnpublished("codex");
    live(sim).report();
    await sim.settle();
    sim.computer.stopByPlatform();
    await sim.advance(60_000);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    expect(sim.record().signOut.loginPossiblyLost).toBe(true);
    expect(await pageCall(sim, "delete_without_sign_out", 1)).toEqual({
      action: "delete_without_sign_out",
      outcome: "accepted",
    });
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removed");
    expect(sim.bucket.objects.size).toBe(0);
  });

  it("starts each sign-out run afresh: a new run clears the last one's failure", async () => {
    const sim = new ComputerSim();
    sim.computer.supervisorOptions = { staggeredLogouts: true, failedLogout: "codex" };
    await removing(sim);
    await signOutRun(sim, 1);
    expect(sim.store.get(SIGN_OUT_FAILED_KEY)).toBeDefined();
    sim.computer.supervisorOptions = { staggeredLogouts: true };
    await signOutRun(sim, 2);
    expect(sim.record().signOut.phase).toBe("verified");
    expect(sim.store.get(SIGN_OUT_FAILED_KEY)).toBeUndefined();
    expect(await pageCall(sim, "delete_without_sign_out", 3)).toMatchObject({
      outcome: "refused",
    });
  });
});

describe("a removed member's computer whose save before stopping keeps failing (WP8.9, Codex r1 CF-1)", () => {
  const ALICE = {
    userId: "alice",
    memberId: "0a1b2c3d4e5f40718293a4b5c6d7e8f9",
    teamId: "9f8e7d6c5b4a49382716f5e4d3c2b1a0",
    hostId: HOST,
  };

  /** Alice's computer, signed in and saved once, then a failure that keeps its saves failing. */
  async function alicesComputer(sim: ComputerSim): Promise<void> {
    sim.client.owner = ALICE;
    await signedIn(sim);
  }

  /** Omnigent removes Alice: her account is gone, so its terminate names her without a member. */
  async function omnigentRemovesAlice(sim: ComputerSim): Promise<void> {
    sim.client.owner = { ...ALICE, memberId: null, teamId: null };
    expect(await sim.call(sim.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
  }

  /** Advances until the removal's stops were refused `n` times, or the computer stopped. */
  async function untilRefused(sim: ComputerSim, n: number): Promise<number> {
    for (let i = 0; i < 40; i += 1) {
      const removal = (await state(sim)).removal;
      if ((removal.refusedStops ?? 0) >= n || !sim.computer.running) break;
      await sim.advance(60_000);
    }
    return (await state(sim)).removal.refusedStops ?? 0;
  }

  const offered = async (sim: ComputerSim) =>
    computerView({ ...(await state(sim)), access: "admin" }, Date.now()).pending;

  it("offers stopping without saving after 3 refused stops when its files cannot be saved", async () => {
    const sim = new ComputerSim();
    await alicesComputer(sim);
    live(sim).options.failCaptures = 10_000;
    await omnigentRemovesAlice(sim);
    expect(await state(sim)).toMatchObject({ removal: { memberRemoved: true } });
    // Before the third refused stop: nothing but the retries.
    expect(await untilRefused(sim, 2)).toBe(2);
    expect((await offered(sim))?.stopWithoutSaving).toBe(false);
    expect(await untilRefused(sim, 3)).toBeGreaterThanOrEqual(3);
    expect(sim.computer.running).toBe(true);
    expect((await offered(sim))?.stopWithoutSaving).toBe(true);
    // Nothing deletes a running computer.
    expect(await pageCall(sim, "resolve_removal", 10)).toMatchObject({ outcome: "refused" });
    expect(await pageCall(sim, "delete_without_sign_out", 11)).toMatchObject({
      outcome: "refused",
    });
    // Evicted: the offer is durable.
    await sim.restart();
    expect((await offered(sim))?.stopWithoutSaving).toBe(true);

    // Called while a retry of the removal's save is under way (its capture now hangs): the
    // retry gives way.
    live(sim).options.failCaptures = 0;
    live(sim).options.capturePolls = 1_000_000;
    for (let i = 0; i < 20 && sim.record().lifecycle.context.stopPrep !== "removal"; i += 1) {
      await sim.advance(10_000);
    }
    expect(sim.record().lifecycle.context.stopPrep).toBe("removal");
    expect(await pageCall(sim, "stop_without_saving", 2)).toEqual({
      action: "stop_without_saving",
      outcome: "accepted",
    });
    expect(sim.record().lifecycle.context.stopPrep).toBe("without_saving");
    await sim.advance(3 * 60_000);
    // Its saves fail again in its next start, the sign-out's, and so for the stop after it.
    sim.computer.supervisorOptions = { failCaptures: 10_000 };
    let r = sim.record();
    expect(sim.computer.running).toBe(false);
    expect(r.lifecycle.context.state).toBe("removal_pending");
    // Its logins were saved first: nothing was lost but the unsaved files.
    expect(r.signOut.loginPossiblyLost).toBe(false);

    // The administrator finishes it: a sign-out, its stop (saves still failing), then deletion.
    await pageCall(sim, "sign_out", 3);
    for (let i = 0; i < 40 && sim.record().signOut.phase !== "verified"; i += 1) {
      await sim.advance(5_000);
    }
    expect(sim.record().signOut.phase).toBe("verified");
    // Started for the sign-out, it stops again through the removal, whose save still fails.
    await sim.advance(2 * 60_000);
    if (sim.computer.running) {
      expect((await offered(sim))?.stopWithoutSaving).toBe(true);
      expect(await pageCall(sim, "stop_without_saving", 4)).toMatchObject({ outcome: "accepted" });
      await sim.advance(3 * 60_000);
    }
    expect(sim.computer.running).toBe(false);
    expect(await pageCall(sim, "resolve_removal", 5)).toEqual({
      action: "resolve_removal",
      outcome: "accepted",
    });
    await sim.advance(5 * 60_000);
    r = sim.record();
    expect(r.lifecycle.context.state).toBe("removed");
    expect(sim.bucket.objects.size).toBe(0);
    expect(sim.store.get(MEMBER_REMOVAL_KEY)).toBeUndefined();
  });

  it("stops it even when its logins cannot be saved, and then deletes it without a sign-out", async () => {
    const sim = new ComputerSim();
    await alicesComputer(sim);
    // A login changed since the last save, and its publication is held back.
    live(sim).options.holdCredentials = true;
    live(sim).refreshUnpublished("codex");
    live(sim).report();
    await sim.settle();
    await omnigentRemovesAlice(sim);
    expect(await untilRefused(sim, 3)).toBeGreaterThanOrEqual(3);
    expect(sim.computer.running).toBe(true);
    await sim.restart();
    expect(await pageCall(sim, "stop_without_saving", 1)).toMatchObject({ outcome: "accepted" });
    // Evicted while its logins are still not saved: the stop still goes on.
    await sim.advance(60_000);
    await sim.restart();
    await sim.advance(3 * 60_000);
    const r = sim.record();
    expect(sim.computer.running).toBe(false);
    expect(r.lifecycle.context.state).toBe("removal_pending");
    expect(r.signOut.loginPossiblyLost).toBe(true);
    expect(sim.logs.some((l) => l.event === "stop_without_saving_unpublished")).toBe(true);
    // A login may be lost: the administrator deletes it without a sign-out, the page saying so.
    expect((await offered(sim))?.deleteWithoutSignOut).toBe(true);
    expect(await pageCall(sim, "delete_without_sign_out", 2)).toEqual({
      action: "delete_without_sign_out",
      outcome: "accepted",
    });
    await sim.advance(5 * 60_000);
    expect(sim.record().lifecycle.context.state).toBe("removed");
    expect(sim.bucket.objects.size).toBe(0);
  });

  for (const start of ["host_refused", "started_no_host"] as const) {
    it(`counts the removal's saves past the no-host deadline, ${start} (Codex r2 CF-3)`, async () => {
      // Default timing: the five-minute no-host deadline competes with the removal's retries.
      const sim = new ComputerSim();
      sim.client.owner = ALICE;
      if (start === "host_refused") {
        await sim.running();
      } else {
        await sim.call(sim.client.provisionRequest("managed-7f3c2a9e"));
        await sim.call(sim.client.resumeRequest());
        await sim.advance(1000);
      }
      live(sim).signIn("claude");
      await sim.call(sim.client.checkpointRequest());
      await sim.settle();
      // A login changed since the last save, whose publication is held back.
      live(sim).options.holdCredentials = true;
      live(sim).refreshUnpublished("codex");
      if (start === "host_refused") live(sim).refuseHost();
      else live(sim).report();
      await sim.settle();
      expect(sim.record().lifecycle.context.state).toBe(start);
      await omnigentRemovesAlice(sim);
      // Past the deadline, then evicted.
      await sim.advance(15 * 60_000);
      await sim.restart();
      await sim.advance(10 * 60_000);
      expect(sim.computer.running).toBe(true);
      expect((await state(sim)).removal.refusedStops ?? 0).toBeGreaterThanOrEqual(3);
      expect((await offered(sim))?.stopWithoutSaving).toBe(true);
      // Whatever its label, the save being retried gives way.
      expect(await pageCall(sim, "stop_without_saving", 1)).toEqual({
        action: "stop_without_saving",
        outcome: "accepted",
      });
      await sim.advance(5 * 60_000);
      const r = sim.record();
      expect(sim.computer.running).toBe(false);
      expect(r.lifecycle.context.state).toBe("removal_pending");
      expect(r.signOut.loginPossiblyLost).toBe(true);
      expect(await pageCall(sim, "delete_without_sign_out", 2)).toMatchObject({
        outcome: "accepted",
      });
      await sim.advance(5 * 60_000);
      expect(sim.record().lifecycle.context.state).toBe("removed");
      expect(sim.bucket.objects.size).toBe(0);
    });
  }

  it("stops normally when its saves recover before anyone acts", async () => {
    const sim = new ComputerSim();
    await alicesComputer(sim);
    live(sim).options.failCaptures = 3;
    await omnigentRemovesAlice(sim);
    await untilRefused(sim, 3);
    await sim.advance(5 * 60_000);
    const r = sim.record();
    expect(sim.computer.running).toBe(false);
    expect(r.lifecycle.context.state).toBe("removal_pending");
    expect(r.signOut.loginPossiblyLost).toBe(false);
    expect((await offered(sim))?.stopWithoutSaving).toBe(false);
  });

  it("keeps the owner's own removal of their computer on today's rules", async () => {
    const sim = new ComputerSim();
    await alicesComputer(sim);
    live(sim).options.failCaptures = 10_000;
    // Alice deletes her own computer in Omnigent: still a member.
    expect(await sim.call(sim.client.terminateRequest())).toMatchObject({ removal: "pending" });
    await sim.advance(10 * 60_000);
    const page = await state(sim);
    expect(page.removal).toMatchObject({ memberRemoved: false, refusedStops: 0 });
    expect(sim.computer.running).toBe(true);
    expect((await offered(sim))?.stopWithoutSaving).toBe(false);
    expect(await pageCall(sim, "stop_without_saving", 1)).toEqual({
      action: "stop_without_saving",
      outcome: "refused",
      reason: "not_offered",
    });
  });
});

describe("a resolved removal's deletions (WP8.9, Codex r1 CF-2)", () => {
  it("says Deleting… until its saved logins are deleted, across a failed delete and an eviction", async () => {
    const sim = new ComputerSim();
    await signedIn(sim);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(30_000);
    await pageCall(sim, "sign_out", 1);
    for (let i = 0; i < 40 && sim.record().signOut.phase !== "verified"; i += 1) {
      await sim.advance(5_000);
    }
    await sim.advance(2 * 60_000);
    const key = sim.record().credential?.object.key ?? "";
    expect(key).not.toBe("");
    sim.bucket.failDeletes = 1_000;
    expect(await pageCall(sim, "resolve_removal", 2)).toMatchObject({ outcome: "accepted" });
    await sim.advance(5 * 60_000);
    let page = await state(sim);
    expect(page.lifecycle).toBe("removed");
    expect(page.removal.deleting).toBe(true);
    expect(computerView(page, Date.now())).toMatchObject({
      status: "Deleting…",
      removal: "deleting",
    });
    expect(sim.bucket.objects.has(key)).toBe(true);
    // Evicted while deleting: still Deleting…, nothing claimed.
    await sim.restart();
    expect((await state(sim)).removal.deleting).toBe(true);
    // The bucket recovers: the deletions finish, then it is Removed.
    sim.bucket.failDeletes = 0;
    await sim.advance(10 * 60_000);
    page = await state(sim);
    expect(page.removal.deleting).toBe(false);
    expect(computerView(page, Date.now())).toMatchObject({
      status: "Removed",
      removal: "resolved",
    });
    expect(sim.bucket.objects.has(key)).toBe(false);
  });
});
