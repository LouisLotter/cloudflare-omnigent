import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock } from "../../staging/lock.ts";
import type { BootstrapState } from "../machine.ts";
import { r2TokenName, r2TokenResources } from "../r2-token.ts";
import {
  removeDeploymentToken,
  removeInstallationToken,
  withInstallationLocks,
} from "../remove.ts";
import type { Installation } from "../settings.ts";
import { fileStateStore, resourceLockPaths } from "../state.ts";
import { FakeWorld, MemoryStore, R2_GROUP_ID } from "./fake-cloud.ts";
import { accountPlan, stagingPlan } from "./fixtures.ts";

let dir: string;
let env: { XDG_CONFIG_HOME?: string | undefined };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-remove-"));
  // The bootstrap's locks live under XDG_CONFIG_HOME: keep them in this test's directory.
  env = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.XDG_CONFIG_HOME = dir;
});
afterEach(() => {
  if (env.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  rmSync(dir, { recursive: true, force: true });
});

/** A world holding the installation's token, and a state that records it. */
function withToken(plan: Installation) {
  const world = new FakeWorld(plan);
  const id = world.addToken({
    name: r2TokenName(plan),
    status: "active",
    policies: [
      { effect: "allow", permissionGroups: [R2_GROUP_ID], resources: r2TokenResources(plan) },
    ],
  });
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

const stagingS3 = () =>
  stagingPlan({
    replica: { url: "s3://cfo-stg-wp24-db/omnigent", endpoint: "https://canary.r2.example.test" },
    artifacts: { url: "s3://cfo-stg-wp24-artifacts" },
  });

describe("removeInstallationToken", () => {
  it("refuses while the installation's platform Worker exists, unless told to go ahead", async () => {
    const { world, id, state } = withToken(await accountPlan());
    const store = new MemoryStore(state);
    const lines: string[] = [];
    const options = {
      store,
      api: world.tokenApi(),
      workerExists: () => true,
      force: false,
      log: (line: string) => lines.push(line),
    };
    expect(() => removeInstallationToken(options)).toThrow(
      /cloudflare-omnigent still exists, and its server .* or pass --yes to cut it off now/,
    );
    expect(world.tokens.has(id)).toBe(true);
    expect(removeInstallationToken({ ...options, force: true })).toBe(1);
    expect(world.tokens.size).toBe(0);
    expect(store.state.journal.r2Token).toBeUndefined();
    // The rest of the journal stays.
    expect(store.state.journal.platformDeployedAt).toBe("2026-10-28T12:00:00.000Z");
    expect(lines).toEqual([`deleted the R2 token ${r2TokenName(state.installation)}`]);
    // Again: nothing recorded, nothing to do.
    expect(removeInstallationToken({ ...options, force: true })).toBe(0);
    expect(lines.at(-1)).toBe("no R2 token recorded for this installation: nothing to delete");
  });

  it("deletes a token whose create's answer was lost, by its name, and one already gone", async () => {
    const plan = await accountPlan();
    const { world, state } = withToken(plan);
    const store = new MemoryStore({
      ...state,
      journal: { r2Token: { name: r2TokenName(plan), createStartedAt: "2026-10-28T11:00:00Z" } },
    });
    const lines: string[] = [];
    const options = {
      store,
      api: world.tokenApi(),
      workerExists: () => false,
      force: false,
      log: (line: string) => lines.push(line),
    };
    expect(removeInstallationToken(options)).toBe(1);
    expect(world.tokens.size).toBe(0);
    store.state = state;
    expect(removeInstallationToken(options)).toBe(0);
    expect(lines.at(-1)).toBe(`the R2 token ${r2TokenName(plan)} was already gone`);
  });

  it("keeps the record when Cloudflare refuses, so that a later run can delete it", async () => {
    const { world, state } = withToken(await accountPlan());
    world.tokensForbidden = true;
    const store = new MemoryStore(state);
    expect(() =>
      removeInstallationToken({
        store,
        api: world.tokenApi(),
        workerExists: () => false,
        force: false,
        log: () => {},
      }),
    ).toThrow(/403/);
    expect(store.state.journal.r2Token).toEqual(state.journal.r2Token);
  });
});

describe("removeDeploymentToken: the staging tool's teardown", () => {
  async function saved(plan: Installation) {
    const { world, id, state } = withToken(plan);
    const path = join(dir, "installations", `${plan.platformWorker}.json`);
    fileStateStore(path).save(state);
    const lines: string[] = [];
    const options = {
      accountId: plan.accountId,
      api: () => world.tokenApi(),
      runner: () => () => ({ status: 0, stdout: "", stderr: "" }),
      log: (line: string) => lines.push(line),
      path,
    };
    return { world, id, path, lines, options };
  }

  it("deletes the token of the staging installation whose platform Worker was torn down", async () => {
    const plan = await stagingS3();
    const { world, path, lines, options } = await saved(plan);
    expect(removeDeploymentToken("cfo-stg-wp24-platform", options)).toBe(1);
    expect(world.tokens.size).toBe(0);
    expect(fileStateStore(path).load().journal.r2Token).toBeUndefined();
    expect(lines).toEqual([`cfo-stg-wp24-platform: deleted the R2 token ${r2TokenName(plan)}`]);
  });

  it("leaves any other deployment, target, account or missing state file alone", async () => {
    const plan = await stagingS3();
    const { world, options } = await saved(plan);
    expect(removeDeploymentToken("cfo-stg-wp24-web", options)).toBe(0);
    expect(
      removeDeploymentToken("cfo-stg-wp24-platform", { ...options, accountId: "2".repeat(32) }),
    ).toBe(0);
    expect(
      removeDeploymentToken("cfo-stg-wp24-platform", { ...options, path: join(dir, "none.json") }),
    ).toBe(0);
    expect(world.tokens.size).toBe(1);
    const account = await saved(await accountPlan());
    expect(removeDeploymentToken("cloudflare-omnigent", account.options)).toBe(0);
    expect(account.world.tokens.size).toBe(1);
  });

  it("waits for no bootstrap run: a busy installation is an error, and the token stays", async () => {
    const plan = await stagingS3();
    const { world, options } = await saved(plan);
    const [first] = resourceLockPaths(plan);
    const release = acquireLock(String(first), 0, "a bootstrap run");
    try {
      expect(() => removeDeploymentToken("cfo-stg-wp24-platform", options)).toThrow(/busy|held/i);
      expect(world.tokens.size).toBe(1);
    } finally {
      release();
    }
    expect(removeDeploymentToken("cfo-stg-wp24-platform", options)).toBe(1);
  });

  it("finds the bootstrap's own state file by default", async () => {
    const plan = await stagingS3();
    const { world, options } = await saved(plan);
    const { path: _path, ...byDefault } = options;
    const previous = process.env.CFO_INSTALL_DIR;
    process.env.CFO_INSTALL_DIR = join(dir, "installations");
    try {
      expect(removeDeploymentToken("cfo-stg-wp24-platform", byDefault)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CFO_INSTALL_DIR;
      else process.env.CFO_INSTALL_DIR = previous;
    }
    expect(world.tokens.size).toBe(0);
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
