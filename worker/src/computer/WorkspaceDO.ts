// WorkspaceDO (WP3.1): one per cloud computer, in the platform Worker. A thin Durable Object around
// `WorkspaceController`: its SQLite storage as the controller's store, its alarm as the heartbeat,
// the computer's container port, ControlDO and the checkpoint bucket. Every new instance re-arms
// the inactivity timeout and the intercepts and carries on from the persisted phase (FH-36).
//
// The RPC surface is `WorkspaceRpc` (`shared/rpc.ts`): `launcher` for `internal/platform-api.ts`,
// `computer` for `internal/computer-api.ts`, `pages` for the web Worker's pages, `reservation` for
// ControlDO, `writeAllowed` for the backup gateway's write fence, and `identity` for the
// computer's route (`internal/omnigent-route.ts`).
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
  type PagesCall,
  type PagesResult,
  type ReservationState,
  type SupervisorReply,
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
import type { Store } from "./record.ts";
import { WORKSPACE_MIGRATIONS } from "./schema.ts";

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

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    // One WorkspaceDO per computer, named by its computer ID (`workspaceObjectName`).
    const computerId = ComputerId.safeParse(ctx.id.name);
    if (!computerId.success) {
      this.#computerId = null;
      this.#controller = null;
      return;
    }
    this.#computerId = computerId.data;
    const store = new SqlStore(ctx.storage);
    this.#controller = new WorkspaceController({
      computerId: computerId.data,
      store,
      port: this.openPort(),
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

  protected timing(): ControllerTiming {
    return CONTROLLER_TIMING;
  }

  protected get controller(): WorkspaceController {
    if (this.#controller === null) {
      throw platformError("bad_request", "a WorkspaceDO is named by its computer ID");
    }
    return this.#controller;
  }

  launcher(call: LauncherCall): Promise<LauncherResult> {
    return this.controller.launcher(call);
  }

  computer(call: ComputerCall): Promise<SupervisorReply> {
    return this.controller.computer(call);
  }

  pages(call: PagesCall): Promise<PagesResult> {
    return this.controller.pages(call);
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

  override async alarm(): Promise<void> {
    if (this.#controller !== null) await this.#controller.alarm();
  }
}
