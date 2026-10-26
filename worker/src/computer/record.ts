// Pure: what WorkspaceDO persists for its computer, and the storage interface it is kept in.
//
// One record holds the lifecycle and every job's progress, so a transition and the intents it
// creates are written together, in one synchronous transaction, before any effect runs (code-
// structure plan, Ordering). A new instance reads the record and carries on from the persisted
// phase (FH-36). The launch token is kept apart from the record, under its own key, only until the
// supervisor has it (design, Identity), so no dump of the record ever holds it.
//
// The record is parsed on every load. Fields added later must default, so state an older build
// stored still reads.

import {
  CheckpointId,
  CliLoginStatus,
  ComputerId,
  CredentialManifest,
  DeclaredCredentialPath,
  DirectoryBackupRecord,
  HostConfig,
  HostId,
  HostName,
  InstanceSize,
  LayerId,
  LifecycleState,
  OperationId,
  ProvisionName,
  ReservationPhase,
  Sha256Hex,
  SuspendRefusal,
  Timestamp,
  WorkspaceManifest,
} from "@cfo/contracts";
import { z } from "zod";

/**
 * A Durable Object's synchronous storage, as the controller uses it: JSON values by key, and a
 * transaction that either commits every write or none. WorkspaceDO implements it on its SQLite
 * storage; the tests on a map that can crash between any two steps.
 */
export interface Store {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  delete(key: string): void;
  /** Keys starting with `prefix`, in order; at most `limit` of them. */
  keys(prefix: string, limit?: number): readonly string[];
  transaction<T>(fn: () => T): T;
}

const Millis = z.number().int().min(0).max(8.64e15);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const StopReasonSchema = z.enum([
  "sleep",
  "restart",
  "removal",
  "without_saving",
  "start_deadline",
]);

const MachineContextSchema = z.strictObject({
  state: LifecycleState,
  claimed: z.boolean(),
  paramsStored: z.boolean(),
  stopPrep: StopReasonSchema.nullable(),
  removalIntent: z.boolean(),
  wakeQueued: z.boolean(),
  failedStart: z.boolean(),
  capturing: z.boolean(),
});

const SaveRequestSchema = z.strictObject({
  id: z.string().min(1).max(64),
  reason: z.enum(["turn_completed", "long_turn", "backstop", "retry", "sigterm"]),
  at: Millis,
});

const CaptureSchema = z.strictObject({
  generation: Count,
  op: OperationId,
  finishOp: OperationId,
  layerId: LayerId,
  kind: z.enum(["base", "delta"]),
  parent: z.strictObject({ checkpointId: CheckpointId, treeDigest: Sha256Hex }).nullable(),
  /** `save`: runs for save requests; `stop`: the sleep checkpoint of a stop being prepared. */
  purpose: z.enum(["save", "stop"]),
  /** The save requests accepted before it began: its cut follows them. */
  covers: z.array(z.string()),
  startedAt: Millis,
  phase: z.enum(["command", "poll", "upload", "publish", "finish"]),
  staged: z
    .strictObject({
      layerDir: z.string().min(1).max(4096),
      indexSha256: Sha256Hex,
      treeDigest: Sha256Hex,
      entries: Count,
      deleted: Count,
      bytes: Count,
      cutAt: Timestamp,
    })
    .nullable(),
  backup: DirectoryBackupRecord.nullable(),
  result: z.enum(["published", "discarded"]).nullable(),
  checkpointId: CheckpointId.nullable(),
  /** Why it failed after staging (the upload); its layer is then discarded. */
  failure: z.string().max(64).nullable(),
});
export type CaptureRecord = z.infer<typeof CaptureSchema>;

export const ComputerRecord = z.strictObject({
  schema: z.literal(1),
  computerId: ComputerId,
  /** `provision`'s name (`managed-<8 hex>`); null if the computer was never provisioned. */
  name: ProvisionName.nullable(),
  createdAt: Millis,

  lifecycle: z.strictObject({
    context: MachineContextSchema,
    generation: Count,
    attempt: Count,
  }),
  /** The highest generation ever asked of ControlDO: never reused. */
  lastReserved: Count,
  /** A reservation asked of ControlDO whose answer is not yet applied (a crash between). */
  reserving: z.strictObject({ generation: Count, operationId: OperationId }).nullable(),

  hostId: HostId.nullable(),
  hostName: HostName.nullable(),
  /** The current attempt's start parameters (the token is kept apart, under TOKEN_KEY). */
  params: z
    .strictObject({
      attempt: Count,
      hostId: HostId,
      hostName: HostName,
      hostConfig: HostConfig,
      /** Not yet answered by the supervisor; delivered once the restore is confirmed. */
      deliver: z.boolean(),
      deliverOp: OperationId,
    })
    .nullable(),

  size: InstanceSize,
  nextSize: InstanceSize.nullable(),
  /** The installation's largest size, as ControlDO last said. */
  maxSize: InstanceSize.nullable(),

  reservation: z
    .strictObject({ generation: Count, phase: ReservationPhase, fenced: z.boolean() })
    .nullable(),
  /** Slots to give back to ControlDO, retried until acknowledged (FH-37). */
  releases: z.array(z.strictObject({ generation: Count, operationId: OperationId })),

  /** The container start under way in `waking`, with its start-after-stop retries (DC-37). */
  start: z
    .strictObject({
      generation: Count,
      refusals: Count,
      /** When the next `start()` may be called. */
      nextAt: Millis,
      /** When `start()` was last called for this attempt; null before. */
      startedAt: Millis.nullable(),
    })
    .nullable(),
  /** Since when no host incarnation holds the running computer (the 300 s start deadline). */
  noHostSince: Millis.nullable(),

  restore: z
    .strictObject({
      generation: Count,
      /** The checkpoint being restored: protected from retention until confirmed. */
      manifest: WorkspaceManifest.nullable(),
      phase: z.enum(["layers", "merge", "credentials"]),
      nextLayer: Count,
      failures: Count,
      mergeOp: OperationId,
      installOp: OperationId,
    })
    .nullable(),
  /** The supervisor's last applied report, for the generation it came from. */
  report: z
    .strictObject({
      generation: Count,
      seq: Count,
      hostState: z.string().max(32),
      hostAttempt: Count.nullable(),
      runnerProcesses: Count,
      credentialsPending: z.array(DeclaredCredentialPath).max(16),
      logins: z.strictObject({ claude: CliLoginStatus, codex: CliLoginStatus }),
      at: Millis,
    })
    .nullable(),

  /** The last stop record: persisted before the stop, confirmed once the container stopped. */
  stop: z
    .strictObject({
      generation: Count,
      reason: z.string().max(32),
      at: Millis,
      confirmedAt: Millis.nullable(),
    })
    .nullable(),
  /** A stop being prepared: its checkpoints, then the final credential barrier (step 7). */
  stopJob: z
    .strictObject({
      generation: Count,
      reason: StopReasonSchema,
      phase: z.enum(["capture", "credentials", "wait"]),
      snapshotOp: OperationId,
      order: Count.nullable(),
      deadline: Millis.nullable(),
      failure: SuspendRefusal.nullable(),
    })
    .nullable(),

  capture: CaptureSchema.nullable(),
  saveRequests: z.array(SaveRequestSchema),
  /** The last save request of any kind; the backstop counts from it. */
  lastRequestAt: Millis.nullable(),
  captureFailures: Count,
  nextCaptureAt: Millis.nullable(),
  verified: z
    .strictObject({
      generation: Count,
      at: Millis,
      how: z.enum(["restore", "published", "unchanged"]),
    })
    .nullable(),
  unchanged: z
    .strictObject({
      generation: Count,
      parentCheckpointId: CheckpointId,
      cutAt: Timestamp,
      at: Millis,
    })
    .nullable(),
  notSaved: z.strictObject({ since: Millis, retries: Count, nextRetryAt: Millis }).nullable(),

  /** The workspace pointer: the latest published checkpoint. */
  workspace: WorkspaceManifest.nullable(),
  /** Layers no checkpoint may need any more, deleted once no retained one references them. */
  orphans: z.array(DirectoryBackupRecord),
  lastSavedAt: Timestamp.nullable(),
  workspaceBytes: Count.nullable(),

  /** The credential pointer. */
  credential: CredentialManifest.nullable(),
  /** The current generation's install: bundles at or below this order predate it. */
  credentialFloor: z.strictObject({ generation: Count, floor: Count }).nullable(),
  /** Bundle objects no longer the pointer, deleted from the bucket. */
  credentialDeletes: z.array(z.string().max(256)),
  /**
   * Bundles being stored: the key is persisted before the upload, so an object a crash leaves
   * behind is found and deleted, and a retry of the same bundle reuses its key.
   */
  credentialUploads: z
    .array(z.strictObject({ checkpointId: CheckpointId, generation: Count, order: Count }))
    .default([]),
  /**
   * Tombstones of abandoned uploads (Codex WP3.1 r2-1, r3): a write already issued may still land
   * after the key was deleted. `fencedAt`: when the key stopped being a pending upload, so the
   * backup gateway refuses it from then on; `at`: the next deletion. A tombstone is retired only
   * once the gateway's fence is enforced and its maximum request time has passed since
   * `fencedAt`; until then it is deleted again on a slow sweep.
   */
  credentialSweeps: z
    .array(z.strictObject({ key: z.string().max(256), fencedAt: Millis, at: Millis }))
    .default([]),
  /** A credential checkpoint has held a login at some time. */
  everHeldLogin: z.boolean(),

  signOut: z.strictObject({
    phase: z.enum(["none", "requested", "tombstoned", "verified"]),
    loginPossiblyLost: z.boolean(),
    revocationRecorded: z.boolean(),
    job: z
      .strictObject({
        generation: Count,
        phase: z.enum(["command", "snapshot", "wait", "verify"]),
        op: OperationId,
        snapshotOp: OperationId,
        order: Count.nullable(),
        deadline: Millis,
      })
      .nullable(),
  }),

  lastContactAt: Millis.nullable(),
  lastKeepAliveAt: Millis.nullable(),
  unexpectedStopAt: Millis.nullable(),
  restoredTo: Timestamp.nullable(),
  /** Sleeps refused in a row because their checkpoints failed (FH-35). */
  refusedSleeps: Count,
  /** When a stop's preparation last failed: a removal or deadline stop retries a heartbeat later. */
  stopRefusedAt: Millis.nullable().default(null),
  /** The setup terminal is open until then (WP3.5's terminal sets it). */
  terminalOpenUntil: Millis.nullable(),

  /** A resolved removal's deletions, in order. */
  deletion: z
    .strictObject({
      phase: z.enum(["layers", "credentials", "forget", "wipe"]),
      forgetOp: OperationId,
    })
    .nullable(),
});
export type ComputerRecord = z.infer<typeof ComputerRecord>;

export const RECORD_KEY = "computer";
/** `suspend` operations waiting on the sleep in progress (they share its outcome): `sleep:<id>`. */
export const SLEEP_PREFIX = "sleep:";
/** The current attempt's launch token, only until the supervisor has it. */
export const TOKEN_KEY = "launch-token";
/** Operation outcomes by operation ID, kept at least 7 days: `op:<kind>:<id>`. */
export const OPERATION_PREFIX = "op:";
/** The same operations by the time they began, for pruning: `opt:<16-digit ms>:<kind>:<id>`. */
export const OPERATION_TIME_PREFIX = "opt:";

export const TokenRecord = z.strictObject({ attempt: Count, token: z.string().min(1).max(512) });

/** An operation's journal entry: the request's fingerprint, and its outcome once settled. */
export const OperationRecord = z.strictObject({
  fingerprint: z.string().max(128),
  outcome: z.unknown().nullable(),
  at: Millis,
});
export type OperationRecord = z.infer<typeof OperationRecord>;

export function newRecord(computerId: ComputerId, now: number): ComputerRecord {
  return {
    schema: 1,
    computerId,
    name: null,
    createdAt: now,
    lifecycle: {
      context: {
        state: "provisioned",
        claimed: false,
        paramsStored: false,
        stopPrep: null,
        removalIntent: false,
        wakeQueued: false,
        failedStart: false,
        capturing: false,
      },
      generation: 0,
      attempt: 0,
    },
    lastReserved: 0,
    reserving: null,
    hostId: null,
    hostName: null,
    params: null,
    size: "standard-2",
    nextSize: null,
    maxSize: null,
    reservation: null,
    releases: [],
    start: null,
    noHostSince: null,
    restore: null,
    report: null,
    stop: null,
    stopJob: null,
    capture: null,
    saveRequests: [],
    lastRequestAt: null,
    captureFailures: 0,
    nextCaptureAt: null,
    verified: null,
    unchanged: null,
    notSaved: null,
    workspace: null,
    orphans: [],
    lastSavedAt: null,
    workspaceBytes: null,
    credential: null,
    credentialFloor: null,
    credentialDeletes: [],
    credentialUploads: [],
    credentialSweeps: [],
    everHeldLogin: false,
    signOut: { phase: "none", loginPossiblyLost: false, revocationRecorded: false, job: null },
    lastContactAt: null,
    lastKeepAliveAt: null,
    unexpectedStopAt: null,
    restoredTo: null,
    refusedSleeps: 0,
    stopRefusedAt: null,
    terminalOpenUntil: null,
    deletion: null,
  };
}
