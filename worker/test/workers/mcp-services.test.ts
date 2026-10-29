// OmnigentServer's MCP report (WP5.10), in workerd with real storage, alarms and eviction, and a
// fake server container: the status line says which revision of the MCP choices this version
// holds (`mcpRevision`) and whether Omnigent's `/v1/info` lists MCP (`mcpRegistry`), the
// installer's reading of it (events.ts, `checkMcpServices`) agrees, and a configuration error
// names the revision it holds.
import {
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ReplicationPosition } from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkMcpServices, parseLogs } from "../../../scripts/bootstrap/events.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const REVISION = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
/** Synthetic: the choices `services add tracker` stores. */
const CHOICES = {
  SERVER_ENV_CFO_MCP_SERVICES: "tracker",
  SERVER_ENV_CFO_MCP_ORIGIN_TRACKER: "https://mcp-demo.example.test",
  SERVER_ENV_CFO_MCP_REVISION: REVISION,
};
const OFF = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };
const ON = { accounts_enabled: true, needs_setup: false, enabled_connections: ["mcp"] };

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

async function runningServer(): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`mcp-${++serial}`) as Stub;
  const fake = testServers.create(stub.id);
  fake.info = OFF;
  fake.position = position(5);
  await stub.bootstrapStatus(call);
  expect(await runDurableObjectAlarm(stub)).toBe(true); // starts it
  await nextCheck(stub); // it answers
  return { stub, fake };
}

/** The secrets change `services add` makes: a new version, which the object switches to. */
async function storeChoices(stub: Stub): Promise<void> {
  testServers.release(stub.id, CHOICES);
  await evictDurableObject(stub);
}

describe("OmnigentServer: the status line's MCP report (WP5.10)", () => {
  it("says which revision this version holds and whether Omnigent lists MCP, and the installer reads it", async () => {
    const { stub, fake } = await runningServer();
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      configApplied: true,
      mcpRevision: null,
      mcpRegistry: false,
    });
    const since = testServers.clock.now();
    await storeChoices(stub);
    await nextCheck(stub); // another configuration: replaced
    expect(fake.signals).toEqual([15]);
    await nextCheck(stub); // seen stopped
    fake.info = ON; // the restarted server passed Omnigent a registry
    await nextCheck(stub); // started with the choices
    const started = fake.starts.at(-1)?.env ?? {};
    expect(started.CFO_MCP_SERVICES).toBe("tracker");
    expect(started.CFO_MCP_REVISION).toBe(REVISION);
    await nextCheck(stub); // it answers
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      configApplied: true,
      mcpRevision: REVISION,
      mcpRegistry: true,
    });
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
    const read = parseLogs(delivered, "cloudflare-omnigent");
    expect(
      checkMcpServices(read, { installationId: INSTALLATION, revision: REVISION, since }),
    ).toEqual({ state: "applied", registry: true });
    expect(
      checkMcpServices(read, { installationId: INSTALLATION, revision: "f".repeat(32), since })
        .state,
    ).toBe("waiting");
  });

  it("logs null for an answer that does not say, and for a revision that is not one", async () => {
    const { stub, fake } = await runningServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    testServers.release(stub.id, { SERVER_ENV_CFO_MCP_REVISION: "not-a-revision" });
    await evictDurableObject(stub);
    for (let i = 0; i < 4; i++) await nextCheck(stub);
    expect(events("bootstrap", "status").at(-1)).toMatchObject({
      mcpRevision: null,
      mcpRegistry: null,
    });
  });

  it("names the revision of a held configuration on its config_error line", async () => {
    const { stub, fake } = await runningServer();
    await storeChoices(stub);
    await nextCheck(stub); // replaced: SIGTERM
    await nextCheck(stub); // seen stopped
    await nextCheck(stub); // started with the choices
    await runInDurableObject(stub, () => fake.stopByPlatform(78)); // which it refuses
    await nextCheck(stub);
    expect(events("watchdog", "config_error").at(-1)).toMatchObject({
      held: true,
      mcpRevision: REVISION,
    });
    // No line carries a value of the choices but the revision itself.
    expect(logs.join("\n")).not.toContain(CHOICES.SERVER_ENV_CFO_MCP_ORIGIN_TRACKER);
  });
});
