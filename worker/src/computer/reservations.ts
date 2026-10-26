// Pure: a computer's capacity reservation, as WorkspaceDO owns it (design, "One controller per
// computer"). ControlDO holds only the slot, a (computer, generation) pair; the phases are here:
//
//   reserved ──▶ starting ──▶ running ──▶ releasing ──▶ (released)
//      └────────────┴─ fenced ─────────────────▲
//
// - `reserved`: capacity granted for this generation; no start attempted yet.
// - `starting`: the container start is in progress, including the start-after-stop retries, which
//   stay under the same generation and reservation (DC-37).
// - `running`: the container runs.
// - `releasing`: the container is being stopped; the slot is released once the stop is confirmed.
//
// An abandoned start is fenced before its capacity is reused: the generation is marked fenced, so
// a container that comes up late is refused and destroyed. A "stopped" observation never frees a
// reservation that is still `reserved` or `starting` until it is fenced (FH-02, FH-03, FH-21).

import type { ComputerId, ReservationPhase, ReservationState } from "@cfo/contracts";

export interface Reservation {
  readonly generation: number;
  readonly phase: ReservationPhase;
  /** The generation's start was abandoned: a late start refuses itself. */
  readonly fenced: boolean;
}

/** A slot granted by ControlDO for this generation. */
export function reserved(generation: number): Reservation {
  return { generation, phase: "reserved", fenced: false };
}

/** Whether a container may be started for `generation` under this reservation. */
export function mayStart(reservation: Reservation | null, generation: number): boolean {
  return (
    reservation !== null &&
    reservation.generation === generation &&
    !reservation.fenced &&
    (reservation.phase === "reserved" || reservation.phase === "starting")
  );
}

/** The start began (or is retried): `starting`. A fenced or released one never starts again. */
export function starting(reservation: Reservation): Reservation {
  if (!mayStart(reservation, reservation.generation)) {
    throw new Error(`no start under a ${reservation.phase} reservation`);
  }
  return { ...reservation, phase: "starting" };
}

/** The container runs. */
export function running(reservation: Reservation): Reservation {
  if (reservation.fenced) throw new Error("a fenced generation never runs");
  return { ...reservation, phase: "running" };
}

/** The start is abandoned: no container of this generation may run from now on. */
export function fence(reservation: Reservation): Reservation {
  return { ...reservation, fenced: true };
}

/**
 * The container is being stopped (or the start was given up). A reservation still `reserved` or
 * `starting` must be fenced first, so a late start cannot run unreserved.
 */
export function releasing(reservation: Reservation): Reservation {
  const unstarted = reservation.phase === "reserved" || reservation.phase === "starting";
  if (unstarted && !reservation.fenced) {
    throw new Error("an unfenced start never releases its reservation");
  }
  return { ...reservation, phase: "releasing" };
}

/**
 * Whether the slot may be given back to ControlDO now: only once the container is confirmed
 * stopped, or the start was fenced and no container runs.
 */
export function releasable(
  reservation: Reservation,
  observation: { readonly containerRunning: boolean; readonly stopConfirmed: boolean },
): boolean {
  if (observation.containerRunning) return false;
  return reservation.phase === "releasing" && (observation.stopConfirmed || reservation.fenced);
}

/** What ControlDO's reconciliation reads for the computer's current generation. */
export function reservationState(input: {
  readonly computerId: ComputerId;
  readonly generation: number;
  readonly reservation: Reservation | null;
  readonly containerRunning: boolean | null;
}): ReservationState {
  const current =
    input.reservation !== null && input.reservation.generation === input.generation
      ? input.reservation
      : null;
  return {
    computerId: input.computerId,
    generation: input.generation,
    phase: current?.phase ?? null,
    fenced: current?.fenced ?? false,
    containerRunning: input.containerRunning,
  };
}
