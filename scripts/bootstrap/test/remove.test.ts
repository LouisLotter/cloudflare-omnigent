import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../staging/lock.ts";
import type { BootstrapState } from "../machine.ts";
import { type ApiToken, r2TokenName, r2TokenResources, TOKEN_SETTLE_MS } from "../r2-token.ts";
import {
  removeInstallationToken,
  removeStagingTokens,
  stagingTokenDeployment,
  withInstallationLocks,
} from "../remove.ts";
import type { Installation } from "../settings.ts";
import { fileStateStore, workerLockPath } from "../state.ts";
import { FakeWorld, MemoryStore, R2_GROUP_ID } from "./fake-cloud.ts";
import { accountPlan, INSTALLATION, stagingPlan } from "./fixtures.ts";

const ACCOUNT = "1".repeat(32);
let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-remove-"));
  // The bootstrap's locks live under XDG_CONFIG_HOME: keep them in this test's directory.
  saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = saved;
  rmSync(dir, { recursive: true, force: true });
});

function tokenFor(plan: Installation): Omit<ApiToken, "id" | "ipLimited"> {
  return {
    name: r2TokenName(plan),
    status: "active",
    policies: [
      { effect: "allow", permissionGroups: [R2_GROUP_ID], resources: r2TokenResources(plan) },
    ],
  };
}

/** A world holding the installation's token, and a state that records it. */
function withToken(plan: Installation) {
  const world = new FakeWorld(plan);
  const id = world.addToken(tokenFor(plan));
  const state: BootstrapState = {
    stateVersion: 1,
    installation: plan,
    journal: {
      platformDeployedAt: "2026-10-28T12:00:00.000Z",
      r2Token: { name: r2TokenName(plan), id, createdAt: "2026-10-28T11:59:00.000Z" },
    },
  };
  return { world, id, state };
}

const stagingS3 = (overrides: Partial<Installation> = {}) =>
  stagingPlan({
    replica: { url: "s3://cfo-stg-wp24-db/omnigent", endpoint: "https://canary.r2.example.test" },
    artifacts: { url: "s3://cfo-stg-wp24-artifacts" },
    ...overrides,
  });

describe("removeInstallationToken: bootstrap.ts remove-r2-token", () => {
  function options(store: MemoryStore, world: FakeWorld, lines: string[], slept: number[] = []) {
    return {
      store,
      api: world.tokenApi(),
      workerExists: () => true,
      force: false,
      sleep: (ms: number) => {
        slept.push(ms);
      },
      log: (line: string) => lines.push(line),
    };
  }

  it("refuses while a Worker of that name exists, unless told to go ahead", async () => {
    const { world, id, state } = withToken(await accountPlan());
    const store = new MemoryStore(state);
    const lines: string[] = [];
    const base = options(store, world, lines);
    expect(() => removeInstallationToken(base)).toThrow(
      /a Worker named cloudflare-omnigent still exists, .* or pass --yes to cut it off now/,
    );
    expect(world.tokens.has(id)).toBe(true);
    expect(removeInstallationToken({ ...base, force: true })).toBe(1);
    expect(world.tokens.size).toBe(0);
    expect(store.state.journal.r2Token).toBeUndefined();
    // The rest of the journal stays.
    expect(store.state.journal.platformDeployedAt).toBe("2026-10-28T12:00:00.000Z");
    expect(lines).toEqual([`deleted the R2 token ${r2TokenName(state.installation)}`]);
    // Again: nothing recorded, nothing to do.
    expect(removeInstallationToken({ ...base, force: true })).toBe(0);
    expect(lines.at(-1)).toBe("no R2 token recorded for this installation: nothing to delete");
  });

  it("waits for a create left in flight, then deletes by name what landed (Codex r1-1)", async () => {
    const plan = await accountPlan();
    const { world, state } = withToken(plan);
    const store = new MemoryStore({
      ...state,
      journal: { r2Token: { name: r2TokenName(plan), createStartedAt: "2026-10-28T11:00:00Z" } },
    });
    const lines: string[] = [];
    const slept: number[] = [];
    const base = { ...options(store, world, lines, slept), workerExists: () => false };
    expect(removeInstallationToken(base)).toBe(1);
    expect(slept).toEqual([TOKEN_SETTLE_MS]);
    expect(world.tokens.size).toBe(0);
    // A recorded token already gone: no wait, and said so.
    store.state = state;
    expect(removeInstallationToken(base)).toBe(0);
    expect(slept).toEqual([TOKEN_SETTLE_MS]);
    expect(lines.at(-1)).toBe(`the R2 token ${r2TokenName(plan)} was already gone`);
  });

  it("keeps the record when Cloudflare refuses, so that a later run can delete it", async () => {
    const { world, state } = withToken(await accountPlan());
    world.tokensForbidden = true;
    const store = new MemoryStore(state);
    expect(() =>
      removeInstallationToken({ ...options(store, world, []), workerExists: () => false }),
    ).toThrow(/403/);
    expect(store.state.journal.r2Token).toEqual(state.journal.r2Token);
  });
});

describe("stagingTokenDeployment: which tokens are a staging installation's", () => {
  it("reads the deployment from the name, only for the staging account's buckets", async () => {
    const plan = await stagingS3();
    const token = { ...tokenFor(plan), id: "t", ipLimited: false };
    expect(stagingTokenDeployment(token, ACCOUNT)).toBe("cfo-stg-wp24-platform");
    expect(stagingTokenDeployment(token, "2".repeat(32))).toBeUndefined();
    const elsewhere = {
      ...token,
      policies: [{ permissionGroups: [], resources: { "com.cloudflare.api.account.x": "*" } }],
    };
    expect(stagingTokenDeployment(elsewhere, ACCOUNT)).toBeUndefined();
    expect(stagingTokenDeployment({ ...token, policies: [] }, ACCOUNT)).toBeUndefined();
    for (const name of [
      `cloudflare-omnigent-r2--${INSTALLATION}`,
      "cfo-stg-wp24-platform-r2--ins_short",
      `cfo-stg-wp24-platform-r2--${INSTALLATION}x`,
      `cfo-stg-wp24-platform-r2--${INSTALLATION.replace("b", "u")}`,
      `my cfo-stg-wp24-platform-r2--${INSTALLATION}`,
    ]) {
      expect(stagingTokenDeployment({ ...token, name }, ACCOUNT)).toBeUndefined();
    }
  });
});

describe("removeStagingTokens: the staging tool's teardown and sweep", () => {
  async function staging(registry: string[] = []) {
    const plan = await stagingS3();
    const world = new FakeWorld(plan);
    const mine = world.addToken(tokenFor(plan));
    const other = await stagingS3({
      installationId: "ins_00000000000000000000000000",
      platformWorker: "cfo-stg-wp99-platform",
      webWorker: "cfo-stg-wp99-web",
      target: {
        kind: "staging",
        owner: "WP9.9",
        platformSuffix: "wp99-platform",
        webSuffix: "wp99-web",
        days: 1,
      },
    });
    const live = world.addToken(tokenFor(other));
    const account = world.addToken(tokenFor(await accountPlan()));
    const lines: string[] = [];
    const statePath = join(dir, "installations", "cfo-stg-wp24-platform.json");
    fileStateStore(statePath).save({
      stateVersion: 1,
      installation: plan,
      journal: { r2Token: { name: r2TokenName(plan), id: mine } },
    });
    const options = {
      accountId: ACCOUNT,
      api: world.tokenApi(),
      lock: (worker: string) => acquireLock(workerLockPath(ACCOUNT, worker), 0, "test"),
      apply: true,
      log: (line: string) => lines.push(line),
      statePath: (worker: string) => join(dir, "installations", `${worker}.json`),
    };
    const gone = (d: string) => !registry.includes(d);
    return { plan, world, mine, live, account, lines, statePath, options, gone };
  }

  it("deletes the token of each removed deployment, by name, and forgets its record", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const result = removeStagingTokens(s.gone, s.options);
    expect(result).toEqual({ found: [r2TokenName(s.plan)], deleted: 1, problems: [] });
    expect([...s.world.tokens.keys()].sort()).toEqual([s.live, s.account].sort());
    expect(fileStateStore(s.statePath).load().journal.r2Token).toBeUndefined();
    expect(s.lines).toEqual([`cfo-stg-wp24-platform: deleted the R2 token ${r2TokenName(s.plan)}`]);
  });

  it("only reports without --yes", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const result = removeStagingTokens(s.gone, { ...s.options, apply: false });
    expect(result).toEqual({ found: [r2TokenName(s.plan)], deleted: 0, problems: [] });
    expect(s.world.tokens.size).toBe(3);
    expect(s.lines).toEqual([
      `cfo-stg-wp24-platform: the R2 token ${r2TokenName(s.plan)} outlived its staging installation; sweep --yes deletes it`,
    ]);
  });

  it("finds a token whatever state file the bootstrap used, or none (Codex r1-4)", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    rmSync(s.statePath);
    const { statePath: _custom, ...byDefault } = s.options;
    expect(removeStagingTokens(s.gone, byDefault).deleted).toBe(1);
    expect(s.world.tokens.has(s.mine)).toBe(false);
  });

  it("keeps a token whose installation a bootstrap run holds, and says so", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const release = acquireLock(workerLockPath(ACCOUNT, "cfo-stg-wp24-platform"), 0, "a run");
    try {
      const result = removeStagingTokens(s.gone, s.options);
      expect(result.deleted).toBe(0);
      expect(result.problems).toEqual([
        "cfo-stg-wp24-platform: a bootstrap run holds this installation; its R2 token was kept",
      ]);
      expect(s.world.tokens.has(s.mine)).toBe(true);
    } finally {
      release();
    }
    // The next sweep finishes it (Codex r1-3).
    expect(removeStagingTokens(s.gone, s.options).deleted).toBe(1);
  });

  it("checks again under the lock: a deployment that came back keeps its token", async () => {
    const s = await staging();
    let calls = 0;
    const gone = (d: string) => d === "cfo-stg-wp24-platform" && calls++ === 0;
    expect(removeStagingTokens(gone, s.options)).toEqual({
      found: [r2TokenName(s.plan)],
      deleted: 0,
      problems: [],
    });
    expect(s.world.tokens.has(s.mine)).toBe(true);
  });

  it("lists again under the locks, and keeps a newer request's record until it settles (Codex r2-2)", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const api = s.world.tokenApi();
    let lists = 0;
    // Between the first listing and the locks, a bootstrap run deleted the token and sent a
    // create that has not been answered.
    const racing = {
      ...api,
      list: () => {
        const listed = api.list();
        if (++lists === 1) {
          s.world.tokens.delete(s.mine);
          fileStateStore(s.statePath).save({
            stateVersion: 1,
            installation: s.plan,
            journal: {
              r2Token: { name: r2TokenName(s.plan), createStartedAt: "2026-10-28T12:00:00Z" },
            },
          });
        }
        return listed;
      },
    };
    const result = removeStagingTokens(s.gone, { ...s.options, api: racing });
    expect(result).toEqual({ found: [r2TokenName(s.plan)], deleted: 0, problems: [] });
    expect(lists).toBe(2);
    expect(fileStateStore(s.statePath).load().journal.r2Token?.createStartedAt).toBe(
      "2026-10-28T12:00:00Z",
    );
    // A token made meanwhile under the name is deleted too, from the fresh listing.
    const t = await staging(["cfo-stg-wp99-platform"]);
    let first = true;
    const making = {
      ...t.world.tokenApi(),
      list: () => {
        const listed = t.world.tokenApi().list();
        if (first) {
          first = false;
          t.world.addToken(tokenFor(t.plan));
        }
        return listed;
      },
    };
    expect(removeStagingTokens(t.gone, { ...t.options, api: making }).deleted).toBe(2);
    expect([...t.world.tokens.keys()].sort()).toEqual([t.live, t.account].sort());
  });

  it("forgets only a settled record of that installation, in that account, whose token is gone", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    // A roll in flight stays recorded.
    const store = fileStateStore(s.statePath);
    store.save({
      stateVersion: 1,
      installation: s.plan,
      journal: {
        r2Token: { name: r2TokenName(s.plan), id: s.mine, rollStartedAt: "2026-10-28T12:00:00Z" },
      },
    });
    expect(removeStagingTokens(s.gone, s.options).deleted).toBe(1);
    expect(store.load().journal.r2Token?.rollStartedAt).toBeDefined();
    // A record of a token Cloudflare still lists (not this deployment's by name) stays.
    const u = await staging(["cfo-stg-wp99-platform"]);
    fileStateStore(u.statePath).save({
      stateVersion: 1,
      installation: u.plan,
      journal: { r2Token: { name: r2TokenName(u.plan), id: u.live } },
    });
    expect(removeStagingTokens(u.gone, u.options).deleted).toBe(1);
    expect(fileStateStore(u.statePath).load().journal.r2Token?.id).toBe(u.live);
    // Another account's plan under the same name stays.
    const v = await staging(["cfo-stg-wp99-platform"]);
    const elsewhere = { ...v.plan, accountId: "2".repeat(32) };
    fileStateStore(v.statePath).save({
      stateVersion: 1,
      installation: elsewhere,
      journal: { r2Token: { name: r2TokenName(v.plan), id: v.mine } },
    });
    expect(removeStagingTokens(v.gone, v.options).deleted).toBe(1);
    expect(fileStateStore(v.statePath).load().journal.r2Token?.id).toBe(v.mine);
  });

  it("reports a failed delete as a problem, and keeps the record", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const api = s.world.tokenApi();
    const failing = {
      ...api,
      remove: () => {
        throw new Error("cf user tokens delete failed: [10000] boom");
      },
    };
    const result = removeStagingTokens(s.gone, { ...s.options, api: failing });
    expect(result.problems).toEqual([
      "cfo-stg-wp24-platform: cf user tokens delete failed: [10000] boom",
    ]);
    expect(fileStateStore(s.statePath).load().journal.r2Token?.id).toBe(s.mine);
  });

  it("leaves a state file that is not that staging installation's alone", async () => {
    const s = await staging(["cfo-stg-wp99-platform"]);
    const foreign = await accountPlan();
    fileStateStore(s.statePath).save({
      stateVersion: 1,
      installation: foreign,
      journal: { r2Token: { name: r2TokenName(foreign) } },
    });
    expect(removeStagingTokens(s.gone, s.options).deleted).toBe(1);
    expect(fileStateStore(s.statePath).load().journal.r2Token).toEqual({
      name: r2TokenName(foreign),
    });
    // A staging state file without a record is left as it is.
    const plan = await stagingS3();
    fileStateStore(s.statePath).save({ stateVersion: 1, installation: plan, journal: {} });
    s.world.addToken(tokenFor(plan));
    expect(removeStagingTokens(s.gone, s.options).deleted).toBe(1);
    expect(fileStateStore(s.statePath).load().journal).toEqual({});
  });
});

describe("withInstallationLocks", () => {
  it("releases the locks after use, and after a failure", async () => {
    const store = new MemoryStore(withToken(await accountPlan()).state);
    expect(withInstallationLocks(store, "test", () => 7)).toBe(7);
    expect(() =>
      withInstallationLocks(store, "test", () => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(withInstallationLocks(store, "test", () => 8)).toBe(8);
  });
});
