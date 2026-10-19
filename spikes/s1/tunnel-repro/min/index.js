// Minimal local reproduction of S1's host tunnel path:
//   client (Omnigent host or a probe) -> this Worker's fetch, or the intercept path through
//   HostRoute -> Durable Object stub fetch -> container.getTcpPort(8000).fetch -> Omnigent server.
// The Durable Object answers the WebSocket upgrade in one of several modes, set by
// POST /__mode?m=<mode>:
//   direct        return the container's 101 response as it is (S1 before 76fa418)
//   bridge        accept it and bridge to a new pair, copying the container's headers (76fa418)
//   bridge-clean  the same bridge, with no handshake headers copied from the container
//   direct-noext  forward the upgrade without Sec-WebSocket-Extensions, return the 101 as it is
// Each upgrade logs the server's 101 headers and whether its Sec-WebSocket-Accept matches the
// client's key (it does not: workerd's fetch to the container sends a key of its own).
// GET /__computer/start starts a held computer container whose omnigent.internal goes through
// HostRoute, so that relay.py can reach HostRoute through workerd's egress listener.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const PORT = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (event, data = {}) =>
  console.log(JSON.stringify({ r: event, wt: Date.now(), ...data }));

/** RFC 6455 section 4.2.2: base64(SHA-1(key + GUID)). */
async function acceptFor(key) {
  if (!key) return null;
  const data = new TextEncoder().encode(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
  return btoa(String.fromCharCode(...digest));
}

export class Server extends DurableObject {
  async ensureUp() {
    const c = this.ctx.container;
    if (!c.running) c.start({ enableInternet: false });
    await c.setInactivityTimeout(30 * 60_000);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    const port = c.getTcpPort(PORT);
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      try {
        const r = await port.fetch("http://server/health");
        if (r.ok) return Date.now() - t0;
      } catch {}
      await sleep(500);
    }
    throw new Error("server did not come up");
  }

  // Keeps this object, and so its container, alive while the reproduction runs.
  async alarm() {
    if (this.ctx.container.running) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__mode") {
      const m = url.searchParams.get("m");
      if (m) await this.ctx.storage.put("mode", m);
      return Response.json({ mode: (await this.ctx.storage.get("mode")) ?? "bridge" });
    }
    if (url.pathname === "/__up") return Response.json({ readyMs: await this.ensureUp() });
    const mode = (await this.ctx.storage.get("mode")) ?? "bridge";
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    let forward = request;
    if (upgrade && mode === "direct-noext") {
      const headers = new Headers(request.headers);
      headers.delete("Sec-WebSocket-Extensions");
      forward = new Request(request, { headers });
    }
    const upstream = await this.ctx.container
      .getTcpPort(PORT)
      .fetch(request.url.replace(/^https:/, "http:"), forward);
    if (!upstream.webSocket) return upstream;
    const upHeaders = Object.fromEntries(upstream.headers);
    const acceptForHostKey = await acceptFor(request.headers.get("Sec-WebSocket-Key"));
    log("upgrade-upstream", {
      mode,
      status: upstream.status,
      headers: upHeaders,
      acceptForHostKey,
      upstreamAcceptMatchesHostKey: upHeaders["sec-websocket-accept"] === acceptForHostKey,
    });
    if (mode === "direct" || mode === "direct-noext") return upstream;

    const container = upstream.webSocket;
    const [client, bridge] = Object.values(new WebSocketPair());
    container.accept();
    bridge.accept();
    const opened = Date.now();
    const closeCode = (code) => (code === 1005 || code === 1006 ? 1000 : code);
    bridge.addEventListener("message", (e) => container.send(e.data));
    container.addEventListener("message", (e) => bridge.send(e.data));
    bridge.addEventListener("close", (e) => {
      log("ws-close", { side: "host", code: e.code, reason: e.reason, ms: Date.now() - opened });
      container.close(closeCode(e.code), e.reason);
    });
    container.addEventListener("close", (e) => {
      log("ws-close", { side: "server", code: e.code, reason: e.reason, ms: Date.now() - opened });
      bridge.close(closeCode(e.code), e.reason);
    });
    if (mode === "bridge") {
      return new Response(null, {
        status: upstream.status,
        webSocket: client,
        headers: upstream.headers,
      });
    }
    const headers = new Headers();
    const protocol = upstream.headers.get("Sec-WebSocket-Protocol");
    if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
    return new Response(null, { status: 101, webSocket: client, headers });
  }
}

/** As S1's HostRoute: hands the intercepted request to the server object. */
export class HostRoute extends WorkerEntrypoint {
  async fetch(request) {
    const server = this.env.SERVER.get(this.env.SERVER.idFromName("server"));
    return server.fetch(request);
  }
}

export class Computer extends DurableObject {
  async fetch(request) {
    const c = this.ctx.container;
    if (new URL(request.url).pathname !== "/__computer/start") {
      return new Response("not found", { status: 404 });
    }
    const route = this.ctx.exports.HostRoute({ props: {} });
    await c.interceptOutboundHttp("omnigent.internal", route);
    if (!c.running) c.start({ enableInternet: true });
    await c.interceptOutboundHttp("omnigent.internal", route);
    await c.setInactivityTimeout(30 * 60_000);
    await this.ctx.storage.setAlarm(Date.now() + 5000);
    return Response.json({ running: c.running });
  }

  async alarm() {
    if (this.ctx.container.running) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname.startsWith("/__computer/")) {
      return env.COMPUTER.get(env.COMPUTER.idFromName("computer")).fetch(request);
    }
    return env.SERVER.get(env.SERVER.idFromName("server")).fetch(request);
  },
};
