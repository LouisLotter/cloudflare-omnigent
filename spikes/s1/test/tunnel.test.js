// The host's tunnel: the 101 headers sent back to the host, the choice of mode, the requests
// HostRoute and S1Server make, and the tunnel-check phase, driven through S1Computer's real
// alarm handler with a scripted container whose tunnel probe answers per mode.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bareHeaders,
  HostRoute,
  resolveWsMode,
  S1Computer,
  S1Server,
  upgradeHeaders,
  websocketAccept,
} from "../src/index.js";

const PROBE = "/usr/local/bin/s1-tunnel-probe.py";
const MODES = ["bare", "fixed", "route-fixed", "bridge", "direct"];
// RFC 6455 section 1.3's example.
const KEY = "dGhlIHNhbXBsZSBub25jZQ==";
const ACCEPT = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

afterEach(() => vi.unstubAllGlobals());

describe("the 101 headers for the host", () => {
  it("computes Sec-WebSocket-Accept as RFC 6455 does", async () => {
    expect(await websocketAccept(KEY)).toBe(ACCEPT);
    await expect(websocketAccept(null)).rejects.toThrow(TypeError);
  });

  it("uses the host's key, copies nothing from the server's 101 and offers no extension", async () => {
    const request = new Headers({
      "Sec-WebSocket-Key": KEY,
      "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
    });
    const upstream = new Headers({
      "Sec-WebSocket-Accept": "for-workerds-own-key=",
      "Sec-WebSocket-Extensions": "permessage-deflate",
      Server: "uvicorn",
    });
    const headers = await upgradeHeaders(request, upstream);
    expect([...headers].sort()).toEqual([
      ["connection", "Upgrade"],
      ["sec-websocket-accept", ACCEPT],
      ["upgrade", "websocket"],
    ]);
  });

  it("keeps a subprotocol the server chose", async () => {
    const headers = await upgradeHeaders(
      new Headers({ "Sec-WebSocket-Key": KEY }),
      new Headers({ "Sec-WebSocket-Protocol": "omnigent" }),
    );
    expect(headers.get("Sec-WebSocket-Protocol")).toBe("omnigent");
  });

  // Staging, 2026-10-19: Cloudflare's container egress writes its own Upgrade, Connection and
  // Accept and then appends the Response's headers, so any Upgrade here reaches the host twice.
  it("bare: sets none of the handshake's headers, only a subprotocol the server chose", () => {
    const upstream = new Headers({
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": "for-workerds-own-key=",
      "Sec-WebSocket-Extensions": "permessage-deflate",
      Server: "uvicorn",
    });
    expect([...bareHeaders(upstream)]).toEqual([]);
    expect([...bareHeaders(undefined)]).toEqual([]);
    upstream.set("Sec-WebSocket-Protocol", "omnigent");
    expect([...bareHeaders(upstream)]).toEqual([["sec-websocket-protocol", "omnigent"]]);
  });
});

describe("the mode for one upgrade", () => {
  const h = (mode) => new Headers(mode ? { "x-s1-ws-mode": mode } : {});
  it("takes the probe's header, then the deployment's choice, then S1_WS_MODE, else bare", () => {
    expect(resolveWsMode(h("direct"), { wsMode: "bridge" }, { S1_WS_MODE: "route-fixed" })).toBe(
      "direct",
    );
    expect(resolveWsMode(h(), { wsMode: "bridge" }, { S1_WS_MODE: "route-fixed" })).toBe("bridge");
    expect(resolveWsMode(h(), { wsMode: null }, { S1_WS_MODE: "route-fixed" })).toBe("route-fixed");
    expect(resolveWsMode(h(), {}, {})).toBe("bare");
    expect(resolveWsMode(h("nonsense"), {}, {})).toBe("bare");
    expect(resolveWsMode(h("fixed"), {}, {})).toBe("fixed");
  });
});

/** A WebSocket end that records what is done to it. */
function fakeSocket(name, log) {
  const listeners = {};
  return {
    name,
    accept: () => log.push(`${name}.accept`),
    send: (data) => log.push(`${name}.send ${data}`),
    close: (code) => log.push(`${name}.close ${code}`),
    addEventListener: (type, fn) => {
      listeners[type] = fn;
    },
    emit: (type, event) => listeners[type]?.(event),
  };
}

/** Response and WebSocketPair as workerd has them; Node's Response refuses status 101. */
function stubRuntime(log) {
  const pairs = [];
  vi.stubGlobal(
    "Response",
    class {
      constructor(_body, init = {}) {
        this.status = init.status ?? 200;
        this.webSocket = init.webSocket ?? null;
        this.headers = new Headers(init.headers);
      }
    },
  );
  vi.stubGlobal(
    "WebSocketPair",
    class {
      constructor() {
        const n = pairs.length;
        const pair = [fakeSocket(`client${n}`, log), fakeSocket(`bridge${n}`, log)];
        pairs.push(pair);
        Object.assign(this, { 0: pair[0], 1: pair[1] });
      }
    },
  );
  return pairs;
}

function upgradeRequest(extra = {}) {
  return new Request("http://omnigent.internal/v1/hosts/abc/tunnel", {
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": KEY,
      "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
      ...extra,
    },
  });
}

/** S1Server with a server container whose port answers every upgrade with a 101. */
function serverObject(log) {
  const forwarded = [];
  const serverSocket = fakeSocket("server", log);
  const upstream = {
    status: 101,
    webSocket: serverSocket,
    headers: new Headers({ "Sec-WebSocket-Accept": "for-workerds-own-key=", Server: "uvicorn" }),
  };
  const ctx = {
    storage: {},
    container: {
      running: true,
      setInactivityTimeout: async () => {},
      getTcpPort: () => ({
        fetch: async (url, request) => {
          forwarded.push({ url, headers: Object.fromEntries(request.headers) });
          return upstream;
        },
      }),
    },
    blockConcurrencyWhile: async (fn) => fn(),
  };
  return { server: new S1Server(ctx, {}), forwarded, upstream, serverSocket };
}

describe("S1Server answers the upgrade in the mode HostRoute names", () => {
  it("fixed: bridges, answers with the host's Accept, and does not pass the mode header on", async () => {
    const log = [];
    const pairs = stubRuntime(log);
    const t = serverObject(log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await t.server.fetch(upgradeRequest({ "x-s1-ws-mode": "fixed" }));
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(pairs[0][0]);
    expect(response.headers.get("Sec-WebSocket-Accept")).toBe(ACCEPT);
    expect(response.headers.has("Sec-WebSocket-Extensions")).toBe(false);
    expect(response.headers.has("Server")).toBe(false);
    expect(t.forwarded[0].headers["x-s1-ws-mode"]).toBeUndefined();
    expect(t.forwarded[0].headers.upgrade).toBe("websocket");
    // Frames flow both ways through the bridge.
    pairs[0][1].emit("message", { data: "hello" });
    t.serverSocket.emit("message", { data: "welcome" });
    expect(log).toContain("server.send hello");
    expect(log).toContain("bridge0.send welcome");
  });

  it("bare: bridges and answers 101 with only the socket, no Upgrade, Connection or Accept", async () => {
    const log = [];
    const pairs = stubRuntime(log);
    const t = serverObject(log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await t.server.fetch(upgradeRequest({ "x-s1-ws-mode": "bare" }));
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(pairs[0][0]);
    expect([...response.headers]).toEqual([]);
    expect(t.forwarded[0].headers["x-s1-ws-mode"]).toBeUndefined();
    pairs[0][1].emit("message", { data: "hello" });
    t.serverSocket.emit("message", { data: "welcome" });
    expect(log).toContain("server.send hello");
    expect(log).toContain("bridge0.send welcome");
  });

  it("bare is the default when no mode is named", async () => {
    stubRuntime([]);
    const t = serverObject([]);
    const response = await t.server.fetch(upgradeRequest());
    expect(response.status).toBe(101);
    expect(response.headers.has("Upgrade")).toBe(false);
    expect(response.headers.has("Connection")).toBe(false);
    expect(response.headers.has("Sec-WebSocket-Accept")).toBe(false);
  });

  it("bridge: copies the server's headers, as 76fa418 did", async () => {
    stubRuntime([]);
    const t = serverObject([]);
    const response = await t.server.fetch(upgradeRequest({ "x-s1-ws-mode": "bridge" }));
    expect(response.headers.get("Sec-WebSocket-Accept")).toBe("for-workerds-own-key=");
  });

  it("direct: returns the server's 101 response as it is", async () => {
    stubRuntime([]);
    const t = serverObject([]);
    const response = await t.server.fetch(upgradeRequest({ "x-s1-ws-mode": "direct" }));
    expect(response).toBe(t.upstream);
  });
});

/** HostRoute with a recording S1Server stub. */
function hostRoute(props, answer) {
  const seen = [];
  const server = {
    fetch: async (request) => {
      seen.push(Object.fromEntries(request.headers));
      return answer;
    },
    mark: async () => {},
  };
  const env = { S1_VERSION: "1", SERVER: { idFromName: (n) => n, get: () => server } };
  const route = new HostRoute({ props, waitUntil() {} }, env);
  return { route, seen };
}

describe("HostRoute names the mode for S1Server", () => {
  it("passes the deployment's chosen mode, and returns S1Server's 101", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const answer = { status: 101, webSocket: {}, headers: new Headers() };
    const t = hostRoute({ run: "w1", wsMode: "bridge" }, answer);
    expect(await t.route.fetch(upgradeRequest())).toBe(answer);
    expect(t.seen[0]["x-s1-ws-mode"]).toBe("bridge");
  });

  it("route-fixed: asks S1Server to bridge, bridges again and answers with the host's Accept", async () => {
    const log = [];
    const pairs = stubRuntime(log);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const inner = fakeSocket("inner", log);
    const answer = { status: 101, webSocket: inner, headers: new Headers({ Server: "uvicorn" }) };
    const t = hostRoute({ run: "w1" }, answer);
    const response = await t.route.fetch(upgradeRequest({ "x-s1-ws-mode": "route-fixed" }));
    expect(t.seen[0]["x-s1-ws-mode"]).toBe("bridge");
    expect(response.status).toBe(101);
    expect(response.webSocket).toBe(pairs[0][0]);
    expect(response.headers.get("Sec-WebSocket-Accept")).toBe(ACCEPT);
    expect(log).toContain("inner.accept");
  });

  it("logs a failed upgrade and returns the failure", async () => {
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((line) => lines.push(JSON.parse(line)));
    const answer = new globalThis.Response("server not running", { status: 503 });
    const t = hostRoute({ run: "w1" }, answer);
    expect((await t.route.fetch(upgradeRequest())).status).toBe(503);
    expect(lines.map((l) => l.s1)).toContain("ws-upgrade-failed");
  });

  it("names bare when neither the probe nor the deployment chose a mode", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const answer = { status: 101, webSocket: {}, headers: new Headers() };
    const t = hostRoute({ run: "w1", wsMode: null }, answer);
    expect(await t.route.fetch(upgradeRequest())).toBe(answer);
    expect(t.seen[0]["x-s1-ws-mode"]).toBe("bare");
  });

  it("passes plain HTTP through untouched", async () => {
    const answer = new globalThis.Response("{}", { status: 200 });
    const t = hostRoute({ run: "w1", wsMode: "bridge" }, answer);
    await t.route.fetch(new Request("http://omnigent.internal/v1/me"));
    expect(t.seen[0]["x-s1-ws-mode"]).toBeUndefined();
  });
});

// ---- tunnel-check, through S1Computer's alarm handler -------------------------------------

function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
    list: async ({ prefix = "" } = {}) =>
      new Map([...map].filter(([key]) => key.startsWith(prefix)).sort()),
    getAlarm: async () => alarm,
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

/**
 * A computer container whose tunnel probe passes for the modes in `working`. The host comes
 * online once released, unless `hostComesOnline` is false.
 */
function setup({ command, working, hostComesOnline = true }) {
  const log = [];
  const probeUrls = [];
  const state = { running: false, held: false, released: false, starts: [] };
  const container = {
    get running() {
      return state.running;
    },
    start(options) {
      state.running = true;
      state.held = options.env?.S1_HOLD_HOST === "1";
      state.released = false;
      state.starts.push(options);
      log.push(state.held ? "start(held)" : "start");
    },
    async destroy() {
      state.running = false;
      log.push("destroy");
    },
    async setInactivityTimeout() {},
    async interceptOutboundHttp(address, route) {
      log.push(`intercept ${address} ${route.props.wsMode}`);
    },
    async exec(cmd) {
      let stdout = "";
      if (cmd[1] === PROBE) {
        const mode = cmd[3];
        log.push(`probe ${mode}`);
        probeUrls.push(cmd[2]);
        stdout = JSON.stringify({ mode, ok: working.includes(mode), raw: {}, lib: {} });
      } else if (cmd[0] === "touch") {
        state.released = true;
        log.push("release");
      } else if (cmd[0] === "true") log.push("exec ready");
      else if (cmd[0] === "cat") stdout = "incarnation-1";
      return {
        output: async () => ({
          exitCode: 0,
          stdout: new TextEncoder().encode(stdout),
          stderr: new Uint8Array(),
        }),
      };
    },
  };
  const server = {
    async hostStatus() {
      const online = state.running && (!state.held || state.released) && hostComesOnline;
      return online ? "online" : "offline";
    },
    marks: async () => ({}),
    keepAlive: async () => true,
    ensureUp: async () => ({ started: false, readyMs: 1 }),
    stop: async () => {},
  };
  const storage = memoryStorage();
  const ctx = {
    storage,
    container,
    exports: { HostRoute: (options) => options, DirectoryBackupGateway: () => ({}) },
    blockConcurrencyWhile: async (fn) => fn(),
    waitUntil() {},
  };
  const env = {
    S1_VERSION: "1",
    S1_COMMAND: command,
    S1_START_GAP_MS: "0",
    S1_WAKE_DEADLINE_MS: "300",
    SERVER: { idFromName: (name) => name, get: () => server },
  };
  vi.spyOn(console, "log").mockImplementation(() => {});
  return { computer: new S1Computer(ctx, env), storage, log, state, probeUrls };
}

async function runCampaign(t, maxAlarms = 40) {
  await t.computer.kickoff({ armedUntil: Date.now() + 3_600_000 });
  for (let i = 0; i < maxAlarms; i++) {
    if ((await t.storage.getAlarm()) === null) return;
    await t.computer.alarm();
    const idle =
      (await t.storage.get("lastCommand")) !== undefined &&
      (await t.storage.get("phase")) === undefined &&
      ((await t.storage.get("queue")) ?? []).length === 0;
    if (idle) return;
  }
  throw new Error("the campaign did not finish");
}

async function records(storage, event) {
  const out = [];
  for (const [, value] of await storage.list({ prefix: "result:" })) {
    if (value.s1 === event) out.push(value);
  }
  return out;
}

describe("tunnel-check", () => {
  it("probes every mode on a held host, keeps the first that works, then releases the host", async () => {
    const t = setup({ command: "t:tunnel-check,wake=1", working: ["route-fixed", "direct"] });
    await runCampaign(t);
    const probes = await records(t.storage, "tunnel-probe");
    expect(probes.map((p) => p.mode)).toEqual(MODES);
    // The probe goes through omnigent.internal with a host ID of its own, never the real host's.
    const hostId = await t.storage.get("hostId");
    for (const url of t.probeUrls) {
      expect(url).toMatch(/^ws:\/\/omnigent\.internal\/v1\/hosts\/[0-9a-f]{32}\/tunnel$/);
      expect(url).not.toContain(hostId);
    }
    expect(await t.storage.get("wsMode")).toBe("route-fixed");
    const [check] = await records(t.storage, "tunnel-check");
    expect(check).toMatchObject({
      ok: true,
      status: "online",
      chosenMode: "route-fixed",
      probesOk: ["route-fixed", "direct"],
      wsMode: "route-fixed",
    });
    expect(check.releasedMs).not.toBeNull();
    expect(check.execReadyMs).not.toBeNull();
    // Held start, the container runs commands, all probes, the route registered again with
    // the chosen mode, then release.
    const start = t.log.indexOf("start(held)");
    const ready = t.log.indexOf("exec ready", start);
    expect(ready).toBeGreaterThan(start);
    expect(t.log.indexOf("probe fixed")).toBeGreaterThan(ready);
    const lastProbe = t.log.indexOf("probe direct");
    const reroute = t.log.indexOf("intercept omnigent.internal route-fixed");
    const release = t.log.indexOf("release");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(lastProbe).toBeGreaterThan(start);
    expect(reroute).toBeGreaterThan(lastProbe);
    expect(release).toBeGreaterThan(reroute);
    // The following wake uses the chosen mode from its first intercept.
    const [wake] = (await records(t.storage, "wake")).filter((w) => w.index === 0);
    expect(wake).toMatchObject({ ok: true, wsMode: "route-fixed" });
    expect(t.log.slice(release)).toContain("intercept omnigent.internal route-fixed");
    expect(t.log.slice(release)).not.toContain("intercept omnigent.internal null");
    expect(await records(t.storage, "tunnel-check-failed")).toEqual([]);
  });

  it("drops the rest of the queue and stops the computer when the host does not come online", async () => {
    const t = setup({
      command: "t:tunnel-check,wake=21,rwake-medium=20",
      working: [],
      hostComesOnline: false,
    });
    await runCampaign(t);
    const [check] = await records(t.storage, "tunnel-check");
    expect(check).toMatchObject({ ok: false, chosenMode: null, probesOk: [] });
    // The host is released anyway, so the check shows whether the real host comes online.
    expect(t.log).toContain("release");
    const [failed] = await records(t.storage, "tunnel-check-failed");
    expect(failed.dropped).toEqual(["wake", "rwake-medium"]);
    expect(await t.storage.get("wsMode")).toBeUndefined();
    expect(t.state.running).toBe(false);
    expect(await records(t.storage, "wake")).toEqual([]);
  });

  it("keeps the default mode when no probe passes but the host still comes online", async () => {
    const t = setup({ command: "t:tunnel-check,wake=1", working: [] });
    await runCampaign(t);
    const [check] = await records(t.storage, "tunnel-check");
    expect(check).toMatchObject({ ok: true, chosenMode: null, wsMode: null });
    expect((await records(t.storage, "wake")).filter((w) => w.index === 0)).toHaveLength(1);
  });

  it("records unreadable probe output as a failed mode", async () => {
    const t = setup({ command: "t:tunnel-check", working: ["fixed"] });
    const exec = t.computer.ctx.container.exec;
    t.computer.ctx.container.exec = async (cmd) =>
      cmd[3] === "fixed"
        ? { output: async () => ({ exitCode: 1, stdout: new TextEncoder().encode("Traceback") }) }
        : exec(cmd);
    await runCampaign(t);
    const fixed = (await records(t.storage, "tunnel-probe")).find((p) => p.mode === "fixed");
    expect(fixed).toMatchObject({ mode: "fixed", ok: false });
    expect(fixed.error).toMatch(/not JSON \(exit 1\)/);
  });
});
