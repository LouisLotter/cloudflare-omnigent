// Pure: WorkspaceDO's lifecycle, as 3.C's state × event table fixes it (`LIFECYCLE_TABLE` and its
// reference interpreter `step`, in @cfo/contracts). Saving is a flag, not a state (R-19).
//
// This module adds what the table leaves to 3.1: the runtime generation and the start attempt
// counter that ride along with the table's context, the guard inputs WorkspaceDO decides when an
// event arrives, and the launcher's answers built from the table's replies. Every transition goes
// through `transition`, so the controller and its tests read one table.

import {
  containerMayRun,
  type Effect,
  type GuardInput,
  type HostSandboxStatus,
  INITIAL_CONTEXT,
  type LifecycleEvent,
  type LifecycleState,
  type MachineContext,
  RESTORED_STATES,
  type Reply,
  ruleFor,
  step,
  typedStatus,
} from "@cfo/contracts";

/** The table's context, with the generation and the latest claimed start attempt. */
export interface Lifecycle {
  readonly context: MachineContext;
  /** The latest generation: increases with every reservation for a new container start. */
  readonly generation: number;
  /** The latest claimed start attempt; 0 before the first claim. Never decreases. */
  readonly attempt: number;
}

export const INITIAL_LIFECYCLE: Lifecycle = { context: INITIAL_CONTEXT, generation: 0, attempt: 0 };

/** Facts from outside the table that WorkspaceDO decides when an event arrives. */
export interface Facts {
  readonly atCapacity?: boolean;
  readonly attemptCurrent?: boolean;
  readonly terminalOpen?: boolean;
  readonly runnerProcesses?: boolean;
  readonly retriesLeft?: boolean;
  readonly sleepsRefusedThrice?: boolean;
  readonly signOutSettled?: boolean;
}

export function guardInputs(facts: Facts): ReadonlySet<GuardInput> {
  const inputs = new Set<GuardInput>();
  if (facts.atCapacity) inputs.add("at_capacity");
  if (facts.attemptCurrent) inputs.add("attempt_current");
  if (facts.terminalOpen) inputs.add("terminal_open");
  if (facts.runnerProcesses) inputs.add("runner_processes");
  if (facts.retriesLeft) inputs.add("retries_left");
  if (facts.sleepsRefusedThrice) inputs.add("sleeps_refused_thrice");
  if (facts.signOutSettled) inputs.add("sign_out_settled");
  return inputs;
}

/**
 * Whether this event, given room, would take a new reservation. WorkspaceDO asks ControlDO first
 * (persisting the generation it asks for), then applies the event with `at_capacity` if refused.
 */
export function wouldReserve(
  lifecycle: Lifecycle,
  event: LifecycleEvent,
  inputs: ReadonlySet<GuardInput>,
): boolean {
  const withRoom = new Set([...inputs].filter((input) => input !== "at_capacity"));
  return ruleFor(lifecycle.context, event, withRoom).effects?.includes("reserve") ?? false;
}

export interface Transition {
  readonly lifecycle: Lifecycle;
  readonly reply: Reply | undefined;
  readonly effects: readonly Effect[];
}

/**
 * One event through the table. A reservation's effects carry the generation WorkspaceDO reserved
 * (`reservedGeneration`, which must be newer than the current one); a granted claim records the
 * next attempt.
 */
export function transition(
  lifecycle: Lifecycle,
  event: LifecycleEvent,
  inputs: ReadonlySet<GuardInput>,
  reservedGeneration?: number,
): Transition {
  const result = step(lifecycle.context, event, inputs);
  let { generation, attempt } = lifecycle;
  if (result.effects.includes("reserve")) {
    if (reservedGeneration === undefined || reservedGeneration <= generation) {
      throw new Error(`${event} reserves without a newer generation`);
    }
    generation = reservedGeneration;
  }
  if (result.effects.includes("record_attempt")) attempt += 1;
  return {
    lifecycle: { context: result.context, generation, attempt },
    reply: result.reply,
    effects: result.effects,
  };
}

/** The typed status Omnigent sees (R-02), and `is_running`'s answer. */
export function statusOf(lifecycle: Lifecycle): {
  readonly status: HostSandboxStatus;
  readonly running: boolean;
} {
  const { state } = lifecycle.context;
  return {
    status: typedStatus(lifecycle.context),
    running: containerMayRun(state) && state !== "waking",
  };
}

/** States in which the container should be running (it is being restored, or restored). */
export function expectsContainer(state: LifecycleState): boolean {
  return state === "restoring" || RESTORED_STATES.includes(state) || state === "stopping";
}

/** States without a host incarnation, which the start deadline applies to (300 s). */
export function withoutHost(state: LifecycleState): boolean {
  return (
    state === "waking" ||
    state === "restoring" ||
    state === "started_no_host" ||
    state === "start_claimed" ||
    state === "host_refused"
  );
}

/** Whether the computer's restore is confirmed in this state (R-19: checkpoints only then). */
export function restored(state: LifecycleState): boolean {
  return RESTORED_STATES.includes(state);
}
