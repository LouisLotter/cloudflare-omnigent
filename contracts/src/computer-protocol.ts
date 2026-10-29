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

/**
 * What a supervisor can do beyond protocol 1's first commands (WP3.23), named in its `hello`:
 * `sign_in` (`sign_in_start`, `sign_in_input`, `sign_in_cancel`, `sign_in_status`),
 * `computer_status` and `staging_check`. A supervisor whose `hello` names none of them is an
 * older one: the setup page then offers the terminal for signing in. The list is free text on the
 * wire, so a newer supervisor may name more without being refused.
 *
 * `terminal_sessions` (WP3.28): the setup terminal keeps each window's shell in a session on the
 * computer, which outlives a dropped stream; ttyd takes `?arg=new&arg=<window>` for a window's
 * first stream and `?arg=attach&arg=<window>` for every later one (an `attach` with no session
 * ends the stream). The supervisor takes `terminal_end` and a capture's `endTerminals`, and
 * counts the sessions in `computer_status`. Without it, ttyd ends the shell with its stream, so
 * WorkspaceDO never sends those, and refuses a reconnect that would need the old shell.
 */
export const SUPERVISOR_FEATURES = [
  "sign_in",
  "computer_status",
  "staging_check",
  "terminal_sessions",
] as const;
export type SupervisorFeature = (typeof SUPERVISOR_FEATURES)[number];

/** First message of each generation, once the supervisor runs. Idempotent per generation. */
export const SupervisorHello = z.strictObject({
  type: z.literal("hello"),
  ...envelope,
  supervisorVersion: z.string().min(1).max(64),
  /** Additive (WP3.23): what this supervisor can do; absent from an older one. */
  features: z.array(z.string().min(1).max(32)).max(32).optional(),
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
  /**
   * A stop's final capture (WP3.28): the supervisor ends every setup-terminal session first.
   * Sent only to a supervisor with the `terminal_sessions` feature.
   */
  endTerminals: z.literal(true).optional(),
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
 * second snapshot. A supervisor with `terminal_sessions` ends every setup-terminal session first
 * (the barrier also ends a sign-out).
 */
export const CredentialSnapshotCommand = z.strictObject({
  type: z.literal("credential_snapshot"),
  ...envelope,
});

/** Ask the CLIs to sign out (`claude auth logout`, `codex logout`); the watcher then publishes
 * the tombstones. Idempotent: signing out again changes nothing. A supervisor with
 * `terminal_sessions` ends every setup-terminal session first. */
export const SignOutCommand = z.strictObject({ type: z.literal("sign_out"), ...envelope });

// Sign-in from the setup page (WP3.23; design, Signing in, D31). The supervisor runs the
// unmodified CLI's own login (`claude auth login --claudeai`, `codex login --device-auth`) in a
// pty as the computer's user, with the terminal's environment and under the workload's spawn and
// capture controls, and reads the link (and Codex's one-time code) from what the CLI prints. The
// person signs in at the provider; for Claude the page relays the code they paste to the pty.
// Completion is unchanged: the credential watcher publishes the login as after a terminal sign-in.
//
// Fencing (the design review's revision 1). WorkspaceDO numbers attempts per computer, never
// reusing a number, and binds each to the computer, its generation, the service and the Access
// session that started it. The supervisor keeps, per service, a fence: the highest attempt it has
// seen in a start or a cancel. A start below the fence, or at it once cancelled, is `superseded`;
// a newer start ends the running attempt first; a cancel raises the fence, so a start delayed in
// transit can never begin after its cancel. Input, cancel and status name their attempt and act
// only on it.
//
// Never stored or logged, anywhere: the link, Codex's one-time code and the code the person
// pastes. The supervisor holds them in memory only, WorkspaceDO only on the request path.

export const SignInService = z.enum(["claude", "codex"]);
export type SignInService = z.infer<typeof SignInService>;

/** A sign-in attempt's number, from WorkspaceDO: increasing per computer, never reused. */
export const SignInAttempt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Where each pinned CLI's sign-in link goes, observed with Claude Code 2.1.311 and Codex 0.164.0
 * (WP3.23's captured transcripts). A parsed link is accepted only if it is HTTPS on exactly this
 * host and path, with no port or user information: anything else fails the attempt as
 * unexpected output, and the page offers the terminal.
 */
export const SIGN_IN_LINKS = {
  claude: { host: "claude.com", path: "/cai/oauth/authorize" },
  codex: { host: "auth.openai.com", path: "/codex/device" },
} as const satisfies Record<SignInService, { readonly host: string; readonly path: string }>;

/** A link's characters: RFC 3986's, without the apostrophe and the brackets. */
export const SignInLink = z
  .string()
  .min(9)
  .max(2048)
  .regex(/^https:\/\/[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+$/);

/** Whether `url` is a sign-in link the pinned CLI for `service` would print. */
export function signInLinkAllowed(service: SignInService, url: string): boolean {
  if (!SignInLink.safeParse(url).success) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const expected = SIGN_IN_LINKS[service];
  return (
    parsed.protocol === "https:" &&
    parsed.hostname === expected.host &&
    parsed.host === expected.host &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === expected.path &&
    url.startsWith(`https://${expected.host}${expected.path}`)
  );
}

/** Codex's one-time device code, as Codex 0.164.0 prints it (four, a hyphen, five). */
export const SignInUserCode = z.string().regex(/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3}$/);

/** The code the person pastes for Claude: printable ASCII, no spaces or control characters. */
export const SignInCode = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[\x21-\x7e]+$/);

/**
 * An attempt's state:
 * - `starting`: the CLI runs; its link is not read yet;
 * - `awaiting_user`: the link (and Codex's code) are read; the person signs in at the provider
 *   (and, for Claude, pastes the code);
 * - `completing`: Claude's code was written to the CLI; it is checking it;
 * - `done`: the CLI exited successfully; the credential watcher saves the login;
 * - `failed` (with `reason`), `expired` (the 10-minute platform deadline; a provider's code may
 *   expire sooner), `cancelled`;
 * - `superseded`: a newer attempt for the service started, or this one was cancelled before it
 *   began;
 * - `none`: the supervisor knows no such attempt (for example after a restart).
 */
export const SignInState = z.enum([
  "starting",
  "awaiting_user",
  "completing",
  "done",
  "failed",
  "expired",
  "cancelled",
  "superseded",
  "none",
]);
export type SignInState = z.infer<typeof SignInState>;

/**
 * Why an attempt failed, as fixed reasons (the CLI's own text is never forwarded):
 * - `code_rejected`: Claude Code said the pasted code was not accepted;
 * - `denied`: Codex said the device sign-in failed (refused or not allowed at the provider);
 * - `network`: the CLI could not reach its provider;
 * - `unexpected_output`: the CLI printed something the parser does not know, or no valid link in
 *   time, or a link on another host;
 * - `cli_exited`: the CLI ended without a result the parser knows;
 * - `start_failed`: the CLI could not be started;
 * - `not_ready`: the computer's credentials are not installed yet (its restore runs).
 */
export const SignInFailure = z.enum([
  "code_rejected",
  "denied",
  "network",
  "unexpected_output",
  "cli_exited",
  "start_failed",
  "not_ready",
]);
export type SignInFailure = z.infer<typeof SignInFailure>;

/** A note while waiting: Claude Code said the pasted code was incomplete and still waits. */
export const SignInNotice = z.enum(["incomplete_code"]);

/** An attempt as the supervisor sees it. */
export const SignInView = z.strictObject({
  service: SignInService,
  attempt: SignInAttempt,
  state: SignInState,
  /** While `awaiting_user` or `completing`: the provider's link, checked (`signInLinkAllowed`). */
  url: SignInLink.optional(),
  /** Codex, while `awaiting_user`: the one-time code to enter on OpenAI's page. */
  userCode: SignInUserCode.optional(),
  reason: SignInFailure.optional(),
  notice: SignInNotice.optional(),
});
export type SignInView = z.infer<typeof SignInView>;

const signIn = { ...envelope, service: SignInService, attempt: SignInAttempt };

/**
 * Start attempt `attempt` for `service`: ends the service's running attempt first, then spawns
 * the CLI's login. Idempotent by attempt: a repeat answers the attempt's state; an attempt at or
 * below the fence that is not the running one is `superseded`. Answers at once with `starting`;
 * the link follows in `sign_in_status`. A supervisor with `terminal_sessions` ends every
 * setup-terminal session before it spawns a new attempt's CLI.
 */
export const SignInStartCommand = z.strictObject({ type: z.literal("sign_in_start"), ...signIn });

/**
 * Claude only: write `code` and a carriage return to the attempt's pty, while it is
 * `awaiting_user`. Idempotent by operation ID: a repeat never writes the code twice. The
 * supervisor never writes the code to a file or a log, nor keeps it after the write.
 */
export const SignInInputCommand = z.strictObject({
  type: z.literal("sign_in_input"),
  ...signIn,
  code: SignInCode,
});

/** End the attempt (and any older one) and raise the fence to it: kills and reaps the whole
 * process group. Idempotent. */
export const SignInCancelCommand = z.strictObject({ type: z.literal("sign_in_cancel"), ...signIn });

/** The attempt's state. Read-only. */
export const SignInStatusCommand = z.strictObject({ type: z.literal("sign_in_status"), ...signIn });

/** The supervisor's metrics for the setup page's status (WP3.23). Read-only. */
export const ComputerStatusCommand = z.strictObject({
  type: z.literal("computer_status"),
  ...envelope,
});

/**
 * Staging only: turn RC-53's save check on or off (`/var/cfo/rc53/enabled`). WorkspaceDO sends it
 * only on a staging installation, before captures, in every generation. Idempotent.
 */
export const StagingCheckCommand = z.strictObject({
  type: z.literal("staging_check"),
  ...envelope,
  rc53: z.boolean(),
});

/** A setup-terminal window's number: increasing per computer, never reused (WP3.5). */
export const TerminalWindowNumber = z.number().int().min(1).max(999_999_999);

/**
 * End the setup terminal's sessions on the computer for every window up to `window` (WP3.28,
 * `terminal_sessions`). WorkspaceDO records one, in the same storage transaction, whenever a
 * window closes or its stream ends for good (its deadline, a new window, a removal, a stop, a
 * sign-out, a page sign-in, the owner's close, a stream that ended) and sends it until answered.
 * A delayed one never reaches a newer window. Idempotent by operation ID; an ended session stays
 * ended. While a capture pauses the computer it is refused as `unavailable` (retryable).
 */
export const TerminalEndCommand = z.strictObject({
  type: z.literal("terminal_end"),
  ...envelope,
  window: TerminalWindowNumber,
});

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
  SignInStartCommand,
  SignInInputCommand,
  SignInCancelCommand,
  SignInStatusCommand,
  ComputerStatusCommand,
  StagingCheckCommand,
  TerminalEndCommand,
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

/** A CLI's version, normalized to its three numbers. */
export const CliVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/);

/**
 * The supervisor's alerts by kind (WP3.23): fixed names, counted. The alerts' own text can hold
 * exception names or paths, so it never leaves the computer.
 */
export const SupervisorAlertKind = z.enum([
  "command_failed",
  "restore_stripped",
  "restore_failed",
  "rc53_collect_failed",
  "rc53_finding",
  "capture_skipped_paths",
  "capture_resumed",
  "capture_journal_failed",
  "capture_no_result",
  "credential_refused",
  "credential_alert",
  "hello_unanswered",
  "report_failed",
  "sign_in_failed",
  "other",
]);
export type SupervisorAlertKind = z.infer<typeof SupervisorAlertKind>;

const StatusCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A capture's RC-53 result, counts only: never a value or a path. */
export const Rc53Counts = z.strictObject({
  /** 0: no finding; 1: a staged layer holds a live value; other: the scan was incomplete. */
  status: z.number().int().min(0).max(255),
  values: StatusCount,
  files: StatusCount,
  findings: StatusCount,
  incomplete: StatusCount,
});
export type Rc53Counts = z.infer<typeof Rc53Counts>;

/**
 * Whether the container's hostname resolves, which `sudo` needs (it warns "unable to resolve
 * host" otherwise): `resolved` or `unresolved` through the C library's lookup (WP3.27: NSS
 * `myhostname`, since Cloudflare's `/etc/hosts` is read-only), or `unknown`. `mapped` and
 * `unmapped` come from an older supervisor (WP3.22), which reported whether `/etc/hosts` maps the
 * name: an image without `myhostname` resolves it only then.
 */
export const HostnameState = z.enum(["resolved", "unresolved", "mapped", "unmapped", "unknown"]);
export type HostnameState = z.infer<typeof HostnameState>;

/**
 * A sign-in state as the status reports it: `SignInState`, or `unknown` when a newer supervisor
 * names a state this release does not know (WP3.29). Sign-in's own messages keep `SignInState`.
 */
export const StatusSignInState = z.enum([...SignInState.options, "unknown"]);
export type StatusSignInState = z.infer<typeof StatusSignInState>;

/**
 * An enum field of an informational reply, read tolerantly (WP3.29): a string this release does
 * not know becomes `fallback`, the field's "can't tell" value. Any other type, and a missing
 * field, are still refused. The exported JSON Schema shows the enum itself: what a parse yields.
 */
function tolerantEnum<E extends z.ZodEnum>(values: E, fallback: z.output<E>) {
  const known: ReadonlySet<unknown> = new Set(values.options);
  return z.preprocess((v) => (typeof v === "string" && !known.has(v) ? fallback : v), values);
}

/** Alerts by kind, one entry per kind: unknown kinds read as `other` are added together. */
function mergeAlerts<A extends { kind: string; count: number }>(alerts: A[]): A[] {
  const merged = new Map<string, A>();
  for (const alert of alerts) {
    const seen = merged.get(alert.kind);
    merged.set(
      alert.kind,
      seen === undefined
        ? alert
        : { ...seen, count: Math.min(seen.count + alert.count, Number.MAX_SAFE_INTEGER) },
    );
  }
  return [...merged.values()];
}

/**
 * The supervisor's part of the computer's status (WP3.23): names, normalized versions, enum
 * states and bounded counts only. No path under the CLIs' homes beyond the declared names, no
 * environment, no file contents, no alert text, no capture result whole.
 *
 * Read tolerantly (WP3.29). After a platform rollback, an older WorkspaceDO meets a newer
 * supervisor until that computer next stops. This reply is informational: it changes no state,
 * so refusing it whole for one name the reader does not know would only blank the status panel
 * and back off the status log. So a reader degrades instead of refusing:
 * - a field it does not know, at any depth, is dropped: never passed on, so no text from the
 *   computer leaves through one;
 * - a string it does not know in an enum field becomes that field's "can't tell" value:
 *   `unknown` for the logins, the sign-in states and the hostname, `other` for an alert's kind.
 * From this release on, a supervisor may add a status field or enum value, and an older reader
 * still parses its status; a newer reader parses an older supervisor's.
 *
 * Everything else stays strict: types, required fields, bounds and the versions' format. Removing
 * or retyping a field is still a breaking change. The exported JSON Schema shows what a parse
 * yields, which is exactly what a supervisor of this release sends: its own outbound check stays
 * strict. Commands, the other replies, reports, credentials, captures and sign-in stay strict
 * (`z.strictObject`): they carry or change state, and a receiver that does not understand a field
 * there must refuse the message rather than act without it.
 */
export const SupervisorStatus = z.object({
  supervisorVersion: z.string().min(1).max(64),
  versions: z.object({
    claude: CliVersion.nullable(),
    codex: CliVersion.nullable(),
    gh: CliVersion.nullable(),
  }),
  logins: z.object({
    claude: tolerantEnum(CliLoginStatus, "unknown"),
    codex: tolerantEnum(CliLoginStatus, "unknown"),
  }),
  signIn: z.object({
    claude: tolerantEnum(StatusSignInState, "unknown"),
    codex: tolerantEnum(StatusSignInState, "unknown"),
  }),
  /** RC-53's save check is on (`/var/cfo/rc53/enabled` exists). */
  rc53: z.boolean(),
  /** Whether the container's hostname resolves (`sudo` warns otherwise). */
  hostname: tolerantEnum(HostnameState, "unknown"),
  /** The home directory's filesystem. */
  disk: z.object({ totalBytes: StatusCount, freeBytes: StatusCount }).nullable(),
  alerts: z
    .array(z.object({ kind: tolerantEnum(SupervisorAlertKind, "other"), count: StatusCount }))
    .max(32)
    .overwrite(mergeAlerts),
  /** The latest captures' RC-53 counts, by capture operation, newest last. */
  captures: z
    .array(z.object({ jobOperationId: OperationId, rc53: z.object(Rc53Counts.shape) }))
    .max(8),
  /**
   * The setup terminal's sessions alive on the computer (WP3.28, `terminal_sessions`); absent
   * from an older supervisor, or when they could not be counted now.
   */
  terminals: StatusCount.optional(),
});
export type SupervisorStatus = z.infer<typeof SupervisorStatus>;

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
  z.strictObject({ type: z.literal("sign_in_start"), view: SignInView }),
  z.strictObject({ type: z.literal("sign_in_input"), view: SignInView }),
  z.strictObject({ type: z.literal("sign_in_cancel"), view: SignInView }),
  z.strictObject({ type: z.literal("sign_in_status"), view: SignInView }),
  /** Read tolerantly, as `SupervisorStatus` says: a field it does not know is dropped. */
  z.object({ type: z.literal("computer_status"), status: SupervisorStatus }),
  z.strictObject({ type: z.literal("staging_check"), rc53: z.boolean() }),
  /** The terminal sessions still alive, for later windows. */
  z.strictObject({ type: z.literal("terminal_end"), remaining: StatusCount }),
]);
export type WorkspaceCommandReply = z.infer<typeof WorkspaceCommandReply>;

// ---------------------------------------------------------------------------------------------

/**
 * How each message is safe to repeat:
 * - `per_generation`: one effect per generation; a repeat returns the same answer;
 * - `sequence`: ordered by `seq`; an already applied one is acknowledged and ignored;
 * - `order`: ordered by (`generation`, copy order); an older or equal one is `superseded`;
 * - `attempt`: one effect per start attempt; see `StartHostCommand` (and the sign-in fence, above);
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
  sign_in_start: { direction: "to_supervisor", idempotency: "attempt" },
  sign_in_input: { direction: "to_supervisor", idempotency: "operation_id" },
  sign_in_cancel: { direction: "to_supervisor", idempotency: "attempt" },
  sign_in_status: { direction: "to_supervisor", idempotency: "read_only" },
  computer_status: { direction: "to_supervisor", idempotency: "read_only" },
  staging_check: { direction: "to_supervisor", idempotency: "operation_id" },
  terminal_end: { direction: "to_supervisor", idempotency: "operation_id" },
} as const satisfies Record<
  SupervisorMessage["type"] | WorkspaceCommand["type"],
  {
    direction: "to_workspace" | "to_supervisor";
    idempotency: "per_generation" | "sequence" | "order" | "attempt" | "operation_id" | "read_only";
  }
>;
