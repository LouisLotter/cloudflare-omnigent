import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { base64UrlEncode } from "../../src/ingress/access.ts";
import { makeOwnerPin, normalizeEmail, parseOwnerPin } from "../../src/ingress/owner.ts";
import { OWNER_EMAIL, SALT } from "../support/access-keys.ts";

describe("the owner pin", () => {
  it("matches the owner's address, trimmed and in any case, and nothing else", async () => {
    const pin = parseOwnerPin(await makeOwnerPin(OWNER_EMAIL, SALT));
    expect(pin).toBeDefined();
    for (const email of [OWNER_EMAIL, "Owner@Example.INVALID", `  ${OWNER_EMAIL}\n`]) {
      expect(await pin?.matches(email)).toBe(true);
    }
    for (const email of [
      "someone-else@example.invalid",
      "owner@example.invalid.",
      "owner+x@example.invalid",
      "",
      "owner",
    ]) {
      expect(await pin?.matches(email), email).toBe(false);
    }
  });

  it("has the documented form and depends on the salt", async () => {
    const text = await makeOwnerPin(OWNER_EMAIL, SALT);
    expect(text).toMatch(/^hmac-sha256:[A-Za-z0-9_-]+:[0-9a-f]{64}$/);
    expect(text.split(":")[1]).toBe(base64UrlEncode(SALT));
    expect(text).not.toContain("owner");
    const other = await makeOwnerPin(OWNER_EMAIL, new Uint8Array(16).fill(8));
    expect(other.split(":")[2]).not.toBe(text.split(":")[2]);
    // A pin made with one salt does not match under another.
    const swapped = `hmac-sha256:${base64UrlEncode(new Uint8Array(16).fill(8))}:${text.split(":")[2]}`;
    expect(await parseOwnerPin(swapped)?.matches(OWNER_EMAIL)).toBe(false);
  });

  it("refuses to make a pin with a short or long salt, or an empty address", async () => {
    await expect(makeOwnerPin(OWNER_EMAIL, new Uint8Array(15))).rejects.toThrow("salt");
    await expect(makeOwnerPin(OWNER_EMAIL, new Uint8Array(65))).rejects.toThrow("salt");
    await expect(makeOwnerPin("  ", SALT)).rejects.toThrow("empty");
  });

  it("parses only the exact stored form", async () => {
    const good = await makeOwnerPin(OWNER_EMAIL, SALT);
    const digest = good.split(":")[2] as string;
    for (const bad of [
      undefined,
      "",
      digest,
      `sha256:${base64UrlEncode(SALT)}:${digest}`,
      `hmac-sha256:${base64UrlEncode(SALT)}:${digest.toUpperCase()}`,
      `hmac-sha256:${base64UrlEncode(SALT)}:${digest.slice(1)}`,
      `hmac-sha256:${base64UrlEncode(new Uint8Array(8))}:${digest}`,
      `hmac-sha256:${base64UrlEncode(new Uint8Array(65))}:${digest}`,
      `hmac-sha256:${base64UrlEncode(SALT)}x:${digest}`, // non-canonical base64url
      `hmac-sha256:${base64UrlEncode(SALT)}=:${digest}`,
      ` ${good}`,
      `${good}\n`,
    ]) {
      expect(parseOwnerPin(bad), String(bad)).toBeUndefined();
    }
  });

  it("property: a pin matches an address exactly when the normalized addresses are equal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(),
        fc.emailAddress(),
        fc.uint8Array({ minLength: 16, maxLength: 64 }),
        async (owner, caller, salt) => {
          const pin = parseOwnerPin(await makeOwnerPin(owner, new Uint8Array(salt)));
          expect(await pin?.matches(caller)).toBe(normalizeEmail(owner) === normalizeEmail(caller));
          expect(await pin?.matches(owner.toUpperCase())).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
