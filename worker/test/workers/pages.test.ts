// The platform pages end to end inside workerd (WP3.5): web.ts's routes → the WORKSPACE binding →
// the real WorkspaceDO (page front, controller, terminal bridge) → a simulated computer whose
// terminal port runs a fake ttyd. Ingress (WP2.1) is replaced by a fabricated admission; its own
// tests cover it, and one test here drives web.ts's handler to show the pages sit behind it.
import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ComputerId,
  PagesResult,
  type SupervisorMessage,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { OMNIGENT_SERVER_OBJECT_NAME, workspaceObjectName } from "../../src/shared/rpc.ts";
import web, { routeAdmitted } from "../../src/web.ts";
import { FakeLauncherClient } from "../support/fake-launcher-client.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import type { SimulatedComputer } from "../support/fake-supervisor.ts";
import type { WorkspaceDO } from "../support/platform-test-worker.ts";
import { testServers } from "../support/server-harness.ts";
import { testComputers } from "../support/workspace-harness.ts";

type Stub = DurableObjectStub<WorkspaceDO>;
const workspaces = (env as unknown as { WORKSPACE_CONTROLLER: DurableObjectNamespace<WorkspaceDO> })
  .WORKSPACE_CONTROLLER;
const ORIGIN = "https://omnigent.example.test";
const OWNER = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };

/** Every method the pages called on a WorkspaceDO stub: they may call `pages` and `fetch` only. */
const calledMethods = new Set<string>();
const listed: { computerId: ComputerId; name: string }[] = [];

const webEnv = {
  OMNIGENT: env.OMNIGENT,
  WORKSPACE: {
    getByName(name: string) {
      const stub = workspaces.getByName(name);
      return new Proxy(stub, {
        get(target, prop) {
          if (typeof prop !== "string") return undefined;
          calledMethods.add(prop);
          // A stub's members are RPC calls: call them on the stub itself, never `bind` them.
          return (...args: unknown[]) =>
            (target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop]?.(...args);
        },
      });
    },
  },
  CONTROL: {
    getByName: () => ({
      control: async () => ({ method: "list_computers", computers: listed }),
    }),
  },
} as unknown as WebEnv;

let serial = 0;
let server: FakeServerContainer;

/** ttyd on the computer's terminal port: echoes each input frame back as output. */
function installTtyd(computer: SimulatedComputer) {
  const shells: WebSocket[] = [];
  computer.terminal = () => {
    const pair = new WebSocketPair();
    const shell = pair[1];
    shell.accept();
    shell.binaryType = "arraybuffer";
    shell.addEventListener("message", (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data[0] === 0x30) {
        const out = new Uint8Array(data.length);
        out.set(data);
        shell.send(out);
      }
    });
    shells.push(shell);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "tty" },
    });
  };
  return shells;
}

async function settle(stub: Stub, computer: SimulatedComputer): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await stub.settle();
    const sup = computer.sup;
    if (sup === null || sup.outbox.length === 0) return;
    await sup.flush((message: SupervisorMessage) =>
      stub.computer({
        ...call,
        props: {
          propsVersion: 1,
          computerId: computer.computerId,
          generation: message.generation,
          hostId: HOST,
        },
        message,
      }),
    );
  }
}

/** A computer that runs, restored, with a fake ttyd. */
async function running() {
  serial += 1;
  const computerId = `cmp_01hzy3m8k6q4t2v9w7x5r1${String(serial).padStart(4, "0")}` as ComputerId;
  const stub = workspaces.getByName(workspaceObjectName(computerId)) as Stub;
  const computer = testComputers.create(stub.id, computerId);
  const shells = installTtyd(computer);
  const client = new FakeLauncherClient(computerId, (request) =>
    stub.launcher({ ...call, request }),
  );
  await client.send(client.provisionRequest(`managed-${serial}`));
  await client.send(client.resumeRequest());
  await settle(stub, computer);
  listed.push({ computerId, name: `managed-${serial}` });
  return { computerId, stub, computer, shells, client, path: `/platform/computers/${computerId}` };
}

function admitted(path: string, init: RequestInit = {}): Admitted {
  return {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { ...OWNER, issuedAt: 1, expiresAt: 2 },
  };
}

async function route(path: string, init: RequestInit = {}): Promise<Response> {
  return routeAdmitted(admitted(path, init), webEnv, createExecutionContext());
}

async function intentOf(path: string): Promise<string> {
  const html = await (await route(path)).text();
  const match =
    /data-intent="([0-9a-f]{64})"/.exec(html) ?? /name="intent" value="([0-9a-f]{64})"/.exec(html);
  if (!match?.[1]) throw new Error("no intent token on the page");
  return match[1];
}

const OP = (n: number) => `op_${String(n).padStart(26, "0")}`;

async function terminalPost(path: string, body: Record<string, unknown>) {
  const response = await route(`${path}/terminal`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function open(path: string, n = 1): Promise<{ capability: string; window: number }> {
  const intent = await intentOf(path);
  const answer = await terminalPost(path, { op: OP(n), intent, mode: "open" });
  if (answer.outcome !== "accepted") throw new Error(`refused: ${JSON.stringify(answer)}`);
  return answer as unknown as { capability: string; window: number };
}

function upgrade(path: string, capability: string) {
  return route(`${path}/terminal`, {
    headers: {
      upgrade: "websocket",
      origin: ORIGIN,
      "sec-websocket-protocol": `tty, cfo-capability.${capability}`,
    },
  });
}

/** The browser's end of a bridged stream, with what it received and how it closed. */
function connectBrowser(response: Response) {
  const socket = response.webSocket;
  if (socket === null) throw new Error(`no socket: ${response.status}`);
  socket.accept();
  socket.binaryType = "arraybuffer";
  const received: ArrayBuffer[] = [];
  let resolveClosed: (event: CloseEvent) => void = () => undefined;
  const closed = new Promise<CloseEvent>((resolve) => {
    resolveClosed = resolve;
  });
  socket.addEventListener("message", (event) => received.push(event.data as ArrayBuffer));
  socket.addEventListener("close", (event) => resolveClosed(event));
  return { socket, received, closed };
}

const until = async (condition: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  calledMethods.clear();
  server = testServers.create(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME));
  server.running = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the pages through the real WorkspaceDO", () => {
  it("serve the computers page and the setup page, and never reach Omnigent", async () => {
    const { computerId, path } = await running();
    const list = await route("/platform/computers");
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(`data-computer="${computerId}"`);
    const page = await route(path);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Only the replication status, on the control port: nothing reached Omnigent's own port.
    expect(server.requests.filter((r) => r.port !== 8001)).toEqual([]);
    expect([...calledMethods].filter((m) => !["pages", "fetch"].includes(m))).toEqual([]);
  });

  it("apply a guarded change once, with the session's intent token", async () => {
    const { stub, path } = await running();
    const intent = await intentOf(path);
    const post = (token: string, origin = ORIGIN) =>
      route(`${path}/do/set-size`, {
        method: "POST",
        headers: { origin, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ op: OP(5), intent: token, size: "standard-3" }).toString(),
      });
    expect((await post(intent, "https://evil.example")).status).toBe(403);
    expect((await post("0".repeat(64))).status).toBe(403);
    const done = await post(intent);
    expect(done.status).toBe(303);
    const state = PagesResult.parse(await stub.pages({ ...call, action: "state" }));
    expect(state.action === "state" && state.computer).toMatchObject({ nextSize: "standard-3" });
  });

  it("sit behind ingress: an unadmitted request reaches no Durable Object", async () => {
    const response = await web.fetch(
      new Request(`${ORIGIN}/platform/computers`),
      webEnv,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(calledMethods.size).toBe(0);
  });
});

describe("the pages' assets", () => {
  it("serve xterm.js, its fit add-on and the setup page's script as text from this origin", async () => {
    for (const [name, type, marker] of [
      ["xterm.js", "text/javascript; charset=utf-8", "Terminal"],
      ["addon-fit.js", "text/javascript; charset=utf-8", "FitAddon"],
      ["setup-client.js", "text/javascript; charset=utf-8", "cfo-capability."],
      ["xterm.css", "text/css; charset=utf-8", ".xterm"],
      ["pages.css", "text/css; charset=utf-8", ".terminal-panel"],
    ] as const) {
      const response = await route(`/platform/assets/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain(marker);
    }
  });
});

describe("the bridged terminal (R-29, RC-24)", () => {
  it("bridges binary frames both ways unchanged, answering with only the subprotocol", async () => {
    const { path } = await running();
    const { capability } = await open(path);
    const response = await upgrade(path, capability);
    expect(response.status).toBe(101);
    expect([...response.headers]).toEqual([["sec-websocket-protocol", "tty"]]);
    const browser = connectBrowser(response);
    const frame = new Uint8Array([0x30, 0x00, 0xff, 0x80, 0x7f, 0x0a]);
    browser.socket.send(frame);
    await until(() => browser.received.length === 1);
    expect([...new Uint8Array(browser.received[0] as ArrayBuffer)]).toEqual([...frame]);
    browser.socket.close(1000, "done");
  });

  it("refuses a replay and the same capability used twice at once", async () => {
    const { path } = await running();
    const { capability } = await open(path);
    const [a, b] = await Promise.all([upgrade(path, capability), upgrade(path, capability)]);
    expect([a.status, b.status].sort()).toEqual([101, 403]);
    expect((await upgrade(path, capability)).status).toBe(403);
    (a.webSocket ?? b.webSocket)?.accept();
  });

  it("logs nothing the terminal carries", async () => {
    const { path } = await running();
    const log = vi.spyOn(console, "log");
    const { capability } = await open(path);
    const browser = connectBrowser(await upgrade(path, capability));
    browser.socket.send(new TextEncoder().encode("0sign-in-code-canary-5521"));
    await until(() => browser.received.length === 1);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("sign-in-code-canary");
    expect(logged).not.toContain(capability);
    browser.socket.close(1000);
  });

  it("closes the stream before a restart reaches the computer", async () => {
    const { path, computer } = await running();
    const { capability } = await open(path);
    const browser = connectBrowser(await upgrade(path, capability));
    const stopsBefore = computer.stops.length;
    let stopsWhenClosed = -1;
    void browser.closed.then(() => {
      stopsWhenClosed = computer.stops.length;
    });
    const intent = await intentOf(path);
    const restart = await route(`${path}/do/restart`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ op: OP(9), intent }).toString(),
    });
    expect(restart.status).toBe(303);
    const event = await browser.closed;
    expect(event.code).toBe(4001);
    expect(stopsWhenClosed).toBe(stopsBefore);
  });

  it("ends the stream at its deadline, and the capability's window with it", async () => {
    const { path } = await running();
    const opened = await open(path);
    const spare = (await terminalPost(path, {
      op: OP(2),
      intent: await intentOf(path),
      mode: "reconnect",
      window: opened.window,
    })) as { capability: string };
    const browser = connectBrowser(await upgrade(path, opened.capability));
    testComputers.advance(31 * 60_000);
    const event = await browser.closed;
    expect(event.code).toBe(4001);
    expect((await upgrade(path, spare.capability)).status).toBe(403);
  });

  it("ends the stream when Omnigent removes the computer", async () => {
    const { path, client } = await running();
    const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
    await client.send(client.terminateRequest());
    expect((await browser.closed).code).toBe(4001);
  });

  it("ends the stream when the computer's generation changes", async () => {
    const { path, computer, stub } = await running();
    const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
    computer.stopByPlatform();
    // The alarm records the unexpected stop; the bridge's next check sees the computer gone.
    testComputers.advance(60_000);
    await stub.settle().catch(() => undefined);
    await (await import("cloudflare:test")).runDurableObjectAlarm(stub);
    const event = await browser.closed;
    expect(event.code).toBe(4001);
  });

  it("drops with a Durable Object restart; a replay fails, a fresh capability reconnects", async () => {
    const { path, stub } = await running();
    const opened = await open(path);
    const browser = connectBrowser(await upgrade(path, opened.capability));
    // A reset of the object, as a platform deploy or a crash ends it.
    await runInDurableObject(stub, (_instance, state) => {
      try {
        state.abort("test restart");
      } catch {
        // abort() throws in the current request by design
      }
    }).catch(() => undefined);
    const event = await browser.closed;
    expect(event.code).not.toBe(1000);
    expect((await upgrade(path, opened.capability)).status).toBe(403);
    const fresh = (await terminalPost(path, {
      op: OP(3),
      intent: await intentOf(path),
      mode: "reconnect",
      window: opened.window,
    })) as { outcome: string; capability: string };
    expect(fresh.outcome).toBe("accepted");
    const again = await upgrade(path, fresh.capability);
    expect(again.status).toBe(101);
    again.webSocket?.accept();
    again.webSocket?.close(1000);
  });

  it("reattaches a dropped browser stream to the same shell (FH-38)", async () => {
    const { path, shells } = await running();
    const opened = await open(path);
    const first = connectBrowser(await upgrade(path, opened.capability));
    first.socket.close(1001, "page reloaded");
    await until(() => shells.length === 1);
    const fresh = (await terminalPost(path, {
      op: OP(4),
      intent: await intentOf(path),
      mode: "reconnect",
      window: opened.window,
    })) as { capability: string };
    const second = connectBrowser(await upgrade(path, fresh.capability));
    second.socket.send(new Uint8Array([0x30, 0x41]));
    await until(() => second.received.length === 1);
    expect(shells).toHaveLength(1);
    second.socket.close(1000);
  });
});
