// OmnigentServer's pure password decisions (WP3.34, `src/server/owner-password.ts`): the page's
// state, the intent text, the attempts limit (with a property test) and the answer mapping.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_WINDOW_MS,
  COOKIE_SECRET_VAR,
  constantTimeEqual,
  cookieSecretOf,
  decideAttempt,
  intentText,
  MAX_ATTEMPTS,
  OWNER_PASSWORD_ON_PAGE_VAR,
  OWNER_USERNAME_VAR,
  outcomeOf,
  ownerUsernameOf,
  passwordState,
  UNAVAILABLE,
  UNAVAILABLE_RETRY_S,
} from "../../src/server/owner-password.ts";

describe("the page's state", () => {
  it("is unchosen only in page mode, until a password is chosen on the page", () => {
    const page = { [OWNER_PASSWORD_ON_PAGE_VAR]: "true" };
    expect(passwordState(page, null)).toBe("unchosen");
    expect(passwordState(page, 1)).toBe("chosen");
    expect(passwordState({}, null)).toBe("chosen");
    expect(passwordState({ [OWNER_PASSWORD_ON_PAGE_VAR]: "false" }, null)).toBe("chosen");
    expect(passwordState({ [OWNER_PASSWORD_ON_PAGE_VAR]: "TRUE" }, null)).toBe("chosen");
  });

  it("names the owner as Omnigent created it, or nobody", () => {
    expect(ownerUsernameOf({ [OWNER_USERNAME_VAR]: "  Owner " })).toBe("owner");
    expect(ownerUsernameOf({ [OWNER_USERNAME_VAR]: "   " })).toBeNull();
    expect(ownerUsernameOf({ [OWNER_USERNAME_VAR]: 7 })).toBeNull();
    expect(ownerUsernameOf({ [OWNER_USERNAME_VAR]: "x".repeat(129) })).toBeNull();
    expect(ownerUsernameOf({})).toBeNull();
  });

  it("keys the platform call by the cookie secret, when there is one", () => {
    expect(cookieSecretOf({ [COOKIE_SECRET_VAR]: "s" })).toBe("s");
    expect(cookieSecretOf({ [COOKIE_SECRET_VAR]: "" })).toBeNull();
    expect(cookieSecretOf({ [COOKIE_SECRET_VAR]: 1 })).toBeNull();
    expect(cookieSecretOf({})).toBeNull();
  });
});

describe("the intent text", () => {
  it("binds the purpose, the owner and the Access session", () => {
    const a = intentText({ sub: "s", sessionId: "a".repeat(64) });
    expect(a).toBe(`cfo-password-page-intent/v1\ns\n${"a".repeat(64)}`);
    expect(intentText({ sub: "s", sessionId: "b".repeat(64) })).not.toBe(a);
    expect(intentText({ sub: "t", sessionId: "a".repeat(64) })).not.toBe(a);
  });

  it("compares in constant time, lengths included", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("the attempts limit", () => {
  const now = 10_000_000;

  it(`allows ${MAX_ATTEMPTS} in the window, then says when the next one may come`, () => {
    let attempts: readonly number[] = [];
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const decision = decideAttempt(attempts, now + i * 1000);
      expect(decision.allowed).toBe(true);
      attempts = decision.attempts;
    }
    const refused = decideAttempt(attempts, now + MAX_ATTEMPTS * 1000);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterSeconds).toBe((ATTEMPT_WINDOW_MS - MAX_ATTEMPTS * 1000) / 1000);
      expect(refused.attempts).toEqual(attempts);
    }
    expect(decideAttempt(attempts, now + ATTEMPT_WINDOW_MS).allowed).toBe(true);
  });

  it("drops attempts older than the window, and counts future ones as now", () => {
    const old = [now - ATTEMPT_WINDOW_MS, now - ATTEMPT_WINDOW_MS - 5];
    expect(decideAttempt(old, now)).toEqual({ allowed: true, attempts: [now] });
    const future = Array.from({ length: MAX_ATTEMPTS }, () => now + 3_600_000);
    const decision = decideAttempt(future, now);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.retryAfterSeconds).toBe(ATTEMPT_WINDOW_MS / 1000);
  });

  it("never lets more than the maximum through in any window", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 * ATTEMPT_WINDOW_MS }), { maxLength: 60 }),
        (offsets) => {
          let attempts: readonly number[] = [];
          const allowed: number[] = [];
          for (const at of [...offsets].sort((a, b) => a - b)) {
            const decision = decideAttempt(attempts, at);
            attempts = decision.attempts;
            if (decision.allowed) allowed.push(at);
            else expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
          }
          for (const start of allowed) {
            const inside = allowed.filter((at) => at >= start && at < start + ATTEMPT_WINDOW_MS);
            expect(inside.length).toBeLessThanOrEqual(MAX_ATTEMPTS);
          }
        },
      ),
    );
  });
});

describe("the answer to the platform call", () => {
  it.each([
    [200, "confirmed", "done"],
    [200, null, "unconfirmed"],
    [200, "unconfirmed", "unconfirmed"],
    [424, "unconfirmed", "unconfirmed"],
    [424, null, "unconfirmed"],
    [503, null, "unavailable"],
    [400, null, "failed"],
    [401, null, "failed"],
    [404, null, "failed"],
    [500, null, "failed"],
    [302, null, "failed"],
  ])("%i with durability %s is %s", (status, durability, outcome) => {
    expect(outcomeOf(status, durability)).toMatchObject({ action: "set", outcome });
  });

  it("says when to try again when the server is not answering", () => {
    expect(outcomeOf(503, null)).toEqual(UNAVAILABLE);
    expect(UNAVAILABLE).toEqual({
      action: "set",
      outcome: "unavailable",
      retryAfterSeconds: UNAVAILABLE_RETRY_S,
    });
  });
});
