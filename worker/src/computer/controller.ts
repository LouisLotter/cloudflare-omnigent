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

import {
  CHECKPOINT_POLICY_V1,
  COMPUTER_START_ENV,
  CONTROL_INTERFACE_VERSION,
  ComputerCall,
  type ComputerId,
  type ComputerPageState,
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
  type InterceptProps,
  LAUNCHER_OPERATIONS,
  LauncherCall,
  type LauncherRequest,
  type LauncherResult,
  type LifecycleEvent,
  PagesCall,
  type PagesResult,
  type Reply,
  type ReservationState,
  ruleFor,
  SIGN_OUT_TABLE,
  SUPERVISOR_API_PORT,
  SUPERVISOR_COMMANDS_PATH,
  SUPERVISOR_PROTOCOL_VERSION,
  SUPPORTED_INTERCEPT_PROPS_VERSIONS,
  SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS,
  SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS,
  type SupervisorMessage,
  type SupervisorReply,
  type SupervisorReport,
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
import type { ControlRpc } from "../shared/rpc.ts";
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
import { chooseSize, sizeForStart, workspaceSizeWarning } from "./sizing.ts";

// ---------------------------------------------------------------------------------------------
// Dependencies.

/** The checkpoint bucket's credential bundles (R2 in production). */
export interface CheckpointBucket {
  put(key: string, body: Uint8Array): Promise<void>;
  /** The object's bytes, or null if it does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  /** Deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
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
  readonly commandTimeoutMs: number;
  /** Repeats of a command after "Network connection lost." (S3): every command is safe to repeat. */
  readonly commandRetries: number;
  /** Consecutive transient restore failures before the restore counts as failed. */
  readonly restoreFailures: number;
  readonly operationRecordMs: number;
}

export const CONTROLLER_TIMING: ControllerTiming = {
  heartbeatMs: TIMING.heartbeatS * 1000,
  pollMs: 2_000,
  startRefusedAfterMs: TIMING.startRefusedAfterS * 1000,
  startRetryDelaysMs: TIMING.startRetryDelaysS.map((s) => s * 1000),
  startDeadlineMs: TIMING.startDeadlineS * 1000,
  inactivityTimeoutMs: INACTIVITY_TIMEOUT_MS,
  uploadDeadlineMs: TIMING.uploadDeadlineS * 1000,
  restoreLayerDeadlineMs: 300_000,
  captureDeadlineMs: (TIMING.uploadDeadlineS + 300) * 1000,
  backstopMs: TIMING.backstopSaveS * 1000,
  notSavedMs: TIMING.notSavedS * 1000,
  retryMs: TIMING.notSavedRetryS.map((s) => s * 1000),
  noContactMs: TIMING.noContactS * 1000,
  credentialBarrierMs: 120_000,
  signOutMs: 300_000,
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
  /** The computer's intercepts for these props: `omnigent.internal`, `computer.internal` (3.3). */
  readonly intercepts: (props: InterceptProps) => readonly InterceptTarget[];
  readonly timing?: ControllerTiming;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
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

function isMissingLayer(error: unknown): boolean {
  const message = describe(error).toLowerCase();
  return message.includes("backup_not_found") || message.includes("not found");
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
  /** The layer restore in flight, aborted when its restore is abandoned (a stop, a removal). */
  #restoreAbort: AbortController | null = null;

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
          this.#log("removal_intent", { generation });
          break;
        case "accept_save_request":
        case "fold_save_request":
          if (extra.request !== undefined) {
            d.saveRequests.push(extra.request);
            d.lastRequestAt = now;
            // The next save covers every pending request, so only a bounded number are kept:
            // the oldest the running capture does not cover go first (R-18 still holds).
            const running = new Set(d.capture?.covers ?? []);
            while (d.saveRequests.length > MAX_PENDING_SAVES) {
              const drop = d.saveRequests.findIndex((x) => !running.has(x.id));
              d.saveRequests.splice(drop < 0 ? 0 : drop, 1);
            }
          }
          break;
        case "publish_credentials":
          break;
        case "run_sign_out":
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
    unavailable: "throw" | "at_capacity" = "throw",
    commit: (d: ComputerRecord, reply: Reply | undefined) => void = () => undefined,
  ): Promise<Reply | undefined> {
    const r = this.#require();
    const apply = (d: ComputerRecord, f: Facts, x: Extra) => {
      const t = this.#step(d, event, f, x);
      commit(d, t.reply);
      return t;
    };
    if (!wouldReserve(r.lifecycle, event, guardInputs(facts))) {
      return this.#write((d) => apply(d, facts, extra).reply);
    }
    if (r.releases.length >= MAX_PENDING_RELEASES) {
      // ControlDO has not acknowledged earlier releases: ask for no new slot until it has.
      if (unavailable === "throw") {
        throw platformError(
          "unavailable",
          "the computer's capacity could not be checked; try again",
        );
      }
      return this.#write((d) => apply(d, { ...facts, atCapacity: true }, extra).reply);
    }
    const generation = Math.max(r.lifecycle.generation, r.lastReserved) + 1;
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
      if (unavailable === "throw") {
        throw platformError(
          "unavailable",
          "the computer's capacity could not be checked; try again",
        );
      }
      return this.#write((d) => apply(d, { ...facts, atCapacity: true }, extra).reply);
    }
    const granted = result.method === "reserve" && result.granted;
    if (granted) await this.#refreshLimits();
    return this.#write((d) => {
      d.reserving = null;
      if (!granted) return apply(d, { ...facts, atCapacity: true }, extra).reply;
      const t = apply(d, facts, { ...extra, reservedGeneration: generation });
      if (!t.effects.includes("reserve")) {
        d.releases.push({ generation, operationId: this.#d.newId("op") });
      }
      return t.reply;
    });
  }

  async #refreshLimits(): Promise<void> {
    try {
      const limits = await this.#d.control.control({
        method: "limits",
        interfaceVersion: CONTROL_INTERFACE_VERSION,
      });
      if (limits.method === "limits") {
        this.#write((d) => {
          d.maxSize = limits.maxInstanceSize;
        });
      }
    } catch (error) {
      this.#log("limits_failed", { error: describe(error) });
    }
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
          for (const u of d.credentialUploads) {
            d.credentialDeletes.push(credentialObjectKey(this.#d.computerId, u.checkpointId));
          }
          d.credentialUploads = [];
        });
      }
      this.#renewTimeout = true;
      this.#propsKey = null;
    });
    this.#kick();
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
        const reply = await this.#reserving("resume", {});
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
   */
  async #suspend(operationId: string, fingerprint: string): Promise<LauncherResult> {
    const r = this.#require();
    const ctx = r.lifecycle.context;
    const now = this.#now();
    const terminalOpen = r.terminalOpenUntil !== null && r.terminalOpenUntil > now;
    // Only the supervisor's answer now can show no runner exists (Lifecycle step 7). If it cannot
    // answer, a cached positive count still refuses, but a cached zero proves nothing: unknown.
    const cached = this.#currentReport(r)?.runnerProcesses ?? null;
    let runners: number | null = cached !== null && cached > 0 ? cached : null;
    if (restored(ctx.state) && ctx.stopPrep === null && !ctx.capturing && !terminalOpen) {
      const fresh = await this.#freshReport(r);
      if (fresh !== null) runners = fresh.runnerProcesses;
    }
    const inputs = sleepInputs({ terminalOpen, runnerProcesses: runners });
    return this.#write((d) => {
      const reply = this.#step(d, "suspend", {
        terminalOpen: inputs.includes("terminal_open"),
        runnerProcesses: inputs.includes("runner_processes"),
      }).reply;
      let result: LauncherResult;
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
        d.credentialDeletes.push(credentialObjectKey(this.#d.computerId, u.checkpointId));
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
      await bucket.put(manifest.object.key, object);
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
      },
      // Additive fields (the schema is loose): the page's notices.
      noContact: !ctx.removalIntent && noContact(r.lastContactAt, now, this.#t.noContactMs),
      sizeWarning: workspaceSizeWarning(r.workspaceBytes),
      stopWithoutSavingOffered: r.refusedSleeps >= TIMING.refusedSleepsBeforeStopWithoutSaving,
    };
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
    if (r.lifecycle.context.state === "removed") return this.#advanceDeletion(r, port);
    if (port !== null) {
      if (await this.#observe(r, port)) return true;
      if (await this.#rearm(r, port)) return true;
      const state = r.lifecycle.context.state;
      if (state === "waking") {
        if (await this.#advanceStart(r, port)) return true;
      } else if (state === "restoring") {
        if (await this.#advanceRestore(r, port)) return true;
      } else if (state === "stopping") {
        if (await this.#advanceStopping(r, port)) return true;
      } else if (restored(state)) {
        if (await this.#advanceDeliver(r)) return true;
        if (await this.#advanceSaves(r, port)) return true;
        if (await this.#advanceStopJob(r)) return true;
        if (await this.#advanceSignOut(r)) return true;
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
      const terminalOpen = d.terminalOpenUntil !== null;
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
  async #observe(r: ComputerRecord, port: ComputerContainerPort): Promise<boolean> {
    const state = r.lifecycle.context.state;
    const running = port.running;
    if (expectsContainer(state) && !running) {
      const old = r.reservation;
      if (state === "stopping" && r.lifecycle.context.wakeQueued && old !== null) {
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
          this.#log("release_failed", { generation: old.generation, error: describe(error) });
        }
      }
      await this.#exclusive(() => this.#reserving("container_stopped", {}, {}, "at_capacity"));
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
      await this.#registerIntercepts(r, port);
      const go = await this.#exclusive(() =>
        this.#write((d) => {
          if (d.lifecycle.context.state !== "waking" || d.start?.startedAt !== null) return false;
          if (d.reservation === null || !mayStart(d.reservation, generation)) return false;
          d.start = { ...d.start, startedAt: now };
          d.reservation = starting(d.reservation);
          return true;
        }),
      );
      if (!go) return true;
      try {
        port.start({
          instance: r.size,
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
            backup = await port.backup({
              dir: staged.layerDir,
              name: c.layerId,
              prefix: workspaceBackupPrefix(this.#d.computerId),
              signal: deadline.signal,
            });
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
    return false;
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
              for (const u of d.credentialUploads) {
                d.credentialDeletes.push(credentialObjectKey(this.#d.computerId, u.checkpointId));
              }
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
              for (const key of this.#d.store.keys(OPERATION_PREFIX)) this.#d.store.delete(key);
              for (const key of this.#d.store.keys(OPERATION_TIME_PREFIX))
                this.#d.store.delete(key);
              this.#dropToken();
              const fresh = newRecord(this.#d.computerId, d.createdAt);
              this.#d.store.put(RECORD_KEY, {
                ...fresh,
                name: d.name,
                lifecycle: d.lifecycle,
                lastReserved: d.lastReserved,
                releases: d.releases,
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
    if (
      ctx.state === "restoring" ||
      ctx.state === "stopping" ||
      r.capture !== null ||
      r.signOut.job !== null ||
      r.stopJob !== null ||
      r.params?.deliver === true
    ) {
      times.push(now + t.pollMs);
    }
    // Deadlines only while their action is eligible; a deferred one waits for what defers it.
    const terminalOpen = r.terminalOpenUntil !== null && r.terminalOpenUntil > now;
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
    if (terminalOpen && r.terminalOpenUntil !== null) times.push(r.terminalOpenUntil);
    if (times.length === 0) {
      await this.#d.alarm.clear();
      return;
    }
    // Never sooner than a second ahead, so no deadline can make the alarm spin.
    await this.#d.alarm.set(Math.max(now + MIN_ALARM_MS, Math.min(...times)));
  }
}
