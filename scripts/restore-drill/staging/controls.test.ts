import { describe, expect, it } from "vitest";
import {
  checkOrigin,
  constantTimeEqual,
  INTENT_TTL_MS,
  intentMatches,
  MAX_INTENTS,
  pruneIntents,
  randomHex,
  sha256Hex,
} from "./src/controls.ts";
import { page } from "./src/page.ts";

const ORIGIN = "https://cfo-stg-wp25-drill.example.test";

function post(headers: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/run`, { method: "POST", headers });
}

describe("checkOrigin (IR-017)", () => {
  it("accepts only the deployment's own origin", () => {
    expect(checkOrigin(post({ origin: ORIGIN }))).toEqual({ ok: true });
    expect(checkOrigin(post({ origin: ORIGIN, "sec-fetch-site": "same-origin" }))).toEqual({
      ok: true,
    });
  });

  it.each([
    ["a missing origin", {}, "missing-origin"],
    ["a null origin", { origin: "null" }, "null-origin"],
    ["a foreign origin", { origin: "https://evil.example" }, "foreign-origin"],
    ["a sibling subdomain", { origin: "https://x.example.test" }, "foreign-origin"],
    ["a cross-site fetch", { origin: ORIGIN, "sec-fetch-site": "cross-site" }, "sec-fetch-site"],
    ["a same-site fetch", { origin: ORIGIN, "sec-fetch-site": "same-site" }, "sec-fetch-site"],
  ])("refuses %s", (_, headers, reason) => {
    expect(checkOrigin(post(headers))).toEqual({ ok: false, reason });
  });
});

describe("intent tokens", () => {
  it("matches only a stored, unexpired, non-empty token", async () => {
    const token = randomHex(32);
    const intents = [{ hash: await sha256Hex(token), expiresAt: 1000 }];
    expect(await intentMatches(token, intents, 999)).toBe(true);
    expect(await intentMatches(token, intents, 1000)).toBe(false);
    expect(await intentMatches(randomHex(32), intents, 0)).toBe(false);
    expect(await intentMatches(null, intents, 0)).toBe(false);
    const empty = [{ hash: await sha256Hex(""), expiresAt: 1000 }];
    expect(await intentMatches("", empty, 0)).toBe(false);
  });

  it("keeps room for a new token and drops expired ones", () => {
    const intents = Array.from({ length: 40 }, (_, i) => ({ hash: String(i), expiresAt: i }));
    const kept = pruneIntents(intents, 10);
    expect(kept.length).toBe(MAX_INTENTS - 1);
    expect(kept.every((i) => i.expiresAt > 10)).toBe(true);
    expect(INTENT_TTL_MS).toBeGreaterThan(0);
  });

  it("compares without an early exit", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("the page", () => {
  it("embeds the intent token, posts with it, and shows no credential", () => {
    const html = page("f".repeat(64));
    expect(html).toContain(JSON.stringify("f".repeat(64)));
    expect(html).toContain('"x-drill-intent": intent');
    expect(html).toContain('type="password"');
    expect(html).toContain('credentials: "same-origin"');
  });
});
