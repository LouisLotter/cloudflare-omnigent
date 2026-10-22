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
import { bootstrapSecretPresent, serverContainerEnv } from "./server-env.ts";
import {
  type Effect,
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

const WatchdogStateSchema = z.strictObject({
  phase: z.enum(["idle", "starting", "waiting"]),
  phaseSince: z.number().nullable(),
  startDueAt: z.number().nullable(),
  failedStarts: z.number().int().min(0),
  lastAnsweredAt: z.number().nullable(),
  startsSince: z.number().nullable(),
  outage: z
    .strictObject({
      outageId: z.string(),
      cause: z.enum(["container_stopped", "not_answering", "start_failed"]),
      startedAt: z.number(),
      detectedAt: z.number(),
      restarts: z.number().int().min(0),
    })
    .nullable(),
});

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
        await this.#registerIntercepts(container);
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
    return SERVER_TIMING;
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
    if (!this.#ready && !(await this.#waitUntilReady(container))) {
      return errorResponse(503, "unavailable", "Omnigent is starting. Try again shortly.", true, {
        "retry-after": "5",
      });
    }
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
      if (container.running && (await this.#healthy(container))) {
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
      const observation = await this.#observe(container);
      const result = step(this.#loadState(), observation, this.now(), timing, randomOutageId);
      this.#persist(result.state, result.effects);
      nextCheckAt = result.nextCheckAt;
      this.#ready = observation === "answering";
      if (container.running) await this.#keepRunning(container);
      await this.#apply(container, result.effects);
      if (observation === "answering") await this.#bootstrapCheck(container);
    } catch (error) {
      logEvent("watchdog", "check_error", { error: describeError(error) });
    } finally {
      await this.ctx.storage.setAlarm(nextCheckAt);
    }
  }

  async #observe(container: ServerContainer): Promise<Observation> {
    if (!container.running) return "stopped";
    if (await this.#healthy(container)) return "answering";
    await sleep(this.timing().probeRetryMs);
    if (!container.running) return "stopped";
    return (await this.#healthy(container)) ? "answering" : "silent";
  }

  /** Whether Omnigent answers its health check with a 2xx. Never throws. */
  async #healthy(container: ServerContainer): Promise<boolean> {
    try {
      const response = await this.#get(container, OMNIGENT_PORT, "/health");
      await response.body?.cancel();
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
    await this.#registerIntercepts(container);
    const { vars, skipped } = serverContainerEnv(this.env as unknown as Record<string, unknown>);
    for (const { name, reason } of skipped) logEvent("watchdog", "env_skipped", { name, reason });
    try {
      container.start(vars);
    } catch (error) {
      logEvent("watchdog", "start_error", { error: describeError(error) });
      return;
    }
    const startedAt = this.now();
    container.watch(({ error }) => {
      logEvent("watchdog", "container_exited", {
        afterMs: this.now() - startedAt,
        error: error === null ? null : describeError(error),
      });
    });
    await this.#keepRunning(container);
  }

  async #keepRunning(container: ServerContainer): Promise<void> {
    try {
      await container.setInactivityTimeout(this.timing().inactivityTimeoutMs);
    } catch (error) {
      logEvent("watchdog", "inactivity_timeout_error", { error: describeError(error) });
    }
  }

  async #registerIntercepts(container: ServerContainer): Promise<void> {
    const props: PlatformInternalProps = {
      propsVersion: PLATFORM_INTERNAL_PROPS_VERSION,
      caller: "omnigent-server",
    };
    try {
      await container.interceptOutboundHttp(
        PLATFORM_INTERNAL_HOST,
        this.ctx.exports.PlatformInternal({ props }),
      );
    } catch (error) {
      logEvent("watchdog", "intercept_error", { error: describeError(error) });
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

  #persist(state: WatchdogState, effects: readonly Effect[]): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
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
