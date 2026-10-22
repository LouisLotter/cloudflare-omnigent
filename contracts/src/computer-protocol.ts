import { z } from "zod";
import {
  AbsolutePath,
  CheckpointId,
  ComputerId,
  Generation,
  HostId,
  LayerId,
  OperationId,
  Sha256Hex,
  StartAttempt,
  Timestamp,
} from "./ids.ts";
import { HostConfig, HostName, LaunchToken } from "./launcher.ts";
import { CredentialBundle, DeclaredCredentialPath, WorkspaceManifest } from "./manifests.ts";

// The computer API: messages between a computer's supervisor (WP3.4) and its WorkspaceDO (WP3.1),
// through WP3.3's `internal/computer-api.ts` and container port. Two directions, both plain HTTP:
// - supervisor → WorkspaceDO: `POST http://computer.internal/v1/messages`, a `SupervisorMessage`.
//   The intercept's trusted props (`InterceptProps`) name the computer and its generation; the
//   message must name the same, or it is refused as `stale_generation`.
// - WorkspaceDO → supervisor: `POST http://<container>:8090/v1/commands`, a `WorkspaceCommand`
//   over the container port. The supervisor refuses a command for any generation but its own.
//
// Safe retry (WP2.2's and S3's staging runs, 22 Oct):
// - Requests from a Durable Object to its container failed with "Network connection lost." three
//   times in about five minutes of busy calls, the container still running; and on the computer's
//   live connection no close reached the computer after a Durable Object reset, a version switch
//   or a stop. So the computer API keeps no long-lived socket: every message is one bounded
//   request, liveness comes from periodic `report`s, and silence means "unknown", never "stopped".
// - Every message carries an operation ID, and each type has an idempotency rule
//   (COMPUTER_API_MESSAGES), so a failed or unanswered request is repeated unchanged, with the
//   same operation ID, until it gets an answer. Nothing is repeated without one.
// - A receiver refuses an unsupported protocol version before changing any state.

export const SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS = [1] as const;
export const SUPERVISOR_PROTOCOL_VERSION = 1;

/** The computer API's virtual host, intercepted with the computer's identity in its props. */
export const COMPUTER_API_HOST = "computer.internal";
export const COMPUTER_API_URL = `http://${COMPUTER_API_HOST}/v1/messages`;
/** The supervisor's command port inside the computer, reached only over the container port. */
export const SUPERVISOR_API_PORT = 8090;
export const SUPERVISOR_COMMANDS_PATH = "/v1/commands";
/** The computer's live connection to the server (A′), intercepted. */
export const OMNIGENT_INTERNAL_URL = "http://omnigent.internal";

/**
 * The supervisor's start environment, set by WorkspaceDO at every start, so the supervisor can
 * fill each message's envelope. The host's identity and launch token never travel this way: they
 * come with `start_host`, for one attempt.
 */
export const COMPUTER_START_ENV = {
  computerId: "CFO_COMPUTER_ID",
  generation: "CFO_GENERATION",
} as const;

/** Larger messages are refused (a credential bundle is the largest). */
export const MAX_COMPUTER_API_BODY_BYTES = 512 * 1024;

/**
 * The trusted props WorkspaceDO gives a computer's intercepts. They outlive the code that wrote
 * them (a deploy runs new handler code with old props), so they carry a version, and a handler
 * refuses props newer than it knows. `hostId` is null until the first `start_host` names it; the
 * live-connection route refuses a host tunnel for any other host ID, and for any generation but
 * this one.
 */
export const SUPPORTED_INTERCEPT_PROPS_VERSIONS = [1] as const;
export const InterceptProps = z.strictObject({
  propsVersion: z.number().int().min(1),
  computerId: ComputerId,
  generation: Generation,
  hostId: HostId.nullable(),
});
export type InterceptProps = z.infer<typeof InterceptProps>;

const envelope = {
  protocolVersion: z.number().int().min(1),
  computerId: ComputerId,
  generation: Generation,
  operationId: OperationId,
};

// ---------------------------------------------------------------------------------------------
// Supervisor → WorkspaceDO.

/** First message of each generation, once the supervisor runs. Idempotent per generation. */
export const SupervisorHello = z.strictObject({
  type: z.literal("hello"),
  ...envelope,
  supervisorVersion: z.string().min(1).max(64),
});
export type SupervisorHello = z.infer<typeof SupervisorHello>;

/** What the supervisor's host process is doing. `refused`: exited with "token refused" (77) and
 * parked, never restarted by the supervisor. */
export const HostProcessState = z.enum([
  "not_started",
  "starting",
  "running",
  "restarting",
  "refused",
]);

/** A CLI's own sign-in status, from its status command; the platform never reads login files. */
export const CliLoginStatus = z.enum(["signed_in", "signed_out", "expired", "unknown"]);

/**
 * The supervisor's state, sent periodically and on every change, and returned by `status`.
 * State, not events: a report replaces every earlier one. `seq` increases within a generation, and
 * WorkspaceDO ignores a report whose `seq` it has already applied, so reports may be repeated
 * or arrive out of order.
 *
 * Reports are not ordered against commands: one sent before `start_host`'s parameters arrived can
 * be delivered after them. So a report never releases a handed-out start attempt (only the
 * supervisor's `declined` answer does), and its host state counts only when `host.startAttempt` is
 * the current attempt: `refused` then moves the computer to `host_refused`; a report about an
 * older attempt, or none, changes nothing about the claim.
 */
export const SupervisorReport = z.strictObject({
  seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  host: z.strictObject({
    state: HostProcessState,
    /** The attempt whose parameters the supervisor holds, if any. */
    startAttempt: StartAttempt.nullable(),
    restarts: z.number().int().min(0),
  }),
  /** Runner processes alive on the computer (the fenced sleep and the backstop save). */
  runnerProcesses: z.number().int().min(0),
  restore: z.enum(["pending", "running", "confirmed", "failed"]),
  capture: z.enum(["idle", "running"]),
  /** Declared credential files changed since the last acknowledged credential checkpoint. */
  credentialsPending: z.array(DeclaredCredentialPath).max(16),
  logins: z.strictObject({ claude: CliLoginStatus, codex: CliLoginStatus }),
});
export type SupervisorReport = z.infer<typeof SupervisorReport>;

export const ReportMessage = z.strictObject({
  type: z.literal("report"),
  ...envelope,
  report: SupervisorReport,
});

/**
 * A credential checkpoint, asked for once the watcher's copy settled (500 ms, read stably), right
 * after a sign-in, after a logout, and on `credential_snapshot`. Retried until acknowledged
 * (R-18). Idempotent by (`generation`, `bundle.order`): a repeat returns the recorded outcome.
 * WorkspaceDO answers `superseded` for a bundle at or below the generation's order floor (copies
 * taken before the credentials were installed) or not newer than the pointer (`credentialIsNewer`),
 * and refuses one before the generation's restore is confirmed (R-19).
 */
export const CredentialCheckpointMessage = z
  .strictObject({
    type: z.literal("credential_checkpoint"),
    ...envelope,
    bundle: CredentialBundle,
  })
  .refine((m) => m.bundle.computerId === m.computerId && m.bundle.generation === m.generation, {
    message: "the bundle is this computer's, from this generation",
  });

/** A best-effort workspace save, asked for when the supervisor receives SIGTERM. */
export const SaveRequestMessage = z.strictObject({
  type: z.literal("save_request"),
  ...envelope,
  reason: z.literal("sigterm"),
});

export const SupervisorMessage = z.discriminatedUnion("type", [
  SupervisorHello,
  ReportMessage,
  CredentialCheckpointMessage,
  SaveRequestMessage,
]);
export type SupervisorMessage = z.infer<typeof SupervisorMessage>;

/** WorkspaceDO's answers. A refusal is an `ErrorBody` (`stale_generation`, `unsupported_version`,
 * `bad_request`; `unavailable` is retryable). */
export const SupervisorReply = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("hello"), protocolVersion: z.number().int().min(1) }),
  z.strictObject({ type: z.literal("report"), appliedSeq: z.number().int().min(0) }),
  z.strictObject({
    type: z.literal("credential_checkpoint"),
    /** `published`: this bundle is now the pointer. `superseded`: the pointer is already as new
     * or newer, or the bundle predates the install; the supervisor stops retrying either way. */
    outcome: z.enum(["published", "superseded"]),
    checkpointId: CheckpointId.nullable(),
  }),
  z.strictObject({ type: z.literal("save_request"), outcome: z.enum(["accepted", "refused"]) }),
]);
export type SupervisorReply = z.infer<typeof SupervisorReply>;

// ---------------------------------------------------------------------------------------------
// WorkspaceDO → supervisor.

/**
 * Install the declared credential files from the latest credential checkpoint, after the
 * workspace restore: into a staging directory first, then only the declared files; tombstoned
 * files are deleted. `null`: no credential checkpoint exists, so nothing is installed. Idempotent
 * by operation ID; installing the same bundle again changes nothing. The bundle is this
 * computer's, from any earlier generation. The supervisor's credential watcher starts only after
 * the install, and its reply's `orderFloor` is the highest copy order it had taken before: a
 * bundle at or below it predates the restored credentials and is never published (S6's cutoff).
 */
export const InstallCredentialsCommand = z
  .strictObject({
    type: z.literal("install_credentials"),
    ...envelope,
    bundle: CredentialBundle.nullable(),
  })
  .refine((c) => c.bundle === null || c.bundle.computerId === c.computerId, {
    message: "the bundle is this computer's",
  });

/**
 * Merge the restored layers and move the result into place. WorkspaceDO has restored each layer
 * with `DirectoryBackup` into `layerDirs`, in the manifest's order. The supervisor applies them in
 * a staging directory, strips any member the checkpoint policy does not save (with an alert),
 * rebuilds the index and checks it against each layer's `treeDigest`, checks the tree against the
 * index, then moves it into place. A missing or corrupt layer fails it and changes nothing.
 * `manifest: null`: a new computer, nothing to restore. Starts a job; idempotent by operation ID.
 * The manifest is this computer's, from any earlier generation.
 */
export const RestoreWorkspaceCommand = z
  .strictObject({
    type: z.literal("restore_workspace"),
    ...envelope,
    manifest: WorkspaceManifest.nullable(),
    layerDirs: z.array(AbsolutePath).max(21),
  })
  .refine((c) => (c.manifest?.layers.length ?? 0) === c.layerDirs.length, {
    message: "one restored directory per layer",
  })
  .refine((c) => c.manifest === null || c.manifest.computerId === c.computerId, {
    message: "the manifest is this computer's",
  });

/**
 * Host start parameters for one attempt (G1BR-005), sent only after both restores are confirmed.
 * Idempotent by attempt: the supervisor takes an attempt once and answers `taken` for a repeat;
 * it answers `superseded` for an attempt older than one it took or declined, and
 * `refused_live_host` for a newer attempt while the host of an earlier one is starting, live or
 * being restarted (only after reporting `refused` does it take a newer one). `declined`: it did
 * not take this attempt (its own restore is not done, say), and it never takes this attempt or an
 * older one later, in any delivery, so WorkspaceDO may treat the attempt as unclaimed
 * (`start_not_taken`). It keeps the token in memory only, and restarts a crashed host with it,
 * whatever the exit code but 77. The token is never logged.
 */
export const StartHostCommand = z.strictObject({
  type: z.literal("start_host"),
  ...envelope,
  startAttempt: StartAttempt,
  hostId: HostId,
  hostName: HostName,
  token: LaunchToken,
  hostConfig: HostConfig,
});

/** The pause lease (D7, R-14, D25): the guard resumes everything by `hardMs` at the latest. */
export const PauseLease = z
  .strictObject({
    targetMs: z.number().int().min(1000).max(40_000),
    hardMs: z.number().int().min(1000).max(40_000),
  })
  .refine((l) => l.targetMs <= l.hardMs, { message: "the target within the hard budget" });

/**
 * Take a capture: copy the declared roots to the kept snapshot while everything runs, pause
 * everything but the supervisor and its guard under the lease, bring the copy up to date with a
 * content comparison, resume, then stage a layer against `parent` (a delta), or the whole snapshot
 * (a base). Every member is filtered by checkpoint policy `policyVersion`. Starts a job;
 * idempotent by operation ID. The upload is WorkspaceDO's, from the staged layer.
 */
const capture = {
  type: z.literal("capture"),
  ...envelope,
  layerId: LayerId,
  policyVersion: z.number().int().min(1),
  lease: PauseLease,
};
export const CaptureCommand = z.discriminatedUnion("kind", [
  z.strictObject({ ...capture, kind: z.literal("base"), parent: z.null() }),
  z.strictObject({
    ...capture,
    kind: z.literal("delta"),
    /** The published checkpoint the delta is computed against. */
    parent: z.strictObject({ checkpointId: CheckpointId, treeDigest: Sha256Hex }),
  }),
]);

/**
 * After the upload: `published` (the manifest naming the layer is the pointer, so the staged
 * index becomes the parent of the next delta) or `discarded`. The staged layer is deleted either
 * way; the kept snapshot stays. Idempotent by the capture's operation ID.
 */
const finishCapture = {
  type: z.literal("finish_capture"),
  ...envelope,
  captureOperationId: OperationId,
};
export const FinishCaptureCommand = z.discriminatedUnion("outcome", [
  z.strictObject({ ...finishCapture, outcome: z.literal("published"), checkpointId: CheckpointId }),
  z.strictObject({ ...finishCapture, outcome: z.literal("discarded"), checkpointId: z.null() }),
]);

/** Read a job's state. Read-only. */
export const JobStatusCommand = z.strictObject({
  type: z.literal("job_status"),
  ...envelope,
  jobOperationId: OperationId,
});

/** Read the supervisor's report. Read-only. */
export const StatusCommand = z.strictObject({ type: z.literal("status"), ...envelope });

/**
 * The final-checkpoint barrier for a stop: take a whole snapshot of the declared files now, under
 * the copy lock, and send it as a `credential_checkpoint` whatever changed, then reply with its
 * order. WorkspaceDO stops only once its pointer holds that order or newer from this generation
 * (lifecycle step 7). Idempotent by operation ID: a repeat returns the same order and takes no
 * second snapshot.
 */
export const CredentialSnapshotCommand = z.strictObject({
  type: z.literal("credential_snapshot"),
  ...envelope,
});

/** Ask the CLIs to sign out (`claude auth logout`, `codex logout`); the watcher then publishes
 * the tombstones. Idempotent: signing out again changes nothing. */
export const SignOutCommand = z.strictObject({ type: z.literal("sign_out"), ...envelope });

export const WorkspaceCommand = z.discriminatedUnion("type", [
  InstallCredentialsCommand,
  RestoreWorkspaceCommand,
  StartHostCommand,
  CaptureCommand,
  FinishCaptureCommand,
  JobStatusCommand,
  StatusCommand,
  CredentialSnapshotCommand,
  SignOutCommand,
]);
export type WorkspaceCommand = z.infer<typeof WorkspaceCommand>;

/** Why a restore failed; the computer's directories are as they were. */
export const RestoreFailure = z.enum([
  "layer_missing",
  "layer_corrupt",
  "index_mismatch",
  "path_refused",
  "disk_full",
  "unsupported_format",
  "move_failed",
]);

/** Why a capture failed; nothing was staged, and the pointer is unchanged (FH-09). */
export const CaptureFailure = z.enum([
  "lease_expired",
  "disk_budget",
  "copy_failed",
  "stage_failed",
  "parent_mismatch",
  "policy_violation",
  "busy",
]);

const job = { jobOperationId: OperationId };

export const RestoreJob = z.discriminatedUnion("state", [
  z.strictObject({ kind: z.literal("restore"), ...job, state: z.literal("running") }),
  z.strictObject({
    kind: z.literal("restore"),
    ...job,
    state: z.literal("done"),
    treeDigest: Sha256Hex.nullable(),
    entries: z.number().int().min(0),
    /** Members stripped because the policy does not save them; each raised an alert. */
    stripped: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("restore"),
    ...job,
    state: z.literal("failed"),
    reason: RestoreFailure,
  }),
]);

export const CaptureJob = z.discriminatedUnion("state", [
  z.strictObject({ kind: z.literal("capture"), ...job, state: z.literal("running") }),
  z.strictObject({
    kind: z.literal("capture"),
    ...job,
    state: z.literal("staged"),
    layerDir: AbsolutePath,
    indexSha256: Sha256Hex,
    treeDigest: Sha256Hex,
    entries: z.number().int().min(0),
    deleted: z.number().int().min(0),
    bytes: z.number().int().min(0),
    cutAt: Timestamp,
    pausedMs: z.number().int().min(0),
  }),
  // Nothing changed since the parent: no layer, but a "verified unchanged" outcome (R-04).
  z.strictObject({
    kind: z.literal("capture"),
    ...job,
    state: z.literal("unchanged"),
    cutAt: Timestamp,
    pausedMs: z.number().int().min(0),
  }),
  z.strictObject({
    kind: z.literal("capture"),
    ...job,
    state: z.literal("failed"),
    reason: CaptureFailure,
    pausedMs: z.number().int().min(0),
  }),
]);

export const WorkspaceCommandReply = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("install_credentials"),
    installed: z.array(DeclaredCredentialPath).max(16),
    removed: z.array(DeclaredCredentialPath).max(16),
    /** The highest copy order taken before the install; 0 if none. */
    orderFloor: z.number().int().min(0),
  }),
  z.strictObject({ type: z.literal("restore_workspace"), job: RestoreJob }),
  z.strictObject({
    type: z.literal("start_host"),
    outcome: z.enum(["taken", "superseded", "refused_live_host", "declined"]),
  }),
  z.strictObject({ type: z.literal("credential_snapshot"), order: z.number().int().min(1) }),
  z.strictObject({ type: z.literal("capture"), job: CaptureJob }),
  z.strictObject({ type: z.literal("finish_capture"), done: z.literal(true) }),
  z.strictObject({
    type: z.literal("job_status"),
    job: z.union([RestoreJob, CaptureJob]),
  }),
  z.strictObject({ type: z.literal("status"), report: SupervisorReport }),
  z.strictObject({
    type: z.literal("sign_out"),
    /** Each CLI's logout exit status. Both CLIs exit 0 even when revocation failed (S6), so this
     * proves a local sign-out at most. */
    claude: z.enum(["ok", "failed"]),
    codex: z.enum(["ok", "failed"]),
  }),
]);
export type WorkspaceCommandReply = z.infer<typeof WorkspaceCommandReply>;

// ---------------------------------------------------------------------------------------------

/**
 * How each message is safe to repeat:
 * - `per_generation`: one effect per generation; a repeat returns the same answer;
 * - `sequence`: ordered by `seq`; an already applied one is acknowledged and ignored;
 * - `order`: ordered by (`generation`, copy order); an older or equal one is `superseded`;
 * - `attempt`: one effect per start attempt; see `StartHostCommand`;
 * - `operation_id`: the outcome is recorded under the operation ID and a repeat returns it;
 * - `read_only`: no effect.
 * All of them may be repeated after "Network connection lost." or any unanswered request.
 */
export const COMPUTER_API_MESSAGES = {
  hello: { direction: "to_workspace", idempotency: "per_generation" },
  report: { direction: "to_workspace", idempotency: "sequence" },
  credential_checkpoint: { direction: "to_workspace", idempotency: "order" },
  save_request: { direction: "to_workspace", idempotency: "operation_id" },
  install_credentials: { direction: "to_supervisor", idempotency: "operation_id" },
  restore_workspace: { direction: "to_supervisor", idempotency: "operation_id" },
  start_host: { direction: "to_supervisor", idempotency: "attempt" },
  capture: { direction: "to_supervisor", idempotency: "operation_id" },
  finish_capture: { direction: "to_supervisor", idempotency: "operation_id" },
  job_status: { direction: "to_supervisor", idempotency: "read_only" },
  status: { direction: "to_supervisor", idempotency: "read_only" },
  credential_snapshot: { direction: "to_supervisor", idempotency: "operation_id" },
  sign_out: { direction: "to_supervisor", idempotency: "operation_id" },
} as const satisfies Record<
  SupervisorMessage["type"] | WorkspaceCommand["type"],
  {
    direction: "to_workspace" | "to_supervisor";
    idempotency: "per_generation" | "sequence" | "order" | "attempt" | "operation_id" | "read_only";
  }
>;
