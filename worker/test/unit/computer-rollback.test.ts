// Codex WP8.4 r1-2: `bootstrap.ts update --rollback` redeploys the previous platform Worker and
// leaves WorkspaceDO's storage as this one wrote it. The previous Worker parses the record as a
// strict object on every load, so the record this one writes must keep exactly that shape; the
// owner binding and the pointer stamps are under their own key, which the previous Worker never
// reads. Here the current controller writes storage through version 1 calls, checkpoint
// publications, an adoption, an owner-bound computer and a restart, and the previous Worker's own
// schemas (`test/fixtures/previous-worker/`, copied from the release before WP8.4) read every key
// it reads at boot and while it runs.
import { type LauncherOwner, PagesResult } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { fingerprintOf } from "../../src/computer/controller.ts";
import {
  OPERATION_PREFIX,
  OWNERSHIP_KEY,
  OwnershipRecord,
  RECORD_KEY,
  STATUS_LOG_KEY,
  TOKEN_KEY,
} from "../../src/computer/record.ts";
import * as previous from "../fixtures/previous-worker/record.ts";
import { ComputerSim, HOST, live } from "../support/computer-sim.ts";

const FOUNDER = "founder";
const MEMBER = "0a1b2c3d4e5f40718293a4b5c6d7e8f9";
const TEAM = "9f8e7d6c5b4a49382716f5e4d3c2b1a0";

/** Every key in the store, read as the previous Worker reads it. Returns the problems. */
function previousReaderProblems(sim: ComputerSim): string[] {
  const problems: string[] = [];
  for (const key of sim.store.keys("")) {
    const value = sim.store.get(key);
    const check = (schema: { safeParse(v: unknown): { success: boolean } }) => {
      if (!schema.safeParse(value).success) problems.push(`${key} does not read`);
    };
    if (key === previous.RECORD_KEY) check(previous.ComputerRecord);
    else if (key === previous.TOKEN_KEY) check(previous.TokenRecord);
    else if (key === previous.STATUS_LOG_KEY) check(previous.StatusLogRecord);
    else if (key.startsWith(previous.OPERATION_PREFIX)) check(previous.OperationRecord);
    else if (key.startsWith(previous.OPERATION_TIME_PREFIX)) {
      if (typeof value !== "string") problems.push(`${key} is not a string`);
    } else if (key.startsWith(previous.SLEEP_PREFIX)) {
      if (value !== true) problems.push(`${key} is not true`);
    } else if (key !== OWNERSHIP_KEY) problems.push(`${key} is unknown`);
  }
  return problems;
}

/** Wakes, signs in, saves files and logins, and sleeps: every pointer is published. */
async function saveAndSleep(sim: ComputerSim, file: string): Promise<void> {
  live(sim).signIn("claude", "claude-login-canary-rollback");
  live(sim).write(`work/${file}`, file);
  await sim.call(sim.client.checkpointRequest());
  await sim.advance(10_000);
  live(sim).runnerProcesses = 0;
  await sim.call(sim.client.suspendRequest());
  await sim.advance(30_000);
}

describe("storage the previous platform Worker reads after a rollback (Codex r1-2)", () => {
  it("keeps the record exactly the previous shape, and the ownership under a key it never reads", () => {
    // The keys the previous Worker uses are the same keys.
    expect(previous.RECORD_KEY).toBe(RECORD_KEY);
    expect(previous.TOKEN_KEY).toBe(TOKEN_KEY);
    expect(previous.STATUS_LOG_KEY).toBe(STATUS_LOG_KEY);
    expect(Object.values(previous)).not.toContain(OWNERSHIP_KEY);
  });

  it("reads everything a version 1 installation wrote: no ownership key at all", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await sim.running();
    await saveAndSleep(sim, "v1.txt");
    await sim.restart();
    await sim.client.wake({ hostId: HOST, token: sim.token(9) });
    await sim.advance(30_000);
    expect(sim.record().workspace).not.toBeNull();
    expect(sim.record().credential).not.toBeNull();
    expect(sim.store.get(OWNERSHIP_KEY)).toBeUndefined();
    expect(previousReaderProblems(sim)).toEqual([]);
    expect(sim.check()).toEqual([]);
  });

  it("reads everything after an adoption and a member's binding, with stamped pointers", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await sim.running();
    await saveAndSleep(sim, "before.txt");
    // Adopted for the installation's owner, then the binding learns the member.
    sim.client.owner = { userId: FOUNDER, memberId: null, teamId: null, hostId: HOST };
    await sim.client.wake({ hostId: HOST, token: sim.token(10) });
    await sim.advance(30_000);
    sim.client.owner = { ...sim.client.owner, memberId: MEMBER, teamId: TEAM };
    await saveAndSleep(sim, "after.txt");
    await sim.restart();
    const o = sim.ownership();
    expect(o.binding).toMatchObject({ userId: FOUNDER, memberId: MEMBER, how: "adopted" });
    expect(o.workspace?.checkpointId).toBe(sim.record().workspace?.checkpointId);
    expect(o.credential?.checkpointId).toBe(sim.record().credential?.checkpointId);
    expect(OwnershipRecord.safeParse(sim.store.get(OWNERSHIP_KEY)).success).toBe(true);
    expect(previousReaderProblems(sim)).toEqual([]);
  });

  it("reads a member's computer bound at provisioning, through a save and a removal", async () => {
    const alice: LauncherOwner = { userId: "alice", memberId: MEMBER, teamId: TEAM, hostId: HOST };
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    sim.client.owner = alice;
    await sim.running();
    await saveAndSleep(sim, "alice.txt");
    expect(previousReaderProblems(sim)).toEqual([]);
    await sim.call(sim.client.terminateRequest());
    await sim.advance(60_000);
    expect(previousReaderProblems(sim)).toEqual([]);
  });

  it("would have caught the shape r1 found: a record with ownership in it does not read", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await sim.running();
    const record = sim.store.get(RECORD_KEY) as Record<string, unknown>;
    expect(previous.ComputerRecord.safeParse(record).success).toBe(true);
    expect(
      previous.ComputerRecord.safeParse({
        ...record,
        owner: null,
        workspaceOwner: null,
        credentialOwner: null,
      }).success,
    ).toBe(false);
  });

  it("restores, after a roll forward, a pointer the previous Worker published on a member's computer", async () => {
    const alice: LauncherOwner = { userId: "alice", memberId: MEMBER, teamId: TEAM, hostId: HOST };
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    sim.client.owner = alice;
    await sim.running();
    await saveAndSleep(sim, "stamped.txt");
    // During a rollback the previous Worker publishes new pointers and never stamps them: here,
    // the stamps are left naming the checkpoints this Worker published, as that Worker leaves
    // them, and the pointers change under them.
    const stamped = sim.ownership();
    await sim.client.wake({ hostId: HOST, token: sim.token(11) });
    await sim.advance(30_000);
    await saveAndSleep(sim, "unstamped.txt");
    sim.store.put(OWNERSHIP_KEY, stamped);
    expect(sim.ownership().workspace?.checkpointId).not.toBe(sim.record().workspace?.checkpointId);
    await sim.client.wake({ hostId: HOST, token: sim.token(12) });
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(live(sim).tree.get("work/unstamped.txt")).toBe("unstamped.txt");
  });
});

// WP8.15: the page journal records who acted, inside the entry's opaque outcome, so its storage
// format is unchanged. Checked here as the previous Worker reads and replays an entry: its
// `OperationRecord` parse, and its replay, which returns the recorded outcome to the web Worker
// as a `PagesResult` (a loose object, unchanged since that release).
describe("the page journal's actor, read by the previous Worker after a rollback (WP8.15)", () => {
  const CAROL = "member:2c3d4e5f60718293a4b5c6d7e8f90a1b";
  const op = (n: number) => `op_${String(n).padStart(26, "0")}`;
  const setSize = (n: number) => ({
    action: "set_size" as const,
    interfaceVersion: 1,
    operationId: op(n),
    size: "basic" as const,
  });

  it("records the actor beside the outcome in the shape the previous Worker reads and replays", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await sim.running();
    const answer = await sim.controller.pages(setSize(1), CAROL);
    expect(answer).toEqual({ action: "set_size", appliesAt: "next_start" });
    const entry = sim.store.get(`${OPERATION_PREFIX}page:${op(1)}`) as {
      fingerprint: string;
      outcome: Record<string, unknown>;
    };
    expect(entry.outcome).toEqual({ action: "set_size", appliesAt: "next_start", actor: CAROL });
    // The previous Worker reads the entry, and its replay is a `PagesResult` the web Worker
    // reads; the extra field passes through and nothing reads it.
    expect(previous.OperationRecord.safeParse(entry).success).toBe(true);
    const replayed = PagesResult.safeParse(entry.outcome);
    expect(replayed.success).toBe(true);
    expect(replayed.data).toMatchObject({ action: "set_size", appliesAt: "next_start" });
    expect(previousReaderProblems(sim)).toEqual([]);
    // The fingerprint leaves the actor out: the same as before WP8.15.
    const { interfaceVersion: _, ...identity } = setSize(1);
    expect(entry.fingerprint).toBe(await fingerprintOf(identity));
  });

  it("answers a repeat without the actor, whoever repeats it, and records nothing it is not given", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await sim.running();
    await sim.controller.pages(setSize(2), CAROL);
    expect(await sim.controller.pages(setSize(2), CAROL)).toEqual({
      action: "set_size",
      appliesAt: "next_start",
    });
    expect(await sim.controller.pages(setSize(2), "installation")).toEqual({
      action: "set_size",
      appliesAt: "next_start",
    });
    // The first actor stays recorded.
    expect(
      (sim.store.get(`${OPERATION_PREFIX}page:${op(2)}`) as { outcome: { actor: string } }).outcome
        .actor,
    ).toBe(CAROL);
    // Without an actor, or with one that is not a member ID or the installation's owner (an
    // address, say), the outcome is recorded as before.
    for (const [n, actor] of [
      [3, undefined],
      [4, "carol@example.com"],
    ] as const) {
      await sim.controller.pages(setSize(n), actor);
      expect(
        (sim.store.get(`${OPERATION_PREFIX}page:${op(n)}`) as { outcome: unknown }).outcome,
      ).toEqual({ action: "set_size", appliesAt: "next_start" });
    }
    // A restart's outcome and its actor, through the controller's other journaling path.
    await sim.controller.pages(
      { action: "restart", interfaceVersion: 1, operationId: op(5) },
      CAROL,
    );
    expect(
      (sim.store.get(`${OPERATION_PREFIX}page:${op(5)}`) as { outcome: unknown }).outcome,
    ).toMatchObject({ action: "restart", actor: CAROL });
    expect(previousReaderProblems(sim)).toEqual([]);
  });
});
