// Pure: WorkspaceDO's sign-in attempts (WP3.23; design, Signing in, D31; the design review's
// revisions 1 and 2). The controller persists them in its record and carries them forward; this
// module decides.
//
// - **Fenced attempts.** Each attempt has a number from a per-computer counter that never goes
//   back, and is bound to the computer, its generation, the service and the Access session that
//   started it. A start's operation ID maps to its attempt durably, so a retry after an eviction
//   or a lost reply gets the same attempt. A newer start for the service supersedes the older one;
//   a cancel ends an attempt even before its start reached the computer (the runner then never
//   delivers it, and the supervisor's fence refuses one already in transit).
// - **The sign-in lease.** While an attempt is active (not ended, its generation current, before
//   its deadline) the computer does not sleep and the start deadline waits, as for an open
//   terminal. The lease is bounded by the attempt's 10-minute deadline and ends on its own then,
//   whatever the page does; it ends sooner when the runner learns the attempt finished.
// - **Admission.** Starts are refused while the computer is not running restored, while a stop,
//   a sign-out or a removal is under way, and when its supervisor predates page sign-in (the page
//   then offers the terminal). Stop, sign-out and removal end every active attempt first (`closeAll`)
//   and queue its cancel for delivery.
// - **Never stored:** the link, Codex's one-time code and the pasted code. Only numbers, states,
//   times, the service and the session are kept.

import {
  type PageSignInView,
  type SignInRefusal,
  type SignInService,
  type SignInView,
  signInLinkAllowed,
} from "@cfo/contracts";
import { z } from "zod";

/** The platform's deadline for an attempt (a provider's code may expire sooner). */
export const SIGN_IN_DEADLINE_MS = 10 * 60_000;
/** How often the runner asks the supervisor whether an active attempt has finished. */
export const SIGN_IN_CHECK_MS = 15_000;
/** Attempts and start operations kept in the record. */
export const MAX_ATTEMPTS = 8;
export const MAX_START_OPS = 16;

const Millis = z.number().int().min(0).max(8.64e15);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SignInAttemptRecord = z.strictObject({
  attempt: Count,
  service: z.enum(["claude", "codex"]),
  generation: Count,
  /** The Access session that started it: only that session may continue or cancel it. */
  session: z.string().max(128),
  startOp: z.string().max(64),
  startedAt: Millis,
  deadline: Millis,
  /** The supervisor answered its start. */
  delivered: z.boolean(),
  /** A cancel to deliver (`pending`), delivered (`done`), or none. */
  cancel: z.enum(["none", "pending", "done"]),
  /** Why it ended; null while active. */
  ended: z.enum(["cancelled", "superseded", "finished", "expired", "gone"]).nullable(),
  /** When the runner last asked the supervisor about it. */
  checkedAt: Millis.nullable(),
});
export type SignInAttemptRecord = z.infer<typeof SignInAttemptRecord>;

export const SignInRecord = z.strictObject({
  /** The last attempt number given; never decreases. */
  next: Count,
  attempts: z.array(SignInAttemptRecord).max(MAX_ATTEMPTS + 1),
  /** Start operations and the attempt each made, so a retried start gets the same attempt. */
  ops: z.array(z.strictObject({ op: z.string().max(64), attempt: Count })).max(MAX_START_OPS + 1),
});
export type SignInRecord = z.infer<typeof SignInRecord>;

export const NO_SIGN_IN: SignInRecord = { next: 0, attempts: [], ops: [] };

/** What the supervisor said in its `hello`, for the current generation. */
export interface SupervisorInfo {
  readonly generation: number;
  readonly features: readonly string[];
}

/** Whether the page can offer sign-in: the supervisor's `hello` named the feature. */
export function signInAvailable(
  info: SupervisorInfo | null,
  generation: number,
): "yes" | "no" | "unknown" {
  if (info === null || info.generation !== generation) return "unknown";
  return info.features.includes("sign_in") ? "yes" : "no";
}

/** What admission needs to know about the computer now. */
export interface SignInFacts {
  readonly removal: boolean;
  /** A restored container runs (the terminal's `RESTORED_RUNNING`). */
  readonly running: boolean;
  /** A stop is being prepared, a stop is under way, or a sign-out job runs. */
  readonly busy: boolean;
  readonly available: "yes" | "no" | "unknown";
}

/** Why a start is refused now, or null. An unknown supervisor is tried: an older one refuses. */
export function startRefusal(facts: SignInFacts): SignInRefusal | null {
  if (facts.removal) return "not_offered";
  if (facts.busy) return "busy";
  if (!facts.running) return "not_running";
  if (facts.available === "no") return "unsupported";
  return null;
}

export function isActive(a: SignInAttemptRecord, generation: number, now: number): boolean {
  return a.ended === null && a.generation === generation && now < a.deadline;
}

/** The sign-in lease: whether any attempt keeps the computer awake now. */
export function leaseActive(r: SignInRecord, generation: number, now: number): boolean {
  return r.attempts.some((a) => isActive(a, generation, now));
}

/** When the lease ends at the latest; null without an active attempt. */
export function leaseUntil(r: SignInRecord, generation: number, now: number): number | null {
  const active = r.attempts.filter((a) => isActive(a, generation, now));
  return active.length === 0 ? null : Math.max(...active.map((a) => a.deadline));
}

/** The attempt a start operation made, if any. */
export function attemptOfOp(r: SignInRecord, op: string): SignInAttemptRecord | undefined {
  const known = r.ops.find((o) => o.op === op);
  return known === undefined ? undefined : r.attempts.find((a) => a.attempt === known.attempt);
}

/** Starts a new attempt (persisted by the caller): supersedes the service's active ones. */
export function begin(
  r: SignInRecord,
  input: {
    readonly service: SignInService;
    readonly generation: number;
    readonly session: string;
    readonly op: string;
    readonly now: number;
    readonly deadlineMs?: number;
  },
): { readonly record: SignInRecord; readonly attempt: SignInAttemptRecord } {
  const number = r.next + 1;
  const attempt: SignInAttemptRecord = {
    attempt: number,
    service: input.service,
    generation: input.generation,
    session: input.session,
    startOp: input.op,
    startedAt: input.now,
    deadline: input.now + (input.deadlineMs ?? SIGN_IN_DEADLINE_MS),
    delivered: false,
    cancel: "none",
    ended: null,
    checkedAt: null,
  };
  // The older attempt's cancel is queued too: if this start never reaches the computer (it stops
  // first, say), the older one is still ended there.
  const attempts = r.attempts.map((a) =>
    a.service === input.service && a.ended === null
      ? { ...a, ended: "superseded" as const, cancel: "pending" as const }
      : a,
  );
  return {
    attempt,
    record: prune({
      next: number,
      attempts: [...attempts, attempt],
      ops: [...r.ops, { op: input.op, attempt: number }],
    }),
  };
}

/** Keeps the newest attempts and start operations, never one still owed a cancel. */
export function prune(r: SignInRecord): SignInRecord {
  let attempts = [...r.attempts];
  while (attempts.length > MAX_ATTEMPTS) {
    const drop = attempts.findIndex((a) => a.ended !== null && a.cancel !== "pending");
    if (drop < 0) break;
    attempts.splice(drop, 1);
  }
  attempts = attempts.slice(-(MAX_ATTEMPTS + 1));
  return { ...r, attempts, ops: r.ops.slice(-MAX_START_OPS) };
}

/** Ends every active attempt (a stop, a sign-out, a removal): each cancel is queued. */
export function closeAll(r: SignInRecord): SignInRecord {
  return {
    ...r,
    attempts: r.attempts.map((a) =>
      a.ended === null ? { ...a, ended: "cancelled" as const, cancel: "pending" as const } : a,
    ),
  };
}

/** The container stopped, or a new generation starts: every attempt ended with it, and no
 * cancel is owed to a container that is gone. */
export function endWithContainer(r: SignInRecord): SignInRecord {
  return {
    ...r,
    attempts: r.attempts.map((a) =>
      a.ended === null || a.cancel === "pending"
        ? {
            ...a,
            ended: a.ended ?? ("gone" as const),
            cancel: a.cancel === "pending" ? "done" : a.cancel,
          }
        : a,
    ),
  };
}

/** Changes one attempt (by number). */
export function update(
  r: SignInRecord,
  attempt: number,
  fn: (a: SignInAttemptRecord) => SignInAttemptRecord,
): SignInRecord {
  return { ...r, attempts: r.attempts.map((a) => (a.attempt === attempt ? fn(a) : a)) };
}

/**
 * Whether this session may act on this attempt now. `stale`: unknown, of another generation,
 * ended (a cancel, a newer attempt, its deadline); `not_yours`: another session's.
 */
export function callerRefusal(
  a: SignInAttemptRecord | undefined,
  input: {
    readonly service: SignInService;
    readonly session: string;
    readonly generation: number;
    readonly now: number;
  },
): SignInRefusal | null {
  if (a === undefined || a.service !== input.service) return "stale";
  if (a.session !== input.session) return "not_yours";
  if (!isActive(a, input.generation, input.now)) return "stale";
  return null;
}

/** The state an ended attempt shows, without asking the supervisor. */
export function endedState(
  a: SignInAttemptRecord,
  generation: number,
  now: number,
): PageSignInView["state"] | null {
  switch (a.ended) {
    case "cancelled":
      return "cancelled";
    case "superseded":
      return "superseded";
    case "expired":
      return "expired";
    case "gone":
      return "none";
    case "finished":
      return null;
    default:
      if (a.generation !== generation) return "none";
      return now >= a.deadline ? "expired" : null;
  }
}

/**
 * The page's view of an attempt: the supervisor's view when it has one, checked once more (a
 * link only on the pinned host, only while it is useful), with the platform's deadline.
 */
export function pageView(
  a: SignInAttemptRecord,
  supervisor: SignInView | null,
  state: PageSignInView["state"] | null,
): PageSignInView {
  const deadline = new Date(a.deadline).toISOString();
  const base = { service: a.service, attempt: a.attempt, deadline };
  if (state !== null) return { ...base, state };
  if (supervisor === null) return { ...base, state: "starting" };
  const view: PageSignInView = { ...base, state: supervisor.state };
  const linked = supervisor.state === "awaiting_user" || supervisor.state === "completing";
  if (linked && supervisor.url !== undefined) {
    // Checked again here: only a link on the pinned CLI's own host ever reaches the page.
    if (!signInLinkAllowed(a.service, supervisor.url)) {
      return { ...base, state: "failed", reason: "unexpected_output" };
    }
    view.url = supervisor.url;
  }
  if (supervisor.state === "awaiting_user" && supervisor.userCode !== undefined) {
    view.userCode = supervisor.userCode;
  }
  if (supervisor.state === "failed" && supervisor.reason !== undefined) {
    view.reason = supervisor.reason;
  }
  if (supervisor.state === "awaiting_user" && supervisor.notice !== undefined) {
    view.notice = supervisor.notice;
  }
  return view;
}

/** Whether a supervisor's state means the attempt is over (the lease ends). */
export function finalState(state: SignInView["state"]): boolean {
  return !["starting", "awaiting_user", "completing"].includes(state);
}

/** The session's attempts still active, for the page to resume after a reload. */
export function sessionAttempts(
  r: SignInRecord,
  session: string,
  generation: number,
  now: number,
): { readonly service: SignInService; readonly attempt: number }[] {
  return r.attempts
    .filter((a) => a.session === session && isActive(a, generation, now))
    .map((a) => ({ service: a.service, attempt: a.attempt }));
}
