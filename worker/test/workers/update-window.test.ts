// OmnigentServer in an update's read-only window and its rollback (WP3.41, ADR 0007), in workerd
// with real storage, alarms and eviction, and a fake server container. A version holding
// `SERVER_ENV_CFO_MAINTENANCE_WINDOW` passes nothing to the server (reads, writes, WebSockets, the password
// page's change) while its watchdog still checks it; its status line says so and names the
// restore point the server reports; the installer's reading of it (events.ts) agrees. A rollback
// order replaces the server, even one in recovery mode; the server's exit 79 is held and logged
// as `rolled_back` with the order; the previous release's configuration starts it again.
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
import {
  OWNER_PASSWORD_CALL_PATH,
  OwnerPasswordResult,
  type PageOwner,
  type ReplicationPosition,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLogs } from "../../../scripts/bootstrap/events.ts";
import platform from "../../src/index.ts";
import { PlatformInternal } from "../../src/internal/entrypoints.ts";
import {
  MAINTENANCE_WINDOW_SECRET,
  RESTORE_POINT_VAR,
  ROLLBACK_SECRET,
} from "../../src/server/maintenance.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { environmentFingerprint } from "../../src/server/server-env.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const ORIGIN = "https://omnigent.example.test";
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const RP = "rp-20261030T120000Z-0a1b2c3d";
const TAKEN = "2026-10-30T12:06:00.000Z";
const OWNER: PageOwner = { sub: "owner-sub-1", sessionId: "a".repeat(64) };
const DURABLE = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };

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

async function nextCheck(stub: Stub): Promise<void> {
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  expect(at).not.toBeNull();
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

async function runningServer(
  vars: Record<string, string | null> = {},
): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`window-${++serial}`) as Stub;
  testServers.release(stub.id, {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: "c".repeat(64),
    ...vars,
  });
  const fake = testServers.create(stub.id);
  fake.info = DURABLE;
  fake.position = position(5);
  await stub.bootstrapStatus(call);
  expect(await runDurableObjectAlarm(stub)).toBe(true); // starts it
  await nextCheck(stub); // it answers
  return { stub, fake };
}

/** A new version of the platform Worker (a deploy or a secrets change), which the object takes. */
async function release(stub: Stub, changes: Record<string, string | null>): Promise<void> {
  testServers.release(stub.id, changes);
  await evictDurableObject(stub);
}

async function forward(stub: Stub, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(FORWARD_VERSION_HEADER, "1");
  const response = await stub.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
  );
  if (response.webSocket) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, headers: response.headers });
}

async function setPassword(stub: Stub) {
  const state = OwnerPasswordResult.parse(
    await stub.ownerPassword({ action: "state", interfaceVersion: 1, owner: OWNER }),
  );
  if (state.action !== "state") throw new Error("not a state");
  return OwnerPasswordResult.parse(
    await stub.ownerPassword({
      action: "set",
      interfaceVersion: 1,
      owner: OWNER,
      intent: state.intentToken,
      password: "a-password-long-enough",
    }),
  );
}

/** Workers Logs as the installer reads them: the object's lines, by version. */
function delivered(since: number, version: string) {
  return lines().map((source, i) => ({
    timestamp: since + 1 + i,
    $workers: {
      scriptName: "cloudflare-omnigent",
      scriptVersion: { id: version },
      eventType: "alarm",
      entrypoint: "OmnigentServer",
    },
    source,
  }));
}

describe("OmnigentServer in an update's read-only window (WP3.41)", () => {
  it("passes nothing to the server while the version holds the window, and everything after", async () => {
    const { stub, fake } = await runningServer();
    // The update's deploy: the window, and the restore point the new server takes.
    await release(stub, { [MAINTENANCE_WINDOW_SECRET]: RP, [RESTORE_POINT_VAR]: RP });
    for (let i = 0; i < 4; i++) await nextCheck(stub); // replaced, then started with it
    expect(fake.starts.at(-1)?.env.CFO_RESTORE_POINT).toBe(RP);
    // The server receives the window too: it starts Omnigent without its scheduler.
    expect(fake.starts.at(-1)?.env.CFO_MAINTENANCE_WINDOW).toBe(RP);
    fake.restorePoint = { id: RP, takenAt: TAKEN, objects: 5, bytes: 4096 };
    await nextCheck(stub);
    const before = fake.forwarded().length;
    for (const [path, init] of [
      ["/v1/sessions", { method: "POST", body: "{}" }],
      ["/v1/sessions", {}],
      ["/", { headers: { accept: "text/html" } }],
      ["/v1/runner/ws", { headers: { upgrade: "websocket", connection: "upgrade" } }],
    ] as const) {
      const answer = await forward(stub, path, init);
      expect(answer.status).toBe(503);
      expect(answer.headers.get("retry-after")).toBe("60");
      const body = (await answer.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("unavailable");
      expect(body.error.message).toMatch(/being updated/);
    }
    expect(fake.forwarded()).toHaveLength(before);
    expect(events("server", "forward_refused").every((e) => e.reason === "maintenance")).toBe(true);
    // The password page's change too: never reaches the server.
    const calls = () =>
      fake.requests.filter((r) => new URL(r.url).pathname === OWNER_PASSWORD_CALL_PATH).length;
    expect(await setPassword(stub)).toMatchObject({ action: "set", outcome: "unavailable" });
    expect(calls()).toBe(0);
    // The watchdog still checks it: its status line says the window holds, and which restore
    // point the server took.
    await nextCheck(stub);
    const status = events("bootstrap", "status").at(-1);
    expect(status).toMatchObject({
      configApplied: true,
      maintenance: RP,
      restorePoint: { id: RP, takenAt: TAKEN },
    });
    const read = parseLogs(delivered(0, "v2"), "cloudflare-omnigent");
    expect(read.statuses.at(-1)).toMatchObject({
      maintenance: RP,
      restorePoint: { id: RP, takenAt: TAKEN },
    });
    // Accepted: the window's secret is deleted. That version passes requests again, and its
    // watchdog restarts the server once without the window (its scheduler on again).
    const starts = fake.starts.length;
    await release(stub, { [MAINTENANCE_WINDOW_SECRET]: null });
    expect((await forward(stub, "/v1/sessions", { method: "POST", body: "{}" })).status).toBe(200);
    expect(await setPassword(stub)).not.toMatchObject({ outcome: "unavailable" });
    expect(calls()).toBe(1);
    for (let i = 0; i < 4; i++) await nextCheck(stub);
    expect(fake.starts).toHaveLength(starts + 1);
    expect(fake.starts.at(-1)?.env.CFO_MAINTENANCE_WINDOW).toBeUndefined();
    expect(fake.signals).toEqual([15, 15]);
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      configApplied: true,
      maintenance: null,
      restorePoint: null,
    });
  });

  it("holds a window whose ID is malformed, and reads no restore point it cannot trust", async () => {
    const { stub, fake } = await runningServer();
    await release(stub, { [MAINTENANCE_WINDOW_SECRET]: "yes please" });
    expect((await forward(stub, "/v1/sessions")).status).toBe(503);
    fake.restorePoint = { id: "rp-elsewhere", takenAt: TAKEN };
    for (let i = 0; i < 4; i++) await nextCheck(stub);
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      maintenance: "malformed",
      restorePoint: null,
    });
  });

  it("tells the object of the version that ends the window through the cron (a yield)", async () => {
    const withWindow = { ...env, [MAINTENANCE_WINDOW_SECRET]: RP } as unknown as Record<
      string,
      unknown
    >;
    const without = env as unknown as Record<string, unknown>;
    expect(await environmentFingerprint(withWindow)).not.toBe(
      await environmentFingerprint(without),
    );
    // The cron runs on the newest version, and the object on an older one yields to it.
    const stub = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as Stub;
    testServers.create(stub.id);
    testServers.release(stub.id, { [MAINTENANCE_WINDOW_SECRET]: RP });
    await stub.bootstrapStatus(call);
    const ctx = createExecutionContext();
    await platform.scheduled(createScheduledController(), env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(events("watchdog", "version_yield")).toHaveLength(1);
  });
});

describe("platform.internal in an update's window (WP3.41)", () => {
  it("refuses every launcher call while the version holds the window, and keeps the key service", async () => {
    const ctx = createExecutionContext() as ExecutionContext & { props: unknown };
    const withProps = Object.assign(Object.create(ctx), {
      props: { propsVersion: 1, caller: "omnigent-server" },
    });
    const internal = (windowed: boolean) =>
      new PlatformInternal(
        withProps as never,
        { ...env, ...(windowed ? { [MAINTENANCE_WINDOW_SECRET]: RP } : {}) } as never,
      );
    const launcher = new Request("http://platform.internal/launcher/v1/computers", {
      method: "POST",
      body: "{}",
    });
    const refused = await internal(true).fetch(launcher.clone());
    expect(refused.status).toBe(503);
    expect(await refused.text()).toMatch(/being updated/);
    expect(events("launcher_api", "refused").at(-1)).toMatchObject({ refused: "maintenance" });
    // Outside the window the same call reaches the launcher API's own checks.
    const open = await internal(false).fetch(launcher.clone());
    expect(await open.text()).not.toMatch(/being updated/);
    // The key service is not paused: it answers with its own checks.
    const keyService = await internal(true).fetch(
      new Request("http://platform.internal/key-service/v1/seal", { method: "POST", body: "{}" }),
    );
    expect(await keyService.text()).not.toMatch(/being updated/);
  });
});

describe("OmnigentServer: an update's rollback (WP3.41)", () => {
  const WINDOW = { [MAINTENANCE_WINDOW_SECRET]: RP, [RESTORE_POINT_VAR]: RP };

  it("replaces the server with the order, holds its exit 79, and starts the previous release's", async () => {
    const { stub, fake } = await runningServer(WINDOW);
    expect((await forward(stub, "/v1/sessions")).status).toBe(503);
    const since = testServers.clock.now();
    await release(stub, { [ROLLBACK_SECRET]: RP });
    await nextCheck(stub); // another configuration: replaced
    expect(fake.signals).toEqual([15]);
    await nextCheck(stub); // seen stopped
    await nextCheck(stub); // started with the order
    expect(fake.starts.at(-1)?.env).toMatchObject({ CFO_ROLLBACK_TO: RP, CFO_RESTORE_POINT: RP });
    // Rollback mode: the restore point back as the replica, then exit 79.
    fake.entrypointPhase = "restoring";
    await nextCheck(stub);
    await runInDurableObject(stub, () => fake.stopByPlatform(79));
    await nextCheck(stub);
    const starts = fake.starts.length;
    for (let i = 0; i < 5; i++) await nextCheck(stub);
    expect(fake.starts).toHaveLength(starts); // held: never started again under the order
    // Said at every check while held, after an eviction too: a lost line recurs.
    await evictDurableObject(stub);
    await nextCheck(stub);
    const rolled = events("watchdog", "rolled_back");
    expect(rolled.length).toBeGreaterThanOrEqual(6);
    for (const line of rolled) {
      expect(line).toMatchObject({ exitCode: 79, held: true, restorePoint: RP });
    }
    expect(events("watchdog", "config_error")).toEqual([]);
    const read = parseLogs(delivered(since, "v3"), "cloudflare-omnigent");
    expect(read.rollbacks.length).toBe(rolled.length);
    expect(read.rollbacks[0]).toEqual(
      expect.objectContaining({ versionId: "v3", held: true, restorePoint: RP }),
    );
    // Still the window: nothing passes.
    expect((await forward(stub, "/v1/sessions")).status).toBe(503);
    // The previous release's version: no window, no order, no restore point. It starts.
    fake.entrypointPhase = "running";
    await release(stub, {
      [MAINTENANCE_WINDOW_SECRET]: null,
      [RESTORE_POINT_VAR]: null,
      [ROLLBACK_SECRET]: null,
    });
    await nextCheck(stub);
    expect(fake.starts).toHaveLength(starts + 1);
    expect(fake.starts.at(-1)?.env.CFO_ROLLBACK_TO).toBeUndefined();
    await nextCheck(stub);
    expect((await forward(stub, "/v1/sessions")).status).toBe(200);
  });

  it("replaces a server in recovery mode to carry the order out, and never otherwise", async () => {
    const { stub, fake } = await runningServer(WINDOW);
    // The update's server is in recovery mode (its migrated database fails its check).
    await release(stub, { SERVER_ENV_CFO_DEPLOY_ID: "d2" });
    await nextCheck(stub);
    await nextCheck(stub);
    fake.entrypointPhase = "recovery";
    fake.recovery = { reason: "database_corrupt", transient: false };
    for (let i = 0; i < 6; i++) await nextCheck(stub);
    const signals = fake.signals.length;
    // Another change of its configuration does not stop recovery mode...
    await release(stub, { SERVER_ENV_CFO_DEPLOY_ID: "d3" });
    for (let i = 0; i < 4; i++) await nextCheck(stub);
    expect(fake.signals).toHaveLength(signals);
    // ...a rollback order does, once.
    await release(stub, { [ROLLBACK_SECRET]: RP });
    await nextCheck(stub);
    expect(fake.signals).toHaveLength(signals + 1);
    expect(events("watchdog", "config_changed").at(-1)).toMatchObject({
      action: "replace",
      phase: "recovery",
    });
    fake.entrypointPhase = "running";
    fake.recovery = null;
    await nextCheck(stub);
    await nextCheck(stub);
    expect(fake.starts.at(-1)?.env.CFO_ROLLBACK_TO).toBe(RP);
    // The replacement is in recovery mode too: never replaced again for the same order.
    fake.entrypointPhase = "recovery";
    fake.recovery = { reason: "restore_failed", transient: true };
    const after = fake.signals.length;
    for (let i = 0; i < 6; i++) await nextCheck(stub);
    expect(fake.signals).toHaveLength(after);
  });

  it("an exit 79 without an order is held, naming no restore point", async () => {
    const { stub, fake } = await runningServer();
    await runInDurableObject(stub, () => fake.stopByPlatform(79));
    await nextCheck(stub);
    expect(events("watchdog", "rolled_back").at(-1)).toMatchObject({
      held: true,
      restorePoint: null,
    });
  });
});
