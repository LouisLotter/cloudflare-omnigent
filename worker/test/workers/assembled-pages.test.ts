// The platform pages on the assembled WorkspaceDO (WP3.18 with WP3.5): web.ts's pages → the
// WORKSPACE binding → the production WorkspaceDO, whose terminal bridge dials the computer's ttyd
// through the same container port (WP3.3's adapter over the runtime container) that its
// controller uses for the supervisor and for `DirectoryBackup`. The computer is provisioned and
// woken through the signed launcher API and the real ControlDO; workspace layers move through the
// real fenced gateway into local R2. Only the runtime container (with a fake ttyd on its terminal
// port) and the clocks are simulated. WP3.5's own pages tests run the same pages against WP3.1's
// controller under fakes (WORKSPACE_CONTROLLER); this file checks the two packages together.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { TERMINAL_SUBPROTOCOL, TERMINAL_WS_PATH } from "@cfo/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import { routeAdmitted } from "../../src/web.ts";
import {
  type Computer,
  hostId,
  PAGE_OWNER,
  provision,
  roomyControl,
  settle,
  sleep,
  wake,
} from "../support/assembled.ts";
import { testServers } from "../support/server-harness.ts";

const ORIGIN = "https://omnigent.example.test";
const TOKEN = "cfo-canary-launch-token-assembled-pages-01234";
const OP = (n: number) => `op_${String(n).padStart(26, "0")}`;
const bucket = () => (env as unknown as { CHECKPOINTS: R2Bucket }).CHECKPOINTS;
/** Every WebSocket a test opened, closed after it (as in pages.test.ts). */
const openSockets: WebSocket[] = [];

/** The web Worker's bindings as deployed: the platform Worker's own objects, cross-script. */
const webEnv = {
  OMNIGENT: env.OMNIGENT,
  WORKSPACE: env.WORKSPACE,
  CONTROL: env.CONTROL,
} as unknown as WebEnv;

function route(path: string, init: RequestInit = {}): Promise<Response> {
  const admitted: Admitted = {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { ...PAGE_OWNER, issuedAt: 1, expiresAt: 2 },
  };
  return routeAdmitted(admitted, webEnv, createExecutionContext());
}

async function intentOf(path: string): Promise<string> {
  const html = await (await route(path)).text();
  const match =
    /data-intent="([0-9a-f]{64})"/.exec(html) ?? /name="intent" value="([0-9a-f]{64})"/.exec(html);
  if (!match?.[1]) throw new Error("no intent token on the page");
  return match[1];
}

async function terminalPost(path: string, body: Record<string, unknown>) {
  const response = await route(`${path}/terminal`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

function upgrade(path: string, capability: string): Promise<Response> {
  return route(`${path}/terminal`, {
    headers: {
      upgrade: "websocket",
      origin: ORIGIN,
      "sec-websocket-protocol": `${TERMINAL_SUBPROTOCOL}, cfo-capability.${capability}`,
    },
  });
}

/** The browser's end of a bridged stream, with what it received and how it closed. */
function connectBrowser(response: Response) {
  const socket = response.webSocket;
  if (socket === null) throw new Error(`no socket: ${response.status}`);
  socket.accept();
  openSockets.push(socket);
  socket.binaryType = "arraybuffer";
  const received: ArrayBuffer[] = [];
  let resolveClosed: (event: CloseEvent) => void = () => undefined;
  const closed = new Promise<CloseEvent>((resolve) => {
    resolveClosed = resolve;
  });
  socket.addEventListener("message", (event) => {
    received.push(event.data as ArrayBuffer);
  });
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

/** What reached the runtime container's terminal port: each dial's path and subprotocol. */
interface Dial {
  readonly path: string;
  readonly protocol: string | null;
}

/** An assembled computer, awake, with a fake ttyd (echoing input frames) on its terminal port. */
async function awakeWithTtyd(): Promise<{ c: Computer; path: string; dials: Dial[] }> {
  const c = await provision();
  await wake(c, { hostId: hostId(), token: TOKEN });
  const dials: Dial[] = [];
  c.container.sim.terminal = (request) => {
    dials.push({
      path: new URL(request.url).pathname,
      protocol: request.headers.get("sec-websocket-protocol"),
    });
    const pair = new WebSocketPair();
    const shell = pair[1];
    shell.accept();
    openSockets.push(shell);
    shell.binaryType = "arraybuffer";
    shell.addEventListener("message", (event) => shell.send(event.data as ArrayBuffer));
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: { "sec-websocket-protocol": TERMINAL_SUBPROTOCOL },
    });
  };
  return { c, path: `/platform/computers/${c.computerId}`, dials };
}

async function openTerminal(path: string, n: number) {
  const intent = await intentOf(path);
  const answer = await terminalPost(path, { op: OP(n), intent, mode: "open" });
  if (answer.outcome !== "accepted") throw new Error(`refused: ${JSON.stringify(answer)}`);
  return answer as unknown as { capability: string; window: number };
}

async function layers(c: Computer): Promise<string[]> {
  return (await bucket().list({ prefix: `workspace/${c.computerId}/` })).objects.map((o) => o.key);
}

beforeAll(() => roomyControl());
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const server = testServers.create(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME));
  server.running = true;
});
afterEach(() => {
  for (const socket of openSockets.splice(0)) {
    try {
      socket.close(1000, "test over");
    } catch {
      // already closed
    }
  }
  vi.restoreAllMocks();
});

describe("the setup terminal on the assembled WorkspaceDO", () => {
  it("is bridged to the computer's ttyd through the container adapter, frames unchanged", async () => {
    const { c, path, dials } = await awakeWithTtyd();
    const page = await route(path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(c.computerId);
    const { capability } = await openTerminal(path, 1);
    const response = await upgrade(path, capability);
    expect(response.status).toBe(101);
    const browser = connectBrowser(response);
    const frame = new Uint8Array([0x30, 0x00, 0xff, 0x80, 0x7f, 0x0a]);
    browser.socket.send(frame);
    await until(() => browser.received.length === 1);
    expect([...new Uint8Array(browser.received[0] as ArrayBuffer)]).toEqual([...frame]);
    // One dial, on the runtime container's terminal port, through the production adapter.
    expect(dials).toEqual([{ path: TERMINAL_WS_PATH, protocol: TERMINAL_SUBPROTOCOL }]);
    browser.socket.close(1000, "done");
  });

  it("closes the stream before a page restart's save, which goes through DirectoryBackup and the fenced gateway", async () => {
    const { c, path } = await awakeWithTtyd();
    c.container.sim.sup?.write("work/notes.md", "saved by the restart");
    const { capability } = await openTerminal(path, 2);
    const browser = connectBrowser(await upgrade(path, capability));
    const runsBefore = c.container.shimRuns.length;
    let runsAtClose = -1;
    void browser.closed.then(() => {
      runsAtClose = c.container.shimRuns.length;
    });
    const restart = await route(`${path}/do/restart`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ op: OP(3), intent: await intentOf(path) }).toString(),
    });
    expect(restart.status).toBe(303);
    const event = await browser.closed;
    expect(event.code).toBe(4001);
    // Closed before the stop's checkpoint started anything in the container.
    expect(runsAtClose).toBe(runsBefore);
    await settle(c);
    expect(
      c.container.shimRuns.slice(runsBefore).filter((r) => r.startsWith("backup:")),
    ).toHaveLength(1);
    expect(await layers(c)).toHaveLength(1);
  });

  it("keeps Omnigent's sleep refused while the window is open, and sleeps through R2 once it is closed", async () => {
    const { c, path } = await awakeWithTtyd();
    c.container.sim.sup?.write("work/notes.md", "saved by the sleep");
    await openTerminal(path, 4);
    expect(await sleep(c)).toEqual({
      operation: "suspend",
      outcome: "refused",
      reason: "terminal_open",
    });
    expect(c.container.running).toBe(true);
    expect(c.container.shimRuns.filter((r) => r.startsWith("backup:"))).toEqual([]);
    const closed = await terminalPost(path, {
      op: OP(5),
      intent: await intentOf(path),
      mode: "close",
    });
    expect(closed).toEqual({ action: "close_terminal", closed: true });
    expect(await sleep(c)).toEqual({ operation: "suspend", outcome: "stopped" });
    expect(c.container.running).toBe(false);
    expect(await layers(c)).toHaveLength(1);
  });
});
