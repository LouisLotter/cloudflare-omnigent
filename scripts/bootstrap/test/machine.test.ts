import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BootstrapRefusal,
  type BootstrapState,
  type RunContext,
  type RunOptions,
  runBootstrap,
} from "../machine.ts";
import {
  COOKIE_SECRET,
  INITIALIZED_SECRET,
  type Installation,
  PASSWORD_SECRET,
  RELEASE_CHANGES,
  REPLICA_KEY_ID_SECRET,
  REPLICA_SECRET_KEY_SECRET,
} from "../settings.ts";
import {
  CHECK_MS,
  Crash,
  type CrashPoint,
  FakeWorld,
  MemoryStore,
  type ServerTruth,
  SWITCH_MS,
} from "./fake-cloud.ts";
import {
  accountPlan,
  baseConfigs,
  freshState,
  INSTALLATION,
  OWNER_PASSWORD,
  stagingPlan,
} from "./fixtures.ts";

const BASE = baseConfigs();
const REPLICA_KEY_ID = "cfo-canary-replica-key-id";
const REPLICA_SECRET = "cfo-canary-replica-secret-key";
const OPTIONS: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};

/** Not initialized, then initialized but not replicated, then durable, from the first deploy. */
function timeline(world: FakeWorld, setupMs: number, replicateMs: number): ServerTruth {
  return (t) => {
    const first = world.versions.get(world.plan.platformWorker)?.[0]?.at ?? t;
    if (t < first + setupMs) return { initialized: false, reason: "not_initialized" };
    if (t < first + setupMs + replicateMs) return { initialized: false, reason: "not_replicated" };
    return { initialized: true, reason: "durable" };
  };
}

interface Harness {
  readonly world: FakeWorld;
  readonly store: MemoryStore;
  readonly lines: string[];
  asked: number;
  run(options?: Partial<RunOptions>): ReturnType<typeof runBootstrap>;
}

function harness(plan: Installation, state: BootstrapState = freshState(plan)): Harness {
  const world = new FakeWorld(plan);
  const store = new MemoryStore(state);
  const h: Harness = {
    world,
    store,
    lines: [],
    asked: 0,
    run: (options = {}) => {
      const ctx: RunContext = {
        cloud: world.cloud(),
        store,
        baseConfigs: BASE,
        secrets: () => {
          h.asked++;
          return {
            ownerPassword: OWNER_PASSWORD,
            replicaAccessKeyId: REPLICA_KEY_ID,
            replicaSecretAccessKey: REPLICA_SECRET,
          };
        },
        random: (n) => new Uint8Array(n).fill(0xab),
        now: () => world.now,
        sleep: async (ms) => {
          world.now += Math.max(0, ms);
        },
        log: (line) => h.lines.push(line),
      };
      return runBootstrap(ctx, { ...OPTIONS, ...options });
    },
  };
  return h;
}

/** Every version of the platform Worker that holds the password, in order. */
function passwordVersions(h: Harness): number[] {
  const list = h.world.versions.get(h.world.plan.platformWorker) ?? [];
  return list.flatMap((v, i) => (v.secrets.has(PASSWORD_SECRET) ? [i] : []));
}

/** The password, once deleted, never comes back. */
function expectNeverReAdded(h: Harness): void {
  const list = h.world.versions.get(h.world.plan.platformWorker) ?? [];
  const firstWithout = list.findIndex((v, i) => i > 0 && !v.secrets.has(PASSWORD_SECRET));
  if (firstWithout >= 0) {
    expect(list.slice(firstWithout).some((v) => v.secrets.has(PASSWORD_SECRET))).toBe(false);
  }
}

describe("runBootstrap: the whole bootstrap", () => {
  it("deploys, waits for a durable owner, releases once, and checks the version switch", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.truth = timeline(h.world, 3 * 60_000, 3 * 60_000);
    expect(await h.run()).toEqual({ kind: "done" });

    // Platform first, then Access, then the web Worker; the release only after the wait.
    const order = h.world.calls.filter((c) => c !== "secretNames" && c !== "logs");
    expect(order).toEqual([
      "deployPlatform",
      "access",
      "deployWeb",
      "updateSecrets",
      "activeVersion",
    ]);
    const versions = h.world.versions.get(plan.platformWorker) ?? [];
    expect(versions).toHaveLength(2);
    const first = versions[0]?.secrets;
    expect([...(first?.keys() ?? [])].sort()).toEqual(
      [
        COOKIE_SECRET,
        INITIALIZED_SECRET,
        PASSWORD_SECRET,
        REPLICA_KEY_ID_SECRET,
        REPLICA_SECRET_KEY_SECRET,
      ].sort(),
    );
    expect(first?.get(INITIALIZED_SECRET)).toBe("false");
    expect(first?.get(PASSWORD_SECRET)).toBe(OWNER_PASSWORD);
    expect(first?.get(COOKIE_SECRET)).toMatch(/^[0-9a-f]{64}$/);
    // The release: one change, exactly the flag and the deletion, after the owner was durable.
    expect(h.world.secretChanges).toEqual([
      { at: expect.any(Number), worker: plan.platformWorker, changes: RELEASE_CHANGES },
    ]);
    const releasedAt = h.world.secretChanges[0]?.at ?? 0;
    const durableFrom = (versions[0]?.at ?? 0) + 6 * 60_000;
    expect(releasedAt).toBeGreaterThanOrEqual(durableFrom);
    const last = versions[1]?.secrets;
    expect(last?.get(INITIALIZED_SECRET)).toBe("true");
    expect(last?.has(PASSWORD_SECRET)).toBe(false);
    expect(last?.get(COOKIE_SECRET)).toBe(first?.get(COOKIE_SECRET));
    // The check after the release waited past the objects' switch.
    expect(Date.parse(h.store.state.journal.verifiedAt ?? "")).toBeGreaterThanOrEqual(
      releasedAt + SWITCH_MS,
    );
    expect(h.store.state.journal.accepted?.status).toMatchObject({
      installationId: INSTALLATION,
      initialized: true,
    });
    // No secret value in the log, and only one read of the installer's secrets.
    const log = h.lines.join("\n");
    for (const value of [
      OWNER_PASSWORD,
      REPLICA_SECRET,
      REPLICA_KEY_ID,
      first?.get(COOKIE_SECRET),
    ]) {
      expect(log).not.toContain(value);
    }
    expect(JSON.stringify(h.store.state)).not.toContain(OWNER_PASSWORD);
    expect(h.asked).toBe(1);
  });

  it("renders the installation's configurations from the checked-in ones", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    await h.run();
    const platform = h.world.configs.get(plan.platformWorker)?.[0] as Record<string, unknown>;
    expect(platform).toMatchObject({
      name: "cloudflare-omnigent",
      account_id: plan.accountId,
      main: "src/index.ts",
      workers_dev: false,
      preview_urls: false,
      vars: {
        CFO_INSTALLATION_ID: INSTALLATION,
        SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL: "https://omnigent.example.test",
        SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
        SERVER_ENV_CFO_REPLICA_URL: plan.replica.url,
        SERVER_ENV_CFO_REPLICA_ENDPOINT: plan.replica.endpoint,
      },
    });
    expect(JSON.stringify(platform)).not.toContain(OWNER_PASSWORD);
    expect(platform.containers).toEqual(BASE.platform.containers);
    expect(platform.triggers).toEqual({ crons: ["* * * * *"] });
    const web = h.world.configs.get(plan.webWorker)?.[0] as Record<string, unknown>;
    expect(web).toMatchObject({
      name: "cloudflare-omnigent-web",
      main: "src/web.ts",
      routes: [{ pattern: "omnigent.example.test", custom_domain: true }],
      durable_objects: {
        bindings: [
          { name: "OMNIGENT", class_name: "OmnigentServer", script_name: "cloudflare-omnigent" },
        ],
      },
      vars: {
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUD: "a".repeat(64),
        ALLOWED_HOSTNAMES: "omnigent.example.test",
        OWNER_EMAIL_HASH: plan.ownerPin,
      },
    });
  });

  it("keeps the password while the owner is initialized but not replicated", async () => {
    const h = harness(await accountPlan());
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    const outcome = await h.run();
    expect(outcome).toEqual({
      kind: "waiting",
      why: "the owner exists but its record is not replicated yet",
    });
    expect(h.world.secretChanges).toEqual([]);
    expect(h.world.secretsOf(h.world.plan.platformWorker)?.has(PASSWORD_SECRET)).toBe(true);
    expect(h.store.state.journal.releaseStartedAt).toBeUndefined();
    // Replication catches up later: the next run releases.
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.secretChanges).toHaveLength(1);
    expect(h.world.calls.filter((c) => c === "deployPlatform")).toHaveLength(1);
  });

  it("does not accept needs_setup: false alone (header or OIDC mode: not initialized)", async () => {
    // WP2.2's watchdog maps accounts_enabled: false to initialized: false, not_initialized.
    const h = harness(await accountPlan());
    h.world.truth = () => ({ initialized: false, reason: "not_initialized" });
    expect((await h.run({ waitMs: 10 * 60_000 })).kind).toBe("waiting");
    expect(h.world.secretChanges).toEqual([]);
  });

  it("never accepts a status from another installation", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    const other = "ins_01hs3f9q2m8z4w7k6t5r1n0yzz";
    for (let i = 0; i < 20; i++) {
      const t = h.world.now + i * CHECK_MS;
      h.world.foreign.push({
        timestamp: t + 10 * 60_000,
        $workers: {
          scriptName: plan.platformWorker,
          scriptVersion: { id: "v1" },
          entrypoint: "OmnigentServer",
        },
        source: {
          cfo: "bootstrap",
          event: "status",
          reason: "durable",
          bootstrapStatus: {
            protocolVersion: 1,
            installationId: other,
            initialized: true,
            checkedAt: new Date(t + 10 * 60_000).toISOString(),
          },
        },
      });
    }
    expect((await h.run({ waitMs: 20 * 60_000 })).kind).toBe("waiting");
    expect(h.world.secretChanges).toEqual([]);
  });

  it("repeating a finished bootstrap changes nothing", async () => {
    const h = harness(await accountPlan());
    expect(await h.run()).toEqual({ kind: "done" });
    const calls = h.world.calls.length;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.calls.slice(calls)).toEqual(["secretNames", "secretNames"]);
    expect(h.store.state.journal.releasedVersionId).toBe(
      h.world.latest(h.world.plan.platformWorker)?.id,
    );
    expect(h.world.secretChanges).toHaveLength(1);
    expect(h.asked).toBe(1);
  });

  it("asks for the installer's secrets only when they must be uploaded", async () => {
    const h = harness(await stagingPlan());
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    await h.run({ waitMs: 0 });
    expect(h.asked).toBe(1);
    await h.run({ waitMs: 0 });
    await h.run({ waitMs: 0 });
    expect(h.asked).toBe(1);
    // A file replica (staging tests) needs no replica credentials.
    const secrets = h.world.secretsOf(h.world.plan.platformWorker);
    expect(secrets?.has(REPLICA_KEY_ID_SECRET)).toBe(false);
  });

  it("checks after the release when it was skipped, and waits past the switch", async () => {
    const h = harness(await accountPlan());
    expect(await h.run({ verify: false })).toEqual({
      kind: "released",
      why: "the check after the release was skipped",
    });
    expect(h.world.released()).toBe(true);
    const updates = h.world.secretChanges.length;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.secretChanges).toHaveLength(updates);
  });

  it("reports released but unchecked when no newer version has run yet", async () => {
    const h = harness(await accountPlan());
    // Workers Logs loses every line: nothing can be accepted, so first seed a release by hand.
    expect(await h.run({ verify: false })).toMatchObject({ kind: "released" });
    h.world.lossEvery = 1;
    expect(await h.run({ verifyWaitMs: 60_000 })).toMatchObject({
      kind: "released",
      why: expect.stringContaining("has not run on the released version"),
    });
    h.world.lossEvery = 0;
    expect(await h.run()).toEqual({ kind: "done" });
  });
});

describe("runBootstrap: Codex review r1", () => {
  it("F4: refuses a web Worker of that name that this plan did not create, before any deploy", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    await h.world.cloud().deployWeb(plan, {});
    h.world.calls.length = 0;
    await expect(h.run()).rejects.toThrow(
      /cloudflare-omnigent-web exists, and this plan did not create it/,
    );
    expect(h.world.calls.filter((c) => c !== "secretNames")).toEqual([]);
    expect(h.world.versions.has(plan.platformWorker)).toBe(false);
  });

  it("F4: claims the web Worker before Access, so a crash in between resumes", async () => {
    const plan = await stagingPlan();
    const h = harness(plan);
    h.world.crash = { call: "access", nth: 1, when: "after" };
    await expect(h.run()).rejects.toThrow(Crash);
    expect(h.store.state.journal.webDeployStartedAt).toBeDefined();
    // The staging adapter's Access step may have deployed the web Worker: that is ours now.
    await h.world.cloud().deployWeb(plan, {});
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("F3: a status seen once is never rolled back by an answer that misses it", async () => {
    const plan = await accountPlan();
    const fresh = harness(plan);
    // A first run sees the server restarting between reads (not durable).
    fresh.world.truth = () => ({ initialized: false, reason: "boot_changed" });
    expect((await fresh.run({ waitMs: 3 * 60_000 })).kind).toBe("waiting");
    const remembered = fresh.store.state.journal.newestStatus;
    expect(remembered).toMatchObject({ reason: "boot_changed", status: { initialized: false } });
    // The laptop's clock moves back to just before that status, and the logs now show only the
    // older lines, durable: without the watermark they would be accepted.
    const seenAt = Date.parse(remembered?.status.checkedAt ?? "");
    fresh.world.truth = (t) =>
      t < seenAt
        ? { initialized: true, reason: "durable" }
        : { initialized: false, reason: "boot_changed" };
    fresh.world.now = seenAt - 1_000;
    const answer = fresh.world.logEvents(plan.platformWorker, 0, fresh.world.now);
    expect(
      answer.some((e) => (e as { source?: { reason?: string } }).source?.reason === "durable"),
    ).toBe(true);
    expect(await fresh.run({ waitMs: 0 })).toEqual({
      kind: "waiting",
      why: "the server restarted between the watchdog's reads",
    });
    expect(fresh.world.secretChanges).toEqual([]);
    // Once a newer durable status arrives, the bootstrap releases.
    fresh.world.now += 4 * 60_000;
    fresh.world.truth = () => ({ initialized: true, reason: "durable" });
    expect((await fresh.run()).kind).toBe("done");
  });

  it("F5: a status that grew too old during a slow query or a slow check is not released on", async () => {
    const h = harness(await accountPlan());
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    // The first answer takes eleven minutes: its statuses are stale when it arrives.
    h.world.slow = { call: "logs", nth: 1, ms: 11 * 60_000 };
    expect(await h.run({ verify: false })).toMatchObject({ kind: "released" });
    const change = h.world.secretChanges[0];
    expect(h.world.counts.get("logs")).toBeGreaterThanOrEqual(2);
    // Released on a status at most ten minutes old at the moment of the release.
    const events = h.world.logEvents(h.world.plan.platformWorker, 0, change?.at ?? 0);
    const newest = Math.max(...events.map((e) => (e as { timestamp: number }).timestamp));
    expect((change?.at ?? 0) - newest).toBeLessThanOrEqual(10 * 60_000);

    const k = harness(await accountPlan());
    k.world.truth = () => ({ initialized: true, reason: "durable" });
    // The secret listing just before the release stalls for eleven minutes: wait again.
    k.world.slow = { call: "secretNames", nth: 5, ms: 11 * 60_000 };
    expect(await k.run({ verify: false })).toMatchObject({ kind: "released" });
    expect(
      k.lines.some((l) => l.startsWith("waiting again: the newest bootstrap status is too old")),
    ).toBe(true);
  });

  it("F7: a release to a Worker that vanished fails, and creates nothing", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    const cloud = h.world.cloud();
    await expect(cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES)).rejects.toThrow(
      /10007/,
    );
    expect(h.world.versions.has(plan.platformWorker)).toBe(false);
  });
});

describe("runBootstrap: Cloudflare misbehaving", () => {
  it("stops when a deploy did not leave every secret, and the next run deploys again", async () => {
    const h = harness(await accountPlan());
    h.world.dropOnDeploy = [COOKIE_SECRET];
    await expect(h.run()).rejects.toThrow(
      `after the deploy, cloudflare-omnigent lacks ${COOKIE_SECRET}; run again`,
    );
    expect(h.store.state.journal.platformDeployedAt).toBeUndefined();
    h.world.dropOnDeploy = [];
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.calls.filter((c) => c === "deployPlatform")).toHaveLength(2);
  });

  it("stops when the platform Worker vanishes before the release", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.before = {
      call: "secretNames",
      nth: 5,
      run: () => h.world.versions.delete(plan.platformWorker),
    };
    await expect(h.run()).rejects.toThrow("cloudflare-omnigent no longer exists");
    expect(h.world.secretChanges).toEqual([]);
  });

  it("stops when a release reports success without taking effect, and sends it again next run", async () => {
    const h = harness(await accountPlan());
    h.world.bulkKeeps = true;
    await expect(h.run()).rejects.toThrow("the release has not taken effect yet; run again");
    expect(h.store.state.journal.releasedAt).toBeUndefined();
    h.world.bulkKeeps = false;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.released()).toBe(true);
  });

  it("releases without version information, and says it cannot check the switch", async () => {
    const h = harness(await accountPlan());
    h.world.noVersions = true;
    expect(await h.run({ verifyWaitMs: 60_000 })).toEqual({
      kind: "released",
      why: "Cloudflare did not say which version the release deployed",
    });
    expect(h.store.state.journal.accepted?.versionId).toBeUndefined();
    // Once Cloudflare names the version, a later run checks the switch.
    h.world.noVersions = false;
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("reports bootstrap lines it ignores, and never accepts them", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    h.world.foreign.push({
      timestamp: h.world.now + 120_000,
      $workers: { scriptName: plan.platformWorker },
      source: { cfo: "bootstrap", event: "status", reason: "durable", bootstrapStatus: {} },
    });
    expect((await h.run({ waitMs: 5 * 60_000 })).kind).toBe("waiting");
    expect(h.lines.some((l) => l.includes("1 bootstrap lines ignored: not the watchdog's"))).toBe(
      true,
    );
  });
});

describe("runBootstrap: refusals", () => {
  it("refuses a Worker of that name that this plan did not create", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    await h.world.cloud().deployPlatform(plan, {}, { OTHER: "x" });
    h.world.calls.length = 0;
    await expect(h.run()).rejects.toThrow(BootstrapRefusal);
    await expect(h.run()).rejects.toThrow(/exists, and this plan did not create it/);
    expect(h.world.calls.filter((c) => c !== "secretNames")).toEqual([]);
  });

  it("refuses to upload the password again to an installation that looks released", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    expect(await h.run()).toEqual({ kind: "done" });
    // The journal is lost, but the Worker shows the release.
    const lost = harness(plan);
    lost.world.versions.set(plan.platformWorker, h.world.versions.get(plan.platformWorker) ?? []);
    await expect(lost.run()).rejects.toThrow(/looks released already/);
    expect(lost.world.calls.filter((c) => c !== "secretNames")).toEqual([]);
  });

  it("refuses when the platform Worker vanished after this plan deployed it", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    await h.run({ waitMs: 0 });
    h.world.versions.delete(plan.platformWorker);
    await expect(h.run()).rejects.toThrow(/no longer exists; plan a new installation/);
  });

  it("refuses when the password was deleted by hand without a release", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.truth = () => ({ initialized: false, reason: "not_replicated" });
    await h.run({ waitMs: 0 });
    await h.world.cloud().updateSecrets(plan.platformWorker, {
      [PASSWORD_SECRET]: null,
      [INITIALIZED_SECRET]: null,
    });
    h.world.truth = () => ({ initialized: true, reason: "durable" });
    await expect(h.run()).rejects.toThrow(/no longer holds the bootstrap password/);
  });

  it("stops before the web Worker when Access is not owner-only, and continues once it is", async () => {
    const h = harness(await accountPlan());
    const good = h.world.access;
    h.world.access = () => {
      throw new Error(
        "the Access application on omnigent.example.test admits someone other than the owner; not deploying",
      );
    };
    await expect(h.run()).rejects.toThrow(/admits someone other than the owner/);
    expect(h.world.calls).not.toContain("deployWeb");
    h.world.access = () => ({ teamDomain: "not-a-team.example.test", aud: "x" });
    await expect(h.run()).rejects.toThrow(/Access is not ready: the team domain/);
    expect(h.world.calls).not.toContain("deployWeb");
    h.world.access = good;
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("names a missing secret, never a value", async () => {
    const plan = await accountPlan();
    const world = new FakeWorld(plan);
    const run = (secrets: Record<string, string>) =>
      runBootstrap({
        cloud: world.cloud(),
        store: new MemoryStore(freshState(plan)),
        baseConfigs: BASE,
        secrets: () => secrets,
        random: (n) => new Uint8Array(n),
        now: () => world.now,
        sleep: async () => {},
        log: () => {},
      });
    await expect(run({})).rejects.toThrow("the owner's password is needed");
    await expect(run({ ownerPassword: "short" })).rejects.toThrow(/at least 8 characters/);
    await expect(run({ ownerPassword: OWNER_PASSWORD })).rejects.toThrow(
      `the replica's access key ID is needed (${REPLICA_KEY_ID_SECRET})`,
    );
    expect(world.calls).not.toContain("deployPlatform");
  });

  it("refuses an unusable plan before any call", async () => {
    const plan = await accountPlan({ ownerUsername: "root" });
    const h = harness(plan);
    await expect(h.run()).rejects.toThrow(/may not be "root"/);
    expect(h.world.calls).toEqual([]);
  });
});

// Every call, before and after its effect, and every journal write.
const CALLS = ["secretNames", "deployPlatform", "access", "deployWeb", "logs", "updateSecrets"];
const CRASH_POINTS: (CrashPoint | { journal: number })[] = [
  ...CALLS.flatMap((call) =>
    [1, 2, 3, 4].flatMap((nth) =>
      (["before", "after"] as const).map((when) => ({ call, nth, when })),
    ),
  ),
  ...Array.from({ length: 12 }, (_, i) => ({ journal: i + 1 })),
];

async function crashThenFinish(
  plan: Installation,
  point: CrashPoint | { journal: number },
  truth: (world: FakeWorld) => ServerTruth,
): Promise<Harness> {
  const h = harness(plan);
  h.world.truth = truth(h.world);
  if ("journal" in point) h.store.crash = { nth: point.journal };
  else h.world.crash = point;
  try {
    await h.run();
  } catch (error) {
    if (!(error instanceof Crash)) throw error;
  }
  // Another run, perhaps a little later, finishes the job.
  h.world.now += 60_000;
  let outcome = await h.run();
  if (outcome.kind !== "done") outcome = await h.run();
  expect(outcome).toEqual({ kind: "done" });
  return h;
}

describe("runBootstrap: a crash at any point", () => {
  it.each(CRASH_POINTS.map((p) => [JSON.stringify(p), p] as const))(
    "%s: a new run finishes, releasing once and never re-adding the password",
    async (_name, point) => {
      const plan = await accountPlan();
      const h = await crashThenFinish(plan, point, (world) =>
        timeline(world, 2 * 60_000, 2 * 60_000),
      );
      expect(h.world.released()).toBe(true);
      // The password went up with the first deploy only.
      expect(passwordVersions(h)[0]).toBe(0);
      expectNeverReAdded(h);
      // A release was sent only while the password existed; a repeat only if the first was lost
      // before its effect.
      const deletions = h.world.secretChanges.filter((c) => c.changes[PASSWORD_SECRET] === null);
      expect(deletions.length).toBeGreaterThanOrEqual(1);
      expect(deletions.length).toBeLessThanOrEqual(1);
      for (const change of h.world.secretChanges) expect(change.changes).toEqual(RELEASE_CHANGES);
      // Never before the owner was durable.
      const first = h.world.versions.get(plan.platformWorker)?.[0]?.at ?? 0;
      expect(deletions[0]?.at).toBeGreaterThanOrEqual(first + 4 * 60_000);
      // The cookie secret never changed.
      const cookies = new Set(
        (h.world.versions.get(plan.platformWorker) ?? []).map((v) => v.secrets.get(COOKIE_SECRET)),
      );
      expect(cookies.size).toBe(1);
    },
  );
});

describe("runBootstrap: properties", () => {
  it("releases only on a fresh durable status of this installation, whatever happens", async () => {
    const plan = await accountPlan();
    await fc.assert(
      fc.asyncProperty(
        // The server's truth: a run of minutes, each durable or not, with blips.
        fc.array(
          fc.constantFrom("not_initialized", "not_replicated", "durable", "position_unavailable"),
          {
            minLength: 1,
            maxLength: 40,
          },
        ),
        fc.option(fc.constantFrom(...CRASH_POINTS), { nil: undefined }),
        fc.constantFrom(0, 0.25, 0.5),
        async (minutes, point, loss) => {
          const h = harness(plan);
          h.world.lossEvery = loss;
          const truth: ServerTruth = (t) => {
            const first = h.world.versions.get(plan.platformWorker)?.[0]?.at ?? t;
            const i = Math.min(minutes.length - 1, Math.floor((t - first) / CHECK_MS));
            const reason = minutes[Math.max(0, i)] ?? "not_initialized";
            return { initialized: reason === "durable", reason };
          };
          h.world.truth = truth;
          if (point !== undefined) {
            if ("journal" in point) h.store.crash = { nth: point.journal };
            else h.world.crash = point;
          }
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const outcome = await h.run({ waitMs: 20 * 60_000 });
              if (outcome.kind === "done") break;
            } catch (error) {
              if (!(error instanceof Crash)) throw error;
            }
          }
          // Each deletion happened when the newest logged status of this installation said
          // durable; the logs the fake serves at that moment are what the bootstrap saw.
          for (const change of h.world.secretChanges) {
            const events = h.world.logEvents(
              plan.platformWorker,
              change.at - 15 * 60_000,
              change.at,
            );
            const statuses = events.filter(
              (e) => (e as { source?: { cfo?: string } }).source?.cfo === "bootstrap",
            ) as { timestamp: number }[];
            const newest = Math.max(...statuses.map((s) => s.timestamp));
            expect(truth(newest).initialized).toBe(true);
            expect(change.at - newest).toBeLessThanOrEqual(10 * 60_000);
          }
          expectNeverReAdded(h);
          // Atomic: initialized is "true" exactly when the password is gone.
          for (const v of h.world.versions.get(plan.platformWorker) ?? []) {
            expect(v.secrets.get(INITIALIZED_SECRET) === "true").toBe(
              !v.secrets.has(PASSWORD_SECRET),
            );
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
