import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bareUpgradeHeaders,
  isSafeMethod,
  isTrustHeader,
  isUpgrade,
  stripTrustHeaders,
} from "../../src/server/headers.ts";

describe("trust headers", () => {
  it("strips identity, Access and platform-internal headers, and keeps Omnigent's own", () => {
    const headers = new Headers({
      "Cf-Access-Jwt-Assertion": "canary.assertion.value",
      "Cf-Access-Authenticated-User-Email": "owner@example.invalid",
      "X-Forwarded-Email": "attacker@example.invalid",
      "X-Forwarded-User": "attacker",
      "X-Auth-Request-Email": "attacker@example.invalid",
      "Remote-User": "attacker",
      "X-Cfo-Interface-Version": "99",
      "X-CFO-Anything": "1",
      Authorization: "Bearer omnigent-session",
      Cookie: "__Host-ap_session=abc",
      "X-Omnigent-Client": "web",
      "Content-Type": "application/json",
    });
    const removed = stripTrustHeaders(headers);
    expect(removed.sort()).toEqual(
      [
        "cf-access-authenticated-user-email",
        "cf-access-jwt-assertion",
        "remote-user",
        "x-auth-request-email",
        "x-cfo-anything",
        "x-cfo-interface-version",
        "x-forwarded-email",
        "x-forwarded-user",
      ].sort(),
    );
    expect([...headers.keys()].sort()).toEqual(
      ["authorization", "content-type", "cookie", "x-omnigent-client"].sort(),
    );
  });

  it("leaves no header that a prefix or name marks as trusted, in any case", () => {
    const name = fc
      .tuple(
        fc.constantFrom("cf-access-", "x-cfo-", "x-auth-request-", "X-CFO-", "CF-ACCESS-"),
        fc.stringMatching(/^[a-z0-9-]{1,12}$/),
      )
      .map(([p, s]) => p + s);
    fc.assert(
      fc.property(fc.uniqueArray(name, { maxLength: 6 }), (names) => {
        const headers = new Headers(names.map((n) => [n, "v"] as [string, string]));
        stripTrustHeaders(headers);
        return (
          [...headers.keys()].every((k) => !isTrustHeader(k)) && [...headers.keys()].length === 0
        );
      }),
    );
  });
});

describe("bareUpgradeHeaders", () => {
  it("keeps only the subprotocol of a 101", () => {
    const bare = bareUpgradeHeaders(
      new Headers({
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Accept": "abc",
        "Sec-WebSocket-Extensions": "permessage-deflate",
        "Sec-WebSocket-Protocol": "omnigent.v1",
        "Set-Cookie": "a=b",
      }),
    );
    expect([...bare]).toEqual([["sec-websocket-protocol", "omnigent.v1"]]);
    expect([...bareUpgradeHeaders(new Headers({ Upgrade: "websocket" }))]).toEqual([]);
  });
});

describe("request kinds", () => {
  it("knows safe methods and upgrades", () => {
    expect(["GET", "HEAD", "OPTIONS"].every(isSafeMethod)).toBe(true);
    expect(["POST", "PUT", "PATCH", "DELETE", "get"].some(isSafeMethod)).toBe(false);
    expect(isUpgrade(new Request("https://a.test/", { headers: { Upgrade: "WebSocket" } }))).toBe(
      true,
    );
    expect(isUpgrade(new Request("https://a.test/", { headers: { Upgrade: "h2c" } }))).toBe(false);
    expect(isUpgrade(new Request("https://a.test/"))).toBe(false);
  });
});
