import {
  CONTROL_INTERFACE_VERSION,
  type LauncherRequest,
  LauncherResult,
  PagesResult,
  SupervisorReply,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  CONNECTION_LOST_MESSAGE,
  isConnectionLostError,
  isStartRefusedError,
  NO_INSTANCE_MESSAGE,
} from "../../src/shared/computer-port.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { CONTROL_OBJECT_NAME, workspaceObjectName } from "../../src/shared/rpc.ts";
import { FakeComputerContainer } from "../support/fake-computer-container.ts";
import { FakeControl } from "../support/fake-control.ts";
import { FAKE_WORKSPACE_PATH, FakeWorkspace } from "../support/fake-workspace.ts";

const CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const TOKEN = "synthetic-launch-token-not-a-secret-0001";
const start = (generation: number) => ({
  instance: "standard-2" as const,
  env: { CFO_COMPUTER_ID: CMP, CFO_GENERATION: String(generation) },
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

describe("the controllers' object names", () => {
  it("names one WorkspaceDO per computer, by its ID, and one ControlDO", () => {
    expect(workspaceObjectName(CMP)).toBe(CMP);
    expect(CONTROL_OBJECT_NAME).toBe("control");
  });
});

describe("the computer port's recognizers", () => {
  it("recognizes a dropped connection and a refused start, whatever the case", () => {
    expect(isConnectionLostError(new Error(CONNECTION_LOST_MESSAGE))).toBe(true);
    expect(isConnectionLostError("network connection lost")).toBe(true);
    expect(isConnectionLostError(new Error("Container is not running."))).toBe(false);
    expect(isStartRefusedError(new Error(NO_INSTANCE_MESSAGE))).toBe(true);
    expect(isStartRefusedError(new Error("try again later"))).toBe(false);
  });
});

describe("FakeComputerContainer", () => {
  it("refuses the next starts after a stop, and surfaces it in the next call (DC-37, CF-05)", async () => {
    const port = new FakeComputerContainer();
    port.supervisor = () => new Response("ok");
    port.start(start(1));
    await port.destroy("sleep");
    port.refuseStarts = 2;
    port.start(start(2));
    expect(port.running).toBe(false);
    const refused = await port
      .fetch(8090, new Request("http://container/v1/commands", { method: "POST", body: "{}" }))
      .catch((error: unknown) => error);
    expect(isStartRefusedError(refused)).toBe(true);
    port.start(start(2));
    port.start(start(2));
    expect(port.running).toBe(true);
    expect(port.starts.map((s) => s.refused)).toEqual([false, true, true, false]);
    expect(() => port.start(start(3))).toThrow();
  });

  it("can refuse every start", () => {
    const port = new FakeComputerContainer();
    port.refuseForever = true;
    for (let i = 0; i < 5; i += 1) port.start(start(1));
    expect(port.running).toBe(false);
    expect(port.ops).toEqual(Array(5).fill("start:refused"));
  });

  it("keeps a record of every stop, telling planned stops from the platform's", async () => {
    const port = new FakeComputerContainer();
    port.clock = () => 42;
    port.start(start(1));
    await port.destroy("sleep");
    await port.destroy("again");
    port.start(start(2));
    port.stopByPlatform();
    port.start(start(3));
    port.signal(15);
    expect(port.stops).toEqual([
      { by: "destroy", reason: "sleep", generation: "1", at: 42 },
      { by: "platform", reason: "platform maintenance", generation: "2", at: 42 },
      { by: "signal", reason: "signal 15", generation: "3", at: 42 },
    ]);
    expect(port.plannedStops().map((s) => s.generation)).toEqual(["1", "3"]);
  });

  it("drops a request before or after the supervisor got it", async () => {
    const port = new FakeComputerContainer();
    const seen: string[] = [];
    port.supervisor = async (request) => {
      seen.push(await request.text());
      return new Response("done");
    };
    port.start(start(1));
    const send = (body: string) =>
      port
        .fetch(8090, new Request("http://container/v1/commands", { method: "POST", body }))
        .then((r) => r.text())
        .catch((error: unknown) => (isConnectionLostError(error) ? "lost" : "other"));
    port.dropRequests = { count: 1, when: "before" };
    expect(await send("a")).toBe("lost");
    port.dropRequests = { count: 1, when: "after" };
    expect(await send("b")).toBe("lost");
    expect(await send("c")).toBe("done");
    expect(seen).toEqual(["b", "c"]);
    await expect(port.fetch(8090, new Request("https://container/"))).rejects.toThrow("http://");
    port.supervisor = null;
    await expect(port.fetch(8090, new Request("http://container/"))).rejects.toThrow(
      "not listening",
    );
    await port.destroy("x");
    await expect(port.fetch(8090, new Request("http://container/"))).rejects.toThrow("not running");
  });

  it("keeps backups per computer prefix, and can fail or hold an upload", async () => {
    const port = new FakeComputerContainer();
    port.start(start(1));
    await port.registerIntercept("computer.internal", {} as Fetcher);
    await port.setInactivityTimeout(2_700_000);
    const record = await port.backup({
      dir: "/stage/a",
      name: "lyr_a",
      prefix: `workspace/${CMP}/`,
    });
    await port.restore(record, { dir: "/restore/a", prefix: `workspace/${CMP}/` });
    await expect(port.restore(record, { dir: "/r", prefix: "workspace/other/" })).rejects.toThrow(
      "BACKUP_NOT_FOUND",
    );
    port.failBackups = 1;
    await expect(port.backup({ dir: "/d", name: "n", prefix: "p/" })).rejects.toThrow(
      "BACKUP_TRANSFER",
    );
    port.holdBackups = true;
    const controller = new AbortController();
    const held = port.backup({ dir: "/d", name: "n", prefix: "p/", signal: controller.signal });
    controller.abort(new Error("upload deadline"));
    await expect(held).rejects.toThrow("upload deadline");
    await port.deleteBackup(record, { prefix: `workspace/${CMP}/` });
    expect(port.backups.size).toBe(0);
    expect(port.ops).toEqual([
      "start",
      "intercept:computer.internal",
      "timeout",
      "backup:lyr_a",
      `restore:${record.id}`,
    ]);
    await port.destroy("x");
    await expect(port.backup({ dir: "/d", name: "n", prefix: "p/" })).rejects.toThrow(
      "not running",
    );
  });
});

describe("FakeControl", () => {
  const rpc = { interfaceVersion: CONTROL_INTERFACE_VERSION };
  const op = "op_01hzy4a7b8c9d0e1f2g3h4j5k6";
  /** A fresh operation ID for each new call. */
  let next = 0;
  const fresh = () => `op_01hzy4a7b8c9d0e1f2g3h4j5${(next++).toString().padStart(2, "0")}`;

  it("registers a computer once per name, and lists and forgets it", async () => {
    const control = new FakeControl();
    const a = await control.control({
      method: "register_computer",
      ...rpc,
      operationId: op,
      name: "managed-7f3c2a9e",
    });
    // A new operation for the same name, after a lost reply: the same computer.
    const b = await control.control({
      method: "register_computer",
      ...rpc,
      operationId: fresh(),
      name: "managed-7f3c2a9e",
    });
    expect(a).toEqual(b);
    const listed = await control.control({ method: "list_computers", ...rpc });
    expect(listed).toMatchObject({ computers: [{ name: "managed-7f3c2a9e" }] });
    if (a.method !== "register_computer") throw new Error("register");
    expect(
      await control.control({
        method: "forget_computer",
        ...rpc,
        operationId: fresh(),
        computerId: a.computerId,
      }),
    ).toEqual({
      method: "forget_computer",
      forgotten: true,
    });
  });

  it("refuses a wake at the limit at once, and repeats a reservation's answer", async () => {
    const control = new FakeControl();
    control.maxAwakeComputers = 1;
    const reserve = (computerId: string, generation: number) =>
      control.control({ method: "reserve", ...rpc, operationId: fresh(), computerId, generation });
    expect(await reserve(CMP, 1)).toEqual({ method: "reserve", granted: true });
    expect(await reserve(CMP, 1)).toEqual({ method: "reserve", granted: true });
    expect(await reserve("cmp_01hzy3m8k6q4t2v9w7x5r0s1n4", 1)).toEqual({
      method: "reserve",
      granted: false,
      reason: "at_capacity",
      awake: 1,
      limit: 1,
    });
    expect(
      await control.control({
        method: "release",
        ...rpc,
        operationId: fresh(),
        computerId: CMP,
        generation: 1,
      }),
    ).toEqual({
      method: "release",
      released: true,
    });
    // An operation ID reused for another call is refused.
    await control.control({
      method: "reserve",
      ...rpc,
      operationId: op,
      computerId: CMP,
      generation: 2,
    });
    expect(
      await codeOf(
        control.control({ method: "forget_computer", ...rpc, operationId: op, computerId: CMP }),
      ),
    ).toBe("conflict");
    expect(await control.control({ method: "limits", ...rpc })).toEqual({
      method: "limits",
      maxAwakeComputers: 1,
      maxInstanceSize: "standard-4",
    });
  });

  it("replays a recorded refusal, even after capacity frees", async () => {
    const control = new FakeControl();
    control.maxAwakeComputers = 1;
    await control.control({
      method: "reserve",
      ...rpc,
      operationId: op,
      computerId: CMP,
      generation: 1,
    });
    const other = "op_01hzy4a7b8c9d0e1f2g3h4j5k7";
    const second = {
      method: "reserve" as const,
      ...rpc,
      operationId: other,
      computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4",
      generation: 1,
    };
    expect(await control.control(second)).toMatchObject({ granted: false });
    await control.control({
      method: "release",
      ...rpc,
      operationId: "op_01hzy4a7b8c9d0e1f2g3h4j5k8",
      computerId: CMP,
      generation: 1,
    });
    expect(await control.control(second)).toMatchObject({ granted: false });
    expect(control.slots.size).toBe(0);
  });

  it("refuses a newer interface version, a malformed call, and fails when unavailable", async () => {
    const control = new FakeControl();
    expect(
      await codeOf(
        control.control({ method: "limits", interfaceVersion: CONTROL_INTERFACE_VERSION + 1 }),
      ),
    ).toBe("unsupported_version");
    expect(await codeOf(control.control({ method: "nope" } as never))).toBe("bad_request");
    control.unavailable = true;
    expect(await codeOf(control.control({ method: "limits", ...rpc }))).toBe("unavailable");
  });
});

describe("FakeWorkspace", () => {
  const interfaceVersion = WORKSPACE_INTERFACE_VERSION;
  let n = 0;
  const call = (request: Record<string, unknown>) => {
    n += 1;
    return {
      interfaceVersion,
      request: {
        protocolVersion: 1,
        operationId: n.toString(16).padStart(32, "0"),
        computerId: CMP,
        ...request,
      } as LauncherRequest,
    };
  };

  it("wakes, claims and starts a host as the lifecycle table says, with results the contract parses", async () => {
    const workspace = new FakeWorkspace(CMP);
    const results = [];
    results.push(await workspace.launcher(call({ operation: "resume" })));
    results.push(await workspace.launcher(call({ operation: "claim_start" })));
    results.push(
      await workspace.launcher(
        call({
          operation: "start_host",
          startAttempt: 1,
          hostId: HOST,
          hostName: "Work",
          token: TOKEN,
          hostConfig: {},
        }),
      ),
    );
    expect(results).toEqual([
      { operation: "resume", outcome: "starting", generation: 1 },
      { operation: "claim_start", granted: true, startAttempt: 1 },
      { operation: "start_host", workspacePath: FAKE_WORKSPACE_PATH },
    ]);
    for (const result of results) expect(LauncherResult.safeParse(result).success).toBe(true);
    workspace.fire("container_running");
    workspace.fire("restore_confirmed");
    expect(workspace.context.state).toBe("host_running");
    expect(await workspace.launcher(call({ operation: "claim_start" }))).toEqual({
      operation: "claim_start",
      granted: false,
      status: "host_running",
    });
    expect(await workspace.launcher(call({ operation: "admission" }))).toEqual({
      operation: "admission",
      admitting: true,
      status: "host_running",
      generation: 1,
    });
  });

  it("returns a recorded outcome for a repeated operation ID, errors included", async () => {
    const workspace = new FakeWorkspace(CMP);
    const claim = call({ operation: "claim_start" });
    const first = await workspace.launcher(claim);
    await workspace.launcher(call({ operation: "resume" }));
    expect(await workspace.launcher(claim)).toEqual(first);
    expect(first).toMatchObject({ granted: false, status: "stopped" });
    await workspace.launcher(call({ operation: "terminate" }));
    const late = call({ operation: "claim_start" });
    expect(await codeOf(workspace.launcher(late))).toBe("gone");
    expect(await codeOf(workspace.launcher(late))).toBe("gone");
  });

  it("reports a sleep in progress, then its recorded outcome under the same operation ID", async () => {
    const workspace = new FakeWorkspace(CMP);
    await workspace.launcher(call({ operation: "resume" }));
    workspace.fire("container_running");
    workspace.fire("restore_confirmed");
    const sleep = call({ operation: "suspend" });
    expect(await workspace.launcher(sleep)).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    expect(await workspace.launcher(sleep)).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
    workspace.fire("stop_preparation_failed");
    expect(await workspace.launcher(sleep)).toMatchObject({ outcome: "refused" });
    const again = call({ operation: "suspend" });
    await workspace.launcher(again);
    workspace.fire("stop_prepared");
    workspace.fire("container_stopped");
    expect(await workspace.launcher(again)).toEqual({ operation: "suspend", outcome: "stopped" });
  });

  it("resolves every sleep operation that joined, and replays it after the computer woke again", async () => {
    const workspace = new FakeWorkspace(CMP);
    await workspace.launcher(call({ operation: "resume" }));
    workspace.fire("container_running");
    workspace.fire("restore_confirmed");
    const a = call({ operation: "suspend" });
    const b = call({ operation: "suspend" });
    await workspace.launcher(a);
    expect(await workspace.launcher(b)).toEqual({ operation: "suspend", outcome: "in_progress" });
    workspace.fire("stop_prepared");
    workspace.fire("container_stopped");
    await workspace.launcher(call({ operation: "resume" }));
    workspace.fire("container_running");
    workspace.fire("restore_confirmed");
    // Replayed after a new wake, B reports its recorded outcome and starts no second sleep.
    expect(await workspace.launcher(b)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(workspace.context.stopPrep).toBeNull();
  });

  it("refuses at capacity, a start for another attempt, and another host on the computer", async () => {
    const workspace = new FakeWorkspace(CMP);
    workspace.inputs.add("at_capacity");
    expect(await codeOf(workspace.launcher(call({ operation: "resume" })))).toBe("at_capacity");
    workspace.inputs.clear();
    await workspace.launcher(call({ operation: "resume" }));
    await workspace.launcher(call({ operation: "claim_start" }));
    const start = {
      operation: "start_host",
      hostId: HOST,
      hostName: "Work",
      token: TOKEN,
      hostConfig: {},
    };
    expect(await codeOf(workspace.launcher(call({ ...start, startAttempt: 7 })))).toBe("conflict");
    await workspace.launcher(call({ ...start, startAttempt: 1 }));
    expect(
      await codeOf(workspace.launcher(call({ ...start, startAttempt: 1, hostId: "0".repeat(32) }))),
    ).toBe("conflict");
  });

  it("checks the computer API's props, generation and protocol version", async () => {
    const workspace = new FakeWorkspace(CMP);
    await workspace.launcher(call({ operation: "resume" }));
    const envelope = {
      protocolVersion: 1,
      computerId: CMP,
      generation: 1,
      operationId: "op_01hzy4a7b8c9d0e1f2g3h4j5k6",
    };
    const props = { propsVersion: 1, computerId: CMP, generation: 1, hostId: null };
    const reply = await workspace.computer({
      interfaceVersion,
      props,
      message: { type: "hello", ...envelope, supervisorVersion: "0.1.0" },
    });
    expect(SupervisorReply.parse(reply)).toEqual({ type: "hello", protocolVersion: 1 });
    expect(
      await codeOf(
        workspace.computer({
          interfaceVersion,
          props: { ...props, generation: 0 },
          message: { type: "hello", ...envelope, supervisorVersion: "0.1.0" },
        }),
      ),
    ).toBe("stale_generation");
    expect(
      await codeOf(
        workspace.computer({
          interfaceVersion,
          props,
          message: { type: "hello", ...envelope, protocolVersion: 2, supervisorVersion: "0.1.0" },
        }),
      ),
    ).toBe("unsupported_version");
    const files = Object.fromEntries(
      [
        ".claude/.credentials.json",
        ".claude/.device-keys.json",
        ".codex/auth.json",
        ".codex/.credentials.json",
      ].map((path, i) => [path, { state: "tombstone", copyOrder: i + 1 }]),
    );
    const bundle = { formatVersion: 1, computerId: CMP, generation: 1, order: 4, files };
    const publish = () =>
      workspace.computer({
        interfaceVersion,
        props,
        message: { type: "credential_checkpoint", ...envelope, bundle } as never,
      });
    // No credential checkpoint before the generation's restore is confirmed (R-19).
    expect(await codeOf(publish())).toBe("conflict");
    workspace.fire("container_running");
    expect(await codeOf(publish())).toBe("conflict");
    expect(workspace.credentialPointer).toBeNull();
    workspace.fire("restore_confirmed");
    expect(await publish()).toMatchObject({ outcome: "published" });
    expect(await publish()).toEqual({
      type: "credential_checkpoint",
      outcome: "superseded",
      checkpointId: null,
    });
  });

  it("answers the pages through the same table, and refuses a newer interface", async () => {
    const workspace = new FakeWorkspace(CMP);
    const op = "op_01hzy4a7b8c9d0e1f2g3h4j5k6";
    const state = await workspace.pages({ action: "state", interfaceVersion });
    expect(PagesResult.parse(state)).toMatchObject({
      computer: { lifecycle: "provisioned", status: "stopped" },
    });
    expect(await workspace.pages({ action: "restart", interfaceVersion, operationId: op })).toEqual(
      {
        action: "restart",
        outcome: "refused",
        reason: "not_running",
      },
    );
    await workspace.launcher(call({ operation: "terminate" }));
    const first = "op_01hzy4a7b8c9d0e1f2g3h4j5k7";
    const second = "op_01hzy4a7b8c9d0e1f2g3h4j5k8";
    expect(
      await workspace.pages({ action: "resolve_removal", interfaceVersion, operationId: first }),
    ).toMatchObject({ outcome: "refused", reason: "unresolved" });
    workspace.inputs.add("sign_out_settled");
    expect(
      await workspace.pages({ action: "resolve_removal", interfaceVersion, operationId: second }),
    ).toMatchObject({ outcome: "accepted" });
    // A repeated page mutation returns its recorded outcome.
    expect(
      await workspace.pages({ action: "resolve_removal", interfaceVersion, operationId: first }),
    ).toMatchObject({ outcome: "refused", reason: "unresolved" });
    expect(
      await codeOf(workspace.pages({ action: "state", interfaceVersion: interfaceVersion + 1 })),
    ).toBe("unsupported_version");
    expect(await workspace.reservation({ interfaceVersion })).toBeNull();
  });
});
