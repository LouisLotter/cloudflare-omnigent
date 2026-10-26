import { z } from "zod";
import { InterceptProps, SupervisorMessage } from "./computer-protocol.ts";
import { ComputerId, Generation, HostId, InstanceSize, OperationId, Timestamp } from "./ids.ts";
import { AdmissionReason, HostSandboxStatus, LauncherRequest, ProvisionName } from "./launcher.ts";
import { LifecycleState, type PageRefusal } from "./lifecycle.ts";
import { SetupCard } from "./setup-cards.ts";

// The payloads of WorkspaceDO's and ControlDO's RPC (the TypeScript interfaces are in
// `worker/src/shared/rpc.ts`). Both run in the platform Worker, but a deploy runs the new
// Worker's code against Durable Objects still on the old version for about 300 s, and the web
// Worker calls WorkspaceDO's pages interface from another deployment. So, as for OmnigentServer
// (R-26, CF-03):
//   - every call carries `interfaceVersion`; a receiver refuses a newer one with
//     `unsupported_version`, so a release out of order fails visibly;
//   - changes are additive only, and the platform Worker ships an addition before a caller uses
//     it;
//   - unknown fields are tolerated (these schemas are loose), in calls and in results;
//   - every mutating call carries an operation ID, and a repeat returns the recorded outcome;
//   - failures are error codes (`platformError`), never error classes.
// Each receiver parses its argument with these schemas before use.

/** The interface versions this source tree speaks. Raise one only when something is added. */
export const WORKSPACE_INTERFACE_VERSION = 1;
export const CONTROL_INTERFACE_VERSION = 1;

const rpc = { interfaceVersion: z.number().int().min(1) };

// ---------------------------------------------------------------------------------------------
// ControlDO: the installation's computers, limits and reservations (WP3.2).

/** A reservation's phase, owned and persisted by WorkspaceDO (design, One controller per
 * computer). ControlDO holds only the slot: a (computer, generation) pair. */
export const ReservationPhase = z.enum(["reserved", "starting", "running", "releasing"]);
export type ReservationPhase = z.infer<typeof ReservationPhase>;

export const ControlCall = z.discriminatedUnion("method", [
  /** `provision`: the computer recorded under this name, created on the first call. */
  z.looseObject({
    method: z.literal("register_computer"),
    ...rpc,
    operationId: OperationId,
    name: ProvisionName,
  }),
  /** Every recorded computer, for the cloud-computers page. Read-only. */
  z.looseObject({ method: z.literal("list_computers"), ...rpc }),
  /** A slot for this generation. Idempotent by (computer, generation): a repeat returns the same
   * answer. Refused at once at the limit, with no queue (R-20). */
  z.looseObject({
    method: z.literal("reserve"),
    ...rpc,
    operationId: OperationId,
    computerId: ComputerId,
    generation: Generation,
  }),
  /** Frees the slot once the generation's container is confirmed stopped or its start fenced.
   * Idempotent. */
  z.looseObject({
    method: z.literal("release"),
    ...rpc,
    operationId: OperationId,
    computerId: ComputerId,
    generation: Generation,
  }),
  /** A resolved removal: drops the computer and its name. Idempotent. */
  z.looseObject({
    method: z.literal("forget_computer"),
    ...rpc,
    operationId: OperationId,
    computerId: ComputerId,
  }),
  /** The installation's limits. Read-only. */
  z.looseObject({ method: z.literal("limits"), ...rpc }),
]);
export type ControlCall = z.infer<typeof ControlCall>;

export const ControlResult = z.discriminatedUnion("method", [
  z.looseObject({ method: z.literal("register_computer"), computerId: ComputerId }),
  z.looseObject({
    method: z.literal("list_computers"),
    computers: z.array(z.looseObject({ computerId: ComputerId, name: ProvisionName })).max(1000),
  }),
  z.discriminatedUnion("granted", [
    z.looseObject({
      method: z.literal("reserve"),
      granted: z.literal(true),
      /**
       * The installation's largest instance size, read when this answer is given (a replay gets
       * the current value), so a start never needs a second call that could be lost (WP3.2 r1-1).
       * Optional only for an older ControlDO during a deploy: a caller that gets no size must
       * not start above a cap it cannot confirm.
       */
      maxInstanceSize: InstanceSize.optional(),
    }),
    z.looseObject({
      method: z.literal("reserve"),
      granted: z.literal(false),
      reason: z.literal("at_capacity"),
      awake: z.number().int().min(0),
      limit: z.number().int().min(0),
    }),
  ]),
  z.looseObject({ method: z.literal("release"), released: z.boolean() }),
  z.looseObject({ method: z.literal("forget_computer"), forgotten: z.boolean() }),
  z.looseObject({
    method: z.literal("limits"),
    maxAwakeComputers: z.number().int().min(0),
    maxInstanceSize: InstanceSize,
  }),
]);
export type ControlResult = z.infer<typeof ControlResult>;

// ---------------------------------------------------------------------------------------------
// WorkspaceDO (WP3.1).

/** From `internal/platform-api.ts`, after the HMAC and the request's schema are checked. */
export const LauncherCall = z.looseObject({ ...rpc, request: LauncherRequest });
export type LauncherCall = z.infer<typeof LauncherCall>;

/** From `internal/computer-api.ts`: a supervisor's message with its intercept's trusted props. */
export const ComputerCall = z.looseObject({
  ...rpc,
  props: InterceptProps,
  message: SupervisorMessage,
});
export type ComputerCall = z.infer<typeof ComputerCall>;

/** For ControlDO's reconciliation: whether the generation still holds or may use its slot. */
export const ReservationState = z.looseObject({
  computerId: ComputerId,
  generation: Generation,
  phase: ReservationPhase.nullable(),
  /** The generation's start was fenced out: a late start refuses itself. */
  fenced: z.boolean(),
  /** Whether a container runs, as the port last saw it; null if unknown. */
  containerRunning: z.boolean().nullable(),
});
export type ReservationState = z.infer<typeof ReservationState>;

/**
 * What the cloud-computers page and the setup page show for one computer (WP3.5). Names are
 * rendered as text only.
 */
export const ComputerPageState = z.looseObject({
  computerId: ComputerId,
  /** The display name `start_host` named; null before the first start. */
  hostName: z.string().max(128).nullable(),
  hostId: HostId.nullable(),
  size: InstanceSize,
  /** A size change applies at the next start. */
  nextSize: InstanceSize.nullable(),
  lifecycle: LifecycleState,
  status: HostSandboxStatus,
  generation: Generation,
  admission: z.looseObject({ admitting: z.boolean(), reason: AdmissionReason.optional() }),
  /** A save is pending or running (RC-36). */
  saving: z.boolean(),
  /** The last published workspace checkpoint's cut. */
  lastSavedAt: Timestamp.nullable(),
  /** The last time the files were verified equal to a published checkpoint in this generation:
   * a confirmed restore, a published save or a verified-unchanged capture (R-04). */
  verifiedAt: Timestamp.nullable(),
  /** The declared roots' size, for the 1.5 GB warning. */
  workspaceBytes: z.number().int().min(0).nullable(),
  /** The activity lease: the last launcher call of any kind, and the last `keep_alive`. */
  lastContactAt: Timestamp.nullable(),
  lastKeepAliveAt: Timestamp.nullable(),
  /** "Restored to 14:05; later file changes were lost": the checkpoint's cut, when a restore
   * used a checkpoint older than the computer's last activity. */
  restoredTo: Timestamp.nullable(),
  unexpectedStopAt: Timestamp.nullable(),
  /** Sleeps refused in a row; at three the page offers "Stop without saving" (FH-35). */
  refusedSleeps: z.number().int().min(0),
  setupCards: z.array(SetupCard).length(2),
  removal: z.looseObject({
    state: z.enum(["none", "pending", "resolved"]),
    signOut: z.enum(["none", "requested", "tombstoned", "verified"]),
    loginPossiblyLost: z.boolean(),
    revocationRecorded: z.boolean(),
  }),
});
export type ComputerPageState = z.infer<typeof ComputerPageState>;

const mutating = { ...rpc, operationId: OperationId };

/** The web Worker's narrow interface into WorkspaceDO: never the launcher's operations. */
export const PagesCall = z.discriminatedUnion("action", [
  z.looseObject({ action: z.literal("state"), ...rpc }),
  z.looseObject({ action: z.literal("set_size"), ...mutating, size: InstanceSize }),
  /** Stops the computer; Omnigent's next wake starts it afresh. Warns that it ends work. */
  z.looseObject({ action: z.literal("restart"), ...mutating }),
  z.looseObject({ action: z.literal("stop_without_saving"), ...mutating }),
  /** Runs the CLIs' logouts, starting the computer for it if a removal is pending. */
  z.looseObject({ action: z.literal("sign_out"), ...mutating }),
  /** The person records that they revoked the sessions at the providers. */
  z.looseObject({ action: z.literal("record_revocation"), ...mutating }),
  z.looseObject({ action: z.literal("resolve_removal"), ...mutating }),
]);
export type PagesCall = z.infer<typeof PagesCall>;

const pageRefusal = z.enum([
  "busy",
  "not_running",
  "not_offered",
  "unresolved",
  "at_capacity",
] as const satisfies readonly PageRefusal[]);

const pageOutcome = (action: string) =>
  z.discriminatedUnion("outcome", [
    z.looseObject({ action: z.literal(action), outcome: z.literal("accepted") }),
    z.looseObject({
      action: z.literal(action),
      outcome: z.literal("refused"),
      reason: pageRefusal,
    }),
  ]);

export const PagesResult = z.discriminatedUnion("action", [
  z.looseObject({ action: z.literal("state"), computer: ComputerPageState }),
  z.looseObject({ action: z.literal("set_size"), appliesAt: z.literal("next_start") }),
  pageOutcome("restart"),
  pageOutcome("stop_without_saving"),
  pageOutcome("sign_out"),
  z.looseObject({ action: z.literal("record_revocation"), recorded: z.literal(true) }),
  pageOutcome("resolve_removal"),
]);
export type PagesResult = z.infer<typeof PagesResult>;
