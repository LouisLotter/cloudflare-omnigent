import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AccessSettings,
  base64UrlDecode,
  base64UrlEncode,
  certsUrlFor,
  importJwk,
  issuerFor,
  JwksCache,
  type JwksOptions,
  KEYS_UNAVAILABLE,
  MAX_ASSERTION_LENGTH,
  validateAssertion,
} from "../../src/ingress/access.ts";
import {
  AUD,
  claims,
  ISSUER,
  jwksResponse,
  makeKey,
  OTHER_AUD,
  OWNER_SUB,
  sign,
  staticKeys,
  type TestKey,
  unavailableKeys,
} from "../support/access-keys.ts";

const NOW = 1_800_000_000;
const settings: AccessSettings = { issuer: ISSUER, audience: AUD };
const enc = (v: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(v)));

let key: TestKey;
let rogue: TestKey; // same kid as `key`, another key pair: a forger's key
let other: TestKey; // a second genuine team key, as during a rotation

beforeAll(async () => {
  [key, rogue, other] = await Promise.all([
    makeKey("kid-current"),
    makeKey("kid-current"),
    makeKey("kid-previous"),
  ]);
});

async function reason(token: string | null, s: AccessSettings = settings, now = NOW) {
  const r = await validateAssertion(token, s, staticKeys([key, other]), now);
  return r.ok ? "ok" : r.reason;
}

describe("validateAssertion", () => {
  it("accepts a genuine assertion and returns its parsed claims", async () => {
    const r = await validateAssertion(
      await sign(key, claims(NOW)),
      settings,
      staticKeys([key]),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.claims.sub).toBe(OWNER_SUB);
      expect(r.claims.exp).toBe(NOW + 600);
      expect(r.claims.iat).toBe(NOW - 10);
      expect(r.claims.country).toBe("XX"); // other claims are kept, and ignored
    }
  });

  it("accepts a token signed by the previous key during a rotation", async () => {
    expect(await reason(await sign(other, claims(NOW)))).toBe("ok");
  });

  it("accepts `aud` as a string or a list holding this application", async () => {
    expect(await reason(await sign(key, claims(NOW, { aud: AUD })))).toBe("ok");
    expect(await reason(await sign(key, claims(NOW, { aud: [OTHER_AUD, AUD] })))).toBe("ok");
  });

  it.each([
    ["absent", null],
    ["empty", ""],
  ])("refuses a missing assertion (%s)", async (_, token) => {
    expect(await reason(token)).toBe("missing_assertion");
    expect(await reason(undefined as unknown as null)).toBe("missing_assertion");
  });

  it("refuses an oversized assertion before parsing it", async () => {
    expect(await reason("a".repeat(MAX_ASSERTION_LENGTH + 1))).toBe("oversized");
  });

  it("refuses malformed tokens", async () => {
    const good = await sign(key, claims(NOW));
    const [h, p, s] = good.split(".") as [string, string, string];
    const cases = [
      `${h}.${p}`,
      `${h}.${p}.${s}.x`,
      `${h}.${p}.`,
      `${h}!.${p}.${s}`,
      `${h}.${p}=.${s}`,
      `${enc([1, 2])}.${p}.${s}`,
      `${base64UrlEncode(new TextEncoder().encode("{not json"))}.${p}.${s}`,
      `${base64UrlEncode(new Uint8Array([0xff, 0xfe]))}.${p}.${s}`,
      `${enc({ alg: "RS256" })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "" })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: 7 })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "k".repeat(129) })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "kid-current", typ: "JWE" })}.${p}.${s}`,
      `${enc({ alg: "RS256", kid: "kid-current", crit: ["exp"] })}.${p}.${s}`,
    ];
    for (const token of cases) expect(await reason(token), token.slice(0, 40)).toBe("malformed");
  });

  it.each(["none", "HS256", "RS512", "ES256", "PS256", "rs256", undefined])(
    "refuses alg %s",
    async (alg) => {
      const [, p, s] = (await sign(key, claims(NOW))).split(".");
      expect(await reason(`${enc({ alg, kid: "kid-current" })}.${p}.${s}`)).toBe("unsupported_alg");
    },
  );

  it("refuses an unknown key ID, and reports unavailable keys rather than guessing", async () => {
    const stranger = await makeKey("kid-unknown");
    expect(await reason(await sign(stranger, claims(NOW)))).toBe("unknown_kid");
    const r = await validateAssertion(await sign(key, claims(NOW)), settings, unavailableKeys, NOW);
    expect(r).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("refuses a forger's signature under a genuine kid, and another genuine key's kid", async () => {
    expect(await reason(await sign(rogue, claims(NOW)))).toBe("bad_signature");
    const [h, p, s] = (await sign(key, claims(NOW))).split(".") as [string, string, string];
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)));
    expect(await reason(`${enc({ ...header, kid: "kid-previous" })}.${p}.${s}`)).toBe(
      "bad_signature",
    );
  });

  it("refuses a payload or header edited after signing, before reading any claim", async () => {
    const [h, p, s] = (await sign(key, claims(NOW))).split(".") as [string, string, string];
    expect(await reason(`${h}.${enc(claims(NOW, { aud: [OTHER_AUD] }))}.${s}`)).toBe(
      "bad_signature",
    );
    expect(await reason(`${h}.${enc(claims(NOW, { exp: NOW + 99_999 }))}.${s}`)).toBe(
      "bad_signature",
    );
    // Not even an expired, foreign or garbage payload is reported as such without a signature.
    expect(await reason(`${h}.${enc({ exp: 1, iss: "x", type: "org" })}.${s}`)).toBe(
      "bad_signature",
    );
    expect(await reason(`${h}.${base64UrlEncode(new TextEncoder().encode("[]"))}.${s}`)).toBe(
      "bad_signature",
    );
    expect(
      await reason(`${enc({ alg: "RS256", kid: "kid-current", typ: "JWT", x: 1 })}.${p}.${s}`),
    ).toBe("bad_signature");
  });

  it("refuses a genuinely signed payload that is not a JSON object", async () => {
    const h = enc({ alg: "RS256", kid: key.kid });
    const p = base64UrlEncode(new TextEncoder().encode("[1]"));
    const sig = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key.privateKey,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(await reason(`${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`)).toBe("malformed");
  });

  it("refuses a genuinely signed token from another team", async () => {
    for (const iss of [
      "https://other.cloudflareaccess.com",
      undefined,
      `${ISSUER}/`,
      ISSUER.toUpperCase(),
    ]) {
      expect(await reason(await sign(key, claims(NOW, { iss })))).toBe("wrong_issuer");
    }
  });

  it("refuses a token for another application, or with no audience", async () => {
    for (const aud of [[OTHER_AUD], [], undefined, { a: AUD }, [AUD.toUpperCase()], `${AUD} `]) {
      expect(await reason(await sign(key, claims(NOW, { aud })))).toBe("wrong_audience");
    }
  });

  it("checks expiry with the leeway", async () => {
    const token = await sign(key, claims(NOW));
    expect(await reason(token, settings, NOW + 600 + 29)).toBe("ok");
    expect(await reason(token, settings, NOW + 600 + 30)).toBe("expired");
    expect(await reason(token, { ...settings, leewaySeconds: 0 }, NOW + 600)).toBe("expired");
    for (const exp of [undefined, "soon", Number.POSITIVE_INFINITY, null]) {
      expect(await reason(await sign(key, claims(NOW, { exp })))).toBe("malformed");
    }
  });

  it("checks nbf and iat with the leeway", async () => {
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
    for (const type of ["org", "App", undefined]) {
      expect(await reason(await sign(key, claims(NOW, { type })))).toBe("wrong_token_type");
    }
  });

  it("refuses service tokens, whose sub is empty", async () => {
    const token = await sign(key, claims(NOW, { sub: "", email: undefined, common_name: "x" }));
    expect(await reason(token)).toBe("service_token");
  });

  it("refuses claims that do not parse as the contract, after every other check", async () => {
    for (const extra of [
      { sub: undefined },
      { sub: 42 },
      { email: "not an email" },
      { exp: NOW + 600.5 },
      { iat: NOW - 10.5 },
    ]) {
      expect(await reason(await sign(key, claims(NOW, extra))), JSON.stringify(extra)).toBe(
        "malformed",
      );
    }
  });

  it("property: any single-character change to a genuine token is refused", async () => {
    const token = await sign(key, claims(NOW));
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/";
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: token.length - 1 }),
        fc.constantFrom(...alphabet.split("")),
        async (i, c) => {
          fc.pre(token[i] !== c);
          expect(await reason(token.slice(0, i) + c + token.slice(i + 1))).not.toBe("ok");
        },
      ),
      { numRuns: 300 },
    );
  });

  it("property: no token built from arbitrary parts is accepted", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.uint8Array({ maxLength: 300 }),
        async (header, payload, signature) => {
          const token = `${enc({ alg: "RS256", kid: "kid-current", ...header })}.${enc(payload)}.${base64UrlEncode(signature)}`;
          expect(await reason(token)).not.toBe("ok");
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("the AccessAssertionClaims fixtures, signed", () => {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../contracts/fixtures/AccessAssertionClaims",
  );
  const files = (d: string) => readdirSync(d).filter((f) => f.endsWith(".json"));
  const load = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const fixtureSettings = (c: Record<string, unknown>): AccessSettings => ({
    issuer: "https://example-team.cloudflareaccess.com",
    audience: (Array.isArray(c.aud) ? c.aud[0] : c.aud) as string,
  });
  const at = (c: Record<string, unknown>) => (c.exp as number) - 60;

  it.each(files(dir))("accepts %s", async (file) => {
    const c = load(join(dir, file));
    const r = await validateAssertion(
      await sign(key, c),
      fixtureSettings(c),
      staticKeys([key]),
      at(c),
    );
    expect(r.ok).toBe(true);
  });

  const expectedInvalid: Record<string, string> = {
    "empty-audience.json": "wrong_audience",
    "fractional-expiry.json": "malformed",
    "http-issuer.json": "wrong_issuer",
    "missing-sub.json": "malformed",
    "org-token.json": "wrong_token_type",
    "service-token.json": "service_token",
  };

  it("names an expected refusal for every invalid fixture", () => {
    expect(files(join(dir, "invalid")).sort()).toEqual(Object.keys(expectedInvalid).sort());
  });

  it.each(files(join(dir, "invalid")))("refuses invalid/%s", async (file) => {
    const c = load(join(dir, "invalid", file));
    const s: AccessSettings = {
      issuer: "https://example-team.cloudflareaccess.com",
      audience: "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2",
    };
    const r = await validateAssertion(await sign(key, c), s, staticKeys([key]), at(c));
    expect(r.ok ? "ok" : r.reason).toBe(expectedInvalid[file]);
  });
});

describe("base64url", () => {
  it("refuses non-canonical spellings and other alphabets", () => {
    expect(base64UrlEncode(new Uint8Array([0xff]))).toBe("_w");
    expect([...base64UrlDecode("_w")]).toEqual([0xff]);
    for (const bad of ["_x", "_w=", "a", "/w", "+w", "", "ab cd"]) {
      expect(() => base64UrlDecode(bad), bad).toThrow();
    }
  });

  it("property: decode inverts encode, and only the canonical spelling decodes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), (bytes) => {
        const text = base64UrlEncode(bytes);
        expect([...base64UrlDecode(text)]).toEqual([...bytes]);
      }),
    );
  });
});

describe("issuerFor", () => {
  it("derives the issuer and certs URL from a team domain, and refuses anything else", () => {
    expect(issuerFor("team.cloudflareaccess.com")).toBe("https://team.cloudflareaccess.com");
    expect(certsUrlFor("https://team.cloudflareaccess.com")).toBe(
      "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    );
    for (const bad of [
      "evil.com",
      "team.cloudflareaccess.com.evil.com",
      "https://team.cloudflareaccess.com",
      "Team.cloudflareaccess.com",
      "a.b.cloudflareaccess.com",
      "-team.cloudflareaccess.com",
      "",
    ]) {
      expect(issuerFor(bad), bad).toBeUndefined();
    }
  });
});

describe("importJwk", () => {
  it("imports RS256 signing keys of 2048 bits and more", async () => {
    expect(await importJwk(key.jwk)).toBeDefined();
    const { alg: _a, use: _u, ...bare } = key.jwk;
    expect(await importJwk(bare)).toBeDefined();
  });

  it("refuses keys under 2048 bits, including a 2047-bit modulus in 256 bytes", async () => {
    const small = await makeKey("small", 1024);
    expect(await importJwk(small.jwk)).toBeUndefined();
    const n = base64UrlDecode(key.jwk.n as string);
    n[0] = 0x7f; // top bit clear: 2047 bits in the same 256 bytes
    expect(await importJwk({ ...key.jwk, n: base64UrlEncode(n) })).toBeUndefined();
    const padded = new Uint8Array([0, ...base64UrlDecode(key.jwk.n as string)]);
    expect(await importJwk({ ...key.jwk, n: base64UrlEncode(padded) })).toBeDefined();
  });

  it("refuses other key types, uses, algorithms, exponents and junk", async () => {
    const cases: unknown[] = [
      null,
      "key",
      { ...key.jwk, kty: "EC" },
      { ...key.jwk, alg: "RS512" },
      { ...key.jwk, use: "enc" },
      { ...key.jwk, kid: "" },
      { ...key.jwk, kid: 5 },
      { ...key.jwk, kid: "k".repeat(129) },
      { ...key.jwk, n: "!!" },
      { ...key.jwk, n: undefined },
      { ...key.jwk, e: "AQAA" }, // even
      { ...key.jwk, e: "AQ" }, // 1
      { ...key.jwk, e: "AQAAAAAB" }, // over 32 bits
      { ...key.jwk, e: 3 },
      { ...key.jwk, n: base64UrlEncode(new Uint8Array(1100).fill(0xff)) }, // over 8192 bits
    ];
    for (const entry of cases)
      expect(await importJwk(entry), JSON.stringify(entry)).toBeUndefined();
  });
});

describe("JwksCache", () => {
  const TEST: JwksOptions = {
    ttlMs: 600_000,
    minRefetchMs: 30_000,
    maxStaleMs: 86_400_000,
    refreshDeadlineMs: 10_000,
  };

  function server(bodies: (() => Response | Promise<Response>)[]) {
    let i = 0;
    const calls: string[] = [];
    return {
      calls,
      fetcher: async (url: string) => {
        calls.push(url);
        const next = bodies[Math.min(i++, bodies.length - 1)];
        if (!next) throw new Error("no body");
        return next();
      },
    };
  }
  const never = () => new Promise<void>(() => {});
  const make = (s: ReturnType<typeof server>, clock: () => number, wait = never) =>
    new JwksCache("https://t/certs", s.fetcher, clock, wait, TEST);

  it("fetches once and serves from the cache while fresh", async () => {
    let now = 0;
    const s = server([() => jwksResponse(key)]);
    const cache = make(s, () => now);
    expect(await cache.key("kid-current")).toBeDefined();
    now = 1000;
    expect(await cache.key("kid-current")).toBeDefined();
    expect(s.calls).toEqual(["https://t/certs"]);
    expect(cache.fetches).toBe(1);
  });

  it("refetches for an unknown kid at most once per interval, and picks up a rotation", async () => {
    let now = 0;
    const s = server([() => jwksResponse(key), () => jwksResponse(key, other)]);
    const cache = make(s, () => now);
    await cache.key("kid-current");
    now = 10_000;
    expect(await cache.key("kid-previous")).toBeUndefined();
    expect(s.calls).toHaveLength(1);
    now = 40_000;
    expect(await cache.key("kid-previous")).toBeDefined();
    expect(s.calls).toHaveLength(2);
    for (let i = 0; i < 50; i++) expect(await cache.key(`random-${i}`)).toBeUndefined();
    expect(s.calls).toHaveLength(2);
  });

  it("drops a key Cloudflare withdrew, at the next good fetch", async () => {
    let now = 0;
    const s = server([() => jwksResponse(key, other), () => jwksResponse(key)]);
    const cache = make(s, () => now);
    expect(await cache.key("kid-previous")).toBeDefined();
    now = TEST.ttlMs + 1;
    expect(await cache.key("kid-previous")).toBeUndefined();
    expect(await cache.key("kid-current")).toBeDefined();
  });

  it("keeps known keys through a certs outage, up to the stale limit", async () => {
    let now = 0;
    const s = server([() => jwksResponse(key), () => new Response("down", { status: 503 })]);
    const cache = make(s, () => now);
    await cache.key("kid-current");
    now = TEST.ttlMs + 1;
    expect(await cache.key("kid-current")).toBeDefined();
    expect(await cache.key("kid-unknown")).toBeUndefined();
    now = TEST.maxStaleMs + 1;
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    expect(await cache.key("kid-unknown")).toBe(KEYS_UNAVAILABLE);
  });

  it("reports KEYS_UNAVAILABLE with no keys at all, for every kind of bad answer", async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("x", { status: 500 }),
      () => {
        throw new Error("network");
      },
      () => new Response("x".repeat(70_000)),
      () => Response.json({}),
      () => Response.json(null),
      () => Response.json({ keys: "no" }),
      () => Response.json({ keys: [{ kty: "EC" }] }),
      () => new Response("{not json"),
    ];
    for (const answer of answers) {
      const cache = make(server([answer]), () => 0);
      expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    }
  });

  it("skips junk entries and duplicate kids, and reads at most 16 keys", async () => {
    const many = await Promise.all(Array.from({ length: 17 }, (_, i) => makeKey(`k${i}`)));
    const body = () =>
      Response.json({
        keys: [null, { kty: "EC", kid: "ec" }, other.jwk, { ...key.jwk, kid: "kid-previous" }],
      });
    const cache = make(server([body]), () => 0);
    const first = await cache.key("kid-previous");
    expect(first).toBeDefined();
    expect(await cache.key("ec")).toBeUndefined();
    // The first entry for a kid wins: it verifies `other`'s signatures.
    const r = await validateAssertion(
      await sign(other, claims(NOW)),
      settings,
      { key: (kid) => cache.key(kid) },
      NOW,
    );
    expect(r.ok).toBe(true);
    const capped = make(server([() => jwksResponse(...many)]), () => 0);
    expect(await capped.key("k15")).toBeDefined();
    expect(await capped.key("k16")).toBeUndefined();
  });

  it("shares one fetch between concurrent lookups at a cold start", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = server([
      async () => {
        await gate;
        return jwksResponse(key);
      },
    ]);
    const cache = make(s, () => 0);
    const lookups = [cache.key("kid-current"), cache.key("kid-current"), cache.key("x")];
    release();
    const [a, b, c] = await Promise.all(lookups);
    expect(a).toBeDefined();
    expect(b).toBe(a);
    expect(c).toBeUndefined();
    expect(s.calls).toHaveLength(1);
  });

  it("gives up on a stranded fetch at the deadline, and fails closed meanwhile", async () => {
    let now = 0;
    const s = server([() => new Promise<Response>(() => {}), () => jwksResponse(key)]);
    // At first `wait` resolves at once: every lookup's own deadline passes immediately.
    let wait: () => Promise<void> = async () => {};
    const cache = make(
      s,
      () => now,
      () => wait(),
    );
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    now = 5_000; // the stranded fetch is still inside its deadline: wait for it, then give up
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    expect(s.calls).toHaveLength(1);
    now = TEST.refreshDeadlineMs + 1; // past its deadline, but inside minRefetchMs: no new fetch
    expect(await cache.key("kid-current")).toBe(KEYS_UNAVAILABLE);
    expect(s.calls).toHaveLength(1);
    now = TEST.minRefetchMs + 1; // a new fetch replaces the stranded one
    wait = never;
    expect(await cache.key("kid-current")).toBeDefined();
    expect(s.calls).toHaveLength(2);
  });

  it("never lets a fetch that finished after a newer one bring back the older key set", async () => {
    let now = 0;
    let finishA: (r: Response) => void = () => {};
    const a = new Promise<Response>((resolve) => {
      finishA = resolve;
    });
    let wait: () => Promise<void> = async () => {};
    const s = server([() => a, () => jwksResponse(key)]);
    const cache = make(
      s,
      () => now,
      () => wait(),
    );
    expect(await cache.key("kid-previous")).toBe(KEYS_UNAVAILABLE); // A outlives its deadline
    now = TEST.minRefetchMs + 1;
    wait = never;
    expect(await cache.key("kid-current")).toBeDefined(); // B installs the new set
    finishA(jwksResponse(other)); // A, the old set with the withdrawn key, lands late
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cache.key("kid-previous")).toBeUndefined();
    expect(await cache.key("kid-current")).toBeDefined();
    expect(s.calls).toHaveLength(2);
  });

  it("validates end to end through the cache", async () => {
    const cache = make(server([() => jwksResponse(key)]), () => 0);
    const r = await validateAssertion(await sign(key, claims(NOW)), settings, cache, NOW);
    expect(r.ok).toBe(true);
  });
});
