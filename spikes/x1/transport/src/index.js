// Experiment X1: the staging transport comparison (pre-registration in the project notes,
// verification/x1-preregistration.md). One process in the computer container holds six
// WebSockets, one per route, each ending at an echo:
//
//   P1  p1.x1.internal → P1Route → ServerDO → container port, bridged (S2's path as built)
//   P2  p2.x1.internal → P2Route → ServerDO → container port, returned without accepting
//   P3  p3.x1.internal → P3Echo, a stateless handler that answers itself
//   P4  internet → this Worker's hostname (Access) → the stateless echo at /x1/echo
//   P5  internet → the Tunnel hostname (Access) → this Worker's policy route → Tunnel → cloudflared
//   P6  p6.x1.internal → P6Policy → Workers VPC service → Tunnel → cloudflared
//
// RunDO holds the run's schedule and forces the ServerDO resets. Results go to the R2 bucket:
// probe batches through rec.x1.internal, the server container's log pulled by ServerDO, and the
// Durable Objects' lifecycle events. Workers Logs get the same events as a secondary source.
// Throwaway spike code: lessons go into the design, not this file.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { BUILD } from "./build.js";
import { PUBLIC_ROUTES } from "./flags.js";
import {
  BLOCKED_PATH,
  bareHeaders,
  CREDENTIAL_HEADER,
  computerEnv,
  dueEvents,
  ECHO_PATH,
  echoReply,
  INTERCEPTS,
  issueCredential,
  lifecycleKey,
  logChunkKey,
  nextEventAt,
  parseRecorderPath,
  publicRun,
  RUN_ID,
  randomHex,
  refusal,
  routesFor,
  runIdFor,
  sameToken,
  schedule,
  stripTrust,
  TUNNEL_LABEL,
  verifyCredential,
  WORKER_NAME,
} from "./lib.js";

const ECHO_PORT = 8081;
const LOG_PORT = 8082;
// S2's keep-alive, unchanged: a 10-second alarm and a 30-minute inactivity timeout.
const ALARM_MS = 10_000;
const INACTIVITY_MS = 30 * 60_000;
const LOG_PULL_MS = 30_000;
const LOG_CHUNK_BYTES = 1 << 20;
const LOG_FETCH_TIMEOUT_MS = 5_000;
// One fixed name: the durable_object policy has no max_instances, so this keeps it to one.
const COMPUTER_ID = "c1";
const COMPUTER_IMAGE = "computer"; // the key under containers[].images in wrangler.jsonc
const COMPUTER_INSTANCE = "standard-1";
const END_POLL_MS = 10_000;
const END_GRACE_MS = 5 * 60_000;
const INTENT_TTL_MS = 10 * 60_000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const CONTROL_ACTIONS = ["preflight", "start", "stop"];

let isolate;
/** A random ID made once per isolate. Made lazily: global scope may not generate random values. */
function isolateId() {
  isolate ??= randomHex(8);
  return isolate;
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ x1: event, build: BUILD.id, t: Date.now(), ...fields }));
}

function errorText(error) {
  return String(error).slice(0, 200);
}

/** A lifecycle event: one object in the results bucket, and the same line in Workers Logs. */
async function record(env, runId, role, event, fields = {}) {
  const t = Date.now();
  log(event, { role, runId, ...fields });
  if (!runId || !env.RESULTS) return;
  const body = JSON.stringify({ x1: event, role, t, build: BUILD.id, runId, ...fields });
  try {
    await env.RESULTS.put(lifecycleKey(runId, t, role, randomHex(4)), body);
  } catch (error) {
    log("record-failed", { role, event, error: errorText(error) });
  }
}

function serverStub(env) {
  return env.SERVER.get(env.SERVER.idFromName("server"));
}

function computerStub(env) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(COMPUTER_ID));
}

function upgradeOf(request) {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
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

/** P3 and P4: a stateless echo that answers itself with a WebSocketPair. */
function statelessEcho(request, hop) {
  if (!upgradeOf(request)) return new Response("expected a WebSocket upgrade\n", { status: 426 });
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const opened = Date.now();
  const identity = { by: hop, isolate: isolateId(), build: BUILD.id };
  server.addEventListener("message", (event) => {
    const reply = echoReply(event.data, identity, Date.now());
    if (reply === null) return;
    try {
      server.send(reply);
    } catch {
      // the socket is closing; the probe records the drop
    }
  });
  server.addEventListener("close", (event) => {
    log("echo-close", { hop, code: event.code, ms: Date.now() - opened });
    try {
      server.close(event.code === 1005 || event.code === 1006 ? 1000 : event.code, "closing");
    } catch {
      // already closed
    }
  });
  log("echo-open", { hop, isolate: identity.isolate });
  return new Response(null, { status: 101, webSocket: client });
}

/** The identity a policy hop sets after stripping: the computer's, from trusted props. */
function setIdentity(headers, who, route) {
  headers.set("x-cfo-computer-id", String(who.computerId));
  headers.set("x-cfo-generation", String(who.generation));
  headers.set("x-x1-route", route);
}

/**
 * P1 and P2: S2's PrivateRoute. It strips trust headers, sets the computer's identity from its
 * props and forwards to the shared ServerDO, which treats the two routes differently.
 */
async function privateRoute(entry, request, route) {
  const props = entry.ctx.props ?? {};
  const url = new URL(request.url);
  if (url.pathname === BLOCKED_PATH) return refusal(`${route}-handler`);
  const headers = new Headers(request.headers);
  stripTrust(headers);
  setIdentity(headers, props, route);
  headers.set("x-x1-handler", isolateId());
  const started = Date.now();
  const response = await serverStub(entry.env).fetch(new Request(request, { headers }));
  // Path and status only: never bodies, query strings or headers.
  log("route", {
    route,
    path: url.pathname,
    upgrade: upgradeOf(request) || undefined,
    status: response.status,
    ms: Date.now() - started,
    generation: props.generation,
    registeredBy: props.registeredBy,
  });
  return response;
}

export class P1Route extends WorkerEntrypoint {
  fetch(request) {
    return privateRoute(this, request, "p1");
  }
}

export class P2Route extends WorkerEntrypoint {
  fetch(request) {
    return privateRoute(this, request, "p2");
  }
}

export class P3Echo extends WorkerEntrypoint {
  fetch(request) {
    return statelessEcho(request, "p3-handler");
  }
}

/**
 * P6: the private Tunnel's policy point, behind interception. P2's rules (here: the synthetic
 * block list), then the Workers VPC service. The upstream socket is returned without being
 * accepted, under a bare 101 for the container egress.
 */
export class P6Policy extends WorkerEntrypoint {
  async fetch(request) {
    const props = this.ctx.props ?? {};
    const url = new URL(request.url);
    if (url.pathname === BLOCKED_PATH) return refusal("p6-handler");
    if (!this.env.X1_VPC) return hopError("p6-handler", "no VPC service binding");
    const headers = new Headers(request.headers);
    stripTrust(headers);
    setIdentity(headers, props, "p6");
    headers.set("x-x1-policy", isolateId());
    const started = Date.now();
    let upstream;
    try {
      // The VPC service fixes the host and port; this URL gives only the path and Host header.
      upstream = await this.env.X1_VPC.fetch(
        new Request(`http://127.0.0.1:${ECHO_PORT}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: bodyOf(request),
        }),
      );
    } catch (error) {
      log("route-error", { route: "p6", error: errorText(error), ms: Date.now() - started });
      return hopError("p6-handler", "VPC service fetch failed");
    }
    log("route", {
      route: "p6",
      path: url.pathname,
      upgrade: upgradeOf(request) || undefined,
      status: upstream.status,
      ms: Date.now() - started,
      generation: props.generation,
    });
    if (!upstream.webSocket) return upstream;
    return new Response(null, {
      status: 101,
      webSocket: upstream.webSocket,
      headers: bareHeaders(upstream.headers),
    });
  }
}

function bodyOf(request) {
  return request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
}

function hopError(hop, message, status = 502) {
  return new Response(`${message}\n`, { status, headers: { "x-x1-hop": hop } });
}

/**
 * rec.x1.internal: stores the probe's numbered batches and its manifest in the results bucket,
 * each at most once (create-only), so a retried batch is never stored twice.
 */
export class Recorder extends WorkerEntrypoint {
  async fetch(request) {
    const props = this.ctx.props ?? {};
    const url = new URL(request.url);
    const target = request.method === "POST" ? parseRecorderPath(url.pathname) : null;
    if (!target) return new Response("not found\n", { status: 404 });
    if (Number(request.headers.get("content-length") ?? 0) > MAX_RECORD_BYTES) {
      return new Response("too large\n", { status: 413 });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_RECORD_BYTES) return new Response("too large\n", { status: 413 });
    const hash = await sha256Hex(body);
    const fields = {
      kind: target.kind,
      runId: target.runId,
      instance: target.instance,
      n: target.n,
    };
    let stored = false;
    try {
      let existing = await this.env.RESULTS.head(target.key);
      if (existing === null) {
        // Create-only, always: of two writes of one name, at most one is stored. Never an
        // unconditional put.
        const put = await this.env.RESULTS.put(target.key, body, {
          customMetadata: { sha256: hash, generation: String(props.generation) },
          onlyIf: new Headers({ "If-None-Match": "*" }),
        });
        stored = put !== null;
        if (!stored) existing = await this.env.RESULTS.head(target.key);
      }
      if (!stored && existing?.customMetadata?.sha256 !== hash) {
        // The name holds another body: acknowledging would hide the difference.
        log("record-conflict", fields);
        return Response.json({ stored: false, conflict: true }, { status: 409 });
      }
    } catch (error) {
      // The outcome is uncertain: the probe retries, and the retry checks what is stored.
      log("record-error", { ...fields, error: errorText(error) });
      return Response.json({ stored: false, retry: true }, { status: 503 });
    }
    log("recorded", { ...fields, bytes: body.byteLength, stored });
    return Response.json({ stored, existed: !stored });
  }
}

async function sha256Hex(body) {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let routeKeyCache = null;

/**
 * What P5 checks a credential against. The key never changes, so it is cached per isolate.
 * The current generation is read from ComputerDO on every handshake (handshakes are rare), so
 * a credential of a generation that has been replaced is refused at once (probe review r1,
 * finding 5).
 */
async function routeInfo(env) {
  const computer = computerStub(env);
  routeKeyCache ??= await computer.routeKey();
  return { computerId: COMPUTER_ID, key: routeKeyCache, generation: await computer.generation() };
}

/** Test hook: forget the cached route key. */
export function resetRouteInfoCache() {
  routeKeyCache = null;
}

/**
 * P5: the public Tunnel's policy point, a Worker route on the Tunnel hostname behind Access. It
 * verifies the per-computer route credential, strips trust headers, sets the identity, refuses
 * the block list, then forwards to the Tunnel origin and returns the upstream response as it
 * came, without accepting its socket.
 */
async function tunnelRoute(request, env, url) {
  if (!PUBLIC_ROUTES) return new Response("not found\n", { status: 404 });
  if (url.pathname === BLOCKED_PATH) return refusal("p5-route");
  const presented = request.headers.get(CREDENTIAL_HEADER) ?? "";
  let verdict;
  try {
    const info = await routeInfo(env);
    verdict = await verifyCredential(presented, info);
  } catch (error) {
    log("route-error", { route: "p5", error: errorText(error) });
    return hopError("p5-route", "route credential check failed", 503);
  }
  if (!verdict.ok) {
    log("route-refused", { route: "p5", reason: verdict.reason });
    return refusal("p5-route", verdict.reason);
  }
  const headers = new Headers(request.headers);
  stripTrust(headers);
  setIdentity(headers, verdict, "p5");
  headers.set("x-x1-policy", isolateId());
  const started = Date.now();
  let upstream;
  try {
    // The same URL: a subrequest to the route's own hostname goes to its origin, the Tunnel.
    upstream = await fetch(
      new Request(url, { method: request.method, headers, body: bodyOf(request) }),
    );
  } catch (error) {
    log("route-error", { route: "p5", error: errorText(error), ms: Date.now() - started });
    return hopError("p5-route", "Tunnel origin fetch failed");
  }
  log("route", {
    route: "p5",
    path: url.pathname,
    upgrade: upgradeOf(request) || undefined,
    status: upstream.status,
    ms: Date.now() - started,
    generation: verdict.generation,
  });
  return upstream;
}

/** Shared lifecycle for both container DOs: S2's self-rearming alarm and inactivity timeout. */
class Keeper extends DurableObject {
  constructor(ctx, env, role) {
    super(ctx, env);
    this.role = role;
    this.instanceId = randomHex(8);
    ctx.blockConcurrencyWhile(async () => {
      const running = ctx.container?.running ?? false;
      this.runId = (await ctx.storage.get("run"))?.runId;
      log(`${role}-wake`, { running, instance: this.instanceId });
      if (running) {
        await ctx.container.setInactivityTimeout(INACTIVITY_MS);
        await this.onWakeRunning();
      }
      if ((await ctx.storage.get("wanted")) && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + ALARM_MS);
      }
      // Not awaited: the first request after a reset does not wait for R2.
      const constructed = record(env, this.runId, role, "constructed", {
        instance: this.instanceId,
        running,
      });
      ctx.waitUntil?.(constructed);
    });
  }

  async onWakeRunning() {}

  async afterAlarm() {}

  async beforeStop() {}

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
      log(`${this.role}-alarm-error`, { error: errorText(error) });
    }
    await this.afterAlarm();
  }

  async stop() {
    await this.beforeStop();
    await this.ctx.storage.put("wanted", false);
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container.running) await this.ctx.container.destroy("x1 stop");
    await record(this.env, this.runId, this.role, "stopped", { instance: this.instanceId });
    return { stopped: true };
  }

  async setRun(run) {
    if (!run) return;
    await this.ctx.storage.put("run", run);
    this.runId = run.runId;
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ServerDO extends Keeper {
  constructor(ctx, env) {
    super(ctx, env, "server");
    this.ready = false;
  }

  async ensure(run) {
    await this.setRun(run);
    await this.ctx.storage.put("wanted", true);
    const container = this.ctx.container;
    if (!container.running) {
      this.ready = false;
      // The Tunnel token is a Worker secret, given only to the server container.
      const env = this.env.X1_TUNNEL_TOKEN ? { X1_TUNNEL_TOKEN: this.env.X1_TUNNEL_TOKEN } : {};
      container.start({ enableInternet: true, env });
      await container.setInactivityTimeout(INACTIVITY_MS);
      await record(this.env, this.runId, "server", "container-start", {
        instance: this.instanceId,
        tunnel: Boolean(this.env.X1_TUNNEL_TOKEN),
      });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
    return { running: container.running };
  }

  async waitReady() {
    if (this.ready) return;
    const port = this.ctx.container.getTcpPort(ECHO_PORT);
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

  /** P1 and P2 arrive here from their handlers; x-x1-route says which. */
  async fetch(request) {
    const route = request.headers.get("x-x1-route");
    await this.ensure();
    try {
      await this.waitReady();
      const headers = new Headers(request.headers);
      headers.set("x-x1-serverdo", this.instanceId);
      const upstream = await this.ctx.container
        .getTcpPort(ECHO_PORT)
        .fetch(new Request(request, { headers }));
      if (!upstream.webSocket) return upstream;
      if (route === "p2") {
        // A′, native forwarding: the container port's socket is handed back as it came, never
        // accepted here, under the bare 101 the container egress needs.
        return new Response(null, {
          status: 101,
          webSocket: upstream.webSocket,
          headers: bareHeaders(upstream.headers),
        });
      }
      // P1, S2 as built: bridge the socket and answer with no handshake headers.
      return new Response(null, {
        status: 101,
        webSocket: bridgeSocket(upstream.webSocket),
        headers: bareHeaders(upstream.headers),
      });
    } catch (error) {
      this.ready = false;
      log("server-proxy-error", { route, error: errorText(error) });
      return new Response("server unavailable", { status: 502 });
    }
  }

  /** A forced reset, requested by RunDO. Recorded first; abort cannot be caught. */
  async reset(reason) {
    await record(this.env, this.runId, "server", "abort", {
      instance: this.instanceId,
      reason: String(reason).slice(0, 100),
    });
    this.ctx.abort(reason);
  }

  async afterAlarm() {
    const last = (await this.ctx.storage.get("logPulledAt")) ?? 0;
    if (Date.now() - last < LOG_PULL_MS) return;
    await this.ctx.storage.put("logPulledAt", Date.now());
    await this.pullLog();
  }

  async beforeStop() {
    await this.pullLog();
  }

  /**
   * Copies the server container's log (echo and cloudflared events) into the bucket from the
   * stored offset. A new container has a new log ID, and its log is read from offset 0.
   */
  async pullLog() {
    if (!this.runId || !this.ctx.container.running) return;
    let state = (await this.ctx.storage.get("log")) ?? { id: null, offset: 0 };
    try {
      const port = this.ctx.container.getTcpPort(LOG_PORT);
      for (let i = 0; i < 16; i++) {
        const res = await withTimeout(
          port.fetch(`http://container/log?offset=${state.offset}`),
          LOG_FETCH_TIMEOUT_MS,
          "log fetch",
        );
        if (!res.ok) {
          log("log-pull-status", { status: res.status });
          return;
        }
        const id = res.headers.get("x-x1-log-id") ?? "unknown";
        if (id !== state.id) {
          const restart = state.offset !== 0;
          state = { id, offset: 0 };
          await this.ctx.storage.put("log", state);
          if (restart) continue;
        }
        const body = await res.arrayBuffer();
        if (body.byteLength === 0) return;
        await this.env.RESULTS.put(logChunkKey(this.runId, id, state.offset), body);
        state = { id, offset: state.offset + body.byteLength };
        await this.ctx.storage.put("log", state);
        if (body.byteLength < LOG_CHUNK_BYTES) return;
      }
    } catch (error) {
      log("log-pull-error", { error: errorText(error) });
    }
  }
}

export class ComputerDO extends Keeper {
  constructor(ctx, env) {
    super(ctx, env, "computer");
  }

  /** S2 as built: intercepts are registered again when the object wakes to a running container. */
  async onWakeRunning() {
    await this.intercept();
  }

  async intercept() {
    const generation = (await this.ctx.storage.get("generation")) ?? 0;
    const started = Date.now();
    // registeredBy names the Worker version that registered the intercept.
    const props = { computerId: COMPUTER_ID, generation, registeredBy: BUILD.id };
    for (const [host, entrypoint] of INTERCEPTS) {
      await this.ctx.container.interceptOutboundHttp(host, this.ctx.exports[entrypoint]({ props }));
    }
    log("intercept", { hosts: INTERCEPTS.length, generation, ms: Date.now() - started });
  }

  /** The route-credential key, made once and held only in this object's storage. */
  async routeKey() {
    let key = await this.ctx.storage.get("routeKey");
    if (!key) {
      key = randomHex(32);
      await this.ctx.storage.put("routeKey", key);
    }
    return key;
  }

  /** For P5's policy route, on every handshake: the computer's current generation. */
  async generation() {
    return (await this.ctx.storage.get("generation")) ?? 0;
  }

  async ensure(run) {
    const container = this.ctx.container;
    const previous = (await this.ctx.storage.get("run"))?.runId;
    if (run && container.running && previous !== run.runId) {
      // A container left from another run would carry that run's schedule: replace it.
      await container.destroy("x1 new run");
      await record(this.env, run.runId, "computer", "stale-container-destroyed", {
        instance: this.instanceId,
        previous: previous ?? null,
      });
    }
    await this.setRun(run);
    const current = run ?? (await this.ctx.storage.get("run"));
    if (!current) throw new Error("no run to start the computer for");
    await this.ctx.storage.put("wanted", true);
    if (!container.running) {
      const generation = ((await this.ctx.storage.get("generation")) ?? 0) + 1;
      await this.ctx.storage.put("generation", generation);
      // Intercepts registered before start, so the first lookup already resolves.
      await this.intercept();
      const credential = await issueCredential(await this.routeKey(), COMPUTER_ID, generation);
      // The durable_object policy: the image comes from the Worker version's image map and the
      // size is chosen here, at each start.
      const image = container.images[COMPUTER_IMAGE];
      container.start({
        image,
        instance: COMPUTER_INSTANCE,
        enableInternet: true,
        env: computerEnv(current, generation, credential, {
          clientId: this.env.X1_ACCESS_CLIENT_ID,
          clientSecret: this.env.X1_ACCESS_CLIENT_SECRET,
        }),
      });
      await container.setInactivityTimeout(INACTIVITY_MS);
      await record(this.env, current.runId, "computer", "container-start", {
        instance: this.instanceId,
        generation,
        instanceType: COMPUTER_INSTANCE,
        routes: current.routes,
      });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
    return { running: container.running };
  }
}

/**
 * The run: its schedule, the forced resets and the end. The owner starts it from the UI
 * Worker, which reaches this object through a cross-script binding and IR-017 controls.
 */
export class RunDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.instanceId = randomHex(8);
    this.constructedAt = Date.now();
    this.constructionRecorded = false;
    this.intents = {};
  }

  /**
   * Records this object's construction on its first alarm or control, never on a status read,
   * so a GET writes nothing.
   */
  async noteConstruction(run) {
    if (this.constructionRecorded || !run) return;
    this.constructionRecorded = true;
    await record(this.env, run.runId, "run", "constructed", {
      instance: this.instanceId,
      constructedAt: this.constructedAt,
    });
  }

  /**
   * IR-017 request-intent token for one action. Random, held in this object's memory only (so
   * showing the confirmation page writes nothing), valid for INTENT_TTL_MS and used once.
   */
  intentToken(action) {
    if (!CONTROL_ACTIONS.includes(action)) throw new Error("unknown action");
    const held = this.intents[action];
    if (!held || Date.now() - held.issuedAt > INTENT_TTL_MS) {
      this.intents[action] = { value: randomHex(32), issuedAt: Date.now() };
    }
    return this.intents[action].value;
  }

  /** The only way the UI changes state: the token is checked and spent first. */
  async control(action, presented, context = {}) {
    const held = this.intents[action];
    if (
      !CONTROL_ACTIONS.includes(action) ||
      !held ||
      Date.now() - held.issuedAt > INTENT_TTL_MS ||
      !sameToken(String(presented ?? ""), held.value)
    ) {
      return { ok: false };
    }
    delete this.intents[action];
    if (action === "stop") return { ok: true, ...(await this.halt("stopped by the owner")) };
    return { ok: true, ...(await this.begin(action === "start" ? "run" : "preflight", context)) };
  }

  async begin(mode, context) {
    const current = await this.ctx.storage.get("run");
    await this.noteConstruction(current);
    if (current && (current.status === "active" || current.status === "ending")) {
      return { started: false, error: "a run is active", runId: current.runId };
    }
    const zone = context.zone;
    if (typeof zone !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) {
      return { started: false, error: "no valid zone" };
    }
    const t0 = Date.now();
    const publicRoutes = Boolean(
      PUBLIC_ROUTES && this.env.X1_ACCESS_CLIENT_ID && this.env.X1_ACCESS_CLIENT_SECRET,
    );
    const run = {
      runId: runIdFor(mode, t0),
      ...schedule(mode, t0),
      status: "active",
      publicRoutesFlag: PUBLIC_ROUTES,
      publicRoutes,
      routes: routesFor(publicRoutes),
      build: BUILD.id,
      // Names the deployment, so the analysis can tell a preflight of this one (Amendment 3).
      worker: WORKER_NAME,
      zone,
    };
    // Persist before effect: the run exists in storage and in the bucket before any container.
    await this.ctx.storage.put("run", run);
    this.constructionRecorded = true;
    await this.env.RESULTS.put(`runs/${run.runId}/run.json`, JSON.stringify(publicRun(run)));
    await this.env.RESULTS.put("runs/current.json", JSON.stringify(currentPointer(run)));
    await this.ctx.storage.setAlarm(nextEventAt(run.events));
    await record(this.env, run.runId, "run", "run-start", {
      instance: this.instanceId,
      mode,
      t0,
      routes: run.routes,
      publicRoutes,
    });
    await serverStub(this.env).ensure({ runId: run.runId });
    await computerStub(this.env).ensure(run);
    return { started: true, runId: run.runId, mode, t0 };
  }

  async alarm() {
    const run = await this.ctx.storage.get("run");
    await this.noteConstruction(run);
    if (!run || (run.status !== "active" && run.status !== "ending")) return;
    const now = Date.now();
    for (const event of dueEvents(run.events, now)) {
      // Persist before effect: an event is marked done before it acts, so it acts at most once.
      event.doneAt = Date.now();
      if (event.kind === "end") {
        run.status = "ending";
        run.endingSince = event.doneAt;
      }
      await this.ctx.storage.put("run", run);
      if (event.kind === "reset") await this.forceReset(run, event);
      if (event.kind === "end") {
        await record(this.env, run.runId, "run", "end-reached", { planned: event.at });
      }
    }
    if (run.status === "ending") {
      const manifests = await this.manifests(run.runId);
      if (manifests.length > 0 || Date.now() - run.endingSince > END_GRACE_MS) {
        await this.finish(run, "end", manifests);
        return;
      }
      await this.ctx.storage.setAlarm(Date.now() + END_POLL_MS);
      return;
    }
    const next = nextEventAt(run.events);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  async forceReset(run, event) {
    const R = Date.now();
    await record(this.env, run.runId, "run", "reset-requested", {
      event: event.id,
      R,
      planned: event.at,
      instance: this.instanceId,
    });
    try {
      await serverStub(this.env).reset(`x1 forced reset ${event.id}`);
      await record(this.env, run.runId, "run", "reset-call-ended", { event: event.id });
    } catch (error) {
      // Expected: the aborted object cannot answer.
      await record(this.env, run.runId, "run", "reset-call-ended", {
        event: event.id,
        error: errorText(error),
      });
    }
  }

  /** The probe's manifests (its completion markers) in the bucket. */
  async manifests(runId) {
    const keys = [];
    let cursor;
    do {
      const page = await this.env.RESULTS.list({ prefix: `runs/${runId}/probe/`, cursor });
      for (const object of page.objects) {
        // A manifest, or the failure record that replaces one, ends the probe's run.
        if (/\/(manifest|failure)\.json$/.test(object.key)) keys.push(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  async finish(run, reason, manifests) {
    run.status = reason === "end" ? "ended" : "stopped";
    run.endedAt = Date.now();
    await this.ctx.storage.put("run", run);
    await this.ctx.storage.deleteAlarm();
    const stops = {};
    for (const [role, stub] of [
      ["computer", computerStub(this.env)],
      ["server", serverStub(this.env)],
    ]) {
      try {
        stops[role] = await stub.stop();
      } catch (error) {
        stops[role] = { error: errorText(error) };
      }
    }
    const end = { runId: run.runId, reason, endedAt: run.endedAt, manifests, stops };
    await this.env.RESULTS.put(`runs/${run.runId}/end.json`, JSON.stringify(end));
    await this.env.RESULTS.put("runs/current.json", JSON.stringify(currentPointer(run)));
    await record(this.env, run.runId, "run", "run-finished", {
      reason,
      manifests: manifests.length,
    });
    return end;
  }

  async halt(reason) {
    const run = await this.ctx.storage.get("run");
    await this.noteConstruction(run);
    if (!run || (run.status !== "active" && run.status !== "ending")) {
      // Nothing scheduled: still make sure both containers are down.
      await this.ctx.storage.deleteAlarm();
      await computerStub(this.env).stop();
      await serverStub(this.env).stop();
      return { stopped: true, runId: run?.runId ?? null };
    }
    const manifests = await this.manifests(run.runId);
    return { stopped: true, ...(await this.finish(run, reason, manifests)) };
  }

  /** Read-only: the run's public record and the next alarm. */
  async status() {
    const run = await this.ctx.storage.get("run");
    return {
      build: BUILD.id,
      run: run ? publicRun(run) : null,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}

function currentPointer(run) {
  if (!RUN_ID.test(run.runId)) throw new Error("bad run ID");
  return {
    runId: run.runId,
    mode: run.mode,
    t0: run.t0,
    soakStart: run.soakStart,
    soakEnd: run.soakEnd,
    tailEnd: run.tailEnd,
    status: run.status,
    build: run.build,
  };
}

/**
 * The public entry: this Worker's own hostname (P4's echo) and, through the route the staging
 * tool adds, the Tunnel hostname (P5's policy route). Both are behind Access. Nothing here
 * changes state: the controls live on the UI Worker.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith(`${TUNNEL_LABEL}.`)) return tunnelRoute(request, env, url);
    if (PUBLIC_ROUTES && url.pathname === ECHO_PATH) return statelessEcho(request, "p4-worker");
    return new Response("not found\n", { status: 404 });
  },
};
