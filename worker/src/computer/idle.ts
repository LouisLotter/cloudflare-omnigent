// Pure: whether a computer may go to sleep now, the saves WorkspaceDO makes on its own, and the
// admission state it reports (design, Lifecycle steps 4 to 7; Checkpoints, "When saving fails").
//
// WorkspaceDO never stops a running computer on its own: Omnigent decides when it is idle and asks
// through `suspend`, and WorkspaceDO only refuses when stopping now could lose work or cut off a
// person (a capture running, the setup terminal open, a runner process alive). What it does on its
// own is save: the backstop save while runners exist and no request came for 15 minutes, and the
// "not saved" retries. A "no contact" notice after 60 minutes without a launcher call tells the
// person, and the page offers the explicit restart (FH-31).

import { type GuardInput, TIMING } from "@cfo/contracts";
import { retryDelayMs } from "./checkpoints.ts";

/**
 * Guard inputs for a `suspend`, from what WorkspaceDO knows: the setup terminal, and the runner
 * processes the supervisor reported. Unknown runner processes count as live: a sleep is refused
 * rather than risk ending a runner (Lifecycle step 7).
 */
export function sleepInputs(facts: {
  readonly terminalOpen: boolean;
  readonly runnerProcesses: number | null;
}): readonly GuardInput[] {
  const inputs: GuardInput[] = [];
  if (facts.terminalOpen) inputs.push("terminal_open");
  if (facts.runnerProcesses === null || facts.runnerProcesses > 0) inputs.push("runner_processes");
  return inputs;
}

/**
 * The backstop save (R-21): no save request for 15 minutes while the supervisor reports runner
 * processes, for example while Omnigent's server is unreachable. Counted from the last request,
 * the last backstop, or the generation's restore, whichever is latest.
 */
export function backstopDue(input: {
  readonly runnerProcesses: number | null;
  readonly lastRequestAt: number;
  readonly now: number;
  readonly backstopMs?: number;
}): boolean {
  const backstopMs = input.backstopMs ?? TIMING.backstopSaveS * 1000;
  return (input.runnerProcesses ?? 0) > 0 && input.now - input.lastRequestAt >= backstopMs;
}

/** Admission closed as "not saved", and when its save is retried next. */
export interface NotSaved {
  readonly since: number;
  readonly retries: number;
  readonly nextRetryAt: number;
}

/** Closes admission: the first retry after 1 minute. */
export function closeNotSaved(now: number, scheduleMs?: readonly number[]): NotSaved {
  return { since: now, retries: 0, nextRetryAt: now + retryDelayMs(0, scheduleMs) };
}

/** A retry started: the next one after 2, then every 5 minutes. */
export function retriedNotSaved(
  state: NotSaved,
  now: number,
  scheduleMs?: readonly number[],
): NotSaved {
  const retries = state.retries + 1;
  return { ...state, retries, nextRetryAt: now + retryDelayMs(retries, scheduleMs) };
}

/** What `admission` reports: only "not saved" closes it in version 1 (3.C, open question 4). */
export type Admission =
  | { readonly admitting: true }
  | { readonly admitting: false; readonly reason: "not_saved"; readonly message: string };

export const NOT_SAVED_MESSAGE =
  "This computer's files have not been saved for over 30 minutes. New work waits until a save succeeds.";

export function admissionOf(notSaved: NotSaved | null): Admission {
  return notSaved === null
    ? { admitting: true }
    : { admitting: false, reason: "not_saved", message: NOT_SAVED_MESSAGE };
}

/** The "no contact" notice: no launcher call of any kind for 60 minutes while awake (FH-31). */
export function noContact(
  lastContactAt: number | null,
  now: number,
  noContactMs: number = TIMING.noContactS * 1000,
): boolean {
  return lastContactAt !== null && now - lastContactAt >= noContactMs;
}

/** The inactivity timeout WorkspaceDO renews on every heartbeat and in every new instance. */
export const INACTIVITY_TIMEOUT_MS = TIMING.inactivityMarginS * 1000;
