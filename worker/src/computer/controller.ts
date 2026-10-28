// WorkspaceDO's controller for one cloud computer (WP3.1), free of the Workers runtime, so the
// simulation can run it whole and crash it between any two steps. `WorkspaceDO.ts` is the thin
// Durable Object around it: storage, the alarm, the container port and the RPC surface.
//
// How it is built (code-structure plan, "Pure state machines inside thin DO classes"):
//   - Every event goes through 3.C's lifecycle table (`machine.ts`). The transition, and the
//     intents its effects create, are written in one synchronous storage transaction before any
//     effect runs (persist before effect).
//   - Intents are fields of the persisted record: a start to make, a restore to run, parameters to
//     deliver, a stop to prepare, a stop record, slots to release, save requests, a sign-out. A
//     single runner, `#reconcile`, reads the record and carries each intent forward with effects
//     that are safe to repeat (the computer API's commands are idempotent; ControlDO's calls carry
//     operation IDs), writing each outcome back with a re-check. A crash anywhere leaves the
//     record saying what is still to do, and the next instance does it (FH-36).
//   - Launcher calls, page actions and computer messages are serialized; long effects (restores,
//     uploads) never hold that lock, and never run inside `alarm()`: the alarm schedules the next
//     one, then kicks the runner and returns (CF-07).
//   - WorkspaceDO never stops a running computer on its own: only Omnigent's `suspend`, a removal,
//     the page's restart, "stop without saving" and the 300 s start deadline for a computer with no
//     host incarnation do (design, Lifecycle step 7).
//   - Sign-in from the page (WP3.23, `sign-in.ts`): fenced attempts persisted here, delivered and
//     cancelled by the runner, and a bounded sign-in lease that counts for sleep and the start
//     deadline as an open terminal does. The computer's status (`status.ts`) is composed here
//     from the supervisor's metrics and this record, and logged as `computer_status`.

import {
  CHECKPOINT_POLICY_V1,
  COMPUTER_START_ENV,
  CONTROL_INTERFACE_VERSION,
  ComputerCall,
  type ComputerId,
  type ComputerPageState,
  type ComputerStatusView,
  type ControlResult,
  CREDENTIAL_PROVIDER,
  CredentialBundle,
  type CredentialManifest,
  containerMayRun,
  credentialIsNewer,
  credentialObjectKey,
  deriveSetupCard,
  ErrorBody,
  type ErrorCode,
  InstanceSize,
  type InterceptProps,
  LAUNCHER_OPERATIONS,
  LauncherCall,
  type LauncherRequest,
  type LauncherResult,
  type LifecycleEvent,
  type PageSignInView,
  PagesCall,
  type PagesResult,
  type Reply,
  type ReservationState,
  ruleFor,
  SIGN_OUT_TABLE,
  type SignInRefusal,
  type SignInService,
  type SignInView,
  SUPERVISOR_API_PORT,
  SUPERVISOR_COMMANDS_PATH,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPPORTED_INTERCEPT_PROPS_VERSIONS,
  SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS,
  SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS,
  type SupervisorMessage,
  type SupervisorReply,
  type SupervisorReport,
  type SupervisorStatus,
  signOutSettled,
  TIMING,
  typedStatus,
  WORKSPACE_INTERFACE_VERSION,
  type WorkspaceCommand,
  WorkspaceCommandReply,
  workspaceBackupPrefix,
} from "@cfo/contracts";
import {
  type ComputerContainerPort,
  isConnectionLostError,
  isStartRefusedError,
} from "../shared/computer-port.ts";
import { errorCodeOf, platformError } from "../shared/errors.ts";
import {
  type ControlRpc,
  type WorkspaceIdentity,
  WriteCheck,
  type WriteDecision,
} from "../shared/rpc.ts";
import {
  bundleObject,
  credentialManifestOf,
  droppedLayers,
  holdsLogin,
  nextLayer,
  noDeclaredFile,
  notSavedDue,
  objectMatches,
  pauseLease,
  publish,
  RESTORE_ROOT,
  restoreDirs,
  retryDelayMs,
  type SaveRequest,
  signOutEventOf,
  uncovered,
  unreferenced,
} from "./checkpoints.ts";
import {
  admissionOf,
  backstopDue,
  closeNotSaved,
  INACTIVITY_TIMEOUT_MS,
  noContact,
  retriedNotSaved,
  sleepInputs,
} from "./idle.ts";
import {
  expectsContainer,
  type Facts,
  guardInputs,
  restored,
  statusOf,
  type Transition,
  transition,
  withoutHost,
  wouldReserve,
} from "./machine.ts";
import {
  type CaptureRecord,
  ComputerRecord,
  newRecord,
  OPERATION_PREFIX,
  OPERATION_TIME_PREFIX,
  OperationRecord,
  RECORD_KEY,
  SLEEP_PREFIX,
  type Store,
  TOKEN_KEY,
  TokenRecord,
} from "./record.ts";
import {
  fence,
  mayStart,
  releasing,
  reservationState,
  reserved,
  running,
  starting,
} from "./reservations.ts";
import {
  attemptOfOp,
  begin,
  callerRefusal,
  closeAll,
  endedState,
  endWithContainer,
  finalState,
  isActive,
  leaseActive,
  leaseUntil,
  pageView,
  SIGN_IN_CHECK_MS,
  SIGN_IN_DEADLINE_MS,
  type SignInAttemptRecord,
  sessionAttempts,
  signInAvailable,
  startRefusal,
  update,
} from "./sign-in.ts";
import { chooseSize, clampSize, sizeForStart, workspaceSizeWarning } from "./sizing.ts";
import {
  composeStatus,
  recordSave,
  STATUS_FRESH_MS,
  STATUS_INTERVAL_MS,
  saveView,
  statusLog,
  withRc53,
} from "./status.ts";
import { isTransientUploadError } from "./upload-errors.ts";

// ---------------------------------------------------------------------------------------------
// Dependencies.

/**
 * The checkpoint bucket's credential bundles (R2 in production). Reads, lists and deletes go to R2
 * directly; every put goes through the backup gateway's write fence (`egress/backups.ts`), named
 * by the generation whose upload it is, so the fence admits only this generation's pending keys.
 */
export interface CheckpointBucket {
  put(key: string, body: Uint8Array, writer: { readonly generation: number }): Promise<void>;
  /** The object's bytes, or null if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** Every key under `prefix` (all pages). */
  list(prefix: string): Promise<readonly string[]>;
}

/** One virtual host to intercept on the computer, with the handler bound to `props` (WP3.3). */
export interface InterceptTarget {
  readonly host: string;
  readonly target: Fetcher;
}

export interface ControllerTiming {
  readonly heartbeatMs: number;
  /** Polls while a start, a restore or a job is in progress. */
  readonly pollMs: number;
  readonly startRefusedAfterMs: number;
  readonly startRetryDelaysMs: readonly number[];
  readonly startDeadlineMs: number;
  readonly inactivityTimeoutMs: number;
  readonly uploadDeadlineMs: number;
  /**
   * After a transient upload failure (`isTransientUploadError`), the whole upload is repeated
   * after each of these delays in turn, within the same upload deadline (WP3.22).
   */
  readonly uploadRetryDelaysMs: readonly number[];
  /** One layer's restore; a transfer that stalls longer is given up and retried. */
  readonly restoreLayerDeadlineMs: number;
  /** A capture that has not ended after this is given up. */
  readonly captureDeadlineMs: number;
  readonly backstopMs: number;
  readonly notSavedMs: number;
  /** "Not saved" retries, and failed saves' retries: 1, 2, then every 5 minutes. */
  readonly retryMs: readonly number[];
  readonly noContactMs: number;
  /** How long a stop waits for its final credential checkpoint to be published. */
  readonly credentialBarrierMs: number;
  /** How long a sign-out run may take before it is given up. */
  readonly signOutMs: number;
  /** How often an abandoned upload's key is deleted again (its tombstone is kept for good). */
  readonly credentialSweepMs: number;
  readonly commandTimeoutMs: number;
  /** Repeats of a command after "Network connection lost." (S3): every command is safe to repeat. */
  readonly commandRetries: number;
  /** Consecutive transient restore failures before the restore counts as failed. */
  readonly restoreFailures: number;
  readonly operationRecordMs: number;
  /** A sign-in attempt's platform deadline, which bounds its lease (WP3.23). */
  readonly signInDeadlineMs?: number;
  /** How often the runner asks whether an active sign-in attempt has finished. */
  readonly signInCheckMs?: number;
  /** How often the status is read and logged while the computer runs. */
  readonly statusIntervalMs?: number;
}

export const CONTROLLER_TIMING: ControllerTiming = {
  heartbeatMs: TIMING.heartbeatS * 1000,
  pollMs: 2_000,
  startRefusedAfterMs: TIMING.startRefusedAfterS * 1000,
  startRetryDelaysMs: TIMING.startRetryDelaysS.map((s) => s * 1000),
  startDeadlineMs: TIMING.startDeadlineS * 1000,
  inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
  uploadDeadlineMs: TIMING.uploadDeadlineS * 1000,
  uploadRetryDelaysMs: [5_000, 15_000],
  restoreLayerDeadlineMs: 300_000,
  captureDeadlineMs: (TIMING.uploadDeadlineS + 300) * 1000,
  backstopMs: TIMING.backstopSaveS * 1000,
  notSavedMs: TIMING.notSavedS * 1000,
  retryMs: TIMING.notSavedRetryS.map((s) => s * 1000),
  noContactMs: TIMING.noContactS * 1000,
  credentialBarrierMs: 120_000,
  signOutMs: 300_000,
  credentialSweepMs: 6 * 3_600_000,
  commandTimeoutMs: 30_000,
  commandRetries: 3,
  restoreFailures: 5,
  operationRecordMs: TIMING.operationRecordS * 1000,
};

export interface ControllerDeps {
  readonly computerId: ComputerId;
  readonly store: Store;
  /** Null while no computer container is configured (before WP3.3 wires the real port). */
  readonly port: ComputerContainerPort | null;
  readonly control: ControlRpc;
  readonly bucket: CheckpointBucket | null;
  readonly clock: () => number;
  /** The Durable Object's alarm: one time, replaced by each `set`. */
  readonly alarm: { set(at: number): void | Promise<void>; clear(): void | Promise<void> };
  readonly newId: (prefix: "op" | "ckp" | "lyr") => string;
  /**
   * A deadline: its signal aborts after `ms` (the upload and command deadlines). `clear` cancels
   * it once the call ended, so no timer outlives its call and keeps the object in memory.
   */
  readonly deadline: (ms: number) => { readonly signal: AbortSignal; clear(): void };
  /** Waits `ms`, or rejects once `signal` aborts (an upload's retry delay). Real timers if absent. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The computer's intercepts for these props: `omnigent.internal`, `computer.internal` (3.3). */
  readonly intercepts: (props: InterceptProps) => readonly InterceptTarget[];
  readonly timing?: ControllerTiming;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * The setup terminal (WP3.5): ends every stream at once, synchronously, when a transition starts
   * a credential-sensitive step (a stop's checkpoints, "Stop without saving", a sign-out run), so
   * none of the step's commands runs while a stream is open. It must not call back into the
   * controller.
   */
  readonly terminal?: { closeNow(reason: string): void };
  /**
   * A staging installation (WP3.23): the page's RC-53 switch is offered and applied. Never true
   * on production: WorkspaceDO sets it only from the staging tool's variable.
   */
  readonly stagingChecks?: boolean;
}

/** The soonest the alarm is ever set after now. */
export const MIN_ALARM_MS = 1_000;
/** Save requests kept pending at most; any later save covers them all. */
export const MAX_PENDING_SAVES = 100;
/** Releases owed to ControlDO beyond which no new reservation is asked for (FH-37). */
export const MAX_PENDING_RELEASES = 20;

/** Where the host starts the agent: the policy's `work` root in the computer user's home. */
export const WORKSPACE_PATH = "/home/omnigent/work";
const SUPERVISOR_URL = `http://supervisor${SUPERVISOR_COMMANDS_PATH}`;
const POLICY = CHECKPOINT_POLICY_V1;
const INTERCEPT_PROPS_VERSION = Math.max(...SUPPORTED_INTERCEPT_PROPS_VERSIONS);

type Outcome = { readonly result: unknown } | { readonly error: ErrorCode };

/** What a transition may carry beyond the table's own inputs. */
interface Extra {
  readonly reservedGeneration?: number;
  readonly request?: SaveRequest;
  readonly params?: NonNullable<ComputerRecord["params"]>;
  readonly token?: string;
}

function describe(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => [key, stable(v)]),
    );
  }
  return value;
}

/**
 * A request's identity for the operation journal: the SHA-256 of its canonical JSON. Only the
 * digest is kept, so a `start_host`'s launch token is never stored with its outcome.
 */
export async function fingerprintOf(request: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(stable(request)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The table's reply of the kind a call expects; anything else is a broken table. */
function expectReply<K extends Reply["kind"]>(
  reply: Reply | undefined,
  kind: K,
): Extract<Reply, { kind: K }> {
  if (reply?.kind !== kind)
    throw platformError("internal", `the lifecycle table answered ${reply?.kind}`);
  return reply as Extract<Reply, { kind: K }>;
}

function checkInterface(version: number): void {
  if (version > WORKSPACE_INTERFACE_VERSION) {
    throw platformError("unsupported_version", `interface version ${version}`);
  }
}

/** Where a computer's credential bundles live (the prefix of `credentialObjectKey`, RC-25). */
function credentialPrefix(computerId: ComputerId): string {
  return `credentials/${computerId}/`;
}

function isMissingLayer(error: unknown): boolean {
  const message = describe(error).toLowerCase();
  return message.includes("backup_not_found") || message.includes("not found");
}

/** An upload retry's wait: resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const done = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", done);
      resolve();
    }, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function isNotRunning(error: unknown): boolean {
  return describe(error).toLowerCase().includes("not running");
}

// ---------------------------------------------------------------------------------------------

export class WorkspaceController {
  readonly #d: ControllerDeps;
  readonly #t: ControllerTiming;
  #serial: Promise<unknown> = Promise.resolve();
  #running: Promise<void> | null = null;
  #again = false;
  /** The intercept props this instance registered; null: none yet (re-register when running). */
  #propsKey: string | null = null;
  /** Renew the inactivity timeout at the next chance (every new instance, every alarm). */
  #renewTimeout = true;
  /** A queued wake that had to wait: retried no sooner than this, with backoff (in memory). */
  #wakeRetryAt = 0;
  #wakeDeferrals = 0;
  /** The layer restore in flight, aborted when its restore is abandoned (a stop, a removal). */
  #restoreAbort: AbortController | null = null;
  /** The supervisor's latest metrics (in memory only): the page's status and the logs. */
  #metrics: {
    readonly generation: number;
    readonly at: number;
    readonly status: SupervisorStatus;
  } | null = null;
  /** What was last logged as `computer_status`, and when. */
  #statusLogged: { readonly signature: string; readonly at: number } | null = null;

  constructor(deps: ControllerDeps) {
    this.#d = deps;
    this.#t = deps.timing ?? CONTROLLER_TIMING;
  }

  // -------------------------------------------------------------------------------------------
  // Storage.

  #now(): number {
    return this.#d.clock();
  }

  #log(event: string, fields: Readonly<Record<string, unknown>>): void {
    this.#d.log(event, { computerId: this.#d.computerId, ...fields });
  }

  #load(): ComputerRecord | null {
    const raw = this.#d.store.get(RECORD_KEY);
    return raw === undefined ? null : ComputerRecord.parse(raw);
  }

  /** One transaction: load, change, save. */
  #write<T>(fn: (d: ComputerRecord) => T): T {
    return this.#d.store.transaction(() => {
      const d = this.#load();
      if (d === null) throw platformError("not_found", "no such computer");
      const result = fn(d);
      // Checked before it is written: a record that would not read back is never stored.
      this.#d.store.put(RECORD_KEY, ComputerRecord.parse(d));
      return result;
    });
  }

  #exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#serial.then(fn, fn);
    this.#serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Drops the kept launch token; with `attempt`, only if it is that attempt's token. */
  #dropToken(attempt?: number): void {
    if (attempt !== undefined) {
      const kept = TokenRecord.safeParse(this.#d.store.get(TOKEN_KEY));
      if (!kept.success || kept.data.attempt !== attempt) return;
    }
    this.#d.store.delete(TOKEN_KEY);
  }

  /**
   * An upload that may still be in flight (in a reset instance, or one whose reply was lost). Its
   * key stops being a pending upload in this transaction: the fence, so the gateway admits no new
   * write to it. A write admitted earlier can still land, so it is deleted now and its tombstone
   * kept: late writes are cleaned up by the re-delete.
   */
  #abandonUpload(d: ComputerRecord, checkpointId: string): void {
    const key = credentialObjectKey(
      this.#d.computerId,
      checkpointId as CredentialManifest["checkpointId"],
    );
    const now = this.#now();
    d.credentialDeletes.push(key);
    d.credentialSweeps.push({ key, fencedAt: now, at: now + this.#t.credentialSweepMs });
  }

  /**
   * Deletes a tombstoned key whose sweep is due, and schedules the next deletion. A tombstone is
   * never retired in version 1: nothing establishes when an issued write has settled (Codex r4;
   * the lead's decision, 26 Oct). The cost is a few bytes per tombstone and one delete every
   * `credentialSweepMs`.
   */
  async #sweep(r: ComputerRecord): Promise<boolean> {
    const now = this.#now();
    const due = r.credentialSweeps.find((x) => x.at <= now);
    if (due === undefined || this.#d.bucket === null) return false;
    try {
      await this.#d.bucket.delete(due.key);
    } catch (error) {
      this.#log("bundle_delete_failed", { error: describe(error) });
      return false;
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        d.credentialSweeps = d.credentialSweeps.map((x) =>
          x.key === due.key ? { ...x, at: now + this.#t.credentialSweepMs } : x,
        );
      }),
    );
    return true;
  }

  /**
   * A fully removed computer's maintenance, every `credentialSweepMs` for the record's life: every
   * object still under its workspace and credential prefixes is deleted. The fence stops new
   * admissions; a write admitted before it can land later, and this sweep cleans it up
   * (the lead's decision, 26 Oct).
   */
  async #sweepRemoved(r: ComputerRecord): Promise<boolean> {
    const now = this.#now();
    const bucket = this.#d.bucket;
    if (bucket === null || r.prefixSweepAt === null || now < r.prefixSweepAt) return false;
    try {
      for (const prefix of [
        workspaceBackupPrefix(this.#d.computerId),
        credentialPrefix(this.#d.computerId),
      ]) {
        for (const key of await bucket.list(prefix)) await bucket.delete(key);
      }
    } catch (error) {
      this.#log("removed_sweep_failed", { error: describe(error) });
      return false;
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        d.prefixSweepAt = now + this.#t.credentialSweepMs;
      }),
    );
    return true;
  }

  // Operation journal (code-structure plan, Conventions: outcomes kept at least 7 days).

  #opKey(kind: string, id: string): string {
    return `${OPERATION_PREFIX}${kind}:${id}`;
  }

  /** The recorded entry for an operation, or undefined. Throws `conflict` for another request. */
  #opFind(kind: string, id: string, fingerprint: string): OperationRecord | undefined {
    const raw = this.#d.store.get(this.#opKey(kind, id));
    if (raw === undefined) return undefined;
    const entry = OperationRecord.parse(raw);
    if (entry.fingerprint !== fingerprint) {
      throw platformError("conflict", "operation ID reused for another request");
    }
    return entry;
  }

  /** Records an operation (in the caller's transaction); `null`: still in progress. */
  #opPut(kind: string, id: string, fingerprint: string, outcome: Outcome | null): void {
    const key = this.#opKey(kind, id);
    const existing = this.#d.store.get(key);
    const at = existing === undefined ? this.#now() : OperationRecord.parse(existing).at;
    this.#d.store.put(key, { fingerprint, outcome, at });
    if (existing === undefined) {
      const time = String(at).padStart(16, "0");
      this.#d.store.put(`${OPERATION_TIME_PREFIX}${time}:${kind}:${id}`, key);
    }
  }

  /** Settles an operation recorded in progress (a sleep's outcome). */
  #opSettle(kind: string, id: string, outcome: Outcome): void {
    const raw = this.#d.store.get(this.#opKey(kind, id));
    if (raw === undefined) return;
    const entry = OperationRecord.parse(raw);
    if (entry.outcome === null) this.#opPut(kind, id, entry.fingerprint, outcome);
  }

  /**
   * The launcher journal's `suspend` records, for the wipe to keep (in its transaction). A sleep
   * still recorded in progress can only have ended with the stop the removal confirmed: it is
   * settled as `stopped`.
   */
  #keepSleepOutcomes(): Set<string> {
    const kept = new Set<string>();
    for (const key of this.#d.store.keys(this.#opKey("launcher", ""))) {
      const entry = OperationRecord.safeParse(this.#d.store.get(key));
      if (!entry.success) continue;
      const outcome = entry.data.outcome as { result?: { operation?: unknown } } | null;
      if (outcome === null) {
        this.#d.store.put(key, {
          ...entry.data,
          outcome: { result: { operation: "suspend", outcome: "stopped" } },
        });
        kept.add(key);
      } else if (outcome.result?.operation === "suspend") {
        kept.add(key);
      }
    }
    return kept;
  }

  /** Forgets operations older than the retention, a bounded batch at a time. */
  #pruneOperations(): void {
    const cutoff = this.#now() - this.#t.operationRecordMs;
    const keys = this.#d.store.keys(OPERATION_TIME_PREFIX, 200);
    this.#d.store.transaction(() => {
      for (const key of keys) {
        const at = Number(key.slice(OPERATION_TIME_PREFIX.length).split(":")[0]);
        if (!(at < cutoff)) break;
        const target = this.#d.store.get(key);
        if (typeof target === "string") this.#d.store.delete(target);
        this.#d.store.delete(key);
      }
    });
  }

  static #unwrap(outcome: Outcome): LauncherResult {
    if ("error" in outcome) throw platformError(outcome.error, "recorded outcome");
    return outcome.result as LauncherResult;
  }

  // -------------------------------------------------------------------------------------------
  // Transitions.

  /**
   * One event through the table, with its bookkeeping, inside the caller's transaction. The
   * effects that need I/O are left as intents in the record for `#reconcile`.
   */
  #step(d: ComputerRecord, event: LifecycleEvent, facts: Facts, extra: Extra = {}): Transition {
    const before = d.lifecycle.context;
    const t = transition(d.lifecycle, event, guardInputs(facts), extra.reservedGeneration);
    d.lifecycle = {
      context: { ...t.lifecycle.context },
      generation: t.lifecycle.generation,
      attempt: t.lifecycle.attempt,
    };
    const after = d.lifecycle.context;
    const now = this.#now();
    const generation = d.lifecycle.generation;
    for (const effect of t.effects) {
      switch (effect) {
        case "reserve":
          d.reservation = reserved(generation);
          d.reserving = null;
          break;
        case "start_container": {
          const size = sizeForStart({ size: d.size, nextSize: d.nextSize }, d.maxSize);
          d.size = size.setting.size;
          d.nextSize = size.setting.nextSize;
          d.start = { generation, refusals: 0, nextAt: now, startedAt: null };
          d.noHostSince = now;
          d.verified = null;
          d.unchanged = null;
          d.notSaved = null;
          d.credentialFloor = null;
          d.captureFailures = 0;
          d.nextCaptureAt = null;
          break;
        }
        case "retry_start":
          if (d.start !== null) {
            const delays = this.#t.startRetryDelaysMs;
            const delay = delays[d.start.refusals] ?? delays[delays.length - 1] ?? 0;
            d.start = {
              ...d.start,
              refusals: d.start.refusals + 1,
              nextAt: now + delay,
              startedAt: null,
            };
          }
          break;
        case "fence_start":
          if (d.reservation !== null) d.reservation = fence(d.reservation);
          d.start = null;
          break;
        case "restore":
          d.start = null;
          if (d.reservation !== null && !d.reservation.fenced)
            d.reservation = running(d.reservation);
          d.restore = {
            generation,
            manifest: d.workspace,
            phase: "layers",
            nextLayer: 0,
            failures: 0,
            mergeOp: this.#d.newId("op"),
            installOp: this.#d.newId("op"),
          };
          break;
        case "record_attempt":
          d.params = null;
          this.#dropToken();
          break;
        case "keep_params":
          if (extra.params !== undefined && extra.token !== undefined) {
            d.params = extra.params;
            this.#d.store.put(TOKEN_KEY, { attempt: extra.params.attempt, token: extra.token });
          }
          break;
        case "deliver_params":
          if (d.params !== null) d.params = { ...d.params, deliver: true };
          break;
        case "record_host_refused":
          this.#log("host_refused", { generation, attempt: d.lifecycle.attempt });
          break;
        case "prepare_stop":
          this.#closeTerminal(d, "the computer is stopping");
          d.signIn = closeAll(d.signIn);
          d.stopJob = {
            generation,
            reason: after.stopPrep ?? "sleep",
            phase: "capture",
            snapshotOp: this.#d.newId("op"),
            order: null,
            deadline: null,
            failure: null,
          };
          break;
        case "prepare_credential_stop":
          this.#closeTerminal(d, "the computer is stopping without saving");
          d.signIn = closeAll(d.signIn);
          d.stopJob = {
            generation,
            reason: after.stopPrep ?? "without_saving",
            phase: "credentials",
            snapshotOp: this.#d.newId("op"),
            order: null,
            deadline: now + this.#t.credentialBarrierMs,
            failure: null,
          };
          break;
        case "record_stop_refusal": {
          const reason = d.stopJob?.failure ?? "checkpoint_failed";
          if (before.stopPrep === "sleep") d.refusedSleeps += 1;
          // Every sleep waiting on this stop (a sleep, or one that joined a restart) is refused.
          this.#settleSleeps({ operation: "suspend", outcome: "refused", reason });
          this.#log("stop_refused", { generation, stop: before.stopPrep, reason });
          d.stopJob = null;
          d.stopRefusedAt = now;
          break;
        }
        case "stop_container": {
          const reason =
            before.stopPrep ??
            (after.failedStart ? "failed_start" : after.removalIntent ? "removal" : "stop");
          d.stop = { generation, reason, at: now, confirmedAt: null };
          d.stopJob = null;
          if (d.reservation !== null) {
            const unstarted =
              d.reservation.phase === "reserved" || d.reservation.phase === "starting";
            d.reservation = releasing(unstarted ? fence(d.reservation) : d.reservation);
          }
          break;
        }
        case "confirm_stop":
          if (d.stop !== null && d.stop.confirmedAt === null)
            d.stop = { ...d.stop, confirmedAt: now };
          if (d.stop?.reason === "sleep") d.refusedSleeps = 0;
          break;
        case "release_reservation":
          if (d.reservation !== null) {
            d.releases.push({
              generation: d.reservation.generation,
              operationId: this.#d.newId("op"),
            });
            d.reservation = null;
          }
          break;
        case "record_unexpected_stop": {
          d.unexpectedStopAt = now;
          d.stop = { generation, reason: "unexpected", at: now, confirmedAt: now };
          const pending = d.report?.generation === generation ? d.report.credentialsPending : [];
          if (pending.length > 0) d.signOut = { ...d.signOut, loginPossiblyLost: true };
          this.#log("unexpected_stop", { generation, credentialsPending: pending.length });
          break;
        }
        case "record_start_failure":
          this.#log("start_failed", { generation, refusals: d.start?.refusals ?? null });
          break;
        case "record_removal_intent":
          d.signIn = closeAll(d.signIn);
          this.#log("removal_intent", { generation });
          break;
        case "accept_save_request":
        case "fold_save_request":
          if (extra.request !== undefined) {
            d.saveRequests.push(extra.request);
            d.lastRequestAt = now;
            // Only a bounded number are kept. Two obligations matter: one request the running
            // capture covers (re-run if it fails), and one it does not (the follow-up whose cut
            // must come later). So the oldest of whichever group has more than one goes (R-18).
            const running = new Set(d.capture?.covers ?? []);
            while (d.saveRequests.length > MAX_PENDING_SAVES) {
              const covered = d.saveRequests.filter((x) => running.has(x.id));
              const group =
                covered.length > 1 ? covered : d.saveRequests.filter((x) => !running.has(x.id));
              const drop = group[0];
              if (drop === undefined || group.length < 2) break;
              d.saveRequests.splice(d.saveRequests.indexOf(drop), 1);
            }
          }
          break;
        case "publish_credentials":
          break;
        case "run_sign_out":
          this.#closeTerminal(d, "a sign-out started");
          d.signIn = closeAll(d.signIn);
          d.signOut = {
            ...d.signOut,
            phase: SIGN_OUT_TABLE[d.signOut.phase].requested,
            job: {
              generation,
              phase: "command",
              op: this.#d.newId("op"),
              snapshotOp: this.#d.newId("op"),
              order: null,
              deadline: now + this.#t.signOutMs,
            },
          };
          break;
        case "delete_records":
          d.deletion = { phase: "layers", forgetOp: this.#d.newId("op") };
          break;
      }
    }
    if (after.state !== before.state) {
      if (before.state === "restoring") this.#restoreAbort?.abort(new Error("restore abandoned"));
      if (!containerMayRun(after.state) || after.state === "waking") this.#containerGone(d);
      else if (after.state === "host_running") d.noHostSince = null;
      else if (before.state === "host_running" && withoutHost(after.state)) d.noHostSince = now;
    }
    return t;
  }

  /** The setup terminal closes before a credential-sensitive step (WP3.5). */
  #closeTerminal(d: ComputerRecord, reason: string): void {
    d.terminalOpenUntil = null;
    this.#d.terminal?.closeNow(reason);
  }

  /** The container stopped, or a new generation starts: everything bound to the old one ends. */
  #containerGone(d: ComputerRecord): void {
    if (d.capture !== null) {
      if (d.capture.backup !== null && d.capture.result !== "published")
        d.orphans.push(d.capture.backup);
      d.capture = null;
    }
    d.restore = null;
    d.stopJob = null;
    d.params = null;
    this.#dropToken();
    if (d.signOut.job !== null) d.signOut = { ...d.signOut, job: null };
    d.notSaved = null;
    d.terminalOpenUntil = null;
    d.signIn = endWithContainer(d.signIn);
    if (d.lifecycle.context.state !== "waking") {
      d.start = null;
      d.noHostSince = null;
    }
    this.#settleSleeps({ operation: "suspend", outcome: "stopped" });
  }

  #settleSleeps(result: LauncherResult): void {
    for (const key of this.#d.store.keys(SLEEP_PREFIX)) {
      this.#opSettle("launcher", key.slice(SLEEP_PREFIX.length), { result });
      this.#d.store.delete(key);
    }
  }

  /**
   * An event that may take a new reservation: ControlDO is asked first, for a generation persisted
   * before the call, then the event is applied with or without `at_capacity`. A failed call
   * releases that generation (its reply may have been lost after a grant). Called serialized.
   */
  async #reserving(
    event: LifecycleEvent,
    facts: Facts,
    extra: Extra = {},
    unavailable: "throw" | "at_capacity" | "defer" = "throw",
    commit: (d: ComputerRecord, reply: Reply | undefined) => void = () => undefined,
  ): Promise<Reply | undefined | "deferred"> {
    const r = this.#require();
    const apply = (d: ComputerRecord, f: Facts, x: Extra) => {
      const t = this.#step(d, event, f, x);
      commit(d, t.reply);
      return t;
    };
    if (!wouldReserve(r.lifecycle, event, guardInputs(facts))) {
      return this.#write((d) => apply(d, facts, extra).reply);
    }
    // Slots owed back (a crash after a grant, a stopped generation) are returned before a new one
    // is asked for, so a wake never competes with this computer's own stale slots.
    const drained = await this.#drainReleases();
    // `defer`: a queued wake waits, rather than ask for a slot while one of this computer's own
    // stale slots may still hold capacity.
    if (unavailable === "defer" && !drained) return "deferred";
    if (this.#require().releases.length >= MAX_PENDING_RELEASES) {
      // ControlDO has not acknowledged earlier releases: ask for no new slot until it has.
      if (unavailable === "throw") {
        throw platformError(
          "unavailable",
          "the computer's capacity could not be checked; try again",
        );
      }
      return this.#write((d) => apply(d, { ...facts, atCapacity: true }, extra).reply);
    }
    const generation =
      Math.max(r.lifecycle.generation, r.lastReserved, this.#require().lastReserved) + 1;
    const operationId = this.#d.newId("op");
    this.#write((d) => {
      d.reserving = { generation, operationId };
      d.lastReserved = generation;
    });
    let result: ControlResult;
    try {
      result = await this.#d.control.control({
        method: "reserve",
        interfaceVersion: CONTROL_INTERFACE_VERSION,
        operationId,
        computerId: this.#d.computerId,
        generation,
      });
    } catch (error) {
      this.#write((d) => {
        d.reserving = null;
        d.releases.push({ generation, operationId: this.#d.newId("op") });
      });
      this.#log("reserve_failed", { generation, error: describe(error) });
      if (unavailable === "defer") return "deferred";
      if (unavailable === "throw") {
        throw platformError(
          "unavailable",
          "the computer's capacity could not be checked; try again",
        );
      }
      return this.#write((d) => apply(d, { ...facts, atCapacity: true }, extra).reply);
    }
    const granted = result.method === "reserve" && result.granted;
    // The size cap comes with the grant, so no second call can be lost before the start
    // (WP3.2 r1-1). An older ControlDO's grant has none: ask for the limits, and if they cannot
    // be confirmed, give the slot back rather than start above a cap nobody confirmed.
    // Checked: a size the contract does not know counts as no cap.
    const carried = result.method === "reserve" && result.granted ? result.maxInstanceSize : null;
    let cap: InstanceSize | null = InstanceSize.safeParse(carried).data ?? null;
    if (granted && cap === null) cap = await this.#confirmedCap();
    if (granted && cap === null) {
      this.#write((d) => {
        d.reserving = null;
        d.releases.push({ generation, operationId: this.#d.newId("op") });
      });
      this.#log("size_cap_unconfirmed", { generation });
      if (unavailable === "defer") return "deferred";
      if (unavailable === "throw") {
        throw platformError(
          "unavailable",
          "the installation's size limit could not be checked; try again",
        );
      }
      return this.#write((d) => apply(d, { ...facts, atCapacity: true }, extra).reply);
    }
    return this.#write((d) => {
      d.reserving = null;
      if (!granted) return apply(d, { ...facts, atCapacity: true }, extra).reply;
      // Persisted with the transition, before `start_container` sizes the start.
      d.maxSize = cap;
      d.maxSizeGeneration = generation;
      const t = apply(d, facts, { ...extra, reservedGeneration: generation });
      if (!t.effects.includes("reserve")) {
        d.releases.push({ generation, operationId: this.#d.newId("op") });
      }
      return t.reply;
    });
  }

  /** Gives owed slots back to ControlDO, in order, until one fails; true if none is left. */
  async #drainReleases(): Promise<boolean> {
    for (const release of this.#require().releases) {
      try {
        await this.#d.control.control({
          method: "release",
          interfaceVersion: CONTROL_INTERFACE_VERSION,
          operationId: release.operationId,
          computerId: this.#d.computerId,
          generation: release.generation,
        });
      } catch (error) {
        this.#log("release_failed", { generation: release.generation, error: describe(error) });
        return false;
      }
      this.#write((d) => {
        d.releases = d.releases.filter((x) => x.operationId !== release.operationId);
      });
    }
    return true;
  }

  /**
   * The installation's size cap from ControlDO's `limits`, or null if it cannot be read within a
   * command's deadline (a reply that never comes must not hold the runner or a launcher call;
   * a late one is ignored).
   */
  async #confirmedCap(): Promise<InstanceSize | null> {
    const deadline = this.#d.deadline(this.#t.commandTimeoutMs);
    const expired = new Promise<"expired">((resolve) => {
      if (deadline.signal.aborted) resolve("expired");
      deadline.signal.addEventListener("abort", () => resolve("expired"), { once: true });
    });
    try {
      const limits = await Promise.race([
        this.#d.control.control({ method: "limits", interfaceVersion: CONTROL_INTERFACE_VERSION }),
        expired,
      ]);
      if (limits === "expired") {
        this.#log("limits_failed", { error: "no answer within the deadline" });
        return null;
      }
      if (limits.method === "limits") {
        const size = InstanceSize.safeParse(limits.maxInstanceSize);
        if (size.success) return size.data;
      }
      this.#log("limits_failed", { error: "an answer that is not the limits" });
    } catch (error) {
      this.#log("limits_failed", { error: describe(error) });
    } finally {
      deadline.clear();
    }
    return null;
  }

  #require(): ComputerRecord {
    const r = this.#load();
    if (r === null) throw platformError("not_found", "no such computer");
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // Instance lifecycle.

  /** Every new instance: re-arm the inactivity timeout and intercepts, and carry on (FH-36). */
  async boot(): Promise<void> {
    await this.#exclusive(() => {
      this.#migrateLegacy();
      const r = this.#load();
      if (r === null) return;
      if (r.reserving !== null) {
        const pending = r.reserving;
        this.#write((d) => {
          d.reserving = null;
          d.releases.push({ generation: pending.generation, operationId: this.#d.newId("op") });
        });
      }
      if (r.credentialUploads.length > 0) {
        // No upload is in flight in a new instance: what the old one left is deleted.
        this.#write((d) => {
          for (const u of d.credentialUploads) this.#abandonUpload(d, u.checkpointId);
          d.credentialUploads = [];
        });
      }
      this.#renewTimeout = true;
      this.#propsKey = null;
    });
    this.#kick();
  }

  /** Records from before sleeps were kept as keys (`sleepOps`, until `db7fffe`) are converted. */
  #migrateLegacy(): void {
    const raw = this.#d.store.get(RECORD_KEY);
    if (raw === null || typeof raw !== "object" || !("sleepOps" in raw)) return;
    const { sleepOps, ...rest } = raw as { sleepOps: unknown } & Record<string, unknown>;
    this.#d.store.transaction(() => {
      for (const id of Array.isArray(sleepOps) ? sleepOps : []) {
        if (typeof id === "string") this.#d.store.put(`${SLEEP_PREFIX}${id}`, true);
      }
      this.#d.store.put(RECORD_KEY, ComputerRecord.parse(rest));
    });
  }

  /** The heartbeat alarm: schedules the next one first, then starts the runner and returns. */
  async alarm(): Promise<void> {
    await this.#exclusive(async () => {
      await this.#schedule();
      this.#pruneOperations();
      // Time-driven events and the inactivity timeout never wait behind the runner, which may be
      // busy with a long restore or upload: the deadlines hold whatever it is doing.
      this.#timeEvents();
      await this.#schedule();
    });
    await this.#renewInactivity();
    this.#kick();
  }

  /** Renews the inactivity timeout 45 minutes ahead while a container should run. */
  async #renewInactivity(): Promise<void> {
    const r = this.#load();
    const port = this.#d.port;
    if (r === null || port === null || !port.running) return;
    const state = r.lifecycle.context.state;
    if (!containerMayRun(state) || state === "waking") return;
    try {
      await port.setInactivityTimeout(this.#t.inactivityTimeoutMs);
      this.#renewTimeout = false;
    } catch (error) {
      this.#log("inactivity_timeout_failed", { error: describe(error) });
      this.#renewTimeout = true;
    }
  }

  /** Resolves once no call is queued and the runner has nothing left to do now (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 10_000; i += 1) {
      await this.#serial;
      const runner = this.#running;
      if (runner === null) return;
      await runner;
    }
  }

  /** The setup terminal (WP3.5) is open until `until`, or closed. */
  async setTerminal(open: boolean, until?: number): Promise<void> {
    await this.#exclusive(() =>
      this.#write((d) => {
        d.terminalOpenUntil = open ? (until ?? this.#now() + 30 * 60_000) : null;
      }),
    );
    this.#kick();
  }

  // -------------------------------------------------------------------------------------------
  // The launcher API (from `internal/platform-api.ts`, after the HMAC and schema checks).

  async launcher(raw: unknown): Promise<LauncherResult> {
    const parsed = LauncherCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a LauncherCall");
    checkInterface(parsed.data.interfaceVersion);
    const request = parsed.data.request;
    if (
      !(SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS as readonly number[]).includes(request.protocolVersion)
    ) {
      throw platformError("unsupported_version", `launcher protocol ${request.protocolVersion}`);
    }
    if ("computerId" in request && request.computerId !== this.#d.computerId) {
      throw platformError("bad_request", "a call for another computer");
    }
    const byId = LAUNCHER_OPERATIONS[request.operation].idempotency === "operation_id";
    const fingerprint = byId ? await fingerprintOf(request) : null;
    try {
      return await this.#exclusive(() => this.#launcherCall(request, fingerprint));
    } finally {
      this.#kick();
    }
  }

  async #launcherCall(
    request: LauncherRequest,
    fingerprint: string | null,
  ): Promise<LauncherResult> {
    if (request.operation === "prepare") {
      return {
        operation: "prepare",
        supportedProtocolVersions: [...SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS],
      };
    }
    if (request.operation === "provision") return this.#provision(request.name);
    const r = this.#load();
    if (r === null) {
      if (request.operation === "terminate") return { operation: "terminate", removal: "absent" };
      throw platformError("not_found", "no such computer");
    }
    this.#write((d) => {
      d.lastContactAt = this.#now();
    });
    if (fingerprint !== null) {
      const prior = this.#opFind("launcher", request.operationId, fingerprint);
      if (prior !== undefined) {
        if (prior.outcome !== null) return WorkspaceController.#unwrap(prior.outcome as Outcome);
        return { operation: "suspend", outcome: "in_progress" };
      }
    }
    switch (request.operation) {
      case "resume": {
        // Never deferred: only a queued wake defers.
        const reply = (await this.#reserving("resume", {})) as Reply | undefined;
        if (reply?.kind === "error") throw this.#replyError(reply.code);
        const resumed = expectReply(reply, "resume");
        return {
          operation: "resume",
          outcome: resumed.outcome,
          generation: this.#require().lifecycle.generation,
        };
      }
      case "claim_start":
        return this.#recorded(request.operationId, fingerprint, (d) => {
          const reply = this.#step(d, "claim_start", {}).reply;
          if (reply?.kind === "error") return { error: reply.code };
          return {
            result: expectReply(reply, "claim").granted
              ? { operation: "claim_start", granted: true, startAttempt: d.lifecycle.attempt }
              : {
                  operation: "claim_start",
                  granted: false,
                  status: typedStatus(d.lifecycle.context) as
                    | "stopped"
                    | "host_running"
                    | "stopping",
                },
          };
        });
      case "start_host":
        return this.#recorded(request.operationId, fingerprint, (d) => {
          if (d.hostId !== null && request.hostId !== d.hostId) return { error: "conflict" };
          const params = {
            attempt: request.startAttempt,
            hostId: request.hostId,
            hostName: request.hostName,
            hostConfig: request.hostConfig,
            deliver: false,
            deliverOp: this.#d.newId("op"),
          };
          const t = this.#step(
            d,
            "start_host",
            { attemptCurrent: request.startAttempt === d.lifecycle.attempt },
            { params, token: request.token },
          );
          if (t.reply?.kind === "error") return { error: t.reply.code };
          d.hostId = request.hostId;
          d.hostName = request.hostName;
          return { result: { operation: "start_host", workspacePath: WORKSPACE_PATH } };
        });
      case "checkpoint":
        return this.#recorded(request.operationId, fingerprint, (d) => {
          const save: SaveRequest = {
            id: request.operationId,
            reason: request.reason,
            at: this.#now(),
          };
          const reply = this.#step(d, "checkpoint", {}, { request: save }).reply;
          if (reply?.kind === "error") return { error: reply.code };
          if (reply?.kind === "checkpoint_refused") {
            return {
              result: { operation: "checkpoint", outcome: "refused", reason: reply.reason },
            };
          }
          const accepted = expectReply(reply, "checkpoint");
          return {
            result: { operation: "checkpoint", outcome: "accepted", folded: accepted.folded },
          };
        });
      case "suspend":
        return this.#suspend(request.operationId, fingerprint as string);
      case "terminate": {
        const reply = this.#write((d) => this.#step(d, "terminate", {}).reply);
        return { operation: "terminate", removal: expectReply(reply, "terminate").removal };
      }
      case "keep_alive": {
        const now = this.#now();
        const live = this.#write((d) => {
          d.lastKeepAliveAt = now;
          return typedStatus(d.lifecycle.context) !== "stopped";
        });
        return { operation: "keep_alive", renewed: live };
      }
      case "status": {
        if (r.lifecycle.context.removalIntent)
          throw platformError("gone", "this computer was removed");
        const status = statusOf(r.lifecycle);
        return { operation: "status", ...status, generation: r.lifecycle.generation };
      }
      case "admission": {
        if (r.lifecycle.context.removalIntent)
          throw platformError("gone", "this computer was removed");
        const admission = admissionOf(r.notSaved);
        const base = {
          operation: "admission" as const,
          status: statusOf(r.lifecycle).status,
          generation: r.lifecycle.generation,
        };
        return admission.admitting
          ? { ...base, admitting: true }
          : { ...base, admitting: false, reason: admission.reason, message: admission.message };
      }
    }
  }

  #replyError(code: "gone" | "at_capacity" | "conflict"): Error {
    const messages = {
      gone: "This computer was removed.",
      at_capacity:
        "All computers are busy: the installation's limit of awake computers is reached.",
      conflict: "This start does not belong to the computer's current start attempt.",
    } as const;
    return platformError(code, messages[code]);
  }

  /** A journaled launcher operation: its outcome and its transition in one transaction. */
  #recorded(
    operationId: string,
    fingerprint: string | null,
    fn: (d: ComputerRecord) => Outcome,
  ): LauncherResult {
    const outcome = this.#write((d) => {
      const result = fn(d);
      if (fingerprint !== null) this.#opPut("launcher", operationId, fingerprint, result);
      return result;
    });
    if ("error" in outcome)
      throw this.#replyError(outcome.error as "gone" | "at_capacity" | "conflict");
    return outcome.result as LauncherResult;
  }

  #provision(name: string): LauncherResult {
    const now = this.#now();
    this.#d.store.transaction(() => {
      const existing = this.#load();
      if (existing === null) {
        this.#d.store.put(
          RECORD_KEY,
          ComputerRecord.parse({ ...newRecord(this.#d.computerId, now), name, lastContactAt: now }),
        );
        return;
      }
      if (existing.lifecycle.context.removalIntent)
        throw platformError("gone", "this computer was removed");
      if (existing.name !== null && existing.name !== name) {
        throw platformError("conflict", "this computer was provisioned under another name");
      }
      this.#d.store.put(RECORD_KEY, { ...existing, name, lastContactAt: now });
    });
    return { operation: "provision", computerId: this.#d.computerId };
  }

  /**
   * `suspend` (Lifecycle step 7): refused while a capture runs, with the setup terminal open or
   * with a live runner process (checked through the supervisor now, falling back to its last
   * report; unknown counts as live), else the sleep is prepared and reported in progress. A
   * repeat with the same operation ID returns the recorded outcome, or `in_progress` meanwhile.
   * With a removal intent a new `suspend` is `gone` (410), never `stopped` (3.C, as 3.6 expects).
   */
  async #suspend(operationId: string, fingerprint: string): Promise<LauncherResult> {
    const r = this.#require();
    const ctx = r.lifecycle.context;
    const now = this.#now();
    // A sign-in attempt holds the computer awake as an open terminal does (WP3.23), and is
    // reported to Omnigent as the same refusal: the setup page is in use.
    const terminalOpen =
      (r.terminalOpenUntil !== null && r.terminalOpenUntil > now) ||
      leaseActive(r.signIn, r.lifecycle.generation, now);
    // Only the supervisor's answer now can show no runner exists (Lifecycle step 7). If it cannot
    // answer, a cached positive count still refuses, but a cached zero proves nothing: unknown.
    const cached = this.#currentReport(r)?.runnerProcesses ?? null;
    let runners: number | null = cached !== null && cached > 0 ? cached : null;
    if (
      restored(ctx.state) &&
      ctx.stopPrep === null &&
      !ctx.capturing &&
      !terminalOpen &&
      !ctx.removalIntent
    ) {
      const fresh = await this.#freshReport(r);
      if (fresh !== null) runners = fresh.runnerProcesses;
    }
    const inputs = sleepInputs({ terminalOpen, runnerProcesses: runners });
    const answer = this.#write((d): LauncherResult | "gone" => {
      const reply = this.#step(d, "suspend", {
        terminalOpen: inputs.includes("terminal_open"),
        runnerProcesses: inputs.includes("runner_processes"),
      }).reply;
      let result: LauncherResult;
      if (reply?.kind === "error") {
        // A removal intent: `gone` (410), recorded so a repeat gets the same answer (3.C, 3.6).
        this.#opPut("launcher", operationId, fingerprint, { error: reply.code });
        return "gone";
      }
      if (reply?.kind === "suspend_refused") {
        result = { operation: "suspend", outcome: "refused", reason: reply.reason };
      } else if (reply?.kind === "suspend" && reply.outcome === "in_progress") {
        this.#d.store.put(`${SLEEP_PREFIX}${operationId}`, true);
        this.#opPut("launcher", operationId, fingerprint, null);
        return { operation: "suspend", outcome: "in_progress" } as LauncherResult;
      } else {
        result = { operation: "suspend", outcome: "stopped" };
      }
      this.#opPut("launcher", operationId, fingerprint, { result });
      return result;
    });
    if (answer === "gone") throw this.#replyError("gone");
    return answer;
  }

  #currentReport(r: ComputerRecord): NonNullable<ComputerRecord["report"]> | null {
    return r.report !== null && r.report.generation === r.lifecycle.generation ? r.report : null;
  }

  /** Asks the supervisor for its report now; null if it cannot answer. */
  async #freshReport(r: ComputerRecord): Promise<SupervisorReport | null> {
    try {
      const reply = await this.#command({
        type: "status",
        ...this.#envelope(r, this.#d.newId("op")),
      });
      this.#write((d) => {
        this.#applyReport(d, r.lifecycle.generation, reply.report);
      });
      return reply.report;
    } catch (error) {
      this.#log("status_failed", { error: describe(error) });
      return null;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The computer API (from `internal/computer-api.ts`, with the intercept's trusted props).

  async computer(raw: unknown): Promise<SupervisorReply> {
    const parsed = ComputerCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a ComputerCall");
    checkInterface(parsed.data.interfaceVersion);
    const { props, message } = parsed.data;
    if (props.propsVersion > INTERCEPT_PROPS_VERSION) {
      throw platformError("unsupported_version", `intercept props version ${props.propsVersion}`);
    }
    if (
      props.computerId !== this.#d.computerId ||
      message.computerId !== props.computerId ||
      message.generation !== props.generation
    ) {
      throw platformError("stale_generation", "another computer or another generation");
    }
    if (
      !(SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS as readonly number[]).includes(
        message.protocolVersion,
      )
    ) {
      throw platformError("unsupported_version", `supervisor protocol ${message.protocolVersion}`);
    }
    try {
      return await this.#exclusive(() => this.#computerCall(props.generation, message));
    } finally {
      this.#kick();
    }
  }

  async #computerCall(generation: number, message: SupervisorMessage): Promise<SupervisorReply> {
    const r = this.#load();
    const live =
      r !== null &&
      generation === r.lifecycle.generation &&
      containerMayRun(r.lifecycle.context.state) &&
      !(r.reservation !== null && r.reservation.generation === generation && r.reservation.fenced);
    if (!live || r === null)
      throw platformError("stale_generation", "not this computer's current generation");
    switch (message.type) {
      case "hello":
        // What it can do (WP3.23): an older supervisor names no features, and the page then
        // offers the terminal for signing in.
        this.#write((d) => {
          d.supervisorInfo = {
            generation,
            version: message.supervisorVersion,
            features: [...(message.features ?? [])],
          };
        });
        return { type: "hello", protocolVersion: SUPERVISOR_PROTOCOL_VERSION };
      case "report": {
        const applied = this.#write((d) => {
          this.#applyReport(d, generation, message.report);
          return d.report?.seq ?? message.report.seq;
        });
        return { type: "report", appliedSeq: applied };
      }
      case "credential_checkpoint":
        return this.#credentialCheckpoint(message.bundle);
      case "save_request": {
        const fingerprint = await fingerprintOf(message);
        const prior = this.#opFind("save", message.operationId, fingerprint);
        if (prior?.outcome) return prior.outcome as SupervisorReply;
        return this.#write((d) => {
          const request: SaveRequest = {
            id: message.operationId,
            reason: "sigterm",
            at: this.#now(),
          };
          const reply = this.#step(d, "checkpoint", {}, { request }).reply;
          const outcome: SupervisorReply = {
            type: "save_request",
            outcome: reply?.kind === "checkpoint" ? "accepted" : "refused",
          };
          this.#opPut("save", message.operationId, fingerprint, outcome as unknown as Outcome);
          return outcome;
        });
      }
    }
  }

  /** Applies a report if it is newer than the last for its generation (state, not events). */
  #applyReport(d: ComputerRecord, generation: number, report: SupervisorReport): void {
    if (generation !== d.lifecycle.generation) return;
    if (d.report !== null && d.report.generation === generation && report.seq <= d.report.seq)
      return;
    d.report = {
      generation,
      seq: report.seq,
      hostState: report.host.state,
      hostAttempt: report.host.startAttempt,
      runnerProcesses: report.runnerProcesses,
      credentialsPending: [...report.credentialsPending],
      logins: { ...report.logins },
      at: this.#now(),
    };
    // Only a report naming the current, handed-out attempt as refused counts (G1BR-005).
    if (
      report.host.state === "refused" &&
      report.host.startAttempt === d.lifecycle.attempt &&
      d.lifecycle.context.state === "host_running"
    ) {
      this.#step(d, "host_refused_reported", {});
    }
  }

  /**
   * A credential checkpoint (R-18): published only where the table allows (never before the
   * generation's restore is confirmed, R-19), only if newer than the pointer and above the
   * install's order floor; the bundle is stored first, then the pointer switches with a re-check.
   * A repeat of the published bundle gets the same answer.
   */
  async #credentialCheckpoint(bundle: CredentialBundle): Promise<SupervisorReply> {
    const r = this.#require();
    const allowed = (record: ComputerRecord) =>
      ruleFor(record.lifecycle.context, "credential_checkpoint").effects?.includes(
        "publish_credentials",
      ) ?? false;
    if (!allowed(r)) {
      throw platformError(
        "conflict",
        `no credential checkpoint while ${r.lifecycle.context.state}`,
      );
    }
    const superseded: SupervisorReply = {
      type: "credential_checkpoint",
      outcome: "superseded",
      checkpointId: null,
    };
    const pointer = r.credential;
    if (
      pointer !== null &&
      pointer.generation === bundle.generation &&
      pointer.order === bundle.order
    ) {
      return {
        type: "credential_checkpoint",
        outcome: "published",
        checkpointId: pointer.checkpointId,
      };
    }
    const floor = r.credentialFloor;
    if (floor !== null && floor.generation === bundle.generation && bundle.order <= floor.floor) {
      return superseded;
    }
    if (!credentialIsNewer(bundle, pointer)) return superseded;
    const bucket = this.#d.bucket;
    if (bucket === null) throw platformError("unavailable", "no checkpoint bucket");
    // The object's key is persisted before the upload: a crash after it leaves a key that is found
    // and deleted, and a retry of the same bundle overwrites the same object. Uploads of other
    // bundles are not in flight (this path holds the lock), so they are queued for deletion.
    const same = (u: { readonly generation: number; readonly order: number }) =>
      u.generation === bundle.generation && u.order === bundle.order;
    const checkpointId = this.#write((d) => {
      for (const u of d.credentialUploads.filter((x) => !same(x))) {
        this.#abandonUpload(d, u.checkpointId);
      }
      const pending = d.credentialUploads.find(same);
      d.credentialUploads = pending === undefined ? [] : [pending];
      if (pending !== undefined) return pending.checkpointId;
      const id = this.#d.newId("ckp") as CredentialManifest["checkpointId"];
      d.credentialUploads.push({
        checkpointId: id,
        generation: bundle.generation,
        order: bundle.order,
      });
      return id;
    });
    const object = bundleObject(bundle);
    const manifest = await credentialManifestOf({ bundle, checkpointId, object, now: this.#now() });
    try {
      await bucket.put(manifest.object.key, object, { generation: bundle.generation });
    } catch (error) {
      this.#log("credential_store_failed", { error: describe(error) });
      throw platformError("unavailable", "the credential checkpoint could not be stored; retry");
    }
    return this.#write((d) => {
      d.credentialUploads = d.credentialUploads.filter((u) => u.checkpointId !== checkpointId);
      if (!allowed(d) || !credentialIsNewer(bundle, d.credential)) {
        d.credentialDeletes.push(manifest.object.key);
        return superseded;
      }
      if (d.credential !== null) d.credentialDeletes.push(d.credential.object.key);
      d.credential = manifest;
      if (holdsLogin(manifest.files)) d.everHeldLogin = true;
      d.signOut = {
        ...d.signOut,
        phase: SIGN_OUT_TABLE[d.signOut.phase][signOutEventOf(manifest.files)],
      };
      this.#step(d, "credential_checkpoint", {});
      this.#log("credentials_published", { generation: bundle.generation, order: bundle.order });
      return { type: "credential_checkpoint", outcome: "published", checkpointId };
    });
  }

  // -------------------------------------------------------------------------------------------
  // The pages (WP3.5's narrow interface; never the launcher's operations).

  async pages(raw: unknown): Promise<PagesResult> {
    const parsed = PagesCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a PagesCall");
    checkInterface(parsed.data.interfaceVersion);
    const call = parsed.data;
    if (call.action === "state") {
      return this.#exclusive(() => ({
        action: "state" as const,
        computer: this.#pageState(this.#require()),
      }));
    }
    const { interfaceVersion: _, ...identity } = call;
    const fingerprint = await fingerprintOf(identity);
    try {
      return await this.#exclusive(async () => {
        this.#require();
        const prior = this.#opFind("page", call.operationId, fingerprint);
        if (prior?.outcome) return prior.outcome as PagesResult;
        // The action and its recorded outcome commit together, so a repeat after a crash returns
        // the outcome instead of acting again, perhaps on a later generation.
        return this.#pageAction(call, (result) =>
          this.#opPut("page", call.operationId, fingerprint, result as unknown as Outcome),
        );
      });
    } finally {
      this.#kick();
    }
  }

  /** One page action; `record` journals its outcome inside the action's own transaction. */
  async #pageAction(
    call: Exclude<PagesCall, { action: "state" }>,
    record: (result: PagesResult) => void,
  ): Promise<PagesResult> {
    const outcome = (
      action: "restart" | "stop_without_saving" | "sign_out" | "resolve_removal",
      reply: Reply | undefined,
    ): PagesResult =>
      reply?.kind === "page_refused"
        ? { action, outcome: "refused", reason: reply.reason }
        : { action, outcome: "accepted" };
    const act = (fn: (d: ComputerRecord) => PagesResult): PagesResult =>
      this.#write((d) => {
        const result = fn(d);
        record(result);
        return result;
      });
    switch (call.action) {
      case "set_size":
        return act((d) => {
          d.nextSize = chooseSize({ size: d.size, nextSize: d.nextSize }, call.size).nextSize;
          return { action: "set_size", appliesAt: "next_start" };
        });
      case "restart":
        return act((d) => outcome("restart", this.#step(d, "restart", {}).reply));
      case "stop_without_saving":
        return act((d) =>
          outcome(
            "stop_without_saving",
            this.#step(d, "stop_without_saving", {
              sleepsRefusedThrice: d.refusedSleeps >= TIMING.refusedSleepsBeforeStopWithoutSaving,
            }).reply,
          ),
        );
      case "sign_out": {
        let result: PagesResult | null = null;
        await this.#reserving("sign_out_run", {}, {}, "throw", (d, reply) => {
          if (reply?.kind === "page") {
            d.signOut = { ...d.signOut, phase: SIGN_OUT_TABLE[d.signOut.phase].requested };
          }
          result = outcome("sign_out", reply);
          record(result);
        });
        if (result === null) throw platformError("internal", "sign_out");
        return result;
      }
      case "record_revocation":
        return act((d) => {
          d.signOut = { ...d.signOut, revocationRecorded: true };
          return { action: "record_revocation", recorded: true };
        });
      case "resolve_removal":
        return act((d) =>
          outcome(
            "resolve_removal",
            this.#step(d, "removal_resolved", {
              signOutSettled: signOutSettled({
                phase: d.signOut.phase,
                neverHeldLogin: !d.everHeldLogin,
                loginPossiblyLost: d.signOut.loginPossiblyLost,
                revocationRecorded: d.signOut.revocationRecorded,
              }),
            }).reply,
          ),
        );
    }
  }

  #pageState(r: ComputerRecord): ComputerPageState {
    const now = this.#now();
    const ctx = r.lifecycle.context;
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const report = this.#currentReport(r);
    const live = containerMayRun(ctx.state) && ctx.state !== "waking" && report !== null;
    const cards = (["claude", "codex"] as const).map((provider) =>
      deriveSetupCard({
        provider,
        manifest: r.credential,
        pending:
          live &&
          (report?.credentialsPending ?? []).some((path) => CREDENTIAL_PROVIDER[path] === provider),
        cli: live && report !== null ? report.logins[provider] : "unknown",
      }),
    );
    const verified =
      r.verified !== null && r.verified.generation === r.lifecycle.generation
        ? r.verified.at
        : null;
    return {
      computerId: r.computerId,
      hostName: r.hostName,
      hostId: r.hostId,
      size: r.size,
      nextSize: r.nextSize,
      lifecycle: ctx.state,
      status: typedStatus(ctx),
      generation: r.lifecycle.generation,
      admission:
        r.notSaved === null ? { admitting: true } : { admitting: false, reason: "not_saved" },
      saving: ctx.capturing || r.saveRequests.length > 0 || r.capture !== null,
      lastSavedAt: r.lastSavedAt,
      verifiedAt: iso(verified),
      workspaceBytes: r.workspaceBytes,
      lastContactAt: iso(r.lastContactAt),
      lastKeepAliveAt: iso(r.lastKeepAliveAt),
      restoredTo: r.restoredTo,
      unexpectedStopAt: iso(r.unexpectedStopAt),
      refusedSleeps: r.refusedSleeps,
      setupCards: cards,
      removal: {
        state: ctx.state === "removed" ? "resolved" : ctx.removalIntent ? "pending" : "none",
        signOut: r.signOut.phase,
        loginPossiblyLost: r.signOut.loginPossiblyLost,
        revocationRecorded: r.signOut.revocationRecorded,
        // Additive (WP3.5): the rule `resolve_removal` applies, so the page offers it exactly then.
        settled: signOutSettled({
          phase: r.signOut.phase,
          neverHeldLogin: !r.everHeldLogin,
          loginPossiblyLost: r.signOut.loginPossiblyLost,
          revocationRecorded: r.signOut.revocationRecorded,
        }),
        // Additive (WP3.5): a sign-out job runs now, whatever its persisted phase.
        signOutRunning: r.signOut.job !== null,
      },
      // Additive fields (the schema is loose): the page's notices.
      noContact: !ctx.removalIntent && noContact(r.lastContactAt, now, this.#t.noContactMs),
      sizeWarning: workspaceSizeWarning(r.workspaceBytes),
      stopWithoutSavingOffered: r.refusedSleeps >= TIMING.refusedSleepsBeforeStopWithoutSaving,
      // Additive (WP3.23).
      signIn: { available: signInAvailable(r.supervisorInfo, r.lifecycle.generation) },
      stagingChecks: this.#d.stagingChecks === true,
      lastSave: r.saves[0] === undefined ? null : saveView(r.saves[0]),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in from the page, the computer's status and the staging switch (WP3.23), behind the page
  // front (`page-front.ts`), which has checked the owner's request-intent token for every change.

  #signInFacts(r: ComputerRecord) {
    const ctx = r.lifecycle.context;
    return {
      removal: ctx.removalIntent || ctx.state === "removed",
      running: restored(ctx.state),
      busy: ctx.stopPrep !== null || ctx.state === "stopping" || r.signOut.job !== null,
      available: signInAvailable(r.supervisorInfo, r.lifecycle.generation),
    };
  }

  /**
   * Starts a sign-in attempt for the session (persisted first: its number, binding and lease),
   * then delivers it now; the runner delivers it later if this delivery gets no answer. A
   * repeated operation ID returns the same attempt.
   */
  async signInStart(input: {
    readonly service: SignInService;
    readonly session: string;
    readonly operationId: string;
  }): Promise<
    | { readonly outcome: "accepted"; readonly view: PageSignInView }
    | { readonly outcome: "refused"; readonly reason: SignInRefusal }
  > {
    const now = this.#now();
    const admitted = await this.#exclusive(() =>
      this.#write((d): SignInAttemptRecord | SignInRefusal => {
        const known = attemptOfOp(d.signIn, input.operationId);
        if (known !== undefined) return known;
        const refusal = startRefusal(this.#signInFacts(d));
        if (refusal !== null) return refusal;
        const started = begin(d.signIn, {
          service: input.service,
          generation: d.lifecycle.generation,
          session: input.session,
          op: input.operationId,
          now,
          deadlineMs: this.#t.signInDeadlineMs ?? SIGN_IN_DEADLINE_MS,
        });
        d.signIn = started.record;
        this.#log("sign_in_started", { service: input.service, attempt: started.attempt.attempt });
        return started.attempt;
      }),
    );
    try {
      if (typeof admitted === "string") return { outcome: "refused", reason: admitted };
      if (admitted.session !== input.session) return { outcome: "refused", reason: "not_yours" };
      const r = this.#require();
      const ended = endedState(admitted, r.lifecycle.generation, now);
      if (ended !== null || admitted.delivered) {
        return { outcome: "accepted", view: pageView(admitted, null, ended ?? "starting") };
      }
      const delivered = await this.#deliverStart(r, admitted);
      if (delivered === "unsupported") return { outcome: "refused", reason: "unsupported" };
      return { outcome: "accepted", view: pageView(admitted, delivered, null) };
    } finally {
      this.#kick();
    }
  }

  /**
   * The start of `a`, to the supervisor. Its answer is recorded (delivered; finished if final).
   * An older supervisor refuses the command: it is recorded as lacking sign-in, so the page
   * offers the terminal. Null: no answer now (the runner tries again).
   */
  async #deliverStart(
    r: ComputerRecord,
    a: SignInAttemptRecord,
  ): Promise<SignInView | "unsupported" | null> {
    let view: SignInView;
    try {
      const reply = await this.#command({
        type: "sign_in_start",
        ...this.#envelope(r, this.#d.newId("op")),
        service: a.service,
        attempt: a.attempt,
      });
      view = reply.view;
    } catch (error) {
      if (errorCodeOf(error) !== "bad_request") {
        this.#log("sign_in_unanswered", { service: a.service, attempt: a.attempt });
        return null;
      }
      await this.#exclusive(() =>
        this.#write((d) => {
          d.signIn = update(d.signIn, a.attempt, (x) => ({ ...x, ended: "finished" }));
          d.supervisorInfo = {
            generation: a.generation,
            version: d.supervisorInfo?.version ?? "unknown",
            features: [],
          };
        }),
      );
      this.#log("sign_in_unsupported", { service: a.service });
      return "unsupported";
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        d.signIn = update(d.signIn, a.attempt, (x) => ({
          ...x,
          delivered: true,
          ended: x.ended === null && finalState(view.state) ? "finished" : x.ended,
        }));
      }),
    );
    return view;
  }

  /** Claude's pasted code, relayed now to the attempt's CLI. Never persisted or logged. */
  async signInInput(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly code: string;
    readonly session: string;
    readonly operationId: string;
  }): Promise<
    | { readonly outcome: "accepted"; readonly view: PageSignInView }
    | { readonly outcome: "refused"; readonly reason: SignInRefusal }
  > {
    const r = this.#require();
    const a = r.signIn.attempts.find((x) => x.attempt === input.attempt);
    const refusal = callerRefusal(a, {
      service: input.service,
      session: input.session,
      generation: r.lifecycle.generation,
      now: this.#now(),
    });
    if (refusal !== null || a === undefined)
      return { outcome: "refused", reason: refusal ?? "stale" };
    if (input.service !== "claude" || !a.delivered) return { outcome: "refused", reason: "stale" };
    try {
      const reply = await this.#command({
        type: "sign_in_input",
        ...this.#envelope(r, input.operationId),
        service: input.service,
        attempt: input.attempt,
        code: input.code,
      });
      return { outcome: "accepted", view: pageView(a, reply.view, null) };
    } catch (error) {
      // `conflict`: the attempt is no longer waiting for a code (it ended, or was replaced).
      return {
        outcome: "refused",
        reason: errorCodeOf(error) === "conflict" ? "stale" : "unreachable",
      };
    }
  }

  /** Ends the session's attempt: recorded first, so a start not yet delivered never is. */
  async signInCancel(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly session: string;
  }): Promise<
    | { readonly outcome: "accepted"; readonly view: PageSignInView }
    | { readonly outcome: "refused"; readonly reason: SignInRefusal }
  > {
    const now = this.#now();
    const ended = await this.#exclusive(() =>
      this.#write((d): SignInAttemptRecord | SignInRefusal => {
        const a = d.signIn.attempts.find((x) => x.attempt === input.attempt);
        if (a === undefined || a.service !== input.service) return "stale";
        if (a.session !== input.session) return "not_yours";
        if (a.ended !== null) return a;
        const cancelled = { ...a, ended: "cancelled" as const, cancel: "pending" as const };
        d.signIn = update(d.signIn, a.attempt, () => cancelled);
        this.#log("sign_in_cancelled", { service: a.service, attempt: a.attempt });
        return cancelled;
      }),
    );
    try {
      if (typeof ended === "string") return { outcome: "refused", reason: ended };
      const r = this.#require();
      if (ended.cancel === "pending") await this.#deliverCancel(r, ended);
      return {
        outcome: "accepted",
        view: pageView(ended, null, endedState(ended, r.lifecycle.generation, now) ?? "cancelled"),
      };
    } finally {
      this.#kick();
    }
  }

  /** An attempt's cancel, to the supervisor; true once answered (or nothing is left to cancel). */
  async #deliverCancel(r: ComputerRecord, a: SignInAttemptRecord): Promise<boolean> {
    if (a.generation === r.lifecycle.generation && restored(r.lifecycle.context.state)) {
      try {
        await this.#command({
          type: "sign_in_cancel",
          ...this.#envelope(r, this.#d.newId("op")),
          service: a.service,
          attempt: a.attempt,
        });
      } catch (error) {
        // An older supervisor has no such command, and so no attempt to cancel.
        if (errorCodeOf(error) !== "bad_request") {
          this.#log("sign_in_cancel_unanswered", { service: a.service, attempt: a.attempt });
          return false;
        }
      }
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        d.signIn = update(d.signIn, a.attempt, (x) =>
          x.cancel === "pending" ? { ...x, cancel: "done" } : x,
        );
      }),
    );
    return true;
  }

  /** An attempt's state now, for the session that started it. Changes nothing. */
  async signInStatus(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly session: string;
  }): Promise<
    | { readonly outcome: "accepted"; readonly view: PageSignInView }
    | { readonly outcome: "refused"; readonly reason: SignInRefusal }
  > {
    const r = this.#require();
    const now = this.#now();
    const a = r.signIn.attempts.find((x) => x.attempt === input.attempt);
    if (a === undefined || a.service !== input.service)
      return { outcome: "refused", reason: "stale" };
    if (a.session !== input.session) return { outcome: "refused", reason: "not_yours" };
    const ended = endedState(a, r.lifecycle.generation, now);
    if (ended !== null || !a.delivered) {
      return { outcome: "accepted", view: pageView(a, null, ended ?? "starting") };
    }
    try {
      const reply = await this.#command({
        type: "sign_in_status",
        ...this.#envelope(r, this.#d.newId("op")),
        service: a.service,
        attempt: a.attempt,
      });
      return { outcome: "accepted", view: pageView(a, reply.view, null) };
    } catch {
      return { outcome: "refused", reason: "unreachable" };
    }
  }

  /** The session's attempts still active (the page resumes them after a reload). */
  sessionAttempts(
    session: string,
  ): { readonly service: SignInService; readonly attempt: number }[] {
    const r = this.#load();
    return r === null
      ? []
      : sessionAttempts(r.signIn, session, r.lifecycle.generation, this.#now());
  }

  /** Whether a sign-in cancel is still owed to the running generation's supervisor. */
  #cancelsPending(r: ComputerRecord): boolean {
    return r.signIn.attempts.some(
      (a) => a.cancel === "pending" && a.generation === r.lifecycle.generation,
    );
  }

  /** The runner's part: cancels, expiries, undelivered starts, and finished attempts. */
  async #advanceSignIns(r: ComputerRecord): Promise<boolean> {
    const now = this.#now();
    const generation = r.lifecycle.generation;
    const owed = r.signIn.attempts.find((a) => a.cancel === "pending");
    if (owed !== undefined) return this.#deliverCancel(r, owed);
    const expired = r.signIn.attempts.find(
      (a) => a.ended === null && a.generation === generation && now >= a.deadline,
    );
    if (expired !== undefined) {
      await this.#exclusive(() =>
        this.#write((d) => {
          d.signIn = update(d.signIn, expired.attempt, (x) =>
            x.ended === null ? { ...x, ended: "expired", cancel: "pending" } : x,
          );
        }),
      );
      this.#log("sign_in_expired", { service: expired.service, attempt: expired.attempt });
      return true;
    }
    const undelivered = r.signIn.attempts.find((a) => isActive(a, generation, now) && !a.delivered);
    if (undelivered !== undefined) return (await this.#deliverStart(r, undelivered)) !== null;
    const checkMs = this.#t.signInCheckMs ?? SIGN_IN_CHECK_MS;
    const due = r.signIn.attempts.find(
      (a) => isActive(a, generation, now) && (a.checkedAt === null || now - a.checkedAt >= checkMs),
    );
    if (due === undefined) return false;
    let state: SignInView["state"] | null = null;
    try {
      const reply = await this.#command({
        type: "sign_in_status",
        ...this.#envelope(r, this.#d.newId("op")),
        service: due.service,
        attempt: due.attempt,
      });
      state = reply.view.state;
    } catch (error) {
      this.#log("sign_in_check_failed", { error: describe(error) });
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        d.signIn = update(d.signIn, due.attempt, (x) => ({
          ...x,
          checkedAt: now,
          ended: x.ended === null && state !== null && finalState(state) ? "finished" : x.ended,
        }));
      }),
    );
    if (state !== null && finalState(state)) {
      this.#log("sign_in_ended", { service: due.service, attempt: due.attempt, state });
    }
    return true;
  }

  /**
   * Staging only: the RC-53 switch, applied in each generation before its captures. `blocked`:
   * not applied yet, so no capture starts; `idle`: nothing to apply.
   */
  async #advanceStagingCheck(r: ComputerRecord): Promise<"progress" | "blocked" | "idle"> {
    const want = r.rc53;
    const generation = r.lifecycle.generation;
    if (this.#d.stagingChecks !== true || want === null || want.appliedGeneration === generation) {
      return "idle";
    }
    try {
      const reply = await this.#command({
        type: "staging_check",
        ...this.#envelope(r, this.#d.newId("op")),
        rc53: want.desired,
      });
      this.#log("staging_check_applied", { generation, rc53: reply.rc53 });
    } catch (error) {
      if (errorCodeOf(error) !== "bad_request") {
        this.#log("staging_check_failed", { error: describe(error) });
        return "blocked";
      }
      // An older supervisor cannot apply it: saves go on without the check.
      this.#log("staging_check_unsupported", { generation });
    }
    await this.#exclusive(() =>
      this.#write((d) => {
        if (d.rc53 !== null && d.rc53.desired === want.desired) {
          d.rc53 = { ...d.rc53, appliedGeneration: generation };
        }
      }),
    );
    return "progress";
  }

  /** The owner's switch (staging only): persisted, then applied by the runner. */
  async setStagingCheck(input: {
    readonly rc53: boolean;
  }): Promise<
    | { readonly outcome: "accepted"; readonly rc53: boolean }
    | { readonly outcome: "refused"; readonly reason: "not_staging" | "not_offered" }
  > {
    // Refused on production before anything is stored (the design: never on production).
    if (this.#d.stagingChecks !== true) return { outcome: "refused", reason: "not_staging" };
    try {
      return await this.#exclusive(() =>
        this.#write((d) => {
          if (d.lifecycle.context.removalIntent || d.lifecycle.context.state === "removed") {
            return { outcome: "refused" as const, reason: "not_offered" as const };
          }
          d.rc53 = { desired: input.rc53, appliedGeneration: null };
          this.#log("staging_check_set", { rc53: input.rc53 });
          return { outcome: "accepted" as const, rc53: input.rc53 };
        }),
      );
    } finally {
      this.#kick();
    }
  }

  /** The supervisor's metrics: fresh enough from memory, or asked for now. */
  async #supervisorStatus(
    r: ComputerRecord,
    freshMs: number,
  ): Promise<{
    readonly part: ComputerStatusView["supervisor"];
    readonly status: SupervisorStatus | null;
  }> {
    const generation = r.lifecycle.generation;
    const info = r.supervisorInfo;
    if (!restored(r.lifecycle.context.state)) return { part: "not_running", status: null };
    if (
      info !== null &&
      info.generation === generation &&
      !info.features.includes("computer_status")
    ) {
      return { part: "unsupported", status: null };
    }
    const cached = this.#metrics;
    if (cached !== null && cached.generation === generation && this.#now() - cached.at < freshMs) {
      return { part: "ok", status: cached.status };
    }
    try {
      const reply = await this.#command({
        type: "computer_status",
        ...this.#envelope(r, this.#d.newId("op")),
      });
      this.#metrics = { generation, at: this.#now(), status: reply.status };
      return { part: "ok", status: reply.status };
    } catch {
      return { part: "unreachable", status: null };
    }
  }

  #compose(
    r: ComputerRecord,
    supervisor: {
      readonly part: ComputerStatusView["supervisor"];
      readonly status: SupervisorStatus | null;
    },
  ): ComputerStatusView {
    return composeStatus({
      now: this.#now(),
      supervisor: supervisor.part,
      metrics: supervisor.status,
      credential: r.credential,
      signOut: { phase: r.signOut.phase, running: r.signOut.job !== null },
      saves: withRc53(r.saves, supervisor.status?.captures ?? []),
      staging: this.#d.stagingChecks === true,
      rc53Desired: r.rc53?.desired ?? false,
    });
  }

  /** The page's "Computer status": read now, composed here. Changes nothing durable. */
  async computerStatus(): Promise<ComputerStatusView> {
    const r = this.#require();
    return this.#compose(r, await this.#supervisorStatus(r, STATUS_FRESH_MS));
  }

  /**
   * The runner's status: read every `statusIntervalMs` while the computer runs, its RC-53 counts
   * kept with the saves they belong to, and logged as `computer_status` (names and counts only)
   * on every change and at each interval.
   */
  async #statusTick(r: ComputerRecord): Promise<void> {
    const now = this.#now();
    const interval = this.#t.statusIntervalMs ?? STATUS_INTERVAL_MS;
    const supervisor = await this.#supervisorStatus(r, interval);
    const captures = supervisor.status?.captures ?? [];
    let current = r;
    if (captures.length > 0 && r.saves.some((s) => s.rc53 === null)) {
      current = await this.#exclusive(() =>
        this.#write((d) => {
          d.saves = withRc53(d.saves, captures);
          return d;
        }),
      );
    }
    const log = statusLog(this.#compose(current, supervisor));
    const last = this.#statusLogged;
    if (last === null || last.signature !== log.signature || now - last.at >= interval) {
      this.#statusLogged = { signature: log.signature, at: now };
      this.#log("computer_status", { generation: r.lifecycle.generation, ...log.fields });
    }
  }

  // -------------------------------------------------------------------------------------------
  // The backup gateway's write fence (WP3.3; the lead's decision, 26 Oct).

  /**
   * Whether a write into this computer's checkpoint objects may go ahead (the lead's refined
   * policy, 26 Oct): the computer exists and is not fully removed, the generation is the one
   * running, and a credential bundle's key is a pending upload of that generation. That includes
   * a removal's sign-out run; an abandoned key stays fenced. The fence is admission control: a
   * write admitted before it may still land, and is cleaned up by the re-delete and the sweep.
   *
   * A lock-free read of committed state: the gateway asks while `computer()` holds the lock across
   * the very upload being checked (Codex r4-2). Storage reads are synchronous, so it never sees a
   * half-written transition.
   */
  async writeAllowed(raw: unknown): Promise<WriteDecision> {
    const parsed = WriteCheck.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a WriteCheck");
    checkInterface(parsed.data.interfaceVersion);
    const call = parsed.data;
    const r = this.#load();
    if (r === null || call.computerId !== this.#d.computerId) {
      return { allowed: false, reason: "unknown_computer" };
    }
    const ctx = r.lifecycle.context;
    if (ctx.state === "removed") return { allowed: false, reason: "removed" };
    const fenced = r.reservation?.generation === call.generation && r.reservation.fenced;
    const live = containerMayRun(ctx.state) && ctx.state !== "waking" && !fenced;
    if (!live || call.generation !== r.lifecycle.generation) {
      return { allowed: false, reason: "stale_generation" };
    }
    if (call.kind === "workspace") {
      return call.objectKey.startsWith(workspaceBackupPrefix(this.#d.computerId))
        ? { allowed: true }
        : { allowed: false, reason: "foreign_key" };
    }
    const pending = r.credentialUploads.some(
      (u) =>
        u.generation === call.generation &&
        credentialObjectKey(this.#d.computerId, u.checkpointId) === call.objectKey,
    );
    return pending ? { allowed: true } : { allowed: false, reason: "not_pending" };
  }

  /**
   * The computer's route (`identity`): the current generation and bound host ID. Lock-free, as
   * `writeAllowed`: a read of committed state, never waiting behind the runner.
   */
  async identity(call: { readonly interfaceVersion: number }): Promise<WorkspaceIdentity | null> {
    checkInterface(call.interfaceVersion);
    const r = this.#load();
    if (r === null) return null;
    return { computerId: r.computerId, generation: r.lifecycle.generation, hostId: r.hostId };
  }

  // -------------------------------------------------------------------------------------------
  // ControlDO's reconciliation.

  async reservation(call: { readonly interfaceVersion: number }): Promise<ReservationState | null> {
    checkInterface(call.interfaceVersion);
    const r = this.#load();
    if (r === null) return null;
    return reservationState({
      computerId: r.computerId,
      generation: r.lifecycle.generation,
      reservation: r.reservation,
      containerRunning: this.#d.port === null ? null : this.#d.port.running,
    });
  }

  // -------------------------------------------------------------------------------------------
  // The runner: carries each persisted intent forward.

  #kick(): void {
    if (this.#running !== null) {
      this.#again = true;
      return;
    }
    this.#running = (async () => {
      try {
        do {
          this.#again = false;
          await this.#reconcile();
        } while (this.#again);
      } catch (error) {
        this.#log("reconcile_failed", { error: describe(error) });
      } finally {
        this.#running = null;
      }
    })();
  }

  async #reconcile(): Promise<void> {
    for (let pass = 0; pass < 200; pass += 1) {
      let progressed = false;
      try {
        // A recovery alarm is in place before any long effect starts (FH-36).
        await this.#exclusive(() => this.#schedule());
        progressed = await this.#reconcileOnce();
      } catch (error) {
        this.#log("reconcile_step_failed", { error: describe(error) });
        progressed = false;
      }
      if (!progressed) break;
    }
    await this.#exclusive(() => this.#schedule());
  }

  async #reconcileOnce(): Promise<boolean> {
    const r = this.#load();
    if (r === null) return false;
    if (await this.#exclusive(() => this.#timeEvents())) return true;
    const port = this.#d.port;
    if (r.lifecycle.context.state === "removed") {
      if (r.deletion !== null) return this.#advanceDeletion(r, port);
      if (await this.#sweep(r)) return true;
      return this.#sweepRemoved(r);
    }
    if (port !== null) {
      const observed = await this.#observe(r, port);
      // A deferred wake ends this pass: nothing else may act on the stopped container meanwhile.
      if (observed === "deferred") return false;
      if (observed) return true;
      if (await this.#rearm(r, port)) return true;
      const state = r.lifecycle.context.state;
      if (state === "waking") {
        if (await this.#advanceStart(r, port)) return true;
      } else if (state === "restoring") {
        if (await this.#advanceRestore(r, port)) return true;
      } else if (state === "stopping") {
        if (await this.#advanceStopping(r, port)) return true;
      } else if (restored(state)) {
        // Sign-in cancels go first: a stop's credential barrier and a sign-out wait for them.
        if (await this.#advanceSignIns(r)) return true;
        if (await this.#advanceDeliver(r)) return true;
        const check = await this.#advanceStagingCheck(r);
        if (check === "progress") return true;
        if (check === "idle" && (await this.#advanceSaves(r, port))) return true;
        if (await this.#advanceStopJob(r)) return true;
        if (await this.#advanceSignOut(r)) return true;
        await this.#statusTick(r);
      }
    }
    return this.#chores(r, port);
  }

  /** Time-driven events (serialized): the start deadline, "not saved", the backstop, removals. */
  #timeEvents(): boolean {
    const r = this.#load();
    if (r === null || r.lifecycle.context.state === "removed") return false;
    const now = this.#now();
    const ctx = r.lifecycle.context;
    const generation = r.lifecycle.generation;
    const before = JSON.stringify(r);
    this.#write((d) => {
      if (d.terminalOpenUntil !== null && d.terminalOpenUntil <= now) d.terminalOpenUntil = null;
      // A sign-in attempt defers the start deadline as an open terminal does (WP3.23).
      const terminalOpen = d.terminalOpenUntil !== null || leaseActive(d.signIn, generation, now);
      // A stop whose preparation just failed is tried again a heartbeat later, not at once.
      const stopRetryDue = d.stopRefusedAt === null || now - d.stopRefusedAt >= this.#t.heartbeatMs;
      if (
        withoutHost(ctx.state) &&
        d.noHostSince !== null &&
        now - d.noHostSince >= this.#t.startDeadlineMs &&
        !(restored(ctx.state) && (ctx.stopPrep !== null || terminalOpen || !stopRetryDue))
      ) {
        this.#step(d, "start_deadline", { terminalOpen });
        return;
      }
      if (!restored(ctx.state)) return;
      if (ctx.removalIntent && ctx.stopPrep === null && d.signOut.job === null && stopRetryDue) {
        this.#step(d, "removal_stop_due", {});
        return;
      }
      if (d.notSaved === null && notSavedDue(d.verified, generation, now, this.#t.notSavedMs)) {
        d.notSaved = closeNotSaved(now, this.#t.retryMs);
        this.#log("not_saved", { generation });
      } else if (d.notSaved !== null && now >= d.notSaved.nextRetryAt) {
        d.notSaved = retriedNotSaved(d.notSaved, now, this.#t.retryMs);
        d.nextCaptureAt = now;
        if (d.saveRequests.length === 0 && d.capture === null) this.#internalSave(d, "retry");
      }
      const report = this.#currentReport(d);
      if (
        backstopDue({
          runnerProcesses: report?.runnerProcesses ?? null,
          lastRequestAt: d.lastRequestAt ?? d.verified?.at ?? now,
          now,
          backstopMs: this.#t.backstopMs,
        })
      ) {
        this.#internalSave(d, "backstop");
        d.lastRequestAt = now;
      }
    });
    return JSON.stringify(this.#load()) !== before;
  }

  #internalSave(d: ComputerRecord, reason: "retry" | "backstop"): void {
    const request: SaveRequest = { id: this.#d.newId("op"), reason, at: this.#now() };
    this.#step(d, "checkpoint", {}, { request });
  }

  /** Whether the container's state matches the lifecycle; corrects it if not. */
  async #observe(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean | "deferred"> {
    const state = r.lifecycle.context.state;
    // The backoff belongs to one queued wake: whatever ends it, the next one starts afresh.
    if (!(state === "stopping" && r.lifecycle.context.wakeQueued)) {
      this.#wakeDeferrals = 0;
      this.#wakeRetryAt = 0;
    }
    const running = port.running;
    if (expectsContainer(state) && !running) {
      const old = r.reservation;
      const queued = state === "stopping" && r.lifecycle.context.wakeQueued;
      // A deferred wake retries with backoff (2, 4, 8 … s, at most a heartbeat), not every pass.
      if (queued && this.#now() < this.#wakeRetryAt) return "deferred";
      const defer = (): "deferred" => {
        const delay = Math.min(this.#t.pollMs * 2 ** this.#wakeDeferrals, this.#t.heartbeatMs);
        this.#wakeDeferrals += 1;
        this.#wakeRetryAt = this.#now() + delay;
        return "deferred";
      };
      if (queued && old !== null) {
        // The container is confirmed stopped: give its slot back before the queued wake asks for
        // one, so the two never compete at the limit. The transition queues the same release
        // again; ControlDO's release is idempotent.
        try {
          await this.#d.control.control({
            method: "release",
            interfaceVersion: CONTROL_INTERFACE_VERSION,
            operationId: this.#d.newId("op"),
            computerId: this.#d.computerId,
            generation: old.generation,
          });
        } catch (error) {
          // The wake stays queued and the computer `stopping`; a later poll tries again.
          this.#log("queued_wake_waits", { generation: old.generation, error: describe(error) });
          return defer();
        }
      }
      // A queued wake is never refused for this computer's own stale slots, nor for ControlDO
      // being unreachable: it waits (`deferred`) and is retried; only a real refusal ends it.
      const outcome = await this.#exclusive(() =>
        this.#reserving("container_stopped", {}, {}, queued ? "defer" : "at_capacity"),
      );
      if (outcome === "deferred") {
        this.#log("queued_wake_waits", { generation: r.lifecycle.generation });
        return defer();
      }
      this.#wakeDeferrals = 0;
      this.#wakeRetryAt = 0;
      return true;
    }
    if (!containerMayRun(state) && running) {
      // A container no state wants: a late start of a fenced generation, or one left by a crash.
      this.#log("orphan_container", { state });
      await port.destroy("orphan");
      return true;
    }
    return false;
  }

  /** Every new instance re-arms the inactivity timeout and refreshes the intercepts' props. */
  async #rearm(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    const state = r.lifecycle.context.state;
    if (!port.running || !containerMayRun(state) || state === "waking") return false;
    if (this.#renewTimeout) {
      await port.setInactivityTimeout(this.#t.inactivityTimeoutMs);
      this.#renewTimeout = false;
    }
    if (this.#propsKey !== `${r.lifecycle.generation}/${r.hostId}`) {
      await this.#registerIntercepts(r, port);
      return true;
    }
    return false;
  }

  async #registerIntercepts(r: ComputerRecord, port: ComputerContainerPort): Promise<void> {
    const props: InterceptProps = {
      propsVersion: INTERCEPT_PROPS_VERSION,
      computerId: this.#d.computerId,
      generation: r.lifecycle.generation,
      hostId: r.hostId,
    };
    for (const { host, target } of this.#d.intercepts(props))
      await port.registerIntercept(host, target);
    this.#propsKey = `${props.generation}/${props.hostId}`;
  }

  /** `waking`: start the container, detect a refused start, retry it (DC-37). */
  async #advanceStart(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    const generation = r.lifecycle.generation;
    const start = r.start;
    const step = (event: LifecycleEvent, facts: Facts = {}) =>
      this.#exclusive(() =>
        this.#write((d) => {
          if (d.lifecycle.context.state !== "waking" || d.lifecycle.generation !== generation)
            return;
          this.#step(d, event, facts);
        }),
      );
    if (start === null || start.generation !== generation || !mayStart(r.reservation, generation)) {
      await step("start_failed");
      return true;
    }
    if (port.running) {
      await step("container_running");
      return true;
    }
    const now = this.#now();
    if (start.startedAt === null) {
      if (now < start.nextAt) return false;
      // Never above the installation's cap. Only this generation's grant is trusted for it; a
      // start recorded otherwise (before grants carried the cap) confirms it with ControlDO
      // first, and waits while it cannot: the start deadline fences a start that never gets one.
      let cap = r.maxSizeGeneration === generation ? r.maxSize : null;
      if (cap === null) {
        cap = await this.#confirmedCap();
        if (cap === null) {
          this.#log("size_cap_unconfirmed", { generation });
          return false;
        }
      }
      const confirmed = cap;
      await this.#registerIntercepts(r, port);
      const instance = await this.#exclusive(() =>
        this.#write((d): InstanceSize | null => {
          if (d.lifecycle.context.state !== "waking" || d.lifecycle.generation !== generation)
            return null;
          if (d.start?.startedAt !== null) return null;
          if (d.reservation === null || !mayStart(d.reservation, generation)) return null;
          d.maxSize = confirmed;
          d.maxSizeGeneration = generation;
          d.size = clampSize(d.size, confirmed);
          d.start = { ...d.start, startedAt: now };
          d.reservation = starting(d.reservation);
          return d.size;
        }),
      );
      if (instance === null) return true;
      try {
        port.start({
          instance,
          env: {
            [COMPUTER_START_ENV.computerId]: this.#d.computerId,
            [COMPUTER_START_ENV.generation]: String(generation),
          },
        });
      } catch (error) {
        if (!isStartRefusedError(error)) {
          this.#log("start_threw", { generation, error: describe(error) });
          await step("start_failed");
          return true;
        }
      }
      if (port.running) await step("container_running");
      return true;
    }
    if (now - start.startedAt >= this.#t.startRefusedAfterMs) {
      await step("start_refused", {
        retriesLeft: start.refusals < this.#t.startRetryDelaysMs.length,
      });
      return true;
    }
    return false;
  }

  /** `restoring`: the layers in order, the merge, then the credentials; then confirmed (R-19). */
  async #advanceRestore(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    const job = r.restore;
    const generation = r.lifecycle.generation;
    if (job === null || job.generation !== generation) {
      await this.#exclusive(() => this.#write((d) => this.#step(d, "restore_failed", {})));
      return true;
    }
    const update = (fn: (d: ComputerRecord, j: NonNullable<ComputerRecord["restore"]>) => void) =>
      this.#exclusive(() =>
        this.#write((d) => {
          if (
            d.restore === null ||
            d.restore.generation !== generation ||
            d.restore.mergeOp !== job.mergeOp
          )
            return;
          fn(d, d.restore);
        }),
      );
    const fail = async (reason: string) => {
      this.#log("restore_failed", { generation, reason });
      await update((d) => {
        this.#step(d, "restore_failed", {});
      });
      return true;
    };
    const trouble = async (error: unknown, what: string) => {
      if (isNotRunning(error)) return true;
      if (job.failures + 1 >= this.#t.restoreFailures) return fail(`${what}: ${describe(error)}`);
      this.#log("restore_retry", { generation, what, error: describe(error) });
      await update((_, j) => {
        j.failures += 1;
      });
      return false;
    };
    const layers = job.manifest?.layers ?? [];
    try {
      if (job.phase === "layers") {
        const layer = layers[job.nextLayer];
        if (layer === undefined) {
          await update((_, j) => {
            j.phase = "merge";
          });
          return true;
        }
        // Bounded, and aborted if the restore is abandoned meanwhile (FH-36).
        const deadline = this.#d.deadline(this.#t.restoreLayerDeadlineMs);
        const abort = new AbortController();
        deadline.signal.addEventListener("abort", () => abort.abort(deadline.signal.reason));
        this.#restoreAbort = abort;
        try {
          await port.restore(layer.backup, {
            dir: `${RESTORE_ROOT}/${layer.layerId}`,
            prefix: workspaceBackupPrefix(this.#d.computerId),
            signal: abort.signal,
          });
        } catch (error) {
          if (isMissingLayer(error)) return fail(`layer ${layer.layerId} missing`);
          throw error;
        } finally {
          deadline.clear();
          this.#restoreAbort = null;
        }
        await update((_, j) => {
          j.nextLayer += 1;
          j.failures = 0;
        });
        return true;
      }
      if (job.phase === "merge") {
        const reply = await this.#command({
          type: "restore_workspace",
          ...this.#envelope(r, job.mergeOp),
          manifest: job.manifest,
          layerDirs: [...restoreDirs(job.manifest)],
        });
        const result = reply.job;
        if (result.state === "running") return false;
        if (result.state === "failed") return fail(result.reason);
        if (result.treeDigest !== (job.manifest?.treeDigest ?? null))
          return fail("tree digest mismatch");
        await update((_, j) => {
          j.phase = "credentials";
          j.failures = 0;
        });
        return true;
      }
      const read = await this.#readBundle(r.credential);
      const reply = await this.#command({
        type: "install_credentials",
        ...this.#envelope(r, job.installOp),
        bundle: read.bundle,
      });
      const now = this.#now();
      await update((d) => {
        d.credentialFloor = { generation, floor: reply.orderFloor };
        if (read.lost) {
          d.credential = null;
          d.signOut = { ...d.signOut, loginPossiblyLost: true };
        }
        d.restoredTo = d.stop?.reason === "unexpected" ? (job.manifest?.cutAt ?? null) : null;
        d.verified = { generation, at: now, how: "restore" };
        d.lastRequestAt = now;
        const restorePoint = d.restore?.manifest ?? null;
        d.restore = null;
        if (restorePoint !== null) d.orphans.push(...droppedLayers(restorePoint, d.workspace));
        this.#step(d, "restore_confirmed", {});
      });
      this.#log("restore_confirmed", { generation, layers: layers.length });
      return true;
    } catch (error) {
      return trouble(error, job.phase);
    }
  }

  /** The bundle the credential pointer names, read back and checked; `lost` if it is gone. */
  async #readBundle(
    pointer: CredentialManifest | null,
  ): Promise<{ readonly bundle: CredentialBundle | null; readonly lost: boolean }> {
    if (pointer === null) return { bundle: null, lost: false };
    const bucket = this.#d.bucket;
    if (bucket === null) throw platformError("unavailable", "no checkpoint bucket");
    const bytes = await bucket.get(pointer.object.key);
    if (bytes === null || !(await objectMatches(pointer, bytes))) {
      this.#log("credential_bundle_lost", { key: pointer.object.key });
      return { bundle: null, lost: true };
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { bundle: null, lost: true };
    }
    const parsed = CredentialBundle.safeParse(json);
    if (!parsed.success || parsed.data.computerId !== this.#d.computerId)
      return { bundle: null, lost: true };
    return { bundle: parsed.data, lost: false };
  }

  /** `host_running`: hand the current attempt's parameters to the supervisor once (G1BR-005). */
  async #advanceDeliver(r: ComputerRecord): Promise<boolean> {
    const params = r.params;
    if (r.lifecycle.context.state !== "host_running" || params === null || !params.deliver)
      return false;
    const token = TokenRecord.safeParse(this.#d.store.get(TOKEN_KEY));
    const finish = (fn: (d: ComputerRecord) => void) =>
      this.#exclusive(() =>
        this.#write((d) => {
          const current =
            d.params?.attempt === params.attempt && d.params.deliverOp === params.deliverOp;
          if (current && d.lifecycle.context.state === "host_running") fn(d);
          if (current) d.params = null;
          this.#dropToken(params.attempt);
        }),
      );
    if (!token.success || token.data.attempt !== params.attempt) {
      this.#log("start_parameters_missing", { attempt: params.attempt });
      await finish((d) => {
        this.#step(d, "start_not_taken", {});
      });
      return true;
    }
    const reply = await this.#command({
      type: "start_host",
      ...this.#envelope(r, params.deliverOp),
      startAttempt: params.attempt,
      hostId: params.hostId,
      hostName: params.hostName,
      token: token.data.token,
      hostConfig: params.hostConfig,
    });
    this.#log("start_delivered", { attempt: params.attempt, outcome: reply.outcome });
    await finish((d) => {
      if (reply.outcome === "taken") this.#step(d, "start_taken", {});
      else if (reply.outcome === "declined") this.#step(d, "start_not_taken", {});
    });
    return true;
  }

  // Saves (D17, R-18, R-19).

  async #advanceSaves(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    if (r.capture !== null) return this.#advanceCapture(r, r.capture, port);
    const job = r.stopJob;
    if (job !== null && job.phase !== "capture") return false;
    const now = this.#now();
    const purpose = job !== null ? "stop" : "save";
    if (
      purpose === "save" &&
      (r.saveRequests.length === 0 || (r.nextCaptureAt !== null && now < r.nextCaptureAt))
    ) {
      return false;
    }
    return this.#exclusive(() =>
      this.#write((d) => {
        if (d.capture !== null || !restored(d.lifecycle.context.state)) return false;
        const t = this.#step(d, "capture_started", {});
        if (t.reply?.kind === "refused") return false;
        const plan = nextLayer(d.workspace, POLICY.version);
        d.capture = {
          generation: d.lifecycle.generation,
          op: this.#d.newId("op"),
          finishOp: this.#d.newId("op"),
          layerId: this.#d.newId("lyr"),
          kind: plan.kind,
          parent: plan.parent,
          purpose,
          covers: d.saveRequests.map((request) => request.id),
          startedAt: this.#now(),
          phase: "command",
          staged: null,
          backup: null,
          result: null,
          checkpointId: null,
          failure: null,
        };
        return true;
      }),
    );
  }

  async #advanceCapture(
    r: ComputerRecord,
    c: CaptureRecord,
    port: ComputerContainerPort,
  ): Promise<boolean> {
    const update = (fn: (d: ComputerRecord, c: CaptureRecord) => void) =>
      this.#exclusive(() =>
        this.#write((d) => {
          if (d.capture !== null && d.capture.op === c.op) fn(d, d.capture);
        }),
      );
    const now = this.#now();
    if (
      c.phase !== "publish" &&
      c.phase !== "finish" &&
      now - c.startedAt > this.#t.captureDeadlineMs
    ) {
      return this.#endCapture(c, "failed", "deadline");
    }
    try {
      switch (c.phase) {
        case "command":
        case "poll": {
          const reply = await this.#command(
            c.phase === "command"
              ? {
                  type: "capture",
                  ...this.#envelope(r, c.op),
                  layerId: c.layerId,
                  policyVersion: POLICY.version,
                  lease: pauseLease(r.workspaceBytes),
                  ...(c.kind === "base" || c.parent === null
                    ? { kind: "base" as const, parent: null }
                    : { kind: "delta" as const, parent: c.parent }),
                }
              : {
                  type: "job_status",
                  ...this.#envelope(r, this.#d.newId("op")),
                  jobOperationId: c.op,
                },
          );
          const job = reply.job;
          if (job.kind !== "capture") return this.#endCapture(c, "failed", "unexpected reply");
          switch (job.state) {
            case "running":
              if (c.phase === "command") {
                await update((_, x) => {
                  x.phase = "poll";
                });
              }
              return false;
            case "staged":
              await update((d, x) => {
                x.staged = {
                  layerDir: job.layerDir,
                  indexSha256: job.indexSha256,
                  treeDigest: job.treeDigest,
                  entries: job.entries,
                  deleted: job.deleted,
                  bytes: job.bytes,
                  cutAt: job.cutAt,
                };
                x.phase = "upload";
                if (x.kind === "base") d.workspaceBytes = job.bytes;
              });
              return true;
            case "unchanged": {
              const parent = c.parent;
              if (c.kind !== "delta" || parent === null)
                return this.#endCapture(c, "failed", "unchanged base");
              await update((d) => {
                if (d.workspace?.checkpointId !== parent.checkpointId) return;
                d.unchanged = {
                  generation: c.generation,
                  parentCheckpointId: parent.checkpointId,
                  cutAt: job.cutAt,
                  at: now,
                };
                // Measured on WorkspaceDO's own clock, from when the capture was asked for: the
                // cut follows it, and the container's clock may differ.
                d.verified = { generation: c.generation, at: c.startedAt, how: "unchanged" };
              });
              const still = this.#load()?.workspace?.checkpointId === parent.checkpointId;
              return this.#endCapture(
                c,
                still ? "unchanged" : "failed",
                still ? null : "parent changed",
              );
            }
            case "failed":
              return this.#endCapture(c, "failed", job.reason);
          }
          return false;
        }
        case "upload": {
          const staged = c.staged;
          if (staged === null) return this.#endCapture(c, "failed", "nothing staged");
          let backup: Awaited<ReturnType<ComputerContainerPort["backup"]>>;
          const deadline = this.#d.deadline(this.#t.uploadDeadlineMs);
          try {
            backup = await this.#upload(port, c, staged.layerDir, deadline.signal);
          } catch (error) {
            this.#log("upload_failed", { generation: c.generation, error: describe(error) });
            await update((_, x) => {
              x.result = "discarded";
              x.failure = "upload";
              x.phase = "finish";
            });
            return true;
          } finally {
            deadline.clear();
          }
          await update((_, x) => {
            x.backup = backup;
            x.phase = "publish";
          });
          return true;
        }
        case "publish": {
          const staged = c.staged;
          const backup = c.backup;
          if (staged === null || backup === null)
            return this.#endCapture(c, "failed", "nothing uploaded");
          await update((d, x) => {
            const outcome = publish({
              pointer: d.workspace,
              plan:
                x.kind === "base" || x.parent === null
                  ? { layerId: x.layerId, kind: "base", reason: "no_parent", parent: null }
                  : { layerId: x.layerId, kind: "delta", parent: x.parent },
              staged,
              backup,
              checkpointId: this.#d.newId("ckp") as CredentialManifest["checkpointId"],
              computerId: this.#d.computerId,
              generation: x.generation,
              policyVersion: POLICY.version,
              roots: POLICY.roots,
              now: this.#now(),
            });
            if (outcome.outcome === "published") {
              d.orphans.push(...droppedLayers(d.workspace, outcome.manifest));
              d.workspace = outcome.manifest;
              d.lastSavedAt = outcome.manifest.cutAt;
              d.unchanged = null;
              d.verified = { generation: x.generation, at: x.startedAt, how: "published" };
              x.result = "published";
              x.checkpointId = outcome.manifest.checkpointId;
              this.#log("workspace_published", {
                generation: x.generation,
                kind: x.kind,
                layers: outcome.manifest.layers.length,
              });
            } else {
              d.orphans.push(backup);
              x.result = "discarded";
              this.#log("workspace_discarded", {
                generation: x.generation,
                reason: outcome.reason,
              });
            }
            x.phase = "finish";
          });
          return true;
        }
        case "finish": {
          await this.#command({
            type: "finish_capture",
            ...this.#envelope(r, c.finishOp),
            captureOperationId: c.op,
            ...(c.result === "published" && c.checkpointId !== null
              ? { outcome: "published" as const, checkpointId: c.checkpointId }
              : { outcome: "discarded" as const, checkpointId: null }),
          });
          if (c.result === "published") return this.#endCapture(c, "published", null);
          return this.#endCapture(c, c.failure === null ? "discarded" : "failed", c.failure);
        }
      }
    } catch (error) {
      this.#log("capture_trouble", {
        generation: c.generation,
        phase: c.phase,
        error: describe(error),
      });
      if (isNotRunning(error)) return true;
      return false;
    }
  }

  /**
   * The staged layer's upload, repeated after a transient failure (WP3.22), each time after the
   * next of `uploadRetryDelaysMs`, all within the one upload deadline. Nothing is persisted between
   * attempts: an attempt that failed left no object, and only the attempt that returns a record
   * is recorded, so a layer is never published incomplete or twice. An eviction mid-way re-runs
   * the upload phase from its first attempt, still bounded by the capture's own deadline. The
   * upload stops being repeated once its capture is no longer current.
   */
  async #upload(
    port: ComputerContainerPort,
    c: CaptureRecord,
    layerDir: string,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<ComputerContainerPort["backup"]>>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await port.backup({
          dir: layerDir,
          name: c.layerId,
          prefix: workspaceBackupPrefix(this.#d.computerId),
          generation: c.generation,
          signal,
        });
      } catch (error) {
        const delay = this.#t.uploadRetryDelaysMs[attempt];
        if (delay === undefined || signal.aborted || !isTransientUploadError(error)) throw error;
        if (this.#load()?.capture?.op !== c.op) throw error;
        this.#log("upload_retry", {
          generation: c.generation,
          attempt: attempt + 1,
          delayMs: delay,
          error: describe(error),
        });
        await (this.#d.sleep ?? abortableSleep)(delay, signal);
      }
    }
  }

  async #endCapture(
    c: CaptureRecord,
    outcome: "published" | "unchanged" | "discarded" | "failed",
    reason: string | null,
  ): Promise<boolean> {
    if (outcome === "failed") this.#log("save_failed", { generation: c.generation, reason });
    return this.#exclusive(() =>
      this.#write((d) => {
        if (d.capture === null || d.capture.op !== c.op) return false;
        d.capture = null;
        this.#step(d, "capture_finished", {});
        const now = this.#now();
        // The final outcome, for the status and the list's badge (WP3.23).
        d.saves = recordSave(d.saves, {
          at: now,
          generation: c.generation,
          op: c.op,
          outcome,
          reason: outcome === "failed" ? (reason ?? "internal").slice(0, 32) : null,
          kind: c.kind,
          rc53: null,
        });
        const ok = outcome === "published" || outcome === "unchanged";
        if (ok) {
          d.saveRequests = [...uncovered(d.saveRequests, c.covers)];
          d.captureFailures = 0;
          d.nextCaptureAt = null;
          d.notSaved = null;
        } else if (outcome === "discarded") {
          d.nextCaptureAt = now;
        } else {
          d.captureFailures += 1;
          d.nextCaptureAt = now + retryDelayMs(d.captureFailures - 1, this.#t.retryMs);
        }
        if (c.purpose === "stop" && d.stopJob !== null && d.stopJob.phase === "capture") {
          if (ok) {
            d.stopJob = {
              ...d.stopJob,
              phase: "credentials",
              deadline: now + this.#t.credentialBarrierMs,
            };
          } else {
            d.stopJob = { ...d.stopJob, failure: "checkpoint_failed" };
            this.#step(d, "stop_preparation_failed", {});
          }
        }
        return true;
      }),
    );
  }

  /** A stop being prepared, after its capture: the final credential barrier (step 7). */
  async #advanceStopJob(r: ComputerRecord): Promise<boolean> {
    const job = r.stopJob;
    if (job === null || job.phase === "capture" || job.generation !== r.lifecycle.generation)
      return false;
    const now = this.#now();
    const fail = () =>
      this.#exclusive(() =>
        this.#write((d) => {
          if (d.stopJob?.snapshotOp !== job.snapshotOp) return;
          d.stopJob = { ...d.stopJob, failure: "credentials_unpublished" };
          this.#step(d, "stop_preparation_failed", {});
        }),
      ).then(() => true);
    if (job.phase === "credentials") {
      if (job.deadline !== null && now >= job.deadline) return fail();
      // A sign-in still running could change a login after the barrier: its cancel goes first.
      if (this.#cancelsPending(r)) return false;
      try {
        const reply = await this.#command({
          type: "credential_snapshot",
          ...this.#envelope(r, job.snapshotOp),
        });
        await this.#exclusive(() =>
          this.#write((d) => {
            if (d.stopJob?.snapshotOp === job.snapshotOp)
              d.stopJob = { ...d.stopJob, phase: "wait", order: reply.order };
          }),
        );
        return true;
      } catch (error) {
        this.#log("credential_snapshot_failed", { error: describe(error) });
        return false;
      }
    }
    const pointer = r.credential;
    if (
      pointer !== null &&
      pointer.generation === r.lifecycle.generation &&
      pointer.order >= (job.order ?? 0)
    ) {
      await this.#exclusive(() =>
        this.#write((d) => {
          if (d.stopJob?.snapshotOp === job.snapshotOp) this.#step(d, "stop_prepared", {});
        }),
      );
      return true;
    }
    if (job.deadline !== null && now >= job.deadline) return fail();
    return false;
  }

  /** `stopping`: the stop record is persisted; stop the container. */
  async #advanceStopping(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    if (!port.running) return false;
    try {
      await port.destroy(r.stop?.reason ?? "stop");
      return true;
    } catch (error) {
      this.#log("destroy_failed", { error: describe(error) });
      return false;
    }
  }

  /**
   * A sign-out run: the CLIs' logouts, a fresh credential snapshot, then, once its tombstones are
   * published, a read-back of the stored bundle showing no declared file (the bytes a fresh
   * computer's install would get; 3.C, open question 6).
   */
  async #advanceSignOut(r: ComputerRecord): Promise<boolean> {
    const job = r.signOut.job;
    if (job === null || job.generation !== r.lifecycle.generation) return false;
    const update = (
      fn: (d: ComputerRecord, j: NonNullable<ComputerRecord["signOut"]["job"]>) => void,
    ) =>
      this.#exclusive(() =>
        this.#write((d) => {
          if (d.signOut.job !== null && d.signOut.job.op === job.op) fn(d, d.signOut.job);
        }),
      ).then(() => true);
    const end = (d: ComputerRecord) => {
      d.signOut = { ...d.signOut, job: null };
    };
    if (this.#now() >= job.deadline) {
      this.#log("sign_out_gave_up", { phase: job.phase });
      return update(end);
    }
    try {
      switch (job.phase) {
        case "command": {
          // Every sign-in attempt is cancelled before the logouts (the supervisor also ends any
          // it still runs).
          if (this.#cancelsPending(r)) return false;
          const reply = await this.#command({ type: "sign_out", ...this.#envelope(r, job.op) });
          this.#log("sign_out_ran", { claude: reply.claude, codex: reply.codex });
          return update((_, j) => {
            j.phase = "snapshot";
          });
        }
        case "snapshot": {
          const reply = await this.#command({
            type: "credential_snapshot",
            ...this.#envelope(r, job.snapshotOp),
          });
          return update((_, j) => {
            j.phase = "wait";
            j.order = reply.order;
          });
        }
        case "wait": {
          const pointer = r.credential;
          if (
            pointer === null ||
            pointer.generation !== r.lifecycle.generation ||
            pointer.order < (job.order ?? 0)
          ) {
            return false;
          }
          return update((d, j) => {
            if (d.signOut.phase === "tombstoned") j.phase = "verify";
            else end(d);
          });
        }
        case "verify": {
          const read = await this.#readBundle(r.credential);
          const verified = read.bundle !== null && noDeclaredFile(read.bundle.files);
          return update((d) => {
            if (verified)
              d.signOut = { ...d.signOut, phase: SIGN_OUT_TABLE[d.signOut.phase].restore_verified };
            end(d);
          });
        }
      }
    } catch (error) {
      this.#log("sign_out_trouble", { phase: job.phase, error: describe(error) });
      return false;
    }
  }

  /** Background work that needs no particular state: releases, layer and bundle deletions. */
  async #chores(r: ComputerRecord, port: ComputerContainerPort | null): Promise<boolean> {
    const release = r.releases[0];
    if (release !== undefined) {
      try {
        await this.#d.control.control({
          method: "release",
          interfaceVersion: CONTROL_INTERFACE_VERSION,
          operationId: release.operationId,
          computerId: this.#d.computerId,
          generation: release.generation,
        });
      } catch (error) {
        this.#log("release_failed", { generation: release.generation, error: describe(error) });
        return false;
      }
      await this.#exclusive(() =>
        this.#write((d) => {
          d.releases = d.releases.filter((x) => x.operationId !== release.operationId);
        }),
      );
      return true;
    }
    const retained = [r.workspace, r.restore?.manifest ?? null].filter((m) => m !== null);
    const orphan = unreferenced(r.orphans, retained)[0];
    if (orphan !== undefined && port !== null) {
      try {
        await port.deleteBackup(orphan, { prefix: workspaceBackupPrefix(this.#d.computerId) });
      } catch (error) {
        this.#log("layer_delete_failed", { error: describe(error) });
        return false;
      }
      await this.#exclusive(() =>
        this.#write((d) => {
          d.orphans = d.orphans.filter((x) => x.id !== orphan.id);
        }),
      );
      return true;
    }
    const live = r.workspace?.layers.map((layer) => layer.backup.id) ?? [];
    if (r.orphans.some((x) => live.includes(x.id))) {
      // In the pointer again: not an orphan. One only a restore point holds waits for it.
      await this.#exclusive(() =>
        this.#write((d) => {
          d.orphans = d.orphans.filter((x) => !live.includes(x.id));
        }),
      );
      return true;
    }
    if (r.credential !== null && r.credentialDeletes.includes(r.credential.object.key)) {
      const live = r.credential.object.key;
      await this.#exclusive(() =>
        this.#write((d) => {
          d.credentialDeletes = d.credentialDeletes.filter((x) => x !== live);
        }),
      );
      return true;
    }
    const key = r.credentialDeletes[0];
    if (key !== undefined && this.#d.bucket !== null) {
      try {
        await this.#d.bucket.delete(key);
      } catch (error) {
        this.#log("bundle_delete_failed", { error: describe(error) });
        return false;
      }
      await this.#exclusive(() =>
        this.#write((d) => {
          d.credentialDeletes = d.credentialDeletes.filter((x) => x !== key);
        }),
      );
      return true;
    }
    return this.#sweep(r);
  }

  /** A resolved removal: layers, then credential bundles, then ControlDO, then the records. */
  async #advanceDeletion(r: ComputerRecord, port: ComputerContainerPort | null): Promise<boolean> {
    const deletion = r.deletion;
    if (deletion === null) return false;
    const set = (fn: (d: ComputerRecord) => void) =>
      this.#exclusive(() => this.#write(fn)).then(() => true);
    try {
      switch (deletion.phase) {
        case "layers": {
          if (r.workspace !== null || r.capture?.backup) {
            return set((d) => {
              d.orphans.push(...(d.workspace?.layers.map((l) => l.backup) ?? []));
              if (d.capture?.backup) d.orphans.push(d.capture.backup);
              d.workspace = null;
              d.capture = null;
            });
          }
          const layer = r.orphans[0];
          if (layer === undefined) {
            return set((d) => {
              d.deletion = { forgetOp: deletion.forgetOp, phase: "credentials" };
            });
          }
          if (port === null) return false;
          await port.deleteBackup(layer, { prefix: workspaceBackupPrefix(this.#d.computerId) });
          return set((d) => {
            d.orphans = d.orphans.filter((x) => x.id !== layer.id);
          });
        }
        case "credentials": {
          if (r.credential !== null || r.credentialUploads.length > 0) {
            return set((d) => {
              if (d.credential !== null) d.credentialDeletes.push(d.credential.object.key);
              for (const u of d.credentialUploads) this.#abandonUpload(d, u.checkpointId);
              d.credential = null;
              d.credentialUploads = [];
            });
          }
          const key = r.credentialDeletes[0];
          if (key === undefined) {
            return set((d) => {
              d.deletion = { forgetOp: deletion.forgetOp, phase: "forget" };
            });
          }
          if (this.#d.bucket === null) return false;
          await this.#d.bucket.delete(key);
          return set((d) => {
            d.credentialDeletes = d.credentialDeletes.filter((x) => x !== key);
          });
        }
        case "forget":
          await this.#d.control.control({
            method: "forget_computer",
            interfaceVersion: CONTROL_INTERFACE_VERSION,
            operationId: deletion.forgetOp,
            computerId: this.#d.computerId,
          });
          return set((d) => {
            d.deletion = { forgetOp: deletion.forgetOp, phase: "wipe" };
          });
        case "wipe": {
          await this.#exclusive(() =>
            this.#d.store.transaction(() => {
              const d = this.#require();
              // Sleeps keep their recorded outcome until the journal's retention ends, as every
              // repeat is promised (Codex WP3.18 r1-2): a removal must not turn an earlier
              // `suspend`'s `stopped` into `gone`. Every other record goes now.
              const kept = this.#keepSleepOutcomes();
              for (const key of this.#d.store.keys(OPERATION_PREFIX)) {
                if (!kept.has(key)) this.#d.store.delete(key);
              }
              for (const key of this.#d.store.keys(OPERATION_TIME_PREFIX)) {
                const target = this.#d.store.get(key);
                if (typeof target !== "string" || !kept.has(target)) this.#d.store.delete(key);
              }
              this.#dropToken();
              const fresh = newRecord(this.#d.computerId, d.createdAt);
              this.#d.store.put(RECORD_KEY, {
                ...fresh,
                name: d.name,
                lifecycle: d.lifecycle,
                lastReserved: d.lastReserved,
                releases: d.releases,
                // The tombstones outlive the records: a late write is still deleted. So does the
                // sweep of the computer's prefixes, starting now.
                credentialSweeps: d.credentialSweeps,
                prefixSweepAt: this.#now(),
              });
            }),
          );
          this.#log("removed", {});
          return true;
        }
      }
    } catch (error) {
      this.#log("deletion_trouble", { phase: deletion.phase, error: describe(error) });
      return false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The computer API's commands (WorkspaceDO → supervisor, port 8090).

  #envelope(r: ComputerRecord, operationId: string) {
    return {
      protocolVersion: SUPERVISOR_PROTOCOL_VERSION,
      computerId: this.#d.computerId,
      generation: r.lifecycle.generation,
      operationId,
    };
  }

  /**
   * One command, repeated unchanged after "Network connection lost." (S3): every command is safe
   * to repeat (3.C's `COMPUTER_API_MESSAGES`). The body may hold a launch token: never logged.
   */
  async #command<T extends WorkspaceCommand>(
    command: T,
  ): Promise<Extract<WorkspaceCommandReply, { type: T["type"] }>> {
    const port = this.#d.port;
    if (port === null) throw platformError("unavailable", "no container");
    const body = JSON.stringify(command);
    for (let attempt = 0; ; attempt += 1) {
      const deadline = this.#d.deadline(this.#t.commandTimeoutMs);
      try {
        const response = await port.fetch(
          SUPERVISOR_API_PORT,
          new Request(SUPERVISOR_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: deadline.signal,
          }),
        );
        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw platformError("internal", `the supervisor's ${command.type} reply is not JSON`);
        }
        if (!response.ok) {
          const error = ErrorBody.safeParse(json);
          throw platformError(
            error.success ? error.data.error.code : "internal",
            `the supervisor refused ${command.type} (${response.status})`,
          );
        }
        const reply = WorkspaceCommandReply.safeParse(json);
        if (!reply.success || reply.data.type !== command.type) {
          throw platformError("internal", `the supervisor's ${command.type} reply is malformed`);
        }
        return reply.data as Extract<WorkspaceCommandReply, { type: T["type"] }>;
      } catch (error) {
        if (isConnectionLostError(error) && attempt < this.#t.commandRetries) continue;
        if (errorCodeOf(error) === undefined)
          this.#log("command_failed", { type: command.type, error: describe(error) });
        throw error;
      } finally {
        deadline.clear();
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The alarm's schedule.

  async #schedule(): Promise<void> {
    const r = this.#load();
    if (r === null) {
      await this.#d.alarm.clear();
      return;
    }
    const now = this.#now();
    const t = this.#t;
    const ctx = r.lifecycle.context;
    const times: number[] = [];
    if (containerMayRun(ctx.state)) times.push(now + t.heartbeatMs);
    if (ctx.state === "waking" && r.start !== null) {
      times.push(
        r.start.startedAt === null
          ? r.start.nextAt
          : Math.min(now + t.pollMs, r.start.startedAt + t.startRefusedAfterMs),
      );
    }
    if (ctx.state === "stopping" && ctx.wakeQueued && this.#wakeRetryAt > now) {
      times.push(this.#wakeRetryAt);
    } else if (ctx.state === "stopping") {
      times.push(now + t.pollMs);
    }
    if (
      ctx.state === "restoring" ||
      r.capture !== null ||
      r.signOut.job !== null ||
      r.stopJob !== null ||
      r.params?.deliver === true
    ) {
      times.push(now + t.pollMs);
    }
    // Deadlines only while their action is eligible; a deferred one waits for what defers it.
    const terminalOpen =
      (r.terminalOpenUntil !== null && r.terminalOpenUntil > now) ||
      leaseActive(r.signIn, r.lifecycle.generation, now);
    const stopRetryAt = r.stopRefusedAt === null ? now : r.stopRefusedAt + t.heartbeatMs;
    if (r.noHostSince !== null && withoutHost(ctx.state)) {
      const deferred = restored(ctx.state) && (ctx.stopPrep !== null || terminalOpen);
      if (!deferred) times.push(Math.max(r.noHostSince + t.startDeadlineMs, stopRetryAt));
    }
    if (ctx.removalIntent && restored(ctx.state) && ctx.stopPrep === null) times.push(stopRetryAt);
    if (r.notSaved !== null) times.push(r.notSaved.nextRetryAt);
    if (r.saveRequests.length > 0 && r.capture === null) {
      times.push(Math.max(r.nextCaptureAt ?? now, now + t.pollMs));
    }
    if (
      r.releases.length > 0 ||
      r.orphans.length > 0 ||
      r.credentialDeletes.length > 0 ||
      r.credentialUploads.length > 0 ||
      r.deletion !== null ||
      r.reserving !== null
    ) {
      times.push(now + t.heartbeatMs);
    }
    for (const sweep of r.credentialSweeps) times.push(sweep.at);
    if (r.prefixSweepAt !== null) times.push(r.prefixSweepAt);
    if (terminalOpen && r.terminalOpenUntil !== null) times.push(r.terminalOpenUntil);
    // Sign-in (WP3.23): the lease's end, the attempts' checks, and cancels or starts to deliver.
    const lease = leaseUntil(r.signIn, r.lifecycle.generation, now);
    if (lease !== null) times.push(lease, now + (t.signInCheckMs ?? SIGN_IN_CHECK_MS));
    if (r.signIn.attempts.some((a) => a.cancel === "pending")) times.push(now + t.pollMs);
    if (times.length === 0) {
      await this.#d.alarm.clear();
      return;
    }
    // Never sooner than a second ahead, so no deadline can make the alarm spin.
    await this.#d.alarm.set(Math.max(now + MIN_ALARM_MS, Math.min(...times)));
  }
}
