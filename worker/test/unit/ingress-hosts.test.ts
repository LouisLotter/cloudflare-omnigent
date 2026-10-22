import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_HEADERS,
  isAllowedHost,
  parseHostnames,
  strippedHeaders,
  withoutAccessCookie,
} from "../../src/ingress/hosts.ts";

describe("parseHostnames", () => {
  it("reads a comma-separated list, trimmed and lowercased", () => {
    expect(parseHostnames("cfo.example.com")).toEqual(["cfo.example.com"]);
    expect(parseHostnames(" CFO.Example.com , second.example.com,")).toEqual([
      "cfo.example.com",
      "second.example.com",
    ]);
  });

  it("refuses an empty list and anything that is not a plain hostname", () => {
    for (const bad of [
      undefined,
      "",
      " , ",
      "localhost",
      "https://cfo.example.com",
      "cfo.example.com:443",
      "cfo.example.com/",
      "*.example.com",
      "cfo.example.com.",
      "-cfo.example.com",
      "cfo_x.example.com",
      "cfo.example.com,https://evil.example",
      `${"a".repeat(64)}.example.com`,
    ]) {
      expect(parseHostnames(bad), String(bad)).toBeUndefined();
    }
  });
});

describe("isAllowedHost", () => {
  const allowed = ["cfo-stg-wp21-ingress.example.com"];
  it.each([
    ["https://cfo-stg-wp21-ingress.example.com/x", true],
    ["https://CFO-STG-WP21-INGRESS.example.com/", true],
    ["https://cfo-stg-wp21-ingress.example.com:8443/", true],
    ["https://cfo-stg-wp21-ingress.example.com./", false],
    ["https://cfo-stg-wp21-ingress.example.com.evil.test/", false],
    ["https://evil-cfo-stg-wp21-ingress.example.com/", false],
    ["https://x.cfo-stg-wp21-ingress.example.com/", false],
    ["https://cfo-stg-wp21-ingress.workers.dev/", false],
    ["https://example.com/", false],
  ])("%s -> %s", (url, ok) => {
    expect(isAllowedHost(new URL(url), allowed)).toBe(ok);
  });
});

describe("strippedHeaders", () => {
  it("removes identity and Access headers, and only the Access cookie", () => {
    const incoming = new Headers({
      "Cf-Access-Jwt-Assertion": "t",
      "Cf-Access-Authenticated-User-Email": "x@example.invalid",
      "Cf-Access-Authenticated-User-Id": "id",
      "Cf-Access-Client-Id": "id",
      "Cf-Access-Client-Secret": "s",
      "Cf-Access-Anything-New": "v",
      "X-Forwarded-Email": "x@example.invalid",
      "X-Forwarded-User": "x",
      "Remote-User": "x",
      Authorization: "Bearer omnigent-token",
      Cookie: "CF_Authorization=t; __Host-session=s; theme=dark",
      Accept: "application/json",
      "Cf-Connecting-Ip": "192.0.2.1",
      Upgrade: "websocket",
    });
    const out = strippedHeaders(incoming);
    const names = [...out.keys()];
    expect(names.filter((n) => n.startsWith("cf-access-"))).toEqual([]);
    for (const name of IDENTITY_HEADERS) expect(out.has(name), name).toBe(false);
    expect(out.get("authorization")).toBe("Bearer omnigent-token");
    expect(out.get("cookie")).toBe("__Host-session=s; theme=dark");
    expect(out.get("accept")).toBe("application/json");
    expect(out.get("cf-connecting-ip")).toBe("192.0.2.1");
    expect(out.get("upgrade")).toBe("websocket");
    // The input is untouched.
    expect(incoming.get("cf-access-jwt-assertion")).toBe("t");
  });

  it("drops the Cookie header when only the Access cookie was there", () => {
    expect(strippedHeaders(new Headers({ Cookie: "cf_authorization=t" })).has("cookie")).toBe(
      false,
    );
    expect(strippedHeaders(new Headers({ Accept: "*/*" })).has("cookie")).toBe(false);
  });
});

describe("withoutAccessCookie", () => {
  it.each([
    ["CF_Authorization=t", undefined],
    ["a=1; CF_Authorization=t; b=2", "a=1; b=2"],
    ["a=1;CF_Authorization=t;b=2", "a=1; b=2"],
    ["cf_authorization=t; CF_AUTHORIZATION=u; a=1", "a=1"],
    ["a=1, CF_Authorization=t, b=2", "a=1; b=2"],
    ["CF_Authorization; a=1", "a=1"],
    [" CF_Authorization =t; a=1", "a=1"],
    ["CF_Authorization_x=1; xCF_Authorization=2", "CF_Authorization_x=1; xCF_Authorization=2"],
    ["a=1; ; b=2;", "a=1; b=2"],
  ])("%s -> %s", (cookie, expected) => {
    expect(withoutAccessCookie(cookie)).toBe(expected);
  });

  const name = fc
    .stringMatching(/^[A-Za-z0-9_-]{1,12}$/)
    .filter((n) => !/^cf_authorization$/i.test(n));
  const value = fc.stringMatching(/^[A-Za-z0-9._~-]{0,20}$/);
  const accessName = fc.constantFrom("CF_Authorization", "cf_authorization", "Cf_Authorization");

  it("property: the Access cookie never survives, wherever it sits and however pairs are joined", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(name, value), { maxLength: 6 }),
        fc.array(fc.tuple(fc.nat(6), accessName, value), { minLength: 1, maxLength: 3 }),
        fc.constantFrom("; ", ";", ", "),
        (others, access, separator) => {
          const pairs = others.map(([n, v]) => `${n}=${v}`);
          for (const [at, n, v] of access) pairs.splice(Math.min(at, pairs.length), 0, `${n}=${v}`);
          const out = withoutAccessCookie(pairs.join(separator));
          expect(out ?? "").not.toMatch(/(^|[;,]\s*)cf_authorization=/i);
          // Every other cookie is kept, in order.
          expect(out).toBe(
            others.length > 0 ? others.map(([n, v]) => `${n}=${v}`).join("; ") : undefined,
          );
        },
      ),
    );
  });
});
