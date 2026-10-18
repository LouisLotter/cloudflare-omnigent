// Spike S1: lifecycle and wake time of a cloud computer.
//
// Two containers, each owned by one Durable Object:
//   - S1Server runs the published Omnigent server (SQLite, login off), kept awake for the
//     experiment. Only this Worker's own code reaches it.
//   - S1Computer runs the published Omnigent host image. Its host connects to the server at
//     http://omnigent.internal, which an outbound intercept (HostRoute) forwards to S1Server,
//     as the design's private host route does.
//
// The Worker sits behind owner-only Access, so the experiment runs itself from Durable Object
// alarms after one kickoff request (GET /s1/kickoff). It is steered afterwards by redeploying
// with a new S1_COMMAND variable, which the idle alarm picks up. Every measurement is written
// to Workers Logs as one JSON line ({"s1": "<event>", ...}) and kept in S1Computer's storage.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

const SERVER_NAME = "server";
const COMPUTER_NAME = "computer-1";
const HOST_NAME = "s1-computer-1";
const SERVER_PORT = 8000;
const SERVER_TIMEOUT_MS = 30 * 60_000;
const IDLE_ALARM_MS = 2 * 60_000;
const WAKE_DEADLINE_MS = 240_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(event, data = {}) {
  console.log(JSON.stringify({ s1: event, wt: Date.now(), ...data }));
}

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Parses "c3:wake=3,heartbeat" into an ID and phase list. */
function parseCommand(text) {
  if (!text) return null;
  const [id, list] = text.split(":");
  if (!id || !list) return null;
  const phases = list.split(",").map((item) => {
    const [kind, arg] = item.split("=");
    return { kind: kind.trim(), arg: arg === undefined ? undefined : Number(arg) };
  });
  return { id, phases };
}

export class S1Server extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    if (ctx.container?.running) {
      ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(SERVER_TIMEOUT_MS));
    }
  }

  /** Starts the server container if needed and waits for /health. */
  async ensureUp() {
    const container = this.ctx.container;
    const t0 = Date.now();
    const started = !container.running;
    if (started) container.start({ enableInternet: true });
    await container.setInactivityTimeout(SERVER_TIMEOUT_MS);
    const port = container.getTcpPort(SERVER_PORT);
    while (Date.now() - t0 < 300_000) {
      try {
        const response = await port.fetch("http://server/health");
        if (response.ok) return { started, readyMs: Date.now() - t0 };
      } catch {
        // Not listening yet.
      }
      await sleep(500);
    }
    return { started, readyMs: null };
  }

  /** Renews the server's inactivity timeout; called from the computer's alarms. */
  async keepAlive() {
    if (!this.ctx.container.running) return false;
    await this.ctx.container.setInactivityTimeout(SERVER_TIMEOUT_MS);
    return true;
  }

  async stop() {
    if (this.ctx.container.running) await this.ctx.container.destroy();
  }

  /** The host's status as the Omnigent server reports it: online, offline or absent. */
  async hostStatus(hostId) {
    const response = await this.ctx.container
      .getTcpPort(SERVER_PORT)
      .fetch(`http://server/v1/hosts/${hostId}`);
    if (response.status === 404) return "absent";
    if (!response.ok) return `http-${response.status}`;
    const body = await response.json();
    return body.status;
  }

  /** Records a timestamped mark from the computer route (boot, SIGTERM, first request). */
  async mark(entry, once = false) {
    const key = `mark:${entry.run}:${entry.ev}`;
    if (once && (await this.ctx.storage.get(key)) !== undefined) return;
    const list = (await this.ctx.storage.get(key)) ?? [];
    list.push(entry);
    await this.ctx.storage.put(key, list);
  }

  async marks(run) {
    const found = await this.ctx.storage.list({ prefix: `mark:${run}:` });
    const out = {};
    for (const [key, list] of found) out[key.slice(`mark:${run}:`.length)] = list;
    return out;
  }

  /** Proxies a request from the computer (HTTP or a WebSocket upgrade) to the server. */
  async fetch(request) {
    if (!this.ctx.container.running) return new Response("server not running", { status: 503 });
    return this.ctx.container.getTcpPort(SERVER_PORT).fetch(request);
  }
}

/** The computer's private route to the server: an outbound intercept for omnigent.internal. */
export class HostRoute extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const props = this.ctx.props ?? {};
    const server = this.env.SERVER.get(this.env.SERVER.idFromName(SERVER_NAME));
    const wt = Date.now();
    if (url.pathname === "/__s1/mark") {
      const entry = { ...Object.fromEntries(url.searchParams), wt, version: this.env.S1_VERSION };
      log("mark", entry);
      await server.mark(entry);
      return new Response("ok");
    }
    const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const ev = upgrade ? "ws" : "http";
    if (upgrade)
      log("ws-upgrade", { run: props.run, path: url.pathname, version: this.env.S1_VERSION });
    this.ctx.waitUntil(server.mark({ run: props.run, ev, wt, path: url.pathname }, true));
    return server.fetch(request);
  }
}

const PHASE_DEFAULTS = {
  wake: { runs: 20, gapMs: 20_000, timeoutMs: 600_000 },
  heartbeat: { minutes: 20, alarmMs: 60_000, timeoutMs: 180_000 },
  "no-heartbeat": { timeoutMs: 120_000, waitMs: 480_000 },
  eviction: { cycles: 4, gapMs: 180_000, timeoutMs: 360_000, rearm: true },
  "eviction-control": { cycles: 4, gapMs: 180_000, timeoutMs: 360_000, rearm: false },
  redeploy: { postMinutes: 10, alarmMs: 60_000, timeoutMs: 180_000, maxWaitMinutes: 90 },
  snapshot: { gapMs: 20_000 },
};

export class S1Computer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.instance = crypto.randomUUID().slice(0, 8);
    this.bornAt = Date.now();
    ctx.blockConcurrencyWhile(async () => {
      const running = Boolean(ctx.container?.running);
      const rearm = (await ctx.storage.get("rearm")) !== false && env.S1_REARM !== "0";
      const timeoutMs = (await ctx.storage.get("timeoutMs")) ?? 180_000;
      let rearmed = false;
      if (running && rearm) {
        await ctx.container.setInactivityTimeout(timeoutMs);
        rearmed = true;
      }
      const record = {
        instance: this.instance,
        version: env.S1_VERSION,
        at: this.bornAt,
        running,
        rearmed,
        timeoutMs,
      };
      await ctx.storage.put("constructed", record);
      log("computer-constructed", record);
    });
  }

  get server() {
    return this.env.SERVER.get(this.env.SERVER.idFromName(SERVER_NAME));
  }

  // ---- entry points -------------------------------------------------------------------

  async kickoff() {
    const existing = await this.ctx.storage.get("hostId");
    if (existing === undefined) {
      await this.ctx.storage.put("hostId", crypto.randomUUID().replaceAll("-", ""));
      await this.ctx.storage.put("queue", []);
      await this.ctx.storage.put("seq", 0);
      log("kickoff", { version: this.env.S1_VERSION });
    }
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }
    return this.status();
  }

  async status() {
    return {
      instance: this.instance,
      version: this.env.S1_VERSION,
      command: (await this.ctx.storage.get("lastCommand")) ?? null,
      phase: (await this.ctx.storage.get("phase")) ?? null,
      queue: (await this.ctx.storage.get("queue")) ?? [],
      alarm: await this.ctx.storage.getAlarm(),
      running: Boolean(this.ctx.container?.running),
    };
  }

  async results() {
    const out = [];
    for (const [, value] of await this.ctx.storage.list({ prefix: "result:" })) out.push(value);
    return out;
  }

  async alarm() {
    // A safety alarm first, so that no failure below ends the experiment's alarm chain.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_ALARM_MS);
    let next = Date.now() + IDLE_ALARM_MS;
    try {
      await this.server.keepAlive().catch(() => false);
      next = await this.step();
    } catch (error) {
      log("error", { instance: this.instance, error: errorText(error) });
      await this.ctx.storage.delete("phase");
    }
    await this.ctx.storage.setAlarm(next);
  }

  // ---- helpers ------------------------------------------------------------------------

  async record(event, data) {
    const seq = ((await this.ctx.storage.get("seq")) ?? 0) + 1;
    await this.ctx.storage.put("seq", seq);
    const entry = { s1: event, seq, wt: Date.now(), instance: this.instance, ...data };
    await this.ctx.storage.put(`result:${String(seq).padStart(5, "0")}`, entry);
    console.log(JSON.stringify(entry));
    return entry;
  }

  async incarnation() {
    const container = this.ctx.container;
    if (!container.running) return null;
    try {
      const process = await container.exec(["cat", "/tmp/s1-incarnation"]);
      const output = await process.output();
      return new TextDecoder().decode(output.stdout).trim() || null;
    } catch (error) {
      return `exec-error: ${errorText(error)}`;
    }
  }

  /** The computer image under the durable_object policy, or null under the default policy. */
  policyImage() {
    try {
      return this.ctx.container.images?.computer ?? null;
    } catch {
      return null;
    }
  }

  async setTimeoutMs(timeoutMs) {
    await this.ctx.storage.put("timeoutMs", timeoutMs);
    if (this.ctx.container.running) await this.ctx.container.setInactivityTimeout(timeoutMs);
  }

  /** Destroys the computer container and waits until the server reports the host offline. */
  async stopComputer() {
    const container = this.ctx.container;
    const hostId = await this.ctx.storage.get("hostId");
    const t0 = Date.now();
    const wasRunning = container.running;
    if (wasRunning) await container.destroy();
    while (container.running && Date.now() - t0 < 60_000) await sleep(200);
    const stoppedMs = Date.now() - t0;
    let status = await this.server.hostStatus(hostId);
    while (status === "online" && Date.now() - t0 < 120_000) {
      await sleep(500);
      status = await this.server.hostStatus(hostId);
    }
    return { wasRunning, stoppedMs, offlineMs: Date.now() - t0, status };
  }

  /** One wake: start the container and wait until the server reports the host online. */
  async wake(run, timeoutMs, snapshot = null) {
    const container = this.ctx.container;
    const hostId = await this.ctx.storage.get("hostId");
    const gen = ((await this.ctx.storage.get("gen")) ?? 0) + 1;
    await this.ctx.storage.put("gen", gen);
    await this.ctx.storage.put("currentRun", run);
    const route = this.ctx.exports.HostRoute({ props: { run, gen } });
    let interceptError = null;
    const intercept = async () => {
      await container.interceptOutboundHttp("omnigent.internal", route);
      await container.interceptOutboundHttp("10.199.0.1:80", route);
    };
    let interceptedBeforeStart = true;
    try {
      await intercept();
    } catch (error) {
      interceptedBeforeStart = false;
      interceptError = errorText(error);
    }
    const options = {
      enableInternet: true,
      env: {
        OMNIGENT_HOST_ID: hostId,
        OMNIGENT_HOST_NAME: HOST_NAME,
        S1_RUN: run,
        S1_GEN: String(gen),
      },
    };
    // Under the durable_object policy the code picks the image (or snapshot) and the size.
    const image = this.policyImage();
    if (image) {
      if (snapshot) options.containerSnapshot = snapshot;
      else options.image = image;
      options.instance = this.env.S1_INSTANCE ?? "standard-2";
    }
    const t0 = Date.now();
    try {
      container.start(options);
    } catch (error) {
      return { run, gen, ok: false, error: `start: ${errorText(error)}` };
    }
    const startReturnedMs = Date.now() - t0;
    if (!interceptedBeforeStart) await intercept();
    await this.setTimeoutMs(timeoutMs);
    let status = null;
    let polls = 0;
    let pollError = null;
    while (Date.now() - t0 < WAKE_DEADLINE_MS) {
      try {
        status = await this.server.hostStatus(hostId);
      } catch (error) {
        pollError = errorText(error);
      }
      polls++;
      if (status === "online") break;
      if (!container.running && Date.now() - t0 > 5000) break;
      await sleep(polls < 240 ? 250 : 1000);
    }
    const onlineMs = Date.now() - t0;
    const marks = await this.server.marks(run);
    const rel = (list) => (list?.[0] ? list[0].wt - t0 : null);
    const boot = marks.boot?.[0] ?? {};
    return {
      run,
      gen,
      ok: status === "online",
      status,
      onlineMs: status === "online" ? onlineMs : null,
      elapsedMs: onlineMs,
      startReturnedMs,
      bootMarkMs: rel(marks.boot),
      firstHttpMs: rel(marks.http),
      wsUpgradeMs: rel(marks.ws),
      containerClockSkewMs: boot.ct ? Number(boot.ct) - boot.wt : null,
      bootToMarkMs: boot.ct && boot.boot ? Number(boot.ct) - Number(boot.boot) : null,
      dns: boot.dns ?? null,
      location: boot.loc ?? null,
      region: boot.region ?? null,
      country: boot.country ?? null,
      polls,
      pollError,
      policy: image ? "durable_object" : "default",
      fromSnapshot: Boolean(image && snapshot),
      interceptedBeforeStart,
      interceptError,
      running: container.running,
    };
  }

  // ---- the experiment ---------------------------------------------------------------

  /** Runs one step of the current phase and returns when the next alarm should fire. */
  async step() {
    let phase = await this.ctx.storage.get("phase");
    if (!phase) {
      const queue = (await this.ctx.storage.get("queue")) ?? [];
      const command = parseCommand(this.env.S1_COMMAND);
      const last = await this.ctx.storage.get("lastCommand");
      if (command && command.id !== last) {
        await this.ctx.storage.put("lastCommand", command.id);
        queue.push(...command.phases);
        await this.record("command", { id: command.id, phases: command.phases });
      }
      const nextPhase = queue.shift();
      await this.ctx.storage.put("queue", queue);
      if (!nextPhase) return Date.now() + IDLE_ALARM_MS;
      phase = { ...nextPhase, state: {} };
      await this.ctx.storage.put("phase", phase);
      await this.record("phase-start", { kind: phase.kind, arg: phase.arg });
    }
    const handler = this[`phase_${phase.kind.replaceAll("-", "_")}`];
    if (!handler) {
      await this.record("phase-unknown", { kind: phase.kind });
      await this.ctx.storage.delete("phase");
      return Date.now() + 1000;
    }
    const options = { ...(PHASE_DEFAULTS[phase.kind] ?? {}) };
    const result = await handler.call(this, phase.state, options, phase.arg);
    if (result.done) {
      await this.ctx.storage.delete("phase");
      await this.record("phase-end", { kind: phase.kind });
      return Date.now() + (result.delayMs ?? 1000);
    }
    phase.state = result.state;
    await this.ctx.storage.put("phase", phase);
    return Date.now() + result.delayMs;
  }

  async phase_server_up() {
    const result = await this.server.ensureUp();
    await this.record("server-up", result);
    return { done: true, delayMs: 2000 };
  }

  /** Repeated wakes from a stopped container: stop, wait the gap, start and time. */
  async phase_wake(state, options, arg) {
    const runs = arg ?? options.runs;
    const i = state.i ?? 0;
    if (i >= runs) {
      await this.stopComputer();
      return { done: true };
    }
    if (!state.stopped) {
      const stop = await this.stopComputer();
      await this.record("wake-stop", { index: i, ...stop });
      return { state: { ...state, stopped: true }, delayMs: options.gapMs };
    }
    if (this.ctx.container.running) {
      // A retried alarm after a restart of this object: stop again before measuring.
      await this.record("wake-retry", { index: i, ...(await this.stopComputer()) });
      return { state: { ...state, stopped: true }, delayMs: options.gapMs };
    }
    const label = (await this.ctx.storage.get("wakeLabel")) ?? "";
    const run = `w${(await this.ctx.storage.get("gen")) ?? 0}`;
    const result = await this.wake(run, options.timeoutMs);
    await this.record("wake", { index: i, label, version: this.env.S1_VERSION, ...result });
    return { state: { i: i + 1, stopped: false }, delayMs: 10_000 };
  }

  /** Ensures a running, online computer for the lifetime phases; returns its incarnation. */
  async ensureComputer(timeoutMs, kind) {
    const hostId = await this.ctx.storage.get("hostId");
    if (this.ctx.container.running && (await this.server.hostStatus(hostId)) === "online") {
      await this.setTimeoutMs(timeoutMs);
      return { incarnation: await this.incarnation(), fresh: false };
    }
    await this.stopComputer();
    const run = `${kind}${(await this.ctx.storage.get("gen")) ?? 0}`;
    const result = await this.wake(run, timeoutMs);
    await this.record("wake", { index: -1, label: kind, version: this.env.S1_VERSION, ...result });
    return { incarnation: await this.incarnation(), fresh: true };
  }

  async check(state) {
    const hostId = await this.ctx.storage.get("hostId");
    const running = this.ctx.container.running;
    const incarnation = running ? await this.incarnation() : null;
    const marks = state.run ? await this.server.marks(state.run) : {};
    return {
      running,
      incarnation,
      bootCount: (marks.boot ?? []).length,
      sameIncarnation: incarnation !== null && incarnation === state.incarnation,
      hostStatus: await this.server.hostStatus(hostId).catch((e) => `error ${errorText(e)}`),
      instanceChanged: state.instance !== undefined && state.instance !== this.instance,
      sinceStartMs: state.startedAt ? Date.now() - state.startedAt : null,
    };
  }

  /** The design's heartbeat: an alarm about every minute renews the inactivity timeout. */
  async phase_heartbeat(state, options, arg) {
    const minutes = arg ?? options.minutes;
    await this.ctx.storage.put("rearm", true);
    if (!state.startedAt) {
      const { incarnation } = await this.ensureComputer(options.timeoutMs, "hb");
      const run = await this.ctx.storage.get("currentRun");
      const startedAt = Date.now();
      await this.record("heartbeat-start", { incarnation, run, timeoutMs: options.timeoutMs });
      return {
        state: { startedAt, incarnation, run, instance: this.instance },
        delayMs: options.alarmMs,
      };
    }
    const check = await this.check(state);
    if (check.running) await this.setTimeoutMs(options.timeoutMs);
    await this.record("heartbeat", { ...check, renewed: check.running });
    const done = !check.running || Date.now() - state.startedAt >= minutes * 60_000;
    if (done) return { done: true, delayMs: 1000 };
    return { state: { ...state, instance: this.instance }, delayMs: options.alarmMs };
  }

  /** Control: no alarm for longer than the timeout. The container should stop. */
  async phase_no_heartbeat(state, options) {
    if (!state.lastActivity) {
      const { incarnation } = await this.ensureComputer(options.timeoutMs, "nh");
      await this.setTimeoutMs(options.timeoutMs);
      const run = await this.ctx.storage.get("currentRun");
      const lastActivity = Date.now();
      await this.record("no-heartbeat-start", { incarnation, timeoutMs: options.timeoutMs, run });
      return {
        state: { lastActivity, incarnation, run, instance: this.instance },
        delayMs: options.waitMs,
      };
    }
    const check = await this.check(state);
    const marks = await this.server.marks(state.run);
    const sigterm = marks.sigterm?.[0]?.wt ?? null;
    await this.record("no-heartbeat-check", {
      ...check,
      sigtermAfterLastActivityMs: sigterm ? sigterm - state.lastActivity : null,
    });
    return { done: true, delayMs: 1000 };
  }

  /** Long alarm gaps, so the Durable Object leaves memory between alarms. */
  async phase_eviction(state, options, arg) {
    const cycles = arg ?? options.cycles;
    await this.ctx.storage.put("rearm", options.rearm);
    if (!state.startedAt) {
      await this.ctx.storage.put("rearm", true);
      const { incarnation } = await this.ensureComputer(options.timeoutMs, "ev");
      await this.ctx.storage.put("rearm", options.rearm);
      const run = await this.ctx.storage.get("currentRun");
      const startedAt = Date.now();
      await this.record("eviction-start", { incarnation, rearm: options.rearm, run });
      return {
        state: { startedAt, incarnation, run, instance: this.instance, cycle: 0 },
        delayMs: options.gapMs,
      };
    }
    const check = await this.check(state);
    const constructed = await this.ctx.storage.get("constructed");
    const marks = await this.server.marks(state.run);
    const sigterm = marks.sigterm?.[0]?.wt ?? null;
    if (check.running && options.rearm) await this.setTimeoutMs(options.timeoutMs);
    const cycle = state.cycle + 1;
    await this.record("eviction-check", {
      cycle,
      rearm: options.rearm,
      constructed,
      ...check,
      sigtermAt: sigterm,
    });
    if (!check.running || cycle >= cycles) {
      await this.ctx.storage.put("rearm", true);
      return { done: true, delayMs: 1000 };
    }
    return { state: { ...state, cycle, instance: this.instance }, delayMs: options.gapMs };
  }

  async phase_eviction_control(state, options, arg) {
    return this.phase_eviction(state, options, arg);
  }

  /** Heartbeat while waiting for a redeploy (a change of S1_VERSION), then keep watching. */
  async phase_redeploy(state, options) {
    if (!state.startedAt) {
      await this.ctx.storage.put("rearm", true);
      const { incarnation } = await this.ensureComputer(options.timeoutMs, "rd");
      const run = await this.ctx.storage.get("currentRun");
      const startedAt = Date.now();
      await this.record("redeploy-start", {
        incarnation,
        run,
        version: this.env.S1_VERSION,
        rearmEnv: this.env.S1_REARM ?? "1",
      });
      return {
        state: {
          startedAt,
          incarnation,
          run,
          instance: this.instance,
          version: this.env.S1_VERSION,
        },
        delayMs: options.alarmMs,
      };
    }
    const rearm = this.env.S1_REARM !== "0";
    const check = await this.check(state);
    if (check.running && rearm) await this.setTimeoutMs(options.timeoutMs);
    const redeployed = this.env.S1_VERSION !== state.version;
    let detectedAt = state.detectedAt;
    let reconnectMs = null;
    if (redeployed && !detectedAt) {
      detectedAt = Date.now();
      // Measure how long the host takes to come back online after the redeploy.
      const hostId = await this.ctx.storage.get("hostId");
      let status = check.hostStatus;
      while (status !== "online" && Date.now() - detectedAt < 120_000) {
        await sleep(500);
        status = await this.server.hostStatus(hostId);
      }
      reconnectMs = status === "online" ? Date.now() - detectedAt : null;
    }
    const marks = await this.server.marks(state.run);
    await this.record("redeploy-check", {
      ...check,
      renewed: check.running && rearm,
      rearmEnv: this.env.S1_REARM ?? "1",
      version: this.env.S1_VERSION,
      redeployed,
      reconnectAfterDetectionMs: reconnectMs,
      constructed: await this.ctx.storage.get("constructed"),
      sigtermAt: marks.sigterm?.[0]?.wt ?? null,
      wsUpgrades: (marks.ws ?? []).length,
    });
    const waitedTooLong = Date.now() - state.startedAt > options.maxWaitMinutes * 60_000;
    const watchedEnough = detectedAt && Date.now() - detectedAt >= options.postMinutes * 60_000;
    if (!check.running || waitedTooLong || watchedEnough) return { done: true, delayMs: 1000 };
    return {
      state: { ...state, detectedAt, instance: this.instance },
      delayMs: options.alarmMs,
    };
  }

  /** durable_object policy only: snapshot a running computer, then wake from the snapshot. */
  async phase_snapshot(state, options, arg) {
    const runs = arg ?? 10;
    if (!this.policyImage()) {
      await this.record("snapshot-skipped", { reason: "default scheduling policy" });
      return { done: true };
    }
    if (!state.snapshot) {
      await this.ensureComputer(600_000, "sn");
      const t0 = Date.now();
      const snapshot = await this.ctx.container.snapshotContainer({ name: `s1-${Date.now()}` });
      const snapshots = (await this.ctx.storage.get("snapshots")) ?? [];
      snapshots.push({ id: snapshot.id, size: snapshot.size, at: Date.now() });
      await this.ctx.storage.put("snapshots", snapshots);
      await this.record("snapshot-created", {
        snapshotId: snapshot.id,
        sizeBytes: snapshot.size,
        createMs: Date.now() - t0,
      });
      return { state: { snapshot: { id: snapshot.id }, i: 0 }, delayMs: 5000 };
    }
    const i = state.i ?? 0;
    if (i >= runs) {
      await this.stopComputer();
      return { done: true };
    }
    if (!state.stopped) {
      const stop = await this.stopComputer();
      await this.record("wake-stop", { index: i, label: "snapshot", ...stop });
      return { state: { ...state, stopped: true }, delayMs: options.gapMs ?? 20_000 };
    }
    const run = `s${(await this.ctx.storage.get("gen")) ?? 0}`;
    const result = await this.wake(run, 600_000, state.snapshot);
    await this.record("wake", {
      index: i,
      label: "snapshot",
      version: this.env.S1_VERSION,
      ...result,
    });
    return { state: { ...state, i: i + 1, stopped: false }, delayMs: 10_000 };
  }

  async phase_stop() {
    const stop = await this.stopComputer();
    await this.record("stop", stop);
    return { done: true };
  }

  async phase_shutdown() {
    const stop = await this.stopComputer();
    await this.server.stop();
    await this.record("shutdown", stop);
    return { done: true, delayMs: IDLE_ALARM_MS };
  }

  async phase_label(_state, _options, arg) {
    await this.ctx.storage.put("wakeLabel", `label-${arg}`);
    return { done: true };
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const computer = env.COMPUTER.get(env.COMPUTER.idFromName(COMPUTER_NAME));
    const json = (value) =>
      new Response(JSON.stringify(value, null, 2), {
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/s1/kickoff") return json(await computer.kickoff());
    if (url.pathname === "/s1/status") return json(await computer.status());
    if (url.pathname === "/s1/results") return json(await computer.results());
    return new Response("not found", { status: 404 });
  },
};
