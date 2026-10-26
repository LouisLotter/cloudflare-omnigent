// The private virtual hosts through their real entrypoints, bindings and RPC (WP3.3):
// `omnigent.internal` → OmnigentRoute → the real OmnigentServer → its (fake) container's port;
// `computer.internal` → ComputerApi → WorkspaceDO (a stand-in calling FakeWorkspace);
// `platform.internal` → PlatformInternal → WorkspaceDO and ControlDO (stand-ins), as registered
// by OmnigentServer on its own container.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  type ComputerId,
  ErrorBody,
  type InterceptProps,
  signLauncherRequest,
} from "@cfo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { directoryBackups } from "../../src/egress/backups.ts";
import { LAUNCH_TOKEN_HEADER } from "../../src/internal/omnigent-route.ts";
import { serverUpgradeAnswer } from "../../src/internal/upgrade-answer.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import { defined } from "../support/defined.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { internalFakes } from "../support/internal-harness.ts";
import { testServers } from "../support/server-harness.ts";

const HOST_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const HOST_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TOKEN_A = "cfo-canary-launch-token-a-0123456789abcdef";
const encoder = new TextEncoder();

type Factory = (options: { props: unknown }) => Fetcher;
const entry = exports as unknown as Record<
  "OmnigentRoute" | "ComputerApi" | "PlatformInternal",
  Factory
>;

let serial = 0;
/** A computer of its own per test: storage is not reset between tests in a file. */
function newComputer(): ComputerId {
  serial += 1;
  return `cmp_01hzy3m8k6q4t2v9w7x5r${String(serial).padStart(5, "0")}` as ComputerId;
}

function propsFor(
  computerId: ComputerId,
  generation: number,
  hostId: string | null,
): InterceptProps {
  return { propsVersion: 1, computerId, generation, hostId };
}

/** A computer whose WorkspaceDO reports this generation and bound host. */
function computerAt(generation: number, hostId: string | null) {
  const computerId = newComputer();
  internalFakes.workspace(computerId).generation = generation;
  internalFakes.workspace(computerId).hostId = hostId as never;
  return {
    computerId,
    route: entry.OmnigentRoute({ props: propsFor(computerId, generation, hostId) }),
  };
}

let fake: FakeServerContainer;

beforeAll(async () => {
  // The one OmnigentServer the route forwards to, started and answering.
  const stub = env.OMNIGENT.getByName(
    OMNIGENT_SERVER_OBJECT_NAME,
  ) as DurableObjectStub<OmnigentServer>;
  fake = testServers.create(stub.id);
  await stub.bootstrapStatus({ interfaceVersion: 1 });
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
});

beforeEach(() => {
  fake.handler = null;
  internalFakes.loseWorkspaceCalls = 0;
});

describe("omnigent.internal: the live connection (A′)", () => {
  it("forwards a computer's HTTP call to port 8000 once, trust headers stripped", async () => {
    const { route } = computerAt(1, HOST_A);
    const before = fake.requests.length;
    const response = await route.fetch("http://omnigent.internal/v1/sessions/s1/events?x=1", {
      method: "POST",
      body: "{}",
      headers: { "x-forwarded-email": "someone@example.test", authorization: "Bearer runner" },
    });
    expect(response.status).toBe(200);
    const sent = fake.requests
      .slice(before)
      .filter((r) => r.url.includes("/v1/sessions/s1/events"));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.port).toBe(8000);
    expect(sent[0]?.url).toBe("http://omnigent.internal/v1/sessions/s1/events?x=1");
    expect(sent[0]?.headers["x-forwarded-email"]).toBeUndefined();
    expect(sent[0]?.headers.authorization).toBe("Bearer runner");
    await response.arrayBuffer();
  });

  it("reaches only port 8000, whatever port the computer names", async () => {
    const { route } = computerAt(1, HOST_A);
    const before = fake.requests.length;
    const response = await route.fetch("http://omnigent.internal:8001/position");
    await response.arrayBuffer();
    const sent = fake.requests.slice(before);
    expect(sent.map((r) => r.port)).toEqual([8000]);
  });

  it("refuses a blocked path before the server sees it", async () => {
    const { route } = computerAt(1, HOST_A);
    const before = fake.requests.length;
    for (const [method, path] of [
      ["POST", "/auth/setup"],
      ["POST", "/AUTH/users/me/password"],
      ["PUT", "/v1/sharing"],
      ["POST", "/v1/sessions/s1/elicitations/e1/resolve"],
      ["DELETE", "/v1/sessions/s1/permissions/u1"],
      ["POST", "/oauth%2Ftoken"],
    ] as const) {
      const response = await route.fetch(`http://omnigent.internal${path}`, {
        method,
        body: method === "DELETE" ? null : "{}",
      });
      expect(response.status, path).toBe(403);
      expect(ErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
    expect(fake.requests.length).toBe(before);
  });

  it("refuses an upgrade on a blocked path, even as GET, before the server sees it", async () => {
    const { route } = computerAt(1, HOST_A);
    const before = fake.requests.length;
    const response = await route.fetch("http://omnigent.internal/auth/users", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    expect(fake.requests.length).toBe(before);
  });

  it("refuses a call from an older generation", async () => {
    const computerId = newComputer();
    internalFakes.workspace(computerId).generation = 5;
    const old = entry.OmnigentRoute({ props: propsFor(computerId, 4, HOST_A) });
    const response = await old.fetch("http://omnigent.internal/v1/info");
    expect(response.status).toBe(409);
    expect(ErrorBody.parse(await response.json()).error.code).toBe("stale_generation");
  });

  it("fails closed when WorkspaceDO does not answer, after one more read", async () => {
    const { route } = computerAt(1, HOST_A);
    internalFakes.loseWorkspaceCalls = 2;
    const response = await route.fetch("http://omnigent.internal/v1/info");
    expect(response.status).toBe(503);
    await response.arrayBuffer();
  });

  it("refuses props the handler does not know", async () => {
    const computerId = newComputer();
    const route = entry.OmnigentRoute({
      props: { ...propsFor(computerId, 0, null), propsVersion: 2 },
    });
    expect((await route.fetch("http://omnigent.internal/v1/info")).status).toBe(503);
    const none = entry.OmnigentRoute({ props: undefined });
    expect((await none.fetch("http://omnigent.internal/v1/info")).status).toBe(503);
  });

  it("carries the computer's own host tunnel: a bare 101, binary frames unchanged both ways", async () => {
    const { route } = computerAt(2, HOST_A);
    const response = await route.fetch(`http://omnigent.internal/v1/hosts/${HOST_A}/tunnel`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": "omnigent.v1",
        [LAUNCH_TOKEN_HEADER]: TOKEN_A,
      },
    });
    expect(response.status).toBe(101);
    expect([...response.headers.keys()].sort()).toEqual(["sec-websocket-protocol"]);
    const socket = defined(response.webSocket, "a WebSocket");
    socket.binaryType = "arraybuffer";
    socket.accept();
    const received: (string | ArrayBuffer)[] = [];
    const three = new Promise<void>((resolve) =>
      socket.addEventListener("message", (event) => {
        received.push(event.data as string | ArrayBuffer);
        if (received.length === 3) resolve();
      }),
    );
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 256);
    socket.send("hello");
    socket.send(new Uint8Array([0, 1, 254, 255]));
    socket.send(bytes);
    await three;
    expect(received[0]).toBe("hello");
    expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([0, 1, 254, 255]);
    expect(new Uint8Array(received[2] as ArrayBuffer)).toEqual(bytes);
    socket.close(1000, "done");
  });

  it("refuses another computer's host tunnel, and a tunnel without the launch token (RC-23)", async () => {
    const { route } = computerAt(2, HOST_A);
    const before = fake.requests.length;
    for (const [hostId, headers] of [
      [HOST_B, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }],
      [HOST_B, { authorization: "Bearer owner" }],
      [HOST_A, { authorization: "Bearer owner" }],
      [HOST_A, { [LAUNCH_TOKEN_HEADER]: TOKEN_A, authorization: "Bearer owner" }],
    ] as const) {
      const response = await route.fetch(`http://omnigent.internal/v1/hosts/${hostId}/tunnel`, {
        headers: { upgrade: "websocket", ...headers },
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect(fake.requests.length).toBe(before);
  });
});

describe("computer.internal: the supervisor's messages", () => {
  const hello = (computerId: ComputerId, generation: number) => ({
    type: "hello",
    protocolVersion: 1,
    computerId,
    generation,
    operationId: "op_01hzy3m8k6q4t2v9w7x5r0s1n3",
    supervisorVersion: "1.0.0",
  });

  it("passes a message with the props to WorkspaceDO and answers its reply", async () => {
    const computerId = newComputer();
    internalFakes.workspace(computerId).generation = 3;
    const api = entry.ComputerApi({ props: propsFor(computerId, 3, null) });
    const response = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(computerId, 3)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "hello", protocolVersion: 1 });
    expect(internalFakes.workspace(computerId).computerCalls).toHaveLength(1);
  });

  it("repeats the call after a lost connection to WorkspaceDO", async () => {
    const computerId = newComputer();
    internalFakes.workspace(computerId).generation = 3;
    internalFakes.loseWorkspaceCalls = 2;
    const api = entry.ComputerApi({ props: propsFor(computerId, 3, null) });
    const response = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(computerId, 3)),
    });
    expect(response.status).toBe(200);
    expect(internalFakes.workspace(computerId).computerCalls).toHaveLength(1);
  });

  it("refuses a message naming another generation, and WorkspaceDO's own refusals pass through", async () => {
    const computerId = newComputer();
    internalFakes.workspace(computerId).generation = 3;
    const api = entry.ComputerApi({ props: propsFor(computerId, 3, null) });
    const other = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(computerId, 2)),
    });
    expect(other.status).toBe(409);
    // Props from an older generation than WorkspaceDO's: refused by WorkspaceDO itself.
    const oldApi = entry.ComputerApi({ props: propsFor(computerId, 2, null) });
    const stale = await oldApi.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(computerId, 2)),
    });
    expect(stale.status).toBe(409);
    expect(ErrorBody.parse(await stale.json()).error.code).toBe("stale_generation");
  });
});

describe("platform.internal: the launcher API", () => {
  const KEY = "cfo-canary-launcher-key-current-0000000000";
  async function signedCall(body: Record<string, unknown>, key = KEY, keyId = "k-test-current") {
    const bytes = encoder.encode(JSON.stringify(body));
    const headers = await signLauncherRequest({
      key: encoder.encode(key),
      keyId,
      operation: body.operation as string,
      timestamp: Math.floor(Date.now() / 1000),
      body: bytes,
    });
    return new Request(`http://platform.internal/launcher/${body.operation as string}`, {
      method: "POST",
      headers,
      body: bytes,
    });
  }
  const api = () =>
    entry.PlatformInternal({ props: { propsVersion: 1, caller: "omnigent-server" } });

  it("provisions through ControlDO and the computer's WorkspaceDO, with the Worker's keys", async () => {
    internalFakes.reset();
    const response = await api().fetch(
      await signedCall({
        protocolVersion: 1,
        operationId: "1".repeat(32),
        operation: "provision",
        name: "managed-0f1e2d3c",
      }),
    );
    expect(response.status).toBe(200);
    const { computerId } = (await response.json()) as { computerId: string };
    expect(internalFakes.has(computerId)).toBe(true);
    expect(internalFakes.control.calls.map((c) => c.method)).toEqual(["register_computer"]);
  });

  it("frames its replies with an exact Content-Length, through the real entrypoint (WP3.6)", async () => {
    const computerId = newComputer();
    for (const request of [
      await signedCall({
        protocolVersion: 1,
        operationId: "5".repeat(32),
        operation: "status",
        computerId,
      }),
      new Request("http://platform.internal/launcher/status", { method: "POST", body: "{}" }),
    ]) {
      const response = await api().fetch(request);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
    }
  });

  it("accepts the previous key during a rotation", async () => {
    const computerId = newComputer();
    const response = await api().fetch(
      await signedCall(
        { protocolVersion: 1, operationId: "2".repeat(32), operation: "status", computerId },
        "cfo-canary-launcher-key-previous-000000000",
        "k-test-previous",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: "status", status: "stopped" });
  });

  it("refuses an unsigned call (an SSRF) and a lost WorkspaceDO answer is retryable", async () => {
    const computerId = newComputer();
    const unsigned = await api().fetch("http://platform.internal/launcher/status", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: 1,
        operationId: "3".repeat(32),
        operation: "status",
        computerId,
      }),
    });
    expect(unsigned.status).toBe(401);
    expect(internalFakes.has(computerId)).toBe(false);
    internalFakes.loseWorkspaceCalls = 1;
    const lost = await api().fetch(
      await signedCall({
        protocolVersion: 1,
        operationId: "4".repeat(32),
        operation: "status",
        computerId,
      }),
    );
    expect(lost.status).toBe(503);
    expect(ErrorBody.parse(await lost.json()).error.retryable).toBe(true);
  });
});

describe("platform.internal's registration and the upgrade answer", () => {
  it("refuses a caller whose props are not the server's", async () => {
    for (const props of [
      undefined,
      { propsVersion: 1, caller: "computer" },
      { propsVersion: 2, caller: "omnigent-server" },
    ]) {
      const response = await entry
        .PlatformInternal({ props })
        .fetch("http://platform.internal/launcher/prepare", {
          method: "POST",
          body: "{}",
        });
      expect(response.status).toBe(503);
      await response.arrayBuffer();
    }
  });

  it("answers an upgrade with a bare 101 that carries at most the subprotocol", () => {
    const pair = new WebSocketPair();
    const upstream = new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "omnigent.v1" },
    });
    const answer = serverUpgradeAnswer(upstream);
    expect(answer.status).toBe(101);
    expect([...answer.headers.keys()]).toEqual(["sec-websocket-protocol"]);
    expect(answer.webSocket).toBe(pair[0]);
  });
});

describe("egress/backups.ts: the Sandbox SDK's DirectoryBackup", () => {
  it("deletes a layer's object under the computer's own prefix only, without a container", async () => {
    const bucket = (env as unknown as { CHECKPOINTS: R2Bucket }).CHECKPOINTS;
    const id = "00000000-0000-4000-8000-0000000000aa";
    await bucket.put(`workspace/cmp_a/${id}.tar.zst`, "layer of a");
    await bucket.put(`workspace/cmp_b/${id}.tar.zst`, "layer of b");
    const noContainer = {
      exec: () => {
        throw new Error("no container in this test");
      },
      interceptOutboundHttp: () => {
        throw new Error("no container in this test");
      },
    } as unknown as Container;
    const backups = directoryBackups(
      noContainer,
      exports as unknown as Parameters<typeof directoryBackups>[1],
    );
    const record = {
      id,
      dir: "/stage/layer",
      size: 10,
      sha256: "0".repeat(64),
      format: "tar+zstd/1",
    } as const;
    await backups("workspace/cmp_a/").delete(record);
    expect(await bucket.head(`workspace/cmp_a/${id}.tar.zst`)).toBeNull();
    expect(await bucket.head(`workspace/cmp_b/${id}.tar.zst`)).not.toBeNull();
    // Deleting a gone object succeeds.
    await backups("workspace/cmp_a/").delete(record);
  });
});
