// The platform pages end to end inside workerd (WP3.5): web.ts's routes → the WORKSPACE binding →
// the real WorkspaceDO (page front, controller, terminal bridge) → a simulated computer whose
// terminal port runs a fake ttyd. Ingress (WP2.1) is replaced by a fabricated admission; its own
// tests cover it, and one test here drives web.ts's handler to show the pages sit behind it.
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
import type { SimulatedComputer, SupervisorOptions } from "../support/fake-supervisor.ts";
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

const PID_QUESTION = new TextEncoder().encode("0echo $$\r");

/**
 * ttyd on the computer's terminal port, with the shells kept per window as tmux keeps them
 * (WP3.28): `new` starts or joins the window's session, `attach` joins it or ends the stream at
 * once (the wrapper exits), and no arguments is an older WorkspaceDO's dial (a new shell). Each
 * input frame is echoed back; `0echo $$\r` is answered with the session's number instead.
 */
function installTtyd(computer: SimulatedComputer) {
  const shells: WebSocket[] = [];
  const dialled: { mode: string | null; window: number | null }[] = [];
  let legacy = 1000;
  computer.terminal = (request) => {
    const args = new URL(request.url).searchParams.getAll("arg");
    const mode = args[0] ?? null;
    const window = args[1] === undefined ? null : Number(args[1]);
    dialled.push({ mode, window });
    const pair = new WebSocketPair();
    const shell = pair[1];
    shell.accept();
    shell.binaryType = "arraybuffer";
    const sessions = computer.terminalSessions;
    const session =
      mode === "new" && window !== null
        ? sessions.open(window)
        : mode === "attach" && window !== null
          ? sessions.attach(window)
          : { id: legacy++ };
    if (session === null) {
      // The wrapper exits before ttyd reads anything: the stream ends at once.
      setTimeout(() => shell.close(1000, ""), 5);
    }
    shell.addEventListener("message", (event) => {
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data[0] !== 0x30 || session === null) return;
      if (data.length === PID_QUESTION.length && data.every((b, i) => b === PID_QUESTION[i])) {
        shell.send(new TextEncoder().encode(`0pid=${session.id};`));
        return;
      }
      const out = new Uint8Array(data.length);
      out.set(data);
      shell.send(out);
    });
    shells.push(shell);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": "tty" },
    });
  };
  return Object.assign(shells, { dialled });
}

/** The shell's number, as `echo $$` would print it. */
async function pidOf(browser: ReturnType<typeof connectBrowser>): Promise<number> {
  const before = browser.received.length;
  browser.socket.send(PID_QUESTION);
  await until(() => browser.received.length > before);
  const text = new TextDecoder().decode(browser.received.at(-1) as ArrayBuffer);
  const match = /pid=(\d+);/.exec(text);
  if (!match?.[1]) throw new Error(`no pid in ${text}`);
  return Number(match[1]);
}

/** Resets the computer's WorkspaceDO, as a platform shutdown or a deploy's switch does. */
async function reset(stub: Stub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    try {
      state.abort("test restart");
    } catch {
      // abort() throws in the current request by design
    }
  }).catch(() => undefined);
}

/** The commands the computer's supervisor received, by type, in order. */
function commandsOf(computer: SimulatedComputer): string[] {
  return computer.requests
    .filter((r) => r.body.startsWith("{"))
    .map((r) => (JSON.parse(r.body) as { type?: string }).type ?? "");
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
async function running(options: Partial<SupervisorOptions> = {}) {
  serial += 1;
  const computerId = `cmp_01hzy3m8k6q4t2v9w7x5r1${String(serial).padStart(4, "0")}` as ComputerId;
  const stub = workspaces.getByName(workspaceObjectName(computerId)) as Stub;
  const computer = testComputers.create(stub.id, computerId);
  computer.supervisorOptions = options;
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

// First in the file: it advances the shared test clock by 31 minutes, which must not reach the
// windows and streams of computers other tests leave behind (with @cloudflare/vitest-plugin 1.4.0
// the run then sometimes never ended after its last test).
describe("closure at the controller's credential-sensitive steps (Codex r1-2)", () => {
  it("a start-deadline stop reached from a supervisor report closes the stream before its commands", async () => {
    const timing = testComputers.terminalTiming as { checkMs?: number | undefined };
    const checkMs = timing.checkMs;
    timing.checkMs = 3_600_000; // the bridge's own check never runs in this test
    try {
      const { path, stub, computer } = await running();
      const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
      const commandsWhenClosed: string[] = [];
      void browser.closed.then(() => {
        for (const r of computer.requests) commandsWhenClosed.push(r.body);
      });
      const before = computer.requests.length;
      // Past the window's deadline and the start deadline; the bridge has not noticed yet.
      testComputers.advance(31 * 60_000);
      computer.sup?.report();
      await settle(stub, computer);
      const event = await browser.closed;
      expect(event.code).toBe(4001);
      expect(event.reason).toContain("the computer is stopping");
      const stopCommands = commandsWhenClosed.slice(before);
      expect(stopCommands.some((body) => body.includes("credential_snapshot"))).toBe(false);
      expect(
        computer.requests.slice(before).some((r) => r.body.includes("credential_snapshot")),
      ).toBe(true);
    } finally {
      timing.checkMs = checkMs;
    }
  });
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

  it("refuses a terminal while a sign-out runs, and the sign-out ends an open one first (Codex r1-1)", async () => {
    const { path, stub, computer } = await running({ holdCredentials: true });
    computer.sup?.signIn("claude");
    await settle(stub, computer);
    const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
    const commandsWhenClosed: string[] = [];
    void browser.closed.then(() => {
      for (const r of computer.requests) commandsWhenClosed.push(r.body);
    });
    const intent = await intentOf(path);
    await route(`${path}/do/sign-out`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ op: OP(21), intent }).toString(),
    });
    expect((await browser.closed).code).toBe(4001);
    expect(commandsWhenClosed.some((body) => body.includes('"sign_out"'))).toBe(false);
    await settle(stub, computer);
    const state = PagesResult.parse(await stub.pages({ ...call, action: "state" }));
    const removal =
      state.action === "state"
        ? (state.computer as { removal: Record<string, unknown> }).removal
        : {};
    expect(removal).toMatchObject({ signOut: "requested", signOutRunning: true });
    const again = await terminalPost(path, {
      op: OP(22),
      intent: await intentOf(path),
      mode: "open",
    });
    expect(again).toEqual({ action: "open_terminal", outcome: "refused", reason: "busy" });
  });
});

describe("shells kept on the computer (WP3.28, FH-38)", () => {
  async function reconnect(path: string, window: number, n: number) {
    const fresh = (await terminalPost(path, {
      op: OP(n),
      intent: await intentOf(path),
      mode: "reconnect",
      window,
    })) as { outcome: string; capability: string };
    expect(fresh.outcome).toBe("accepted");
    return upgrade(path, fresh.capability);
  }

  it("a reset between the drop and the reconnect finds the same shell", async () => {
    const { path, stub, shells } = await running();
    const log = vi.spyOn(console, "log");
    const opened = await open(path);
    const first = connectBrowser(await upgrade(path, opened.capability));
    const pid = await pidOf(first);
    first.socket.close(1001, "page reloaded");
    await first.closed;
    await reset(stub);
    const second = connectBrowser(await reconnect(path, opened.window, 30));
    expect(await pidOf(second)).toBe(pid);
    expect(shells.dialled).toEqual([
      { mode: "new", window: 1 },
      { mode: "attach", window: 1 },
    ]);
    const lines = log.mock.calls
      .map(([line]) => {
        try {
          return JSON.parse(String(line)) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, unknown> => l !== null);
    // A new instance served the reconnect: it reattached, and never bridged a new shell. Each
    // terminal line carries its instance's ID, the one its `instance_started` names (WP3.27).
    const terminal = lines.filter((l) => String(l.event).startsWith("terminal_"));
    expect(terminal.filter((l) => l.event === "terminal_bridged")).toHaveLength(1);
    const bridged = terminal.find((l) => l.event === "terminal_bridged");
    const reattached = terminal.at(-1);
    expect(reattached?.event).toBe("terminal_reattached");
    expect(bridged?.instanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(reattached?.instanceId).not.toBe(bridged?.instanceId);
    const started = new Set(
      lines
        .filter((l) => l.event === "instance_started" && l.class === "WorkspaceDO")
        .map((l) => l.instanceId),
    );
    expect(started.has(bridged?.instanceId)).toBe(true);
    expect(started.has(reattached?.instanceId)).toBe(true);
    second.socket.close(1000);
  });

  it("a reconnect while the old stream still looks attached takes it over (27 Oct)", async () => {
    const { path, shells } = await running();
    const opened = await open(path);
    const old = connectBrowser(await upgrade(path, opened.capability));
    const pid = await pidOf(old);
    const fresh = connectBrowser(await reconnect(path, opened.window, 31));
    const event = await old.closed;
    expect(event.code).toBe(4001);
    expect(event.reason).toContain("opened again");
    expect(await pidOf(fresh)).toBe(pid);
    expect(shells).toHaveLength(1);
    fresh.socket.close(1000);
  });

  it("refuses a reconnect whose shell is gone with 4002, and starts no shell in its place", async () => {
    const { path, stub, shells, computer } = await running();
    const opened = await open(path);
    const first = connectBrowser(await upgrade(path, opened.capability));
    await pidOf(first);
    first.socket.close(1001);
    await first.closed;
    await reset(stub);
    computer.terminalSessions.endAll(); // the reaper ended it meanwhile
    const again = connectBrowser(await reconnect(path, opened.window, 32));
    expect((await again.closed).code).toBe(4002);
    expect(computer.terminalSessions.sessions.size).toBe(0);
    expect(shells.dialled.at(-1)).toEqual({ mode: "attach", window: 1 });
  });

  it("with a supervisor whose ttyd ends the shell with its stream, refuses that reconnect undialled", async () => {
    const { path, stub, shells } = await running({ terminalSessions: false });
    const opened = await open(path);
    const first = connectBrowser(await upgrade(path, opened.capability));
    first.socket.close(1001);
    await first.closed;
    await reset(stub);
    const again = connectBrowser(await reconnect(path, opened.window, 33));
    const event = await again.closed;
    expect(event.code).toBe(4002);
    expect(event.reason).toContain("session on the computer ended");
    expect(shells).toHaveLength(1);
  });

  type Ctx = Awaited<ReturnType<typeof running>>;
  const post = async (ctx: Ctx, action: string, n: number): Promise<void> => {
    const response = await route(`${ctx.path}/do/${action}`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ op: OP(n), intent: await intentOf(ctx.path) }).toString(),
    });
    expect(response.status).toBe(303);
  };
  it.each([
    [
      "the owner's close",
      async (ctx: Ctx): Promise<void> =>
        void (await terminalPost(ctx.path, {
          op: OP(40),
          intent: await intentOf(ctx.path),
          mode: "close",
        })),
    ],
    ["a new window", async (ctx: Ctx): Promise<void> => void (await open(ctx.path, 41))],
    ["a sign-out", (ctx: Ctx): Promise<void> => post(ctx, "sign-out", 42)],
    ["a restart", (ctx: Ctx): Promise<void> => post(ctx, "restart", 43)],
    [
      "a removal by Omnigent",
      async (ctx: Ctx): Promise<void> =>
        void (await ctx.client.send(ctx.client.terminateRequest())),
    ],
    [
      "a sign-in from the page",
      async (ctx: Ctx): Promise<void> => {
        const html = await (await route(ctx.path)).text();
        const generation = /data-generation="([0-9]+)"/.exec(html)?.[1];
        const response = await route(`${ctx.path}/sign-in`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({
            op: OP(44),
            intent: await intentOf(ctx.path),
            mode: "start",
            service: "codex",
            generation: Number(generation),
          }),
        });
        expect(response.status).toBe(200);
      },
    ],
  ] as const)(
    "%s ends the window's shell on the computer, with terminal_end first",
    async (_name, step) => {
      const ctx = await running();
      const { path, stub, computer } = ctx;
      const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
      await pidOf(browser);
      expect(computer.terminalSessions.sessions.has(1)).toBe(true);
      const before = commandsOf(computer).length;
      await step(ctx);
      expect((await browser.closed).code).toBe(4001);
      await settle(stub, computer);
      expect(computer.terminalSessions.sessions.has(1)).toBe(false);
      const after = commandsOf(computer).slice(before);
      // Ended by WorkspaceDO's terminal_end, before any credential-sensitive command the runner
      // sends. A page sign-in's start goes on the request path: the supervisor ends every session
      // itself before the CLI's spawn, and the terminal_end follows.
      expect(after).toContain("terminal_end");
      const end = after.indexOf("terminal_end");
      for (const type of ["sign_out", "credential_snapshot", "capture"]) {
        if (after.includes(type)) expect(end).toBeLessThan(after.indexOf(type));
      }
    },
  );

  it("the window's deadline ends its shell on the computer", async () => {
    const timing = testComputers.terminalTiming as { checkMs?: number | undefined };
    const { path, stub, computer } = await running();
    const browser = connectBrowser(await upgrade(path, (await open(path)).capability));
    await pidOf(browser);
    testComputers.advance(31 * 60_000);
    expect((await browser.closed).code).toBe(4001);
    expect(timing).toBeDefined();
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    expect(commandsOf(computer)).toContain("terminal_end");
    expect(computer.terminalSessions.sessions.size).toBe(0);
  });
});
