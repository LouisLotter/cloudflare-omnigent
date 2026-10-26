import { z } from "zod";
import type { ErrorCode } from "./errors.ts";
import {
  AbsolutePath,
  ComputerId,
  Generation,
  HostId,
  LauncherOperationId,
  StartAttempt,
} from "./ids.ts";

// The launcher API: the Cloudflare launcher (Omnigent's `SandboxHostLauncher` in the server
// image, WP3.6) calls the platform Worker (WP3.3's `internal/platform-api.ts`) on
// `platform.internal`, and the Worker passes each call to the computer's WorkspaceDO (WP3.1).
// Its methods map one to one onto the launcher's, as core changes 13 and 15 built them in the
// fork (`cfo/integration` `35ac1ebd2`, `omnigent/onboarding/sandboxes/{base,types}.py`).

/** Launcher protocol versions this contract package understands. Version 1 is the first. */
export const LAUNCHER_PROTOCOL_VERSION = 1;
export const SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS = [1] as const;

/** Reachable only from the server container, through its intercept. */
export const PLATFORM_INTERNAL_HOST = "platform.internal";
/** Every operation is `POST <base>/<operation>`, the operation also named in the body. */
export const LAUNCHER_BASE_URL = `http://${PLATFORM_INTERNAL_HOST}/launcher`;

// ---------------------------------------------------------------------------------------------
// The HMAC envelope. The same envelope as core change 19's key service on the same host
// (`omnigent/stores/credential_store/http_cipher.py`, "HTTP key service" in the fork's
// `designs/CREDENTIAL_STORE.md`), with its own first line so a signature never verifies in the
// other protocol, even under a shared key.
//
// The string to sign is five lines joined by "\n", with no trailing newline:
//   cfo-launcher-v1
//   <operation, as in the path>
//   <signing key ID>
//   <timestamp, exactly as sent>
//   <lowercase hex SHA-256 of the exact body bytes>
// The signature is the lowercase hex HMAC-SHA256 of that string under the key. The launcher
// sends compact JSON with sorted keys; the Worker verifies the bytes it received before parsing
// them, and never re-serialises to verify.
//
// The Worker checks, in this order, before any effect (FH-28):
//   1. the three headers are present, the key ID is one it holds, and the signature matches,
//      compared in constant time (401 `unauthorized`); during a rotation it holds the current and
//      the previous key, told apart by ID;
//   2. the timestamp is within LAUNCHER_SIGNATURE_MAX_SKEW_S of its clock (401 `unauthorized`);
//   3. the path's operation equals the body's `operation`, and the body parses as a
//      `LauncherRequest` (400 `bad_request`);
//   4. the protocol version is supported (400 `unsupported_version`).
// A refused request is logged by path and status only.

export const LAUNCHER_SIGNING_PROTOCOL = "cfo-launcher-v1";
export const SIGNING_KEY_ID_HEADER = "X-Omnigent-Signing-Key-Id";
export const TIMESTAMP_HEADER = "X-Omnigent-Timestamp";
export const SIGNATURE_HEADER = "X-Omnigent-Signature";
/** The signing key is the UTF-8 bytes of a secret of at least this many bytes. */
export const MIN_SIGNING_KEY_BYTES = 32;
/** Bounds replay; the protocol has no nonce. Operation IDs make a replay return a record. */
export const LAUNCHER_SIGNATURE_MAX_SKEW_S = 300;
/** Larger bodies are refused before they are hashed. */
export const MAX_LAUNCHER_BODY_BYTES = 128 * 1024;

export const SigningKeyId = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
export type SigningKeyId = z.infer<typeof SigningKeyId>;

/** Unix seconds, in decimal, as the timestamp header carries them. */
export const SigningTimestamp = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);

export const LauncherSignature = z.string().regex(/^[0-9a-f]{64}$/);

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase hex SHA-256 of `body`. */
export async function sha256Hex(body: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>));
}

/** The canonical string a launcher request's signature covers. */
export function launcherStringToSign(input: {
  readonly operation: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly bodySha256: string;
}): string {
  return [
    LAUNCHER_SIGNING_PROTOCOL,
    input.operation,
    input.keyId,
    input.timestamp,
    input.bodySha256,
  ].join("\n");
}

/**
 * The reference signer: the three headers for one request. Used by the fake launcher client
 * and the test vectors; the Python launcher (WP3.6) must produce the same bytes.
 */
export async function signLauncherRequest(input: {
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly operation: string;
  readonly timestamp: number;
  readonly body: Uint8Array;
}): Promise<Record<string, string>> {
  if (input.key.byteLength < MIN_SIGNING_KEY_BYTES) {
    throw new Error(`a signing key needs at least ${MIN_SIGNING_KEY_BYTES} bytes`);
  }
  SigningKeyId.parse(input.keyId);
  const timestamp = String(input.timestamp);
  SigningTimestamp.parse(timestamp);
  const message = launcherStringToSign({
    operation: input.operation,
    keyId: input.keyId,
    timestamp,
    bodySha256: await sha256Hex(input.body),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    input.key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return {
    [SIGNING_KEY_ID_HEADER]: input.keyId,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
}

// ---------------------------------------------------------------------------------------------
// Types shared with Omnigent's launcher surface.

/**
 * The computer as Omnigent sees it (core change 13's `HostSandboxStatus`; the design's status
 * table, R-02). Derived from WorkspaceDO's lifecycle by `typedStatus` in `lifecycle.ts`.
 */
export const HostSandboxStatus = z.enum([
  "stopped",
  "started_no_host",
  "start_claimed",
  "host_running",
  "host_refused",
  "stopping",
]);
export type HostSandboxStatus = z.infer<typeof HostSandboxStatus>;

/** Typed admission reasons Omnigent knows (`ADMISSION_NOT_SAVED`, `ADMISSION_NEEDS_SIGN_IN`). */
export const AdmissionReason = z.enum(["not_saved", "needs_sign_in"]);
export type AdmissionReason = z.infer<typeof AdmissionReason>;

/** Core change 15's `CheckpointReason`. */
export const CheckpointReason = z.enum(["turn_completed", "long_turn"]);
export type CheckpointReason = z.infer<typeof CheckpointReason>;

/** Why WorkspaceDO refused a sleep before stopping anything (lifecycle step 7). */
export const SuspendRefusal = z.enum([
  "restoring",
  "capture_running",
  "terminal_open",
  "runner_processes",
  "checkpoint_failed",
  "credentials_unpublished",
]);
export type SuspendRefusal = z.infer<typeof SuspendRefusal>;

/** Why WorkspaceDO refused a `checkpoint` request: nothing new can be saved now. */
export const CheckpointRefusal = z.enum(["not_running", "restoring", "stopping"]);
export type CheckpointRefusal = z.infer<typeof CheckpointRefusal>;

/**
 * `provision`'s name: Omnigent (fork `cfo/integration` from `3228d4de3`) passes `managed-<the whole
 * host ID>`, 40 characters; computers first provisioned before that keep `managed-<8 hex>`.
 */
export const ProvisionName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/** A host display name, chosen by the person in Omnigent. Rendered as text only. */
export const HostName = z
  .string()
  .min(1)
  .max(128)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/**
 * A launch token as Omnigent mints it (`secrets.token_urlsafe(32)`). Login material: it is never
 * logged, never written to a checkpoint, and kept by WorkspaceDO only until the supervisor has it.
 */
export const LaunchToken = z.string().regex(/^[A-Za-z0-9_-]{32,512}$/);

/** Deployment-supplied `~/.omnigent/config.yaml` content, installed before the host starts. */
export const HostConfig = z
  .record(z.string(), z.unknown())
  .refine((config) => JSON.stringify(config).length <= 64 * 1024, {
    message: "host configuration larger than 64 KiB",
  });

// ---------------------------------------------------------------------------------------------
// Requests. Every request carries the protocol version and an operation ID. Unknown fields are
// refused: any change raises the protocol version, and the Worker supports the current and the
// previous version, so the server image and the Worker release separately (design, Upgrades).

const call = {
  protocolVersion: z.number().int().min(1),
  operationId: LauncherOperationId,
};
const onComputer = { ...call, computerId: ComputerId };

/** `prepare()`: the launcher's preflight. Read-only: checks the key and the protocol version. */
export const PrepareRequest = z.strictObject({ operation: z.literal("prepare"), ...call });

/** `provision(name)`: records a computer at the default size. Idempotent by `name`. */
export const ProvisionRequest = z.strictObject({
  operation: z.literal("provision"),
  ...call,
  name: ProvisionName,
});

/** `claim_start(sandbox_id, operation_id=)`: the fence before any re-arm (G1BR-005). */
export const ClaimStartRequest = z.strictObject({
  operation: z.literal("claim_start"),
  ...onComputer,
});

/**
 * `start_host(sandbox_id, token=, host_id=, host_name=, host_config=, start_attempt=)`.
 * Omnigent passes `repos=()` for persistent hosts, so none are sent. `server_url` is not sent
 * either: a computer always reaches the server at `http://omnigent.internal`, and the launcher
 * checks its registration says so. `host_config=None` is sent as `{}`.
 *
 * WorkspaceDO records the host ID at the first accepted start and answers `conflict` to a start
 * for any other host ID. New computers are named by the whole host ID (`ProvisionName`), but
 * computers named before that by `managed-<first 8 hex digits of the host ID>` keep that name, so
 * two hosts sharing those digits would otherwise share a computer and its logins.
 */
export const StartHostRequest = z.strictObject({
  operation: z.literal("start_host"),
  ...onComputer,
  startAttempt: StartAttempt,
  hostId: HostId,
  hostName: HostName,
  token: LaunchToken,
  hostConfig: HostConfig,
});

/** `resume(sandbox_id)`: starts the computer, or does nothing if it is already starting or up. */
export const ResumeRequest = z.strictObject({ operation: z.literal("resume"), ...onComputer });

/** `keep_alive(sandbox_id)`: renews the activity lease. */
export const KeepAliveRequest = z.strictObject({
  operation: z.literal("keep_alive"),
  ...onComputer,
});

/** `is_running(sandbox_id)`. Read-only. */
export const StatusRequest = z.strictObject({ operation: z.literal("status"), ...onComputer });

/** `admission(sandbox_id)`: the typed status and whether new work is admitted. Read-only. */
export const AdmissionRequest = z.strictObject({
  operation: z.literal("admission"),
  ...onComputer,
});

/** `checkpoint(sandbox_id, reason=)`: accepted once WorkspaceDO has persisted the request. */
export const CheckpointRequest = z.strictObject({
  operation: z.literal("checkpoint"),
  ...onComputer,
  reason: CheckpointReason,
});

/** `suspend(sandbox_id, operation_id=)`: starts the sleep, or reports how it went. */
export const SuspendRequest = z.strictObject({ operation: z.literal("suspend"), ...onComputer });

/** `terminate(sandbox_id)`: records a removal intent. Succeeds once the intent is durable. */
export const TerminateRequest = z.strictObject({
  operation: z.literal("terminate"),
  ...onComputer,
});

/** Every launcher API request, by `operation`. */
export const LauncherRequest = z.discriminatedUnion("operation", [
  PrepareRequest,
  ProvisionRequest,
  ClaimStartRequest,
  StartHostRequest,
  ResumeRequest,
  KeepAliveRequest,
  StatusRequest,
  AdmissionRequest,
  CheckpointRequest,
  SuspendRequest,
  TerminateRequest,
]);
export type LauncherRequest = z.infer<typeof LauncherRequest>;
export type LauncherOperation = LauncherRequest["operation"];

// ---------------------------------------------------------------------------------------------
// Results: HTTP 200 with one of these. Refusals that Omnigent's methods return as values are
// results; failures are an `ErrorBody` with the status in LAUNCHER_ERROR_STATUS.

export const PrepareResult = z.strictObject({
  operation: z.literal("prepare"),
  supportedProtocolVersions: z.array(z.number().int().min(1)).min(1),
});

export const ProvisionResult = z.strictObject({
  operation: z.literal("provision"),
  computerId: ComputerId,
});

/** Granted: attempt N is recorded and supersedes every earlier one. */
export const ClaimStartGranted = z.strictObject({
  operation: z.literal("claim_start"),
  granted: z.literal(true),
  startAttempt: StartAttempt,
});
/** Refused, with the status that refused it: `host_running`, `stopping` or `stopped`. */
export const ClaimStartRefused = z.strictObject({
  operation: z.literal("claim_start"),
  granted: z.literal(false),
  status: z.enum(["stopped", "host_running", "stopping"]),
});
export const ClaimStartResult = z.discriminatedUnion("granted", [
  ClaimStartGranted,
  ClaimStartRefused,
]);

/**
 * Accepted: the parameters are kept for this attempt and reach the supervisor once both restores
 * are confirmed. `workspacePath` is where the host starts the agent.
 */
export const StartHostResult = z.strictObject({
  operation: z.literal("start_host"),
  workspacePath: AbsolutePath,
});

/**
 * `starting`: a reservation was taken and a new generation's start began. `running`: the computer
 * was already starting or up, and nothing changed. `after_stop`: a stop is in progress; the
 * computer starts once it is confirmed stopped.
 */
export const ResumeResult = z.strictObject({
  operation: z.literal("resume"),
  outcome: z.enum(["starting", "running", "after_stop"]),
  generation: Generation,
});

/** `renewed: false` when the computer is not running: nothing was extended. */
export const KeepAliveResult = z.strictObject({
  operation: z.literal("keep_alive"),
  renewed: z.boolean(),
});

/** `running` is true while a container runs, `stopping` included. */
export const StatusResult = z.strictObject({
  operation: z.literal("status"),
  running: z.boolean(),
  status: HostSandboxStatus,
  generation: Generation,
});

/**
 * Omnigent's `AdmissionReport`. The launcher sets `observed_at` to the time it received this
 * reply (its own clock), and `generation` to its decimal string. `message` is person-readable
 * and only present with a reason.
 */
export const AdmissionResult = z.discriminatedUnion("admitting", [
  z.strictObject({
    operation: z.literal("admission"),
    admitting: z.literal(true),
    status: HostSandboxStatus,
    generation: Generation,
  }),
  z.strictObject({
    operation: z.literal("admission"),
    admitting: z.literal(false),
    reason: AdmissionReason,
    message: z.string().min(1).max(300).optional(),
    status: HostSandboxStatus,
    generation: Generation,
  }),
]);

/**
 * `accepted`: persisted, and run until a published or verified-unchanged save covers it;
 * `folded` when it joined a follow-up behind a running capture. `refused`: nothing new can be
 * saved now (the launcher raises an ordinary error, which Omnigent logs and does not retry).
 */
export const CheckpointAccepted = z.strictObject({
  operation: z.literal("checkpoint"),
  outcome: z.literal("accepted"),
  folded: z.boolean(),
});
export const CheckpointRefused = z.strictObject({
  operation: z.literal("checkpoint"),
  outcome: z.literal("refused"),
  reason: CheckpointRefusal,
});
export const CheckpointResult = z.discriminatedUnion("outcome", [
  CheckpointAccepted,
  CheckpointRefused,
]);

/**
 * The platform's side of `suspend`. `refused`: nothing was stopped, the computer keeps running.
 * `stopped`: confirmed stopped. `in_progress`: the sleep runs (it can take about 12 minutes);
 * the launcher repeats the same operation ID until it ends, and reports Omnigent's `unknown` if
 * its own deadline passes first. A lost or failed reply is `unknown` too. Never `unknown` here.
 */
export const SuspendRefused = z.strictObject({
  operation: z.literal("suspend"),
  outcome: z.literal("refused"),
  reason: SuspendRefusal,
});
export const SuspendStopped = z.strictObject({
  operation: z.literal("suspend"),
  outcome: z.literal("stopped"),
});
export const SuspendInProgress = z.strictObject({
  operation: z.literal("suspend"),
  outcome: z.literal("in_progress"),
});
export const SuspendResult = z.discriminatedUnion("outcome", [
  SuspendRefused,
  SuspendStopped,
  SuspendInProgress,
]);

/**
 * `pending`: the removal intent is durable; credentials are kept until the removal resolves.
 * `resolved`: removed. `absent`: no such computer, which Omnigent treats as success.
 */
export const TerminateResult = z.strictObject({
  operation: z.literal("terminate"),
  removal: z.enum(["pending", "resolved", "absent"]),
});

/** Every launcher API result, by `operation`. */
export const LauncherResult = z.discriminatedUnion("operation", [
  PrepareResult,
  ProvisionResult,
  ClaimStartResult,
  StartHostResult,
  ResumeResult,
  KeepAliveResult,
  StatusResult,
  AdmissionResult,
  CheckpointResult,
  SuspendResult,
  TerminateResult,
]);
export type LauncherResult = z.infer<typeof LauncherResult>;

// ---------------------------------------------------------------------------------------------
// The rules per operation, as data for the Worker (3.3), the controller (3.1), the launcher
// (3.6) and their tests.

/**
 * How a repeated call is safe:
 * - `operation_id`: the outcome is recorded under the operation ID (kept at least 7 days) and a
 *   repeat returns it, whatever happened since;
 * - `semantic`: repeating the call is harmless by its meaning (a second `resume` while up changes
 *   nothing; a second removal intent is the same intent; `provision` returns the computer
 *   already recorded for the name), so no record is needed;
 * - `read_only`: no effect.
 */
export type LauncherIdempotency = "operation_id" | "semantic" | "read_only";

export interface LauncherOperationRule {
  /** The `SandboxHostLauncher` method that makes this call. */
  readonly omnigentMethod: string;
  readonly idempotency: LauncherIdempotency;
  /** Whether Omnigent passes the operation ID (else the launcher mints one per call). */
  readonly operationIdFromOmnigent: boolean;
  /**
   * Whether the launcher waits for Litestream to replicate the database as it stood when the
   * call began, before sending it (the durability wait, R-23, FH-29).
   */
  readonly durabilityWait: boolean;
  /** Whether the call targets one computer, and so can answer `gone`. */
  readonly onComputer: boolean;
}

export const LAUNCHER_OPERATIONS: Readonly<Record<LauncherOperation, LauncherOperationRule>> = {
  prepare: {
    omnigentMethod: "prepare",
    idempotency: "read_only",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: false,
  },
  provision: {
    omnigentMethod: "provision",
    idempotency: "semantic",
    operationIdFromOmnigent: false,
    durabilityWait: true,
    onComputer: false,
  },
  claim_start: {
    omnigentMethod: "claim_start",
    idempotency: "operation_id",
    operationIdFromOmnigent: true,
    durabilityWait: false,
    onComputer: true,
  },
  start_host: {
    omnigentMethod: "start_host",
    idempotency: "operation_id",
    operationIdFromOmnigent: false,
    durabilityWait: true,
    onComputer: true,
  },
  resume: {
    omnigentMethod: "resume",
    idempotency: "semantic",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: true,
  },
  keep_alive: {
    omnigentMethod: "keep_alive",
    idempotency: "semantic",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: true,
  },
  status: {
    omnigentMethod: "is_running",
    idempotency: "read_only",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: true,
  },
  admission: {
    omnigentMethod: "admission",
    idempotency: "read_only",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: true,
  },
  checkpoint: {
    omnigentMethod: "checkpoint",
    idempotency: "operation_id",
    operationIdFromOmnigent: false,
    durabilityWait: false,
    onComputer: true,
  },
  suspend: {
    omnigentMethod: "suspend",
    idempotency: "operation_id",
    operationIdFromOmnigent: true,
    durabilityWait: true,
    onComputer: true,
  },
  terminate: {
    omnigentMethod: "terminate",
    idempotency: "semantic",
    operationIdFromOmnigent: false,
    durabilityWait: true,
    onComputer: true,
  },
};

/** The HTTP status of each error code on the launcher API. */
export const LAUNCHER_ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_request: 400,
  unsupported_version: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  stale_generation: 409,
  gone: 410,
  at_capacity: 429,
  internal: 500,
  unavailable: 503,
};

/**
 * What the Cloudflare launcher raises for an error reply, so Omnigent reacts as core change 13
 * expects:
 * - `sandbox_gone`: `SandboxGoneError`, only for `gone` (the computer was removed);
 * - `readable_refusal`: `click.ClickException` with the message, a final refusal Omnigent shows
 *   (for example "All computers are busy");
 * - `unknown_outcome`: any other exception, which Omnigent treats as a lost reply and retries
 *   within its deadline. Timeouts and connection failures are the same.
 */
export const LAUNCHER_ERROR_CLASS: Readonly<
  Record<ErrorCode, "sandbox_gone" | "readable_refusal" | "unknown_outcome">
> = {
  gone: "sandbox_gone",
  at_capacity: "readable_refusal",
  conflict: "readable_refusal",
  forbidden: "readable_refusal",
  bad_request: "readable_refusal",
  unsupported_version: "readable_refusal",
  unauthorized: "readable_refusal",
  not_found: "readable_refusal",
  stale_generation: "unknown_outcome",
  unavailable: "unknown_outcome",
  internal: "unknown_outcome",
};
