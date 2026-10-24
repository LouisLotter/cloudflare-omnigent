import {
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import type { EntrypointPhase } from "../../src/server/watchdog.ts";
import { FORWARD_VERSION_HEADER } from "../../src/shared/rpc.ts";
import { TEST_TIMING as T, testServers } from "../support/server-harness.ts";

const phases = ["starting", "restoring", "initializing", "running"] as const;
const REBOOT_MS = 60_000;
const WHOLE_START =
  Math.max(T.restoreWaitMs, T.readinessWaitMs) + T.appStartWaitMs + T.readinessWaitMs;
let serial = 0;

beforeEach(() => {
  testServers.clock.reset();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

async function silentStart(phase: EntrypointPhase) {
  const stub = env.OMNIGENT.getByName(
    `bounded-reboots-${++serial}`,
  ) as DurableObjectStub<OmnigentServer>;
  const fake = testServers.create(stub.id);
  fake.listening = false;
  fake.stopMs = null;
  fake.entrypointPhase = phase;
  fake.bootId = "0".repeat(32);
  await stub.bootstrapStatus({ interfaceVersion: 1 });
  expect(await runDurableObjectAlarm(stub)).toBe(true); // start
  expect(await runDurableObjectAlarm(stub)).toBe(true); // first boot observed
  return { stub, fake };
}

it.each(phases)("bounds repeated %s boots across eviction, then recovers", async (phase) => {
  const { stub, fake } = await silentStart(phase);
  const startedAt = testServers.clock.now();
  const bound = startedAt + T.startRetryMs.length * REBOOT_MS + WHOLE_START;
  for (let boot = 1; testServers.clock.now() <= bound && fake.signals.length === 0; boot++) {
    testServers.clock.advance(REBOOT_MS);
    fake.bootId = boot.toString(16).padStart(32, "0");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
  }
  expect(fake.signals).toEqual([15]);
  expect(testServers.clock.now()).toBeLessThanOrEqual(bound + REBOOT_MS);
  expect(fake.starts).toHaveLength(1);
  expect(fake.destroys).toEqual([]);

  // The real persisted stop/retry path must permit a later successful start, not just stop.
  await runInDurableObject(stub, () => fake.stopByPlatform(0));
  fake.entrypointPhase = "running";
  fake.listening = true;
  for (let check = 0; check < 3; check++) {
    testServers.clock.advance(T.slowRetryMs);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
  }
  expect(fake.starts).toHaveLength(2);
  expect(fake.signals).toEqual([15]);
  const response = await stub.fetch(
    new Request("https://omnigent.example.test/v1/sessions", {
      headers: { [FORWARD_VERSION_HEADER]: "1" },
    }),
  );
  await response.arrayBuffer();
  expect(response.status).toBe(200);
});

it.each([...phases, null])("caps late %s status after exhaustion and eviction", async (phase) => {
  const { stub, fake } = await silentStart("restoring");
  const startedAt = testServers.clock.now();
  for (let boot = 1; boot <= T.startRetryMs.length + 1; boot++) {
    testServers.clock.advance(REBOOT_MS);
    fake.bootId = boot.toString(16).padStart(32, "0");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await evictDurableObject(stub);
  }
  const deadline = startedAt + T.startRetryMs.length * REBOOT_MS + WHOLE_START;
  fake.entrypointPhase = null;
  testServers.clock.advance(deadline - 1 - testServers.clock.now());
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await evictDurableObject(stub);
  expect(fake.signals).toEqual([]);
  fake.entrypointPhase = phase;
  fake.bootId = "e".repeat(32);
  testServers.clock.advance(1);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await evictDurableObject(stub);
  expect(fake.signals).toEqual([15]);
});
