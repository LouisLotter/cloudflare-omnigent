// The write fence of the computers' checkpoint bucket (the lead's decisions, 26 Oct). Every
// workspace layer and credential bundle reaches R2 through the platform's backup gateway
// (`egress/backups.ts`), and the gateway asks the computer's WorkspaceDO before each put. WP3.1's
// policy: the computer is not fully removed, the write is for its current generation, and a
// credential's key is a pending upload of that generation (the removal sign-out's own upload
// included, so a removal intent alone does not refuse). Pure: no Workers runtime import.
//
// **Admission control, not a drain.** The fence decides whether a write may *start*. Once
// WorkspaceDO moves on (a new generation, a removal), no new write is admitted; but a write
// admitted just before the move can still land afterwards: WorkspaceDO may answer "allowed" and
// change its state before the gateway's put reaches R2, and an R2 call already issued cannot be
// cancelled. Nothing here promises that no object appears after the move. Safety comes from WP3.1:
// it never retires a credential tombstone in version 1 and deletes each tombstoned key again
// every 6 hours; restore and resume read only the objects a record or manifest names, never a
// prefix listing; and a removed computer's prefixes are swept again every 6 hours. A late layer
// cannot overwrite a current one: the SDK names every backup's object with a fresh
// `crypto.randomUUID()`, so a stale write lands under its own key.
//
// The fence travels in the gateway's props, set by the platform code that builds the gateway for
// one computer's generation (`directoryBackups`, `credentialWriter`). A write without a fence, or
// for a key outside the computer's own prefix, is refused without asking. A WorkspaceDO that does
// not answer is a refusal too (fail closed): the write can be repeated later.

import { ComputerId, Generation, WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { z } from "zod";
import type { WriteCheck, WriteDecision } from "../shared/rpc.ts";

export type { WriteCheck, WriteDecision };

/** The fence the gateway's props carry: whose write this is. */
export const BackupFence = z.strictObject({
  fenceVersion: z.literal(1),
  computerId: ComputerId,
  generation: Generation,
  kind: z.enum(["credential", "workspace"]),
});
export type BackupFence = z.infer<typeof BackupFence>;

/** The interface version of WorkspaceDO's RPC this code speaks (contracts' controllers.ts). */
export const WRITE_FENCE_INTERFACE_VERSION = WORKSPACE_INTERFACE_VERSION;

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

/**
 * How long the gateway waits for an R2 call it made before it gives up and reports a failure.
 * This bounds the waiting only: the R2 call is not cancelled and may still complete later.
 */
export const GATEWAY_PUT_TIMEOUT_MS = 120_000;
/** How long the gateway waits for WorkspaceDO's answer; no answer is a refusal. */
export const FENCE_CHECK_TIMEOUT_MS = 10_000;

/**
 * `promise`, or a rejection once `ms` have passed (the timer is cleared either way). The work
 * behind `promise` goes on: only the wait ends.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}
