// WorkspaceDO (WP3.1): one per cloud computer, in the platform Worker. A thin Durable Object around
// `WorkspaceController`: its SQLite storage as the controller's store, its alarm as the heartbeat,
// the computer's container port, ControlDO and the checkpoint bucket. Every new instance re-arms
// the inactivity timeout and the intercepts and carries on from the persisted phase (FH-36).
//
// The RPC surface is `WorkspaceRpc` (`shared/rpc.ts`): `launcher` for `internal/platform-api.ts`,
// `computer` for `internal/computer-api.ts`, `pages` for the web Worker's pages, `reservation` for
// ControlDO, `writeAllowed` for the backup gateway's write fence, and `identity` for the
// computer's route (`internal/omnigent-route.ts`). The pages reach the controller through the page
// front (`computer/page-front.ts`, WP3.5: intent tokens, the setup terminal, removal), and `fetch`
// takes the setup terminal's upgrade, which the terminal bridge (`computer/terminal.ts`) dials on
// the same container port as everything else.
//
// The production wiring (WP3.18, the M3 assembly):
//   - `openPort()`: the computer's container through WP3.3's adapter (`computer/container-port.ts`),
//     with the Sandbox SDK's `DirectoryBackup` for layer uploads and restores. An upload's gateway
//     carries the write fence for its capture's generation (`egress/backups.ts`); a restore's or a
//     delete's carries none, so nothing can be written through it.
//   - `intercepts(props)`: `omnigent.internal` and `computer.internal`, each bound to this
//     generation's props (`computer/network.ts`). The backup host is never among them: each
//     `DirectoryBackup` operation registers it with its own fenced grant.
//   - `checkpointBucket()`: credential bundles read, listed and deleted on the `CHECKPOINTS` R2
//     binding; every put goes through the fenced gateway (`credentialWriter`), so the write fence
//     admits it only as a pending upload of the running generation.
// Without a container (a class with none configured) or a `CHECKPOINTS` binding, the hooks return
// null and WorkspaceDO answers only what needs neither.

import { DurableObject } from "cloudflare:workers";
import {
  type ComputerCall,
  ComputerId,
  type InterceptProps,
  type LauncherCall,
  type LauncherResult,
  type PageFrontCall,
  type PageFrontResult,
  type PageReadCall,
  type PageReadResult,
  type PagesCall,
  type PagesResult,
  type ReservationState,
  type SupervisorReply,
  TERMINAL_PORT,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_WS_PATH,
} from "@cfo/contracts";
import { credentialWriter, directoryBackups, type GatewayExports } from "../egress/backups.ts";
import type { PlatformEnv } from "../env.ts";
import { logEvent } from "../server/responses.ts";
import type { ComputerContainerPort } from "../shared/computer-port.ts";
import { platformError } from "../shared/errors.ts";
import {
  CONTROL_OBJECT_NAME,
  type ControlRpc,
  type WorkspaceIdentity,
  type WorkspaceRpc,
  type WriteCheck,
  type WriteDecision,
} from "../shared/rpc.ts";
import { migrate } from "../shared/sql.ts";
import { r2Bucket } from "./bucket.ts";
import { computerContainerOf, nativeComputerContainer } from "./container-port.ts";
import {
  type CheckpointBucket,
  CONTROLLER_TIMING,
  type ControllerTiming,
  type InterceptTarget,
  WorkspaceController,
} from "./controller.ts";
import { randomId } from "./ids.ts";
import { type InterceptExports, interceptTargets } from "./network.ts";
import { PageFront } from "./page-front.ts";
import type { Store } from "./record.ts";
import { WORKSPACE_MIGRATIONS } from "./schema.ts";
import { isStagingInstallation } from "./staging.ts";
import { type BridgeSocket, TerminalBridge, type TerminalTiming } from "./terminal.ts";

/** The controller's store on the Durable Object's SQLite storage: one JSON value per key. */
export class SqlStore implements Store {
  readonly #storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
  }

  get(key: string): unknown {
    const rows = this.#storage.sql
      .exec<{ value: string }>("SELECT value FROM workspace_kv WHERE key = ?", key)
      .toArray();
    const row = rows[0];
    return row === undefined ? undefined : (JSON.parse(row.value) as unknown);
  }

  put(key: string, value: unknown): void {
    this.#storage.sql.exec(
      `INSERT INTO workspace_kv (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      JSON.stringify(value),
    );
  }

  delete(key: string): void {
    this.#storage.sql.exec("DELETE FROM workspace_kv WHERE key = ?", key);
  }

  keys(prefix: string, limit = -1): readonly string[] {
    return this.#storage.sql
      .exec<{ key: string }>(
        "SELECT key FROM workspace_kv WHERE key >= ? AND key < ? ORDER BY key LIMIT ?",
        prefix,
        `${prefix}￿`,
        limit,
      )
      .toArray()
      .map((row) => row.key);
  }

  transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(fn);
  }
}

export class WorkspaceDO extends DurableObject<PlatformEnv> implements WorkspaceRpc {
  readonly #controller: WorkspaceController | null;
  /** This object's computer, from its name; null for an object not named by a computer ID. */
  readonly #computerId: ComputerId | null;
  readonly #front: PageFront | null;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    // One WorkspaceDO per computer, named by its computer ID (`workspaceObjectName`).
    const computerId = ComputerId.safeParse(ctx.id.name);
    if (!computerId.success) {
      this.#computerId = null;
      this.#controller = null;
      this.#front = null;
      return;
    }
    this.#computerId = computerId.data;
    const store = new SqlStore(ctx.storage);
    const port = this.openPort();
    // The terminal bridge is built after the controller (it calls the controller); the controller
    // reaches it through this reference, to end every stream before a credential-sensitive step.
    let bridge: TerminalBridge | null = null;
    this.#controller = new WorkspaceController({
      computerId: computerId.data,
      store,
      port,
      control: this.controlRpc(),
      bucket: this.checkpointBucket(),
      clock: () => this.now(),
      alarm: {
        set: (at) => ctx.storage.setAlarm(at),
        clear: () => ctx.storage.deleteAlarm(),
      },
      newId: randomId,
      deadline: (ms) => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new DOMException("deadline passed", "TimeoutError")),
          ms,
        );
        return { signal: controller.signal, clear: () => clearTimeout(timer) };
      },
      intercepts: (props) => this.intercepts(props),
      timing: this.timing(),
      log: (event, fields) => logEvent("workspace", event, fields),
      terminal: {
        closeNow: (reason) => bridge?.closeNow(reason),
        pendingEnd: () => bridge?.pendingEnd() ?? null,
        endSettled: (op) => bridge?.endSettled(op),
      },
      stagingChecks: this.stagingChecks(),
    });
    const controller = this.#controller;
    let front: PageFront | null = null;
    const terminal = new TerminalBridge({
      computerId: computerId.data,
      store,
      now: () => this.now(),
      timing: this.terminalTiming(),
      target: () => {
        if (front === null) throw platformError("internal", "no page front");
        return front.target();
      },
      dial: (mode, window) => {
        if (port === null) throw platformError("unavailable", "no container");
        // ttyd's URL arguments (WP3.28): built here only, never from the browser's request.
        const args = new URLSearchParams([
          ["arg", mode],
          ["arg", String(window)],
        ]);
        return port.fetch(
          TERMINAL_PORT,
          new Request(`http://computer${TERMINAL_WS_PATH}?${args}`, {
            headers: { upgrade: "websocket", "sec-websocket-protocol": TERMINAL_SUBPROTOCOL },
          }),
        );
      },
      setWindow: (until) =>
        until === null ? controller.setTerminal(false) : controller.setTerminal(true, until),
      pair: () => {
        const pair = new WebSocketPair();
        return [pair[0] as BridgeSocket, pair[1] as BridgeSocket];
      },
      upgradeResponse: (client) =>
        new Response(null, {
          status: 101,
          webSocket: client as unknown as WebSocket,
          headers: { "sec-websocket-protocol": TERMINAL_SUBPROTOCOL },
        }),
      socketOf: (response) => (response.webSocket as BridgeSocket | null) ?? null,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      // The instance's ID on every terminal line (WP3.27's `instance_started`), for FH-38.
      log: (event, fields) =>
        logEvent("workspace", event, { ...fields, instanceId: controller.instanceId }),
      // A shell's end is owed to the supervisor (WP3.28): the runner sends it at once, not at its
      // next heartbeat. Deferred, since the bridge may record one inside a controller transition.
      endRecorded: () => queueMicrotask(() => controller.terminalEndOwed()),
    });
    bridge = terminal;
    front = new PageFront(computerId.data, {
      store,
      controller,
      terminal,
      log: (event, fields) => logEvent("workspace", event, fields),
    });
    this.#front = front;
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, WORKSPACE_MIGRATIONS);
      await controller.boot();
    });
  }

  // -------------------------------------------------------------------------------------------
  // The production wiring. The Workers-runtime tests replace only `runtimeContainer()` (a
  // simulated container), the clock and the timing; everything else here runs as deployed.

  /** The runtime's container of this object, or null when its class has none configured. */
  protected runtimeContainer(): Container | null {
    return computerContainerOf(this.ctx);
  }

  /** `ctx.exports`: the platform Worker's own entrypoints, as loopback bindings. */
  #exports(): GatewayExports & InterceptExports {
    return this.ctx.exports as unknown as GatewayExports & InterceptExports;
  }

  /**
   * The computer's container port (WP3.3's adapter), with `DirectoryBackup` behind the fenced
   * gateway: an upload names its capture's generation, a restore or a delete none.
   */
  protected openPort(): ComputerContainerPort | null {
    const container = this.runtimeContainer();
    const computerId = this.#computerId;
    if (container === null || computerId === null) return null;
    const exports = this.#exports();
    return nativeComputerContainer(container, {
      backups: (prefix, generation) =>
        directoryBackups(
          container,
          exports,
          generation === null ? null : { computerId, generation },
        )(prefix),
    });
  }

  protected controlRpc(): ControlRpc {
    return this.env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as ControlRpc;
  }

  /** Credential bundles: reads, lists and deletes on R2; puts through the write fence. */
  protected checkpointBucket(): CheckpointBucket | null {
    const bucket = (this.env as { readonly CHECKPOINTS?: R2Bucket }).CHECKPOINTS;
    const computerId = this.#computerId;
    if (bucket === undefined || computerId === null) return null;
    const exports = this.#exports();
    return r2Bucket(bucket, (key, body, generation) =>
      credentialWriter(exports, { computerId, generation }).put(key, body),
    );
  }

  /** The intercepts registered before every start and in every new instance (WP3.3). */
  protected intercepts(props: InterceptProps): readonly InterceptTarget[] {
    return interceptTargets(this.#exports(), props);
  }

  protected now(): number {
    return Date.now();
  }

  /**
   * A staging installation (WP3.23): the setup page's RC-53 switch is offered and applied. Only
   * the staging tool's variable makes it so: the bootstrap sets `CFO_STAGING_INSTALLATION` to the
   * platform Worker's own name for a staging target only, and production names never carry the
   * staging prefix (the bootstrap refuses them).
   */
  protected stagingChecks(): boolean {
    return isStagingInstallation(this.env.CFO_STAGING_INSTALLATION);
  }

  protected timing(): ControllerTiming {
    return CONTROLLER_TIMING;
  }

  /** The setup terminal's timing (WP3.5); the production values unless a test overrides them. */
  protected terminalTiming(): Partial<TerminalTiming> {
    return {};
  }

  protected get controller(): WorkspaceController {
    if (this.#controller === null) {
      throw platformError("bad_request", "a WorkspaceDO is named by its computer ID");
    }
    return this.#controller;
  }

  protected get front(): PageFront {
    if (this.#front === null) {
      throw platformError("bad_request", "a WorkspaceDO is named by its computer ID");
    }
    return this.#front;
  }

  async launcher(call: LauncherCall): Promise<LauncherResult> {
    // `terminate` closes the setup terminal first; a sleep finds an expired window closed.
    await this.front.beforeLauncher(call);
    return this.controller.launcher(call);
  }

  computer(call: ComputerCall): Promise<SupervisorReply> {
    return this.controller.computer(call);
  }

  /** The pages, through the page front (WP3.5): intent tokens, the terminal, removal; and (WP3.23)
   * sign-in from the page and the computer's status. */
  pages(
    call: PagesCall | PageFrontCall | PageReadCall,
  ): Promise<PagesResult | PageFrontResult | PageReadResult> {
    return this.front.pages(call);
  }

  /** The setup terminal's upgrade from the web Worker (WP3.5). */
  override async fetch(request: Request): Promise<Response> {
    if (this.#front === null) return new Response(null, { status: 404 });
    return this.#front.fetch(request);
  }

  reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null> {
    return this.controller.reservation(call);
  }

  writeAllowed(call: WriteCheck): Promise<WriteDecision> {
    return this.controller.writeAllowed(call);
  }

  identity(call: { readonly interfaceVersion: number }): Promise<WorkspaceIdentity | null> {
    return this.controller.identity(call);
  }

  /**
   * Staging only (WP3.33): the container killed at once, as a crash would (the controller's
   * `stagingKill`). Called only by the staging harness's soak module (`run.sh computer-kill`), so
   * it is not part of `WorkspaceRpc`. Refused on production, from the staging tool's variable as
   * the RC-53 and keep-awake switches are (`stagingChecks`), before anything happens.
   */
  stagingKill(call: {
    readonly interfaceVersion: number;
  }): ReturnType<WorkspaceController["stagingKill"]> {
    return this.controller.stagingKill(call);
  }

  override async alarm(): Promise<void> {
    if (this.#front !== null) await this.#front.beforeAlarm();
    if (this.#controller !== null) await this.#controller.alarm();
  }
}
