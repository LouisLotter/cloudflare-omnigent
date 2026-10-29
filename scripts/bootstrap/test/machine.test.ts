import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BootstrapRefusal,
  type BootstrapState,
  type RunContext,
  type RunOptions,
  runBootstrap,
} from "../machine.ts";
import { r2TokenPrefix, type S3Credentials } from "../r2-token.ts";
import {
  ARTIFACTS_KEY_ID_SECRET,
  ARTIFACTS_SECRET_KEY_SECRET,
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
  R2_GROUP_ID,
  REPLACE_MS,
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
  /** For each read of the installer's secrets: whether the owner's password was needed. */
  readonly needs: boolean[];
  run(options?: Partial<RunOptions>): ReturnType<typeof runBootstrap>;
}

/**
 * How the R2 credentials come: supplied by the installer (the default, as before WP3.25), or
 * from the token the bootstrap makes, with `ask` standing in for the terminal's prompt.
 */
interface R2Mode {
  readonly tokens: boolean;
  readonly ask?: (step: string) => Promise<S3Credentials>;
}

function harness(
  plan: Installation,
  state: BootstrapState = freshState(plan),
  r2: R2Mode = { tokens: false },
): Harness {
  const world = new FakeWorld(plan);
  const store = new MemoryStore(state);
  const h: Harness = {
    world,
    store,
    lines: [],
    asked: 0,
    needs: [],
    run: (options = {}) => {
      const ctx: RunContext = {
        cloud: world.cloud(),
        store,
        baseConfigs: BASE,
        secrets: (need) => {
          h.asked++;
          h.needs.push(need.password);
          return r2.tokens
            ? { ownerPassword: OWNER_PASSWORD }
            : {
                ownerPassword: OWNER_PASSWORD,
                replicaAccessKeyId: REPLICA_KEY_ID,
                replicaSecretAccessKey: REPLICA_SECRET,
              };
        },
        ...(r2.tokens ? { r2Tokens: world.tokenApi() } : {}),
        ...(r2.ask === undefined ? {} : { askR2: r2.ask }),
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
    const order = h.world.calls.filter(
      (c) => c !== "secretNames" && c !== "logs" && c !== "workerInstallation",
    );
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
        ARTIFACTS_KEY_ID_SECRET,
        ARTIFACTS_SECRET_KEY_SECRET,
      ].sort(),
    );
    // The installer gave one R2 token: its values serve both buckets, under their own names.
    expect(first?.get(ARTIFACTS_KEY_ID_SECRET)).toBe(first?.get(REPLICA_KEY_ID_SECRET));
    expect(first?.get(ARTIFACTS_SECRET_KEY_SECRET)).toBe(first?.get(REPLICA_SECRET_KEY_SECRET));
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
    // The check after the release waited past the objects' switch, and past the server's
    // replacement with the released configuration (G2-SEC-001).
    expect(Date.parse(h.store.state.journal.verifiedAt ?? "")).toBeGreaterThanOrEqual(
      releasedAt + SWITCH_MS + REPLACE_MS,
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
          // The platform pages' bindings (WP3.5), to the same platform Worker.
          { name: "WORKSPACE", class_name: "WorkspaceDO", script_name: "cloudflare-omnigent" },
          { name: "CONTROL", class_name: "ControlDO", script_name: "cloudflare-omnigent" },
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

  it("reports released, not yet applied, while the running server keeps its old configuration (G2-SEC-001)", async () => {
    const h = harness(await accountPlan());
    // A platform build that never replaces the server: the release stays in the Worker.
    h.world.appliesReleases = false;
    const outcome = await h.run();
    expect(outcome).toEqual({
      kind: "released",
      why: expect.stringMatching(/^released, not yet applied: /),
    });
    expect(h.world.released()).toBe(true);
    expect(h.store.state.journal.verifiedAt).toBeUndefined();
    expect(h.lines.some((l) => l.startsWith("checked:"))).toBe(false);
    // Once the server is replaced with the released configuration, a later run completes,
    // without another release.
    h.world.appliesReleases = true;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.secretChanges).toHaveLength(1);
  });

  it("waits for the replacement within its existing deadline, and says so", async () => {
    const h = harness(await accountPlan());
    // The check after the switch stops after the released version ran, before the
    // replacement it began could answer.
    expect(await h.run({ verifyWaitMs: 0, switchMs: SWITCH_MS + CHECK_MS })).toEqual({
      kind: "released",
      why: expect.stringMatching(/^released, not yet applied: /),
    });
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("completes a release whose confirmation was lost, when the run resumes long after the server's notice (Codex r1-3)", async () => {
    for (const point of [
      { call: "updateSecrets", nth: 1, when: "after" },
      { call: "secretNames", nth: 4, when: "before" },
      { call: "activeVersion", nth: 1, when: "before" },
    ] as const) {
      const h = harness(await accountPlan());
      h.world.crash = point;
      await expect(h.run()).rejects.toThrow(Crash);
      expect(h.world.released()).toBe(true);
      // The installer comes back an hour later: the replaced server's notice is long over.
      h.world.now += 60 * 60_000;
      expect(await h.run()).toEqual({ kind: "done" });
      expect(h.world.secretChanges).toHaveLength(1);
    }
  });

  it("completes once the restarted server's owner is durable again, however late (Codex r1-2)", async () => {
    const h = harness(await accountPlan());
    // After the release, the replaced server's replica lags for 40 minutes.
    let releasedAt: number | undefined;
    h.world.truth = (t) =>
      releasedAt !== undefined && t > releasedAt && t < releasedAt + 40 * 60_000
        ? { initialized: false, reason: "not_replicated" }
        : { initialized: true, reason: "durable" };
    h.world.before = {
      call: "updateSecrets",
      nth: 1,
      run: () => {
        releasedAt = h.world.now;
      },
    };
    expect(await h.run()).toEqual({
      kind: "released",
      why: expect.stringContaining("does not show a durable owner yet"),
    });
    h.world.now += 45 * 60_000;
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("finds the release's evidence behind more later activity than one query returns (Codex r2-3)", async () => {
    const h = harness(await accountPlan());
    h.world.noisePerMinute = 40; // about 2,400 lines an hour
    h.world.logCap = 2_000;
    h.world.crash = { call: "updateSecrets", nth: 1, when: "after" };
    await expect(h.run()).rejects.toThrow(Crash);
    // The installer comes back three hours later: the newest 2,000 events are all later activity.
    h.world.now += 3 * 60 * 60_000;
    const newest = h.world
      .logEvents(h.world.plan.platformWorker, 0, h.world.now)
      .slice(0, 2_000) as { source?: { cfo?: string } }[];
    expect(newest.some((e) => e.source?.cfo === "bootstrap")).toBe(false);
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.secretChanges).toHaveLength(1);
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
      "a Worker named cloudflare-omnigent-web exists and is not this installation's",
    );
    expect(h.world.calls.filter((c) => c !== "secretNames" && c !== "workerInstallation")).toEqual(
      [],
    );
    expect(h.world.versions.has(plan.platformWorker)).toBe(false);
  });

  it("r2-1: a failed Access check claims nothing; a web Worker created meanwhile is refused", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    const good = h.world.access;
    h.world.access = () => {
      throw new Error("expected exactly one Access application on omnigent.example.test, found 0");
    };
    await expect(h.run()).rejects.toThrow(/found 0/);
    expect(h.store.state.journal.webDeployStartedAt).toBeUndefined();
    // Someone else deploys a Worker under the web name; Access is fixed; the bootstrap resumes.
    await h.world.cloud().deployWeb(plan, { name: plan.webWorker });
    h.world.access = good;
    h.world.calls.length = 0;
    await expect(h.run()).rejects.toThrow(
      "cloudflare-omnigent-web exists and is not this installation's",
    );
    expect(h.world.calls).not.toContain("deployWeb");
  });

  it("r2-1: a web Worker this installation deployed, with no journal entry, is resumed", async () => {
    const plan = await stagingPlan();
    const h = harness(plan);
    // The staging adapter's Access step deploys the web Worker with the installation's ID; the
    // run stops right after.
    const deployedByAccess = () =>
      h.world.cloud().deployWeb(plan, { vars: { CFO_INSTALLATION_ID: plan.installationId } });
    h.world.before = { call: "access", nth: 1, run: () => void deployedByAccess() };
    h.world.crash = { call: "access", nth: 1, when: "after" };
    await expect(h.run()).rejects.toThrow(Crash);
    expect(h.store.state.journal.webDeployStartedAt).toBeUndefined();
    expect(await h.run()).toEqual({ kind: "done" });
  });

  it("r2-2: a release whose window passes during the tool's own checks is not sent, and waits again", async () => {
    const h = harness(await accountPlan());
    // The guarded update stalls eleven minutes before its request (the staging tool's checks).
    h.world.slow = { call: "updateSecrets", nth: 1, ms: 11 * 60_000 };
    expect(await h.run({ verify: false })).toMatchObject({ kind: "released" });
    expect(h.lines).toContain(
      "waiting again: the accepted status grew too old before the release was sent",
    );
    expect(h.world.counts.get("updateSecrets")).toBe(2);
    expect(h.world.secretChanges).toHaveLength(1);
  });

  it("r2-3: repeated stale acceptances stop at the wait's deadline", async () => {
    const h = harness(await accountPlan());
    // Every secret listing before a release stalls eleven minutes.
    const stall = () => {
      h.world.slow = {
        call: "secretNames",
        nth: (h.world.counts.get("secretNames") ?? 0) + 1,
        ms: 11 * 60_000,
      };
    };
    const real = h.world.cloud();
    const startedAt = h.world.now;
    let listings = 0;
    const cloud = {
      ...real,
      secretNames: async (worker: string) => {
        listings++;
        if (listings > 20) throw new Error("the bootstrap keeps retrying past its deadline");
        if (listings >= 3) stall();
        return real.secretNames(worker);
      },
    };
    const outcome = await runBootstrap(
      {
        cloud,
        store: h.store,
        baseConfigs: BASE,
        secrets: () => ({
          ownerPassword: OWNER_PASSWORD,
          replicaAccessKeyId: REPLICA_KEY_ID,
          replicaSecretAccessKey: REPLICA_SECRET,
        }),
        random: (n) => new Uint8Array(n).fill(1),
        now: () => h.world.now,
        sleep: async (ms) => {
          h.world.now += ms;
        },
        log: () => {},
      },
      { ...OPTIONS, waitMs: 5 * 60_000 },
    );
    expect(outcome).toEqual({ kind: "waiting", why: "the newest bootstrap status is too old" });
    expect(h.world.secretChanges).toEqual([]);
    // One stale attempt, then the deadline: not an endless loop holding the locks.
    expect(h.world.now - startedAt).toBeLessThan(30 * 60_000);
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
    k.world.slow = { call: "secretNames", nth: 3, ms: 11 * 60_000 };
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
  it("deploys the platform again when its version went live but its container application failed (WP3.19)", async () => {
    // Wrangler 4.149.0 makes the new version live before it creates or updates a
    // `durable_object` container application; if that step fails, it says to deploy again.
    const h = harness(await accountPlan());
    h.world.failAfter = {
      call: "deployPlatform",
      nth: 1,
      message:
        "wrangler deploy exited with 1: The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings.",
    };
    await expect(h.run()).rejects.toThrow("could not finish applying");
    // Live, with the installer's secrets, but not counted as deployed.
    expect(h.world.secretsOf(h.world.plan.platformWorker)?.has(PASSWORD_SECRET)).toBe(true);
    expect(h.store.state.journal.platformDeployedAt).toBeUndefined();
    expect(await h.run()).toEqual({ kind: "done" });
    // The same deploy again, without asking the installer a second time.
    const configs = h.world.configs.get(h.world.plan.platformWorker) ?? [];
    expect(configs).toHaveLength(2);
    expect(configs[1]).toEqual(configs[0]);
    expect(h.asked).toBe(1);
    expect(h.world.released()).toBe(true);
  });

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

  it("asks the installer again when only the artifacts' credentials are missing (G2-DUR-001)", async () => {
    const h = harness(await accountPlan());
    h.world.dropOnDeploy = [ARTIFACTS_SECRET_KEY_SECRET];
    await expect(h.run()).rejects.toThrow(
      `after the deploy, cloudflare-omnigent lacks ${ARTIFACTS_SECRET_KEY_SECRET}; run again`,
    );
    expect(h.asked).toBe(1);
    h.world.dropOnDeploy = [];
    expect(await h.run()).toEqual({ kind: "done" });
    // The password and the replica's pair are held: only the artifacts' half was missing, so
    // the second read says the password is not needed (nothing is generated or asked for).
    expect(h.asked).toBe(2);
    expect(h.needs).toEqual([true, false]);
    expect(h.world.secretsOf(h.world.plan.platformWorker)?.get(ARTIFACTS_SECRET_KEY_SECRET)).toBe(
      REPLICA_SECRET,
    );
  });

  it("stops when the platform Worker vanishes before the release", async () => {
    const plan = await accountPlan();
    const h = harness(plan);
    h.world.before = {
      call: "secretNames",
      nth: 3,
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
    await expect(h.run()).rejects.toThrow(/exists and is not this installation's/);
    expect(h.world.calls.filter((c) => c !== "secretNames" && c !== "workerInstallation")).toEqual(
      [],
    );
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
const CALLS = [
  "secretNames",
  "workerInstallation",
  "deployPlatform",
  "access",
  "deployWeb",
  "logs",
  "updateSecrets",
  "activeVersion",
];
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

const TOKENS: R2Mode = { tokens: true };

/** The installation's tokens at Cloudflare. */
function tokensOf(h: Harness) {
  const prefix = r2TokenPrefix(h.world.plan);
  return [...h.world.tokens.values()].filter((t) => t.token.name.startsWith(prefix));
}

/** The Worker's four R2 secrets are the S3 key pair of this token's value. */
function expectWorkerUses(h: Harness, id: string): void {
  const pair = h.world.pairOf(id);
  const secrets = h.world.secretsOf(h.world.plan.platformWorker);
  expect(secrets?.get(REPLICA_KEY_ID_SECRET)).toBe(pair.accessKeyId);
  expect(secrets?.get(ARTIFACTS_KEY_ID_SECRET)).toBe(pair.accessKeyId);
  expect(secrets?.get(REPLICA_SECRET_KEY_SECRET)).toBe(pair.secretAccessKey);
  expect(secrets?.get(ARTIFACTS_SECRET_KEY_SECRET)).toBe(pair.secretAccessKey);
}

/** No token value, and no secret key derived from one, in the journal or the log. */
function expectNoTokenSecret(h: Harness): void {
  const kept = `${JSON.stringify(h.store.state)}\n${h.lines.join("\n")}`;
  for (const [id, { value }] of h.world.tokens) {
    expect(kept).not.toContain(value);
    expect(kept).not.toContain(h.world.pairOf(id).secretAccessKey);
  }
  expect(kept).not.toContain("cfo-canary-r2-token-value");
}

/** The token the Worker uses is the journal's current one, and every other is to be deleted. */
function expectAccounted(h: Harness): void {
  const current = h.store.state.journal.r2Token;
  expect(current?.id).toBeDefined();
  expectWorkerUses(h, String(current?.id));
  const toDelete = new Set((h.store.state.journal.r2TokensToDelete ?? []).map((t) => t.name));
  for (const { token } of tokensOf(h)) {
    if (token.id !== current?.id) expect(toDelete.has(token.name)).toBe(true);
  }
}

const DELETE_STEP =
  /^Cloudflare does not let this cf login delete API tokens, so delete the token named exactly (\S+) by hand: open https:\/\/dash\.cloudflare\.com\/profile\/api-tokens, open the three-dot menu next to it, and choose Delete\.$/;

describe("runBootstrap: the R2 token (WP3.25)", () => {
  it("makes one token on exactly the installation's buckets, and sets its key pair for both uses", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    expect(await h.run()).toEqual({ kind: "done" });
    const [made, ...more] = tokensOf(h);
    expect(more).toEqual([]);
    expect(made?.token).toEqual({
      id: made?.token.id,
      name: `cloudflare-omnigent-r2--${INSTALLATION}--20261022T120000Z`,
      status: "active",
      ipLimited: false,
      policies: [
        {
          effect: "allow",
          permissionGroups: [R2_GROUP_ID],
          resources: {
            [`com.cloudflare.edge.r2.bucket.${"1".repeat(32)}_default_cfo-canary-replica`]: "*",
            [`com.cloudflare.edge.r2.bucket.${"1".repeat(32)}_default_cfo-canary-artifacts`]: "*",
          },
        },
      ],
    });
    // An installation's token does not expire.
    expect(made?.token.expiresOn).toBeUndefined();
    expectWorkerUses(h, String(made?.token.id));
    expect(h.store.state.journal.r2Token).toEqual({
      name: made?.token.name,
      id: made?.token.id,
      createdAt: expect.any(String),
    });
    expect(h.store.state.journal.r2TokensToDelete).toBeUndefined();
    // Made just before the first deploy, once, with no call the OAuth login may not make.
    const order = h.world.calls.filter((c) => c.startsWith("token") || c === "deployPlatform");
    expect(order).toEqual(["tokenGroup", "tokenCreate", "deployPlatform"]);
    expect(h.lines).toContainEqual(expect.stringMatching(/^created the R2 token .*no expiry$/));
    expectNoTokenSecret(h);
  });

  it("gives a staging installation's token an expiry a day after the deployments'", async () => {
    const plan = await stagingPlan({
      replica: { url: "s3://cfo-stg-wp24-db/omnigent", endpoint: "https://canary.r2.example.test" },
      artifacts: { url: "s3://cfo-stg-wp24-artifacts" },
      target: {
        kind: "staging",
        owner: "WP2.4",
        platformSuffix: "wp24-platform",
        webSuffix: "wp24-web",
        days: 2,
      },
    });
    const h = harness(plan, freshState(plan), TOKENS);
    const start = h.world.now;
    await h.run({ waitMs: 0 });
    const [made] = tokensOf(h);
    expect(made?.token.name).toBe(`cfo-stg-wp24-platform-r2--${INSTALLATION}--20261022T120000Z`);
    // Two days of deployments, and one more: whole seconds, as Cloudflare takes them.
    expect(made?.token.expiresOn).toBe("2026-10-25T12:00:00Z");
    expect(Date.parse(String(made?.token.expiresOn))).toBe(start + 3 * 86_400_000);
    expect(h.store.state.journal.r2Token?.expiresOn).toBe(made?.token.expiresOn);
  });

  it("reuses the deployed pair: a run while the Worker holds it touches no token", async () => {
    const plan = await accountPlan();
    const supplied = harness(plan);
    await supplied.run();
    expect(supplied.world.calls.some((c) => c.startsWith("token"))).toBe(false);
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.failAfter = { call: "deployWeb", nth: 1, message: "the web deploy failed" };
    await expect(h.run()).rejects.toThrow("the web deploy failed");
    const tokenCalls = h.world.calls.filter((c) => c.startsWith("token")).length;
    const { platformDeployedAt: _deployed, ...journal } = h.store.state.journal;
    h.store.state = { ...h.store.state, journal };
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.world.calls.filter((c) => c.startsWith("token")).length).toBe(tokenCalls);
    expect(h.world.calls.filter((c) => c === "deployPlatform")).toHaveLength(2);
    expect(tokensOf(h)).toHaveLength(1);
  });

  it("after a deploy that failed, makes a new token and names the old one to delete (OAuth: 403 on delete)", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.run()).rejects.toThrow(Crash);
    const [first] = tokensOf(h);
    h.world.now += 60_000;
    expect(await h.run()).toEqual({ kind: "done" });
    // Never rolled: a new token, under a name of its own.
    const second = tokensOf(h).find((t) => t.token.id !== first?.token.id);
    expect(second?.token.name).toBe(`cloudflare-omnigent-r2--${INSTALLATION}--20261022T120100Z`);
    expect(h.world.tokens.get(String(first?.token.id))?.value).toBe(first?.value);
    expectWorkerUses(h, String(second?.token.id));
    expect(h.store.state.journal.r2TokensToDelete).toEqual([
      { name: first?.token.name, id: first?.token.id },
    ]);
    const steps = h.lines.filter((l) => DELETE_STEP.test(l));
    expect(steps).toEqual([expect.stringContaining(String(first?.token.name))]);
    expect(h.world.calls).toContain("tokenRemove");
    expectAccounted(h);
    expectNoTokenSecret(h);
  });

  it("a retry within the same second: the new token is named apart, and never named to delete (Codex r3-3)", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.run()).rejects.toThrow(Crash);
    expect(await h.run()).toEqual({ kind: "done" });
    const current = String(h.store.state.journal.r2Token?.name);
    expect(current).toBe(`cloudflare-omnigent-r2--${INSTALLATION}--20261022T120000Z-2`);
    const steps = h.lines.filter((l) => DELETE_STEP.test(l));
    expect(steps).toHaveLength(1);
    expect(steps[0]).not.toContain(current);
    expectAccounted(h);
  });

  it("supplied values for a Worker holding only half a pair retire the token made earlier (Codex r3-4)", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    // The first deploy left only the replica's access key ID of the first token.
    h.world.dropOnDeploy = [
      REPLICA_SECRET_KEY_SECRET,
      ARTIFACTS_KEY_ID_SECRET,
      ARTIFACTS_SECRET_KEY_SECRET,
    ];
    await expect(h.run()).rejects.toThrow("lacks");
    h.world.dropOnDeploy = [];
    const [first] = tokensOf(h);
    const ctx = {
      cloud: h.world.cloud(),
      store: h.store,
      baseConfigs: BASE,
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: REPLICA_KEY_ID,
        replicaSecretAccessKey: REPLICA_SECRET,
      }),
      r2Tokens: h.world.tokenApi(),
      random: (n: number) => new Uint8Array(n).fill(0xab),
      now: () => h.world.now,
      sleep: async (ms: number) => {
        h.world.now += Math.max(0, ms);
      },
      log: (line: string) => h.lines.push(line),
    };
    const { platformDeployedAt: _deployed, ...journal } = h.store.state.journal;
    h.store.state = { ...h.store.state, journal };
    expect(await runBootstrap(ctx, OPTIONS)).toEqual({ kind: "done" });
    // Both pairs are the supplied values; the first token is no longer current.
    const secrets = h.world.secretsOf(plan.platformWorker);
    expect(secrets?.get(REPLICA_KEY_ID_SECRET)).toBe(REPLICA_KEY_ID);
    expect(secrets?.get(ARTIFACTS_KEY_ID_SECRET)).toBe(REPLICA_KEY_ID);
    expect(h.store.state.journal.r2Token).toBeUndefined();
    expect(h.store.state.journal.r2TokensToDelete).toEqual([
      { name: first?.token.name, id: first?.token.id },
    ]);
  });

  it("a Worker holding only half a pair gets a new token: the half is replaced whole (Codex r3-4)", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.dropOnDeploy = [
      REPLICA_SECRET_KEY_SECRET,
      ARTIFACTS_KEY_ID_SECRET,
      ARTIFACTS_SECRET_KEY_SECRET,
    ];
    await expect(h.run()).rejects.toThrow("lacks");
    h.world.dropOnDeploy = [];
    h.world.now += 60_000;
    const { platformDeployedAt: _deployed, ...journal } = h.store.state.journal;
    h.store.state = { ...h.store.state, journal };
    expect(await h.run()).toEqual({ kind: "done" });
    expectAccounted(h);
    expect(h.store.state.journal.r2TokensToDelete).toHaveLength(1);
  });

  it("deletes the old token itself where the login may (API Tokens Write)", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.oauthLogin = false;
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.run()).rejects.toThrow(Crash);
    expect(await h.run()).toEqual({ kind: "done" });
    expect(tokensOf(h)).toHaveLength(1);
    expect(h.store.state.journal.r2TokensToDelete).toBeUndefined();
    expect(h.lines).toContainEqual(expect.stringMatching(/^deleted the unused R2 token /));
    expect(h.lines.some((l) => DELETE_STEP.test(l))).toBe(false);
    expectAccounted(h);
  });

  it("a create whose answer was lost: named to delete if it exists, or found by name where listing is allowed", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.late = { call: "tokenCreate", nth: 1, afterMs: 120_000 };
    await expect(h.run()).rejects.toThrow("cf user tokens create failed: timeout");
    expect(h.store.state.journal.r2Token).toEqual({
      name: `cloudflare-omnigent-r2--${INSTALLATION}--20261022T120000Z`,
      createStartedAt: "2026-10-22T12:00:00.000Z",
    });
    h.world.now += 300_000;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.store.state.journal.r2TokensToDelete).toEqual([
      {
        name: `cloudflare-omnigent-r2--${INSTALLATION}--20261022T120000Z`,
        createStartedAt: "2026-10-22T12:00:00.000Z",
      },
    ]);
    expect(h.lines).toContainEqual(
      expect.stringContaining(
        `delete the token named exactly cloudflare-omnigent-r2--${INSTALLATION}--20261022T120000Z if it exists (its create was never answered) by hand`,
      ),
    );
    expectAccounted(h);
    // A login that may list finds it by its name, and deletes it.
    const listing = harness(plan, freshState(plan), TOKENS);
    listing.world.oauthLogin = false;
    listing.world.late = { call: "tokenCreate", nth: 1, afterMs: 120_000 };
    await expect(listing.run()).rejects.toThrow("timeout");
    listing.world.now += 300_000;
    expect(await listing.run()).toEqual({ kind: "done" });
    expect(tokensOf(listing)).toHaveLength(1);
    expect(listing.store.state.journal.r2TokensToDelete).toBeUndefined();
  });

  it("supplied values replace a token made earlier, which is retired", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.run()).rejects.toThrow(Crash);
    const [first] = tokensOf(h);
    // The installer now gives a hand-made token's values.
    const ctx = {
      cloud: h.world.cloud(),
      store: h.store,
      baseConfigs: BASE,
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: REPLICA_KEY_ID,
        replicaSecretAccessKey: REPLICA_SECRET,
      }),
      r2Tokens: h.world.tokenApi(),
      random: (n: number) => new Uint8Array(n).fill(0xab),
      now: () => h.world.now,
      sleep: async (ms: number) => {
        h.world.now += Math.max(0, ms);
      },
      log: (line: string) => h.lines.push(line),
    };
    expect(await runBootstrap(ctx, OPTIONS)).toEqual({ kind: "done" });
    expect(h.store.state.journal.r2Token).toBeUndefined();
    expect(h.store.state.journal.r2TokensToDelete).toEqual([
      { name: first?.token.name, id: first?.token.id },
    ]);
    expect(h.world.calls.filter((c) => c === "tokenCreate")).toHaveLength(1);
    expect(h.lines.some((l) => DELETE_STEP.test(l))).toBe(true);
  });

  it("falls back to the dashboard step when the login may not make tokens (403)", async () => {
    const plan = await accountPlan();
    const asked: string[] = [];
    const h = harness(plan, freshState(plan), {
      tokens: true,
      ask: async (step) => {
        asked.push(step);
        return { accessKeyId: REPLICA_KEY_ID, secretAccessKey: REPLICA_SECRET };
      },
    });
    h.world.tokensForbidden = true;
    expect(await h.run()).toEqual({ kind: "done" });
    expect(asked).toEqual([
      "In the Cloudflare dashboard, open R2 object storage, select Manage next to API Tokens, choose Create User API token, set Permissions to Object Read & Write, apply it to the buckets cfo-canary-replica and cfo-canary-artifacts only, select Create User API token, and copy its Access Key ID and Secret Access Key.",
    ]);
    expect(h.lines).toContainEqual(
      expect.stringContaining(
        "your cf login may not make API tokens (Cloudflare answered 403 Forbidden), so the R2 token is made by hand. In the Cloudflare dashboard",
      ),
    );
    const secrets = h.world.secretsOf(plan.platformWorker);
    expect(secrets?.get(REPLICA_SECRET_KEY_SECRET)).toBe(REPLICA_SECRET);
    expect(secrets?.get(ARTIFACTS_SECRET_KEY_SECRET)).toBe(REPLICA_SECRET);
    expect(h.store.state.journal.r2Token).toBeUndefined();
  });

  it("a create refused (403) leaves nothing in flight, and the old token is still named", async () => {
    const plan = await accountPlan();
    const ask = async () => ({ accessKeyId: REPLICA_KEY_ID, secretAccessKey: REPLICA_SECRET });
    const h = harness(plan, freshState(plan), { tokens: true, ask });
    h.world.crash = { call: "deployPlatform", nth: 1, when: "before" };
    await expect(h.run()).rejects.toThrow(Crash);
    const [first] = tokensOf(h);
    h.world.before = {
      call: "tokenCreate",
      nth: 2,
      run: () => {
        h.world.tokensForbidden = true;
      },
    };
    expect(await h.run()).toEqual({ kind: "done" });
    expect(h.store.state.journal.r2Token).toBeUndefined();
    expect(h.store.state.journal.r2TokensToDelete).toEqual([
      { name: first?.token.name, id: first?.token.id },
    ]);
    expect(h.lines.filter((l) => DELETE_STEP.test(l))).toHaveLength(1);
  });

  it("without a terminal, a 403 is a refusal that says what to click, and deploys nothing", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.tokensForbidden = true;
    const run = h.run();
    await expect(run).rejects.toThrow(BootstrapRefusal);
    await expect(run).rejects.toThrow(
      /403 Forbidden\)\. In the Cloudflare dashboard, .* Then run again with them on stdin \(--secrets-stdin/,
    );
    expect(h.world.calls).not.toContain("deployPlatform");
  });

  it("refuses to make a second token while the Worker holds one pair but lacks the other", async () => {
    const plan = await accountPlan();
    const h = harness(plan, freshState(plan), TOKENS);
    h.world.dropOnDeploy = [ARTIFACTS_SECRET_KEY_SECRET];
    await expect(h.run()).rejects.toThrow(`lacks ${ARTIFACTS_SECRET_KEY_SECRET}`);
    h.world.dropOnDeploy = [];
    await expect(h.run()).rejects.toThrow(
      /holds .*LITESTREAM_ACCESS_KEY_ID.* but not every R2 credential it needs, so the bootstrap will not make a second token; supply one token's values with --secrets-stdin .*: they replace each incomplete pair whole, and a complete pair is kept/,
    );
    expect(h.world.counts.get("tokenCreate")).toBe(1);
    expect(h.store.state.journal.r2TokensToDelete).toBeUndefined();
  });

  it("makes no token for a deploy that would be refused", async () => {
    const plan = await accountPlan();
    const bad = harness(plan, freshState(plan), TOKENS);
    const run = async () =>
      runBootstrap(
        {
          cloud: bad.world.cloud(),
          store: bad.store,
          baseConfigs: BASE,
          secrets: () => ({ ownerPassword: "short" }),
          r2Tokens: bad.world.tokenApi(),
          random: (n) => new Uint8Array(n).fill(0xab),
          now: () => bad.world.now,
          sleep: async () => {},
          log: () => {},
        },
        OPTIONS,
      );
    await expect(run()).rejects.toThrow(/at least 8 characters/);
    expect(bad.world.calls.some((c) => c.startsWith("token"))).toBe(false);
  });
});

const TOKEN_CALLS = ["tokenGroup", "tokenList", "tokenCreate", "tokenRemove"];
const TOKEN_CRASH_POINTS: (CrashPoint | { journal: number })[] = [
  ...[...TOKEN_CALLS, "deployPlatform", "secretNames"].flatMap((call) =>
    [1, 2].flatMap((nth) => (["before", "after"] as const).map((when) => ({ call, nth, when }))),
  ),
  ...Array.from({ length: 6 }, (_, i) => ({ journal: i + 1 })),
];

describe("runBootstrap: a crash at any point of the R2 token", () => {
  it.each(
    TOKEN_CRASH_POINTS.flatMap((p) =>
      [true, false].map(
        (oauth) => [JSON.stringify(p), oauth ? "OAuth" : "API Tokens Write", p, oauth] as const,
      ),
    ),
  )(
    "%s, %s login: a new run finishes, and every token is in use or recorded to delete",
    async (_name, _login, point, oauth) => {
      const plan = await accountPlan();
      const h = harness(plan, freshState(plan), TOKENS);
      h.world.oauthLogin = oauth;
      h.world.truth = timeline(h.world, 2 * 60_000, 2 * 60_000);
      if ("journal" in point) h.store.crash = { nth: point.journal };
      else h.world.crash = point;
      try {
        await h.run();
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
      }
      h.world.now += 60_000;
      let outcome = await h.run();
      if (outcome.kind !== "done") outcome = await h.run();
      expect(outcome).toEqual({ kind: "done" });
      h.world.landLate();
      expectAccounted(h);
      if (!oauth) expect(tokensOf(h).length).toBeLessThanOrEqual(2);
      expect(h.world.released()).toBe(true);
      expectNoTokenSecret(h);
    },
  );
});

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
