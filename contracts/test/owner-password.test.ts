import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isPlatformCallPath,
  MAX_OWNER_PASSWORD_LENGTH,
  MIN_OWNER_PASSWORD_LENGTH,
  OWNER_PASSWORD_CALL_PATH,
  OwnerPassword,
  OwnerPasswordCallBody,
  ownerPasswordLength,
  ownerPasswordProblem,
  PLATFORM_CALL_KEY_LABEL,
  platformCallKey,
  platformCallStringToSign,
  signPlatformCall,
} from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const encoder = new TextEncoder();

interface Vectors {
  readonly cookieSecret: string;
  readonly keyLabel: string;
  readonly keyHex: string;
  readonly cases: readonly {
    readonly method: string;
    readonly path: string;
    readonly timestamp: number;
    readonly body: string;
    readonly stringToSign: string;
    readonly headers: Record<string, string>;
  }[];
}

const vectors = JSON.parse(
  readFileSync(join(root, "vectors", "platform-call-v1.json"), "utf8"),
) as Vectors;

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("the platform call's signature (WP3.34)", () => {
  it("derives the key from the cookie secret under its own label", async () => {
    expect(vectors.keyLabel).toBe(PLATFORM_CALL_KEY_LABEL);
    expect(hex(await platformCallKey(vectors.cookieSecret))).toBe(vectors.keyHex);
  });

  it("reproduces the vectors, which node:crypto computed independently", async () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(2);
    for (const c of vectors.cases) {
      const headers = await signPlatformCall({
        cookieSecret: vectors.cookieSecret,
        method: c.method,
        path: c.path,
        timestamp: c.timestamp,
        body: encoder.encode(c.body),
      });
      expect(headers).toEqual(c.headers);
      expect(c.stringToSign.split("\n")).toHaveLength(5);
      expect(c.path).toBe(OWNER_PASSWORD_CALL_PATH);
    }
  });

  it("changes the signature with any part of the request", async () => {
    const base = {
      cookieSecret: vectors.cookieSecret,
      method: "POST",
      path: OWNER_PASSWORD_CALL_PATH,
      timestamp: 1_792_407_600,
      body: encoder.encode(
        '{"password":"synthetic-vector-password-1","nonce":"00000000000000000000000000000001"}',
      ),
    };
    const signature = async (input: typeof base) =>
      (await signPlatformCall(input))["x-cfo-call-signature"];
    const reference = await signature(base);
    const variants = [
      { ...base, cookieSecret: `${base.cookieSecret}x` },
      { ...base, method: "PUT" },
      { ...base, path: "/_cfo/owner-passwords" },
      { ...base, timestamp: base.timestamp + 1 },
      {
        ...base,
        body: encoder.encode(
          '{"password":"synthetic-vector-password-1","nonce":"00000000000000000000000000000002"}',
        ),
      },
    ];
    for (const variant of variants) expect(await signature(variant)).not.toBe(reference);
  });

  it("joins exactly five lines, with no trailing newline", () => {
    expect(
      platformCallStringToSign({ method: "POST", path: "/p", timestamp: "1", bodySha256: "ab" }),
    ).toBe("cfo-platform-call/v1\nPOST\n/p\n1\nab");
  });
});

describe("the owner's password rules", () => {
  it("counts Unicode code points, as Omnigent does", () => {
    expect(ownerPasswordLength("🔑🔑🔑🔑")).toBe(4);
    expect(ownerPasswordProblem("🔑🔑🔑🔑")).toBe("too_short");
    expect(ownerPasswordProblem("🔑".repeat(MIN_OWNER_PASSWORD_LENGTH))).toBeNull();
    expect(ownerPasswordProblem("a".repeat(MIN_OWNER_PASSWORD_LENGTH - 1))).toBe("too_short");
    expect(ownerPasswordProblem("a".repeat(MIN_OWNER_PASSWORD_LENGTH))).toBeNull();
    expect(ownerPasswordProblem("a".repeat(MAX_OWNER_PASSWORD_LENGTH))).toBeNull();
    expect(ownerPasswordProblem("a".repeat(MAX_OWNER_PASSWORD_LENGTH + 1))).toBe("too_long");
    expect(ownerPasswordProblem("🔑".repeat(MAX_OWNER_PASSWORD_LENGTH))).toBeNull();
  });

  it("accepts exactly the lengths the rule accepts", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (password) => {
        const ok = ownerPasswordProblem(password) === null;
        expect(OwnerPassword.safeParse(password).success).toBe(ok);
        expect(OwnerPasswordCallBody.safeParse({ password, nonce: "0".repeat(32) }).success).toBe(
          ok,
        );
      }),
    );
  });

  it("refuses a body with anything but the password and a nonce", () => {
    const nonce = "0123456789abcdef".repeat(2);
    expect(OwnerPasswordCallBody.safeParse({ password: "abcdefgh", nonce }).success).toBe(true);
    expect(OwnerPasswordCallBody.safeParse({ password: "abcdefgh" }).success).toBe(false);
    expect(OwnerPasswordCallBody.safeParse({ password: "abcdefgh", nonce: "XYZ" }).success).toBe(
      false,
    );
    expect(
      OwnerPasswordCallBody.safeParse({ password: "abcdefgh", nonce, user: "x" }).success,
    ).toBe(false);
  });
});

describe("platform call paths", () => {
  it.each([
    "/_cfo/owner-password",
    "/_cfo",
    "/_cfo/",
    "/_cfo/anything/else",
    "//_cfo/owner-password",
    "/%5Fcfo/owner-password",
    "/%5fcfo%2Fowner-password",
    "/_cf%6F/owner-password",
    "/%E0%A4%A", // does not decode: refused
  ])("%s is one", (path) => {
    expect(isPlatformCallPath(path)).toBe(true);
  });

  it.each(["/", "/login", "/_cfox", "/v1/_cfo", "/auth/users/me/password", "/_CFO/owner-password"])(
    "%s is not",
    (path) => {
      expect(isPlatformCallPath(path)).toBe(false);
    },
  );
});
