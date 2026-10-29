// OmnigentServer's GitHub linking parts (WP3.36), in workerd with real storage, alarms and
// eviction, and a fake server container:
//   - the status line says which GitHub App this version holds (`githubApp`, a tag) and whether
//     Omnigent's `/v1/info` lists GitHub linking (`githubLinking`), and the installer's reading of
//     it (events.ts) agrees with what the object logged;
//   - `githubSetup`, the GitHub setup page's state, through a secrets change: the object on the
//     old version, the new version before and after the watchdog's restart, a held, a recovering
//     and a starting server, and no container;
//   - the cron's yield: an object on an older version than the cron's resets itself, never twice
//     in a row for the same newer environment and at most once in `VERSION_YIELD_INTERVAL_MS`, and its next instance
//     applies the new configuration;
//   - a configuration error names the App of the configuration it holds.
import {
  createExecutionContext,
  createScheduledController,
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { GitHubSetupResult, type ReplicationPosition } from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitHubLinking, parseLogs } from "../../../scripts/bootstrap/events.ts";
import platform from "../../src/index.ts";
import { githubAppTag } from "../../src/server/github-linking.ts";
import { type OmnigentServer, VERSION_YIELD_INTERVAL_MS } from "../../src/server/OmnigentServer.ts";
import { environmentFingerprint } from "../../src/server/server-env.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
/** Synthetic: the App's settings as `github-app` stores them. */
const CLIENT_ID = "Iv23liCanaryClient00";
const APP = {
  SERVER_ENV_OMNIGENT_GITHUB_APP_ID: "123456",
  SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID: CLIENT_ID,
  SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_SECRET: "cfo-canary-github-client-secret-00000000",
  SERVER_ENV_OMNIGENT_GITHUB_APP_REDIRECT_URI:
    "https://omnigent.example.test/v1/connections/github/callback",
  SERVER_ENV_OMNIGENT_GITHUB_APP_SLUG: "omnigent-01hs3f9q",
};
const OFF = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };
const ON = { accounts_enabled: true, needs_setup: false, enabled_connections: ["github"] };

let serial = 0;
type Stub = DurableObjectStub<OmnigentServer>;

let logs: string[] = [];
beforeEach(() => {
  testServers.clock.reset();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

const lines = () =>
  logs.map((line) => JSON.parse(line) as { cfo: string; event: string } & Record<string, unknown>);
const events = (source: string, name?: string) =>
  lines().filter((e) => e.cfo === source && (name === undefined || e.event === name));

const position = (txid: number): ReplicationPosition => ({
  protocolVersion: 1,
  bootId: "c".repeat(32),
  txid,
  replicatedTxid: txid,
});

async function check(stub: Stub): Promise<void> {
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function nextCheck(stub: Stub): Promise<void> {
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  expect(at).not.toBeNull();
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  await check(stub);
}

/** A started server whose owner is durable, answering with `info`. */
async function runningServer(
  info: Readonly<Record<string, unknown>> = OFF,
): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`github-${++serial}`) as Stub;
  const fake = testServers.create(stub.id);
  fake.info = info;
  fake.position = position(5);
  await stub.bootstrapStatus(call);
  await check(stub); // starts it
  await nextCheck(stub); // it answers
  return { stub, fake };
}

/** The secrets change `github-app` makes: a new version, which the object switches to. */
async function storeApp(stub: Stub): Promise<void> {
  testServers.release(stub.id, APP);
  await evictDurableObject(stub);
}

async function setup(stub: Stub) {
  return GitHubSetupResult.parse(await stub.githubSetup(call));
}

describe("OmnigentServer: the status line's GitHub linking (WP3.36)", () => {
  it("says whether this version holds the App and Omnigent lists GitHub, and the installer reads it", async () => {
    const { stub, fake } = await runningServer();
    // The bootstrap secret is still set in the test env: a status on every check.
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      configApplied: true,
      githubApp: null,
      githubLinking: false,
    });
    const since = testServers.clock.now();
    await storeApp(stub);
    await nextCheck(stub); // another configuration: replaced
    expect(fake.signals).toEqual([15]);
    await nextCheck(stub); // seen stopped
    fake.info = ON; // the restarted server wired GitHub linking
    await nextCheck(stub); // started with the App's settings
    expect(fake.starts.at(-1)?.env.OMNIGENT_GITHUB_APP_CLIENT_ID).toBe(CLIENT_ID);
    await nextCheck(stub); // it answers
    const applied = events("bootstrap", "status").at(-1);
    const tag = await githubAppTag(CLIENT_ID);
    expect(applied).toMatchObject({ configApplied: true, githubApp: tag, githubLinking: true });
    // No line carries a value of the App's settings.
    for (const value of Object.values(APP)) expect(logs.join("\n")).not.toContain(value);
    // The installer's reading of these very lines, as Workers Logs would deliver them.
    const delivered = lines()
      .filter((e) => e.cfo === "bootstrap")
      .map((source, i) => ({
        timestamp: since + 1 + i,
        $workers: {
          scriptName: "cloudflare-omnigent",
          scriptVersion: { id: "v2" },
          eventType: "alarm",
          entrypoint: "OmnigentServer",
        },
        source,
      }));
    expect(
      checkGitHubLinking(parseLogs(delivered, "cloudflare-omnigent"), {
        installationId: INSTALLATION,
        appTag: tag ?? "",
        since,
      }),
    ).toEqual({ state: "on" });
    // And never for another App (an earlier one, on --replace).
    expect(
      checkGitHubLinking(parseLogs(delivered, "cloudflare-omnigent"), {
        installationId: INSTALLATION,
        appTag: (await githubAppTag("Iv23liAnotherApp0000")) ?? "",
        since,
      }).state,
    ).toBe("waiting");
  });

  it("logs null when Omnigent's answer does not say", async () => {
    await runningServer({ accounts_enabled: true, needs_setup: false });
    expect(events("bootstrap", "status").at(-1)).toMatchObject({ githubLinking: null });
  });
});

describe("OmnigentServer: githubSetup, the GitHub setup page's state (WP3.36)", () => {
  it("follows a secrets change: no App, the App not applied yet, then GitHub linking on", async () => {
    const { stub, fake } = await runningServer();
    expect(await setup(stub)).toEqual({
      configured: false,
      applied: true,
      server: "answering",
      linking: "off",
    });
    await storeApp(stub);
    // The new version, before its watchdog replaced the server: not applied.
    expect(await setup(stub)).toEqual({
      configured: true,
      applied: false,
      server: "answering",
      linking: "off",
    });
    await nextCheck(stub); // replaced: stopping
    expect((await setup(stub)).server).toBe("starting");
    await nextCheck(stub);
    fake.info = ON;
    await nextCheck(stub);
    await nextCheck(stub);
    expect(await setup(stub)).toEqual({
      configured: true,
      applied: true,
      server: "answering",
      linking: "on",
    });
    // Reads only: no start, stop or signal of its own.
    const ops = fake.ops.length;
    await setup(stub);
    expect(fake.ops.length).toBe(ops);
  });

  it("names a held, a recovering and a stopped server without reading Omnigent", async () => {
    const held = await runningServer();
    await runInDurableObject(held.stub, () => held.fake.stopByPlatform(78));
    await nextCheck(held.stub);
    expect(await setup(held.stub)).toMatchObject({ server: "held", linking: "unknown" });
    // The line names the held configuration's App (none here), and that it is the current one.
    expect(events("watchdog", "config_error").at(-1)).toMatchObject({
      exitCode: 78,
      held: true,
      githubApp: null,
    });

    const recovering = await runningServer();
    recovering.fake.listening = false;
    recovering.fake.entrypointPhase = "recovery";
    recovering.fake.recovery = { reason: "replica_empty", transient: false };
    await nextCheck(recovering.stub);
    expect(await setup(recovering.stub)).toMatchObject({ server: "recovery", linking: "unknown" });

    const stopped = await runningServer();
    await runInDurableObject(stopped.stub, () => stopped.fake.stopByPlatform(0));
    const reads = stopped.fake.requests.length;
    expect(await setup(stopped.stub)).toMatchObject({ server: "starting", linking: "unknown" });
    expect(stopped.fake.requests.length).toBe(reads);
  });

  it("names the App of a held configuration on its config_error line, and none for an older container's exit", async () => {
    const { stub, fake } = await runningServer();
    await storeApp(stub);
    await nextCheck(stub); // replaced: SIGTERM
    await nextCheck(stub); // seen stopped
    await nextCheck(stub); // started with the App's settings
    await runInDurableObject(stub, () => fake.stopByPlatform(78)); // which it refuses
    await nextCheck(stub);
    expect(events("watchdog", "config_error").at(-1)).toMatchObject({
      held: true,
      githubApp: await githubAppTag(CLIENT_ID),
    });
    expect(await setup(stub)).toMatchObject({ configured: true, server: "held" });
  });

  it("says starting when the server does not answer the read", async () => {
    const { stub, fake } = await runningServer();
    fake.listening = false;
    expect(await setup(stub)).toMatchObject({ server: "starting", linking: "unknown" });
  });

  it("says unavailable without a container, and refuses a newer interface", async () => {
    const stub = env.OMNIGENT.getByName(`github-none-${++serial}`) as Stub;
    expect(await setup(stub)).toEqual({
      configured: false,
      applied: false,
      server: "unavailable",
      linking: "unknown",
    });
    const error = await runInDurableObject(stub, async (server: OmnigentServer) => {
      try {
        await server.githubSetup({ interfaceVersion: 99 });
      } catch (e) {
        return e;
      }
      return undefined;
    });
    expect(errorCodeOf(error)).toBe("unsupported_version");
  });
});

describe("OmnigentServer: the cron's yield to a newer version (WP3.36)", () => {
  /** The fingerprint a newer version's cron sends: this object's environment plus the App. */
  const newer = () =>
    environmentFingerprint({ ...(env as unknown as Record<string, unknown>), ...APP });

  /** The cron's call, through RPC as the cron makes it: the reset comes back as its failure. */
  async function ensure(stub: Stub, environment: unknown): Promise<unknown> {
    try {
      await stub.ensureStarted({ ...call, environment } as never);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it("does nothing for the cron of its own version, or one that sends no fingerprint", async () => {
    const { stub } = await runningServer();
    const own = await environmentFingerprint(env as unknown as Record<string, unknown>);
    for (const environment of [own, undefined, "not-a-digest", 7]) {
      expect(await ensure(stub, environment)).toBeUndefined();
    }
    expect(events("watchdog", "version_yield")).toEqual([]);
  });

  // A stub whose object reset is broken for good, as on Cloudflare: each call after a reset
  // takes a new stub (the cron makes one every minute).
  const again = (stub: Stub) => env.OMNIGENT.get(stub.id) as Stub;

  it("resets itself once for a newer version's cron, with its alarm due now, then not again for that version, nor for a while", async () => {
    const { stub } = await runningServer();
    const fingerprint = await newer();
    const error = await ensure(stub, fingerprint);
    expect(String(error)).toContain("a newer version of the platform Worker is deployed");
    expect(events("watchdog", "version_yield")).toHaveLength(1);
    // No digest of the environment is logged.
    expect(logs.join("\n")).not.toContain(fingerprint);
    const alarm = await runInDurableObject(again(stub), (_i: OmnigentServer, s) =>
      s.storage.getAlarm(),
    );
    expect(alarm).toBe(testServers.clock.now());
    // The next instance, still on the same version (the platform has not switched it): no
    // second reset within the interval.
    expect(await ensure(again(stub), fingerprint)).toBeUndefined();
    // Another newer version within the interval: not yet.
    const newest = await environmentFingerprint({
      ...(env as unknown as Record<string, unknown>),
      ...APP,
      SERVER_ENV_CFO_DEPLOY_ID: "d2",
    });
    testServers.clock.advance(VERSION_YIELD_INTERVAL_MS - 1);
    expect(await ensure(again(stub), newest)).toBeUndefined();
    testServers.clock.advance(1);
    // The same version, however long after: never again (Codex r1: a gradual deployment keeps
    // an object on its version on purpose).
    expect(await ensure(again(stub), fingerprint)).toBeUndefined();
    testServers.clock.advance(24 * 60 * 60_000);
    expect(await ensure(again(stub), fingerprint)).toBeUndefined();
    // Another newer version, after the interval: once.
    expect(String(await ensure(again(stub), newest))).toContain("newer version");
    expect(events("watchdog", "version_yield")).toHaveLength(2);
  });

  it("the next instance on the newer version applies the new configuration at its first check", async () => {
    const { stub: old, fake } = await runningServer();
    await ensure(old, await newer());
    // The platform gives the next instance the newest version.
    testServers.release(old.id, APP);
    const stub = again(old);
    await check(stub); // the alarm the yield set for now
    expect(fake.signals).toEqual([15]);
    expect(events("watchdog", "config_changed").length).toBeGreaterThan(0);
  });

  it("the cron sends its own version's fingerprint, and logs an object's reset instead of failing", async () => {
    const cron = async (cronEnv: unknown) => {
      const ctx = createExecutionContext();
      await platform.scheduled(createScheduledController(), cronEnv as Env, ctx);
      await waitOnExecutionContext(ctx);
    };
    // The production-named object, on this (the test's) version.
    await cron(env);
    expect(events("watchdog", "version_yield")).toEqual([]);
    expect(events("cron")).toEqual([]);
    // A cron on a newer version, whose environment holds the App: the object yields to it.
    await cron({ ...env, ...APP });
    expect(events("watchdog", "version_yield")).toHaveLength(1);
    expect(events("cron", "ensure_started_error")).toHaveLength(1);
  });
});
