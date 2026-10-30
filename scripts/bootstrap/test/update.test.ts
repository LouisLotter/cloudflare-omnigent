// `bootstrap.ts update` (WP3.35) against the fake Cloudflare: a finished installation, made by the
// bootstrap itself, moved to new code; its names, secrets and variables kept; a missing secret
// added once; the refusals; a crash at every journal write and call; and the wait and check.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KEY_SERVICE_SECRETS } from "../../../worker/src/internal/key-service.ts";
import { GITHUB_APP_SECRETS } from "../github-app.ts";
import {
  BootstrapRefusal,
  type BootstrapState,
  generatedSecrets,
  type RunOptions,
  runBootstrap,
  type StateStore,
  type WorkerIdentity,
} from "../machine.ts";
import {
  bucketTagOf,
  COOKIE_SECRET,
  CREDENTIAL_STORE_SECRETS,
  credentialStoreToAdd,
  DEPLOY_ID_VAR,
  INITIALIZED_SECRET,
  type Installation,
  KEY_SERVICE_KEY_ID_SECRET,
  KEY_SERVICE_KEY_SECRET,
  LAUNCHER_KEY_ID_SECRET,
  LAUNCHER_KEY_SECRET,
  MCP_STATE_SECRET,
  PASSWORD_SECRET,
  RECORD_KEYS_SECRET,
  REPLICA_KEY_ID_SECRET,
} from "../settings.ts";
import { fileStateStore, parseState } from "../state.ts";
import {
  requiredAfterRelease,
  runUpdate,
  secretsToEnsure,
  serving,
  shortCode,
  type UpdateContext,
  type UpdateOptions,
  type UpdateOutcome,
} from "../update.ts";
import {
  CHECK_MS,
  Crash,
  type CrashPoint,
  FakeWorld,
  MemoryStore,
  REPLACE_MS,
  SWITCH_MS,
  WINDOW_SECRETS,
} from "./fake-cloud.ts";
import {
  accountPlan,
  baseConfigs,
  freshState,
  INSTALLATION,
  OWNER_EMAIL,
  OWNER_PASSWORD,
  stagingPlan,
} from "./fixtures.ts";

const BASE = baseConfigs();
const REPLICA_KEY_ID = "cfo-canary-replica-key-id";
const REPLICA_SECRET = "cfo-canary-replica-secret-key";
const CODE_A = "a".repeat(40);
const CODE_B = "b".repeat(40);
const RUN: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};
const OPTIONS: UpdateOptions = {
  verify: true,
  pollMs: 30_000,
  switchMs: 330_000,
  verifyWaitMs: 15 * 60_000,
};
/** Secrets a later step set (github-app, by hand): the update must keep each, with its value. */
const LATER_SECRETS: Readonly<Record<string, string>> = {
  [GITHUB_APP_SECRETS.appId]: "123456",
  [GITHUB_APP_SECRETS.clientId]: "Iv23liCanaryClient00",
  [GITHUB_APP_SECRETS.clientSecret]: "cfo-canary-github-client-secret",
  [KEY_SERVICE_SECRETS.currentId]: "ks-cafe0001",
  [KEY_SERVICE_SECRETS.current]: "cfo-canary-key-service-signing-key",
  [KEY_SERVICE_SECRETS.recordKeys]: "cfo-canary-key-service-record-keys",
  SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: "cfo-canary-launcher-signing-key-set-by-hand",
  SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k-20261029",
};

/** A plan made since D33: its bucket tag recorded, a version 2 state file. */
async function taggedPlan(): Promise<Installation> {
  return accountPlan({ bucketTag: bucketTagOf(INSTALLATION) });
}

function taggedState(plan: Installation): BootstrapState {
  return { stateVersion: 2, installation: plan, journal: {} };
}

interface Harness {
  readonly world: FakeWorld;
  readonly store: StateStore & { state?: BootstrapState; crash?: { nth: number } | undefined };
  readonly lines: string[];
  /** An update from code CODE_A, unless given (undefined: a checkout of unknown version). */
  update(
    ...args: [code?: string | undefined, options?: Partial<UpdateOptions>]
  ): Promise<UpdateOutcome>;
  context(code: string | undefined): UpdateContext;
}

/** Bytes that differ on every call, so that each deploy gets its own ID. */
function counter(): (n: number) => Uint8Array {
  let next = 1;
  return (n) => new Uint8Array(n).map(() => next++ % 256);
}

/** A finished installation: the bootstrap ran to its end against a fake Cloudflare. */
async function installed(
  plan: Installation,
  state: BootstrapState = freshState(plan),
  store: StateStore & { state?: BootstrapState } = new MemoryStore(state),
  access?: "api",
): Promise<Harness> {
  const world = new FakeWorld(plan);
  if (!(store instanceof MemoryStore)) store.save(state);
  const outcome = await runBootstrap(
    {
      cloud: world.cloud(),
      store,
      baseConfigs: BASE,
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: REPLICA_KEY_ID,
        replicaSecretAccessKey: REPLICA_SECRET,
      }),
      ...(access === "api" ? { accessApi: world.accessApi(), ownerEmail: OWNER_EMAIL } : {}),
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
  // A day later.
  world.now += 24 * 3600_000;
  const random = counter();
  const h: Harness = {
    world,
    store,
    lines: [],
    context: (code) => ({
      cloud: world.cloud(),
      store,
      baseConfigs: BASE,
      codeVersion: code,
      ...(access === "api" ? { accessApi: world.accessApi() } : {}),
      random,
      now: () => world.now,
      sleep: async (ms) => {
        world.now += Math.max(0, ms);
      },
      log: (line) => h.lines.push(line),
    }),
    update: (...args) =>
      runUpdate(h.context(args.length === 0 ? CODE_A : args[0]), { ...OPTIONS, ...args[1] }),
  };
  return h;
}

function platformSecrets(h: Harness): Map<string, string> {
  return new Map(h.world.secretsOf(h.world.plan.platformWorker));
}

function count(h: Harness, call: string): number {
  return h.world.calls.filter((c) => c === call).length;
}

function lastConfig(h: Harness, worker: string): Record<string, unknown> {
  return h.world.configs.get(worker)?.at(-1) as Record<string, unknown>;
}

function journalOf(h: Harness) {
  return h.store.load().journal;
}

/** The platform configuration without the update's own deploy ID and restore point (WP3.41). */
function withoutDeployId(config: Record<string, unknown>): Record<string, unknown> {
  const {
    [DEPLOY_ID_VAR]: _id,
    SERVER_ENV_CFO_RESTORE_POINT: _point,
    ...vars
  } = config.vars as Record<string, string>;
  return { ...config, vars };
}

describe("runUpdate: a finished installation moves to new code", () => {
  it.each([
    ["a fresh installation (version 2, tagged buckets)", taggedPlan, taggedState],
    ["an old one (version 1, untagged buckets)", () => accountPlan(), freshState],
    ["a staging one (version 1)", () => stagingPlan(), freshState],
  ] as const)(
    "%s: keeps its names, secrets and variables, and checks the server",
    async (_n, make, stateOf) => {
      const plan = await make();
      const h = await installed(plan, stateOf(plan));
      const before = platformSecrets(h);
      const platformBefore = lastConfig(h, plan.platformWorker);
      const webBefore = lastConfig(h, plan.webWorker);
      const versionsBefore = h.world.versions.get(plan.platformWorker)?.length ?? 0;

      expect(await h.update()).toEqual({ kind: "done" });

      // Platform first, then web, then only reads, and the acceptance: the window's secret deleted.
      const effects = h.world.calls.filter((c) => c.startsWith("deploy") || c === "updateSecrets");
      expect(effects).toEqual(["deployPlatform", "deployWeb", "updateSecrets"]);
      expect(h.world.secretChanges.at(-1)?.changes).toEqual({ [WINDOW_SECRETS.window]: null });
      // The same names and settings: the plan's, its buckets' D33 tag or none, Access's variables.
      const platform = lastConfig(h, plan.platformWorker);
      expect(withoutDeployId(platform)).toEqual(platformBefore);
      expect(platform.name).toBe(plan.platformWorker);
      expect(platform.r2_buckets).toEqual(platformBefore.r2_buckets);
      const checkpoints = (platform.r2_buckets as { bucket_name: string }[])[0]?.bucket_name;
      expect(checkpoints).toBe(
        plan.bucketTag === undefined
          ? `${plan.platformWorker}-checkpoints`
          : `${plan.platformWorker}-${plan.bucketTag}-checkpoints`,
      );
      expect((platform.vars as Record<string, string>)[DEPLOY_ID_VAR]).toMatch(/^[0-9a-f]{16}$/);
      expect(lastConfig(h, plan.webWorker)).toEqual(webBefore);
      // Every secret kept, with its value; nothing added; the release stays.
      expect(platformSecrets(h)).toEqual(before);
      // The deploy (with the window's secret), then the acceptance (without it).
      const versions = h.world.versions.get(plan.platformWorker) ?? [];
      expect(versions).toHaveLength(versionsBefore + 2);
      expect(versions.at(-2)?.secrets.get(WINDOW_SECRETS.window)).toMatch(/^rp-/);
      expect(h.world.released()).toBe(true);
      // The journal: the code, each step, the versions, the check after the restart.
      const journal = journalOf(h);
      const update = journal.update;
      expect(update).toMatchObject({
        code: CODE_A,
        platformVersionId: versions.at(-2)?.id,
        webVersionId: h.world.latest(plan.webWorker)?.id,
      });
      // The window closed, its restore point recorded where the server keeps it.
      const id = (platform.vars as Record<string, string>).SERVER_ENV_CFO_RESTORE_POINT;
      expect(id).toMatch(/^rp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/);
      expect(versions.at(-2)?.secrets.get(WINDOW_SECRETS.window)).toBe(id);
      expect(journal.window).toBeUndefined();
      expect(journal.restorePoints).toEqual([
        {
          id,
          where: `${plan.replica.url.startsWith("s3:") ? `s3://${new URL(plan.replica.url).hostname}` : "file://"}/cfo-restore-points/${id}/`,
          takenAt: expect.any(String),
          updatedTo: CODE_A,
          outcome: "accepted",
          closedAt: expect.any(String),
        },
      ]);
      expect(update?.addedSecrets).toBeUndefined();
      expect(journal).toMatchObject({ platformCode: CODE_A, webCode: CODE_A });
      expect(journal.updatedAt).toBe(update?.webDeployedAt);
      const deployedAt = Date.parse(update?.platformDeployedAt ?? "");
      expect(Date.parse(update?.verifiedAt ?? "")).toBeGreaterThanOrEqual(
        deployedAt + SWITCH_MS + REPLACE_MS,
      );
      // The installation's own records stay as they were.
      expect(journal.releasedAt).toBeDefined();
      expect(journal.verifiedAt).toBeDefined();
      expect(h.store.load().stateVersion).toBe(stateOf(plan).stateVersion);
      // What the person sees: a short line per step, and no secret.
      expect(h.lines.slice(0, 7)).toEqual([
        `updating https://${plan.hostname} to ${shortCode(CODE_A)}: ${plan.platformWorker}, then ${plan.webWorker}`,
        `first the new server takes a restore point of Omnigent's data (${id}), and Omnigent is paused (it takes no requests) until the new version is checked: about 10 to 15 minutes`,
        `deploying the platform Worker ${plan.platformWorker}: Wrangler builds and pushes the images first, the slow part`,
        `deployed the platform Worker: it kept all ${before.size} of its secrets`,
        `deploying the web Worker ${plan.webWorker} for https://${plan.hostname}`,
        "deployed the web Worker",
        "waiting for the platform objects to switch to the new version and the server to restart on it (about 5 to 10 minutes)",
      ]);
      const checked = h.lines.findIndex((l) => l.startsWith("checked: "));
      expect(h.lines[checked]).toBe(
        `checked: the server restarted on the new version, answers, and shows the owner initialized and durable; its restore point ${id} was taken at ${journal.restorePoints?.[0]?.takenAt}`,
      );
      for (const line of h.lines.slice(7, checked)) expect(line).toMatch(/^waiting: /);
      expect(h.lines[checked + 1]).toMatch(
        /^accepting the update: Omnigent will be available again/,
      );
      expect(h.lines.at(-1)).toBe(
        `accepted: Omnigent is available again. The restore point ${id} is kept (${journal.restorePoints?.[0]?.where})`,
      );
      for (const line of h.lines.slice(checked + 2, -1)) expect(line).toMatch(/^waiting: /);
      expect(h.lines.length).toBeLessThanOrEqual(14);
      const log = h.lines.join("\n");
      for (const value of before.values()) {
        if (value.length > 8) expect(log).not.toContain(value);
      }
    },
  );

  it("keeps every secret a later step set (GitHub App, key service, launcher key by hand)", async () => {
    const plan = await taggedPlan();
    const h = await installed(plan, taggedState(plan));
    await h.world.cloud().updateSecrets(plan.platformWorker, LATER_SECRETS);
    h.world.now += 3600_000;
    const before = platformSecrets(h);
    for (const [name, value] of Object.entries(LATER_SECRETS)) expect(before.get(name)).toBe(value);
    const changes = h.world.secretChanges.length;

    expect(await h.update()).toEqual({ kind: "done" });

    expect(platformSecrets(h)).toEqual(before);
    // The update changed no secret but its window's own: it deployed, adding nothing else, and
    // its acceptance deleted the window's secret.
    expect(h.world.secretChanges.slice(changes).map((c) => c.changes)).toEqual([
      { [WINDOW_SECRETS.window]: null },
    ]);
    expect(JSON.stringify(h.store.load())).not.toContain("cfo-canary-github-client-secret");
    expect(h.lines.join("\n")).not.toMatch(/cfo-canary-(github|key-service|launcher)/);
  });

  it("names each variable the deploy removes: one set by hand, or one a release no longer sets", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    for (const [worker, name] of [
      [plan.platformWorker, "SERVER_ENV_SET_BY_HAND"],
      [plan.webWorker, "OLD_SETTING"],
    ] as const) {
      const configs = h.world.configs.get(worker) ?? [];
      const last = configs.at(-1) as Record<string, unknown>;
      configs.push({ ...last, vars: { ...(last.vars as object), [name]: "x" } });
    }
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.lines).toContain(
      `the deploy removes ${plan.platformWorker}'s variable SERVER_ENV_SET_BY_HAND, which this release does not set`,
    );
    expect(h.lines).toContain(
      `the deploy removes ${plan.webWorker}'s variable OLD_SETTING, which this release does not set`,
    );
    // A Worker whose variables are all the release's: nothing named.
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(h.lines.filter((l) => l.startsWith("the deploy removes"))).toHaveLength(2);
  });

  it("adds a missing secret once, by name, and never again", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    await h.world.cloud().updateSecrets(plan.platformWorker, { [COOKIE_SECRET]: null });
    h.world.now += 3600_000;
    const before = platformSecrets(h);
    expect(before.has(COOKIE_SECRET)).toBe(false);

    expect(await h.update()).toEqual({ kind: "done" });

    const after = platformSecrets(h);
    expect(after.get(COOKIE_SECRET)).toMatch(/^[0-9a-f]{64}$/);
    for (const [name, value] of before) expect(after.get(name)).toBe(value);
    expect(journalOf(h).update?.addedSecrets).toEqual([COOKIE_SECRET]);
    expect(h.lines).toContain(
      `deploying the platform Worker ${plan.platformWorker}, adding ${COOKIE_SECRET}: Wrangler builds and pushes the images first, the slow part`,
    );
    expect(h.lines.join("\n")).not.toContain(after.get(COOKIE_SECRET));
    expect(JSON.stringify(h.store.load())).not.toContain(after.get(COOKIE_SECRET));
    // Run again, and once more with new code: the secret is there, nothing is added or replaced.
    expect(await h.update()).toEqual({ kind: "current" });
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(platformSecrets(h).get(COOKIE_SECRET)).toBe(after.get(COOKIE_SECRET));
    expect(journalOf(h).update?.addedSecrets).toBeUndefined();
  });

  it("deploys nothing for the code it already runs, and updates again for newer code", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect(await h.update()).toEqual({ kind: "done" });
    const deploys = count(h, "deployPlatform");
    const lines = h.lines.length;
    expect(await h.update()).toEqual({ kind: "current" });
    expect(count(h, "deployPlatform")).toBe(deploys);
    expect(count(h, "deployWeb")).toBe(1);
    expect(h.lines.slice(lines)).toEqual([
      `https://${plan.hostname} already runs this checkout's version (${shortCode(CODE_A)})`,
    ]);
    const firstId = (lastConfig(h, plan.platformWorker).vars as Record<string, string>)[
      DEPLOY_ID_VAR
    ];
    h.world.now += 3600_000;
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(deploys + 1);
    expect(journalOf(h)).toMatchObject({ platformCode: CODE_B, webCode: CODE_B });
    expect(journalOf(h).update?.code).toBe(CODE_B);
    // Each update's deploy has an ID of its own: the server restarts once per update.
    expect(
      (lastConfig(h, plan.platformWorker).vars as Record<string, string>)[DEPLOY_ID_VAR],
    ).not.toBe(firstId);
  });

  it("reads Access in the installer's account by the recorded application, creating nothing", async () => {
    const plan = await accountPlan();
    const h = await installed(plan, freshState(plan), new MemoryStore(freshState(plan)), "api");
    const apps = [...h.world.accessApps.keys()];
    const recorded = journalOf(h).accessApp;
    expect(recorded?.id).toBe(apps[0]);
    const webBefore = lastConfig(h, plan.webWorker);
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "accessCreate")).toBe(0);
    expect(count(h, "accessGet")).toBe(1);
    expect([...h.world.accessApps.keys()]).toEqual(apps);
    expect(lastConfig(h, plan.webWorker)).toEqual(webBefore);
    expect(journalOf(h).accessApp).toEqual(recorded);
  });

  it("creates the Access application again only when it is gone, with the owner's address", async () => {
    const plan = await accountPlan();
    const h = await installed(plan, freshState(plan), new MemoryStore(freshState(plan)), "api");
    h.world.accessApps.clear();
    // Without the address it stops before the web deploy; the platform deploy is recorded.
    await expect(h.update()).rejects.toThrow(/run again with --owner-email/);
    expect(count(h, "deployWeb")).toBe(0);
    expect(journalOf(h).update?.platformDeployedAt).toBeDefined();
    const deploys = count(h, "deployPlatform");
    const ctx = { ...h.context(CODE_A), ownerEmail: OWNER_EMAIL };
    expect(await runUpdate(ctx, OPTIONS)).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(deploys);
    expect(count(h, "accessCreate")).toBe(1);
    const app = [...h.world.accessApps.values()][0];
    expect((lastConfig(h, plan.webWorker).vars as Record<string, string>).ACCESS_AUD).toBe(
      app?.aud,
    );
  });

  it.each([
    ["an old state file (version 1, untagged)", () => accountPlan(), 1],
    ["a version 2 one (tagged), as the owner's", taggedPlan, 2],
  ] as const)(
    "%s, from before WP3.34, reads and keeps its names; it is written as version 6",
    async (_n, make, version) => {
      const dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-update-"));
      try {
        const path = join(dir, "cloudflare-omnigent.json");
        const plan = await make();
        const store = fileStateStore(path);
        const h = await installed(plan, freshState(plan), store);
        // As a bootstrap from before WP3.34 left it: no code recorded, no password marker.
        const old = JSON.parse(readFileSync(path, "utf8"));
        const { ownerPassword: _p, platformCode: _c, webCode: _w, ...journal } = old.journal;
        writeFileSync(path, JSON.stringify({ ...old, stateVersion: version, journal }, null, 2));
        expect(store.load().stateVersion).toBe(version);
        const platformBefore = lastConfig(h, plan.platformWorker);
        expect(await h.update()).toEqual({ kind: "done" });
        const text = readFileSync(path, "utf8");
        // An older bootstrap refuses it now, rather than drop the update's records.
        expect(JSON.parse(text).stateVersion).toBe(6);
        const state = parseState(text);
        expect(state.installation).toEqual(plan);
        expect(state.journal.update).toMatchObject({ code: CODE_A });
        expect(state.journal.update?.verifiedAt).toBeDefined();
        expect(state.journal).toMatchObject({ platformCode: CODE_A, webCode: CODE_A });
        expect(state.journal.releasedAt).toBe(journal.releasedAt);
        expect(withoutDeployId(lastConfig(h, plan.platformWorker))).toEqual(platformBefore);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("runUpdate: refusals, before anything is deployed", () => {
  /** Refused twice alike, with no deploy, no secret change and no update recorded. */
  async function refused(h: Harness, why: RegExp, ...code: [] | [string | undefined]) {
    const start = h.world.calls.length;
    await expect(h.update(...code)).rejects.toThrow(BootstrapRefusal);
    await expect(h.update(...code)).rejects.toThrow(why);
    const effects = h.world.calls
      .slice(start)
      .filter((c) => c.startsWith("deploy") || c === "updateSecrets");
    expect(effects).toEqual([]);
    expect(h.store.load().journal.update).toBeUndefined();
  }

  it("an installation not finished: never released, or released and not checked", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    const { releasedAt: _r, verifiedAt: _v, ...unreleased } = journalOf(h);
    h.store.save({ ...h.store.load(), journal: unreleased });
    await refused(h, /not finished yet .*bootstrap\.ts install, or run; nothing was changed/);
    const { verifiedAt: _w, ...unchecked } = h.store.load().journal;
    h.store.save({
      ...h.store.load(),
      journal: { ...unchecked, releasedAt: new Date(h.world.now).toISOString() },
    });
    await refused(h, /release has not been checked yet: finish it with bootstrap\.ts run/);
    expect(h.world.calls).toEqual([]);
  });

  it("code of unknown version: uncommitted changes, or no commit at all", async () => {
    const h = await installed(await accountPlan());
    await refused(h, /changes that are not committed .*git pull/, undefined);
    await refused(h, /changes that are not committed/, "HEAD");
    await refused(h, /changes that are not committed/, `${CODE_A}x`);
  });

  it("a Worker that is another installation's, or gone", async () => {
    const plan = await accountPlan();
    for (const worker of [plan.platformWorker, plan.webWorker]) {
      const h = await installed(plan);
      const configs = h.world.configs.get(worker) ?? [];
      const last = configs.at(-1) as Record<string, unknown>;
      configs.push({
        ...last,
        vars: { ...(last.vars as object), CFO_INSTALLATION_ID: "ins_01aaaaaaaaaaaaaaaaaaaaaaaa" },
      });
      await refused(h, new RegExp(`the Worker named ${worker} is not this installation's`));
    }
    const gone = await installed(plan);
    gone.world.versions.delete(plan.webWorker);
    await refused(gone, /cloudflare-omnigent-web no longer exists, so there is nothing to update/);
    const platformGone = await installed(plan);
    platformGone.world.versions.delete(plan.platformWorker);
    await refused(platformGone, /cloudflare-omnigent no longer exists/);
  });

  it("a platform Worker that does not show the release", async () => {
    const plan = await accountPlan();
    const withPassword = await installed(plan);
    await withPassword.world
      .cloud()
      .updateSecrets(plan.platformWorker, { [PASSWORD_SECRET]: OWNER_PASSWORD });
    await refused(withPassword, /still holds the bootstrap password/);
    const noFlag = await installed(plan);
    await noFlag.world.cloud().updateSecrets(plan.platformWorker, { [INITIALIZED_SECRET]: null });
    await refused(noFlag, new RegExp(`holds no ${INITIALIZED_SECRET}`));
  });

  it("a secret only a person can give, named; and a plan that is not usable", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    await h.world.cloud().updateSecrets(plan.platformWorker, { [REPLICA_KEY_ID_SECRET]: null });
    await refused(h, new RegExp(`lacks ${REPLICA_KEY_ID_SECRET}, which the update cannot make`));
    // A plan that is not usable: refused as it is read, before any call.
    const bad = await installed(plan);
    const calls = bad.world.calls.length;
    (bad.store as MemoryStore).state = {
      ...bad.store.load(),
      installation: { ...plan, ownerUsername: "root" },
    };
    await expect(bad.update()).rejects.toThrow(/plan is not usable/);
    expect(bad.world.calls.length).toBe(calls);
    // And by the update itself, when a store hands it over unchecked.
    const unchecked = { load: () => (bad.store as MemoryStore).state, save: () => undefined };
    await expect(runUpdate({ ...bad.context(CODE_A), store: unchecked }, OPTIONS)).rejects.toThrow(
      BootstrapRefusal,
    );
  });

  it("half of the launcher's signing pair: never completed or replaced (Codex r1-1)", async () => {
    const plan = await accountPlan();
    for (const [held, gone] of [
      [LAUNCHER_KEY_SECRET, LAUNCHER_KEY_ID_SECRET],
      [LAUNCHER_KEY_ID_SECRET, LAUNCHER_KEY_SECRET],
    ] as const) {
      const h = await installed(plan);
      await h.world.cloud().updateSecrets(plan.platformWorker, { [gone]: null });
      const value = h.world.secretsOf(plan.platformWorker)?.get(held);
      await refused(h, new RegExp(`holds ${held} but not ${gone}, half of the launcher's`));
      expect(h.world.secretsOf(plan.platformWorker)?.get(held)).toBe(value);
    }
  });

  it("half of the key service's signing pair: never completed or replaced (WP5.10)", async () => {
    const plan = await accountPlan();
    for (const [held, gone] of [
      [KEY_SERVICE_KEY_SECRET, KEY_SERVICE_KEY_ID_SECRET],
      [KEY_SERVICE_KEY_ID_SECRET, KEY_SERVICE_KEY_SECRET],
    ] as const) {
      const h = await installed(plan);
      await h.world.cloud().updateSecrets(plan.platformWorker, { [gone]: null });
      const value = h.world.secretsOf(plan.platformWorker)?.get(held);
      await refused(h, new RegExp(`holds ${held} but not ${gone}, half of the key service's`));
      expect(h.world.secretsOf(plan.platformWorker)?.get(held)).toBe(value);
    }
  });

  it("an installation from before WP5.10 gets the credential store's keys, once", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    await h.world
      .cloud()
      .updateSecrets(
        plan.platformWorker,
        Object.fromEntries(CREDENTIAL_STORE_SECRETS.map((name) => [name, null])),
      );
    h.world.now += 3600_000;
    expect(await h.update()).toEqual({ kind: "done" });
    const after = platformSecrets(h);
    expect(after.get(KEY_SERVICE_KEY_SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(after.get(MCP_STATE_SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(after.get(RECORD_KEYS_SECRET) ?? "")).toMatchObject({
      keyId: `${plan.installationId}.records`,
    });
    expect(journalOf(h).update?.addedSecrets).toEqual([...CREDENTIAL_STORE_SECRETS].sort());
    for (const name of CREDENTIAL_STORE_SECRETS) {
      const value = after.get(name) ?? "";
      expect(h.lines.join("\n")).not.toContain(value);
      expect(JSON.stringify(h.store.load())).not.toContain(value);
    }
    // Kept from then on: a later update replaces none of them.
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    for (const name of CREDENTIAL_STORE_SECRETS) {
      expect(platformSecrets(h).get(name)).toBe(after.get(name));
    }
  });

  it("a release the server would not start with", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    // A secret the platform would not forward: the check sees what the server would receive.
    await h.world.cloud().updateSecrets(plan.platformWorker, { "SERVER_ENV_BAD-NAME": "x" });
    await refused(h, /the server would not start: SERVER_ENV_BAD-NAME would not reach the server/);
  });

  it("an error reading Access is passed on as it is, after the platform deploy", async () => {
    const plan = await accountPlan();
    const h = await installed(plan, freshState(plan), new MemoryStore(freshState(plan)), "api");
    h.world.crash = { call: "accessOrg", nth: 1, when: "before" };
    await expect(h.update()).rejects.toThrow(Crash);
    expect(count(h, "deployWeb")).toBe(0);
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(1);
  });

  it("Access that is not ready stops the web deploy", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.access = () => ({ teamDomain: "team.example.test", aud: "a".repeat(64) });
    await expect(h.update()).rejects.toThrow(/Access is not ready: the team domain/);
    expect(count(h, "deployWeb")).toBe(0);
  });
});

describe("runUpdate: the deploy keeps secrets, or the update stops", () => {
  it("stops, naming them, when a deploy loses secrets the Worker held", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.dropOnDeploy = [REPLICA_KEY_ID_SECRET];
    await expect(h.update()).rejects.toThrow(
      new RegExp(`no longer holds ${REPLICA_KEY_ID_SECRET}, which it held before`),
    );
    expect(count(h, "deployWeb")).toBe(0);
    expect(journalOf(h).update?.platformDeployedAt).toBeUndefined();
  });

  it("says to run again when a secret it added did not arrive", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    await h.world.cloud().updateSecrets(plan.platformWorker, { [COOKIE_SECRET]: null });
    h.world.dropOnDeploy = [COOKIE_SECRET];
    await expect(h.update()).rejects.toThrow(/lacks .*COOKIE_SECRET; run update again/);
    h.world.dropOnDeploy = [];
    expect(await h.update()).toEqual({ kind: "done" });
    expect(platformSecrets(h).has(COOKIE_SECRET)).toBe(true);
  });

  it("says to run again when the platform Worker is gone after its deploy", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.before = {
      call: "secretNames",
      nth: 2,
      run: () => h.world.versions.delete(plan.platformWorker),
    };
    await expect(h.update()).rejects.toThrow(/does not exist; run update again/);
  });
});

describe("runUpdate: the wait for the switch and the check", () => {
  it("is not checked while the server has not restarted on the new version; a later run checks", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.appliesReleases = false;
    const outcome = await h.update();
    expect(outcome).toEqual({
      kind: "deployed",
      why: expect.stringMatching(/^released, not yet applied/),
      window: "open",
    });
    expect(journalOf(h).update?.verifiedAt).toBeUndefined();
    // The watchdog replaces the server after all: the next run only checks.
    h.world.appliesReleases = true;
    const deploys = h.world.calls.filter((c) => c.startsWith("deploy")).length;
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.world.calls.filter((c) => c.startsWith("deploy")).length).toBe(deploys);
    expect(h.lines).toContain(
      `continuing the update of https://${plan.hostname} to ${shortCode(CODE_A)}`,
    );
  });

  it("is not checked while the restarted server shows no durable owner", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    const from = h.world.now;
    h.world.truth = (t) =>
      t < from + 40 * 60_000
        ? { initialized: false, reason: "not_replicated" }
        : { initialized: true, reason: "durable" };
    const outcome = await h.update();
    expect(outcome).toEqual({
      kind: "deployed",
      why: expect.stringMatching(
        /does not show a durable owner yet: the owner exists but its record/,
      ),
      window: "open",
    });
    h.world.now = from + 45 * 60_000;
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(1);
  });

  it("sends a deploy again, with an ID of its own, when its confirmation was lost", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.crash = { call: "activeVersion", nth: 1, when: "before" };
    await expect(h.update()).rejects.toThrow(Crash);
    const ids = () =>
      (h.world.configs.get(plan.platformWorker) ?? []).map(
        (c) => (c.vars as Record<string, string>)[DEPLOY_ID_VAR],
      );
    // The deploy landed; its confirmation did not: the next run deploys again, with a new ID,
    // so that its own restart is what the check finds.
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(2);
    const [first, second] = ids().slice(-2);
    expect(first).not.toBe(second);
    expect(journalOf(h).update?.deployId).toBe(second);
  });

  it("asks which version serves when Cloudflare did not say right after the deploy", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.before = {
      call: "activeVersion",
      nth: 1,
      run: () => {
        h.world.noVersions = true;
        // Cloudflare names it again by the check's first look (the fourth identity read).
        h.world.before = {
          call: "workerInstallation",
          nth: 4,
          run: () => {
            h.world.noVersions = false;
          },
        };
      },
    };
    expect(await h.update()).toEqual({ kind: "done" });
    expect(journalOf(h).update?.platformVersionId).toBe(
      h.world.versions.get(plan.platformWorker)?.at(-2)?.id,
    );
    expect(journalOf(h).update?.webVersionId).toBeUndefined();
  });

  it("never checks a version Cloudflare never names", async () => {
    const plan = await accountPlan();
    const noVersion = await installed(plan);
    // Named before the update (its window records what to go back to), then never again.
    noVersion.world.before = {
      call: "deployPlatform",
      nth: 1,
      run: () => {
        noVersion.world.noVersions = true;
      },
    };
    const outcome = await noVersion.update();
    // Nothing is decided without knowing which version serves (Codex r2-2): never checked.
    expect(outcome).toEqual({
      kind: "deployed",
      why: "Cloudflare does not say yet which version serves the platform Worker",
      window: "open",
    });
    expect(journalOf(noVersion).update?.verifiedAt).toBeUndefined();
    expect(count(noVersion, "logs")).toBe(0);
  });

  it("refuses to start when Cloudflare names no version to go back to (WP3.41)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.noVersions = true;
    await expect(h.update()).rejects.toThrow(
      /does not name one version serving all of .*'s traffic .*nothing was changed/,
    );
    expect(count(h, "deployPlatform")).toBe(0);
    expect(journalOf(h).window).toBeUndefined();
  });

  it("can skip the check, and check on the next run without deploying again", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect(await h.update(CODE_A, { verify: false })).toEqual({
      kind: "deployed",
      why: "the check after the update was skipped",
      window: "open",
    });
    expect(count(h, "logs")).toBe(0);
    h.world.now += 20 * 60_000;
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(1);
    expect(count(h, "deployWeb")).toBe(1);
  });

  it("an unchecked update replaced in the journal by an unfinished one is deployed and checked again (Codex r1-2)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect((await h.update(CODE_A, { verify: false })).kind).toBe("deployed");
    h.world.crash = { call: "deployPlatform", nth: 2, when: "before" };
    await expect(h.update(CODE_B)).rejects.toThrow(Crash);
    expect(journalOf(h)).toMatchObject({ platformCode: CODE_A, webCode: CODE_A });
    expect(journalOf(h).update?.code).toBe(CODE_B);
    // Back on A's checkout: A was never checked, so it is not "up to date".
    expect(await h.update(CODE_A)).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(3);
    expect(journalOf(h).update).toMatchObject({ code: CODE_A, verifiedAt: expect.any(String) });
    expect(await h.update(CODE_A)).toEqual({ kind: "current" });
  });

  it("deploys again when a secrets change made a newer version before the check (Codex r1-3, r2-3)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect((await h.update(CODE_A, { verify: false })).kind).toBe("deployed");
    const deployed = journalOf(h).update?.platformVersionId;
    // As github-app does, before the objects switch: one secrets change, a newer version.
    await h.world.cloud().updateSecrets(plan.platformWorker, LATER_SECRETS);
    expect(h.world.latest(plan.platformWorker)?.id).not.toBe(deployed);
    expect(await h.update()).toEqual({ kind: "done" });
    expect(h.lines).toContain(
      "a newer version of the platform Worker serves since this update's deploy (a secrets change or another deploy): deploying the update again, so that its own restart can be checked",
    );
    expect(count(h, "deployPlatform")).toBe(2);
    expect(journalOf(h).update?.platformVersionId).toBe(
      h.world.versions.get(plan.platformWorker)?.at(-2)?.id,
    );
    for (const [name, value] of Object.entries(LATER_SECRETS)) {
      expect(h.world.secretsOf(plan.platformWorker)?.get(name)).toBe(value);
    }
  });

  it("a secret written again unchanged an hour later never strands the check (Codex r2-3)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect((await h.update(CODE_A, { verify: false })).kind).toBe("deployed");
    h.world.now += 3600_000;
    const cookie = h.world.secretsOf(plan.platformWorker)?.get(COOKIE_SECRET) as string;
    // The same value: a newer version whose server configuration is unchanged.
    await h.world.cloud().updateSecrets(plan.platformWorker, { [COOKIE_SECRET]: cookie });
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(2);
    expect(h.world.secretsOf(plan.platformWorker)?.get(COOKIE_SECRET)).toBe(cookie);
  });

  it("deploys again when another deploy replaced the update's version before its check (Codex r1-3)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    expect((await h.update(CODE_A, { verify: false })).kind).toBe("deployed");
    // Someone deploys the platform Worker again, with another configuration.
    const last = lastConfig(h, plan.platformWorker);
    await h.world
      .cloud()
      .deployPlatform(
        plan,
        { ...last, vars: { ...(last.vars as object), [DEPLOY_ID_VAR]: "ffffffffffffffff" } },
        {},
      );
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(3);
    expect(count(h, "deployWeb")).toBe(1);
  });

  it("a newer version during the wait: not checked, and the next run deploys again (Codex r2-1)", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    // A secrets change lands between the deploys and the check's first look.
    h.world.before = {
      call: "workerInstallation",
      nth: 4,
      run: () => void h.world.cloud().updateSecrets(plan.platformWorker, LATER_SECRETS),
    };
    const outcome = await h.update();
    expect(outcome).toEqual({
      kind: "deployed",
      why: "a newer version of the platform Worker serves since this update's deploy (a secrets change or another deploy); run update again, and it deploys the update again",
      window: "open",
    });
    expect(journalOf(h).update?.platformDeployedAt).toBeUndefined();
    expect(journalOf(h).update?.verifiedAt).toBeUndefined();
    expect(count(h, "logs")).toBe(0);
    expect(await h.update()).toEqual({ kind: "done" });
    expect(count(h, "deployPlatform")).toBe(2);
  });

  it("an unfinished update to other code is replaced by the update to this code", async () => {
    const plan = await accountPlan();
    const h = await installed(plan);
    h.world.crash = { call: "deployWeb", nth: 1, when: "before" };
    await expect(h.update(CODE_A)).rejects.toThrow(Crash);
    expect(journalOf(h).update).toMatchObject({ code: CODE_A });
    expect(await h.update(CODE_B)).toEqual({ kind: "done" });
    expect(journalOf(h).update?.code).toBe(CODE_B);
    expect(journalOf(h)).toMatchObject({ platformCode: CODE_B, webCode: CODE_B });
    expect(count(h, "deployPlatform")).toBe(2);
  });
});

// Every call an update makes, each occurrence, before and after its effect, and every journal
// write: one update calls secretNames twice (before and after the platform deploy),
// workerInstallation at least four times (each Worker, the web Worker again before its deploy,
// and the platform Worker at each look of the check), activeVersion twice (after each deploy),
// and reads Workers Logs at least three times.
const CALLS: readonly (readonly [string, number])[] = [
  ["secretNames", 2],
  ["workerInstallation", 4],
  ["deployPlatform", 1],
  ["activeVersion", 2],
  ["access", 1],
  ["deployWeb", 1],
  ["logs", 3],
];
/** The journal writes of one update: its start, each deploy's start and end, Access, its check. */
const JOURNAL_WRITES = 7;
const CRASH_POINTS: (CrashPoint | { journal: number })[] = [
  ...CALLS.flatMap(([call, times]) =>
    Array.from({ length: times }, (_, i) => i + 1).flatMap((nth) =>
      (["before", "after"] as const).map((when) => ({ call, nth, when })),
    ),
  ),
  ...Array.from({ length: JOURNAL_WRITES }, (_, i) => ({ journal: i + 1 })),
];

describe("runUpdate: a crash at any point", () => {
  it.each(CRASH_POINTS.map((p) => [JSON.stringify(p), p] as const))(
    "%s: a new run finishes, keeping every secret and adding the missing one once",
    async (_name, point) => {
      const plan = await taggedPlan();
      const store = new MemoryStore(taggedState(plan));
      const h = await installed(plan, taggedState(plan), store);
      await h.world.cloud().updateSecrets(plan.platformWorker, {
        ...LATER_SECRETS,
        [COOKIE_SECRET]: null,
      });
      h.world.now += 3600_000;
      const before = platformSecrets(h);
      const versionsBefore = h.world.versions.get(plan.platformWorker)?.length ?? 0;
      const saves = store.saves;
      if ("journal" in point) store.crash = { nth: saves + point.journal };
      else h.world.crash = point;
      // Runs, perhaps a little apart, until one finishes: the crash may come in any of them.
      let outcome: UpdateOutcome | undefined;
      for (let attempt = 0; attempt < 4 && outcome?.kind !== "done"; attempt++) {
        try {
          outcome = await h.update();
        } catch (error) {
          if (!(error instanceof Crash)) throw error;
        }
        h.world.now += CHECK_MS;
      }
      expect(outcome).toEqual({ kind: "done" });
      expect(h.world.crash).toBeUndefined();
      expect(store.crash).toBeUndefined();
      // Every secret kept with its value; the missing one added, and its value never replaced.
      const after = platformSecrets(h);
      for (const [name, value] of before) expect(after.get(name)).toBe(value);
      expect(after.has(COOKIE_SECRET)).toBe(true);
      const cookies = new Set(
        (h.world.versions.get(plan.platformWorker) ?? [])
          .slice(versionsBefore)
          .map((v) => v.secrets.get(COOKIE_SECRET))
          .filter((v) => v !== undefined),
      );
      expect(cookies.size).toBe(1);
      // The release stays: the password never came back.
      for (const v of h.world.versions.get(plan.platformWorker) ?? []) {
        expect(v.secrets.has(PASSWORD_SECRET)).toBe(
          v === h.world.versions.get(plan.platformWorker)?.[0],
        );
      }
      // At most one repeat of each deploy, and the names never changed.
      expect(count(h, "deployPlatform")).toBeLessThanOrEqual(2);
      expect(count(h, "deployWeb")).toBeLessThanOrEqual(2);
      for (const config of h.world.configs.get(plan.platformWorker) ?? []) {
        expect(config.name).toBe(plan.platformWorker);
        expect((config.r2_buckets as { bucket_name: string }[])[0]?.bucket_name).toBe(
          `${plan.platformWorker}-${plan.bucketTag}-checkpoints`,
        );
      }
      const journal = journalOf(h);
      expect(journal.update?.verifiedAt).toBeDefined();
      expect(journal.update?.platformVersionId).toBe(
        h.world.versions.get(plan.platformWorker)?.at(-2)?.id,
      );
      expect(journal).toMatchObject({ platformCode: CODE_A, webCode: CODE_A });
      // Accepted: the window closed, its restore point recorded once, the secret gone.
      expect(journal.window).toBeUndefined();
      expect(journal.restorePoints).toHaveLength(1);
      expect(platformSecrets(h).has(WINDOW_SECRETS.window)).toBe(false);
    },
  );
});

describe("which version serves: the update's own, another, or unknown (Codex r2-1, r2-2)", () => {
  it("decides only on one read naming the version and its variables", async () => {
    const plan = await accountPlan();
    const update = {
      code: CODE_A,
      startedAt: "2026-10-30T09:00:00.000Z",
      deployId: "0102030405060708",
      platformVersionId: "v9",
    };
    const vars = { CFO_INSTALLATION_ID: plan.installationId, [DEPLOY_ID_VAR]: "0102030405060708" };
    type Serving = Extract<WorkerIdentity, { readonly exists: true }>;
    const at = (over: Partial<Serving> = {}): Serving => ({
      exists: true,
      installationId: plan.installationId,
      versionId: "v9",
      vars,
      ...over,
    });
    expect(serving(at(), update, plan)).toBe("ours");
    expect(serving(at({ versionId: "v10" }), update, plan)).toBe("other");
    expect(serving(at({ vars: { ...vars, [DEPLOY_ID_VAR]: "ff" } }), update, plan)).toBe("other");
    const { [DEPLOY_ID_VAR]: _id, ...noId } = vars;
    expect(serving(at({ vars: noId }), update, plan)).toBe("other");
    // Not recorded right after the deploy: its deploy ID is enough.
    const { platformVersionId: _v, ...unrecorded } = update;
    expect(serving(at({ versionId: "v10" }), unrecorded, plan)).toBe("ours");
    // Unknown: nothing decided.
    expect(serving({ exists: false }, update, plan)).toBe("unknown");
    expect(serving({ exists: true, installationId: undefined }, update, plan)).toBe("unknown");
    const { versionId: _n, ...unnamed } = at();
    expect(serving(unnamed, update, plan)).toBe("unknown");
    expect(serving(at({ vars: {} }), update, plan)).toBe("unknown");
  });
});

describe("the update's secrets step", () => {
  it("makes only what is missing, a pair whole, and requires what a finished installation holds", async () => {
    const made = generatedSecrets({
      random: (n) => new Uint8Array(n).fill(1),
      now: () => Date.UTC(2026, 9, 30),
    });
    const plan = await accountPlan();
    const all = new Set([
      COOKIE_SECRET,
      LAUNCHER_KEY_SECRET,
      LAUNCHER_KEY_ID_SECRET,
      ...CREDENTIAL_STORE_SECRETS,
    ]);
    expect(secretsToEnsure(plan, all, made)).toEqual({});
    const store = credentialStoreToAdd(plan, new Set(), made);
    expect(secretsToEnsure(plan, new Set(), made)).toEqual({
      [COOKIE_SECRET]: made.cookieSecret,
      [LAUNCHER_KEY_SECRET]: made.launcherKey,
      [LAUNCHER_KEY_ID_SECRET]: "k-20261030",
      // WP5.10: an installation from before it gets the credential store's keys.
      ...store,
    });
    expect(Object.keys(store).sort()).toEqual([...CREDENTIAL_STORE_SECRETS].sort());
    // Half a pair is never completed or replaced here (runUpdate refuses it); the cookie
    // secret held is kept.
    const held = new Set(CREDENTIAL_STORE_SECRETS);
    expect(
      secretsToEnsure(plan, new Set([...held, COOKIE_SECRET, LAUNCHER_KEY_ID_SECRET]), made),
    ).toEqual({});
    expect(secretsToEnsure(plan, new Set([...held, LAUNCHER_KEY_SECRET]), made)).toEqual({
      [COOKIE_SECRET]: made.cookieSecret,
    });
    expect(requiredAfterRelease(plan)).not.toContain(PASSWORD_SECRET);
    expect(requiredAfterRelease(plan)).toContain(INITIALIZED_SECRET);
    expect(requiredAfterRelease(plan)).toContain(LAUNCHER_KEY_SECRET);
    expect(requiredAfterRelease(await stagingPlan())).not.toContain(REPLICA_KEY_ID_SECRET);
  });
});
