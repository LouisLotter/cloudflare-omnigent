// The private virtual hosts through their real entrypoints, bindings and RPC (WP3.3), against the
// assembled controllers (WP3.18): the real WorkspaceDO and ControlDO, with only the containers and
// the clocks simulated (test/support/assembly-harness.ts, runtime-container.ts).
//   - `omnigent.internal` → OmnigentRoute → WorkspaceDO's `identity` → the real OmnigentServer →
//     its (fake) container's port;
//   - `computer.internal` → ComputerApi → WorkspaceDO;
//   - `platform.internal` → PlatformInternal → ControlDO and WorkspaceDO, as registered by
//     OmnigentServer on its own container;
//   - the backup gateway → WorkspaceDO's `writeAllowed` → local R2.
// One case keeps an inline stand-in, because a real WorkspaceDO cannot produce it on demand: a
// WorkspaceDO that answers "allowed" and moves on before the gateway's put lands (the late write).
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  type ComputerId,
  ControlResult,
  ErrorBody,
  type InterceptProps,
  signLauncherRequest,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  credentialWriter,
  directoryBackups,
  FencedBackupGateway,
  type GatewayExports,
} from "../../src/egress/backups.ts";
import { OmnigentRoute } from "../../src/internal/entrypoints.ts";
import { LAUNCH_TOKEN_HEADER } from "../../src/internal/omnigent-route.ts";
import { serverUpgradeAnswer } from "../../src/internal/upgrade-answer.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { CONTROL_OBJECT_NAME, OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import {
  type Computer,
  currentProps,
  entry,
  hostId,
  identityOf,
  provision,
  roomyControl,
  sleep,
  wake,
} from "../support/assembled.ts";
import { assembly } from "../support/assembly-harness.ts";
import { defined } from "../support/defined.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const TOKEN_A = "cfo-canary-launch-token-a-0123456789abcdef";
const encoder = new TextEncoder();

/** A computer awake at generation 1 with its host started under `host`. */
async function awake(host = hostId()): Promise<Computer & { readonly host: string }> {
  const c = await provision();
  await wake(c, { hostId: host, token: TOKEN_A });
  return { ...c, host };
}

/** The same computer one sleep and wake later: generation 2, the same host. */
async function nextGeneration(c: Computer & { readonly host: string }): Promise<void> {
  expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
  await wake(c, { hostId: c.host, token: TOKEN_A });
}

/** The computer's live connection, as its container reaches it, with these props. */
function routeFor(props: InterceptProps): Fetcher {
  return entry.OmnigentRoute({ props });
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

beforeAll(() => roomyControl());

beforeEach(() => {
  fake.handler = null;
  assembly.loseCalls = 0;
});

describe("omnigent.internal: the live connection (A′)", () => {
  it("forwards a computer's HTTP call to port 8000 once, trust headers stripped", async () => {
    const c = await awake();
    const route = routeFor(currentProps(c));
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

  it("is the target WorkspaceDO registered, bound to its generation and host (WP3.18)", async () => {
    const c = await awake();
    expect(currentProps(c)).toEqual({
      propsVersion: 1,
      computerId: c.computerId,
      generation: 1,
      hostId: c.host,
    });
    // The intercept the container actually holds, called in the context that registered it.
    const registered = defined(c.container.intercepts.get("omnigent.internal"), "an intercept");
    const status = await runInDurableObject(c.stub, async () => {
      const response = await registered.fetch("http://omnigent.internal/v1/info");
      await response.arrayBuffer();
      return response.status;
    });
    expect(status).toBe(200);
    expect(c.container.registrations).not.toContain("platform.internal");
  });

  it("reaches only port 8000, whatever port the computer names", async () => {
    const c = await awake();
    const before = fake.requests.length;
    const response = await routeFor(currentProps(c)).fetch(
      "http://omnigent.internal:8001/position",
    );
    await response.arrayBuffer();
    const sent = fake.requests.slice(before);
    expect(sent.map((r) => r.port)).toEqual([8000]);
  });

  it("refuses a blocked path before the server sees it", async () => {
    const route = routeFor(currentProps(await awake()));
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
    const route = routeFor(currentProps(await awake()));
    const before = fake.requests.length;
    const response = await route.fetch("http://omnigent.internal/auth/users", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    expect(fake.requests.length).toBe(before);
  });

  it("refuses a call from an older generation once WorkspaceDO runs a newer one", async () => {
    const c = await awake();
    const old = routeFor(currentProps(c));
    await nextGeneration(c);
    expect(currentProps(c).generation).toBe(2);
    const response = await old.fetch("http://omnigent.internal/v1/info");
    expect(response.status).toBe(409);
    expect(ErrorBody.parse(await response.json()).error.code).toBe("stale_generation");
    const current = await routeFor(currentProps(c)).fetch("http://omnigent.internal/v1/info");
    expect(current.status).toBe(200);
    await current.arrayBuffer();
  });

  it("fails closed when WorkspaceDO does not answer, after one more read", async () => {
    const route = routeFor(currentProps(await awake()));
    assembly.loseCalls = 2;
    const response = await route.fetch("http://omnigent.internal/v1/info");
    expect(response.status).toBe(503);
    await response.arrayBuffer();
    // One lost read is repeated once: the request goes through.
    assembly.loseCalls = 1;
    const second = await route.fetch("http://omnigent.internal/v1/info");
    expect(second.status).toBe(200);
    await second.arrayBuffer();
  });

  it("fails closed for a computer WorkspaceDO has no record of", async () => {
    const response = await routeFor({
      propsVersion: 1,
      computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0zzzz" as ComputerId,
      generation: 1,
      hostId: null,
    }).fetch("http://omnigent.internal/v1/info");
    expect(response.status).toBe(503);
    await response.arrayBuffer();
  });

  it("refuses props the handler does not know", async () => {
    const c = await provision();
    const route = entry.OmnigentRoute({
      props: { propsVersion: 2, computerId: c.computerId, generation: 0, hostId: null },
    });
    expect((await route.fetch("http://omnigent.internal/v1/info")).status).toBe(503);
    const none = entry.OmnigentRoute({ props: undefined });
    expect((await none.fetch("http://omnigent.internal/v1/info")).status).toBe(503);
  });

  it("carries the computer's own host tunnel: a bare 101, binary frames unchanged both ways", async () => {
    const c = await awake();
    const response = await routeFor(currentProps(c)).fetch(
      `http://omnigent.internal/v1/hosts/${c.host}/tunnel`,
      {
        headers: {
          upgrade: "websocket",
          "sec-websocket-protocol": "omnigent.v1",
          [LAUNCH_TOKEN_HEADER]: TOKEN_A,
        },
      },
    );
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
    const c = await awake();
    const other = await awake();
    const route = routeFor(currentProps(c));
    const before = fake.requests.length;
    for (const [host, headers] of [
      [other.host, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }],
      [other.host, { authorization: "Bearer owner" }],
      [c.host, { authorization: "Bearer owner" }],
      [c.host, { [LAUNCH_TOKEN_HEADER]: TOKEN_A, authorization: "Bearer owner" }],
    ] as const) {
      const response = await route.fetch(`http://omnigent.internal/v1/hosts/${host}/tunnel`, {
        headers: { upgrade: "websocket", ...headers },
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect(fake.requests.length).toBe(before);
  });

  it("reads the page state only from a WorkspaceDO that has no `identity` yet (a deploy's window)", async () => {
    const c = await awake();
    const real = env.WORKSPACE.getByName(c.computerId);
    /** An older WorkspaceDO: `identity` is not a method it implements; otherwise the real one. */
    const routeWith = (identity: () => Promise<unknown>) =>
      new OmnigentRoute(
        { props: currentProps(c), waitUntil: () => undefined } as unknown as ExecutionContext,
        {
          ...(env as unknown as Record<string, unknown>),
          WORKSPACE: { getByName: () => ({ identity, pages: (call: never) => real.pages(call) }) },
        } as never,
      );
    const older = routeWith(async () => {
      throw new TypeError('The RPC receiver does not implement the method "identity".');
    });
    const response = await older.fetch(new Request("http://omnigent.internal/v1/info"));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    // Any other failure is not read as an older version: the route fails closed.
    const failing = routeWith(async () => {
      throw new Error("Network connection lost.");
    });
    const refused = await failing.fetch(new Request("http://omnigent.internal/v1/info"));
    expect(refused.status).toBe(503);
    await refused.arrayBuffer();
  });

  it("reads the identity WorkspaceDO's `identity` answers: generation and the bound host", async () => {
    const c = await provision();
    expect(await identityOf(c)).toEqual({ computerId: c.computerId, generation: 0, hostId: null });
    await wake(c, { hostId: hostId(), token: TOKEN_A });
    expect(await identityOf(c)).toMatchObject({ generation: 1, hostId: currentProps(c).hostId });
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
    const c = await awake();
    const api = entry.ComputerApi({ props: currentProps(c) });
    const response = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(c.computerId, 1)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "hello", protocolVersion: 1 });
    // The supervisor's own messages took the same path (through the registered intercept).
    expect(c.container.sim.sup?.sent.map((m) => m.type)).toContain("hello");
  });

  it("repeats the call after a lost connection to WorkspaceDO", async () => {
    const c = await awake();
    assembly.loseCalls = 2;
    const api = entry.ComputerApi({ props: currentProps(c) });
    const response = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(c.computerId, 1)),
    });
    expect(response.status).toBe(200);
    expect(assembly.loseCalls).toBe(0);
  });

  it("refuses a message naming another generation, and WorkspaceDO's own refusals pass through", async () => {
    const c = await awake();
    const oldProps = currentProps(c);
    await nextGeneration(c);
    const api = entry.ComputerApi({ props: currentProps(c) });
    const other = await api.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(c.computerId, 1)),
    });
    expect(other.status).toBe(409);
    await other.arrayBuffer();
    // Props from an older generation than WorkspaceDO's: refused by WorkspaceDO itself.
    const oldApi = entry.ComputerApi({ props: oldProps });
    const stale = await oldApi.fetch("http://computer.internal/v1/messages", {
      method: "POST",
      body: JSON.stringify(hello(c.computerId, 1)),
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

  const opId = () => crypto.randomUUID().replaceAll("-", "");
  const control = () => env.CONTROL.getByName(CONTROL_OBJECT_NAME);

  it("provisions through ControlDO and the computer's WorkspaceDO, with the Worker's keys", async () => {
    const name = `managed-${opId()}`;
    const response = await api().fetch(
      await signedCall({ protocolVersion: 1, operationId: opId(), operation: "provision", name }),
    );
    expect(response.status).toBe(200);
    const { computerId } = (await response.json()) as { computerId: ComputerId };
    // ControlDO registered the name; the WorkspaceDO it names recorded the computer.
    const listed = ControlResult.parse(
      await control().control({ method: "list_computers", interfaceVersion: 1 }),
    );
    expect(listed.method === "list_computers" && listed.computers).toContainEqual({
      computerId,
      name,
    });
    const workspace = env.WORKSPACE.getByName(computerId);
    expect(await workspace.identity({ interfaceVersion: WORKSPACE_INTERFACE_VERSION })).toEqual({
      computerId,
      generation: 0,
      hostId: null,
    });
  });

  it("frames its replies with an exact Content-Length, through the real entrypoint (WP3.6)", async () => {
    const { computerId } = await provision();
    for (const request of [
      await signedCall({
        protocolVersion: 1,
        operationId: opId(),
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
    const { computerId } = await provision();
    const response = await api().fetch(
      await signedCall(
        { protocolVersion: 1, operationId: opId(), operation: "status", computerId },
        "cfo-canary-launcher-key-previous-000000000",
        "k-test-previous",
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: "status", status: "stopped" });
  });

  it("refuses an unsigned call (an SSRF) and a lost WorkspaceDO answer is retryable", async () => {
    const { computerId } = await provision();
    const unsigned = await api().fetch("http://platform.internal/launcher/resume", {
      method: "POST",
      body: JSON.stringify({
        protocolVersion: 1,
        operationId: opId(),
        operation: "resume",
        computerId,
      }),
    });
    expect(unsigned.status).toBe(401);
    expect(await identityOf({ stub: env.WORKSPACE.getByName(computerId) } as never)).toMatchObject({
      generation: 0,
    });
    assembly.loseCalls = 1;
    const lost = await api().fetch(
      await signedCall({
        protocolVersion: 1,
        operationId: opId(),
        operation: "status",
        computerId,
      }),
    );
    expect(lost.status).toBe(503);
    expect(ErrorBody.parse(await lost.json()).error.retryable).toBe(true);
  });

  it("answers a sleep asked for after a removal with 410 gone, as the launcher expects (3.C, 3.6)", async () => {
    const c = await awake();
    const terminated = await api().fetch(
      await signedCall({
        protocolVersion: 1,
        operationId: opId(),
        operation: "terminate",
        computerId: c.computerId,
      }),
    );
    expect(await terminated.json()).toEqual({ operation: "terminate", removal: "pending" });
    const suspend = {
      protocolVersion: 1,
      operationId: opId(),
      operation: "suspend",
      computerId: c.computerId,
    };
    for (const attempt of [1, 2]) {
      const response = await api().fetch(await signedCall(suspend));
      expect(response.status, `attempt ${attempt}`).toBe(410);
      expect(ErrorBody.parse(await response.json()).error.code).toBe("gone");
    }
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

  const fenceOf = (computerId: ComputerId, generation: number, kind = "workspace") => ({
    fenceVersion: 1,
    computerId,
    generation,
    kind,
  });
  const layerProps = (
    computerId: ComputerId,
    key: string,
    generation: number,
    extra: Record<string, unknown>,
  ) => ({
    protocolVersion: 1,
    binding: "CHECKPOINTS",
    key,
    fence: fenceOf(computerId, generation),
    ...extra,
  });
  const putPart = (gateway: Fetcher, part: Uint8Array) =>
    gateway.fetch(
      new Request("http://backups.sandbox.internal/parts/1", {
        method: "PUT",
        headers: { "content-length": String(part.byteLength) },
        body: part,
      }),
    );
  const layerKey = (computerId: ComputerId, n: string) =>
    `workspace/${computerId}/00000000-0000-4000-8000-${n.padStart(12, "0")}.tar.zst`;

  it("asks the real WorkspaceDO, which admits only the running generation's writes", async () => {
    const c = await awake();
    const key = layerKey(c.computerId, "a1");
    const control = (generation: number) =>
      gateways.DirectoryBackupGateway({
        props: layerProps(c.computerId, key, generation, { mode: "control" }),
      });
    const uploadId = await control(1).createUpload("layer");
    await control(1).abortUpload(uploadId);
    await nextGeneration(c);
    // Generation 1's container is gone: its writes are refused before R2 is touched.
    await expect(control(1).createUpload("layer")).rejects.toThrow(/stale_generation/);
    const current = await control(2).createUpload("layer");
    await control(2).abortUpload(current);
    // A credential key that is not one of WorkspaceDO's pending uploads.
    const credential = `credentials/${c.computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n4.json`;
    await expect(
      credentialWriter(gateways, { computerId: c.computerId, generation: 2 }).put(
        credential,
        encoder.encode("{}"),
      ),
    ).rejects.toThrow(/not_pending/);
    expect(await bucket().head(credential)).toBeNull();
  });

  it("refuses another computer's key, an unreachable WorkspaceDO, and a computer it has no record of", async () => {
    const c = await awake();
    const body = encoder.encode("{}");
    const writer = credentialWriter(gateways, { computerId: c.computerId, generation: 1 });
    await expect(
      writer.put("credentials/cmp_01hzy3m8k6q4t2v9w7x5r0s1n9/ckp_x.json", body),
    ).rejects.toThrow(/foreign_key/);
    assembly.loseCalls = 1;
    await expect(
      writer.put(`credentials/${c.computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n5.json`, body),
    ).rejects.toThrow(/workspace_unreachable/);
    const unknown = "cmp_01hzy3m8k6q4t2v9w7x5r0yyyy" as ComputerId;
    await expect(
      credentialWriter(gateways, { computerId: unknown, generation: 0 }).put(
        `credentials/${unknown}/ckp_01hzy3m8k6q4t2v9w7x5r0s1n6.json`,
        body,
      ),
    ).rejects.toThrow(/unknown_computer/);
  });

  it("refuses every write for a fully removed computer, but not for a removal intent alone", async () => {
    // A removal intent alone: the running generation's writes are still admitted (the removal's
    // sign-out run uploads its tombstones).
    const c = await awake();
    expect(await c.client.send(c.client.terminateRequest())).toEqual({
      operation: "terminate",
      removal: "pending",
    });
    const key = layerKey(c.computerId, "b1");
    const control = gateways.DirectoryBackupGateway({
      props: layerProps(c.computerId, key, 1, { mode: "control" }),
    });
    await control.abortUpload(await control.createUpload("layer"));
    // A computer whose removal is resolved (it never held a login, so nothing is left to sign out).
    const r = await provision();
    await r.client.send(r.client.terminateRequest());
    expect(
      await r.stub.pages({
        action: "resolve_removal",
        interfaceVersion: WORKSPACE_INTERFACE_VERSION,
        operationId: "op_01hzy3m8k6q4t2v9w7x5r0s1n3",
      }),
    ).toMatchObject({ action: "resolve_removal", outcome: "accepted" });
    const removed = layerKey(r.computerId, "b2");
    await expect(
      gateways
        .DirectoryBackupGateway({
          props: layerProps(r.computerId, removed, 0, { mode: "control" }),
        })
        .createUpload("layer"),
    ).rejects.toThrow(/removed/);
    expect(await bucket().head(removed)).toBeNull();
  });

  it("fences a layer's upload: the create, each part from the container, and the publication", async () => {
    const c = await awake();
    await nextGeneration(c);
    const key = layerKey(c.computerId, "bb");
    const props = (generation: number, extra: Record<string, unknown>) =>
      layerProps(c.computerId, key, generation, extra);
    const control = (generation: number) =>
      gateways.DirectoryBackupGateway({ props: props(generation, { mode: "control" }) });
    // Refused for a stale generation, before R2 is touched.
    await expect(control(1).createUpload("layer")).rejects.toThrow(/stale_generation/);
    const uploadId = await control(2).createUpload("layer");
    const part = new Uint8Array(1024).fill(7);
    const write = (generation: number) =>
      gateways.DirectoryBackupGateway({ props: props(generation, { mode: "write", uploadId }) });
    const stalePart = await putPart(write(1), part);
    expect(stalePart.status).toBe(403);
    await stalePart.arrayBuffer();
    const goodPart = await putPart(write(2), part);
    expect(goodPart.status).toBe(200);
    const { etag } = (await goodPart.json()) as { etag: string };
    // The generation moves on before publication: the object never appears.
    await nextGeneration(c);
    await expect(control(2).completeUpload(uploadId, [{ partNumber: 1, etag }])).rejects.toThrow(
      /stale_generation/,
    );
    expect(await bucket().head(key)).toBeNull();
    await control(3).abortUpload(uploadId);
  });

  it("publishes a layer for the current generation, and still deletes without asking", async () => {
    const c = await awake();
    const key = layerKey(c.computerId, "cc");
    const props = (extra: Record<string, unknown>) => ({
      props: layerProps(c.computerId, key, 1, extra),
    });
    const control = gateways.DirectoryBackupGateway(props({ mode: "control" }));
    const uploadId = await control.createUpload("layer");
    const part = new Uint8Array(2048).fill(9);
    const uploaded = await putPart(
      gateways.DirectoryBackupGateway(props({ mode: "write", uploadId })),
      part,
    );
    const { etag } = (await uploaded.json()) as { etag: string };
    expect(await control.completeUpload(uploadId, [{ partNumber: 1, etag }])).toBe(2048);
    expect((await bucket().head(key))?.size).toBe(2048);
    // A removal does not stop deletes: the SDK's DirectoryBackup deletes it, with no fence at all.
    await c.client.send(c.client.terminateRequest());
    const backups = directoryBackups(noContainer, gateways, null);
    const record = {
      id: key.slice(`workspace/${c.computerId}/`.length, -".tar.zst".length),
      dir: "/stage/layer",
      size: 2048,
      sha256: "0".repeat(64),
      format: "tar+zstd/1",
    } as const;
    await backups(`workspace/${c.computerId}/`).delete(record);
    expect(await bucket().head(key)).toBeNull();
  });

  it("refuses every write through a DirectoryBackup built with no writer (a restore's or a delete's)", async () => {
    const c = await awake();
    const key = layerKey(c.computerId, "dd");
    // No fence in the props: the gateway refuses without asking WorkspaceDO.
    const unfenced = gateways.DirectoryBackupGateway({
      props: { protocolVersion: 1, binding: "CHECKPOINTS", key, mode: "control" },
    });
    await expect(unfenced.createUpload("layer")).rejects.toThrow(/unfenced/);
  });

  it("is the class the platform Worker exports as DirectoryBackupGateway (through real RPC)", async () => {
    const c = await awake();
    const key = layerKey(c.computerId, "ee");
    const exported = (exports as unknown as GatewayExports).DirectoryBackupGateway({
      props: layerProps(c.computerId, key, 1, { mode: "control" }),
    });
    const uploadId = await exported.createUpload("layer");
    expect(uploadId).toEqual(expect.any(String));
    await exported.abortUpload(uploadId);
  });

  // The lead's decision (26 Oct): the fence is admission control, not a drain. A write admitted
  // just before WorkspaceDO moves on still lands; WP3.1 re-deletes tombstoned keys and sweeps a
  // removed computer's prefixes, and reads only named objects. A late layer cannot overwrite a
  // current one, because every backup has its own object key (the SDK's crypto.randomUUID()).
  //
  // The one inline stand-in in this file (WP3.18): a real WorkspaceDO cannot be made to answer
  // "allowed" and then move on before the gateway's put lands, deterministically. When racing,
  // the stand-in admits and moves on at once after each answer; otherwise it admits only the
  // current generation, as the real policy does.
  it("lets a write admitted just before the fence moves land late, under its own key (admission control, not a drain)", async () => {
    const computerId = "cmp_01hzy3m8k6q4t2v9w7x5r0s1p9" as ComputerId;
    const fake = { generation: 3 };
    const gatewayWith = (racing: boolean) => (props: Record<string, unknown>) =>
      new FencedBackupGateway(
        {
          props,
          waitUntil: () => undefined,
          passThroughOnException: () => undefined,
        } as unknown as ExecutionContext,
        {
          ...(env as unknown as Record<string, unknown>),
          WORKSPACE: {
            getByName: () => ({
              writeAllowed: async (check: { generation: number }) => {
                if (racing) {
                  fake.generation += 1; // the move, after the answer, before the put
                  return { allowed: true };
                }
                return check.generation === fake.generation
                  ? { allowed: true }
                  : { allowed: false, reason: "stale_generation" };
              },
            }),
          },
        } as never,
      );
    /** The real gateway, with a WorkspaceDO that answers "allowed" and moves on at once after. */
    const racingGateway = gatewayWith(true);
    const steadyGateway = gatewayWith(false);
    // A credential bundle admitted at generation 3 lands although generation 4 now runs; it is
    // left for WP3.1's re-delete of tombstoned keys and its sweep.
    const lateKey = `credentials/${computerId}/ckp_01hzy3m8k6q4t2v9w7x5r0s1p0.json`;
    await racingGateway({
      protocolVersion: 1,
      mode: "control",
      binding: "CHECKPOINTS",
      key: lateKey,
      fence: { fenceVersion: 1, computerId, generation: 3, kind: "credential" },
    }).putCredential(new TextEncoder().encode('{"late":true}'));
    expect(await bucket().head(lateKey)).not.toBeNull();
    await bucket().delete(lateKey); // WP3.1's re-delete or sweep
    expect(await bucket().head(lateKey)).toBeNull();

    // A current layer (generation 5) is published; a stale-generation layer admitted just before
    // the move then lands under its own backup ID, and the current layer is untouched.
    fake.generation = 5;
    const currentKey = `workspace/${computerId}/00000000-0000-4000-8000-0000000000dd.tar.zst`;
    const staleKey = `workspace/${computerId}/00000000-0000-4000-8000-0000000000ee.tar.zst`;
    const publish = async (
      key: string,
      generation: number,
      fill: number,
      gateway: (
        p: Record<string, unknown>,
      ) => ReturnType<GatewayExports["DirectoryBackupGateway"]> | FencedBackupGateway,
    ) => {
      const base = {
        protocolVersion: 1,
        binding: "CHECKPOINTS",
        key,
        fence: { fenceVersion: 1, computerId, generation, kind: "workspace" },
      };
      const control = gateway({ ...base, mode: "control" });
      const uploadId = await control.createUpload("layer");
      const part = new Uint8Array(1024).fill(fill);
      const uploaded = await gateway({ ...base, mode: "write", uploadId }).fetch(
        new Request("http://backups.sandbox.internal/parts/1", {
          method: "PUT",
          headers: { "content-length": String(part.byteLength) },
          body: part,
        }),
      );
      const { etag } = (await uploaded.json()) as { etag: string };
      return control.completeUpload(uploadId, [{ partNumber: 1, etag }]);
    };
    await publish(currentKey, 5, 1, steadyGateway);
    const before = await bucket().get(currentKey);
    const beforeBytes = new Uint8Array(await (before as R2ObjectBody).arrayBuffer());
    // The stale writer: each of its checks is answered "allowed" for generation 5 just before
    // the generation moves on, as a racing WorkspaceDO would.
    fake.generation = 5;
    await publish(staleKey, 5, 2, (props) => {
      fake.generation = 5;
      return racingGateway(props);
    });
    expect(fake.generation).toBeGreaterThan(5); // WorkspaceDO moved on after each admission
    const current = await bucket().get(currentKey);
    expect(new Uint8Array(await (current as R2ObjectBody).arrayBuffer())).toEqual(beforeBytes);
    expect(await bucket().head(staleKey)).not.toBeNull();
    expect(currentKey).not.toBe(staleKey);
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
