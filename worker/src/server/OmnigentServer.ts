// OmnigentServer (WP2.2): the singleton Omnigent server's Durable Object, in the platform Worker.
//
//   - Always on. The watchdog alarm checks the server every minute (every few seconds while it
//     starts or is down), keeps its inactivity timeout armed, starts it whenever it is found
//     stopped, waits 120 s for readiness after each start, retries a refused start (DC-37), and
//     restarts a server that stopped answering. Its decisions are the pure `watchdog.ts`.
//   - Outage records. Every interval in which the server did not answer is stored as an
//     `OutageRecord`, from the last time it answered to the first time it answered again.
//   - Bootstrap status. While the server answers, the watchdog reads `/v1/info` and the
//     entrypoint's replication position over the container's ports and stores a
//     `BootstrapStatus`; while the bootstrap secret exists it logs that status as a structured
//     event on every check (G1BR-002, R-30). The decision is the pure `bootstrap.ts`.
//   - Native forwarding (R-24). `fetch` passes a request to port 8000 with
//     `getTcpPort(8000).fetch` over `http://`, once, and returns the answer; a WebSocket comes back
//     unaccepted under a bare 101 that carries at most the subprotocol.
//   - `platform.internal` is intercepted for this container only, before every start and in
//     every new instance, with versioned props.
//
// Persist before effect: each watchdog step's state and outage records are written in one
// transaction before the container is started or destroyed.

import { DurableObject } from "cloudflare:workers";
import {
  type BootstrapStatus,
  BootstrapStatus as BootstrapStatusSchema,
  OutageId,
  OutageRecord,
  outageOverlaps,
  REPLICATION_POSITION_PATH,
  REPLICATION_POSITION_PORT,
  Timestamp,
} from "@cfo/contracts";
import { z } from "zod";
import type { PlatformEnv } from "../env.ts";
import { platformError } from "../shared/errors.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  type OmnigentServerCall,
  type OmnigentServerRpc,
  type OutagesQuery,
} from "../shared/rpc.ts";
import { migrate } from "../shared/sql.ts";
import { type BootstrapTarget, BootstrapTargetSchema, checkBootstrap } from "./bootstrap.ts";
import {
  exitCodeOf,
  isNotListeningError,
  OMNIGENT_PORT,
  type ServerContainer,
  serverContainerOf,
} from "./container-port.ts";
import { bareUpgradeHeaders, isSafeMethod, isUpgrade, stripTrustHeaders } from "./headers.ts";
import {
  PLATFORM_INTERNAL_HOST,
  PLATFORM_INTERNAL_PROPS_VERSION,
  type PlatformInternalProps,
} from "./platform-internal.ts";
import { describeError, errorResponse, logEvent } from "./responses.ts";
import { SERVER_MIGRATIONS } from "./schema.ts";
import {
  bootstrapSecretPresent,
  configFingerprint,
  serverContainerEnv,
  serverDeadlines,
} from "./server-env.ts";
import {
  ANSWERING,
  type Effect,
  type EntrypointReport,
  INITIAL_WATCHDOG_STATE,
  type Observation,
  randomOutageId,
  step,
  WATCHDOG_TIMING,
  type WatchdogState,
  type WatchdogTiming,
} from "./watchdog.ts";

export interface ServerTiming extends WatchdogTiming {
  /** The container's inactivity timeout, renewed on every check (at most 6 hours). */
  readonly inactivityTimeoutMs: number;
  /** The first check after a new instance finds no alarm. */
  readonly firstCheckDelayMs: number;
  /** One health or status read. */
  readonly probeTimeoutMs: number;
  /** The pause before a failed health check is repeated. */
  readonly probeRetryMs: number;
  /** How long a forwarded request waits for a starting server before answering 503. */
  readonly requestWaitMs: number;
  readonly requestPollMs: number;
}

export const SERVER_TIMING: ServerTiming = {
  ...WATCHDOG_TIMING,
  inactivityTimeoutMs: 60 * 60_000,
  firstCheckDelayMs: 0,
  probeTimeoutMs: 5_000,
  probeRetryMs: 1_000,
  requestWaitMs: 30_000,
  requestPollMs: 500,
};

/** A time a `Date` can hold, in milliseconds since the epoch. */
const Millis = z.number().int().min(0).max(8.64e15);

// Fields added after the first version default, so state an older build stored still reads.
const WatchdogStateSchema = z.strictObject({
  phase: z.enum(["idle", "starting", "stopping", "waiting", "held"]),
  phaseSince: Millis.nullable(),
  startDueAt: Millis.nullable(),
  failedStarts: z.number().int().min(0).max(1_000_000),
  lastAnsweredAt: Millis.nullable(),
  startsSince: Millis.nullable(),
  heldConfig: z.string().max(64).nullable().default(null),
  outage: z
    .strictObject({
      outageId: OutageId,
      cause: z.enum(["container_stopped", "not_answering", "start_failed", "recovery_mode"]),
      startedAt: Millis,
      detectedAt: Millis,
      restarts: z.number().int().min(0).max(1_000_000),
      exitCode: z.number().int().min(0).max(255).nullable().default(null),
      recovery: z.string().max(200).nullable().default(null),
    })
    .nullable(),
});

/** The fields of the entrypoint's `GET :8001/status` the watchdog reads (WP2.3); others ignored. */
const EntrypointStatus = z.object({
  phase: z.enum(["starting", "restoring", "recovery", "running", "stopping", "stopped"]),
  recovery: z
    .object({ reason: z.string().max(200), transient: z.boolean() })
    .nullable()
    .optional(),
});

/** The entrypoint's status port (WP2.3): the same port as the replication position. */
const STATUS_PATH = "/status";
const SIGTERM = 15;

const STATE_KEY = "watchdog";
const BOOTSTRAP_STATUS_KEY = "bootstrap_status";
const BOOTSTRAP_TARGET_KEY = "bootstrap_target";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type VersionCheck = "ok" | "missing" | "unsupported";

function checkVersion(value: unknown): VersionCheck {
  if (value === undefined || value === null || value === "") return "missing";
  const version = typeof value === "string" && /^[0-9]{1,6}$/.test(value) ? Number(value) : value;
  if (typeof version !== "number" || !Number.isInteger(version)) return "missing";
  return version >= 1 && version <= OMNIGENT_SERVER_INTERFACE_VERSION ? "ok" : "unsupported";
}

export class OmnigentServer extends DurableObject<PlatformEnv> implements OmnigentServerRpc {
  readonly #container: ServerContainer | null;
  /** The last health check or forwarded request reached the server. In memory only. */
  #ready = false;
  /** When a health check or a forwarded request last reached the server. In memory only. */
  #answeredAt = 0;
  /** The watchdog is stopping the container: no request is passed on meanwhile. */
  #stopping = false;
  /** The running container's intercept registration failed and is retried at each check. */
  #interceptPending = false;
  /**
   * The exit code `monitor()` last reported, until a check consumes it. In memory: a pending
   * `monitor()` keeps this instance alive while the container runs, and the code is diagnostic.
   */
  #exitCode: number | null = null;
  #readyWait: Promise<boolean> | null = null;
  /** Serialises watchdog checks: one step at a time, whether the alarm or a request ran it. */
  #checks: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    this.#container = this.openContainer();
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, SERVER_MIGRATIONS);
      const container = this.#container;
      if (container?.running) {
        // A new instance (a deploy's version switch, a reset, an eviction) keeps the container:
        // renew its timeout and register the intercepts again, with this build's props.
        await this.#keepRunning(container);
        this.#interceptPending = !(await this.#registerIntercepts(container));
        this.#watch(container);
      }
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(this.now() + this.timing().firstCheckDelayMs);
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // Seams for the Workers-runtime tests, which run without containers and with a test clock.

  /** The container port, or null when this class has no container configured. */
  protected openContainer(): ServerContainer | null {
    return serverContainerOf(this.ctx);
  }

  protected now(): number {
    return Date.now();
  }

  protected timing(): ServerTiming {
    return { ...SERVER_TIMING, ...serverDeadlines(this.env as unknown as Record<string, unknown>) };
  }

  // -------------------------------------------------------------------------------------------
  // Forwarding

  override async fetch(request: Request): Promise<Response> {
    const version = checkVersion(request.headers.get(FORWARD_VERSION_HEADER));
    if (version !== "ok") {
      logEvent("server", "forward_refused", { reason: `version_${version}` });
      return version === "missing"
        ? errorResponse(400, "bad_request", "The call carries no interface version.", false)
        : errorResponse(
            400,
            "unsupported_version",
            "The call's interface version is newer.",
            false,
          );
    }
    const container = this.#container;
    if (container === null) {
      logEvent("server", "forward_refused", { reason: "no_container" });
      return errorResponse(503, "unavailable", "Omnigent is not available.", false);
    }
    const starting = () =>
      errorResponse(503, "unavailable", "Omnigent is starting. Try again shortly.", true, {
        "retry-after": "5",
      });
    const state = this.#loadState();
    if (this.#stopping || state.phase === "stopping") return starting();
    if (state.phase === "held") {
      // Exit 78: restarting cannot help until the installation's settings are fixed.
      return errorResponse(
        503,
        "unavailable",
        "Omnigent cannot start: a setting of this installation is missing or malformed.",
        false,
      );
    }
    // In recovery mode the server image answers every request itself, with its reason.
    const recovery = state.outage?.cause === "recovery_mode";
    if (!this.#ready && !recovery && !(await this.#waitUntilReady(container))) return starting();
    // The watchdog may have begun a restart while this request waited.
    if (this.#stopping || this.#loadState().phase === "stopping") return starting();
    return this.#forward(container, request);
  }

  async #forward(container: ServerContainer, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Removes the interface version with every other `x-cfo-` header, and any trust header that
    // reached this far: Omnigent sees none of them.
    stripTrustHeaders(headers);
    const outbound = new Request(`http://${url.host}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
    let response: Response;
    try {
      response = await container.fetch(OMNIGENT_PORT, outbound);
    } catch (error) {
      this.#ready = false;
      logEvent("server", "forward_error", {
        method: request.method,
        path: url.pathname,
        upgrade: isUpgrade(request),
        error: describeError(error),
      });
      // Retryable only when the request certainly never reached Omnigent, or changes nothing.
      return isNotListeningError(error) || isSafeMethod(request.method)
        ? errorResponse(503, "unavailable", "Omnigent is not answering. Try again shortly.", true, {
            "retry-after": "5",
          })
        : errorResponse(
            502,
            "unavailable",
            "The answer from Omnigent was lost. Check the current state before repeating the change.",
            false,
          );
    }
    this.#ready = true;
    this.#answeredAt = Date.now();
    const socket = response.webSocket;
    if (socket) {
      logEvent("server", "upgrade", { path: url.pathname });
      // Never accepted here: the container's socket goes back as it came, under a bare 101.
      return new Response(null, {
        status: 101,
        webSocket: socket,
        headers: bareUpgradeHeaders(response.headers),
      });
    }
    if (response.status >= 500) {
      logEvent("server", "forward_status", { path: url.pathname, status: response.status });
    }
    return response;
  }

  /** Waits for a starting server, once for all requests that arrive meanwhile. */
  #waitUntilReady(container: ServerContainer): Promise<boolean> {
    this.#readyWait ??= this.#pollReady(container).finally(() => {
      this.#readyWait = null;
    });
    return this.#readyWait;
  }

  async #pollReady(container: ServerContainer): Promise<boolean> {
    const timing = this.timing();
    const deadline = Date.now() + timing.requestWaitMs;
    // A stopped server is started now, if its next start is due (DC-37's backoff holds).
    if (!container.running) await this.#check();
    for (;;) {
      if (!this.#stopping && container.running && (await this.#healthy(container))) {
        this.#ready = true;
        // Let the watchdog record the end of an outage now rather than at its next poll.
        await this.ctx.storage.setAlarm(this.now());
        return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(timing.requestPollMs);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The watchdog

  override async alarm(): Promise<void> {
    await this.#check();
  }

  #check(): Promise<void> {
    const run = this.#checks.then(() => this.#checkNow());
    this.#checks = run.catch(() => undefined);
    return run;
  }

  async #checkNow(): Promise<void> {
    const timing = this.timing();
    let nextCheckAt = this.now() + timing.pollMs;
    try {
      const container = this.#container;
      if (container === null) {
        logEvent("watchdog", "no_container");
        nextCheckAt = this.now() + timing.intervalMs;
        return;
      }
      const observedFrom = Date.now();
      const observation = await this.#observe(container);
      const config = await configFingerprint(
        serverContainerEnv(this.env as unknown as Record<string, unknown>).vars,
      );
      let result = step(this.#loadState(), observation, this.now(), timing, randomOutageId, config);
      this.#persist(result.state, result.effects, observation.kind === "stopped");
      nextCheckAt = result.nextCheckAt;
      this.#ready = observation.kind === "answering";
      if (result.effects.some((effect) => effect.type === "stop")) {
        // A restart decided on silence. Admit nothing from here, then take a last look: if the
        // server answered meanwhile, a request or a health check saw it, so the restart is
        // called off and the answer recorded instead (Codex WP2.2 r1, finding 1). Requests
        // already passed on before this point can still be cut by the stop.
        this.#stopping = true;
        const lastLook = await this.#healthy(container);
        // Read after the last look settles: a request already passed on may have been answered
        // during it (Codex WP2.2 r2). No await between here and the stop.
        if (lastLook || this.#answeredAt >= observedFrom) {
          this.#stopping = false;
          await this.#apply(
            container,
            result.effects.filter((effect) => effect.type !== "stop"),
          );
          logEvent("watchdog", "restart_called_off");
          const resumed: WatchdogState = { ...result.state, phase: "idle", phaseSince: null };
          result = step(resumed, ANSWERING, this.now(), timing, randomOutageId, config);
          this.#persist(result.state, result.effects, false);
          nextCheckAt = result.nextCheckAt;
          this.#ready = true;
        }
      }
      try {
        await this.#apply(container, result.effects);
      } finally {
        this.#stopping = false;
      }
      if (container.running) {
        await this.#keepRunning(container);
        if (this.#interceptPending) {
          this.#interceptPending = !(await this.#registerIntercepts(container));
        }
      }
      if (this.#ready) await this.#bootstrapCheck(container);
    } catch (error) {
      logEvent("watchdog", "check_error", { error: describeError(error) });
    } finally {
      await this.ctx.storage.setAlarm(nextCheckAt);
    }
  }

  async #observe(container: ServerContainer): Promise<Observation> {
    const stopped = (): Observation => ({ kind: "stopped", exitCode: this.#lastExit() });
    if (!container.running) return stopped();
    if (await this.#healthy(container)) return ANSWERING;
    await sleep(this.timing().probeRetryMs);
    if (!container.running) return stopped();
    if (await this.#healthy(container)) return ANSWERING;
    return { kind: "silent", entrypoint: await this.#entrypoint(container) };
  }

  /** What the entrypoint says about itself on its status port, or null when it cannot say. */
  async #entrypoint(container: ServerContainer): Promise<EntrypointReport | null> {
    const parsed = EntrypointStatus.safeParse(
      await this.#read(container, REPLICATION_POSITION_PORT, STATUS_PATH),
    );
    if (!parsed.success) return null;
    return { phase: parsed.data.phase, recovery: parsed.data.recovery ?? null };
  }

  /** The exit code `monitor()` last reported and no check has consumed yet. */
  #lastExit(): number | null {
    return this.#exitCode;
  }

  /** Whether Omnigent answers its health check with a 2xx. Never throws. */
  async #healthy(container: ServerContainer): Promise<boolean> {
    try {
      const response = await this.#get(container, OMNIGENT_PORT, "/health");
      await response.body?.cancel();
      if (response.ok) this.#answeredAt = Date.now();
      return response.ok;
    } catch {
      return false;
    }
  }

  /** The JSON body of a 2xx answer to a GET on a container port, else null. Never throws. */
  async #read(container: ServerContainer, port: number, path: string): Promise<unknown> {
    try {
      const response = await this.#get(container, port, path);
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }

  #get(container: ServerContainer, port: number, path: string): Promise<Response> {
    const signal = AbortSignal.timeout(this.timing().probeTimeoutMs);
    return container.fetch(port, new Request(`http://omnigent${path}`, { signal }));
  }

  async #apply(container: ServerContainer, effects: readonly Effect[]): Promise<void> {
    for (const effect of effects) {
      switch (effect.type) {
        case "event":
          logEvent("watchdog", effect.name, effect.fields);
          break;
        case "outage":
          break; // persisted with the state
        case "stop":
          try {
            container.signal(SIGTERM);
          } catch (error) {
            logEvent("watchdog", "stop_error", { error: describeError(error) });
          }
          break;
        case "destroy":
          try {
            await container.destroy(effect.reason);
          } catch (error) {
            logEvent("watchdog", "destroy_error", { error: describeError(error) });
          }
          break;
        case "start":
          await this.#start(container);
          break;
      }
    }
  }

  async #start(container: ServerContainer): Promise<void> {
    if (container.running) return;
    // The server needs platform.internal from its first moment: no start without it. The
    // watchdog finds the server still stopped and tries again after its backoff.
    if (!(await this.#registerIntercepts(container))) return;
    this.#interceptPending = false;
    const { vars, skipped } = serverContainerEnv(this.env as unknown as Record<string, unknown>);
    for (const { name, reason } of skipped) logEvent("watchdog", "env_skipped", { name, reason });
    // An exit left from an earlier container is not this one's.
    this.#exitCode = null;
    try {
      container.start(vars);
    } catch (error) {
      logEvent("watchdog", "start_error", { error: describeError(error) });
      return;
    }
    this.#watch(container);
    await this.#keepRunning(container);
  }

  /** Records how the running container ends, for the check that finds it stopped. */
  #watch(container: ServerContainer): void {
    const since = this.now();
    try {
      container.watch((exit) => {
        const exitCode = exitCodeOf(exit);
        logEvent("watchdog", "container_exited", {
          afterMs: this.now() - since,
          exitCode,
          error: exit.error === null ? null : describeError(exit.error),
        });
        // Kept until a check consumes it, so the outage record can carry it.
        this.#exitCode = exitCode;
      });
    } catch (error) {
      logEvent("watchdog", "watch_error", { error: describeError(error) });
    }
  }

  async #keepRunning(container: ServerContainer): Promise<void> {
    try {
      await container.setInactivityTimeout(this.timing().inactivityTimeoutMs);
    } catch (error) {
      logEvent("watchdog", "inactivity_timeout_error", { error: describeError(error) });
    }
  }

  /** Registers `platform.internal` for this container. False when the call failed. */
  async #registerIntercepts(container: ServerContainer): Promise<boolean> {
    const props: PlatformInternalProps = {
      propsVersion: PLATFORM_INTERNAL_PROPS_VERSION,
      caller: "omnigent-server",
    };
    try {
      await container.interceptOutboundHttp(
        PLATFORM_INTERNAL_HOST,
        this.ctx.exports.PlatformInternal({ props }),
      );
      return true;
    } catch (error) {
      logEvent("watchdog", "intercept_error", { error: describeError(error) });
      return false;
    }
  }

  #loadState(): WatchdogState {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM server_state WHERE key = ?", STATE_KEY)
      .toArray()[0];
    if (row === undefined) return INITIAL_WATCHDOG_STATE;
    const parsed = WatchdogStateSchema.safeParse(parseJson(row.value));
    if (parsed.success) return parsed.data;
    // Start over rather than stop watching: the next check starts or adopts the server.
    logEvent("watchdog", "state_unreadable");
    return INITIAL_WATCHDOG_STATE;
  }

  #persist(state: WatchdogState, effects: readonly Effect[], consumedExit: boolean): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      if (consumedExit) this.#exitCode = null;
      sql.exec(
        "INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)",
        STATE_KEY,
        JSON.stringify(state),
      );
      for (const effect of effects) {
        if (effect.type !== "outage") continue;
        const record = OutageRecord.parse(effect.record);
        sql.exec(
          "INSERT OR REPLACE INTO outages (outage_id, record, started_ms, ended_ms) VALUES (?, ?, ?, ?)",
          record.outageId,
          JSON.stringify(record),
          Date.parse(record.startedAt),
          record.endedAt === null ? null : Date.parse(record.endedAt),
        );
      }
    });
  }

  // -------------------------------------------------------------------------------------------
  // The bootstrap check

  async #bootstrapCheck(container: ServerContainer): Promise<void> {
    const secretPresent = bootstrapSecretPresent(this.env as unknown as Record<string, unknown>);
    const stored = this.#loadBootstrap();
    if (!secretPresent && stored.status?.initialized === true) return;
    // In this order: the position, /v1/info, the position again (see bootstrap.ts).
    const before = await this.#read(
      container,
      REPLICATION_POSITION_PORT,
      REPLICATION_POSITION_PATH,
    );
    const info = await this.#read(container, OMNIGENT_PORT, "/v1/info");
    const after = await this.#read(container, REPLICATION_POSITION_PORT, REPLICATION_POSITION_PATH);
    const check = checkBootstrap(
      this.env.CFO_INSTALLATION_ID,
      stored.target,
      { before, info, after },
      this.now(),
    );
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (check.status !== null) {
        sql.exec(
          "INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)",
          BOOTSTRAP_STATUS_KEY,
          JSON.stringify(check.status),
        );
      }
      if (check.target === null)
        sql.exec("DELETE FROM server_state WHERE key = ?", BOOTSTRAP_TARGET_KEY);
      else {
        sql.exec(
          "INSERT OR REPLACE INTO server_state (key, value) VALUES (?, ?)",
          BOOTSTRAP_TARGET_KEY,
          JSON.stringify(check.target),
        );
      }
    });
    if (secretPresent) {
      // The bootstrap script (WP2.4) deletes the secret only after an event with
      // `initialized: true` for its own installation. Logged on every check, so a lost line recurs.
      logEvent("bootstrap", "status", {
        reason: check.reason,
        bootstrapStatus: check.status,
        secretPresent,
      });
    }
  }

  #loadBootstrap(): { status: BootstrapStatus | null; target: BootstrapTarget | null } {
    const rows = this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM server_state WHERE key IN (?, ?)",
        BOOTSTRAP_STATUS_KEY,
        BOOTSTRAP_TARGET_KEY,
      )
      .toArray();
    const value = (key: string) => {
      const row = rows.find((r) => r.key === key);
      return row === undefined ? undefined : parseJson(row.value);
    };
    const status = BootstrapStatusSchema.safeParse(value(BOOTSTRAP_STATUS_KEY));
    const target = BootstrapTargetSchema.safeParse(value(BOOTSTRAP_TARGET_KEY));
    return {
      status: status.success ? status.data : null,
      target: target.success ? target.data : null,
    };
  }

  // -------------------------------------------------------------------------------------------
  // RPC (shared/rpc.ts)

  #checkCall(call: OmnigentServerCall): void {
    if (checkVersion(call?.interfaceVersion) !== "ok") {
      throw platformError("unsupported_version", "unsupported OmnigentServer interface version");
    }
  }

  async outages(query: OutagesQuery): Promise<OutageRecord[]> {
    this.#checkCall(query);
    const from = Timestamp.safeParse(query.from);
    const to = Timestamp.safeParse(query.to);
    if (!from.success || !to.success) throw platformError("bad_request", "invalid outage range");
    const rows = this.ctx.storage.sql
      .exec<{ record: string }>(
        `SELECT record FROM outages
         WHERE started_ms < ? AND (ended_ms IS NULL OR ended_ms > ?)
         ORDER BY started_ms, outage_id`,
        Date.parse(to.data),
        Date.parse(from.data),
      )
      .toArray();
    const records: OutageRecord[] = [];
    for (const row of rows) {
      const parsed = OutageRecord.safeParse(parseJson(row.record));
      if (parsed.success && outageOverlaps(parsed.data, from.data, to.data))
        records.push(parsed.data);
    }
    return records;
  }

  async bootstrapStatus(call: OmnigentServerCall): Promise<BootstrapStatus | null> {
    this.#checkCall(call);
    return this.#loadBootstrap().status;
  }
}
