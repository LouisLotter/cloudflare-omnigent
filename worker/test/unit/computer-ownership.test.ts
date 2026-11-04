// WP8.4 (D50): a cloud computer belongs to one person. The pure decisions (`ownership.ts`), and
// WorkspaceDO's controller in the simulation: the binding at provisioning, every launcher call for
// someone else's computer refused beside the same call from its owner, the adoption of computers
// recorded before owners, version 1 calls, checkpoint stamps at restore, and crashes at every step
// across generations and ownership changes.
import type { LauncherOwner, LauncherRequest, LauncherResult } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bindingFor,
  checkLauncherOwner,
  matchOwner,
  nameContradictsHost,
  type OwnerBinding,
  type OwnerFields,
  ownerTag,
  ownsComputer,
  pageAccess,
  pageAllows,
  personKey,
  type RemovalFacts,
  removalStopWithoutSavingDue,
  removeOffered,
  stampMatches,
  unsignedDeletionDue,
} from "../../src/computer/ownership.ts";
import { OWNERSHIP_KEY, RECORD_KEY } from "../../src/computer/record.ts";
import { ComputerSim, HOST, live } from "../support/computer-sim.ts";

const FOUNDER = "founder";
const TEAM = "9f8e7d6c5b4a49382716f5e4d3c2b1a0";
const ALICE_MEMBER = "0a1b2c3d4e5f40718293a4b5c6d7e8f9";
const BOB_MEMBER = "1b2c3d4e5f60718293a4b5c6d7e8f90a";
const FOUNDER_MEMBER = "2c3d4e5f60718293a4b5c6d7e8f90a1b";
const BOB_HOST = "0123456789abcdef0123456789abcdef";

const ALICE: LauncherOwner = {
  userId: "alice",
  memberId: ALICE_MEMBER,
  teamId: TEAM,
  hostId: HOST,
};
/** Bob, as Omnigent would name him for his own host: another person and another host. */
const BOB: LauncherOwner = { userId: "bob", memberId: BOB_MEMBER, teamId: TEAM, hostId: BOB_HOST };
/** Bob naming Alice's host: another person on the same host ID. */
const BOB_ON_ALICES_HOST: LauncherOwner = { ...BOB, hostId: HOST };
/** The installation's owner before the team model: no member yet. */
const FOUNDER_ALONE: LauncherOwner = {
  userId: FOUNDER,
  memberId: null,
  teamId: null,
  hostId: HOST,
};
const FOUNDER_IN_TEAM: LauncherOwner = { ...FOUNDER_ALONE, memberId: FOUNDER_MEMBER, teamId: TEAM };

const NAME = "managed-7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";

// ---------------------------------------------------------------------------------------------
// The pure decisions.

const hex32 = fc.stringMatching(/^[0-9a-f]{32}$/);
const owner: fc.Arbitrary<OwnerFields> = fc
  .record({
    userId: fc.constantFrom("alice", "bob", FOUNDER),
    member: fc.option(fc.constantFrom(ALICE_MEMBER, BOB_MEMBER, FOUNDER_MEMBER), { nil: null }),
    hostId: fc.constantFrom(HOST, BOB_HOST),
  })
  .map((o) => ({
    userId: o.userId,
    memberId: o.member,
    teamId: o.member === null ? null : TEAM,
    hostId: o.hostId,
  }));

describe("matchOwner", () => {
  it("never matches another account or another host, whatever the members", () => {
    fc.assert(
      fc.property(owner, owner, (a, b) => {
        if (a.userId !== b.userId || a.hostId !== b.hostId) {
          expect(matchOwner(a, b)).toBe("other");
        }
      }),
    );
  });

  it("matches the same account and host; a binding without a member learns one; two members must agree", () => {
    fc.assert(
      fc.property(owner, owner, (a, b) => {
        const m = matchOwner(a, b);
        if (a.userId !== b.userId || a.hostId !== b.hostId) return;
        if (a.memberId === null) expect(m).toBe(b.memberId === null ? "same" : "refines");
        else if (b.memberId === null) expect(m).toBe("same");
        else expect(m).toBe(a.memberId === b.memberId ? "same" : "other");
      }),
    );
  });

  it("is reflexive", () => {
    fc.assert(
      fc.property(owner, (a) => {
        expect(matchOwner(a, a)).toBe("same");
      }),
    );
  });

  it("refuses the same member in another team", () => {
    expect(matchOwner(ALICE, { ...ALICE, teamId: BOB_MEMBER })).toBe("other");
  });
});

describe("nameContradictsHost", () => {
  it("reads both of Omnigent's names and nothing else", () => {
    expect(nameContradictsHost(NAME, HOST)).toBe(false);
    expect(nameContradictsHost(NAME, BOB_HOST)).toBe(true);
    expect(nameContradictsHost("managed-7f3c2a9e", HOST)).toBe(false);
    expect(nameContradictsHost("managed-7f3c2a9e", BOB_HOST)).toBe(true);
    expect(nameContradictsHost("work-computer", BOB_HOST)).toBe(false);
    expect(nameContradictsHost(null, BOB_HOST)).toBe(false);
  });

  it("holds for every host ID", () => {
    fc.assert(
      fc.property(hex32, hex32, (a, b) => {
        expect(nameContradictsHost(`managed-${a}`, b)).toBe(a !== b);
        expect(nameContradictsHost(`managed-${a.slice(0, 8)}`, b)).toBe(
          a.slice(0, 8) !== b.slice(0, 8),
        );
      }),
    );
  });
});

const bound = (o: LauncherOwner, how: OwnerBinding["how"] = "provision"): OwnerBinding =>
  bindingFor(o, how, 1_000);

const decide = (input: Partial<Parameters<typeof checkLauncherOwner>[0]>) =>
  checkLauncherOwner({
    binding: null,
    hostId: null,
    name: null,
    owner: undefined,
    installationOwner: FOUNDER,
    now: 5_000,
    ...input,
  });

describe("checkLauncherOwner", () => {
  it("lets a version 1 call act for the installation's owner only", () => {
    expect(decide({})).toEqual({ ok: true, bind: null });
    expect(decide({ binding: bound(FOUNDER_IN_TEAM) })).toEqual({ ok: true, bind: null });
    expect(decide({ binding: bound(ALICE) })).toEqual({ ok: false, reason: "unattributed" });
    expect(decide({ binding: bound(FOUNDER_IN_TEAM), installationOwner: null })).toEqual({
      ok: false,
      reason: "unattributed",
    });
  });

  it("adopts an unbound computer for the installation's owner only, on its own host", () => {
    expect(decide({ owner: FOUNDER_ALONE, name: "managed-7f3c2a9e" })).toEqual({
      ok: true,
      bind: { ...FOUNDER_ALONE, how: "adopted", boundAt: 5_000 },
    });
    expect(decide({ owner: ALICE })).toEqual({ ok: false, reason: "not_installation_owner" });
    expect(decide({ owner: FOUNDER_ALONE, installationOwner: null })).toEqual({
      ok: false,
      reason: "no_installation_owner",
    });
    expect(decide({ owner: { ...FOUNDER_ALONE, hostId: BOB_HOST }, hostId: HOST })).toEqual({
      ok: false,
      reason: "other_host",
    });
    expect(decide({ owner: { ...FOUNDER_ALONE, hostId: BOB_HOST }, name: NAME })).toEqual({
      ok: false,
      reason: "other_host",
    });
  });

  it("accepts the bound owner, refines a binding without a member, and refuses anyone else", () => {
    expect(decide({ binding: bound(ALICE), owner: ALICE })).toEqual({ ok: true, bind: null });
    expect(decide({ binding: bound(FOUNDER_ALONE), owner: FOUNDER_IN_TEAM })).toEqual({
      ok: true,
      bind: { ...bound(FOUNDER_ALONE), memberId: FOUNDER_MEMBER, teamId: TEAM },
    });
    // A caller without a team (the reaper after a removal, a server rolled back) for the same
    // account and host: accepted, and the binding keeps its member.
    expect(
      decide({ binding: bound(ALICE), owner: { ...ALICE, memberId: null, teamId: null } }),
    ).toEqual({ ok: true, bind: null });
    expect(decide({ binding: bound(ALICE), owner: BOB_ON_ALICES_HOST })).toEqual({
      ok: false,
      reason: "other_owner",
    });
    expect(decide({ binding: bound(ALICE), owner: { ...ALICE, memberId: BOB_MEMBER } })).toEqual({
      ok: false,
      reason: "other_owner",
    });
    expect(decide({ binding: bound(ALICE), owner: BOB })).toEqual({
      ok: false,
      reason: "other_host",
    });
  });

  it("never binds anyone but the named owner, and never moves a binding to another person", () => {
    const named = fc.option(owner as fc.Arbitrary<LauncherOwner>, { nil: undefined });
    const binding = fc.option(
      fc.tuple(owner, fc.constantFrom("provision" as const, "adopted" as const)),
      { nil: null },
    );
    fc.assert(
      fc.property(
        binding,
        named,
        fc.option(fc.constantFrom(HOST, BOB_HOST), { nil: null }),
        (b, o, hostId) => {
          const current = b === null ? null : bound(b[0] as LauncherOwner, b[1]);
          const decision = decide({ binding: current, owner: o, hostId });
          if (!decision.ok || decision.bind === null) return;
          expect(o).toBeDefined();
          const next = decision.bind;
          expect(next.userId).toBe(o?.userId);
          expect(next.hostId).toBe(o?.hostId);
          if (current !== null) {
            expect(next.userId).toBe(current.userId);
            expect(next.hostId).toBe(current.hostId);
            expect(current.memberId).toBeNull();
            expect(next.how).toBe(current.how);
          } else {
            expect(next.userId).toBe(FOUNDER);
            expect(next.how).toBe("adopted");
          }
        },
      ),
    );
  });
});

describe("stampMatches", () => {
  const CKP = "ckp_0000000000000000000000000a";
  const OTHER_CKP = "ckp_0000000000000000000000000b";
  const stamp = (owner: OwnerBinding, checkpointId = CKP) => ({ checkpointId, owner });

  it("restores a pointer no stamp names: published by a Worker without owners, this computer's own", () => {
    for (const binding of [
      null,
      bound(FOUNDER_ALONE, "adopted"),
      bound(FOUNDER_IN_TEAM),
      bound(ALICE),
    ]) {
      expect(stampMatches(null, CKP, binding)).toBe(true);
      // A stamp for an earlier pointer: the previous Worker published this one during a rollback.
      expect(stampMatches(stamp(bound(BOB_ON_ALICES_HOST), OTHER_CKP), CKP, binding)).toBe(true);
    }
  });

  it("restores the owner's own and an ancestor's stamps, never another person's", () => {
    expect(stampMatches(stamp(bound(ALICE)), CKP, bound(ALICE))).toBe(true);
    expect(stampMatches(stamp(bound(FOUNDER_ALONE)), CKP, bound(FOUNDER_IN_TEAM))).toBe(true);
    expect(stampMatches(stamp(bound(BOB_ON_ALICES_HOST)), CKP, bound(ALICE))).toBe(false);
    expect(stampMatches(stamp(bound(ALICE)), CKP, null)).toBe(false);
    expect(stampMatches(stamp(bound({ ...ALICE, hostId: BOB_HOST })), CKP, bound(ALICE))).toBe(
      false,
    );
  });
});

describe("ownerTag", () => {
  it("names the member, or a marker; never the account", () => {
    expect(ownerTag(null)).toBe("installation");
    expect(ownerTag(bound(FOUNDER_ALONE))).toBe("account");
    expect(ownerTag(bound(ALICE))).toBe(`member:${ALICE_MEMBER}`);
    expect(ownerTag(bound(ALICE))).not.toContain("alice");
  });
});

// ---------------------------------------------------------------------------------------------
// The controller.

/** A computer provisioned and running for `who`: the usual starting point, with an owner. */
async function runningFor(sim: ComputerSim, who: LauncherOwner | undefined): Promise<number> {
  sim.client.owner = who;
  await sim.call(sim.client.provisionRequest(NAME));
  const token = sim.token(sim.tokens.length + 1);
  await sim.call(sim.client.resumeRequest());
  await sim.advance(1);
  const claim = await sim.call(sim.client.claimRequest());
  if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim refused");
  await sim.call(sim.client.startRequest({ attempt: claim.startAttempt, token, hostId: HOST }));
  await sim.advance(sim.timing.pollMs);
  return claim.startAttempt;
}

/** The record and its ownership: a refused call touches neither. */
const snapshot = (sim: ComputerSim) =>
  JSON.stringify([sim.store.get(RECORD_KEY), sim.store.get(OWNERSHIP_KEY)]);

/** Every on-computer launcher request, as `owner` would send it. */
function requests(sim: ComputerSim, as: LauncherOwner | undefined): [string, LauncherRequest][] {
  const saved = sim.client.owner;
  sim.client.owner = as;
  const list: [string, LauncherRequest][] = [
    ["provision", sim.client.provisionRequest(NAME)],
    ["claim_start", sim.client.claimRequest()],
    [
      "start_host",
      sim.client.startRequest({
        attempt: 1,
        token: sim.token(900 + sim.tokens.length),
        hostId: as?.hostId ?? HOST,
      }),
    ],
    ["resume", sim.client.resumeRequest()],
    ["keep_alive", sim.client.keepAliveRequest()],
    ["status", sim.client.statusRequest()],
    ["admission", sim.client.admissionRequest()],
    ["checkpoint", sim.client.checkpointRequest()],
    ["suspend", sim.client.suspendRequest()],
    ["terminate", sim.client.terminateRequest()],
  ];
  sim.client.owner = saved;
  return list;
}

describe("a computer bound to its owner at provisioning (T3, T15)", () => {
  it("binds a new computer to the named owner in the write that records it", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    sim.client.owner = ALICE;
    expect(await sim.call(sim.client.provisionRequest(NAME))).toMatchObject({
      computerId: sim.client.computerId,
    });
    expect(sim.ownership().binding).toEqual({ ...ALICE, how: "provision", boundAt: sim.now });
    // Alice again: the same computer, the same binding.
    await sim.call(sim.client.provisionRequest(NAME));
    expect(sim.ownership().binding?.memberId).toBe(ALICE_MEMBER);
    // A name naming another host is refused before anything is recorded.
    const other = new ComputerSim({ installationOwner: FOUNDER });
    other.client.owner = ALICE;
    expect(await other.client.refusal(other.client.provisionRequest(`managed-${BOB_HOST}`))).toBe(
      "forbidden",
    );
    expect(other.store.get(RECORD_KEY)).toBeUndefined();
  });

  it("refuses every launcher call for someone else's computer, changing nothing, beside the same call from its owner", async () => {
    for (const intruder of [BOB, BOB_ON_ALICES_HOST]) {
      const sim = new ComputerSim({ installationOwner: FOUNDER });
      await runningFor(sim, ALICE);
      const before = snapshot(sim);
      const starts = sim.computer.starts.length;
      const journal = sim.store.keys("op:").length;
      for (const [operation, request] of requests(sim, intruder)) {
        expect(await sim.client.refusal(request), operation).toBe("forbidden");
      }
      await sim.settle();
      expect(snapshot(sim)).toBe(before);
      expect(sim.computer.starts.length).toBe(starts);
      expect(sim.store.keys("op:").length).toBe(journal);
      expect(
        sim.logs.filter((l) => l.event === "owner_refused").map((l) => l.fields.reason),
      ).toEqual(Array(10).fill(intruder === BOB ? "other_host" : "other_owner"));
      // No log names the account.
      expect(JSON.stringify(sim.logs)).not.toMatch(/"bob"|"alice"/);
      // The allowed neighbours: Alice's own calls are answered.
      sim.client.owner = ALICE;
      for (const request of [
        sim.client.statusRequest(),
        sim.client.admissionRequest(),
        sim.client.keepAliveRequest(),
        sim.client.resumeRequest(),
        sim.client.checkpointRequest(),
        sim.client.provisionRequest(NAME),
      ]) {
        expect(await sim.client.refusal(request), request.operation).toBeUndefined();
      }
      expect(sim.check()).toEqual([]);
    }
  });

  it("refuses a start, a sleep and a removal from someone else, and lets the owner do each", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, ALICE);
    live(sim).runnerProcesses = 0;
    sim.client.owner = BOB_ON_ALICES_HOST;
    expect(await sim.client.refusal(sim.client.suspendRequest())).toBe("forbidden");
    expect(await sim.client.refusal(sim.client.terminateRequest())).toBe("forbidden");
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    sim.client.owner = ALICE;
    expect(await sim.call(sim.client.suspendRequest())).toMatchObject({ operation: "suspend" });
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    sim.client.owner = BOB_ON_ALICES_HOST;
    expect(await sim.client.refusal(sim.client.resumeRequest())).toBe("forbidden");
    expect(await sim.client.refusal(sim.client.claimRequest())).toBe("forbidden");
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    sim.client.owner = ALICE;
    await sim.client.wake({ hostId: HOST, token: sim.token(2) });
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(await sim.call(sim.client.terminateRequest())).toMatchObject({ removal: "pending" });
  });

  it("never answers someone else from the owner's journal: a repeated operation ID is refused first", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    sim.client.owner = ALICE;
    await sim.call(sim.client.provisionRequest(NAME));
    await sim.call(sim.client.resumeRequest());
    await sim.advance(1);
    const op = "a".repeat(32);
    const claim = await sim.call(sim.client.claimRequest(op));
    expect(claim).toMatchObject({ granted: true });
    sim.client.owner = BOB_ON_ALICES_HOST;
    expect(await sim.client.refusal(sim.client.claimRequest(op))).toBe("forbidden");
    // The owner's repeat gets the recorded grant; the same ID with another owner's fields is
    // another request.
    sim.client.owner = ALICE;
    expect(await sim.call(sim.client.claimRequest(op))).toEqual(claim);
  });

  it("refuses a start for another host than the owner's", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, ALICE);
    expect(sim.record().hostId).toBe(HOST);
    sim.client.owner = { ...ALICE, hostId: BOB_HOST };
    expect(await sim.client.refusal(sim.client.claimRequest())).toBe("forbidden");
  });
});

describe("authorizeLauncher: the owner check before WorkspaceDO's own steps (Codex r1-1)", () => {
  const call = (request: LauncherRequest) => ({ interfaceVersion: 1, request });

  it("refuses what the launcher call itself would refuse, and changes nothing", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    // No record yet: nothing is bound, and the call answers for itself.
    sim.client.owner = BOB;
    expect(() =>
      sim.controller.authorizeLauncher(call(sim.client.terminateRequest())),
    ).not.toThrow();
    await runningFor(sim, ALICE);
    const before = snapshot(sim);
    for (const [operation, request] of requests(sim, BOB_ON_ALICES_HOST)) {
      expect(() => sim.controller.authorizeLauncher(call(request)), operation).toThrow(/forbidden/);
    }
    for (const [operation, request] of requests(sim, undefined)) {
      expect(() => sim.controller.authorizeLauncher(call(request)), operation).toThrow(/forbidden/);
    }
    expect(snapshot(sim)).toBe(before);
    // The owner's calls, and `prepare`, pass; an adoption is not persisted by the check.
    for (const [operation, request] of requests(sim, ALICE)) {
      expect(() => sim.controller.authorizeLauncher(call(request)), operation).not.toThrow();
    }
    expect(() =>
      sim.controller.authorizeLauncher(
        call({ operation: "prepare", protocolVersion: 1, operationId: "f".repeat(32) }),
      ),
    ).not.toThrow();
    expect(snapshot(sim)).toBe(before);
  });

  it("refuses a malformed call, another version or another computer before anything", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, ALICE);
    expect(() => sim.controller.authorizeLauncher({ interfaceVersion: 1 })).toThrow(/bad_request/);
    expect(() =>
      sim.controller.authorizeLauncher({
        interfaceVersion: 2,
        request: sim.client.statusRequest(),
      }),
    ).toThrow(/unsupported_version/);
    expect(() =>
      sim.controller.authorizeLauncher(
        call({
          ...sim.client.statusRequest(),
          computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4",
        } as LauncherRequest),
      ),
    ).toThrow(/bad_request/);
  });

  it("does not persist an adoption: the call itself adopts", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, undefined);
    sim.client.owner = FOUNDER_ALONE;
    sim.controller.authorizeLauncher(call(sim.client.statusRequest()));
    expect(sim.store.get(OWNERSHIP_KEY)).toBeUndefined();
    await sim.call(sim.client.statusRequest());
    expect(sim.ownership().binding).toMatchObject({ userId: FOUNDER, how: "adopted" });
  });
});

describe("computers recorded before owners (the installation's owner, adopted on first use)", () => {
  it("serves version 1 calls as before, and adopts the computer at its first version 2 call", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, undefined);
    expect(sim.ownership().binding).toBeNull();
    // Someone else's version 2 call is refused, and adopts nothing.
    sim.client.owner = { ...ALICE, hostId: HOST };
    expect(await sim.client.refusal(sim.client.statusRequest())).toBe("forbidden");
    expect(sim.ownership().binding).toBeNull();
    // The installation owner's first version 2 call adopts it, before the call's effect.
    sim.client.owner = FOUNDER_ALONE;
    await sim.call(sim.client.keepAliveRequest());
    expect(sim.ownership().binding).toMatchObject({ ...FOUNDER_ALONE, how: "adopted" });
    expect(sim.logs.find((l) => l.event === "owner_adopted")?.fields).toMatchObject({
      operation: "keep_alive",
      owner: "account",
    });
    // Once the founder has a member, the binding learns it once; a version 1 call still works
    // for the founder (a rollback), never once the computer is someone else's.
    sim.client.owner = FOUNDER_IN_TEAM;
    await sim.call(sim.client.statusRequest());
    expect(sim.ownership().binding).toMatchObject({ memberId: FOUNDER_MEMBER, how: "adopted" });
    sim.client.owner = undefined;
    expect(await sim.client.refusal(sim.client.statusRequest())).toBeUndefined();
    sim.client.owner = { ...FOUNDER_IN_TEAM, memberId: ALICE_MEMBER };
    expect(await sim.client.refusal(sim.client.statusRequest())).toBe("forbidden");
  });

  it("adopts nothing when the installation's owner is not configured", async () => {
    const sim = new ComputerSim();
    await runningFor(sim, undefined);
    sim.client.owner = FOUNDER_ALONE;
    expect(await sim.client.refusal(sim.client.statusRequest())).toBe("forbidden");
    expect(sim.ownership().binding).toBeNull();
    sim.client.owner = undefined;
    expect(await sim.client.refusal(sim.client.statusRequest())).toBeUndefined();
  });

  it("refuses a version 1 call on a member's computer, and accepts it on the installation owner's", async () => {
    const alices = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(alices, ALICE);
    alices.client.owner = undefined;
    for (const [operation, request] of requests(alices, undefined)) {
      expect(await alices.client.refusal(request), operation).toBe("forbidden");
    }
    expect(alices.logs.at(-1)?.fields).toMatchObject({ reason: "unattributed" });
    const founders = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(founders, FOUNDER_IN_TEAM);
    founders.client.owner = undefined;
    expect(await founders.client.refusal(founders.client.statusRequest())).toBeUndefined();
  });

  it("lets the page record a removal on a member's computer without a launcher owner", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, ALICE);
    expect(await sim.controller.removeForPage()).toBe("pending");
    expect(sim.record().lifecycle.context.removalIntent).toBe(true);
    const none = new ComputerSim();
    expect(await none.controller.removeForPage()).toBe("absent");
  });
});

describe("checkpoints stamped with their owner (T15)", () => {
  async function sleepAndWake(sim: ComputerSim): Promise<void> {
    live(sim).runnerProcesses = 0;
    await sim.call(sim.client.suspendRequest());
    await sim.advance(30_000);
    expect(sim.record().lifecycle.context.state).toBe("asleep");
    await sim.client.wake({ hostId: HOST, token: sim.token(sim.tokens.length + 1) });
    await sim.advance(30_000);
  }

  it("stamps both pointers with the binding when they are published, and tags the bundle", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, ALICE);
    live(sim).signIn("claude", "claude-login-canary-ownership");
    live(sim).write("work/a.txt", "a");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(10_000);
    const r = sim.record();
    const o = sim.ownership();
    expect(r.workspace).not.toBeNull();
    expect(o.workspace).toEqual({
      checkpointId: r.workspace?.checkpointId,
      generation: r.workspace?.generation,
      owner: o.binding,
    });
    expect(r.credential).not.toBeNull();
    expect(o.credential).toEqual({
      checkpointId: r.credential?.checkpointId,
      generation: r.credential?.generation,
      owner: o.binding,
    });
    expect(sim.bucket.writers.at(-1)).toEqual({
      key: r.credential?.object.key,
      generation: r.credential?.generation,
      owner: `member:${ALICE_MEMBER}`,
    });
  });

  it("restores the owner's checkpoints, and refuses a pointer stamped for anyone else, failing the start", async () => {
    for (const pointer of ["workspace", "credential"] as const) {
      const sim = new ComputerSim({ installationOwner: FOUNDER });
      await runningFor(sim, ALICE);
      live(sim).signIn("claude", "claude-login-canary-ownership");
      live(sim).write("work/a.txt", "a");
      await sim.call(sim.client.checkpointRequest());
      await sim.advance(10_000);
      // The allowed neighbour: a sleep and a wake restore Alice's own checkpoints.
      await sleepAndWake(sim);
      expect(sim.record().lifecycle.context.state).toBe("host_running");
      expect(live(sim).tree.get("work/a.txt")).toBe("a");
      // A pointer stamped for Bob (as if another computer's checkpoint were named here).
      live(sim).runnerProcesses = 0;
      await sim.call(sim.client.suspendRequest());
      await sim.advance(30_000);
      const current = sim.record()[pointer];
      if (current === null) throw new Error(`no ${pointer} pointer`);
      sim.store.put(OWNERSHIP_KEY, {
        ...sim.ownership(),
        [pointer]: {
          checkpointId: current.checkpointId,
          generation: current.generation,
          owner: bindingFor(BOB_ON_ALICES_HOST, "provision", 1),
        },
      });
      const restores = sim.computer.restores.length;
      await sim.client
        .wake({ hostId: HOST, token: sim.token(sim.tokens.length + 1) })
        .catch(() => null);
      await sim.advance(30_000);
      expect(sim.record().lifecycle.context.state, pointer).toBe("failed");
      expect(sim.computer.restores.length).toBe(restores);
      expect(sim.logs.find((l) => l.event === "restore_failed")?.fields).toMatchObject({
        reason: "owner_mismatch",
      });
      const commands = sim.sup?.commands.map((c) => c.type) ?? [];
      expect(commands).not.toContain("install_credentials");
    }
  });

  it("restores pointers published before owners into the adopted computer", async () => {
    const sim = new ComputerSim({ installationOwner: FOUNDER });
    await runningFor(sim, undefined);
    live(sim).signIn("claude", "claude-login-canary-ownership");
    live(sim).write("work/a.txt", "legacy");
    await sim.call(sim.client.checkpointRequest());
    await sim.advance(10_000);
    expect(sim.ownership()).toEqual({ binding: null, workspace: null, credential: null });
    expect(sim.store.get(OWNERSHIP_KEY)).toBeUndefined();
    sim.client.owner = FOUNDER_ALONE;
    await sleepAndWake(sim);
    expect(sim.ownership().binding?.how).toBe("adopted");
    expect(sim.record().lifecycle.context.state).toBe("host_running");
    expect(live(sim).tree.get("work/a.txt")).toBe("legacy");
  });
});

// ---------------------------------------------------------------------------------------------
// Crashes at every step, across generations and ownership changes.

async function send(sim: ComputerSim, request: LauncherRequest): Promise<LauncherResult | string> {
  for (let i = 0; i < 6; i += 1) {
    try {
      const result = await sim.client.send(request);
      if (sim.dead) await sim.restart();
      await sim.settle();
      return result;
    } catch (error) {
      if (sim.dead) {
        await sim.restart();
        await sim.settle();
        continue;
      }
      const code = /^\[([a-z_]+)\]/.exec((error as Error).message)?.[1];
      if ((code === "unavailable" || code === "internal") && i < 5) continue;
      return code ?? String(error);
    }
  }
  throw new Error(`no answer to ${request.operation}`);
}

/** Omnigent's wake, with retries, until the host runs. */
async function wake(sim: ComputerSim, token: string): Promise<void> {
  await send(sim, sim.client.resumeRequest());
  await sim.advance(2_000);
  for (let i = 0; i < 6; i += 1) {
    const status = await send(sim, sim.client.statusRequest());
    if (typeof status === "string" || status.operation !== "status")
      throw new Error(String(status));
    if (status.status === "host_running") return;
    if (status.status === "stopped") {
      await send(sim, sim.client.resumeRequest());
      await sim.advance(2_000);
      continue;
    }
    const claim = await send(sim, sim.client.claimRequest());
    if (typeof claim !== "string" && claim.operation === "claim_start" && claim.granted) {
      await send(
        sim,
        sim.client.startRequest({ attempt: claim.startAttempt, token, hostId: HOST }),
      );
    }
    await sim.advance(5_000);
  }
}

async function sleep(sim: ComputerSim): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    if (sim.sup !== null) sim.sup.runnerProcesses = 0;
    const outcome = await send(sim, sim.client.suspendRequest());
    await sim.advance(30_000);
    if (
      typeof outcome !== "string" &&
      outcome.operation === "suspend" &&
      outcome.outcome !== "refused"
    ) {
      if (sim.record().lifecycle.context.state === "asleep") return;
    }
    await sim.advance(60_000);
  }
}

/**
 * Three generations: one before owners (version 1), one whose first call adopts the computer for
 * the installation's owner, and one after the owner joined a team (the binding learns the member).
 * Between them, Bob's calls are refused.
 */
async function ownershipScenario(sim: ComputerSim): Promise<string[]> {
  const refusals: string[] = [];
  sim.client.owner = undefined;
  await send(sim, sim.client.provisionRequest("managed-7f3c2a9e", `${"0".repeat(31)}1`));
  await wake(sim, sim.token(1));
  sim.sup?.signIn("claude", "claude-login-canary-ownership");
  sim.sup?.write("work/a.txt", "saved");
  await sim.settle();
  await send(sim, sim.client.checkpointRequest());
  await sim.advance(10_000);
  await sleep(sim);
  for (const [owner, token] of [
    [FOUNDER_ALONE, 2],
    [FOUNDER_IN_TEAM, 3],
  ] as const) {
    sim.client.owner = BOB_ON_ALICES_HOST;
    const refused = await send(sim, sim.client.resumeRequest());
    refusals.push(typeof refused === "string" ? refused : "answered");
    sim.client.owner = owner;
    await wake(sim, sim.token(token));
    if (token === 2) {
      sim.sup?.write("work/b.txt", "adopted");
      await sim.settle();
      await send(sim, sim.client.checkpointRequest());
      await sim.advance(10_000);
      await sleep(sim);
    }
  }
  await sim.advance(60_000);
  return refusals;
}

describe("crashes across generations and ownership", () => {
  it("survives a crash at any step: the binding only ever gains detail, and everything restores", async () => {
    const dry = new ComputerSim({ installationOwner: FOUNDER });
    expect(await ownershipScenario(dry)).toEqual(["forbidden", "forbidden"]);
    expect(dry.check()).toEqual([]);
    expect(dry.ownership().binding).toMatchObject({ ...FOUNDER_IN_TEAM, how: "adopted" });
    const steps = dry.steps;
    expect(steps).toBeGreaterThan(100);
    const failures: string[] = [];
    for (let at = 1; at <= steps; at += 1) {
      const sim = new ComputerSim({ installationOwner: FOUNDER });
      sim.crashAt = at;
      const seen: (OwnerBinding | null)[] = [];
      sim.store.afterCommit = ((original) => () => {
        original?.();
        const raw = sim.store.get(OWNERSHIP_KEY) as { binding?: OwnerBinding | null } | undefined;
        seen.push(raw?.binding ?? null);
      })(sim.store.afterCommit);
      let refusals: string[];
      try {
        refusals = await ownershipScenario(sim);
      } catch (error) {
        failures.push(`step ${at} (${dry.stepLog[at - 1]}): ${String(error)}`);
        continue;
      }
      const r = { ...sim.record(), owner: sim.ownership().binding };
      const problems = sim.check();
      if (refusals.some((x) => x !== "forbidden")) problems.push(`Bob was answered: ${refusals}`);
      if (r.lifecycle.context.state !== "host_running")
        problems.push(`ended ${r.lifecycle.context.state}`);
      if (r.owner?.memberId !== FOUNDER_MEMBER || r.owner.how !== "adopted")
        problems.push(`ended bound ${JSON.stringify(r.owner)}`);
      if (sim.sup?.tree.get("work/a.txt") !== "saved") problems.push("a.txt was not restored");
      if (sim.sup?.tree.get("work/b.txt") !== "adopted") problems.push("b.txt was not restored");
      if (sim.sup?.credentials.get(".claude/.credentials.json") !== "claude-login-canary-ownership")
        problems.push("the login was not restored");
      // The binding never names anyone but the founder, and never loses its member once it has one.
      let member = false;
      for (const b of seen) {
        if (b !== null && b.userId !== FOUNDER) problems.push(`bound to ${b.userId}`);
        if (b?.memberId) member = true;
        else if (member) problems.push("the binding lost its member");
      }
      if (problems.length > 0)
        failures.push(`step ${at} (${dry.stepLog[at - 1]}): ${problems.join("; ")}`);
    }
    expect(failures).toEqual([]);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------
// The pages' access rules (T3, T13).

describe("pageAccess and pageAllows", () => {
  const member = (memberId: string, userId: string, role: "owner" | "admin" | "member") =>
    ({ kind: "member", memberId, userId, role }) as const;
  const person = fc.oneof(
    fc.constant({ kind: "installation_owner" } as const),
    fc
      .tuple(
        fc.constantFrom(
          [ALICE_MEMBER, "alice"] as const,
          [BOB_MEMBER, "bob"] as const,
          [FOUNDER_MEMBER, FOUNDER] as const,
        ),
        fc.constantFrom("owner" as const, "admin" as const, "member" as const),
      )
      .map(([[id, user], role]) => member(id, user, role)),
  );
  const binding = fc.option(
    fc.constantFrom(
      bound(ALICE),
      bound(BOB_ON_ALICES_HOST),
      bound(FOUNDER_ALONE, "adopted"),
      bound(FOUNDER_IN_TEAM),
    ),
    { nil: null },
  );
  const actions = [
    "fleet",
    "view",
    "terminal",
    "sign_in",
    "set_size",
    "restart",
    "stop_without_saving",
    "sign_out",
    "record_revocation",
    "resolve_removal",
    "delete_without_sign_out",
    "remove",
    "staging",
  ] as const;

  it("never lets a plain member past someone else's computer, and never an admin into what is the owner's alone", () => {
    fc.assert(
      fc.property(
        person,
        binding,
        fc.constantFrom(...actions),
        fc.boolean(),
        (p, b, action, pending) => {
          const access = pageAccess(p, b, FOUNDER);
          const owns = ownsComputer(p, b, FOUNDER);
          expect(access === "owner").toBe(owns);
          if (!owns && p.kind === "member" && p.role === "member") expect(access).toBe("none");
          const allowed = pageAllows(access, action, pending);
          if (access === "none") expect(allowed).toBe(false);
          if (access === "admin") {
            const adminActions = ["fleet", "restart", "remove"];
            const pendingActions = [
              "sign_out",
              "resolve_removal",
              "delete_without_sign_out",
              "stop_without_saving",
            ];
            expect(allowed).toBe(
              adminActions.includes(action) || (pending && pendingActions.includes(action)),
            );
          }
          // Deleting without a sign-out is the administrator's: an owner records a revocation.
          if (access === "owner") expect(allowed).toBe(action !== "delete_without_sign_out");
        },
      ),
    );
  });

  it("lets an admin stop someone else's computer without saving only while a removal is pending", () => {
    expect(pageAllows("admin", "stop_without_saving", true)).toBe(true);
    expect(pageAllows("admin", "stop_without_saving", false)).toBe(false);
    expect(pageAllows("none", "stop_without_saving", true)).toBe(false);
    expect(pageAllows("owner", "stop_without_saving", false)).toBe(true);
  });

  it("decides ownership by member, and by the installation owner's account where there is none", () => {
    expect(ownsComputer(member(ALICE_MEMBER, "alice", "member"), bound(ALICE), FOUNDER)).toBe(true);
    expect(ownsComputer(member(BOB_MEMBER, "bob", "admin"), bound(ALICE), FOUNDER)).toBe(false);
    // The same member ID under another account is not the same person.
    expect(ownsComputer(member(ALICE_MEMBER, "mallory", "member"), bound(ALICE), FOUNDER)).toBe(
      false,
    );
    expect(ownsComputer({ kind: "installation_owner" }, null, null)).toBe(true);
    expect(ownsComputer({ kind: "installation_owner" }, bound(ALICE), FOUNDER)).toBe(false);
    expect(ownsComputer({ kind: "installation_owner" }, bound(FOUNDER_IN_TEAM), FOUNDER)).toBe(
      true,
    );
    expect(ownsComputer(member(FOUNDER_MEMBER, FOUNDER, "owner"), null, FOUNDER)).toBe(true);
    expect(
      ownsComputer(
        member(FOUNDER_MEMBER, FOUNDER, "owner"),
        bound(FOUNDER_ALONE, "adopted"),
        FOUNDER,
      ),
    ).toBe(true);
    expect(ownsComputer(member(ALICE_MEMBER, "alice", "member"), null, FOUNDER)).toBe(false);
    expect(ownsComputer(member(FOUNDER_MEMBER, FOUNDER, "owner"), null, null)).toBe(false);
    expect(pageAccess({ kind: "installation_owner" }, bound(ALICE), FOUNDER)).toBe("admin");
    expect(pageAccess(member(BOB_MEMBER, "bob", "owner"), bound(ALICE), FOUNDER)).toBe("admin");
    expect(pageAccess(member(BOB_MEMBER, "bob", "member"), bound(ALICE), FOUNDER)).toBe("none");
  });

  it("keys an intent token to the person", () => {
    expect(personKey({ kind: "installation_owner" })).toBe("installation");
    expect(personKey(member(ALICE_MEMBER, "alice", "member"))).toBe(`member:${ALICE_MEMBER}`);
  });
});

describe("the removal offers (WP8.9): one rule for the page, its cards and WorkspaceDO", () => {
  const facts: fc.Arbitrary<RemovalFacts> = fc.record({
    noContact: fc.boolean(),
    removal: fc.constantFrom("none" as const, "pending" as const, "resolved" as const),
    lifecycle: fc.constantFrom("host_running", "asleep", "removal_pending", "removed", "stopping"),
    settled: fc.boolean(),
    signOut: fc.constantFrom(
      "none" as const,
      "requested" as const,
      "tombstoned" as const,
      "verified" as const,
    ),
    signOutRunning: fc.boolean(),
    signOutFailed: fc.boolean(),
    revocationRequired: fc.boolean(),
    memberRemoved: fc.boolean(),
    refusedStops: fc.integer({ min: 0, max: 6 }),
  });

  it("offers recording a removal only for a lost host, to the owner and an admin alike", () => {
    fc.assert(
      fc.property(facts, (f) => {
        // `noContact` counts only an awake computer (`idle.ts`): asleep, it is never offered.
        expect(removeOffered(f)).toBe(
          f.noContact && f.removal === "none" && f.lifecycle !== "removed",
        );
        // Never both: a computer with a removal recorded goes on through the removal's steps.
        if (removeOffered(f)) expect(unsignedDeletionDue(f)).toBe(false);
      }),
    );
  });

  it("offers stopping without saving only a removed member's running computer, after 3 refused stops", () => {
    const running = ["started_no_host", "start_claimed", "host_running", "host_refused"];
    fc.assert(
      fc.property(facts, (f) => {
        expect(removalStopWithoutSavingDue(f)).toBe(
          f.removal === "pending" &&
            f.memberRemoved &&
            running.includes(f.lifecycle) &&
            f.refusedStops >= 3,
        );
      }),
    );
  });

  it("lets a removal end unsigned only when the sign-out cannot settle, never instead of one", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const due = unsignedDeletionDue(f);
        if (due) {
          expect(f.removal).toBe("pending");
          expect(f.lifecycle).toBe("removal_pending");
          expect(f.settled || f.signOutRunning).toBe(false);
          expect(
            f.revocationRequired ||
              f.signOutFailed ||
              f.signOut === "requested" ||
              f.signOut === "tombstoned",
          ).toBe(true);
        }
        // A sign-out that settled, never tried, or still runs: the ordinary steps.
        if (f.settled || f.signOutRunning) expect(due).toBe(false);
        const tried = f.signOutFailed || f.signOut === "requested" || f.signOut === "tombstoned";
        if (!tried && !f.revocationRequired) expect(due).toBe(false);
      }),
    );
    const base: RemovalFacts = {
      noContact: false,
      removal: "pending",
      lifecycle: "removal_pending",
      settled: false,
      signOut: "requested",
      signOutRunning: false,
      signOutFailed: false,
      revocationRequired: false,
      memberRemoved: false,
      refusedStops: 0,
    };
    expect(unsignedDeletionDue(base)).toBe(true);
    expect(unsignedDeletionDue({ ...base, signOut: "none", revocationRequired: true })).toBe(true);
    // A failed logout leaves the phase at none: the marker says it was tried.
    expect(unsignedDeletionDue({ ...base, signOut: "none", signOutFailed: true })).toBe(true);
    expect(unsignedDeletionDue({ ...base, signOut: "none" })).toBe(false);
  });
});
