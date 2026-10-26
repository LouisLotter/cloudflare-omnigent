// ControlDO (WP3.2): the installation's computers, limits and reservations, in the platform
// Worker. One object per installation (`CONTROL_OBJECT_NAME`).
//
// Its RPC surface is `ControlRpc` (`shared/rpc.ts`): one entry point, `control`, by method. Every
// call is parsed with the contract after its interface version is checked; every mutating call is
// journaled by operation ID in the same transaction as its effect, so a repeat returns the
// recorded outcome (an ID reused for another request is `conflict`). The decisions are in
// `limits.ts`; this class keeps them in SQLite and runs reconciliation from its alarm.
//
// Reconciliation (design, "Limits"). While any slot is held, the alarm runs every minute, and
// once soon after every new instance. It asks each slot holder's WorkspaceDO for its reservation
// (container state and startup intent), gives back the slots `judgeSlot` releases and counts the
// ones `adoption` finds uncounted; at most hourly it asks every registered computer, so a
// reservation ControlDO does not hold is rebuilt from actual state. It only ever calls
// `reservation`, which is read-only: ControlDO never stops, starts or wakes a computer, and never
// stops one to make room (FH-20).

import { DurableObject } from "cloudflare:workers";
import {
  CONTROL_INTERFACE_VERSION,
  type ComputerId,
  ControlCall,
  type ControlResult,
  ReservationState,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import type { PlatformEnv } from "../env.ts";
import { describeError, logEvent } from "../server/responses.ts";
import { platformError } from "../shared/errors.ts";
import { type ControlRpc, type WorkspaceRpc, workspaceObjectName } from "../shared/rpc.ts";
import { migrate } from "../shared/sql.ts";
import {
  decideRelease,
  decideReserve,
  FORGOTTEN_FLOOR,
  type LimitSettings,
  type Limits,
  MAX_COMPUTERS,
  NO_FLOOR,
  parseLimits,
  planReconciliation,
  type Report,
  type Slot,
  slotKey,
} from "./limits.ts";
import { CONTROL_MIGRATIONS } from "./schema.ts";

export interface ControlHealth {
  readonly schemaVersion: number;
  /** How many times this object has been constructed: increases after every eviction. */
  readonly boots: number;
}

/** What reconciliation asks of a computer's WorkspaceDO: its reservation, nothing else. */
export type ReservationSource = Pick<WorkspaceRpc, "reservation">;

export interface ControlTiming {
  /** Between reconciliations while any slot is held. */
  readonly reconcileIntervalMs: number;
  /** From a new instance to its first reconciliation. */
  readonly restartDelayMs: number;
  /** Between reconciliations that ask every registered computer, not only the slot holders. */
  readonly sweepIntervalMs: number;
  /** How long one WorkspaceDO may take to answer; a late answer counts as unreachable. */
  readonly reportTimeoutMs: number;
  /** How long an operation's outcome is kept for repeats: at least 7 days (conventions). */
  readonly journalRetentionMs: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export const CONTROL_TIMING: ControlTiming = {
  reconcileIntervalMs: MINUTE_MS,
  restartDelayMs: 5_000,
  sweepIntervalMs: 60 * MINUTE_MS,
  reportTimeoutMs: 10_000,
  journalRetentionMs: 8 * DAY_MS,
};

type Mutating = Extract<ControlCall, { readonly operationId: string }>;

/**
 * A call's outcome, as journaled: a result, or a refusal that stays true for good (a finished
 * generation never reopens), so a repeat is refused the same way and its operation ID stays bound
 * to its request. Other failures roll back and are not journaled.
 */
type Outcome =
  | { readonly result: ControlResult }
  | { readonly refused: "stale_generation"; readonly message: string };

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A new computer ID: 26 random Crockford base32 digits (130 bits). */
function mintComputerId(): ComputerId {
  let id = "cmp_";
  for (const byte of crypto.getRandomValues(new Uint8Array(26))) id += BASE32[byte & 31];
  return id;
}

/** A request's identity for the journal: its method and the fields this receiver acts on. */
function fingerprint(call: Mutating): string {
  switch (call.method) {
    case "register_computer":
      return JSON.stringify([call.method, call.name]);
    case "reserve":
    case "release":
      return JSON.stringify([call.method, call.computerId, call.generation]);
    case "forget_computer":
      return JSON.stringify([call.method, call.computerId]);
  }
}

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  logEvent("control", event, fields);
}

export class ControlDO extends DurableObject<PlatformEnv> implements ControlRpc {
  #schemaVersion = 0;
  #boots = 0;

  constructor(ctx: DurableObjectState, env: PlatformEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#schemaVersion = migrate(ctx.storage, CONTROL_MIGRATIONS);
      const row = ctx.storage.sql
        .exec<{ value: string }>(
          `INSERT INTO control_meta (key, value) VALUES ('boots', '1')
           ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
           RETURNING value`,
        )
        .one();
      this.#boots = Number(row.value);
      await this.#armAfterRestart();
    });
  }

  // -------------------------------------------------------------------------------------------
  // Hooks the Workers-runtime tests replace (test/support/platform-test-worker.ts).

  /** A computer's WorkspaceDO, for its reservation. Throws if it cannot be reached. */
  protected workspace(computerId: ComputerId): ReservationSource {
    // The WORKSPACE binding arrives with WorkspaceDO (WP3.1); until then no report can be read,
    // and reconciliation keeps every slot.
    const namespace = (this.env as { readonly WORKSPACE?: DurableObjectNamespace }).WORKSPACE;
    if (namespace === undefined) throw platformError("unavailable", "no WorkspaceDO binding");
    return namespace.getByName(workspaceObjectName(computerId)) as unknown as ReservationSource;
  }

  /** The installation's limit settings: Worker variables. */
  protected settings(): LimitSettings {
    return {
      CFO_MAX_AWAKE_COMPUTERS: this.env.CFO_MAX_AWAKE_COMPUTERS,
      CFO_MAX_INSTANCE_SIZE: this.env.CFO_MAX_INSTANCE_SIZE,
    };
  }

  protected now(): number {
    return Date.now();
  }

  protected timing(): ControlTiming {
    return CONTROL_TIMING;
  }

  // -------------------------------------------------------------------------------------------
  // RPC.

  async health(): Promise<ControlHealth> {
    return { schemaVersion: this.#schemaVersion, boots: this.#boots };
  }

  /** `ControlRpc`: the computers, the limits and the slots. Failures are `platformError` codes. */
  async control(raw: ControlCall): Promise<ControlResult> {
    // The version first: a newer caller's call may use a method this code does not know.
    const version = (raw as { readonly interfaceVersion?: unknown } | null | undefined)
      ?.interfaceVersion;
    if (typeof version === "number" && version > CONTROL_INTERFACE_VERSION) {
      throw platformError("unsupported_version", `interface version ${version}`);
    }
    const parsed = ControlCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a ControlCall");
    const call = parsed.data;
    const now = this.now();
    const outcome = this.ctx.storage.transactionSync(() => this.#answer(call, now));
    // A held slot keeps the reconciliation alarm set (persisted with the slot, then armed).
    if (call.method === "reserve") await this.#ensureAlarm(now);
    if ("refused" in outcome) throw platformError(outcome.refused, outcome.message);
    return outcome.result;
  }

  #answer(call: ControlCall, now: number): Outcome {
    switch (call.method) {
      case "list_computers":
        return {
          result: {
            method: "list_computers",
            computers: this.#sql<{ computer_id: ComputerId; name: string }>(
              "SELECT computer_id, name FROM computers ORDER BY created_at, computer_id",
            ).map((row) => ({ computerId: row.computer_id, name: row.name })),
          },
        };
      case "limits": {
        const limits = this.#limits();
        return {
          result: {
            method: "limits",
            maxAwakeComputers: limits.maxAwakeComputers,
            maxInstanceSize: limits.maxInstanceSize,
          },
        };
      }
      default:
        return this.#mutate(call, now);
    }
  }

  /** A mutating call through the journal, in the caller's transaction. */
  #mutate(call: Mutating, now: number): Outcome {
    this.#exec(
      "DELETE FROM operations WHERE created_at < ?",
      now - this.timing().journalRetentionMs,
    );
    const request = fingerprint(call);
    const recorded = this.#sql<{ request: string; result: string }>(
      "SELECT request, result FROM operations WHERE operation_id = ?",
      call.operationId,
    )[0];
    if (recorded !== undefined) {
      if (recorded.request !== request) {
        throw platformError("conflict", "operation ID reused for another request");
      }
      const outcome = JSON.parse(recorded.result) as Outcome;
      if (
        call.method === "reserve" &&
        "result" in outcome &&
        outcome.result.method === "reserve" &&
        outcome.result.granted &&
        !this.#held(call.computerId, call.generation)
      ) {
        // The slot this operation was granted has been released or superseded since: a replay
        // must not tell its caller it holds capacity it no longer has.
        return {
          refused: "stale_generation",
          message: "the slot granted to this operation was released",
        };
      }
      return outcome;
    }
    const outcome = this.#effect(call, now);
    this.#exec(
      "INSERT INTO operations (operation_id, request, result, created_at) VALUES (?, ?, ?, ?)",
      call.operationId,
      request,
      JSON.stringify(outcome),
      now,
    );
    return outcome;
  }

  #effect(call: Mutating, now: number): Outcome {
    switch (call.method) {
      case "register_computer": {
        const existing = this.#sql<{ computer_id: ComputerId }>(
          "SELECT computer_id FROM computers WHERE name = ?",
          call.name,
        )[0];
        if (existing !== undefined) {
          return { result: { method: "register_computer", computerId: existing.computer_id } };
        }
        if (this.#count("computers") >= MAX_COMPUTERS) {
          throw platformError(
            "conflict",
            `the installation already has ${MAX_COMPUTERS} computers`,
          );
        }
        const computerId = mintComputerId();
        this.#exec(
          "INSERT INTO computers (computer_id, name, created_at) VALUES (?, ?, ?)",
          computerId,
          call.name,
          now,
        );
        log("computer_registered", { computerId });
        return { result: { method: "register_computer", computerId } };
      }
      case "reserve": {
        const limits = this.#limits();
        const decision = decideReserve({
          slots: this.#slots(),
          floor: this.#floor(call.computerId),
          limit: limits.maxAwakeComputers,
          computerId: call.computerId,
          generation: call.generation,
        });
        if (decision.kind === "stale") {
          log("reserve_stale", { computerId: call.computerId, generation: call.generation });
          return {
            refused: "stale_generation",
            message: `generation ${call.generation} of this computer is already finished`,
          };
        }
        this.#raiseFloor(call.computerId, decision.floor);
        if (decision.kind === "refuse") {
          log("reserve_refused", {
            computerId: call.computerId,
            generation: call.generation,
            awake: decision.awake,
            limit: decision.limit,
          });
          return {
            result: {
              method: "reserve",
              granted: false,
              reason: "at_capacity",
              awake: decision.awake,
              limit: decision.limit,
            },
          };
        }
        if (decision.kind === "grant") {
          for (const old of decision.replaces) this.#dropSlot(old);
          this.#exec(
            "INSERT INTO slots (computer_id, generation, granted_at, adopted) VALUES (?, ?, ?, 0)",
            call.computerId,
            call.generation,
            now,
          );
          log("reserve_granted", {
            computerId: call.computerId,
            generation: call.generation,
            replaced: decision.replaces.map((s) => s.generation),
          });
        }
        return { result: { method: "reserve", granted: true } };
      }
      case "release": {
        const decision = decideRelease({
          slots: this.#slots(),
          floor: this.#floor(call.computerId),
          computerId: call.computerId,
          generation: call.generation,
        });
        if (decision.released) {
          this.#dropSlot({ computerId: call.computerId, generation: call.generation });
          log("released", { computerId: call.computerId, generation: call.generation });
        }
        this.#raiseFloor(call.computerId, decision.floor);
        return { result: { method: "release", released: decision.released } };
      }
      case "forget_computer": {
        const forgotten = this.#count("computers", "computer_id = ?", call.computerId) > 0;
        this.#exec("DELETE FROM computers WHERE computer_id = ?", call.computerId);
        this.#exec("DELETE FROM slots WHERE computer_id = ?", call.computerId);
        this.#raiseFloor(call.computerId, FORGOTTEN_FLOOR);
        log("computer_forgotten", { computerId: call.computerId, forgotten });
        return { result: { method: "forget_computer", forgotten } };
      }
    }
  }

  #limits(): Limits {
    const parsed = parseLimits(this.settings());
    if (!parsed.ok) {
      log("limits_invalid", { problem: parsed.problem });
      throw platformError("internal", parsed.problem);
    }
    return parsed.limits;
  }

  // -------------------------------------------------------------------------------------------
  // Reconciliation.

  override async alarm(): Promise<void> {
    const now = this.now();
    // The next one first, so a reconciliation cut short by a crash or a deploy still happens.
    if (this.#count("slots") > 0) {
      await this.ctx.storage.setAlarm(now + this.timing().reconcileIntervalMs);
    }
    await this.#reconcile(now);
    await this.#ensureAlarm(now);
  }

  async #reconcile(now: number): Promise<void> {
    const sweep = this.#sweepDue(now);
    const before = this.#slots();
    const targets = new Set(before.map((s) => s.computerId));
    if (sweep) for (const computerId of this.#computerIds()) targets.add(computerId);
    // Read every report before deciding anything: the calls let other requests in, so the
    // decisions are made afterwards, in one transaction, against the slots held then.
    const reports = new Map<ComputerId, Report>(
      await Promise.all(
        [...targets].map(async (id) => [id, await this.#report(id)] as [ComputerId, Report]),
      ),
    );
    this.ctx.storage.transactionSync(() => {
      const plan = planReconciliation({
        slots: this.#slots(),
        eligible: new Set(before.map(slotKey)),
        reports,
        floors: new Map([...targets].map((id) => [id, this.#floor(id)])),
        registered: new Set(this.#computerIds()),
      });
      for (const slot of plan.release) {
        this.#dropSlot(slot);
        this.#raiseFloor(slot.computerId, slot.generation);
        log("reconciled_release", { ...slot, report: summary(reports.get(slot.computerId)) });
      }
      for (const slot of plan.adopt) {
        this.#exec(
          "INSERT INTO slots (computer_id, generation, granted_at, adopted) VALUES (?, ?, ?, 1)",
          slot.computerId,
          slot.generation,
          now,
        );
        log("reconciled_adopt", { ...slot, report: summary(reports.get(slot.computerId)) });
      }
      if (sweep) this.#setMeta("last_sweep_at", String(now));
    });
  }

  /** A WorkspaceDO's report, or `unreachable` if it fails, is late or breaks the contract. */
  async #report(computerId: ComputerId): Promise<Report> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const source = this.workspace(computerId);
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("no answer in time")),
          this.timing().reportTimeoutMs,
        );
      });
      const raw = await Promise.race([
        source.reservation({ interfaceVersion: WORKSPACE_INTERFACE_VERSION }),
        late,
      ]);
      const parsed = ReservationState.nullable().safeParse(raw);
      if (!parsed.success) {
        log("report_invalid", { computerId });
        return "unreachable";
      }
      if (parsed.data !== null && parsed.data.computerId !== computerId) {
        log("report_for_another_computer", { computerId });
      }
      return parsed.data;
    } catch (error) {
      log("report_failed", { computerId, error: describeError(error) });
      return "unreachable";
    } finally {
      // A pending timer would keep the object in memory after the alarm.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #sweepDue(now: number): boolean {
    const last = this.#meta("last_sweep_at");
    return last === undefined || now - Number(last) >= this.timing().sweepIntervalMs;
  }

  /** Every new instance: a reconciliation soon, if there is anything to reconcile. */
  async #armAfterRestart(): Promise<void> {
    const now = this.now();
    const due = this.#count("slots") > 0 || (this.#count("computers") > 0 && this.#sweepDue(now));
    if (!due) return;
    const at = now + this.timing().restartDelayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  /** While any slot is held, an alarm is set. */
  async #ensureAlarm(now: number): Promise<void> {
    if (this.#count("slots") === 0) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + this.timing().reconcileIntervalMs);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Storage.

  #sql<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }

  #exec(query: string, ...bindings: unknown[]): void {
    this.ctx.storage.sql.exec(query, ...bindings);
  }

  #count(table: "computers" | "slots", where = "1 = 1", ...bindings: unknown[]): number {
    return this.ctx.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...bindings)
      .one().n;
  }

  #slots(): Slot[] {
    return this.#sql<{ computer_id: ComputerId; generation: number }>(
      "SELECT computer_id, generation FROM slots ORDER BY granted_at, computer_id, generation",
    ).map((row) => ({ computerId: row.computer_id, generation: row.generation }));
  }

  #held(computerId: ComputerId, generation: number): boolean {
    return this.#count("slots", "computer_id = ? AND generation = ?", computerId, generation) > 0;
  }

  #dropSlot(slot: Slot): void {
    this.#exec(
      "DELETE FROM slots WHERE computer_id = ? AND generation = ?",
      slot.computerId,
      slot.generation,
    );
  }

  #computerIds(): ComputerId[] {
    return this.#sql<{ computer_id: ComputerId }>("SELECT computer_id FROM computers").map(
      (row) => row.computer_id,
    );
  }

  #floor(computerId: ComputerId): number {
    return (
      this.#sql<{ floor: number }>("SELECT floor FROM floors WHERE computer_id = ?", computerId)[0]
        ?.floor ?? NO_FLOOR
    );
  }

  /** Floors only rise. */
  #raiseFloor(computerId: ComputerId, floor: number): void {
    this.#exec(
      `INSERT INTO floors (computer_id, floor) VALUES (?, ?)
       ON CONFLICT (computer_id) DO UPDATE SET floor = MAX(floor, excluded.floor)`,
      computerId,
      floor,
    );
  }

  #meta(key: string): string | undefined {
    return this.#sql<{ value: string }>("SELECT value FROM control_meta WHERE key = ?", key)[0]
      ?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#exec(
      `INSERT INTO control_meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}

/** A report for a log line: its reservation fields only. */
function summary(report: Report | undefined): unknown {
  if (report === undefined || report === "unreachable" || report === null) return report ?? null;
  return {
    generation: report.generation,
    phase: report.phase,
    fenced: report.fenced,
    containerRunning: report.containerRunning,
  };
}
