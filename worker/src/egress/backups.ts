// The Sandbox SDK's backup gateway (`@cloudflare/sandbox` 1.0.0), fenced, and the factories the
// computer's code uses to reach the checkpoint bucket through it.
//
// `DirectoryBackupGateway`, exported from the platform Worker's main module under the name the SDK
// expects, is the SDK's gateway with the write fence (`write-fence.ts`) in front of every R2 write:
//   - a part upload from the container (`fetch` with a write grant);
//   - `createUpload` and `completeUpload`, the Durable Object's control calls; `completeUpload` is
//     the one that makes a layer's object exist;
//   - `putCredential`, a credential bundle's single put.
// Each asks the computer's WorkspaceDO (`writeAllowed`) just before the put, and refuses when
// WorkspaceDO refuses (WP3.1's policy: fully removed, another generation, a credential key that is
// not a pending upload), when the key is not the computer's own, or when WorkspaceDO does not
// answer. Reads (restores) and deletes are not fenced.
//
// This is admission control, not a drain (`write-fence.ts`): a write admitted just before
// WorkspaceDO moves on can still land afterwards, and WP3.1's re-deletes and sweeps, and its
// reading only named objects, deal with it. The gateway waits at most GATEWAY_PUT_TIMEOUT_MS for
// each R2 call; that bounds its waiting, not when the write may land.
//
// `DirectoryBackup` registers this gateway as the container's `backups.sandbox.internal`
// intercept itself, with props that grant one operation on one object under the computer's own
// prefix and deny everything once it ends: a computer can never name another computer's objects
// (RC-25). No platform code registers that host.

import { DirectoryBackup, DirectoryBackupGateway as SdkGateway } from "@cloudflare/sandbox";
import type { DirectoryBackups, DirectoryBackupsFor } from "../computer/container-port.ts";
import {
  type BackupFence,
  checkWrite,
  FENCE_CHECK_TIMEOUT_MS,
  type FenceVerdict,
  GATEWAY_PUT_TIMEOUT_MS,
  type WriteCheck,
  type WriteDecision,
  withTimeout,
} from "./write-fence.ts";

/** The R2 binding of the computers' checkpoint bucket (code-structure plan, Wrangler). */
export const CHECKPOINTS_BINDING = "CHECKPOINTS";

/** The bindings the gateway uses: WorkspaceDO, for the fence. */
interface FenceEnv {
  readonly WORKSPACE?: {
    getByName(name: string): { writeAllowed(check: WriteCheck): Promise<WriteDecision> };
  };
}

/** The gateway's props: the SDK's, plus the fence the platform's factories add. */
interface FencedProps {
  readonly protocolVersion?: unknown;
  readonly mode?: unknown;
  readonly binding?: unknown;
  readonly key?: unknown;
  readonly fence?: unknown;
}

function log(event: string, fields: Readonly<Record<string, unknown>>): void {
  console.log(JSON.stringify({ cfo: "backup_gateway", event, ...fields }));
}

/** The SDK's gateway with the write fence (exported as `DirectoryBackupGateway`). */
export class FencedBackupGateway extends SdkGateway {
  /** Asks WorkspaceDO whether this write may proceed. Never throws. */
  async #verdict(): Promise<FenceVerdict> {
    const props = (this.ctx.props ?? {}) as FencedProps;
    const key = typeof props.key === "string" ? props.key : "";
    const workspace = (this.env as FenceEnv).WORKSPACE;
    return checkWrite(props.fence, key, async (check) => {
      if (!workspace) throw new Error("no WORKSPACE binding");
      return withTimeout(
        workspace.getByName(check.computerId).writeAllowed(check),
        FENCE_CHECK_TIMEOUT_MS,
        "the write fence",
      );
    });
  }

  async #require(operation: string): Promise<void> {
    const verdict = await this.#verdict();
    if (!verdict.allowed) {
      log("write_refused", { operation, reason: verdict.reason });
      throw new Error(`[forbidden] the write fence refused this ${operation}: ${verdict.reason}`);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const props = (this.ctx.props ?? {}) as FencedProps;
    if (props.mode === "write") {
      const verdict = await this.#verdict();
      if (!verdict.allowed) {
        log("write_refused", { operation: "part", reason: verdict.reason });
        await request.body?.cancel().catch(() => undefined);
        return new Response(`the write fence refused this part: ${verdict.reason}`, {
          status: 403,
        });
      }
      return withTimeout(super.fetch(request), GATEWAY_PUT_TIMEOUT_MS, "a part upload").catch(
        (error: unknown) =>
          new Response(error instanceof Error ? error.message.slice(0, 200) : "part failed", {
            status: 504,
          }),
      );
    }
    return super.fetch(request);
  }

  override async createUpload(name?: string): Promise<string> {
    await this.#require("upload");
    return withTimeout(super.createUpload(name), GATEWAY_PUT_TIMEOUT_MS, "createUpload");
  }

  override async completeUpload(
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<number> {
    await this.#require("publication");
    return withTimeout(
      super.completeUpload(uploadId, parts),
      GATEWAY_PUT_TIMEOUT_MS,
      "completeUpload",
    );
  }

  /**
   * A credential bundle's put, at the control props' key, through the same fence (kind
   * `credential`). Only the Durable Object holds control props.
   */
  async putCredential(body: Uint8Array): Promise<void> {
    const props = (this.ctx.props ?? {}) as FencedProps;
    if (props.protocolVersion !== 1 || props.mode !== "control" || typeof props.key !== "string") {
      throw new Error("[forbidden] putCredential needs control props");
    }
    if (typeof props.binding !== "string") throw new Error("[forbidden] no bucket binding");
    await this.#require("credential");
    const bucket = (this.env as Record<string, R2Bucket | undefined>)[props.binding];
    if (!bucket) throw new Error(`env.${props.binding} is not an R2 bucket binding`);
    await withTimeout(
      bucket.put(props.key, body, { httpMetadata: { contentType: "application/json" } }),
      GATEWAY_PUT_TIMEOUT_MS,
      "a credential put",
    );
  }
}

/** `ctx.exports`, as far as the factories need it. */
export interface GatewayExports {
  readonly DirectoryBackupGateway: (options: {
    readonly props: Record<string, unknown>;
  }) => Fetcher & {
    createUpload(name?: string): Promise<string>;
    completeUpload(uploadId: string, parts: readonly unknown[]): Promise<number>;
    abortUpload(uploadId: string): Promise<void>;
    deleteObject(): Promise<void>;
    putCredential(body: Uint8Array): Promise<void>;
  };
}

/** The generation whose writes these factories carry: the running container's. */
export interface WriterIdentity {
  readonly computerId: BackupFence["computerId"];
  readonly generation: BackupFence["generation"];
}

/**
 * `DirectoryBackup` for one computer's container and generation, by key prefix: every gateway
 * it builds (the container's write grant and the control calls) carries the workspace fence.
 */
export function directoryBackups(
  container: Container,
  exports: GatewayExports,
  writer: WriterIdentity,
  binding: string = CHECKPOINTS_BINDING,
): DirectoryBackupsFor {
  const fence: BackupFence = { fenceVersion: 1, ...writer, kind: "workspace" };
  const gateway = (options: { readonly props: Record<string, unknown> }) =>
    exports.DirectoryBackupGateway({ props: { ...options.props, fence } });
  return (prefix: string): DirectoryBackups =>
    new DirectoryBackup(
      container,
      gateway as unknown as ConstructorParameters<typeof DirectoryBackup>[1],
      { binding, prefix },
    );
}

/** A credential bundle's put through the fenced gateway (kind `credential`). */
export function credentialWriter(
  exports: GatewayExports,
  writer: WriterIdentity,
  binding: string = CHECKPOINTS_BINDING,
): { put(key: string, body: Uint8Array): Promise<void> } {
  const fence: BackupFence = { fenceVersion: 1, ...writer, kind: "credential" };
  return {
    put: (key, body) =>
      exports
        .DirectoryBackupGateway({
          props: { protocolVersion: 1, mode: "control", binding, key, fence },
        })
        .putCredential(body),
  };
}

export { FencedBackupGateway as DirectoryBackupGateway };
