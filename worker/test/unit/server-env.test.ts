import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_PASSWORD_SECRET,
  bootstrapSecretPresent,
  configFingerprint,
  DATABASE_CHECK_ALLOWANCE_S,
  serverContainerEnv,
  serverDeadlines,
  UNKNOWN_DEADLINES,
} from "../../src/server/server-env.ts";
import { WATCHDOG_TIMING } from "../../src/server/watchdog.ts";

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
    expect(serverDeadlines({})).toEqual({ restoreWaitMs: 540_000, stopGraceMs: 660_000 });
    // The watchdog's defaults are the image's (watchdog.ts).
    expect(serverDeadlines({}).restoreWaitMs).toBe(WATCHDOG_TIMING.restoreWaitMs);
    expect(
      serverDeadlines({
        SERVER_ENV_CFO_RESTORE_DEADLINE_S: "600",
        SERVER_ENV_CFO_LITESTREAM_READY_TIMEOUT_S: "30",
        SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S: " 120 ",
      }),
    ).toEqual({ restoreWaitMs: 810_000, stopGraceMs: 300_000 });
    expect(serverDeadlines({ SERVER_ENV_CFO_RESTORE_DEADLINE_S: "soon" }).restoreWaitMs).toBe(
      (3600 + DATABASE_CHECK_ALLOWANCE_S + 60 + 60) * 1000,
    );
    expect(serverDeadlines({ SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S: "0" }).stopGraceMs).toBe(
      (2 * 3600 + 60) * 1000,
    );
  });

  it("reads seconds as the image does, so the grace is never shorter than its own (Codex r3-3)", () => {
    const grace = (value: string) =>
      serverDeadlines({ SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S: value }).stopGraceMs;
    for (const value of [
      "900",
      "900.0",
      "9e2",
      "9E+2",
      " 900 ",
      "9_00",
      "+900",
      "900.",
      "９００", // fullwidth (Codex r4-1)
      "٩٠٠", // Arabic-Indic
      "९००", // Devanagari
      "\u00a0900\u2003",
    ]) {
      expect(grace(value), value).toBe(1_860_000);
    }
    expect(grace("0.5")).toBe(61_000);
    expect(grace(".5")).toBe(61_000);
    // Set, but not something this parser can read as the image would: never a short grace.
    for (const value of ["inf", "nan", "-5", "0x10", "1e400", "", "9__00", "_900", "soon"]) {
      expect(grace(value), value).toBe(2 * 3_600_000 + 60_000);
    }
    expect(serverDeadlines({}).stopGraceMs).toBe(660_000);
  });
});

describe("the deadlines of a container whose settings are unknown (Codex G2-SEC-001 r2-1)", () => {
  it("are never shorter than the image's from unreadable settings or ones up to an hour", () => {
    const setting = fc.oneof(
      fc.constant(undefined),
      fc.constantFrom("soon", "", "0", "-5", "nan"),
      fc.integer({ min: 1, max: 3600 }).map(String),
    );
    fc.assert(
      fc.property(setting, setting, setting, (restore, ready, finalSync) => {
        const env: Record<string, unknown> = {};
        if (restore !== undefined) env.SERVER_ENV_CFO_RESTORE_DEADLINE_S = restore;
        if (ready !== undefined) env.SERVER_ENV_CFO_LITESTREAM_READY_TIMEOUT_S = ready;
        if (finalSync !== undefined) env.SERVER_ENV_CFO_FINAL_SYNC_TIMEOUT_S = finalSync;
        const read = serverDeadlines(env);
        return (
          read.restoreWaitMs <= UNKNOWN_DEADLINES.restoreWaitMs &&
          read.stopGraceMs <= UNKNOWN_DEADLINES.stopGraceMs
        );
      }),
    );
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
