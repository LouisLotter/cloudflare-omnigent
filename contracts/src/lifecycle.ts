import { z } from "zod";
import type { CheckpointRefusal, HostSandboxStatus, SuspendRefusal } from "./launcher.ts";

// WorkspaceDO's lifecycle as a state × event table (machine.ts, WP3.1; code-structure plan),
// fixed here so the controller (3.1), the launcher (3.6), Omnigent's core change 13 (3.8) and
// the pages (3.5) agree on it. It covers the host not started, the start claim and its attempt
// (G1BR-005), the host refused, start retries after a stop (DC-37), the fenced sleep's platform
// side, stop records, removal intents and sign-out verification.
//
// Saving is a flag, not a state (R-19): a capture runs inside whatever state the computer is in,
// and a sleep, a removal or a restart is prepared (checkpoints first) without leaving the running
// state, so a refused preparation leaves the computer exactly as it was. Orthogonal facts are
// context fields; a few more come from outside as guard inputs.
//
// The table says what each event does in each state: the next state, the reply for an event that
// is a call, context changes and the effects 3.1 must perform. 3.1 persists the transition before
// the effects and records their outcomes after (code-structure plan, Ordering). `step` is the
// reference interpreter.

export const LifecycleState = z.enum([
  /** Recorded by `provision`; never started. */
  "provisioned",
  /** `resume` accepted: a reservation is taken and the container start is in progress, with the
   * start-after-stop retries (5, 10, 20, 20 s). */
  "waking",
  /** The container runs; the workspace and credential restores are not confirmed yet. */
  "restoring",
  /** Restored; no start attempt holds the computer. */
  "started_no_host",
  /** Attempt N is claimed; its parameters have not reached the supervisor. */
  "start_claimed",
  /** Attempt N's parameters were handed to the supervisor: a live incarnation until the
   * supervisor reports otherwise or the container stops. */
  "host_running",
  /** The supervisor parked the host after its "token refused" exit (code 77). */
  "host_refused",
  /** A stop record is persisted and the container is being stopped. */
  "stopping",
  /** Stopped by a planned stop (a sleep, a restart, the start deadline). */
  "asleep",
  /** Found stopped with no stop record (FH-07, FH-34): an unexpected stop. */
  "stopped",
  /** The last start failed after its retries, or its restore failed. */
  "failed",
  /** Removal intent recorded and the container stopped; credentials kept until resolved. */
  "removal_pending",
  /** Resolved: the records and checkpoints are deleted. Terminal. */
  "removed",
]);
export type LifecycleState = z.infer<typeof LifecycleState>;

export const LifecycleEvent = z.enum([
  // Launcher API calls (each always gets a reply).
  "resume",
  "claim_start",
  "start_host",
  "suspend",
  "terminate",
  "checkpoint",
  // The container port.
  "container_running",
  "start_refused",
  "start_failed",
  "container_stopped",
  // The supervisor, over the computer API.
  "restore_confirmed",
  "restore_failed",
  "start_taken",
  "start_not_taken",
  "host_refused_reported",
  "credential_checkpoint",
  // WorkspaceDO's own steps.
  "capture_started",
  "capture_finished",
  "stop_prepared",
  "stop_preparation_failed",
  "start_deadline",
  /** A removal intent with no stop being prepared: after a sign-out run, or to retry a refused
   * removal stop (the heartbeat alarm). */
  "removal_stop_due",
  // The cloud-computers page.
  "restart",
  "stop_without_saving",
  "sign_out_run",
  "removal_resolved",
]);
export type LifecycleEvent = z.infer<typeof LifecycleEvent>;

/** Why a stop is being prepared (its checkpoints run before the stop record). */
export type StopReason = "sleep" | "restart" | "removal" | "without_saving" | "start_deadline";

/** The orthogonal facts the table reads and changes. 3.1 persists them with the state. */
export interface MachineContext {
  readonly state: LifecycleState;
  /** A current start attempt is claimed and its parameters were not handed out. */
  readonly claimed: boolean;
  /** `start_host` was accepted for the current claim; the parameters wait for the restore. */
  readonly paramsStored: boolean;
  /** A stop is being prepared; the typed status is `stopping` meanwhile (FH-36). */
  readonly stopPrep: StopReason | null;
  /** `terminate` recorded a removal intent; every later wake is refused (FH-29). */
  readonly removalIntent: boolean;
  /** A `resume` arrived during `stopping`: start once the stop is confirmed. */
  readonly wakeQueued: boolean;
  /** The stop in progress ends a failed start. */
  readonly failedStart: boolean;
  /** A capture runs: the "saving" flag (R-19). */
  readonly capturing: boolean;
}

export const INITIAL_CONTEXT: MachineContext = {
  state: "provisioned",
  claimed: false,
  paramsStored: false,
  stopPrep: null,
  removalIntent: false,
  wakeQueued: false,
  failedStart: false,
  capturing: false,
};

/** Facts from outside the table, decided by 3.1 when the event arrives. */
export type GuardInput =
  /** ControlDO refused a reservation: the installation's limit is reached. */
  | "at_capacity"
  /** The `start_host` names the current claimed attempt. */
  | "attempt_current"
  /** The setup terminal is open. */
  | "terminal_open"
  /** The supervisor reports live runner processes. */
  | "runner_processes"
  /** Start-after-stop retries remain under this generation and reservation. */
  | "retries_left"
  /** Three sleeps in a row were refused (FH-35). */
  | "sleeps_refused_thrice"
  /** `signOutSettled` holds. */
  | "sign_out_settled";

/** Guards read from the context. */
export type ContextGuard =
  | "removal_intent"
  | "stop_prep"
  | "claimed"
  | "params_stored"
  | "wake_queued"
  | "failed_start"
  | "capturing";

export type Guard = GuardInput | ContextGuard;

export type Effect =
  | "reserve"
  | "start_container"
  | "retry_start"
  | "fence_start"
  | "restore"
  | "record_attempt"
  | "keep_params"
  | "deliver_params"
  | "record_host_refused"
  | "prepare_stop"
  | "prepare_credential_stop"
  | "record_stop_refusal"
  | "stop_container"
  | "confirm_stop"
  | "release_reservation"
  | "record_unexpected_stop"
  | "record_start_failure"
  | "record_removal_intent"
  | "accept_save_request"
  | "fold_save_request"
  | "publish_credentials"
  | "run_sign_out"
  | "delete_records";

export type PageRefusal = "busy" | "not_running" | "not_offered" | "unresolved" | "at_capacity";

/** The answer to an event that is a call. A claim's refusal carries `typedStatus` of the state. */
export type Reply =
  | { readonly kind: "resume"; readonly outcome: "starting" | "running" | "after_stop" }
  | { readonly kind: "claim"; readonly granted: boolean }
  | { readonly kind: "start_host" }
  | { readonly kind: "suspend"; readonly outcome: "in_progress" | "stopped" }
  | { readonly kind: "suspend_refused"; readonly reason: SuspendRefusal }
  | { readonly kind: "terminate"; readonly removal: "pending" | "resolved" }
  | { readonly kind: "checkpoint"; readonly folded: boolean }
  | { readonly kind: "checkpoint_refused"; readonly reason: CheckpointRefusal }
  | { readonly kind: "error"; readonly code: "gone" | "at_capacity" | "conflict" }
  | { readonly kind: "page"; readonly accepted: true }
  | { readonly kind: "page_refused"; readonly reason: PageRefusal }
  | { readonly kind: "refused" };

/** Context changes. Entering a state where no container runs also clears the claim, the stop
 * preparation, a queued wake and the failed-start mark (`step` applies it). */
export interface ContextChange {
  /** `new`: a new attempt is claimed (any stored parameters dropped); `handed`: its parameters
   * went to the supervisor; `clear`: no current claim. */
  readonly claim?: "new" | "handed" | "clear";
  readonly paramsStored?: true;
  readonly stopPrep?: StopReason | null;
  readonly removalIntent?: true;
  readonly wakeQueued?: boolean;
  readonly failedStart?: true;
  readonly capturing?: boolean;
}

export interface Rule {
  /** Every guard listed must hold. */
  readonly when?: readonly Guard[];
  /** No guard listed may hold. */
  readonly unless?: readonly Guard[];
  /** The next state; absent: the state does not change. */
  readonly to?: LifecycleState;
  readonly reply?: Reply;
  readonly set?: ContextChange;
  readonly effects?: readonly Effect[];
}

/** A cell: rules tried in order; the first whose guards hold applies. The last has no guard. */
export type Cell = readonly Rule[];

/** An event a state does not expect (late, repeated or from an older step): nothing changes. */
export const IGNORE: Cell = [{}];

const NOT_RUNNING = ["provisioned", "asleep", "stopped", "failed"] as const;

/** States in which no container runs. */
export const CONTAINER_STOPPED_STATES: readonly LifecycleState[] = [
  ...NOT_RUNNING,
  "removal_pending",
  "removed",
];

const goneReply: Reply = { kind: "error", code: "gone" };
const gone: Rule = { when: ["removal_intent"], reply: goneReply };
const conflict: Rule = { reply: { kind: "error", code: "conflict" } };
const refused: Rule = { reply: { kind: "refused" } };
const claimRefused: Rule = { reply: { kind: "claim", granted: false } };
const claimGranted = (to?: LifecycleState): Rule => ({
  ...(to ? { to } : {}),
  reply: { kind: "claim", granted: true },
  set: { claim: "new" },
  effects: ["record_attempt"],
});
const terminatePending: Rule = {
  when: ["removal_intent"],
  reply: { kind: "terminate", removal: "pending" },
};
const suspendStopped: Rule = { reply: { kind: "suspend", outcome: "stopped" } };
const suspendInProgress: Rule = { reply: { kind: "suspend", outcome: "in_progress" } };
const pageRefused = (reason: PageRefusal): Rule => ({ reply: { kind: "page_refused", reason } });
const pageAccepted = { kind: "page", accepted: true } as const;

type Table = Readonly<Record<LifecycleState, Readonly<Partial<Record<LifecycleEvent, Cell>>>>>;

function notRunning(): Partial<Record<LifecycleEvent, Cell>> {
  return {
    resume: [
      gone,
      { when: ["at_capacity"], reply: { kind: "error", code: "at_capacity" } },
      {
        to: "waking",
        reply: { kind: "resume", outcome: "starting" },
        effects: ["reserve", "start_container"],
      },
    ],
    claim_start: [gone, claimRefused],
    start_host: [gone, conflict],
    suspend: [suspendStopped],
    terminate: [
      {
        to: "removal_pending",
        reply: { kind: "terminate", removal: "pending" },
        set: { removalIntent: true },
        effects: ["record_removal_intent"],
      },
    ],
    checkpoint: [gone, { reply: { kind: "checkpoint_refused", reason: "not_running" } }],
    capture_started: [refused],
    capture_finished: [{ set: { capturing: false } }],
    restart: [pageRefused("not_running")],
    stop_without_saving: [pageRefused("not_running")],
    sign_out_run: [pageRefused("not_running")],
    removal_resolved: [pageRefused("unresolved")],
  };
}

function starting(state: "waking" | "restoring"): Partial<Record<LifecycleEvent, Cell>> {
  return {
    resume: [gone, { reply: { kind: "resume", outcome: "running" } }],
    // Safe to grant: no host process exists before the restore is confirmed.
    claim_start: [gone, claimGranted()],
    start_host: [
      gone,
      {
        when: ["attempt_current", "claimed"],
        unless: ["params_stored"],
        reply: { kind: "start_host" },
        set: { paramsStored: true },
        effects: ["keep_params"],
      },
      conflict,
    ],
    suspend: [{ reply: { kind: "suspend_refused", reason: "restoring" } }],
    terminate:
      state === "waking"
        ? [
            terminatePending,
            {
              to: "stopping",
              reply: { kind: "terminate", removal: "pending" },
              set: { removalIntent: true },
              effects: ["record_removal_intent", "fence_start", "stop_container"],
            },
          ]
        : [
            terminatePending,
            // Nothing ran yet, so there is nothing newer to save.
            {
              to: "stopping",
              reply: { kind: "terminate", removal: "pending" },
              set: { removalIntent: true },
              effects: ["record_removal_intent", "stop_container"],
            },
          ],
    checkpoint: [
      gone,
      {
        reply: {
          kind: "checkpoint_refused",
          reason: state === "waking" ? "not_running" : "restoring",
        },
      },
    ],
    // No checkpoint of either kind before the generation's restore is confirmed (R-19).
    capture_started: [refused],
    capture_finished: [{ set: { capturing: false } }],
    credential_checkpoint: [refused],
    restart: [pageRefused("busy")],
    stop_without_saving: [pageRefused("busy")],
    sign_out_run: [pageRefused("busy")],
    removal_resolved: [pageRefused("unresolved")],
  };
}

/** What every restored, running state shares. */
function restored(): Partial<Record<LifecycleEvent, Cell>> {
  return {
    resume: [gone, { reply: { kind: "resume", outcome: "running" } }],
    start_host: [gone, conflict],
    suspend: [
      { when: ["stop_prep"], ...suspendInProgress },
      { when: ["capturing"], reply: { kind: "suspend_refused", reason: "capture_running" } },
      { when: ["terminal_open"], reply: { kind: "suspend_refused", reason: "terminal_open" } },
      {
        when: ["runner_processes"],
        reply: { kind: "suspend_refused", reason: "runner_processes" },
      },
      {
        reply: { kind: "suspend", outcome: "in_progress" },
        set: { stopPrep: "sleep" },
        effects: ["prepare_stop"],
      },
    ],
    terminate: [
      {
        when: ["stop_prep"],
        reply: { kind: "terminate", removal: "pending" },
        set: { removalIntent: true },
        effects: ["record_removal_intent"],
      },
      // Already recorded: a sign-out run or a stop retry is under way; nothing more to do.
      terminatePending,
      {
        reply: { kind: "terminate", removal: "pending" },
        set: { removalIntent: true, stopPrep: "removal" },
        effects: ["record_removal_intent", "prepare_stop"],
      },
    ],
    removal_stop_due: [
      { when: ["stop_prep"] },
      { when: ["removal_intent"], set: { stopPrep: "removal" }, effects: ["prepare_stop"] },
      {},
    ],
    checkpoint: [
      gone,
      { when: ["stop_prep"], reply: { kind: "checkpoint_refused", reason: "stopping" } },
      {
        when: ["capturing"],
        reply: { kind: "checkpoint", folded: true },
        effects: ["fold_save_request"],
      },
      { reply: { kind: "checkpoint", folded: false }, effects: ["accept_save_request"] },
    ],
    container_stopped: [
      {
        when: ["removal_intent"],
        to: "removal_pending",
        effects: ["record_unexpected_stop", "release_reservation"],
      },
      { to: "stopped", effects: ["record_unexpected_stop", "release_reservation"] },
    ],
    credential_checkpoint: [{ effects: ["publish_credentials"] }],
    capture_started: [{ when: ["capturing"], ...refused }, { set: { capturing: true } }],
    capture_finished: [{ set: { capturing: false } }],
    stop_prepared: [{ when: ["stop_prep"], to: "stopping", effects: ["stop_container"] }, {}],
    stop_preparation_failed: [
      { when: ["stop_prep"], set: { stopPrep: null }, effects: ["record_stop_refusal"] },
      {},
    ],
    restart: [
      { when: ["stop_prep"], ...pageRefused("busy") },
      { reply: pageAccepted, set: { stopPrep: "restart" }, effects: ["prepare_stop"] },
    ],
    stop_without_saving: [
      { when: ["stop_prep"], ...pageRefused("busy") },
      {
        when: ["sleeps_refused_thrice"],
        reply: pageAccepted,
        set: { stopPrep: "without_saving" },
        effects: ["prepare_credential_stop"],
      },
      pageRefused("not_offered"),
    ],
    sign_out_run: [
      { when: ["stop_prep"], ...pageRefused("busy") },
      { reply: pageAccepted, effects: ["run_sign_out"] },
    ],
    removal_resolved: [pageRefused("unresolved")],
  };
}

/** States without a host incarnation stop after the start deadline (300 s), unless the setup
 * terminal is open or a stop is already being prepared. */
const startDeadlineStop: Cell = [
  { when: ["terminal_open"] },
  { when: ["stop_prep"] },
  { set: { stopPrep: "start_deadline" }, effects: ["prepare_stop"] },
];

export const LIFECYCLE_TABLE: Table = {
  provisioned: notRunning(),
  asleep: notRunning(),
  stopped: notRunning(),
  failed: notRunning(),
  waking: {
    ...starting("waking"),
    container_running: [{ to: "restoring", effects: ["restore"] }],
    start_refused: [
      { when: ["retries_left"], effects: ["retry_start"] },
      { to: "failed", effects: ["record_start_failure", "fence_start", "release_reservation"] },
    ],
    // A start that did not hold is treated as refused (DC-37: `start()` returns before placement).
    container_stopped: [
      { when: ["retries_left"], effects: ["retry_start"] },
      { to: "failed", effects: ["record_start_failure", "fence_start", "release_reservation"] },
    ],
    start_failed: [
      { to: "failed", effects: ["record_start_failure", "fence_start", "release_reservation"] },
    ],
    start_deadline: [
      { to: "failed", effects: ["record_start_failure", "fence_start", "release_reservation"] },
    ],
  },
  restoring: {
    ...starting("restoring"),
    restore_confirmed: [
      // A sign-out run under a removal intent: no host starts.
      { when: ["removal_intent"], to: "started_no_host", effects: ["run_sign_out"] },
      {
        when: ["params_stored"],
        to: "host_running",
        set: { claim: "handed" },
        effects: ["deliver_params"],
      },
      { when: ["claimed"], to: "start_claimed" },
      { to: "started_no_host" },
    ],
    restore_failed: [
      {
        to: "stopping",
        set: { failedStart: true },
        effects: ["record_start_failure", "stop_container"],
      },
    ],
    container_stopped: [
      {
        when: ["removal_intent"],
        to: "removal_pending",
        effects: ["record_unexpected_stop", "release_reservation"],
      },
      { to: "stopped", effects: ["record_unexpected_stop", "release_reservation"] },
    ],
    start_deadline: [
      {
        to: "stopping",
        set: { failedStart: true },
        effects: ["record_start_failure", "stop_container"],
      },
    ],
  },
  started_no_host: {
    ...restored(),
    claim_start: [gone, { when: ["stop_prep"], ...claimRefused }, claimGranted("start_claimed")],
    start_deadline: startDeadlineStop,
  },
  start_claimed: {
    ...restored(),
    // A later claim supersedes the earlier attempt, whose start is then refused.
    claim_start: [gone, { when: ["stop_prep"], ...claimRefused }, claimGranted()],
    start_host: [
      gone,
      { when: ["stop_prep"], ...conflict },
      {
        when: ["attempt_current", "claimed"],
        to: "host_running",
        reply: { kind: "start_host" },
        set: { claim: "handed" },
        effects: ["keep_params", "deliver_params"],
      },
      conflict,
    ],
    start_deadline: startDeadlineStop,
  },
  host_running: {
    ...restored(),
    // Never claim or re-arm a live incarnation (G1BR-005).
    claim_start: [gone, claimRefused],
    start_taken: [{}],
    // The supervisor answered that it does not hold the attempt: no incarnation exists.
    start_not_taken: [{ to: "start_claimed", set: { claim: "new" } }],
    host_refused_reported: [{ to: "host_refused", effects: ["record_host_refused"] }],
    start_deadline: IGNORE,
  },
  host_refused: {
    ...restored(),
    claim_start: [gone, { when: ["stop_prep"], ...claimRefused }, claimGranted("start_claimed")],
    start_deadline: startDeadlineStop,
  },
  stopping: {
    resume: [gone, { reply: { kind: "resume", outcome: "after_stop" }, set: { wakeQueued: true } }],
    claim_start: [gone, claimRefused],
    start_host: [gone, conflict],
    suspend: [suspendInProgress],
    terminate: [
      {
        reply: { kind: "terminate", removal: "pending" },
        set: { removalIntent: true },
        effects: ["record_removal_intent"],
      },
    ],
    checkpoint: [gone, { reply: { kind: "checkpoint_refused", reason: "stopping" } }],
    container_stopped: [
      {
        when: ["removal_intent"],
        to: "removal_pending",
        effects: ["confirm_stop", "release_reservation"],
      },
      { when: ["failed_start"], to: "failed", effects: ["confirm_stop", "release_reservation"] },
      {
        when: ["wake_queued", "at_capacity"],
        to: "asleep",
        effects: ["confirm_stop", "release_reservation"],
      },
      {
        when: ["wake_queued"],
        to: "waking",
        effects: ["confirm_stop", "release_reservation", "reserve", "start_container"],
      },
      { to: "asleep", effects: ["confirm_stop", "release_reservation"] },
    ],
    // A login changed after the final credential checkpoint is still newer: keep it.
    credential_checkpoint: [{ effects: ["publish_credentials"] }],
    capture_started: [refused],
    capture_finished: [{ set: { capturing: false } }],
    restart: [pageRefused("busy")],
    stop_without_saving: [pageRefused("busy")],
    sign_out_run: [pageRefused("busy")],
    removal_resolved: [pageRefused("unresolved")],
  },
  removal_pending: {
    resume: [{ reply: goneReply }],
    claim_start: [{ reply: goneReply }],
    start_host: [{ reply: goneReply }],
    suspend: [suspendStopped],
    terminate: [{ reply: { kind: "terminate", removal: "pending" } }],
    checkpoint: [{ reply: goneReply }],
    capture_started: [refused],
    capture_finished: [{ set: { capturing: false } }],
    restart: [pageRefused("not_running")],
    stop_without_saving: [pageRefused("not_running")],
    // Starts the computer for the CLIs' logouts only; Omnigent's claims stay refused.
    sign_out_run: [
      { when: ["at_capacity"], ...pageRefused("at_capacity") },
      { to: "waking", reply: pageAccepted, effects: ["reserve", "start_container"] },
    ],
    removal_resolved: [
      {
        when: ["sign_out_settled"],
        to: "removed",
        reply: pageAccepted,
        effects: ["delete_records"],
      },
      pageRefused("unresolved"),
    ],
  },
  removed: {
    resume: [{ reply: goneReply }],
    claim_start: [{ reply: goneReply }],
    start_host: [{ reply: goneReply }],
    suspend: [suspendStopped],
    terminate: [{ reply: { kind: "terminate", removal: "resolved" } }],
    checkpoint: [{ reply: goneReply }],
    capture_started: [refused],
    restart: [pageRefused("not_running")],
    stop_without_saving: [pageRefused("not_running")],
    sign_out_run: [pageRefused("not_running")],
    removal_resolved: [pageRefused("not_running")],
  },
};

/** The launcher calls: every state answers each of them. */
export const LAUNCHER_EVENTS = [
  "resume",
  "claim_start",
  "start_host",
  "suspend",
  "terminate",
  "checkpoint",
] as const satisfies readonly LifecycleEvent[];

/** The page actions: every state answers each of them. */
export const PAGE_EVENTS = [
  "restart",
  "stop_without_saving",
  "sign_out_run",
  "removal_resolved",
] as const satisfies readonly LifecycleEvent[];

/**
 * The typed status Omnigent sees (R-02). A stop being prepared reads as `stopping` (FH-36). Before
 * the restore is confirmed the computer reads as `started_no_host`, or `start_claimed` once
 * claimed, so Omnigent can claim and deliver `start_host` while the restore runs; the supervisor
 * takes the parameters only after it.
 */
export function typedStatus(context: MachineContext): HostSandboxStatus {
  if (context.stopPrep !== null) return "stopping";
  switch (context.state) {
    case "provisioned":
    case "asleep":
    case "stopped":
    case "failed":
    case "removal_pending":
    case "removed":
      return "stopped";
    case "waking":
    case "restoring":
      return context.claimed ? "start_claimed" : "started_no_host";
    case "started_no_host":
    case "start_claimed":
    case "host_running":
    case "host_refused":
    case "stopping":
      return context.state;
  }
}

/** Whether a container may be running in this state (for reconciliation with ControlDO). */
export function containerMayRun(state: LifecycleState): boolean {
  return !CONTAINER_STOPPED_STATES.includes(state);
}

function contextGuard(context: MachineContext, guard: Guard): boolean | undefined {
  switch (guard) {
    case "removal_intent":
      return context.removalIntent;
    case "stop_prep":
      return context.stopPrep !== null;
    case "claimed":
      return context.claimed;
    case "params_stored":
      return context.paramsStored;
    case "wake_queued":
      return context.wakeQueued;
    case "failed_start":
      return context.failedStart;
    case "capturing":
      return context.capturing;
    default:
      return undefined;
  }
}

function holds(context: MachineContext, inputs: ReadonlySet<GuardInput>, guard: Guard): boolean {
  return contextGuard(context, guard) ?? inputs.has(guard as GuardInput);
}

/** The cell for a state and an event; events a state does not list are ignored. */
export function cellFor(state: LifecycleState, event: LifecycleEvent): Cell {
  return LIFECYCLE_TABLE[state][event] ?? IGNORE;
}

/** The rule that applies. Every cell ends in an unguarded rule, so one always does. */
export function ruleFor(
  context: MachineContext,
  event: LifecycleEvent,
  inputs: ReadonlySet<GuardInput> = new Set(),
): Rule {
  const cell = cellFor(context.state, event);
  const rule = cell.find(
    (r) =>
      (r.when ?? []).every((g) => holds(context, inputs, g)) &&
      !(r.unless ?? []).some((g) => holds(context, inputs, g)),
  );
  if (!rule) throw new Error(`no rule for ${context.state} × ${event}`);
  return rule;
}

export interface Step {
  readonly context: MachineContext;
  readonly reply: Reply | undefined;
  readonly effects: readonly Effect[];
}

/** The reference interpreter: one event, one transition. Pure. */
export function step(
  context: MachineContext,
  event: LifecycleEvent,
  inputs: ReadonlySet<GuardInput> = new Set(),
): Step {
  const rule = ruleFor(context, event, inputs);
  const set = rule.set ?? {};
  let next: MachineContext = { ...context, state: rule.to ?? context.state };
  if (set.claim === "new") next = { ...next, claimed: true, paramsStored: false };
  if (set.claim === "handed" || set.claim === "clear") {
    next = { ...next, claimed: false, paramsStored: false };
  }
  if (set.paramsStored) next = { ...next, paramsStored: true };
  if (set.stopPrep !== undefined) next = { ...next, stopPrep: set.stopPrep };
  if (set.removalIntent) next = { ...next, removalIntent: true };
  if (set.wakeQueued !== undefined) next = { ...next, wakeQueued: set.wakeQueued };
  if (set.failedStart) next = { ...next, failedStart: true };
  if (set.capturing !== undefined) next = { ...next, capturing: set.capturing };
  if (rule.to !== undefined && rule.to !== context.state) {
    // Leaving a running state ends any stop preparation; a stopped container holds no claim,
    // no queued wake and no capture.
    next = { ...next, stopPrep: null };
    if (!containerMayRun(next.state) || next.state === "waking") {
      next = {
        ...next,
        claimed: false,
        paramsStored: false,
        wakeQueued: false,
        failedStart: false,
        capturing: false,
      };
    }
  }
  return { context: next, reply: rule.reply, effects: rule.effects ?? [] };
}

// ---------------------------------------------------------------------------------------------
// Sign-out verification (design, Signing in): the CLIs' logouts, the tombstones published, then
// a restore of that checkpoint showing no declared file. Tracked beside the lifecycle.

export type SignOutPhase = "none" | "requested" | "tombstoned" | "verified";
export type SignOutEvent =
  /** The page asked; the supervisor runs `claude auth logout` and `codex logout`. */
  | "requested"
  /** A published credential checkpoint tombstones both providers' login files. */
  | "tombstones_published"
  /** A restore of that checkpoint left no declared credential file. */
  | "restore_verified"
  /** A credential checkpoint holding a login was published: any sign-out is undone. */
  | "login_published";

export const SIGN_OUT_TABLE: Readonly<
  Record<SignOutPhase, Readonly<Record<SignOutEvent, SignOutPhase>>>
> = {
  none: {
    requested: "requested",
    tombstones_published: "none",
    restore_verified: "none",
    login_published: "none",
  },
  requested: {
    requested: "requested",
    tombstones_published: "tombstoned",
    restore_verified: "requested",
    login_published: "none",
  },
  tombstoned: {
    requested: "tombstoned",
    tombstones_published: "tombstoned",
    restore_verified: "verified",
    login_published: "none",
  },
  verified: {
    requested: "verified",
    tombstones_published: "verified",
    restore_verified: "verified",
    login_published: "none",
  },
};

/**
 * Whether a removal may resolve and delete the checkpoints. Unknown state never counts as signed
 * out. A login that may have been lost unpublished (a forced stop, or an unexpected stop after an
 * unpublished change) can be revoked only at the provider, so it needs the person's record.
 */
export function signOutSettled(input: {
  readonly phase: SignOutPhase;
  /** No credential checkpoint ever held a login. */
  readonly neverHeldLogin: boolean;
  readonly loginPossiblyLost: boolean;
  /** The person recorded that they revoked the sessions at the providers; survives a wipe. */
  readonly revocationRecorded: boolean;
}): boolean {
  if (input.revocationRecorded) return true;
  if (input.loginPossiblyLost) return false;
  return input.phase === "verified" || input.neverHeldLogin;
}

// ---------------------------------------------------------------------------------------------
// The timing budget (design, "Timing budget"), as the values the packages test against.

export const TIMING = {
  /** Omnigent's online wait for a computer (core change 13 setting). */
  onlineWaitS: 240,
  /** Start-after-stop retries under one generation and reservation (DC-37). */
  startRetryDelaysS: [5, 10, 20, 20],
  /** A container not running this long after `start()` counts as refused (no `monitor()`). */
  startRefusedAfterS: 10,
  /** A container without a host incarnation is stopped after this. */
  startDeadlineS: 300,
  /** Omnigent's start redelivery (`START_REDELIVERY_S`, core change 13). */
  startRedeliveryS: 15,
  /** The capture pause: target and hard budget (D7, R-14); D25 raises the target to the hard
   * budget for workspaces above about 2 GB. */
  pauseTargetS: 20,
  pauseHardBudgetS: 40,
  largeWorkspaceBytes: 2_000_000_000,
  /** The upload deadline for a capture, below the 15 minutes a pending operation can hold a DO. */
  uploadDeadlineS: 600,
  /** The host's "token refused" exit (core change 13). */
  tokenRefusedExitCode: 77,
  tokenRefusedExitS: 1200,
  /** The heartbeat alarm, and the inactivity-timeout margin it renews. */
  heartbeatS: 60,
  inactivityMarginS: 2700,
  /** An admission report's maximum age. */
  admissionMaxAgeS: 60,
  /** The backstop save while runner processes exist and no request came. */
  backstopSaveS: 900,
  /** "Not saved" closes admission after this, and its reopen retries back off like this. */
  notSavedS: 1800,
  notSavedRetryS: [60, 120, 300],
  /** The "no contact" notice. */
  noContactS: 3600,
  /** Refused sleeps before "Stop without saving the latest changes" is offered (FH-35). */
  refusedSleepsBeforeStopWithoutSaving: 3,
  /** Operation outcomes are kept at least this long (code-structure plan, Conventions). */
  operationRecordS: 7 * 24 * 3600,
} as const;
