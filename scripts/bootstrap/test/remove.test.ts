import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../staging/lock.ts";
import type { BootstrapState } from "../machine.ts";
import { type ApiToken, r2TokenName, r2TokenResources } from "../r2-token.ts";
import {
  installationStateFiles,
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
const AT = Date.UTC(2026, 9, 28, 12, 0, 0);
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

function tokenFor(plan: Installation, at = AT): Omit<ApiToken, "id" | "ipLimited"> {
  return {
    name: r2TokenName(plan, at),
    status: "active",
    policies: [
      { effect: "allow", permissionGroups: [R2_GROUP_ID], resources: r2TokenResources(plan) },
    ],
  };
}

/** A world holding the installation's token and an older one, and a state recording both. */
function withTokens(plan: Installation, oauth: boolean) {
  const world = new FakeWorld(plan);
  world.oauthLogin = oauth;
  const old = world.addToken(tokenFor(plan, AT - 60_000));
  const id = world.addToken(tokenFor(plan));
  const state: BootstrapState = {
    stateVersion: 1,
    installation: plan,
    journal: {
      platformDeployedAt: "2026-10-28T12:00:00.000Z",
      r2Token: { name: r2TokenName(plan, AT), id, createdAt: "2026-10-28T12:00:00.000Z" },
      r2TokensToDelete: [{ name: r2TokenName(plan, AT - 60_000), id: old }],
    },
  };
  return { world, id, old, state };
}

const stagingS3 = (overrides: Partial<Installation> = {}) =>
  stagingPlan({
    replica: { url: "s3://cfo-stg-wp24-db/omnigent", endpoint: "https://canary.r2.example.test" },
    artifacts: { url: "s3://cfo-stg-wp24-artifacts" },
    ...overrides,
  });

const DELETE_STEP =
  /^Cloudflare does not let this cf login delete API tokens, so delete .* by hand: open https:\/\/dash\.cloudflare\.com\/profile\/api-tokens, open the three-dot menu next to (it|each), and choose Delete\.$/;

describe("removeInstallationToken: bootstrap.ts remove-r2-token", () => {
  function options(store: MemoryStore, world: FakeWorld, lines: string[]) {
    return {
      store,
      api: world.tokenApi(),
      workerExists: () => true,
      force: false,
      now: () => AT + 3_600_000,
      log: (line: string) => lines.push(line),
    };
  }

  it("refuses while a Worker of that name exists, unless told to go ahead; deletes both where allowed", async () => {
    const { world, state } = withTokens(await accountPlan(), false);
    const store = new MemoryStore(state);
    const lines: string[] = [];
    const base = options(store, world, lines);
    expect(() => removeInstallationToken(base)).toThrow(
      /a Worker named cloudflare-omnigent still exists, .* or pass --yes to cut it off now/,
    );
    expect(world.tokens.size).toBe(2);
    expect(removeInstallationToken({ ...base, force: true })).toEqual({
      deleted: 2,
      left: [],
      unconfirmed: [],
    });
    expect(world.tokens.size).toBe(0);
    expect(store.state.journal.r2Token).toBeUndefined();
    expect(store.state.journal.r2TokensToDelete).toBeUndefined();
    expect(store.state.journal.platformDeployedAt).toBe("2026-10-28T12:00:00.000Z");
    expect(removeInstallationToken({ ...base, force: true })).toEqual({
      deleted: 0,
      left: [],
      unconfirmed: [],
    });
    expect(lines.at(-1)).toBe("no R2 token recorded for this installation: nothing to delete");
  });

  it("an OAuth login (403 on delete): names each token, keeps them recorded, and reports them left", async () => {
    const plan = await accountPlan();
    const { world, id, old, state } = withTokens(plan, true);
    const store = new MemoryStore(state);
    const lines: string[] = [];
    const result = removeInstallationToken({ ...options(store, world, lines), force: true });
    expect(result.deleted).toBe(0);
    expect(result.left.map((t) => t.id)).toEqual([old, id]);
    expect(world.tokens.size).toBe(2);
    // The current token stays current: a later removal still guards it (Codex r3-1).
    expect(store.state.journal.r2Token).toEqual(state.journal.r2Token);
    expect(store.state.journal.r2TokensToDelete).toEqual([result.left[0]]);
    expect(lines).toEqual([expect.stringMatching(DELETE_STEP)]);
    expect(lines[0]).toContain(
      `each of the tokens named exactly ${r2TokenName(plan, AT - 60_000)}; ${r2TokenName(plan, AT)} by hand`,
    );
    expect(() => removeInstallationToken(options(store, world, lines))).toThrow(
      /still exists, .* pass --yes/,
    );
    // Once the person deleted them by hand, the same OAuth login reads them as gone.
    world.tokens.clear();
    expect(removeInstallationToken({ ...options(store, world, lines), force: true })).toEqual({
      deleted: 2,
      left: [],
      unconfirmed: [],
    });
    expect(store.state.journal.r2Token).toBeUndefined();
    expect(store.state.journal.r2TokensToDelete).toBeUndefined();
  });

  it("names a create never answered once, if it exists, and then forgets it (OAuth)", async () => {
    const plan = await accountPlan();
    const world = new FakeWorld(plan);
    const pending = { name: r2TokenName(plan, AT), createStartedAt: "2026-10-28T12:00:00.000Z" };
    const store = new MemoryStore({
      stateVersion: 1,
      installation: plan,
      journal: { r2TokensToDelete: [pending] },
    });
    const lines: string[] = [];
    const result = removeInstallationToken({ ...options(store, world, lines), force: true });
    expect(result).toEqual({ deleted: 0, left: [], unconfirmed: [pending] });
    expect(lines[0]).toContain(`${pending.name} if it exists (its create was never answered)`);
    expect(store.state.journal.r2TokensToDelete).toBeUndefined();
  });

  it("needs no --yes for tokens no Worker uses any more, and then seeks none by name", async () => {
    const plan = await accountPlan();
    const { world, id, state } = withTokens(plan, false);
    const { r2Token: _current, ...journal } = state.journal;
    const store = new MemoryStore({ ...state, journal });
    // The Worker exists: the token of the installation's name it may use is left alone.
    expect(removeInstallationToken(options(store, world, [])).deleted).toBe(1);
    expect([...world.tokens.keys()]).toEqual([id]);
  });

  it("also deletes a token of the installation's name that a lost answer left unrecorded, where it may list", async () => {
    const plan = await accountPlan();
    const { world, state } = withTokens(plan, false);
    world.addToken(tokenFor(plan, AT + 60_000));
    world.addToken({ ...tokenFor(plan), name: "someone-else" });
    const store = new MemoryStore(state);
    expect(removeInstallationToken({ ...options(store, world, []), force: true }).deleted).toBe(3);
    expect([...world.tokens.values()].map((t) => t.token.name)).toEqual(["someone-else"]);
  });
});

describe("stagingTokenDeployment: which listed tokens are a staging installation's", () => {
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
      `cloudflare-omnigent-r2--${INSTALLATION}--20261028T120000Z`,
      `cfo-stg-wp24-platform-r2--${INSTALLATION}`,
      `cfo-stg-wp24-platform-r2--ins_short--20261028T120000Z`,
      `cfo-stg-wp24-platform-r2--${INSTALLATION.replace("b", "u")}--20261028T120000Z`,
      `my cfo-stg-wp24-platform-r2--${INSTALLATION}--20261028T120000Z`,
    ]) {
      expect(stagingTokenDeployment({ ...token, name }, ACCOUNT)).toBeUndefined();
    }
  });
});

describe("removeStagingTokens: the staging tool's teardown and sweep", () => {
  async function staging(oauth: boolean, registry: string[] = []) {
    const plan = await stagingS3();
    const { world, id, old, state } = withTokens(plan, oauth);
    const statePath = join(dir, "installations", "cfo-stg-wp24-platform.json");
    fileStateStore(statePath).save(state);
    const lines: string[] = [];
    const options = {
      accountId: ACCOUNT,
      api: world.tokenApi(),
      lock: (worker: string) => acquireLock(workerLockPath(ACCOUNT, worker), 0, "test"),
      apply: true,
      log: (line: string) => lines.push(line),
      stateFiles: () => installationStateFiles(join(dir, "installations")),
      now: () => AT + 3_600_000,
    };
    const gone = (d: string) => !registry.includes(d);
    return { plan, world, id, old, lines, statePath, options, gone };
  }

  it("a login that may: deletes the recorded tokens and any named for the deployment", async () => {
    const s = await staging(false);
    const extra = s.world.addToken(tokenFor(s.plan, AT + 120_000));
    const result = removeStagingTokens(s.gone, s.options);
    expect(result.deleted).toBe(3);
    expect(result.left).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(s.world.tokens.has(extra)).toBe(false);
    expect(fileStateStore(s.statePath).load().journal.r2TokensToDelete).toBeUndefined();
    expect(fileStateStore(s.statePath).load().journal.r2Token).toBeUndefined();
  });

  it("an OAuth login: names the tokens with the click, keeps them recorded, and says when they expire", async () => {
    const s = await staging(true);
    const store = fileStateStore(s.statePath);
    const state = store.load();
    store.save({
      ...state,
      journal: {
        ...state.journal,
        r2Token: {
          ...state.journal.r2Token,
          name: String(state.journal.r2Token?.name),
          expiresOn: "2026-10-30T12:00:00Z",
        },
      },
    });
    const result = removeStagingTokens(s.gone, s.options);
    expect(result.deleted).toBe(0);
    expect(result.left.map((t) => t.id)).toEqual([s.old, s.id]);
    expect(store.load().journal.r2TokensToDelete).toEqual([result.left[0]]);
    expect(store.load().journal.r2Token?.id).toBe(s.id);
    expect(s.lines).toEqual([
      expect.stringMatching(
        /^cfo-stg-wp24-platform: Cloudflare does not let this cf login delete API tokens/,
      ),
    ]);
    expect(s.lines[0]).toContain("(or leave it: it expires on 2026-10-30T12:00:00Z)");
  });

  it("only reports without --yes", async () => {
    const s = await staging(true);
    const result = removeStagingTokens(s.gone, { ...s.options, apply: false });
    expect(result.found).toEqual([r2TokenName(s.plan, AT - 60_000), r2TokenName(s.plan, AT)]);
    expect(result.deleted).toBe(0);
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toContain("outlived its staging installation; sweep --yes deletes it");
  });

  it("leaves a deployment the registry still holds, another account's plan and an account installation alone", async () => {
    const s = await staging(false, ["cfo-stg-wp24-platform"]);
    expect(removeStagingTokens(s.gone, s.options).found).toEqual([]);
    const t = await staging(false);
    expect(removeStagingTokens(t.gone, { ...t.options, accountId: "2".repeat(32) }).found).toEqual(
      [],
    );
    const account = await accountPlan();
    fileStateStore(join(dir, "installations", "cloudflare-omnigent.json")).save({
      stateVersion: 1,
      installation: account,
      journal: { r2Token: { name: r2TokenName(account, AT), id: "x" } },
    });
    expect(removeStagingTokens(t.gone, t.options).found).not.toContain(r2TokenName(account, AT));
  });

  it("keeps a token whose installation a bootstrap run holds, and the next sweep finishes it", async () => {
    const s = await staging(false);
    const release = acquireLock(workerLockPath(ACCOUNT, "cfo-stg-wp24-platform"), 0, "a run");
    try {
      const result = removeStagingTokens(s.gone, s.options);
      expect(result.deleted).toBe(0);
      expect(result.problems).toEqual([
        "cfo-stg-wp24-platform: a bootstrap run holds this installation; its R2 token was kept",
      ]);
    } finally {
      release();
    }
    expect(removeStagingTokens(s.gone, s.options).deleted).toBe(2);
  });

  it("checks again under the locks, and reads the records afresh (Codex r2-2)", async () => {
    const s = await staging(false);
    let calls = 0;
    const comesBack = (d: string) => d === "cfo-stg-wp24-platform" && calls++ === 0;
    expect(removeStagingTokens(comesBack, s.options).deleted).toBe(0);
    expect(s.world.tokens.size).toBe(2);
    // A run retired a token and began a create between the reading and the locks.
    const store = fileStateStore(s.statePath);
    const api = s.world.tokenApi();
    let lists = 0;
    const racing = {
      ...api,
      list: () => {
        const listed = api.list();
        if (++lists === 1) {
          store.save({
            ...store.load(),
            journal: {
              r2Token: {
                name: r2TokenName(s.plan, AT + 60_000),
                createStartedAt: "2026-10-28T12:01:00Z",
              },
              r2TokensToDelete: [{ name: r2TokenName(s.plan, AT), id: s.id }],
            },
          });
        }
        return listed;
      },
    };
    const result = removeStagingTokens(s.gone, { ...s.options, api: racing });
    expect(result.problems).toEqual([]);
    // The fresh records were used: the unanswered create was looked for by name (not found,
    // so dropped where listing is allowed), and the old token deleted.
    expect(s.world.tokens.has(s.id)).toBe(false);
    expect(store.load().journal.r2TokensToDelete).toBeUndefined();
  });

  it("finds listed tokens with no state file, and reports a broken state file", async () => {
    const s = await staging(false);
    rmSync(s.statePath);
    writeFileSync(join(dir, "installations", "broken.json"), "{");
    const result = removeStagingTokens(s.gone, s.options);
    expect(result.deleted).toBe(2);
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.stringContaining("broken.json")]),
    );
  });

  it("reports a failed delete as a problem, and keeps the records", async () => {
    const s = await staging(false);
    const failing = {
      ...s.world.tokenApi(),
      remove: () => {
        throw new Error("cf user tokens delete failed: [10000] boom");
      },
    };
    const result = removeStagingTokens(s.gone, { ...s.options, api: failing });
    expect(result.problems).toEqual([
      "cfo-stg-wp24-platform: cf user tokens delete failed: [10000] boom",
    ]);
    expect(fileStateStore(s.statePath).load().journal.r2Token?.id).toBe(s.id);
  });
});

describe("installationStateFiles and withInstallationLocks", () => {
  it("lists the JSON state files, or none", () => {
    expect(installationStateFiles(join(dir, "none"))).toEqual([]);
    mkdirSync(join(dir, "i"));
    writeFileSync(join(dir, "i", "a.json"), "{}");
    writeFileSync(join(dir, "i", "a.json.1.tmp"), "{}");
    expect(installationStateFiles(join(dir, "i"))).toEqual([join(dir, "i", "a.json")]);
  });

  it("releases the locks after use, and after a failure", async () => {
    const store = new MemoryStore(withTokens(await accountPlan(), false).state);
    expect(withInstallationLocks(store, "test", () => 7)).toBe(7);
    expect(() =>
      withInstallationLocks(store, "test", () => {
        throw new Error("inside");
      }),
    ).toThrow("inside");
    expect(withInstallationLocks(store, "test", () => 8)).toBe(8);
  });
});
