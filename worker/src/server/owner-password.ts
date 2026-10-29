// The owner's Omnigent password, chosen on the site (WP3.34): OmnigentServer's decisions, pure.
// The contract and the platform call's signature are in `contracts/src/owner-password.ts`.
//
//   - **State.** The owner still has to choose a password when the installer chose none (it set
//     the platform Worker's `CFO_OWNER_PASSWORD_ON_PAGE`) and no password has been set on the page
//     since (OmnigentServer's own record). Every other installation is "chosen": one whose owner
//     typed a password at install, and every installation from before this package.
//   - **Intent.** The page's request-intent token: HMAC-SHA256 under a random secret kept in
//     OmnigentServer's storage, over the owner's Access `sub` and session ID, compared in constant
//     time before any effect (as WorkspaceDO's page front does for the computer pages).
//   - **Attempts.** At most MAX_ATTEMPTS calls reach the server in any ATTEMPT_WINDOW_MS; each is
//     recorded before it is sent. A refusal before the server (the intent, the configuration, a
//     server that is not answering) costs nothing and is not counted.
//   - **Answers.** "done" only for a 200 with the barrier's `x-cfo-durability: confirmed`; a 424,
//     or a 200 without that confirmation, is "unconfirmed"; a refused connection, a lost answer or
//     a 503 is "unavailable" (try again: setting the same password twice is harmless); anything
//     else is "failed".

import type { OwnerPasswordResult, PageOwner } from "@cfo/contracts";

/** Set by the installer, as a Worker secret, when it chose no password (page mode). */
export const OWNER_PASSWORD_ON_PAGE_VAR = "CFO_OWNER_PASSWORD_ON_PAGE";
/** The installation's Omnigent cookie secret, which keys the platform call. */
export const COOKIE_SECRET_VAR = "SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET";
/** The owner's Omnigent username, as the installation configures it. */
export const OWNER_USERNAME_VAR = "SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME";

export const ATTEMPT_WINDOW_MS = 10 * 60_000;
/** How long after a confirmed change its Access session's page shows "done". */
export const JUST_SET_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 6;
/** One platform call: the server's hashing and its barrier's wait (10 s by default), and margin. */
export const PLATFORM_CALL_TIMEOUT_MS = 30_000;
/** What the page tells the owner to wait before trying again when the server is not answering. */
export const UNAVAILABLE_RETRY_S = 30;

const encoder = new TextEncoder();

/** The owner's Omnigent username as Omnigent created it (trimmed, lowercase), or null. */
export function ownerUsernameOf(env: Readonly<Record<string, unknown>>): string | null {
  const raw = env[OWNER_USERNAME_VAR];
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  return name === "" || name.length > 128 ? null : name;
}

/** The cookie secret the platform call is keyed by, or null. */
export function cookieSecretOf(env: Readonly<Record<string, unknown>>): string | null {
  const raw = env[COOKIE_SECRET_VAR];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Whether the owner still has to choose: page mode, and nothing chosen on the page yet. */
export function passwordState(
  env: Readonly<Record<string, unknown>>,
  chosenAt: number | null,
): "unchosen" | "chosen" {
  return env[OWNER_PASSWORD_ON_PAGE_VAR] === "true" && chosenAt === null ? "unchosen" : "chosen";
}

/** The text the intent token signs, for one owner's Access session. */
export function intentText(owner: PageOwner): string {
  return `cfo-password-page-intent/v1\n${owner.sub}\n${owner.sessionId}`;
}

/** Constant-time equality of two strings. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type AttemptDecision =
  | { readonly allowed: true; readonly attempts: readonly number[] }
  | {
      readonly allowed: false;
      readonly attempts: readonly number[];
      readonly retryAfterSeconds: number;
    };

/**
 * Whether one more attempt may reach the server now, and the attempts to keep: those inside the
 * window, plus this one when it is allowed. Times the clock has not reached yet (a clock set
 * back) count as now, so they cannot open the window early.
 */
export function decideAttempt(stored: readonly number[], now: number): AttemptDecision {
  const recent = stored
    .map((at) => Math.min(at, now))
    .filter((at) => at > now - ATTEMPT_WINDOW_MS)
    .sort((a, b) => a - b);
  if (recent.length < MAX_ATTEMPTS) return { allowed: true, attempts: [...recent, now] };
  const oldest = recent[recent.length - MAX_ATTEMPTS] as number;
  const waitMs = oldest + ATTEMPT_WINDOW_MS - now;
  return {
    allowed: false,
    attempts: recent,
    retryAfterSeconds: Math.min(3600, Math.max(1, Math.ceil(waitMs / 1000))),
  };
}

type SetResult = Extract<OwnerPasswordResult, { action: "set" }>;

/** The page's answer for the server's answer to the platform call. */
export function outcomeOf(status: number, durability: string | null): SetResult {
  if (status === 200) {
    return durability === "confirmed"
      ? { action: "set", outcome: "done" }
      : { action: "set", outcome: "unconfirmed" };
  }
  if (status === 424) return { action: "set", outcome: "unconfirmed" };
  if (status === 503) {
    return { action: "set", outcome: "unavailable", retryAfterSeconds: UNAVAILABLE_RETRY_S };
  }
  return { action: "set", outcome: "failed" };
}

export const UNAVAILABLE: SetResult = {
  action: "set",
  outcome: "unavailable",
  retryAfterSeconds: UNAVAILABLE_RETRY_S,
};

/**
 * Whether this Access session set the password, confirmed durable, within JUST_SET_MS: the
 * page shows "done" only then (Codex WP3.34 r1-3).
 */
export function justSet(
  done: { readonly sessionId: string; readonly at: number } | null,
  sessionId: string,
  now: number,
): boolean {
  return (
    done !== null && done.sessionId === sessionId && done.at <= now && now - done.at < JUST_SET_MS
  );
}
