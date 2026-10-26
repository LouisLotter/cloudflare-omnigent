// WP2.4: the bootstrap script's acceptance rule (scripts/bootstrap/events.ts), fed what the real
// OmnigentServer logs. The watchdog runs in workerd with a fake container (WP2.2's harness); its
// structured lines are wrapped as Workers Logs delivers them, in both shapes, and the script
// decides. Also: the web Worker's variables the script renders are what ingress accepts.

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ReplicationPosition } from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, parseLogs, verifyRelease } from "../../../scripts/bootstrap/events.ts";
import { type Installation, webVars } from "../../../scripts/bootstrap/settings.ts";
import { parseIngressEnv } from "../../src/ingress/index.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc"; // wrangler.test.jsonc's
const OTHER = "ins_01hs3f9q2m8z4w7k6t5r1n0yzz";
const SCRIPT = "cloudflare-omnigent";
const BOOT = "e".repeat(32);
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
type Stub = DurableObjectStub<OmnigentServer>;

let serial = 0;
let lines: { at: number; version: string; text: string }[] = [];
/** The platform Worker version the object runs: Workers Logs tags each line with it. */
let version = "v1";
beforeEach(() => {
  testServers.clock.reset();
  lines = [];
  version = "v1";
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push({ at: testServers.clock.now(), version, text: String(line) });
  });
});
afterEach(() => vi.restoreAllMocks());

async function freshServer(): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`bootstrap-script-${++serial}`) as Stub;
  const fake = testServers.create(stub.id);
  await stub.bootstrapStatus(call);
  return { stub, fake };
}

/** One watchdog check at the alarm's time. */
async function nextCheck(stub: Stub): Promise<void> {
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  testServers.clock.advance(Math.max(0, (at ?? testServers.clock.now()) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

const position = (txid: number, replicatedTxid: number): ReplicationPosition => ({
  protocolVersion: 1,
  bootId: BOOT,
  txid,
  replicatedTxid,
});

/** The logged lines as Workers Logs events: parsed into `source`, or kept as its message. */
function workersLogs(asMessage = false): unknown[] {
  return lines.map(({ at, version: id, text }) => ({
    timestamp: at,
    $workers: {
      scriptName: SCRIPT,
      scriptVersion: { id },
      eventType: "alarm",
      entrypoint: "OmnigentServer",
    },
    source: asMessage ? { level: "info", message: text } : JSON.parse(text),
  }));
}

function scriptDecides(installationId = INSTALLATION, asMessage = false) {
  const logs = parseLogs(workersLogs(asMessage), SCRIPT);
  expect(logs.malformed).toBe(0);
  return decide(logs.statuses, { installationId, now: testServers.clock.now() });
}

describe("the bootstrap script reads what OmnigentServer logs", () => {
  it("waits while the owner is initialized but not replicated, then accepts the durable owner", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(9, 4); // replication held back
    await nextCheck(stub);
    await nextCheck(stub);
    expect(scriptDecides()).toMatchObject({
      accepted: false,
      why: "the owner exists but its record is not replicated yet",
    });
    fake.position = position(15, 9); // the replica passes the owner's commit
    await nextCheck(stub);
    for (const asMessage of [false, true]) {
      const decision = scriptDecides(INSTALLATION, asMessage);
      expect(decision.accepted).toBe(true);
      if (decision.accepted) {
        expect(decision.event.status).toEqual(await stub.bootstrapStatus(call));
        expect(decision.event.reason).toBe("durable");
      }
    }
    // A status from this installation's object does not count for another installation.
    expect(scriptDecides(OTHER)).toMatchObject({
      accepted: false,
      why: "the only bootstrap statuses are another installation's",
    });
  });

  it("never accepts needs_setup: false alone (header and OIDC modes), or an owner not yet created", async () => {
    const { stub, fake } = await freshServer();
    fake.position = position(5, 5);
    fake.info = { accounts_enabled: false, needs_setup: false };
    await nextCheck(stub);
    await nextCheck(stub);
    expect(scriptDecides()).toMatchObject({
      accepted: false,
      why: "Omnigent does not show the owner yet",
    });
    fake.info = { accounts_enabled: true, needs_setup: true };
    await nextCheck(stub);
    expect(scriptDecides()).toMatchObject({
      accepted: false,
      why: "Omnigent does not show the owner yet",
    });
  });

  it("follows the newest line: a server restarted after a durable status is waited for again", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(5, 5);
    await nextCheck(stub);
    await nextCheck(stub);
    expect(scriptDecides().accepted).toBe(true);
    // A replaced server: a new boot, its own owner commit not replicated yet.
    fake.position = { ...position(20, 6), bootId: "f".repeat(32) };
    await nextCheck(stub);
    expect(scriptDecides()).toMatchObject({ accepted: false });
  });
});

describe("the bootstrap's check after its release reads what OmnigentServer logs (G2-SEC-001)", () => {
  it("is released but not applied until a server started with the released configuration reports itself", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(5, 5);
    await nextCheck(stub);
    await nextCheck(stub);
    expect(scriptDecides().accepted).toBe(true);
    // The release: one new version without the password, marked initialized.
    const releasedAt = testServers.clock.now();
    const rules = { installationId: INSTALLATION, releasedVersionId: "v2", releasedAt };
    const verify = (asMessage = false) =>
      verifyRelease(parseLogs(workersLogs(asMessage), SCRIPT), rules);
    testServers.release(stub.id, {
      SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: null,
      SERVER_ENV_CFO_INSTALLATION_INITIALIZED: "true",
    });
    expect(verify()).toMatchObject({
      verified: false,
      why: expect.stringContaining("has not run"),
    });
    // The objects switch to v2: the new instance adopts the server still holding the password.
    version = "v2";
    await evictDurableObject(stub);
    await nextCheck(stub); // v2 runs, and replaces the server
    expect(fake.signals).toEqual([15]);
    expect(verify()).toMatchObject({
      verified: false,
      why: expect.stringContaining("released, not yet applied"),
    });
    await nextCheck(stub); // seen stopped
    await nextCheck(stub); // started with v2's configuration, restoring
    fake.position = { ...position(6, 6), bootId: "a".repeat(32) };
    expect(verify().verified).toBe(false);
    await nextCheck(stub); // the replacement answers and reports itself
    for (const asMessage of [false, true]) expect(verify(asMessage)).toEqual({ verified: true });
    expect(fake.starts.at(-1)?.env).not.toHaveProperty("OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD");
    // The lines name no secret.
    expect(lines.map((l) => l.text).join("\n")).not.toContain("cfo-canary-bootstrap-password");
  });
});

describe("the web Worker's variables the bootstrap renders", () => {
  it("are what ingress accepts", async () => {
    const plan = {
      hostname: "omnigent.example.test",
      ownerPin: await makeOwnerPin("owner-canary@example.test", new Uint8Array(32).fill(3)),
    } as Installation;
    const access = { teamDomain: "team.cloudflareaccess.com", aud: "a".repeat(64) };
    expect(parseIngressEnv(webVars(plan, access))).toBeDefined();
    expect(parseIngressEnv(webVars({ ...plan, ownerPin: "x" }, access))).toBeUndefined();
  });
});
