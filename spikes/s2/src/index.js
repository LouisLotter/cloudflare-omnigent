// Spike S2: the private host route. A "computer" container reaches the Omnigent server through
// a plain-HTTP intercept for the virtual host omnigent.internal. The intercept hands each
// request to the PrivateRoute entrypoint, which strips trust headers, adds the computer's
// identity from its props, and forwards to the ServerDO, which proxies to the server
// container. A WebSocket upgrade is bridged and answered with no handshake headers of its own
// (see bareHeaders).
//
// Everything is logged as one JSON object per line with an "s2" key, read back from Workers
// Logs by scripts/collect.sh. Throwaway spike code: lessons go into the design, not this file.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { BUILD } from "./build.js";

const SERVER_PORT = 8000;
const ALARM_MS = 10_000;
const INACTIVITY_MS = 30 * 60_000;
const VIRTUAL_HOST = "omnigent.internal";
// One fixed name: the durable_object policy has no max_instances, so this keeps it to one.
const COMPUTER_ID = "c1";
const COMPUTER_IMAGE = "computer"; // the key under containers[].images in wrangler.jsonc
const COMPUTER_INSTANCE = "standard-1";
const ADMIN_USER = "s2-admin";

function log(event, fields = {}) {
  console.log(JSON.stringify({ s2: event, build: BUILD.id, t: Date.now(), ...fields }));
}

function serverStub(env) {
  return env.SERVER.get(env.SERVER.idFromName("server"));
}

function computerStub(env) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(COMPUTER_ID));
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Headers a computer must never be able to set: Access identity and the route's own. */
function stripTrust(headers) {
  for (const name of [...headers.keys()]) {
    if (
      name.startsWith("cf-access-") ||
      name.startsWith("x-cfo-") ||
      name === "x-forwarded-email" ||
      name === "x-forwarded-user"
    ) {
      headers.delete(name);
    }
  }
}

/**
 * The 101 headers for a WebSocket answered through the container egress: none of the
 * handshake's own (no Upgrade, Connection, Accept or extension), which the egress adds; only a
 * subprotocol the server chose. The same rule as S1's `bare` mode, which brought the host online
 * on Cloudflare.
 */
export function bareHeaders(upstreamHeaders) {
  const headers = new Headers();
  const protocol = upstreamHeaders?.get("Sec-WebSocket-Protocol");
  if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
  return headers;
}

/** Relays an accepted upstream socket through a new pair and returns the pair's client end. */
function bridgeSocket(upstream) {
  const [client, bridge] = Object.values(new WebSocketPair());
  upstream.accept();
  bridge.accept();
  const closeCode = (code) => (code === 1005 || code === 1006 ? 1000 : code);
  bridge.addEventListener("message", (event) => {
    try {
      upstream.send(event.data);
    } catch {
      bridge.close(1011, "failed to forward to the server");
    }
  });
  upstream.addEventListener("message", (event) => {
    try {
      bridge.send(event.data);
    } catch {
      upstream.close(1011, "failed to forward to the host");
    }
  });
  const opened = Date.now();
  bridge.addEventListener("close", (event) => {
    log("ws-close", { side: "host", code: event.code, ms: Date.now() - opened });
    upstream.close(closeCode(event.code), event.reason);
  });
  upstream.addEventListener("close", (event) => {
    log("ws-close", { side: "server", code: event.code, ms: Date.now() - opened });
    bridge.close(closeCode(event.code), event.reason);
  });
  bridge.addEventListener("error", () => upstream.close(1011, "host side error"));
  upstream.addEventListener("error", () => bridge.close(1011, "server side error"));
  return client;
}

/** The handler behind the omnigent.internal intercept. Never on the public route table. */
export class PrivateRoute extends WorkerEntrypoint {
  async fetch(request) {
    const props = this.ctx.props ?? {};
    const url = new URL(request.url);
    const upgrade = request.headers.get("upgrade");
    if (url.pathname === "/_s2/report") {
      const text = await request.text();
      for (const line of text.split("\n")) {
        if (line.trim() !== "") console.log(`{"s2":"report","build":"${BUILD.id}","r":${line}}`);
      }
      return new Response("ok");
    }
    if (url.pathname === "/_s2/whoami") {
      return Response.json({
        via: "private-route",
        build: BUILD.id,
        host: url.host,
        computer: props.computerId,
        generation: props.generation,
      });
    }
    const headers = new Headers(request.headers);
    stripTrust(headers);
    headers.set("x-cfo-computer-id", String(props.computerId));
    headers.set("x-cfo-generation", String(props.generation));
    const started = Date.now();
    const response = await serverStub(this.env).fetch(new Request(request, { headers }));
    // Path and status only: never bodies, query strings or headers.
    log("route", {
      path: url.pathname,
      method: request.method,
      upgrade: upgrade ?? undefined,
      status: response.status,
      ms: Date.now() - started,
      computer: props.computerId,
      generation: props.generation,
      registeredBy: props.registeredBy,
    });
    return response;
  }
}

/** Shared lifecycle for both container DOs: a self-rearming alarm and the inactivity timeout. */
class Keeper extends DurableObject {
  constructor(ctx, env, role) {
    super(ctx, env);
    this.role = role;
    this.wokeAt = Date.now();
    ctx.blockConcurrencyWhile(async () => {
      const running = ctx.container?.running ?? false;
      log(`${role}-wake`, { running, reregister: BUILD.reregister });
      if (running) {
        await ctx.container.setInactivityTimeout(INACTIVITY_MS);
        await this.onWakeRunning();
      }
      if ((await ctx.storage.get("wanted")) && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + ALARM_MS);
      }
    });
  }

  async onWakeRunning() {}

  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    if (!(await this.ctx.storage.get("wanted"))) return;
    try {
      if (this.ctx.container.running) {
        await this.ctx.container.setInactivityTimeout(INACTIVITY_MS);
      } else {
        log(`${this.role}-not-running`);
        await this.ensure();
      }
    } catch (error) {
      log(`${this.role}-alarm-error`, { error: String(error) });
    }
  }

  async stop() {
    await this.ctx.storage.put("wanted", false);
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container.running) await this.ctx.container.destroy("s2 stop");
    log(`${this.role}-stopped`);
    return { stopped: true };
  }
}

export class ServerDO extends Keeper {
  constructor(ctx, env) {
    super(ctx, env, "server");
    this.ready = false;
  }

  async credentials() {
    let secret = await this.ctx.storage.get("secret");
    if (!secret) {
      secret = { password: randomHex(24), cookie: randomHex(32) };
      await this.ctx.storage.put("secret", secret);
    }
    return secret;
  }

  async ensure() {
    await this.ctx.storage.put("wanted", true);
    const container = this.ctx.container;
    if (!container.running) {
      const secret = await this.credentials();
      this.ready = false;
      container.start({
        enableInternet: true,
        env: {
          DATABASE_URL: "sqlite:////data/omnigent.db",
          OMNIGENT_ACCOUNTS_BASE_URL: `http://${VIRTUAL_HOST}`,
          OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: ADMIN_USER,
          OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: secret.password,
          OMNIGENT_ACCOUNTS_COOKIE_SECRET: secret.cookie,
        },
      });
      await container.setInactivityTimeout(INACTIVITY_MS);
      log("server-start");
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
    return { running: container.running };
  }

  /** Admin login for the computer's setup script. Synthetic, generated per deployment. */
  async adminLogin() {
    await this.ensure();
    const secret = await this.credentials();
    return { username: ADMIN_USER, password: secret.password };
  }

  async waitReady() {
    if (this.ready) return;
    const port = this.ctx.container.getTcpPort(SERVER_PORT);
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      try {
        const res = await port.fetch("http://container/health");
        if (res.ok) {
          this.ready = true;
          log("server-ready", { waitedMs: Date.now() - started });
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("server container not ready after 120 s");
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_s2/echo") return this.echo(url);
    await this.ensure();
    try {
      await this.waitReady();
      const upstream = await this.ctx.container.getTcpPort(SERVER_PORT).fetch(request);
      if (!upstream.webSocket) return upstream;
      // The host's tunnel. Cloudflare's container egress writes its own Upgrade, Connection and
      // Sec-WebSocket-Accept, then appends the Response's headers, so returning the server's 101
      // as it is gives the host "Upgrade: websocket" twice, which its client refuses (S1
      // tunnel-check, 19 Oct 2026). Bridge the socket and answer with no handshake headers.
      return new Response(null, {
        status: 101,
        webSocket: bridgeSocket(upstream.webSocket),
        headers: bareHeaders(upstream.headers),
      });
    } catch (error) {
      this.ready = false;
      log("server-proxy-error", { path: url.pathname, error: String(error) });
      return new Response("server unavailable", { status: 502 });
    }
  }

  echo(url) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tag = url.searchParams.get("c") ?? "anon";
    this.ctx.acceptWebSocket(server, [tag]);
    log("echo-open", { tag, open: this.ctx.getWebSockets().length });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    ws.send(
      JSON.stringify({
        echo: String(message),
        build: BUILD.id,
        wokeAt: this.wokeAt,
        t: Date.now(),
      }),
    );
  }

  webSocketClose(ws, code, reason) {
    log("echo-close", { tag: this.ctx.getTags(ws)[0], code, reason });
  }

  webSocketError(ws, error) {
    log("echo-error", { tag: this.ctx.getTags(ws)[0], error: String(error) });
  }
}

export class ComputerDO extends Keeper {
  constructor(ctx, env) {
    super(ctx, env, "computer");
  }

  async onWakeRunning() {
    if (BUILD.reregister) await this.intercept();
  }

  async intercept() {
    const generation = (await this.ctx.storage.get("generation")) ?? 0;
    const started = Date.now();
    // registeredBy names the Worker version that registered the intercept, so the route log
    // shows whether an intercept registered by an older version still serves after a deploy.
    const route = this.ctx.exports.PrivateRoute({
      props: { computerId: COMPUTER_ID, generation, registeredBy: BUILD.id },
    });
    await this.ctx.container.interceptOutboundHttp(VIRTUAL_HOST, route);
    log("intercept", { host: VIRTUAL_HOST, generation, ms: Date.now() - started });
  }

  async ensure() {
    await this.ctx.storage.put("wanted", true);
    const login = await serverStub(this.env).adminLogin();
    const container = this.ctx.container;
    if (!container.running) {
      const generation = ((await this.ctx.storage.get("generation")) ?? 0) + 1;
      await this.ctx.storage.put("generation", generation);
      // The computer's stable host identity, assigned once, as WorkspaceDO would.
      let hostId = await this.ctx.storage.get("hostId");
      if (!hostId) {
        hostId = randomHex(16);
        await this.ctx.storage.put("hostId", hostId);
      }
      // Intercepts registered before start, so the first lookup already resolves.
      await this.intercept();
      // The durable_object policy, as the design gives computers: the image comes from the
      // Worker version's image map and the size is chosen here, at each start.
      const image = container.images[COMPUTER_IMAGE];
      container.start({
        image,
        instance: COMPUTER_INSTANCE,
        enableInternet: true,
        env: {
          S2_SERVER_URL: `http://${VIRTUAL_HOST}`,
          S2_GENERATION: String(generation),
          S2_HOST_ID: hostId,
          S2_HOST_NAME: `s2-${COMPUTER_ID}`,
          S2_ADMIN_USER: login.username,
          S2_ADMIN_PASSWORD: login.password,
        },
      });
      await container.setInactivityTimeout(INACTIVITY_MS);
      log("computer-start", { generation, image, instance: COMPUTER_INSTANCE });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
    return { running: container.running };
  }

  async status() {
    return {
      running: this.ctx.container.running,
      generation: (await this.ctx.storage.get("generation")) ?? 0,
      wanted: (await this.ctx.storage.get("wanted")) ?? false,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  /**
   * IR-017 request-intent token for one action. Random, held in this object's memory only (so
   * showing the confirmation page writes nothing), valid for INTENT_TTL_MS and used once. A
   * page on another site cannot read it. If the object is evicted in between, the token is
   * gone and the POST is refused; the owner reloads the page.
   */
  intentToken(action) {
    this.intents ??= {};
    const held = this.intents[action];
    if (!held || Date.now() - held.issuedAt > INTENT_TTL_MS) {
      this.intents[action] = { value: randomHex(32), issuedAt: Date.now() };
    }
    return this.intents[action].value;
  }

  /** The only way the public entry changes state: the token is checked and spent first. */
  async control(action, presented) {
    const held = this.intents?.[action];
    if (
      !held ||
      Date.now() - held.issuedAt > INTENT_TTL_MS ||
      !sameToken(String(presented ?? ""), held.value)
    ) {
      return { ok: false };
    }
    delete this.intents[action];
    if (action === "start") return { ok: true, computer: await this.ensure() };
    const computer = await this.stop();
    const server = await serverStub(this.env).stop();
    return { ok: true, computer, server };
  }
}

/** Constant-time comparison of two token strings. */
function sameToken(a, b) {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Campaign controls (IR-017, spikes/README.md). Being through Access is not permission to
// act: a GET or HEAD only shows a confirmation page, and a change is a same-origin POST that
// carries the page's request-intent token. S2 has no fault or scenario route: the redeploy
// series runs from the laptop through the staging tool, never from a browser.
const CONTROLS = { "/s2/start": "start", "/s2/stop": "stop" };
const INTENT_TTL_MS = 10 * 60_000;
const MAX_FORM_BYTES = 4096;
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};
const PAGE_TEXT = {
  start:
    "Starts the S2 run: the Omnigent server (basic) and one computer container (standard-1), kept awake by an alarm until the run is stopped or torn down.",
  stop: "Stops both containers and the keep-alive alarm. Teardown is still done with the staging tool.",
};

function confirmationPage(action, intent) {
  const label = action === "start" ? "Start" : "Stop";
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>S2 ${action}</title></head>
<body>
<h1>Spike S2: ${action}</h1>
<p>${PAGE_TEXT[action]}</p>
<form method="post" action="/s2/${action}"><input type="hidden" name="intent" value="${intent}"><button type="submit">${label}</button></form>
<p>Build ${BUILD.id}. The button works once, within 10 minutes; reload the page if it is refused.</p>
</body>
</html>
`;
  return new Response(html, { headers: PAGE_HEADERS });
}

/** Why a control POST is refused before anything else happens, or null when it may proceed. */
function originRefusal(request, url) {
  const origin = request.headers.get("origin");
  if (origin === null) return "missing_origin";
  if (origin !== url.origin) return "bad_origin"; // includes "null"
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "cross_site";
  return null;
}

async function presentedIntent(request) {
  const header = request.headers.get("x-s2-intent");
  if (header) return header;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return "";
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return "";
  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return "";
  return new URLSearchParams(text).get("intent") ?? "";
}

async function control(request, env, url, action) {
  if (request.method === "GET" || request.method === "HEAD") {
    return confirmationPage(action, await computerStub(env).intentToken(action));
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }
  const refusal = originRefusal(request, url);
  if (refusal) {
    log("control-refused", { action, reason: refusal });
    return Response.json({ error: refusal }, { status: 403 });
  }
  const result = await computerStub(env).control(action, await presentedIntent(request));
  if (!result.ok) {
    log("control-refused", { action, reason: "bad_intent" });
    return Response.json({ error: "bad_intent" }, { status: 403 });
  }
  log("control", { action });
  const { ok: _, ...rest } = result;
  return Response.json({ build: BUILD.id, action, ...rest });
}

/** The public entry, behind owner-only Access. Only the owner can start or stop the spike. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = CONTROLS[url.pathname];
    if (action) return control(request, env, url, action);
    if (url.pathname === "/s2/status" && (request.method === "GET" || request.method === "HEAD")) {
      return Response.json({ build: BUILD.id, computer: await computerStub(env).status() });
    }
    return new Response("not found", { status: 404 });
  },
};
