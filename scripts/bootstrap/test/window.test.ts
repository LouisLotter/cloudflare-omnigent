// ADR 0007's restore point and read-only window in `bootstrap.ts update`, and its rollback
// (WP3.41), against the fake Cloudflare: a finished installation made by the bootstrap itself,
// updated with a window that opens before the deploy and closes only on acceptance; the check
// that needs the restore point; acceptance and rollback interrupted at every call and every
// journal write; the refusals; and the journal's records.

import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_WINDOW_SECRET,
  RESTORE_POINT_VAR,
  ROLLBACK_SECRET,
} from "../../../worker/src/server/maintenance.ts";
import { parseLogs } from "../events.ts";
import {
  BootstrapRefusal,
  type BootstrapState,
  type Journal,
  type RunOptions,
  runBootstrap,
  type StateStore,
} from "../machine.ts";
import { runRollback } from "../rollback.ts";
import type { Installation } from "../settings.ts";
import { parseState } from "../state.ts";
import {
  runUpdate,
  type UpdateContext,
  type UpdateOptions,
  type UpdateOutcome,
} from "../update.ts";
import {
  closeWindow,
  newWindowId,
  RESTORE_POINTS_KEPT,
  type RestorePointRecord,
  restorePointWhere,
  windowCheck,
  windowRefusal,
} from "../window.ts";
import { CHECK_MS, Crash, FakeWorld, MemoryStore, SWITCH_MS } from "./fake-cloud.ts";
import { accountPlan, baseConfigs, freshState, OWNER_PASSWORD, stagingPlan } from "./fixtures.ts";

const BASE = baseConfigs();
const CODE_A = "a".repeat(40);
const CODE_B = "b".repeat(40);
const OPTIONS: UpdateOptions = {
  verify: true,
  pollMs: 30_000,
  switchMs: 330_000,
  verifyWaitMs: 15 * 60_000,
  acceptWaitMs: 10 * 60_000,
};
const RUN: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};
const ID = /^rp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

interface Harness {
  readonly world: FakeWorld;
  readonly store: MemoryStore;
  readonly lines: string[];
  readonly plan: Installation;
  update(code?: string, options?: Partial<UpdateOptions>): Promise<UpdateOutcome>;
  rollback(options?: Partial<UpdateOptions>): ReturnType<typeof runRollback>;
  journal(): Journal;
}

function counter(): (n: number) => Uint8Array {
  let next = 1;
  return (n) => new Uint8Array(n).map(() => next++ % 256);
}

/** A finished installation, made by the bootstrap against a fake Cloudflare, a day old. */
async function installed(plan?: Installation): Promise<Harness> {
  const p = plan ?? (await accountPlan());
  const world = new FakeWorld(p);
  const store = new MemoryStore(freshState(p));
  const outcome = await runBootstrap(
    {
      cloud: world.cloud(),
      store,
      baseConfigs: BASE,
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: "cfo-canary-replica-key-id",
        replicaSecretAccessKey: "cfo-canary-replica-secret-key",
      }),
      random: (n) => new Uint8Array(n).fill(0xab),
      now: () => world.now,
      sleep: async (ms) => {
        world.now += Math.max(0, ms);
      },
      log: () => undefined,
    },
    RUN,
  );
  expect(outcome).toEqual({ kind: "done" });
  world.calls.length = 0;
  world.counts.clear();
  world.now += 24 * 3600_000;
  const random = counter();
  const lines: string[] = [];
  const context = (code: string): UpdateContext => ({
    cloud: world.cloud(),
    store,
    baseConfigs: BASE,
    codeVersion: code,
    random,
    now: () => world.now,
    sleep: async (ms) => {
      world.now += Math.max(0, ms);
    },
    log: (line) => lines.push(line),
  });
  return {
    world,
    store,
    lines,
    plan: p,
    update: (code = CODE_A, options = {}) => runUpdate(context(code), { ...OPTIONS, ...options }),
    rollback: (options = {}) => runRollback(context(CODE_A), { ...OPTIONS, ...options }),
    journal: () => store.load().journal,
  };
}

/** The secrets of the version serving all of the Worker's traffic now. */
function secrets(h: Harness, worker = h.plan.platformWorker): ReadonlyMap<string, string> {
  return h.world.secretsOf(worker) ?? new Map();
}

function count(h: Harness, call: string): number {
  return h.world.calls.filter((c) => c === call).length;
}

/** An update left open: deployed, its check not passed (the server never shows a durable owner). */
async function openWindow(h: Harness): Promise<{ id: string; before: Map<string, string> }> {
  const before = new Map(secrets(h));
  const from = h.world.now;
  h.world.truth = (t) =>
    t < from ? { initialized: true, reason: "durable" } : { initialized: false, reason: "x" };
  const outcome = await h.update();
  expect(outcome).toMatchObject({ kind: "deployed", window: "open" });
  const id = h.journal().window?.id as string;
  expect(id).toMatch(ID);
  return { id, before };
}

describe("an update's read-only window (WP3.41)", () => {
  it("is recorded before the deploy, with what ran before, and carried by the deploy", async () => {
    const h = await installed();
    const platformBefore = h.world.latest(h.plan.platformWorker)?.id;
    const webBefore = h.world.latest(h.plan.webWorker)?.id;
    const saved: (Journal["window"] | undefined)[] = [];
    h.world.before = {
      call: "deployPlatform",
      nth: 1,
      run: () => saved.push(h.store.load().journal.window),
    };
    const { id } = await openWindow(h);
    // Persist before effect: the window, and what to go back to, were in the journal first.
    expect(saved[0]).toMatchObject({ id, previous: { platformVersionId: platformBefore } });
    expect(h.journal().window).toEqual({
      id,
      openedAt: expect.any(String),
      deployStartedAt: expect.any(String),
      // Reported by the server even while the check waits for a durable owner.
      restorePointTakenAt: expect.any(String),
      previous: { platformVersionId: platformBefore, webVersionId: webBefore },
    });
    const config = h.world.configs.get(h.plan.platformWorker)?.at(-1) as {
      vars: Record<string, string>;
    };
    expect(config.vars[RESTORE_POINT_VAR]).toBe(id);
    expect(secrets(h).get(MAINTENANCE_WINDOW_SECRET)).toBe(id);
    expect(h.lines).toContain(
      `first the new server takes a restore point of Omnigent's data (${id}), and Omnigent is paused (it takes no requests) until the new version is checked: about 10 to 15 minutes`,
    );
    // Other steps refuse while it is open.
    expect(windowRefusal(h.journal())).toMatch(/Omnigent is paused until it is/);
  });

  it("is never accepted without the restore point its server reports", async () => {
    const h = await installed();
    h.world.restorePointFails = true;
    const outcome = await h.update();
    expect(outcome).toEqual({
      kind: "deployed",
      why: expect.stringMatching(/not yet applied|has not reported its restore point/),
      window: "open",
    });
    expect(h.journal().update?.verifiedAt).toBeUndefined();
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(true);
    // The server takes it after all: the next run checks, and accepts.
    h.world.restorePointFails = false;
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(1);
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
  });

  it("an update to newer code inside the window keeps its restore point and what ran before", async () => {
    const h = await installed();
    const { id } = await openWindow(h);
    const previous = h.journal().window?.previous;
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    const config = h.world.configs.get(h.plan.platformWorker)?.at(-1) as {
      vars: Record<string, string>;
    };
    expect(config.vars[RESTORE_POINT_VAR]).toBe(id);
    expect(h.journal().restorePoints).toEqual([
      expect.objectContaining({ id, outcome: "accepted", updatedTo: CODE_B }),
    ]);
    expect(previous).toBeDefined();
    expect(h.lines).toContainEqual(
      expect.stringMatching(
        /^updating https:\/\/.* to bbbbbbbbbbbb inside the read-only window opened at .*: its restore point, from before the first update, stays the one to go back to$/,
      ),
    );
  });

  it("a window ended outside the installer is never rolled back: the update starts again", async () => {
    const h = await installed();
    const { id } = await openWindow(h);
    // Someone deletes the window's secret by hand: Omnigent may have taken changes since.
    await h.world
      .cloud()
      .updateSecrets(h.plan.platformWorker, { [MAINTENANCE_WINDOW_SECRET]: null });
    await expect(h.rollback()).rejects.toThrow(/ended outside this installer/);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.update()).toEqual({ kind: "done" });
    const points = h.journal().restorePoints ?? [];
    expect(points.map((p) => [p.id === id, p.outcome])).toEqual([
      [true, "ended outside the installer"],
      [false, "accepted"],
    ]);
    expect(count(h, "deployPlatform")).toBe(2);
  });

  it("refuses an order or a window the state file does not explain, and an update during a rollback", async () => {
    const h = await installed();
    await h.world
      .cloud()
      .updateSecrets(h.plan.platformWorker, { [ROLLBACK_SECRET]: "rp-20261001T000000Z-00000001" });
    await expect(h.update()).rejects.toThrow(/holds a rollback order .* nothing was changed/);
    await h.world.cloud().updateSecrets(h.plan.platformWorker, {
      [ROLLBACK_SECRET]: null,
      [MAINTENANCE_WINDOW_SECRET]: "rp-20261001T000000Z-00000001",
    });
    await expect(h.update()).rejects.toThrow(/read-only window .* this state file does not record/);
    expect(count(h, "deployPlatform")).toBe(0);
    const other = await installed();
    await openWindow(other);
    other.world.rollbackWorks = false;
    expect((await other.rollback({ verifyWaitMs: 60_000 })).kind).toBe("waiting");
    await expect(other.update()).rejects.toThrow(/being rolled back: finish it with/);
    expect(windowRefusal(other.journal())).toMatch(/being rolled back/);
  });

  it("acceptance, once decided, is finished first and never rolled back", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    // Decided, then the window's secret change lost: the next run finishes it.
    h.world.crash = { call: "updateSecrets", nth: 1, when: "before" };
    await expect(h.update()).rejects.toThrow(Crash);
    expect(h.journal().window?.acceptStartedAt).toBeDefined();
    await expect(h.rollback()).rejects.toThrow(/was accepted at .* fix|newer update instead/);
    // A newer checkout finishes the acceptance before its own update.
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.map((p) => [p.outcome, p.updatedTo])).toEqual([
      ["accepted", CODE_A],
      ["accepted", CODE_B],
    ]);
    await expect(h.rollback()).rejects.toThrow(
      /the last update was accepted at .*nothing was changed/,
    );
  });

  it("acceptance closes the window once its secret is gone, and says when the restart was not seen (Codex r2-3)", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    const outcome = await h.update(CODE_A, { acceptWaitMs: 60_000 });
    expect(outcome).toEqual({
      kind: "deployed",
      why: expect.stringMatching(/has not run on the released version yet|not yet applied/),
      window: "closing",
    });
    // Closed whatever the logs say later: no evidence lost or late can hold it open.
    expect(h.journal().window).toBeUndefined();
    expect(h.journal().restorePoints?.[0]?.outcome).toBe("accepted");
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
    h.world.now += SWITCH_MS;
    expect(await h.update()).toEqual({ kind: "current" });
    expect(count(h, "updateSecrets")).toBe(1);
  });

  it("is never accepted while the server does not report its restore point, though it answers", async () => {
    const h = await installed();
    h.world.reportsRestorePoint = false;
    expect(await h.update(CODE_A, { verifyWaitMs: 5 * 60_000 })).toEqual({
      kind: "deployed",
      why: "the restarted server has not reported its restore point yet",
      window: "open",
    });
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(true);
    h.world.reportsRestorePoint = true;
    expect(await h.update()).toEqual({ kind: "done" });
  });

  it("an acceptance decided and interrupted is finished first by a newer checkout", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.crash = { call: "updateSecrets", nth: 1, when: "before" };
    await expect(h.update()).rejects.toThrow(Crash);
    expect(h.journal().window?.acceptStartedAt).toBeDefined();
    expect(await h.update(CODE_B, { acceptWaitMs: 60_000 })).toEqual({
      kind: "deployed",
      why: expect.stringMatching(/has not run on the released version yet|not yet applied/),
      window: "closing",
    });
    expect(count(h, "deployPlatform")).toBe(1);
    h.world.now += SWITCH_MS;
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.map((p) => p.updatedTo)).toEqual([CODE_A, CODE_B]);
  });

  it("acceptance waits while Cloudflare does not say which version serves", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.before = {
      call: "updateSecrets",
      nth: 1,
      run: () => {
        h.world.noVersions = true;
      },
    };
    const outcome = await h.update(CODE_A, { acceptWaitMs: 60_000 });
    expect(outcome).toEqual({
      kind: "deployed",
      why: "Cloudflare does not say yet which version serves the platform Worker",
      window: "closing",
    });
    expect(h.journal().window).toBeUndefined();
  });

  it("acceptance stops, the window kept, when the window's secret is not seen deleted", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.bulkKeeps = true;
    await expect(h.update()).rejects.toThrow(/still holds the update's read-only window/);
    expect(h.journal().window?.acceptStartedAt).toBeDefined();
    h.world.bulkKeeps = false;
    expect(await h.update()).toEqual({ kind: "done" });
  });

  it("acceptance stops when the platform Worker is gone", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.before = {
      call: "secretNames",
      nth: (h.world.counts.get("secretNames") ?? 0) + 2,
      run: () => h.world.versions.delete(h.plan.platformWorker),
    };
    await expect(h.update()).rejects.toThrow(/no longer exists/);
  });

  it("a window ended outside the installer after a deploy whose confirmation was lost is never reused (Codex r1-3)", async () => {
    const h = await installed();
    h.world.crash = {
      call: "activeVersion",
      nth: (h.world.counts.get("activeVersion") ?? 0) + 1,
      when: "before",
    };
    await expect(h.update()).rejects.toThrow(Crash);
    const first = h.journal().window?.id as string;
    expect(h.journal().update?.platformDeployedAt).toBeUndefined();
    expect(secrets(h).get(MAINTENANCE_WINDOW_SECRET)).toBe(first);
    // Someone ends the window by hand; Omnigent takes changes.
    await h.world
      .cloud()
      .updateSecrets(h.plan.platformWorker, { [MAINTENANCE_WINDOW_SECRET]: null });
    expect(await h.update()).toEqual({ kind: "done" });
    const points = h.journal().restorePoints ?? [];
    expect(points.map((p) => [p.id === first, p.outcome])).toEqual([
      [true, "ended outside the installer"],
      [false, "accepted"],
    ]);
  });

  it("a window ended by redeploying the version from before is never reused (Codex r2-1)", async () => {
    const h = await installed();
    const { id } = await openWindow(h);
    const previous = h.journal().window?.previous.platformVersionId as string;
    await h.world.cloud().deployVersion(h.plan.platformWorker, previous);
    // As on Cloudflare, the secrets listed are still the latest version's, the update's, with the
    // window, though the version from before serves without it (WP3.41b).
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(true);
    await expect(h.rollback()).rejects.toThrow(/the version from before the update serves/);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.map((p) => [p.id === id, p.outcome])).toEqual([
      [true, "abandoned"],
      [false, "accepted"],
    ]);
  });

  it("after finishing an acceptance, the next window goes back to the accepted release (Codex r1)", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.crash = { call: "updateSecrets", nth: 1, when: "after" };
    await expect(h.update()).rejects.toThrow(Crash);
    const accepted = h.world.latest(h.plan.platformWorker);
    expect(accepted?.secrets.has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
    h.world.now += SWITCH_MS;
    expect((await h.update(CODE_B, { verify: false })).kind).toBe("deployed");
    expect(h.journal().window?.previous.platformVersionId).toBe(accepted?.id);
  });

  it("refuses, before any effect, a replica with no room beside it for a restore point", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    const root = {
      ...h.store.state,
      installation: { ...plan, replica: { ...plan.replica, url: "s3://cfo-canary-replica" } },
    };
    h.store.state = root as BootstrapState;
    await expect(h.update()).rejects.toThrow(
      /cannot be updated: its replica \(s3:\/\/cfo-canary-replica\) is at the root of its bucket.*nothing was changed/,
    );
    expect(count(h, "deployPlatform") + count(h, "secretNames")).toBe(0);
  });

  it("keeps the last three restore points", async () => {
    const h = await installed();
    const codes = ["1", "2", "3", "4", "5"].map((c) => c.repeat(40));
    for (const code of codes) {
      expect(await h.update(code)).toEqual({ kind: "done" });
      h.world.now += 3600_000;
    }
    const points = h.journal().restorePoints ?? [];
    expect(points).toHaveLength(RESTORE_POINTS_KEPT);
    expect(points.map((p) => p.updatedTo)).toEqual(codes.slice(-3));
    expect(new Set(points.map((p) => p.id)).size).toBe(3);
  });
});

describe("bootstrap.ts update --rollback (WP3.41)", () => {
  it("puts the restore point back, then the versions from before, and checks the server", async () => {
    const h = await installed();
    const platformBefore = h.world.latest(h.plan.platformWorker)?.id as string;
    const webBefore = h.world.latest(h.plan.webWorker)?.id as string;
    const journalBefore = h.journal();
    const { id, before } = await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.rollback()).toEqual({ kind: "done" });
    // The order, then the web Worker, then the platform Worker: each its version from before.
    const effects = h.world.calls.filter((c) =>
      ["updateSecrets", "deployVersion", "deployPlatform", "deployWeb"].includes(c),
    );
    expect(effects).toEqual([
      "deployPlatform",
      "deployWeb",
      "updateSecrets",
      "deployVersion",
      "deployVersion",
    ]);
    expect(h.world.secretChanges.at(-1)?.changes).toEqual({ [ROLLBACK_SECRET]: id });
    expect(h.world.redeployed.map((r) => [r.worker, r.versionId])).toEqual([
      [h.plan.webWorker, webBefore],
      [h.plan.platformWorker, platformBefore],
    ]);
    // Only after the server said the restore point is the replica again.
    const logs = parseLogs(
      h.world.logEvents(h.plan.platformWorker, 0, h.world.now),
      h.plan.platformWorker,
    );
    const rolled = logs.rollbacks.find((r) => r.restorePoint === id);
    expect(rolled).toBeDefined();
    expect(h.world.redeployed[0]?.at).toBeGreaterThanOrEqual(rolled?.loggedAt ?? Infinity);
    // The installation as before: its secrets, its code, no window, no order.
    expect(new Map(secrets(h))).toEqual(before);
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
    expect(secrets(h).has(ROLLBACK_SECRET)).toBe(false);
    const journal = h.journal();
    expect(journal.window).toBeUndefined();
    expect(journal.update).toBeUndefined();
    expect(journal.platformCode).toBe(journalBefore.platformCode);
    expect(journal.webCode).toBe(journalBefore.webCode);
    expect(journal.restorePoints).toEqual([
      expect.objectContaining({ id, outcome: "rolled back", updatedTo: CODE_A }),
    ]);
    expect(h.lines.at(-1)).toMatch(
      /^rolled back: https:\/\/.* runs the version from before the update, with Omnigent's data as it was at .*, and is available again$/,
    );
    // Then the update can be tried again: a new window, a new restore point.
    expect(await h.update()).toEqual({ kind: "done" });
    const again = h.journal().restorePoints ?? [];
    expect(again).toHaveLength(2);
    expect(again[1]?.id).not.toBe(id);
  });

  it("refuses outside a window, and changes nothing", async () => {
    const h = await installed();
    await expect(h.rollback()).rejects.toThrow(/no update is waiting to be checked/);
    expect(await h.update()).toEqual({ kind: "done" });
    await expect(h.rollback()).rejects.toThrow(/the last update was accepted/);
    expect(count(h, "deployVersion")).toBe(0);
  });

  it("has nothing to undo when no deploy of the window was ever sent", async () => {
    const h = await installed();
    // The window recorded; the run stops before its deploy's intent is written.
    h.store.crash = { nth: h.store.saves + 2 };
    await expect(h.update()).rejects.toThrow(Crash);
    expect(h.journal().window).toBeDefined();
    expect(h.journal().window?.deployStartedAt).toBeUndefined();
    expect(await h.rollback()).toEqual({ kind: "nothing" });
    expect(h.journal().window).toBeUndefined();
    expect(h.journal().update).toBeUndefined();
    expect(count(h, "deployVersion") + count(h, "updateSecrets")).toBe(0);
    expect(await h.update()).toEqual({ kind: "done" });
  });

  it("says so when a deploy was sent but the version from before serves, and update starts again", async () => {
    const h = await installed();
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.update()).rejects.toThrow(Crash);
    await expect(h.rollback()).rejects.toThrow(
      /not held, and the version from before the update serves: the update's deploy did not land.*run bootstrap\.ts update to try the update again.*nothing was changed/,
    );
    expect(count(h, "deployVersion") + count(h, "updateSecrets")).toBe(0);
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.map((p) => p.outcome)).toEqual(["abandoned", "accepted"]);
    expect(h.lines).toContainEqual(
      expect.stringMatching(/^the update's earlier deploy did not land/),
    );
  });

  it("waits, and says why, until the server puts the restore point back; a later run continues", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.rollbackWorks = false;
    const waiting = await h.rollback({ verifyWaitMs: 5 * 60_000 });
    expect(waiting).toEqual({
      kind: "waiting",
      why: expect.stringMatching(/has not put the restore point back yet/),
    });
    expect(count(h, "deployVersion")).toBe(0);
    h.world.rollbackWorks = true;
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.rollback()).toEqual({ kind: "done" });
    // The order was sent once.
    expect(h.world.secretChanges.filter((c) => ROLLBACK_SECRET in c.changes)).toHaveLength(1);
  });

  it("deletes a window or an order a version kept, after going back", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    // As if Cloudflare kept the current secrets on a rollback (it keeps each version's own).
    h.world.rollbackKeepsSecrets = true;
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.world.secretChanges.at(-1)?.changes).toEqual({
      [MAINTENANCE_WINDOW_SECRET]: null,
      [ROLLBACK_SECRET]: null,
    });
    expect(secrets(h).has(ROLLBACK_SECRET)).toBe(false);
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
  });

  it("goes back to the code from before the update too, and then refuses", async () => {
    const h = await installed();
    expect(await h.update(CODE_A)).toEqual({ kind: "done" });
    h.world.now += 3600_000;
    const from = h.world.now;
    h.world.truth = (t) =>
      t < from ? { initialized: true, reason: "durable" } : { initialized: false, reason: "x" };
    expect((await h.update(CODE_B)).kind).toBe("deployed");
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.journal()).toMatchObject({ platformCode: CODE_A, webCode: CODE_A });
    expect(h.journal().restorePoints?.at(-1)).toMatchObject({
      outcome: "rolled back",
      before: CODE_A,
      updatedTo: CODE_B,
    });
    await expect(h.rollback()).rejects.toThrow(
      /nothing to go back to: the last update's window was rolled back at .*nothing was changed/,
    );
    // The update can be made again from B's checkout.
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
  });

  it("goes back when the new server never took its restore point", async () => {
    const h = await installed();
    h.world.restorePointFails = true;
    expect((await h.update(CODE_A, { verifyWaitMs: 5 * 60_000 })).kind).toBe("deployed");
    expect(h.journal().window?.restorePointTakenAt).toBeUndefined();
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.lines).toContainEqual(
      expect.stringMatching(/with Omnigent's data as it was before the update \(restore point/),
    );
    expect(h.journal().restorePoints?.[0]?.takenAt).toBeUndefined();
  });

  it("waits, naming why, while the server refuses the order's settings", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.refusesSettings = (v) => v.secrets.has(ROLLBACK_SECRET);
    expect(await h.rollback({ verifyWaitMs: 5 * 60_000 })).toEqual({
      kind: "waiting",
      why: expect.stringMatching(/refused the rollback's settings \(it exited 78\)/),
    });
    expect(count(h, "deployVersion")).toBe(0);
  });

  it("only its own restore point's line counts, from a server it holds", async () => {
    const h = await installed();
    const { id } = await openWindow(h);
    h.world.rollbackWorks = false;
    const line = (restorePoint: string, held: boolean) => ({
      timestamp: h.world.now + 60_000,
      $workers: {
        scriptName: h.plan.platformWorker,
        scriptVersion: { id: "vx" },
        eventType: "alarm",
        entrypoint: "OmnigentServer",
      },
      source: { cfo: "watchdog", event: "rolled_back", exitCode: 79, held, restorePoint },
    });
    h.world.foreign.push(line("rp-20261001T000000Z-00000001", true), line(id, false));
    expect((await h.rollback({ verifyWaitMs: 5 * 60_000 })).kind).toBe("waiting");
    expect(count(h, "deployVersion")).toBe(0);
  });

  it("refuses when the plan is not usable or the platform Worker is gone", async () => {
    const h = await installed();
    await openWindow(h);
    const broken = { ...h.store.state, installation: { ...h.plan, ownerUsername: "root" } };
    const store: StateStore = { load: () => broken as BootstrapState, save: () => undefined };
    await expect(
      runRollback(
        {
          cloud: h.world.cloud(),
          store,
          baseConfigs: BASE,
          codeVersion: CODE_A,
          random: counter(),
          now: () => h.world.now,
          sleep: async () => undefined,
          log: () => undefined,
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/the plan is not usable/);
    h.world.versions.delete(h.plan.platformWorker);
    await expect(h.rollback()).rejects.toThrow(
      /no longer exists, so there is nothing to roll back/,
    );
  });

  it("stops when the platform Worker is gone after its version from before is deployed", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.before = {
      call: "secretNames",
      nth: (h.world.counts.get("secretNames") ?? 0) + 2,
      run: () => h.world.versions.delete(h.plan.platformWorker),
    };
    await expect(h.rollback()).rejects.toThrow(/after its rollback, .* does not exist/);
  });

  it("checks the version serving after it, once Cloudflare names it, and waits for a durable owner", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    h.world.before = {
      call: "deployVersion",
      nth: 2,
      run: () => {
        h.world.noVersions = true;
      },
    };
    const waiting = await h.rollback({ verifyWaitMs: 5 * 60_000 });
    expect(waiting.kind).toBe("waiting");
    expect(h.journal().window?.rollback?.platformVersionId).toBeUndefined();
    h.world.noVersions = false;
    expect((await h.rollback({ verifyWaitMs: 5 * 60_000 })).kind).toBe("waiting");
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(count(h, "deployVersion")).toBe(2);
  });

  it("never orders a rollback once the window ended outside the installer, on any run (Codex r1-2)", async () => {
    const h = await installed();
    await openWindow(h);
    // Started, then interrupted before the order; the window then ended by hand.
    h.world.crash = { call: "updateSecrets", nth: 1, when: "before" };
    await expect(h.rollback()).rejects.toThrow(Crash);
    expect(h.journal().window?.rollback?.startedAt).toBeDefined();
    await h.world
      .cloud()
      .updateSecrets(h.plan.platformWorker, { [MAINTENANCE_WINDOW_SECRET]: null });
    await expect(h.rollback()).rejects.toThrow(
      /ended outside this installer.*the rollback was called off/,
    );
    expect(h.world.secretChanges.some((c) => ROLLBACK_SECRET in c.changes)).toBe(false);
    expect(h.journal().window).toBeUndefined();
    expect(h.journal().restorePoints?.at(-1)?.outcome).toBe("ended outside the installer");
    expect(count(h, "deployVersion")).toBe(0);
    // The update goes on from there, with a restore point of now.
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.update()).toEqual({ kind: "done" });
  });

  it("keeps an order already sent, and the server held, when the window ends before the restore point is back (Codex r2-2)", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.rollbackWorks = false;
    expect((await h.rollback({ verifyWaitMs: 60_000 })).kind).toBe("waiting");
    expect(secrets(h).has(ROLLBACK_SECRET)).toBe(true);
    await h.world
      .cloud()
      .updateSecrets(h.plan.platformWorker, { [MAINTENANCE_WINDOW_SECRET]: null });
    await expect(h.rollback()).rejects.toThrow(/may be partly put back.*get help/);
    expect(secrets(h).has(ROLLBACK_SECRET)).toBe(true);
    expect(h.journal().window?.rollback?.startedAt).toBeDefined();
    expect(count(h, "deployVersion")).toBe(0);
    await expect(h.update()).rejects.toThrow(/being rolled back/);
  });

  it("resumes the rollback stopped where the first real one stopped, hours later (WP3.41b)", async () => {
    const h = await installed();
    const { id, before } = await openWindow(h);
    const previous = h.journal().window?.previous.platformVersionId as string;
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    // The owner's installation on 30 Oct: the restore point back, both versions from before
    // deployed, then the run failed before recording the platform Worker's.
    h.world.crash = { call: "deployVersion", nth: 2, when: "after" };
    await expect(h.rollback()).rejects.toThrow(Crash);
    const rollback = h.journal().window?.rollback;
    expect(rollback?.restoredAt).toBeDefined();
    expect(rollback?.webRolledBackAt).toBeDefined();
    expect(rollback?.platformRolledBackAt).toBeUndefined();
    expect(h.world.latest(h.plan.platformWorker)?.id).toBe(previous);
    // The latest version is the order's, with the window and the order, and not deployed: as on
    // Cloudflare, every secrets change is refused (10215) and a deploy would keep them.
    const order = h.world.uploads(h.plan.platformWorker)[0];
    expect(order?.id).not.toBe(previous);
    expect(order?.secrets.get(MAINTENANCE_WINDOW_SECRET)).toBe(id);
    expect(order?.secrets.get(ROLLBACK_SECRET)).toBe(id);
    await expect(
      h.world.cloud().updateSecrets(h.plan.platformWorker, { [ROLLBACK_SECRET]: null }),
    ).rejects.toThrow(
      /refuses to change .*'s secrets while its latest version is not the one deployed/,
    );
    // Hours later: the server long since durable, its status no longer logged.
    h.world.now += 6 * 3600_000;
    h.world.calls.length = 0;
    const deployed = h.world.redeployed.length;
    expect(await h.rollback()).toEqual({ kind: "done" });
    // Not deployed again; the update's versions deleted, and the version from before is the
    // latest again, with its own secrets.
    expect(h.world.redeployed).toHaveLength(deployed);
    expect(count(h, "deleteVersion")).toBeGreaterThanOrEqual(2);
    expect(count(h, "deleteLatestSecrets") + count(h, "updateSecrets")).toBe(0);
    expect(h.world.uploads(h.plan.platformWorker)[0]?.id).toBe(previous);
    expect(new Map(secrets(h))).toEqual(before);
    expect(h.journal().window).toBeUndefined();
    expect(h.journal().restorePoints?.at(-1)).toMatchObject({ id, outcome: "rolled back" });
    // Secrets changes work again (services, github-app), and so does the next update.
    expect(
      await h.world.cloud().updateSecrets(h.plan.platformWorker, { SERVER_ENV_CFO_X: "1" }),
    ).toBe("sent");
    expect(await h.update()).toEqual({ kind: "done" });
  });

  it("when Cloudflare keeps the update's versions, deletes the window and the order from the latest, and says what stays refused (WP3.41b)", async () => {
    const h = await installed();
    const { before } = await openWindow(h);
    const previous = h.journal().window?.previous.platformVersionId as string;
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.keepsVersions = true;
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.world.latest(h.plan.platformWorker)?.id).toBe(previous);
    // The latest version is a new one, not deployed, without the window and the order: no later
    // deploy takes them up.
    const latest = h.world.uploads(h.plan.platformWorker)[0];
    expect(latest?.id).not.toBe(previous);
    expect(latest?.secrets.has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
    expect(latest?.secrets.has(ROLLBACK_SECRET)).toBe(false);
    expect(count(h, "deleteLatestSecrets")).toBe(1);
    expect(h.lines).toContainEqual(
      expect.stringMatching(
        /^warning: .*'s latest version is not the one deployed \(cf workers versions delete failed: \[10000\]\)\. It holds no window or rollback order.*refuses changes of its secrets/,
      ),
    );
    await expect(
      h.world.cloud().updateSecrets(h.plan.platformWorker, { SERVER_ENV_CFO_X: "1" }),
    ).rejects.toThrow(/latest version is not the one deployed/);
    // The next update deploys a version: its window is its own, and secrets changes work again.
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.map((p) => p.outcome)).toEqual(["rolled back", "accepted"]);
    expect(secrets(h).has(ROLLBACK_SECRET)).toBe(false);
    expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
    expect(new Map([...secrets(h)].filter(([n]) => before.has(n)))).toEqual(before);
    expect(
      await h.world.cloud().updateSecrets(h.plan.platformWorker, { SERVER_ENV_CFO_X: "1" }),
    ).toBe("sent");
  });

  it("falls back the same way when Cloudflare does not list the version that serves, or still lists a newer one (WP3.41b)", async () => {
    for (const how of ["unlisted", "kept"] as const) {
      const h = await installed();
      await openWindow(h);
      h.world.truth = () => ({ initialized: true, reason: "durable" });
      const previous = h.journal().window?.previous.platformVersionId;
      const cloud = h.world.cloud();
      const stand = { ...cloud };
      if (how === "unlisted") {
        stand.versions = async (worker) =>
          (await cloud.versions(worker)).filter((v) => v.id !== previous);
      } else stand.deleteVersion = async () => undefined;
      const outcome = await runRollback(
        {
          cloud: stand,
          store: h.store,
          baseConfigs: BASE,
          codeVersion: CODE_A,
          random: counter(),
          now: () => h.world.now,
          sleep: async (ms) => {
            h.world.now += Math.max(0, ms);
          },
          log: (line) => h.lines.push(line),
        },
        OPTIONS,
      );
      expect(outcome, how).toEqual({ kind: "done" });
      expect(h.lines, how).toContainEqual(
        expect.stringMatching(
          how === "unlisted"
            ? /^warning: .*\(Cloudflare does not list the version that serves, v\d+\)/
            : /^warning: .*\(Cloudflare still lists version v\d+ first\)/,
        ),
      );
      expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET), how).toBe(false);
      expect(secrets(h).has(ROLLBACK_SECRET), how).toBe(false);
    }
  });

  it("stops when the window or the order outlasts its deletion from the latest version (WP3.41b)", async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.keepsVersions = true;
    const cloud = h.world.cloud();
    const outcome = runRollback(
      {
        cloud: { ...cloud, deleteLatestSecrets: async () => undefined },
        store: h.store,
        baseConfigs: BASE,
        codeVersion: CODE_A,
        random: counter(),
        now: () => h.world.now,
        sleep: async (ms) => {
          h.world.now += Math.max(0, ms);
        },
        log: () => undefined,
      },
      OPTIONS,
    );
    await expect(outcome).rejects.toThrow(
      /latest version still holds SERVER_ENV_CFO_MAINTENANCE_WINDOW, SERVER_ENV_CFO_ROLLBACK_TO after deleting them; run bootstrap\.ts update --rollback again/,
    );
    h.world.keepsVersions = false;
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.world.uploads(h.plan.platformWorker)[0]?.id).toBe(
      h.world.latest(h.plan.platformWorker)?.id,
    );
  });

  it("a staging installation goes back the same way", async () => {
    const h = await installed(await stagingPlan());
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.rollback()).toEqual({ kind: "done" });
    expect(h.journal().restorePoints?.[0]?.where).toMatch(/^file:\/\/\/cfo-restore-points\/rp-/);
  });
});

/** Every call and journal write of a run, by occurrence, from a reference run of `act`. */
async function crashPoints(
  setup: () => Promise<Harness>,
  act: (h: Harness) => Promise<unknown>,
): Promise<({ call: string; nth: number; when: "before" | "after" } | { journal: number })[]> {
  const h = await setup();
  const calls = h.world.calls.length;
  const saves = h.store.saves;
  await act(h);
  const seen = new Map<string, number>();
  for (const call of h.world.calls.slice(calls)) seen.set(call, (seen.get(call) ?? 0) + 1);
  return [
    ...[...seen].flatMap(([call, times]) =>
      Array.from({ length: Math.min(times, 4) }, (_, i) =>
        (["before", "after"] as const).map((when) => ({ call, nth: i + 1, when })),
      ).flat(),
    ),
    ...Array.from({ length: h.store.saves - saves }, (_, i) => ({ journal: i + 1 })),
  ];
}

async function runUntil<T>(h: Harness, run: () => Promise<T>, done: (t: T) => boolean) {
  let outcome: T | undefined;
  for (let attempt = 0; attempt < 5 && (outcome === undefined || !done(outcome)); attempt++) {
    try {
      outcome = await run();
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
    }
    h.world.now += CHECK_MS;
  }
  return outcome;
}

describe("a crash at any point of the acceptance or the rollback", () => {
  const checkedOpen = async () => {
    const h = await installed();
    await openWindow(h);
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    h.world.calls.length = 0;
    h.world.counts.clear();
    return h;
  };

  it("acceptance: a new run finishes it, deletes the window's secret once, and records it once", {
    timeout: 120_000,
  }, async () => {
    const points = await crashPoints(checkedOpen, (h) => h.update());
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      const h = await checkedOpen();
      if ("journal" in point) h.store.crash = { nth: h.store.saves + point.journal };
      else h.world.crash = point;
      const outcome = await runUntil(
        h,
        () => h.update(),
        (o) => o.kind === "done" || o.kind === "current",
      );
      // Done; or, interrupted after the window closed, up to date on the next run.
      expect(["done", "current"], JSON.stringify(point)).toContain(outcome?.kind);
      expect(h.world.crash).toBeUndefined();
      expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET)).toBe(false);
      expect(h.journal().window).toBeUndefined();
      expect(h.journal().restorePoints).toHaveLength(1);
      expect(count(h, "deployPlatform")).toBe(0);
    }
  });

  it.each([
    ["", false],
    [", Cloudflare keeping the update's versions (WP3.41b)", true],
  ])(
    "rollback%s: a new run finishes it, orders it once, and goes back to the same versions",
    {
      timeout: 120_000,
    },
    async (_how, keepsVersions) => {
      const setup = async () => {
        const h = await checkedOpen();
        h.world.keepsVersions = keepsVersions;
        return h;
      };
      // A deletion Cloudflare refuses has no effect to lose the answer of.
      const points = (await crashPoints(setup, (h) => h.rollback())).filter(
        (p) => !(keepsVersions && "call" in p && p.call === "deleteVersion" && p.when === "after"),
      );
      expect(points.length).toBeGreaterThan(20);
      for (const point of points) {
        const h = await setup();
        const platformBefore = h.journal().window?.previous.platformVersionId;
        if ("journal" in point) h.store.crash = { nth: h.store.saves + point.journal };
        else h.world.crash = point;
        const outcome = await runUntil(
          h,
          () => h.rollback(),
          (o) => o.kind === "done",
        );
        expect(outcome, JSON.stringify(point)).toEqual({ kind: "done" });
        expect(h.world.crash).toBeUndefined();
        const orders = h.world.secretChanges.filter(
          (c) => c.changes[ROLLBACK_SECRET] !== undefined,
        );
        expect(orders.length, JSON.stringify(point)).toBeLessThanOrEqual(2);
        expect(new Set(orders.map((o) => o.changes[ROLLBACK_SECRET])).size).toBe(1);
        expect(h.world.latest(h.plan.platformWorker)?.id).toBe(platformBefore);
        expect(h.world.redeployed.every((r) => r.at >= (h.world.redeployed[0]?.at ?? 0))).toBe(
          true,
        );
        // Neither the window nor the order where a later deploy would take them up (WP3.41b).
        expect(secrets(h).has(MAINTENANCE_WINDOW_SECRET), JSON.stringify(point)).toBe(false);
        expect(secrets(h).has(ROLLBACK_SECRET), JSON.stringify(point)).toBe(false);
        expect(h.world.uploads(h.plan.platformWorker)[0]?.id === platformBefore).toBe(
          !keepsVersions,
        );
        expect(h.journal().window).toBeUndefined();
        expect(h.journal().restorePoints?.[0]?.outcome).toBe("rolled back");
        // Never the platform Worker's version from before while the server had not said the
        // restore point is the replica again.
        const logs = parseLogs(
          h.world.logEvents(h.plan.platformWorker, 0, h.world.now),
          h.plan.platformWorker,
        );
        const first = Math.min(...logs.rollbacks.map((r) => r.loggedAt));
        for (const r of h.world.redeployed) expect(r.at).toBeGreaterThanOrEqual(first);
      }
    },
  );
});

describe("the window's pieces", () => {
  it("names windows by time, sortable, with 8 random hex digits", () => {
    const id = newWindowId(Date.UTC(2026, 9, 30, 12, 3, 4), () => new Uint8Array([1, 2, 254, 255]));
    expect(id).toBe("rp-20261030T120304Z-0102feff");
  });

  it("finds restore points where the server keeps them, beside the replica", () => {
    const where = (url: string) => restorePointWhere({ replica: { url } }, "rp-x");
    expect(where("s3://b-replica/omnigent")).toBe("s3://b-replica/cfo-restore-points/rp-x/");
    expect(where("s3://b/a/omnigent")).toBe("s3://b/a/cfo-restore-points/rp-x/");
    expect(where("file:///replica")).toBe("file:///cfo-restore-points/rp-x/");
    expect(where("file:///srv/replica")).toBe("file:///srv/cfo-restore-points/rp-x/");
  });

  it("keeps the newest three restore points when a window closes", () => {
    const point = (n: number): RestorePointRecord => ({
      id: `rp-2026100${n}T000000Z-0000000${n}`,
      where: "s3://b/cfo-restore-points/",
      outcome: "accepted",
      closedAt: new Date(n).toISOString(),
    });
    let journal: Journal = {};
    for (let n = 1; n <= 5; n++) journal = closeWindow(journal, point(n));
    expect(journal.restorePoints?.map((p) => p.id.slice(-1))).toEqual(["3", "4", "5"]);
    expect(closeWindow(journal, point(5)).restorePoints).toHaveLength(3);
  });

  it("needs the window and the restore point from the update's own version", () => {
    const line = (over: Record<string, unknown>, version = "v9", at = 2000) => ({
      timestamp: at,
      $workers: {
        scriptName: "w",
        scriptVersion: { id: version },
        eventType: "alarm",
        entrypoint: "OmnigentServer",
      },
      source: {
        cfo: "bootstrap",
        event: "status",
        reason: "durable",
        bootstrapStatus: {
          protocolVersion: 1,
          installationId: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
          initialized: true,
          checkedAt: new Date(at).toISOString(),
        },
        secretPresent: false,
        configApplied: true,
        ...over,
      },
    });
    const id = "rp-20261030T120000Z-0a1b2c3d";
    const point = { id, takenAt: "2026-10-30T12:05:00.000Z" };
    const check = (...events: unknown[]) =>
      windowCheck(parseLogs(events, "w"), {
        installationId: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
        versionId: "v9",
        since: 1000,
        id,
      });
    expect(check(line({ maintenance: id, restorePoint: point }))).toEqual({
      ok: true,
      takenAt: point.takenAt,
    });
    expect(check(line({ maintenance: null, restorePoint: point }))).toMatchObject({ ok: false });
    expect(check(line({ maintenance: id, restorePoint: null }))).toMatchObject({ ok: false });
    expect(
      check(line({ maintenance: id, restorePoint: { ...point, id: "rp-other" } })),
    ).toMatchObject({
      ok: false,
    });
    // Another version's, one from before the deploy, or one not applied: no word at all.
    expect(check(line({ maintenance: id, restorePoint: point }, "v8"))).toMatchObject({
      ok: false,
    });
    expect(check(line({ maintenance: id, restorePoint: point }, "v9", 500))).toMatchObject({
      ok: false,
    });
    expect(
      check(line({ maintenance: id, restorePoint: point, configApplied: false })),
    ).toMatchObject({ ok: false });
    // The newest decides.
    expect(
      check(
        line({ maintenance: id, restorePoint: point }, "v9", 2000),
        line({ maintenance: null, restorePoint: null }, "v9", 3000),
      ),
    ).toMatchObject({ ok: false });
  });

  it("reads and writes the window and the restore points in the state file, and refuses broken ones", async () => {
    const plan = await accountPlan();
    const id = "rp-20261030T120000Z-0a1b2c3d";
    const window = {
      id,
      openedAt: "2026-10-30T12:00:00.000Z",
      previous: {
        platformVersionId: "v1",
        webVersionId: "v2",
        platformCode: CODE_A,
        webCode: CODE_A,
      },
      restorePointTakenAt: "2026-10-30T12:06:00.000Z",
      acceptStartedAt: "2026-10-30T12:10:00.000Z",
      deployStartedAt: "2026-10-30T12:00:30.000Z",
      rollback: {
        startedAt: "2026-10-30T12:11:00.000Z",
        restoredAt: "2026-10-30T12:12:00.000Z",
        webRolledBackAt: "2026-10-30T12:13:00.000Z",
        platformRolledBackAt: "2026-10-30T12:14:00.000Z",
        platformVersionId: "v1",
      },
    };
    const points: RestorePointRecord[] = [
      {
        id,
        where: `s3://b/cfo-restore-points/${id}/`,
        takenAt: "2026-10-30T12:06:00.000Z",
        before: CODE_B,
        updatedTo: CODE_A,
        outcome: "rolled back",
        closedAt: "2026-10-30T12:20:00.000Z",
      },
    ];
    const state = (journal: unknown): string =>
      JSON.stringify({ stateVersion: 6, installation: plan, journal });
    const read = parseState(state({ window, restorePoints: points }));
    expect(read.journal.window).toEqual(window);
    expect(read.journal.restorePoints).toEqual(points);
    const store = new MemoryStore({ ...freshState(plan), journal: {} } as BootstrapState);
    expect(store.load().journal).toEqual({});
    for (const [journal, message] of [
      [{ window: { ...window, id: "rp-1" } }, /journal.window.id is not a window's ID/],
      [{ window: { ...window, openedAt: undefined } }, /journal.window.openedAt is missing/],
      [{ window: { ...window, previous: { webVersionId: "v2" } } }, /previous.platformVersionId/],
      [{ window: { ...window, rollback: {} } }, /rollback.startedAt is missing/],
      [
        { window: { ...window, previous: { ...window.previous, platformCode: "main" } } },
        /platformCode is not a commit ID/,
      ],
      [{ restorePoints: "x" }, /restorePoints is not a list/],
      [{ restorePoints: [{ ...points[0], outcome: "lost" }] }, /unknown outcome/],
      [{ restorePoints: [{ ...points[0], closedAt: "never" }] }, /closedAt is not a time/],
    ] as const) {
      expect(() => parseState(state(journal))).toThrow(message);
    }
    // A bootstrap from before WP3.41 never reads it: it is version 6.
    expect(() =>
      parseState(state({ window }).replace('"stateVersion":6', '"stateVersion":7')),
    ).toThrow(/unknown version/);
  });

  it("refuses with BootstrapRefusal, so the command exits 1 and names it", async () => {
    const h = await installed();
    const error = await h.rollback().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BootstrapRefusal);
  });
});
