// The write fence of the computers' checkpoint bucket (the lead's decision, 26 Oct). Every
// workspace layer and credential bundle reaches R2 through the platform's backup gateway
// (`egress/backups.ts`), and the gateway asks the computer's WorkspaceDO before each put: the
// computer exists, has no removal intent, runs the named generation, and (for a credential) the
// key is a pending upload. Pure: no Workers runtime import.
//
// The fence travels in the gateway's props, set by the platform code that builds the gateway for
// one computer's generation (`directoryBackups`, `credentialWriter`). A write without a fence, or
// for a key outside the computer's own prefix, is refused without asking. A WorkspaceDO that does
// not answer is a refusal too (fail closed): the write can be repeated, a stale one cannot be
// taken back.

import { ComputerId, Generation } from "@cfo/contracts";
import { z } from "zod";

/**
 * WorkspaceDO's `writeAllowed` call. The shape of WP3.1's `WriteCheck` (shared `rpc.ts`, its
 * `[shared]` commit of 26 Oct); the lead reconciles the two at merge.
 */
export interface WriteCheck {
  readonly interfaceVersion: number;
  readonly computerId: ComputerId;
  readonly generation: Generation;
  readonly kind: "credential" | "workspace";
  /** The R2 key the write targets. */
  readonly objectKey: string;
}

export interface WriteDecision {
  readonly allowed: boolean;
  readonly reason?:
    | "unknown_computer"
    | "removed"
    | "stale_generation"
    | "not_pending"
    | "foreign_key";
}

/** The fence the gateway's props carry: whose write this is. */
export const BackupFence = z.strictObject({
  fenceVersion: z.literal(1),
  computerId: ComputerId,
  generation: Generation,
  kind: z.enum(["credential", "workspace"]),
});
export type BackupFence = z.infer<typeof BackupFence>;

/** The interface version of WorkspaceDO's RPC this code speaks (contracts' controllers.ts). */
export const WRITE_FENCE_INTERFACE_VERSION = 1;

/** Where a computer's objects of each kind live (RC-25), as the contracts name them. */
export function fencePrefix(fence: BackupFence): string {
  return fence.kind === "workspace"
    ? `workspace/${fence.computerId}/`
    : `credentials/${fence.computerId}/`;
}

export type FenceVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Whether a write of `objectKey` may proceed, asking WorkspaceDO through `ask`. Never throws:
 * every failure is a refusal.
 */
export async function checkWrite(
  rawFence: unknown,
  objectKey: string,
  ask: (check: WriteCheck) => Promise<WriteDecision>,
): Promise<FenceVerdict> {
  const fence = BackupFence.safeParse(rawFence);
  if (!fence.success) return { allowed: false, reason: "unfenced" };
  const prefix = fencePrefix(fence.data);
  const rest = objectKey.slice(prefix.length);
  if (
    !objectKey.startsWith(prefix) ||
    rest === "" ||
    rest.includes("/") ||
    rest.includes("..") ||
    objectKey.length > 1024
  ) {
    return { allowed: false, reason: "foreign_key" };
  }
  let decision: WriteDecision;
  try {
    decision = await ask({
      interfaceVersion: WRITE_FENCE_INTERFACE_VERSION,
      computerId: fence.data.computerId,
      generation: fence.data.generation,
      kind: fence.data.kind,
      objectKey,
    });
  } catch {
    return { allowed: false, reason: "workspace_unreachable" };
  }
  if (decision?.allowed === true) return { allowed: true };
  return { allowed: false, reason: decision?.reason ?? "refused" };
}

/** The gateway's own bound on each R2 put it makes, and on the fence's question. */
export const GATEWAY_PUT_TIMEOUT_MS = 120_000;
export const FENCE_CHECK_TIMEOUT_MS = 10_000;

/** `promise`, or a rejection once `ms` have passed (the timer is cleared either way). */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
