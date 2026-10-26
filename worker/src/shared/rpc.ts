// The Durable Objects' RPC surfaces. DOs call each other only through the methods declared here
// (code-structure plan, module rules). Owned by the integration lead: change it through a pull
// request to the lead, together with its fake in test/support/.

import {
  type BootstrapStatus,
  type ComputerCall,
  ComputerId,
  type ControlCall,
  type ControlResult,
  Generation,
  type LauncherCall,
  type LauncherResult,
  type OutageRecord,
  type PagesCall,
  type PagesResult,
  type ReservationState,
  type SupervisorReply,
  type Timestamp,
} from "@cfo/contracts";
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// OmnigentServer (WP2.2), in the platform Worker. The web Worker reaches it through a
// cross-script Durable Object binding (AR-17), so these calls are a versioned contract between
// two deployments released at different times (R-26, CF-03):
//   - every call carries `interfaceVersion`;
//   - changes are additive only, and the platform Worker ships an addition before the web
//     Worker uses it;
//   - unknown fields are tolerated; a version newer than the receiver knows is refused with
//     `unsupported_version`, so a release out of order fails visibly instead of half-working.

/** The interface version this source tree speaks. Raise it only when something is added. */
export const OMNIGENT_SERVER_INTERFACE_VERSION = 1;

/** The one OmnigentServer object: `env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME)`. */
export const OMNIGENT_SERVER_OBJECT_NAME = "omnigent-server";

/**
 * Forwarding: platform code passes a request to Omnigent with `stub.fetch(request)`, carrying
 * the interface version in this header. OmnigentServer reads it and removes every `x-cfo-`
 * header before the request reaches the server container. The request is the caller's to
 * prepare: the web Worker sends only what ingress admitted, with trust headers stripped.
 * The answer is Omnigent's, passed through once and never retried; a WebSocket upgrade is
 * answered with a bare 101 (R-24).
 */
export const FORWARD_VERSION_HEADER = "x-cfo-interface-version";

/** What every RPC call into OmnigentServer carries. */
export interface OmnigentServerCall {
  readonly interfaceVersion: number;
}

export interface OutagesQuery extends OmnigentServerCall {
  readonly from: Timestamp;
  readonly to: Timestamp;
}

/**
 * OmnigentServer, the always-on server's Durable Object. Browser traffic reaches it through
 * `fetch`, from the web Worker once ingress admitted the request (WP2.1); the computers' live
 * connection will reach it the same way from the platform Worker's `omnigent.internal` handler
 * (WP3.3). Other platform code, such as the cloud-computers page's outage notices (WP3.5), uses
 * these methods.
 */
export interface OmnigentServerRpc {
  /**
   * Outage records that overlap [from, to), oldest first, as `outageOverlaps` defines it. An
   * ongoing outage has `endedAt: null`.
   */
  outages(query: OutagesQuery): Promise<OutageRecord[]>;
  /**
   * The watchdog's latest bootstrap check (G1BR-002), or null before its first check.
   * `initialized` is true only when `/v1/info` showed the owner and the replicated position
   * covered a position read after that.
   */
  bootstrapStatus(call: OmnigentServerCall): Promise<BootstrapStatus | null>;
  /**
   * The always-on backstop, from the platform Worker's cron trigger: arms the watchdog's alarm
   * if none is set, and lets the watchdog start a stopped server now. Nothing else: no health
   * check, and no restart of a server that runs. The watchdog's rules hold, so a server in
   * recovery mode, held after exit 78, or inside DC-37's backoff is not started.
   */
  ensureStarted(call: OmnigentServerCall): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// M3 (3.C): WorkspaceDO, one per cloud computer (WP3.1), and ControlDO, the installation's
// computers, limits and reservations (WP3.2). Both in the platform Worker. The same versioning
// rules as above apply, because a deploy runs new Worker code against Durable Objects still on
// the old version for about 300 s, and the web Worker calls the pages interface from another
// deployment. The payloads, with their zod schemas, are in `@cfo/contracts` (`controllers.ts`);
// each receiver parses its argument with them, checks `interfaceVersion` first, and answers a
// newer one with `unsupported_version`. Failures are `platformError` codes.

export { CONTROL_INTERFACE_VERSION, WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";

/** WorkspaceDO's name for a computer: `env.WORKSPACE.getByName(computerId)`. */
export function workspaceObjectName(computerId: ComputerId): string {
  return computerId;
}

/** The one ControlDO object: `env.CONTROL.getByName(CONTROL_OBJECT_NAME)`. */
export const CONTROL_OBJECT_NAME = "control";

/**
 * WorkspaceDO. Four callers, four narrow methods:
 * - `launcher`: `internal/platform-api.ts`, after the HMAC and the request's schema are checked
 *   (WP3.3). A repeated operation ID returns the recorded outcome (LAUNCHER_OPERATIONS).
 * - `computer`: `internal/computer-api.ts`, with the intercept's trusted props (WP3.3).
 * - `pages`: the web Worker's pages (WP3.5), never the launcher's operations.
 * - `reservation`: ControlDO's reconciliation (WP3.2).
 * The setup terminal's stream goes through `fetch` (WP3.5).
 */
export interface WorkspaceRpc {
  launcher(call: LauncherCall): Promise<LauncherResult>;
  computer(call: ComputerCall): Promise<SupervisorReply>;
  pages(call: PagesCall): Promise<PagesResult>;
  reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null>;
  /** The backup gateway's fence (WP3.3), asked before every write into the checkpoint bucket. */
  writeAllowed(call: WriteCheck): Promise<WriteDecision>;
}

/**
 * The write fence (the lead's decision, 26 Oct). Every credential and workspace write reaches R2
 * through the platform's own backup gateway (`egress/backups.ts`, WP3.3), which asks the
 * computer's WorkspaceDO before each `put`. A write is allowed only for a computer that exists and
 * is not fully removed, runs the named generation, and, for a credential bundle, whose key is a
 * pending upload of that generation (a removal's sign-out run included). The fence means no new
 * admissions: a write admitted before it may still land, and is cleaned up by WorkspaceDO's
 * re-delete of abandoned keys and its sweep of a removed computer's prefixes.
 */
export const WriteCheck = z.looseObject({
  interfaceVersion: z.number().int().min(1),
  computerId: ComputerId,
  generation: Generation,
  kind: z.enum(["credential", "workspace"]),
  /** The R2 key the write targets. */
  objectKey: z.string().min(1).max(1024),
});
export type WriteCheck = z.infer<typeof WriteCheck>;

export interface WriteDecision {
  readonly allowed: boolean;
  /** Why not: no such computer, removed, another generation or none running, not a pending upload,
   * or a key outside this computer's prefix. */
  readonly reason?:
    | "unknown_computer"
    | "removed"
    | "stale_generation"
    | "not_pending"
    | "foreign_key";
}

/**
 * ControlDO: one entry point for its calls, by `method` (`ControlCall`). Reservations are
 * idempotent by (computer, generation); a wake at the limit is refused at once, with no queue
 * (R-20); a slot is released only once WorkspaceDO's `reservation` shows the generation's
 * container confirmed stopped or its start fenced.
 *
 * Generations are finished in order (WP3.2, `control/limits.ts`). WorkspaceDO asks for each
 * generation once, persisted first, and asks for a newer one only when no container of an older
 * one can run. So asking for generation G, or releasing it, finishes every older generation of that
 * computer, and `forget_computer` finishes all of them:
 * - a `reserve` at or below a finished generation is refused with `stale_generation`, even while
 *   its slot is still held, and also when a granted operation is replayed after its slot was
 *   released or its generation finished: the one exception to "a repeat returns the recorded
 *   outcome" (a delayed or repeated request never takes, or is told it holds, a slot nobody would
 *   start or release); the refusal itself is recorded, so a repeat is refused the same way;
 * - a granted `reserve` replaces the computer's older slots, which never count against the limit.
 * The answer to `reservation` is read-only input to reconciliation: ControlDO never asks a computer
 * to stop, start or wake.
 */
export interface ControlRpc {
  control(call: ControlCall): Promise<ControlResult>;
}
