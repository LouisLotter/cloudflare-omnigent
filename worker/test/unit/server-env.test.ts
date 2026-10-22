import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PASSWORD_SECRET,
  bootstrapSecretPresent,
  configFingerprint,
  serverContainerEnv,
  serverDeadlines,
} from "../../src/server/server-env.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";

describe("serverContainerEnv", () => {
  it("forwards only SERVER_ENV_ variables, without the prefix, and the installation ID", () => {
    const { vars, skipped } = serverContainerEnv({
      SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: "canary-cookie-secret",
      SERVER_ENV_LITESTREAM_ACCESS_KEY_ID: "canary-key-id",
      CFO_INSTALLATION_ID: INSTALLATION,
      ACCESS_AUD: "not for the server",
      OWNER_EMAIL_HASH: "not for the server",
      OMNIGENT_ACCOUNTS_COOKIE_SECRET: "unprefixed: not forwarded",
      CONTROL: { binding: true },
    });
    expect(vars).toEqual({
      OMNIGENT_ACCOUNTS_COOKIE_SECRET: "canary-cookie-secret",
      LITESTREAM_ACCESS_KEY_ID: "canary-key-id",
      CFO_INSTALLATION_ID: INSTALLATION,
    });
    expect(skipped).toEqual([]);
  });

  it("skips what start() would refuse or the platform sets, naming never a value", () => {
    const { vars, skipped } = serverContainerEnv({
      "SERVER_ENV_BAD=NAME": "x",
      SERVER_ENV_: "x",
      SERVER_ENV_CFO_INSTALLATION_ID: "ins_spoofed",
      SERVER_ENV_NUL: "a\0b",
      SERVER_ENV_OBJECT: { a: 1 },
      SERVER_ENV_HUGE: "x".repeat(40 * 1024),
      CFO_INSTALLATION_ID: "not-an-id",
    });
    expect(vars).toEqual({});
    expect(skipped.map((s) => s.reason).sort()).toEqual(
      [
        "contains NUL",
        "invalid installation ID",
        "invalid name",
        "invalid name",
        "not a string",
        "set by the platform",
        "too long",
      ].sort(),
    );
    expect(JSON.stringify(skipped)).not.toContain("a\0b");
  });

  it("never forwards a variable without the prefix", () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 20 }).filter((k) => !k.startsWith("SERVER_ENV_")),
          fc.string(),
        ),
        (env) => {
          const { vars } = serverContainerEnv(env);
          return Object.keys(vars).every((k) => k === "CFO_INSTALLATION_ID");
        },
      ),
    );
  });

  it("knows whether the bootstrap password is still configured", () => {
    expect(bootstrapSecretPresent({ [BOOTSTRAP_PASSWORD_SECRET]: "canary-password" })).toBe(true);
    expect(bootstrapSecretPresent({ [BOOTSTRAP_PASSWORD_SECRET]: "" })).toBe(false);
    expect(bootstrapSecretPresent({})).toBe(false);
    expect(BOOTSTRAP_PASSWORD_SECRET).toBe("SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD");
  });
});

describe("the server image's deadlines (WP2.3)", () => {
  it("follow the image's defaults, and its settings when set", () => {
    expect(serverDeadlines({})).toEqual({ restoreWaitMs: 420_000, stopGraceMs: 660_000 });
    expect(
      serverDeadlines({
        SERVER_ENV_CFO_RESTORE_DEADLINE_S: "600",
        SERVER_ENV_CFO_LITESTREAM_READY_TIMEOUT_S: "30",
        SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S: " 120 ",
      }),
    ).toEqual({ restoreWaitMs: 690_000, stopGraceMs: 300_000 });
    expect(serverDeadlines({ SERVER_ENV_CFO_RESTORE_DEADLINE_S: "soon" }).restoreWaitMs).toBe(
      420_000,
    );
    expect(serverDeadlines({ SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S: "0" }).stopGraceMs).toBe(660_000);
  });
});

describe("configFingerprint", () => {
  it("changes with any setting, not with their order, and shows no value", async () => {
    const a = await configFingerprint({ A: "1", B: "secret-canary" });
    expect(await configFingerprint({ B: "secret-canary", A: "1" })).toBe(a);
    expect(await configFingerprint({ A: "1", B: "secret-canary2" })).not.toBe(a);
    expect(await configFingerprint({ A: "1" })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toContain("secret");
  });
});
