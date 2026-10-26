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
import {
  credentialWriter,
  directoryBackups,
  FencedBackupGateway,
  type GatewayExports,
} from "../../src/egress/backups.ts";
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

describe("egress/backups.ts: the fenced backup gateway (the write fence)", () => {
  const bucket = () => (env as unknown as { CHECKPOINTS: R2Bucket }).CHECKPOINTS;
  // The real gateway class, constructed in this context with the test Worker's env, so that a
  // refusal is an ordinary rejection here rather than one crossing RPC (which the vitest plugin
  // reports as unhandled; WP2.2's upstream candidate 1).
  const gateways: GatewayExports = {
    DirectoryBackupGateway: ({ props }) =>
      new FencedBackupGateway(
        {
          props,
          waitUntil: () => undefined,
          passThroughOnException: () => undefined,
        } as unknown as ExecutionContext,
        env as never,
      ) as unknown as ReturnType<GatewayExports["DirectoryBackupGateway"]>,
  };
  const noContainer = {
    exec: () => {
      throw new Error("no container in this test");
    },
    interceptOutboundHttp: () => {
      throw new Error("no container in this test");
    },
  } as unknown as Container;

  /** A computer at generation 3, running, as the fence sees it. */
  function liveComputer(): ComputerId {
    const computerId = newComputer();
    const fake = internalFakes.workspace(computerId);
    fake.fire("resume");
    fake.fire("container_running");
    fake.fire("restore_confirmed");
    fake.generation = 3;
    return computerId;
  }

  it("puts a pending credential bundle for the current generation", async () => {
    const computerId = liveComputer();
    const key = `credentials/${computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n3.json`;
    internalFakes.pendingCredentialKeys.add(key);
    await credentialWriter(gateways, { computerId, generation: 3 }).put(
      key,
      new TextEncoder().encode("{}"),
    );
    expect(await (await bucket().get(key))?.text()).toBe("{}");
  });

  it("refuses a removed computer, a stale generation, a key not pending, another computer's key, and an unreachable WorkspaceDO", async () => {
    const computerId = liveComputer();
    const key = `credentials/${computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n4.json`;
    internalFakes.pendingCredentialKeys.add(key);
    const body = new TextEncoder().encode("{}");
    const attempt = (generation: number, objectKey = key) =>
      credentialWriter(gateways, { computerId, generation }).put(objectKey, body);
    await expect(attempt(2)).rejects.toThrow(/stale_generation/);
    await expect(
      attempt(3, `credentials/${computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n5.json`),
    ).rejects.toThrow(/not_pending/);
    await expect(
      attempt(3, `credentials/cmp_01hzy3m8k6q4t2v9w7x5r0s1n9/ckp_x.json`),
    ).rejects.toThrow(/foreign_key/);
    internalFakes.loseWorkspaceCalls = 1;
    await expect(attempt(3)).rejects.toThrow(/workspace_unreachable/);
    // A removal intent: every later write is refused.
    internalFakes.workspace(computerId).fire("terminate");
    await expect(attempt(3)).rejects.toThrow(/removed/);
    expect(await bucket().head(key)).toBeNull();
    // An unknown computer.
    await expect(
      credentialWriter(gateways, { computerId: newComputer(), generation: 0 }).put(
        `credentials/${computerId}/x.json`,
        body,
      ),
    ).rejects.toThrow(/foreign_key|unknown_computer/);
  });

  it("fences a layer's upload: the create, each part from the container, and the publication", async () => {
    const computerId = liveComputer();
    const key = `workspace/${computerId}/00000000-0000-4000-8000-0000000000bb.tar.zst`;
    const props = (generation: number, extra: Record<string, unknown>) => ({
      protocolVersion: 1,
      binding: "CHECKPOINTS",
      key,
      fence: { fenceVersion: 1, computerId, generation, kind: "workspace" },
      ...extra,
    });
    const control = (generation: number) =>
      gateways.DirectoryBackupGateway({ props: props(generation, { mode: "control" }) });
    // Refused for a stale generation, before R2 is touched.
    await expect(control(2).createUpload("layer")).rejects.toThrow(/stale_generation/);
    const uploadId = await control(3).createUpload("layer");
    const part = new Uint8Array(1024).fill(7);
    const write = (generation: number) =>
      gateways.DirectoryBackupGateway({ props: props(generation, { mode: "write", uploadId }) });
    const stalePart = await write(2).fetch(
      new Request("http://backups.sandbox.internal/parts/1", {
        method: "PUT",
        headers: { "content-length": String(part.byteLength) },
        body: part,
      }),
    );
    expect(stalePart.status).toBe(403);
    await stalePart.arrayBuffer();
    const goodPart = await write(3).fetch(
      new Request("http://backups.sandbox.internal/parts/1", {
        method: "PUT",
        headers: { "content-length": String(part.byteLength) },
        body: part,
      }),
    );
    expect(goodPart.status).toBe(200);
    const { etag } = (await goodPart.json()) as { etag: string };
    // The generation moves on before publication: the object never appears.
    internalFakes.workspace(computerId).generation = 4;
    await expect(control(3).completeUpload(uploadId, [{ partNumber: 1, etag }])).rejects.toThrow(
      /stale_generation/,
    );
    expect(await bucket().head(key)).toBeNull();
    await control(4).abortUpload(uploadId);
  });

  it("publishes a layer for the current generation, and still deletes without asking", async () => {
    const computerId = liveComputer();
    const key = `workspace/${computerId}/00000000-0000-4000-8000-0000000000cc.tar.zst`;
    const props = (extra: Record<string, unknown>) => ({
      props: {
        protocolVersion: 1,
        binding: "CHECKPOINTS",
        key,
        fence: { fenceVersion: 1, computerId, generation: 3, kind: "workspace" },
        ...extra,
      },
    });
    const control = gateways.DirectoryBackupGateway(props({ mode: "control" }));
    const uploadId = await control.createUpload("layer");
    const part = new Uint8Array(2048).fill(9);
    const uploaded = await gateways
      .DirectoryBackupGateway(props({ mode: "write", uploadId }))
      .fetch(
        new Request("http://backups.sandbox.internal/parts/1", {
          method: "PUT",
          headers: { "content-length": String(part.byteLength) },
          body: part,
        }),
      );
    const { etag } = (await uploaded.json()) as { etag: string };
    expect(await control.completeUpload(uploadId, [{ partNumber: 1, etag }])).toBe(2048);
    expect((await bucket().head(key))?.size).toBe(2048);
    // A removal does not stop deletes: the SDK's DirectoryBackup, through the factory, deletes it.
    internalFakes.workspace(computerId).fire("terminate");
    const backups = directoryBackups(noContainer, gateways, { computerId, generation: 3 });
    const record = {
      id: "00000000-0000-4000-8000-0000000000cc",
      dir: "/stage/layer",
      size: 2048,
      sha256: "0".repeat(64),
      format: "tar+zstd/1",
    } as const;
    await backups(`workspace/${computerId}/`).delete(record);
    expect(await bucket().head(key)).toBeNull();
  });

  it("is the class the platform Worker exports as DirectoryBackupGateway (through real RPC)", async () => {
    const computerId = liveComputer();
    const key = `credentials/${computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n6.json`;
    internalFakes.pendingCredentialKeys.add(key);
    await credentialWriter(exports as unknown as GatewayExports, { computerId, generation: 3 }).put(
      key,
      new TextEncoder().encode("{}"),
    );
    expect(await bucket().head(key)).not.toBeNull();
  });

  it("refuses a write grant that carries no fence", async () => {
    const response = await gateways
      .DirectoryBackupGateway({
        props: {
          protocolVersion: 1,
          mode: "write",
          binding: "CHECKPOINTS",
          key: "workspace/x/y.tar.zst",
          uploadId: "u",
        },
      })
      .fetch(
        new Request("http://backups.sandbox.internal/parts/1", {
          method: "PUT",
          headers: { "content-length": "1" },
          body: "x",
        }),
      );
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/unfenced/);
  });
});
