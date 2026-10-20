import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AccessAssertionClaims,
  DURABILITY_UNCONFIRMED_CODE,
  DURABILITY_UNCONFIRMED_MESSAGE,
  DurabilityUnconfirmed,
  DurabilityUnconfirmedAuth,
  durabilityBodyShape,
  OutageRecord,
  outageOverlaps,
  Timestamp,
  wireSchemas,
} from "../src/index.ts";

describe("OutageRecord time order (checked here, not in the JSON Schema)", () => {
  const record = {
    outageId: "out_01hs3f9q2m8z4w7k6t5r1n0ybc",
    cause: "not_answering",
    startedAt: "2026-10-20T03:00:00Z",
    detectedAt: "2026-10-20T03:02:00.5Z",
    endedAt: "2026-10-20T03:12:00Z",
    restarts: 0,
  };

  it("accepts ordered times, including mixed precision and an ongoing outage", () => {
    expect(OutageRecord.safeParse(record).success).toBe(true);
    expect(OutageRecord.safeParse({ ...record, endedAt: null }).success).toBe(true);
    expect(OutageRecord.safeParse({ ...record, detectedAt: record.startedAt }).success).toBe(true);
  });

  it("rejects detection before the start, and an end before detection", () => {
    expect(OutageRecord.safeParse({ ...record, startedAt: "2026-10-20T03:05:00Z" }).success).toBe(
      false,
    );
    expect(OutageRecord.safeParse({ ...record, endedAt: "2026-10-20T03:01:00Z" }).success).toBe(
      false,
    );
  });

  it("orders any three instants it accepts", () => {
    fc.assert(
      fc.property(
        fc.array(fc.date({ min: new Date(0), max: new Date(4e12), noInvalidDate: true }), {
          minLength: 3,
          maxLength: 3,
        }),
        ([a, b, c]) => {
          const [startedAt, detectedAt, endedAt] = [a, b, c].map((d) => d?.toISOString());
          const parsed = OutageRecord.safeParse({ ...record, startedAt, detectedAt, endedAt });
          const ordered =
            (a?.getTime() ?? 0) <= (b?.getTime() ?? 0) &&
            (b?.getTime() ?? 0) <= (c?.getTime() ?? 0);
          expect(parsed.success).toBe(ordered);
        },
      ),
    );
  });
});

describe("outageOverlaps", () => {
  const base = {
    outageId: "out_01hs3f9q2m8z4w7k6t5r1n0ybc",
    cause: "container_stopped" as const,
    startedAt: "2026-10-20T03:00:00Z",
    detectedAt: "2026-10-20T03:01:00Z",
    endedAt: "2026-10-20T03:12:00Z",
    restarts: 1,
  };
  it("treats the range as half-open, and an ongoing outage as open-ended", () => {
    expect(outageOverlaps(base, "2026-10-20T02:00:00Z", "2026-10-20T03:00:00Z")).toBe(false);
    expect(outageOverlaps(base, "2026-10-20T03:12:00Z", "2026-10-20T04:00:00Z")).toBe(false);
    expect(outageOverlaps(base, "2026-10-20T03:11:59Z", "2026-10-20T04:00:00Z")).toBe(true);
    expect(outageOverlaps(base, "2026-10-20T02:00:00Z", "2026-10-20T03:00:00.001Z")).toBe(true);
    const ongoing = { ...base, endedAt: null };
    expect(outageOverlaps(ongoing, "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z")).toBe(true);
    expect(outageOverlaps(ongoing, "2026-10-19T00:00:00Z", "2026-10-20T03:00:00Z")).toBe(false);
  });
});

describe("Timestamp", () => {
  it("accepts toISOString output and refuses offsets and dates without a time", () => {
    expect(Timestamp.safeParse(new Date(0).toISOString()).success).toBe(true);
    expect(Timestamp.safeParse("2026-10-20T05:00:00+02:00").success).toBe(false);
    expect(Timestamp.safeParse("2026-10-20").success).toBe(false);
  });
});

describe("the two 424 bodies", () => {
  it("chooses the body each route family's clients parse", () => {
    expect(durabilityBodyShape("/auth/password")).toBe("auth");
    expect(durabilityBodyShape("/oauth/token")).toBe("auth");
    expect(durabilityBodyShape("/v1/scheduled-tasks")).toBe("api");
    expect(durabilityBodyShape("/authorize")).toBe("api");
    expect(durabilityBodyShape("/v1/auth/x")).toBe("api");
  });

  it("accepts the bodies built from the shared constants, and neither accepts the other", () => {
    const api = {
      error: { code: DURABILITY_UNCONFIRMED_CODE, message: DURABILITY_UNCONFIRMED_MESSAGE },
      applied: true,
    };
    const auth = {
      error: DURABILITY_UNCONFIRMED_MESSAGE,
      code: DURABILITY_UNCONFIRMED_CODE,
      applied: true,
    };
    expect(DurabilityUnconfirmed.parse(api)).toEqual(api);
    expect(DurabilityUnconfirmedAuth.parse(auth)).toEqual(auth);
    expect(DurabilityUnconfirmed.safeParse(auth).success).toBe(false);
    expect(DurabilityUnconfirmedAuth.safeParse(api).success).toBe(false);
  });
});

describe("AccessAssertionClaims", () => {
  it("keeps claims it does not check, and refuses a token for another kind of client", () => {
    const claims = {
      aud: ["a".repeat(64)],
      exp: 1792407600,
      iss: "https://example-team.cloudflareaccess.com",
      sub: "7335d417-61da-459d-899c-0a01c76a2f94",
      type: "app",
      custom: { groups: ["x"] },
    };
    expect(AccessAssertionClaims.parse(claims)).toEqual(claims);
    expect(AccessAssertionClaims.safeParse({ ...claims, iss: "https://a" }).success).toBe(false);
    expect(
      AccessAssertionClaims.safeParse({ ...claims, iss: "https://team.example.com/path" }).success,
    ).toBe(false);
  });
});

describe("every wire schema", () => {
  it("reports failure on arbitrary JSON input, and never throws", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        for (const schema of Object.values(wireSchemas)) {
          expect(() => schema.safeParse(value)).not.toThrow();
        }
      }),
    );
  });
});
