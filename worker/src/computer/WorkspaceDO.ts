// WorkspaceDO (WP3.1): one per cloud computer, in the platform Worker. A thin Durable Object around
// `WorkspaceController`: its SQLite storage as the controller's store, its alarm as the heartbeat,
// the computer's container port, ControlDO and the checkpoint bucket. Every new instance re-arms
// the inactivity timeout and the intercepts and carries on from the persisted phase (FH-36).
//
// The RPC surface is `WorkspaceRpc` (`shared/rpc.ts`): `launcher` for `internal/platform-api.ts`,
// `computer` for `internal/computer-api.ts`, `pages` for the web Worker's pages, `reservation` for
// ControlDO. WP3.3 supplies the container port (`computer/container-port.ts`) and the intercept
// targets (`computer/network.ts`) through `openPort` and `intercepts`; until then a deployed
// WorkspaceDO has no container and answers only what needs none.

import { DurableObject } from "cloudflare:workers";
import {
  type ComputerCall,
  ComputerId,
  type InterceptProps,
  type LauncherCall,
  type LauncherResult,
  type PageFrontCall,
  type PageFrontResult,
  type PagesCall,
  type PagesResult,
  type ReservationState,
  type SupervisorReply,
  TERMINAL_PORT,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_WS_PATH,
} from "@cfo/contracts";
import type { PlatformEnv } from "../env.ts";
import { logEvent } from "../server/responses.ts";
import type { ComputerContainerPort } from "../shared/computer-port.ts";
import { platformError } from "../shared/errors.ts";
import {
  CONTROL_OBJECT_NAME,
  type ControlRpc,
  type WorkspaceRpc,
  type WriteCheck,
  type WriteDecision,
} from "../shared/rpc.ts";
import { migrate } from "../shared/sql.ts";
import { r2Bucket } from "./bucket.ts";
import {
  type CheckpointBucket,
  CONTROLLER_TIMING,
  type ControllerTiming,
  type InterceptTarget,
  WorkspaceController,
} from "./controller.ts";
import { randomId } from "./ids.ts";
import { PageFront } from "./page-front.ts";
import type { Store } from "./record.ts";
import { WORKSPACE_MIGRATIONS } from "./schema.ts";
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
  readonly #front: PageFront | null;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    // One WorkspaceDO per computer, named by its computer ID (`workspaceObjectName`).
    const computerId = ComputerId.safeParse(ctx.id.name);
    if (!computerId.success) {
      this.#controller = null;
      this.#front = null;
      return;
    }
    const store = new SqlStore(ctx.storage);
    const port = this.openPort();
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
      dial: () => {
        if (port === null) throw platformError("unavailable", "no container");
        return port.fetch(
          TERMINAL_PORT,
          new Request(`http://computer${TERMINAL_WS_PATH}`, {
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
      log: (event, fields) => logEvent("workspace", event, fields),
    });
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

  /** The computer's container port: WP3.3's adapter; none until it is wired. */
  protected openPort(): ComputerContainerPort | null {
    return null;
  }

  protected controlRpc(): ControlRpc {
    return this.env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as ControlRpc;
  }

  protected checkpointBucket(): CheckpointBucket | null {
    const bucket = (this.env as { readonly CHECKPOINTS?: R2Bucket }).CHECKPOINTS;
    return bucket === undefined ? null : r2Bucket(bucket);
  }

  /** The intercepts registered before every start and in every new instance (WP3.3). */
  protected intercepts(_props: InterceptProps): readonly InterceptTarget[] {
    return [];
  }

  protected now(): number {
    return Date.now();
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

  /** The pages, through the page front (WP3.5): intent tokens, the terminal, removal. */
  pages(call: PagesCall | PageFrontCall): Promise<PagesResult | PageFrontResult> {
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

  override async alarm(): Promise<void> {
    if (this.#front !== null) await this.#front.beforeAlarm();
    if (this.#controller !== null) await this.#controller.alarm();
  }
}
