// Pure: the installation's capacity (WP3.2; design, "Limits" and "One controller per computer").
//
// ControlDO holds the slots: a set of (computer, generation) pairs within the limit of awake
// computers. WorkspaceDO alone owns each reservation's phases (reserved, starting, running,
// releasing) and reports them through `reservation`. This module decides, without any I/O:
//   - a reservation: the same answer for a slot already held; refused at once at the limit, with
//     the counts and no queue (R-20); never by stopping another computer (FH-20);
//   - a release: idempotent;
//   - reconciliation: which slots to give back, and which to rebuild, from WorkspaceDO's report of
//     its container and its startup intent. A slot is given back only once its container is
//     confirmed stopped or its start fenced out, so a lost reply can neither leak a slot nor free
//     one that a delayed start could still use.
//
// Generations. WorkspaceDO persists a generation before it asks for it, never asks for one twice,
// and asks for a newer one only once every older one is confirmed stopped, fenced or given up
// (one container per computer). So once a computer asks for generation G, or releases it, every
// older generation of that computer is finished. ControlDO keeps that as a per-computer floor:
//   - a reservation at or below the floor is stale (a delayed or replayed request for a generation
//     its computer already gave up), and is refused instead of taking a slot nobody would start or
//     release (FH-03);
//   - a granted reservation replaces the computer's older slots, so a wake never competes with its
//     own stopped generation, and one computer holds at most one slot;
//   - a forgotten computer's floor is the highest generation there is.

import { type ComputerId, InstanceSize, type ReservationState } from "@cfo/contracts";

export interface Slot {
  readonly computerId: ComputerId;
  readonly generation: number;
}

export interface Limits {
  /** How many computers may be awake at once. */
  readonly maxAwakeComputers: number;
  /** The largest instance size a computer may start with. */
  readonly maxInstanceSize: InstanceSize;
}

/** Used when the installation sets nothing: two awake computers, any size. */
export const DEFAULT_LIMITS: Limits = { maxAwakeComputers: 2, maxInstanceSize: "standard-4" };

/** The most computers an installation records: `list_computers` answers at most this many. */
export const MAX_COMPUTERS = 1000;

/** The floor of a computer that has asked for nothing: every generation is still open. */
export const NO_FLOOR = -1;

/** The floor of a forgotten computer: no generation of it may take a slot again. */
export const FORGOTTEN_FLOOR = Number.MAX_SAFE_INTEGER;

/** The Worker variables that set the limits; unset means the default. */
export interface LimitSettings {
  readonly CFO_MAX_AWAKE_COMPUTERS?: unknown;
  readonly CFO_MAX_INSTANCE_SIZE?: unknown;
}

export type ParsedLimits =
  | { readonly ok: true; readonly limits: Limits }
  | { readonly ok: false; readonly problem: string };

/**
 * The installation's limits from its settings. A setting that is present but invalid is an error,
 * never a silent default: a wrong cap could overspend, so the wake fails visibly instead.
 */
export function parseLimits(settings: LimitSettings): ParsedLimits {
  let maxAwakeComputers = DEFAULT_LIMITS.maxAwakeComputers;
  const awake = settings.CFO_MAX_AWAKE_COMPUTERS;
  if (awake !== undefined && awake !== "") {
    const text = typeof awake === "number" ? String(awake) : awake;
    if (typeof text !== "string" || !/^\d{1,4}$/.test(text) || Number(text) > MAX_COMPUTERS) {
      return {
        ok: false,
        problem: `CFO_MAX_AWAKE_COMPUTERS must be a whole number from 0 to ${MAX_COMPUTERS}`,
      };
    }
    maxAwakeComputers = Number(text);
  }
  let maxInstanceSize = DEFAULT_LIMITS.maxInstanceSize;
  const size = settings.CFO_MAX_INSTANCE_SIZE;
  if (size !== undefined && size !== "") {
    const parsed = InstanceSize.safeParse(size);
    if (!parsed.success) {
      return {
        ok: false,
        problem: `CFO_MAX_INSTANCE_SIZE must be one of ${InstanceSize.options.join(", ")}`,
      };
    }
    maxInstanceSize = parsed.data;
  }
  return { ok: true, limits: { maxAwakeComputers, maxInstanceSize } };
}

// ---------------------------------------------------------------------------------------------
// Reservations and releases.

export type ReserveDecision =
  /** The slot is already held: the same answer, granted. */
  | { readonly kind: "held"; readonly floor: number }
  /** At or below the computer's floor: a generation its computer has already finished. */
  | { readonly kind: "stale"; readonly floor: number }
  /** Granted. `replaces` are the computer's older slots, which this one supersedes. */
  | { readonly kind: "grant"; readonly floor: number; readonly replaces: readonly Slot[] }
  /** At the limit: refused at once, with the counts. Nothing is queued. */
  | {
      readonly kind: "refuse";
      readonly floor: number;
      readonly awake: number;
      readonly limit: number;
    };

/**
 * A reservation for (computer, generation), given every slot held, the computer's floor and the
 * limit. Only other computers' slots count against the limit: the computer's own older slots are
 * finished generations whose releases may still be on their way.
 */
export function decideReserve(input: {
  readonly slots: readonly Slot[];
  readonly floor: number;
  readonly limit: number;
  readonly computerId: ComputerId;
  readonly generation: number;
}): ReserveDecision {
  const { slots, computerId, generation } = input;
  // Asking for G finishes every older generation of this computer, whatever the answer.
  const floor = Math.max(input.floor, generation - 1);
  if (slots.some((s) => s.computerId === computerId && s.generation === generation)) {
    return { kind: "held", floor };
  }
  if (generation <= input.floor) return { kind: "stale", floor: input.floor };
  const replaces = slots.filter((s) => s.computerId === computerId && s.generation < generation);
  const competing = slots.length - replaces.length;
  if (competing >= input.limit) {
    return { kind: "refuse", floor, awake: competing, limit: input.limit };
  }
  return { kind: "grant", floor, replaces };
}

/** A release of (computer, generation): idempotent, and it finishes that generation for good. */
export function decideRelease(input: {
  readonly slots: readonly Slot[];
  readonly floor: number;
  readonly computerId: ComputerId;
  readonly generation: number;
}): { readonly released: boolean; readonly floor: number } {
  return {
    released: input.slots.some(
      (s) => s.computerId === input.computerId && s.generation === input.generation,
    ),
    floor: Math.max(input.floor, input.generation),
  };
}

// ---------------------------------------------------------------------------------------------
// Reconciliation.

/**
 * What WorkspaceDO said when asked for its reservation: its report (null when it holds no
 * computer record), or `unreachable` when the call failed, timed out or answered something that
 * is not a `ReservationState`.
 */
export type Report = ReservationState | null | "unreachable";

export type Verdict = "keep" | "release";

/**
 * Whether a held slot may be given back, from its computer's report. Anything uncertain keeps it:
 * a slot freed too early lets a delayed start run unreserved, while one kept too long only refuses
 * a wake until the next reconciliation.
 */
export function judgeSlot(slot: Slot, report: Report): Verdict {
  if (report === "unreachable") return "keep";
  // No computer record: nothing can start under the slot (its removal was resolved).
  if (report === null) return "release";
  if (report.computerId !== slot.computerId) return "keep";
  // The grant may still be on its way to WorkspaceDO, which then starts under it; a generation it
  // gave up instead is released by WorkspaceDO itself.
  if (report.generation < slot.generation) return "keep";
  // A newer generation was reserved, which happens only once this one was confirmed stopped or
  // fenced (one container per computer); a running container is the newer generation's.
  if (report.generation > slot.generation) return "release";
  if (report.containerRunning === true) return "keep";
  // WorkspaceDO dropped the reservation: it does so only once the stop is confirmed.
  if (report.phase === null) return "release";
  // The start was fenced out and no container runs: a late start refuses itself.
  if (report.fenced && report.containerRunning === false) return "release";
  // Reserved, starting, running or releasing: the start may still come (a "stopped" observation
  // never frees a reservation that is reserved or starting), or the stop is not yet confirmed.
  return "keep";
}

/**
 * The slot a computer's report shows it holds, if ControlDO does not hold it: WorkspaceDO's
 * startup intent names a reservation for its current generation, which must be counted (one
 * reservation per live container). Never at or below the computer's floor, so a report read
 * before a release cannot bring the released slot back.
 */
export function adoption(
  computerId: ComputerId,
  report: Report,
  held: readonly Slot[],
  floor: number,
): Slot | null {
  if (report === "unreachable" || report === null) return null;
  if (report.computerId !== computerId || report.phase === null) return null;
  const slot = { computerId, generation: report.generation };
  if (slot.generation <= floor) return null;
  if (held.some((s) => s.computerId === computerId && s.generation === slot.generation)) {
    return null;
  }
  return judgeSlot(slot, report) === "keep" ? slot : null;
}

export interface ReconciliationPlan {
  readonly release: readonly Slot[];
  readonly adopt: readonly Slot[];
}

/**
 * One reconciliation over the slots held now. `eligible` are the slots that were already held when
 * the reports were asked for: only those may be released, since a report cannot describe a slot
 * granted after it was read. `floors` and `registered` are read now too; a computer neither
 * registered nor holding a slot is not adopted.
 */
export function planReconciliation(input: {
  readonly slots: readonly Slot[];
  readonly eligible: ReadonlySet<string>;
  readonly reports: ReadonlyMap<ComputerId, Report>;
  readonly floors: ReadonlyMap<ComputerId, number>;
  readonly registered: ReadonlySet<ComputerId>;
}): ReconciliationPlan {
  const release: Slot[] = [];
  for (const slot of input.slots) {
    if (!input.eligible.has(slotKey(slot))) continue;
    // Not asked (a slot granted meanwhile is not eligible anyway): unknown, so kept.
    const report = input.reports.has(slot.computerId)
      ? (input.reports.get(slot.computerId) as Report)
      : "unreachable";
    if (judgeSlot(slot, report) === "release") release.push(slot);
  }
  const adopt: Slot[] = [];
  for (const [computerId, report] of input.reports) {
    const held = input.slots.filter((s) => s.computerId === computerId);
    if (held.length === 0 && !input.registered.has(computerId)) continue;
    const floor = input.floors.get(computerId) ?? NO_FLOOR;
    const slot = adoption(computerId, report, held, floor);
    if (slot !== null) adopt.push(slot);
  }
  return { release, adopt };
}

/** A slot's key, for sets of slots. */
export function slotKey(slot: Slot): string {
  return `${slot.computerId}/${slot.generation}`;
}
