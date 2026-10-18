import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccessConfig,
  base64UrlDecode,
  base64UrlEncode,
  certsUrlFor,
  checkHost,
  issuerFor,
  JwksCache,
  KEYS_UNAVAILABLE,
  MAX_ASSERTION_BYTES,
  sha256Hex,
  upstreamHeaders,
  validateAccessJwt,
} from "../src/access.ts";
import { deriveNegativeCases } from "../src/selftest.ts";
import {
  AUD,
  claims,
  ISSUER,
  makeKey,
  OTHER_AUD,
  sign,
  staticKeys,
  type TestKey,
  unavailableKeys,
} from "./keys.ts";

const NOW = 1_800_000_000;
const config: AccessConfig = { issuer: ISSUER, audience: AUD };

let key: TestKey;
let rogue: TestKey; // same kid as `key`, different key pair: a forger's key
let other: TestKey; // a second genuine team key, as after a rotation

beforeAll(async () => {
  key = await makeKey("kid-current");
  rogue = await makeKey("kid-current");
  other = await makeKey("kid-previous");
});

async function reason(token: string | null, c: AccessConfig = config, now = NOW) {
  const r = await validateAccessJwt(token, c, staticKeys([key, other]), now);
  return r.ok ? "ok" : r.reason;
}

describe("validateAccessJwt", () => {
  it("accepts a genuine assertion and returns the identity", async () => {
    const r = await validateAccessJwt(await sign(key, claims(NOW)), config, staticKeys([key]), NOW);
    expect(r).toEqual({
      ok: true,
      identity: {
        sub: "00000000-0000-4000-8000-000000000001",
        email: "owner@example.invalid",
        exp: NOW + 600,
        iat: NOW - 10,
      },
    });
  });

  it("accepts a token signed by the previous key during rotation", async () => {
    expect(await reason(await sign(other, claims(NOW)))).toBe("ok");
  });

  it("accepts `aud` as a string", async () => {
    expect(await reason(await sign(key, claims(NOW, { aud: AUD })))).toBe("ok");
  });

  it("fails closed when not configured", async () => {
    const token = await sign(key, claims(NOW));
    expect(await reason(token, { issuer: "", audience: AUD })).toBe("not_configured");
    expect(await reason(token, { issuer: ISSUER, audience: "" })).toBe("not_configured");
  });

  it.each([
    ["absent", null],
    ["empty", ""],
  ])("rejects a missing assertion (%s)", async (_, token) => {
    expect(await reason(token)).toBe("missing_assertion");
  });

  it("rejects an oversized assertion before parsing", async () => {
    expect(await reason("a".repeat(MAX_ASSERTION_BYTES + 1))).toBe("oversized");
  });

  it("rejects malformed tokens", async () => {
    const good = await sign(key, claims(NOW));
    const [h, p, s] = good.split(".") as [string, string, string];
    const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
    const cases = [
      `${h}.${p}`,
      `${h}.${p}.${s}.x`,
      `${h}.${p}.`,
      `${h}!.${p}.${s}`,
      `${enc([1, 2])}.${p}.${s}`,
      `${h}.${enc("text")}.${s}`,
      `${base64UrlEncode(new TextEncoder().encode("{not json"))}.${p}.${s}`,
      `${enc({ alg: "RS256" })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "" })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "k".repeat(129) })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "kid-current", typ: "JWE" })}.${p}.${s}`,
    ];
    for (const token of cases) expect(await reason(token)).toBe("malformed");
  });

  it.each(["none", "HS256", "RS512", "ES256", "PS256", undefined])(
    "rejects alg %s",
    async (alg) => {
      const good = await sign(key, claims(NOW));
      const [, p, s] = good.split(".");
      const h = base64UrlEncode(
        new TextEncoder().encode(JSON.stringify({ alg, kid: "kid-current" })),
      );
      expect(await reason(`${h}.${p}.${s}`)).toBe("unsupported_alg");
    },
  );

  it("rejects an unknown key id", async () => {
    const stranger = await makeKey("kid-unknown");
    expect(await reason(await sign(stranger, claims(NOW)))).toBe("unknown_kid");
  });

  it("reports unavailable keys rather than guessing", async () => {
    const r = await validateAccessJwt(await sign(key, claims(NOW)), config, unavailableKeys, NOW);
    expect(r).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("rejects a forger's signature under a genuine kid", async () => {
    expect(await reason(await sign(rogue, claims(NOW)))).toBe("bad_signature");
  });

  it("rejects a payload or header edited after signing", async () => {
    const good = await sign(key, claims(NOW));
    const [h, , s] = good.split(".");
    const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));
    expect(await reason(`${h}.${enc(claims(NOW, { aud: [OTHER_AUD] }))}.${s}`)).toBe(
      "bad_signature",
    );
    expect(await reason(`${h}.${enc(claims(NOW, { exp: NOW + 99_999 }))}.${s}`)).toBe(
      "bad_signature",
    );
    const [, p] = good.split(".");
    expect(
      await reason(`${enc({ alg: "RS256", kid: "kid-current", typ: "JWT", x: 1 })}.${p}.${s}`),
    ).toBe("bad_signature");
  });

  it("rejects a genuinely signed token from the wrong issuer", async () => {
    expect(
      await reason(await sign(key, claims(NOW, { iss: "https://other.cloudflareaccess.com" }))),
    ).toBe("wrong_issuer");
    expect(await reason(await sign(key, claims(NOW, { iss: undefined })))).toBe("wrong_issuer");
    expect(await reason(await sign(key, claims(NOW, { iss: `${ISSUER}/` })))).toBe("wrong_issuer");
  });

  it("rejects a token for another application, or with no audience", async () => {
    expect(await reason(await sign(key, claims(NOW, { aud: [OTHER_AUD] })))).toBe("wrong_audience");
    expect(await reason(await sign(key, claims(NOW, { aud: [] })))).toBe("wrong_audience");
    expect(await reason(await sign(key, claims(NOW, { aud: undefined })))).toBe("wrong_audience");
    expect(await reason(await sign(key, claims(NOW, { aud: { a: AUD } })))).toBe("wrong_audience");
    expect(await reason(await sign(key, claims(NOW, { aud: [AUD.toUpperCase()] })))).toBe(
      "wrong_audience",
    );
  });

  it("checks expiry with leeway", async () => {
    const token = await sign(key, claims(NOW));
    expect(await reason(token, config, NOW + 600 + 29)).toBe("ok");
    expect(await reason(token, config, NOW + 600 + 30)).toBe("expired");
    expect(await reason(token, { ...config, leewaySeconds: 0 }, NOW + 600)).toBe("expired");
    expect(await reason(await sign(key, claims(NOW, { exp: undefined })))).toBe("malformed");
    expect(await reason(await sign(key, claims(NOW, { exp: "soon" })))).toBe("malformed");
  });

  it("checks nbf and iat with leeway", async () => {
    expect(await reason(await sign(key, claims(NOW, { nbf: NOW + 31 })))).toBe("not_yet_valid");
    expect(await reason(await sign(key, claims(NOW, { nbf: NOW + 30 })))).toBe("ok");
    expect(await reason(await sign(key, claims(NOW, { iat: NOW + 31 })))).toBe("not_yet_valid");
    expect(await reason(await sign(key, claims(NOW, { nbf: "x" })))).toBe("malformed");
    expect(await reason(await sign(key, claims(NOW, { iat: "x" })))).toBe("malformed");
    expect(await reason(await sign(key, claims(NOW, { nbf: undefined, iat: undefined })))).toBe(
      "ok",
    );
  });

  it("accepts only application tokens", async () => {
    expect(await reason(await sign(key, claims(NOW, { type: "org" })))).toBe("wrong_token_type");
    expect(await reason(await sign(key, claims(NOW, { type: undefined })))).toBe(
      "wrong_token_type",
    );
  });

  it("requires sub", async () => {
    expect(await reason(await sign(key, claims(NOW, { sub: undefined })))).toBe("malformed");
  });

  it("pins the owner by email hash, case-insensitively", async () => {
    const pinned = { ...config, ownerEmailSha256: await sha256Hex("owner@example.invalid") };
    expect(
      await reason(await sign(key, claims(NOW, { email: "Owner@Example.invalid " })), pinned),
    ).toBe("ok");
    expect(
      await reason(await sign(key, claims(NOW, { email: "other@example.invalid" })), pinned),
    ).toBe("not_owner");
    expect(await reason(await sign(key, claims(NOW, { email: undefined })), pinned)).toBe(
      "not_owner",
    );
  });

  it("property: any single-character change to a genuine token is refused", async () => {
    const token = await sign(key, claims(NOW));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.";
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: token.length - 1 }),
        fc.constantFrom(...alphabet.split("")),
        async (i, c) => {
          fc.pre(token[i] !== c);
          const mutated = token.slice(0, i) + c + token.slice(i + 1);
          expect(await reason(mutated)).not.toBe("ok");
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("base64url", () => {
  it("refuses non-canonical spellings", () => {
    const canonical = base64UrlEncode(new Uint8Array([0xff]));
    expect(canonical).toBe("_w");
    expect(() => base64UrlDecode("_x")).toThrow("non-canonical");
    expect(() => base64UrlDecode("_w=")).toThrow();
    expect(() => base64UrlDecode("a")).toThrow();
    expect([...base64UrlDecode(canonical)]).toEqual([0xff]);
  });
});

describe("team domain", () => {
  it("derives issuer and certs URL, and refuses anything else", () => {
    expect(issuerFor("team.cloudflareaccess.com")).toBe("https://team.cloudflareaccess.com");
    expect(certsUrlFor("team.cloudflareaccess.com")).toBe(
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    for (const bad of [
      "evil.com",
      "team.cloudflareaccess.com.evil.com",
      "https://team.cloudflareaccess.com",
      "",
    ]) {
      expect(() => issuerFor(bad)).toThrow();
    }
  });
});

describe("checkHost", () => {
  const allowed = ["cfo-stg-s5-access.example.com"];
  it.each([
    ["https://cfo-stg-s5-access.example.com/x", true],
    ["https://CFO-STG-S5-ACCESS.example.com/", true],
    ["https://cfo-stg-s5-access.example.com.evil.test/", false],
    ["https://evil-cfo-stg-s5-access.example.com/", false],
    ["https://cfo-stg-s5-access.workers.dev/", false],
    ["https://example.com/", false],
  ])("%s -> %s", (url, ok) => {
    expect(checkHost(new URL(url), allowed)).toBe(ok);
  });
});

describe("JwksCache", () => {
  function server(bodies: (() => Response)[]) {
    let i = 0;
    const calls: string[] = [];
    return {
      calls,
      fetcher: async (url: string) => {
        calls.push(url);
        const next = bodies[Math.min(i, bodies.length - 1)];
        i++;
        if (!next) throw new Error("no body");
        return next();
      },
    };
  }
  const jwks =
    (...keys: TestKey[]) =>
    () =>
      Response.json({ keys: keys.map((k) => k.jwk) });

  it("fetches once and caches", async () => {
    let now = 0;
    const s = server([jwks(key)]);
    const cache = new JwksCache("https://t/certs", s.fetcher, () => now);
    expect(await cache.key("kid-current")).toBeDefined();
    now = 1000;
    expect(await cache.key("kid-current")).toBeDefined();
    expect(s.calls).toHaveLength(1);
  });

  it("refetches for an unknown kid at most once per interval, and picks up a rotation", async () => {
    let now = 0;
    const s = server([jwks(key), jwks(key, other)]);
    const cache = new JwksCache("https://t/certs", s.fetcher, () => now);
    await cache.key("kid-current");
    now = 10_000; // within minRefetchMs (30 s)
    expect(await cache.key("kid-previous")).toBeUndefined();
    expect(s.calls).toHaveLength(1);
    now = 40_000;
    expect(await cache.key("kid-previous")).toBeDefined();
    expect(s.calls).toHaveLength(2);
    // A flood of random kids costs no further fetches inside the interval.
    for (let i = 0; i < 50; i++) await cache.key(`random-${i}`);
    expect(s.calls).toHaveLength(2);
  });

  it("keeps known keys through a certs outage, up to the stale limit", async () => {
    let now = 0;
    const s = server([jwks(key), () => new Response("down", { status: 503 })]);
    const cache = new JwksCache("https://t/certs", s.fetcher, () => now);
    await cache.key("kid-current");
    now = 11 * 60_000; // past ttl: refetch fails, the key still works
    expect(await cache.key("kid-current")).toBeDefined();
    now = 25 * 3_600_000; // past maxStaleMs
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
  });

  it("reports keys_unavailable with no keys at all", async () => {
    const s = server([() => new Response("x", { status: 500 })]);
    const cache = new JwksCache("https://t/certs", s.fetcher, () => 0);
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    const thrown = new JwksCache(
      "https://t/certs",
      async () => {
        throw new Error("network");
      },
      () => 0,
    );
    expect(await thrown.key("kid-current")).toBe(KEYS_UNAVAILABLE);
  });

  it("ignores non-RS256 keys, junk and oversized documents", async () => {
    const junk = () =>
      Response.json({
        keys: [
          { kty: "EC", kid: "ec", crv: "P-256", x: "x", y: "y" },
          { ...key.jwk, alg: "RS512", kid: "rs512" },
          { ...key.jwk, use: "enc", kid: "enc" },
          { kty: "RSA", kid: "broken", n: "!!", e: "AQAB" },
          null,
          other.jwk,
        ],
      });
    const cache = new JwksCache("https://t/certs", server([junk]).fetcher, () => 0);
    expect(await cache.key("kid-previous")).toBeDefined();
    for (const kid of ["ec", "rs512", "enc", "broken"])
      expect(await cache.key(kid)).toBeUndefined();
    const big = new JwksCache(
      "https://t/certs",
      server([() => new Response("x".repeat(70_000))]).fetcher,
      () => 0,
    );
    expect(await big.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    const noKeys = new JwksCache(
      "https://t/certs",
      server([() => Response.json({})]).fetcher,
      () => 0,
    );
    expect(await noKeys.key("kid-current")).toBe(KEYS_UNAVAILABLE);
  });

  it("shares one fetch between concurrent lookups", async () => {
    const s = server([jwks(key)]);
    const cache = new JwksCache("https://t/certs", s.fetcher, () => 0);
    await Promise.all([cache.key("kid-current"), cache.key("kid-current"), cache.key("x")]);
    expect(s.calls).toHaveLength(1);
  });

  it("validates end to end through the cache", async () => {
    const cache = new JwksCache("https://t/certs", server([jwks(key)]).fetcher, () => 0);
    const r = await validateAccessJwt(await sign(key, claims(NOW)), config, cache, NOW);
    expect(r.ok).toBe(true);
  });
});

describe("upstreamHeaders", () => {
  it("strips identity and Access headers, and only the Access cookie", () => {
    const h = new Headers({
      "Cf-Access-Jwt-Assertion": "t",
      "Cf-Access-Authenticated-User-Email": "x@example.invalid",
      "X-Forwarded-Email": "x@example.invalid",
      "X-Forwarded-User": "x",
      "Cf-Access-Client-Id": "id",
      "Cf-Access-Client-Secret": "s",
      Authorization: "Bearer omnigent-token",
      Cookie: "CF_Authorization=t; __Host-ap_session=s; theme=dark",
      Accept: "application/json",
    });
    const out = upstreamHeaders(h);
    for (const name of [
      "cf-access-jwt-assertion",
      "cf-access-authenticated-user-email",
      "x-forwarded-email",
      "x-forwarded-user",
      "cf-access-client-id",
      "cf-access-client-secret",
    ]) {
      expect(out.has(name)).toBe(false);
    }
    expect(out.get("authorization")).toBe("Bearer omnigent-token");
    expect(out.get("cookie")).toBe("__Host-ap_session=s; theme=dark");
    expect(out.get("accept")).toBe("application/json");
  });

  it("drops the Cookie header when only the Access cookie was there", () => {
    expect(upstreamHeaders(new Headers({ Cookie: "cf_authorization=t" })).has("cookie")).toBe(
      false,
    );
  });
});

describe("deriveNegativeCases", () => {
  it("passes every derived case for a genuine token", async () => {
    const cases = await deriveNegativeCases(
      await sign(key, claims(NOW)),
      { ...config, ownerEmailSha256: await sha256Hex("owner@example.invalid") },
      staticKeys([key]),
      NOW,
      { url: new URL("https://s5.example.com/"), allowed: ["s5.example.com"] },
      OTHER_AUD,
    );
    expect(cases.filter((c) => !c.pass)).toEqual([]);
    expect(cases.length).toBeGreaterThanOrEqual(18);
  });
});
