// WP3.27: every Durable Object class logs `instance_started`, with a fresh random instance ID,
// when an instance starts, so resets, evictions and version switches are measured rather than
// inferred (the 28 Oct sitting's unplanned resets). In workerd, with real eviction.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ComputerId } from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OMNIGENT_SERVER_INTERFACE_VERSION, workspaceObjectName } from "../../src/shared/rpc.ts";
import type {
  ControlDO,
  OmnigentServer,
  WorkspaceUnderFakes as WorkspaceDO,
} from "../support/platform-test-worker.ts";
import { testServers } from "../support/server-harness.ts";
import { testComputers } from "../support/workspace-harness.ts";

const logs: string[] = [];

beforeEach(() => {
  logs.length = 0;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => vi.restoreAllMocks());

/** The `instance_started` lines so far, parsed. */
function started(cls: string): Record<string, unknown>[] {
  return logs
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (l): l is Record<string, unknown> => l?.event === "instance_started" && l.class === cls,
    );
}

/** Starts an instance, evicts it, and starts another: two lines with two different IDs. */
async function twoInstances(stub: DurableObjectStub, cls: string) {
  await runInDurableObject(stub, () => undefined);
  await evictDurableObject(stub);
  await runInDurableObject(stub, () => undefined);
  const lines = started(cls);
  expect(lines).toHaveLength(2);
  for (const line of lines) expect(line.instanceId).toMatch(/^[0-9a-f]{16}$/);
  expect(lines[0]?.instanceId).not.toBe(lines[1]?.instanceId);
  return lines;
}

describe("instance_started (WP3.27)", () => {
  it("ControlDO: once per instance, with its count of starts", async () => {
    const stub = env.CONTROL.getByName(
      `instances-${crypto.randomUUID()}`,
    ) as DurableObjectStub<ControlDO>;
    const lines = await twoInstances(stub, "ControlDO");
    expect(lines.map((l) => [l.cfo, l.boots])).toEqual([
      ["control", 1],
      ["control", 2],
    ]);
  });

  it("OmnigentServer: once per instance, saying whether its container already runs", async () => {
    const stub = env.OMNIGENT.getByName(
      `instances-${crypto.randomUUID()}`,
    ) as DurableObjectStub<OmnigentServer>;
    testServers.create(stub.id);
    await stub.bootstrapStatus({ interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION });
    await evictDurableObject(stub);
    await runInDurableObject(stub, () => undefined);
    const lines = started("OmnigentServer");
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.cfo)).toEqual(["watchdog", "watchdog"]);
    expect(lines[0]?.instanceId).not.toBe(lines[1]?.instanceId);
    for (const line of lines) expect(typeof line.containerRunning).toBe("boolean");
    // Names nothing else: no value from the environment or the container.
    for (const line of lines) {
      expect(Object.keys(line).sort()).toEqual([
        "cfo",
        "class",
        "containerRunning",
        "event",
        "instanceId",
      ]);
    }
  });

  it("WorkspaceDO: once per instance, with its computer, generation and state", async () => {
    const computerId = `cmp_01hzy3m8k6q4t2v9w7x5s2${String(Date.now() % 10_000).padStart(4, "0")}`;
    const stub = (
      env as unknown as { WORKSPACE_CONTROLLER: DurableObjectNamespace<WorkspaceDO> }
    ).WORKSPACE_CONTROLLER.getByName(workspaceObjectName(computerId as ComputerId));
    testComputers.create(stub.id, computerId as ComputerId);
    const lines = await twoInstances(stub, "WorkspaceDO");
    for (const line of lines) {
      expect(line).toMatchObject({
        cfo: "workspace",
        computerId,
        generation: null,
        state: null,
      });
    }
  });
});
