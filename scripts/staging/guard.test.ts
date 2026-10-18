import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  accessAppBody,
  assertAccount,
  assertManaged,
  expired,
  expiry,
  hostnameFor,
  resourceName,
  type StagingResource,
  teardownOrder,
} from "./guard.ts";

const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "owner@example.com" };

describe("staging guard", () => {
  it("names resources with the prefix and rejects bad suffixes", () => {
    expect(resourceName("m0-hello")).toBe("cfo-stg-m0-hello");
    for (const bad of ["", "-x", "x-", "X", "a_b", "a--b", "a.b", "a/b", "x".repeat(60)]) {
      expect(() => resourceName(bad)).toThrow();
    }
  });

  it("refuses to touch anything without the prefix", () => {
    for (const name of ["inyanda", "agents", "cfo-stg-", "cfo-prod-x", "Cfo-stg-x"]) {
      expect(() => assertManaged(name)).toThrow();
    }
    expect(() => assertManaged("cfo-stg-x")).not.toThrow();
  });

  it("never produces an unmanaged name from any suffix", () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        try {
          const name = resourceName(suffix);
          expect(name.startsWith("cfo-stg-")).toBe(true);
          expect(() => assertManaged(name)).not.toThrow();
        } catch {
          // rejected suffixes are fine
        }
      }),
    );
  });

  it("builds hostnames only for managed names", () => {
    expect(hostnameFor("cfo-stg-x", "example.com")).toBe("cfo-stg-x.example.com");
    expect(() => hostnameFor("agents", "example.com")).toThrow();
    expect(() => hostnameFor("cfo-stg-x", "not a zone")).toThrow();
  });

  it("requires the configured account to be accessible", () => {
    expect(() => assertAccount("a".repeat(32), ["a".repeat(32)])).not.toThrow();
    expect(() => assertAccount("a".repeat(32), ["b".repeat(32)])).toThrow();
    expect(() => assertAccount("not-an-id", ["not-an-id"])).toThrow();
  });

  it("bounds lifetimes and finds expired resources", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(expiry(now, 7)).toBe("2026-10-25T12:00:00.000Z");
    expect(() => expiry(now, 0)).toThrow();
    expect(() => expiry(now, 31)).toThrow();
    const make = (name: string, expiresAt: string): StagingResource => ({
      kind: "worker",
      name,
      owner: "wp0.4",
      createdAt: now.toISOString(),
      expiresAt,
    });
    const list = [
      make("cfo-stg-old", "2026-10-18T11:59:59Z"),
      make("cfo-stg-new", "2026-10-19T00:00:00Z"),
    ];
    expect(expired(list, now).map((r) => r.name)).toEqual(["cfo-stg-old"]);
  });

  it("tears down Workers before their Access apps, and only managed resources", () => {
    const base = { owner: "x", createdAt: "", expiresAt: "" };
    const order = teardownOrder([
      { ...base, kind: "access-app", name: "cfo-stg-a" },
      { ...base, kind: "worker", name: "cfo-stg-a" },
    ]);
    expect(order.map((r) => r.kind)).toEqual(["worker", "access-app"]);
    expect(() => teardownOrder([{ ...base, kind: "worker", name: "agents" }])).toThrow();
  });

  it("builds an owner-only Access application for the exact hostname", () => {
    const body = accessAppBody("cfo-stg-a", "cfo-stg-a.example.com", config);
    expect(body).toMatchObject({
      type: "self_hosted",
      name: "cfo-stg-a",
      domain: "cfo-stg-a.example.com",
      policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }],
    });
    expect(() => accessAppBody("cfo-stg-a", "cfo-stg-b.example.com", config)).toThrow();
    expect(() => accessAppBody("agents", "agents.example.com", config)).toThrow();
  });
});
