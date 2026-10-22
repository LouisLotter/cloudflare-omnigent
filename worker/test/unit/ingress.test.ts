import { ErrorBody } from "@cfo/contracts";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KeySource } from "../../src/ingress/access.ts";
import {
  type Admitted,
  createIngress,
  type IngressConfig,
  type IngressDeps,
  type IngressEnv,
  type IngressFailure,
  ingressFromEnv,
  parseIngressEnv,
  REFUSALS,
  refusal,
  withIngress,
} from "../../src/ingress/index.ts";
import { RateLimiter } from "../../src/ingress/limits.ts";
import { makeOwnerPin, parseOwnerPin } from "../../src/ingress/owner.ts";
import {
  AUD,
  claims,
  HOST,
  ISSUER,
  jwksResponse,
  makeKey,
  OWNER_EMAIL,
  OWNER_SUB,
  SALT,
  sign,
  staticKeys,
  TEAM,
  type TestKey,
} from "../support/access-keys.ts";
import { deriveCases, leakedIdentity } from "../support/ingress-derived.ts";
import { FOUR_PATHS, s5Cases } from "../support/ingress-s5-cases.ts";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;
const ORIGIN = `https://${HOST}`;

let key: TestKey;
let rogue: TestKey;
let stranger: TestKey;
let pin: string;
let config: IngressConfig;
let genuine: string;

beforeAll(async () => {
  [key, rogue, stranger] = await Promise.all([
    makeKey("kid-current"),
    makeKey("kid-current"),
    makeKey("kid-stranger"),
  ]);
  pin = await makeOwnerPin(OWNER_EMAIL, SALT);
  const parsed = parseIngressEnv({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: pin,
  });
  if (!parsed) throw new Error("test configuration did not parse");
  config = parsed;
  genuine = await sign(key, claims(NOW));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Harness {
  readonly admit: (request: Request) => ReturnType<ReturnType<typeof createIngress>["admit"]>;
  readonly logs: Record<string, string>[];
  readonly keyLookups: () => number;
}

function harness(
  overrides: Partial<IngressDeps> = {},
  cfg: IngressConfig | "unconfigured" = config,
): Harness {
  const logs: Record<string, string>[] = [];
  let lookups = 0;
  const keys = staticKeys([key]);
  const counted: KeySource = {
    key: (kid) => {
      lookups++;
      return keys.key(kid);
    },
  };
  const ingress = createIngress(cfg === "unconfigured" ? undefined : cfg, {
    keys: counted,
    limiter: new RateLimiter(() => NOW_MS),
    nowMs: () => NOW_MS,
    log: (line) => logs.push({ ...line }),
    ...overrides,
  });
  return { admit: (r) => ingress.admit(r), logs, keyLookups: () => lookups };
}

const request = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`${ORIGIN}${path}`, init);

async function admitted(h: Harness, r: Request): Promise<Admitted> {
  const result = await h.admit(r);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
}

async function expectRefusal(response: Response, reason: IngressFailure) {
  const { status, code, retryable } = REFUSALS[reason];
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  const text = await response.text();
  const body = ErrorBody.parse(JSON.parse(text));
  expect(body.error.code).toBe(code);
  expect(body.error.retryable).toBe(retryable);
  expect(text).not.toContain(reason);
}

describe("parseIngressEnv", () => {
  const env: IngressEnv = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: "",
  };

  it("reads a complete configuration, with the team's own certs endpoint", () => {
    const parsed = parseIngressEnv({ ...env, OWNER_EMAIL_HASH: pin });
    expect(parsed?.settings).toEqual({ issuer: ISSUER, audience: AUD });
    expect(parsed?.hostnames).toEqual([HOST]);
    expect(parsed?.certsUrl).toBe(`${ISSUER}/cdn-cgi/access/certs`);
  });

  it("fails closed on any missing or malformed part, the owner pin included", () => {
    const good = { ...env, OWNER_EMAIL_HASH: pin };
    for (const bad of [
      { ...good, ACCESS_TEAM_DOMAIN: undefined },
      { ...good, ACCESS_TEAM_DOMAIN: "evil.example" },
      { ...good, ACCESS_AUD: undefined },
      { ...good, ACCESS_AUD: "" },
      { ...good, ACCESS_AUD: "has space" },
      { ...good, ALLOWED_HOSTNAMES: undefined },
      { ...good, ALLOWED_HOSTNAMES: "https://x.example" },
      { ...good, OWNER_EMAIL_HASH: undefined },
      { ...good, OWNER_EMAIL_HASH: "" },
      { ...good, OWNER_EMAIL_HASH: OWNER_EMAIL },
    ]) {
      expect(parseIngressEnv(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("uses a local certs origin only on 127.0.0.1 or localhost over http", () => {
    const good = { ...env, OWNER_EMAIL_HASH: pin };
    for (const local of ["http://127.0.0.1:9000", "http://localhost:9000"]) {
      expect(parseIngressEnv({ ...good, ACCESS_CERTS_URL_LOCAL_ONLY: local })?.certsUrl).toBe(
        `${local}/cdn-cgi/access/certs`,
      );
    }
    for (const ignored of [
      "https://127.0.0.1:9000",
      "http://127.0.0.1",
      "http://evil.example:9000",
      "http://127.0.0.1:9000/x",
      "http://127.0.0.1.evil.example:9000",
    ]) {
      expect(parseIngressEnv({ ...good, ACCESS_CERTS_URL_LOCAL_ONLY: ignored })?.certsUrl).toBe(
        `${ISSUER}/cdn-cgi/access/certs`,
      );
    }
  });
});

describe("refusal", () => {
  it.each(Object.keys(REFUSALS) as IngressFailure[])("answers %s without naming it", async (r) => {
    await expectRefusal(refusal(r), r);
  });

  it("sets Retry-After when asked", () => {
    expect(refusal("rate_limited", 7).headers.get("retry-after")).toBe("7");
  });
});

describe("createIngress", () => {
  it("fails closed with 503 for every request when unconfigured, before anything else", async () => {
    const h = harness({}, "unconfigured");
    const result = await h.admit(request("/", { headers: { "cf-access-jwt-assertion": genuine } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_configured");
      await expectRefusal(result.response, "not_configured");
    }
    expect(h.keyLookups()).toBe(0);
    expect(h.logs).toEqual([
      { event: "ingress_refused", reason: "not_configured", method: "GET", path: "/" },
    ]);
  });

  it("admits the owner's genuine assertion on each path and hands on a stripped request", async () => {
    const h = harness();
    for (const { method, path } of FOUR_PATHS) {
      const body = method === "POST" ? JSON.stringify({ username: "x" }) : undefined;
      const a = await admitted(
        h,
        request(path, {
          method,
          headers: {
            "cf-access-jwt-assertion": genuine,
            "cf-access-authenticated-user-email": OWNER_EMAIL,
            cookie: `CF_Authorization=${genuine}; omnigent_session=s1`,
            authorization: "Bearer omnigent-token",
            ...(body ? { "content-type": "application/json", origin: ORIGIN } : {}),
          },
          ...(body ? { body } : {}),
        }),
      );
      expect(a.identity).toEqual({
        sub: OWNER_SUB,
        sessionId: expect.stringMatching(/^[0-9a-f]{64}$/),
        issuedAt: NOW - 10,
        expiresAt: NOW + 600,
      });
      expect(a.origin).toBe(ORIGIN);
      expect(a.request.method).toBe(method);
      expect(a.request.url).toBe(`${ORIGIN}${path}`);
      expect(leakedIdentity(a.request)).toBeUndefined();
      expect(a.request.headers.get("cookie")).toBe("omnigent_session=s1");
      expect(a.request.headers.get("authorization")).toBe("Bearer omnigent-token");
      if (body) expect(await a.request.text()).toBe(body);
    }
    expect(h.logs).toEqual([]);
    // No email reaches the next handler at all.
    expect(
      JSON.stringify(
        await admitted(h, request("/", { headers: { "cf-access-jwt-assertion": genuine } })),
      ),
    ).not.toContain(OWNER_EMAIL);
  });

  it("keeps a WebSocket upgrade an upgrade", async () => {
    const a = await admitted(
      harness(),
      request("/v1/ws", {
        headers: { "cf-access-jwt-assertion": genuine, upgrade: "websocket", origin: ORIGIN },
      }),
    );
    expect(a.request.headers.get("upgrade")).toBe("websocket");
    expect(a.request.headers.get("origin")).toBe(ORIGIN);
  });

  it("derives one session ID per Access session", async () => {
    const h = harness();
    const id = async (token: string) =>
      (await admitted(h, request("/", { headers: { "cf-access-jwt-assertion": token } }))).identity
        .sessionId;
    const first = await id(genuine);
    expect(await id(genuine)).toBe(first);
    // Two sign-ins in the same second differ by Access's identity nonce.
    expect(await id(await sign(key, claims(NOW, { identity_nonce: "other" })))).not.toBe(first);
    expect(await id(await sign(key, claims(NOW, { country: "YY" })))).toBe(first);
    expect(await id(await sign(key, claims(NOW, { iat: NOW - 20 })))).not.toBe(first);
    const noIat = await id(await sign(key, claims(NOW, { iat: undefined })));
    expect(noIat).not.toBe(first);
    expect(await id(await sign(key, claims(NOW, { iat: undefined })))).toBe(noIat);
  });

  describe("S5's 16 negative cases, and service tokens, on four paths", () => {
    it("refuses each, never reaches the next step, and logs no secret", async () => {
      const cases = await s5Cases({ key, rogue, stranger }, NOW);
      expect(cases).toHaveLength(17);
      for (const { method, path } of FOUR_PATHS) {
        for (const c of cases) {
          const h = harness();
          const next = vi.fn();
          const result = await h.admit(
            request(path, {
              method,
              headers: { ...c.headers },
              ...(method === "POST" ? { body: "{}" } : {}),
            }),
          );
          if (result.ok) next(result);
          expect(next, `${c.name} on ${path}`).not.toHaveBeenCalled();
          expect(result.ok ? "ok" : result.reason, `${c.name} on ${path}`).toBe(c.expected);
          if (!result.ok) await expectRefusal(result.response, c.expected);
          const logged = JSON.stringify(h.logs);
          expect(h.logs).toHaveLength(1);
          expect(logged).not.toContain("canary");
          expect(logged).not.toContain("?");
          expect(logged).not.toContain("example.invalid");
          for (const value of Object.values(c.headers)) {
            if (value.length > 20) expect(logged).not.toContain(value.slice(-20));
          }
        }
      }
    });
  });

  it("refuses an unknown hostname before any key lookup", async () => {
    const h = harness();
    for (const url of [
      "https://attacker.example/",
      `https://${HOST}.evil.example/`,
      `https://x.${HOST}/`,
      "https://cfo-stg.workers.dev/",
      `http://${HOST}/`,
      `https://${HOST}:8443/`,
    ]) {
      const result = await h.admit(
        new Request(url, { headers: { "cf-access-jwt-assertion": genuine } }),
      );
      expect(result.ok ? "ok" : result.reason).toBe("unknown_host");
    }
    expect(h.keyLookups()).toBe(0);
  });

  it("rate-limits per client before any key lookup", async () => {
    const h = harness({
      limiter: new RateLimiter(() => NOW_MS, { burst: 2, perSecond: 0.5, maxClients: 8 }),
    });
    const from = (ip: string) =>
      request("/", { headers: { "cf-access-jwt-assertion": genuine, "cf-connecting-ip": ip } });
    expect((await h.admit(from("192.0.2.1"))).ok).toBe(true);
    expect((await h.admit(from("192.0.2.1"))).ok).toBe(true);
    const limited = await h.admit(from("192.0.2.1"));
    expect(limited.ok).toBe(false);
    if (!limited.ok) {
      expect(limited.reason).toBe("rate_limited");
      expect(limited.response.headers.get("retry-after")).toBe("2");
      await expectRefusal(limited.response, "rate_limited");
    }
    expect(h.keyLookups()).toBe(2);
    expect((await h.admit(from("192.0.2.2"))).ok).toBe(true);
  });

  it("answers a retryable 503 while the team's keys cannot be loaded", async () => {
    const h = harness({
      keys: { key: async () => (await import("../../src/ingress/access.ts")).KEYS_UNAVAILABLE },
    });
    const result = await h.admit(request("/", { headers: { "cf-access-jwt-assertion": genuine } }));
    expect(result.ok ? "ok" : result.reason).toBe("keys_unavailable");
    if (!result.ok) await expectRefusal(result.response, "keys_unavailable");
  });

  it("refuses another identity even though Access admitted it, and a token without email", async () => {
    const h = harness();
    for (const extra of [
      { email: "someone-else@example.invalid" },
      { email: undefined },
      { email: "owner@example.invalid.attacker.example" },
    ]) {
      const result = await h.admit(
        request("/", {
          headers: { "cf-access-jwt-assertion": await sign(key, claims(NOW, extra)) },
        }),
      );
      expect(result.ok ? "ok" : result.reason).toBe("not_owner");
    }
    // A pin for someone else refuses the owner too.
    const otherPin = parseOwnerPin(await makeOwnerPin("someone-else@example.invalid", SALT));
    if (!otherPin) throw new Error("pin");
    const result = await harness({}, { ...config, owner: otherPin }).admit(
      request("/", { headers: { "cf-access-jwt-assertion": genuine } }),
    );
    expect(result.ok ? "ok" : result.reason).toBe("not_owner");
  });

  it("refuses a cross-origin unsafe request or upgrade only after admission", async () => {
    const h = harness();
    const cross = await h.admit(
      request("/v1/sessions", {
        method: "POST",
        body: "{}",
        headers: { "cf-access-jwt-assertion": genuine, origin: "null" },
      }),
    );
    expect(cross.ok ? "ok" : cross.reason).toBe("bad_origin");
    const anonymous = await h.admit(
      request("/v1/sessions", { method: "POST", body: "{}", headers: { origin: "null" } }),
    );
    expect(anonymous.ok ? "ok" : anonymous.reason).toBe("missing_assertion");
  });

  it("passes every case derived from one genuine assertion (S5's 18 and WP2.1's)", async () => {
    const other = await makeKey("kid-other");
    const cases = await deriveCases({
      request: request("/", {
        headers: {
          "cf-access-jwt-assertion": genuine,
          "cf-access-authenticated-user-email": OWNER_EMAIL,
          cookie: `CF_Authorization=${genuine}`,
          "cf-connecting-ip": "192.0.2.9",
        },
      }),
      config,
      keys: staticKeys([key, other]),
      nowMs: NOW_MS,
      otherKid: other.kid,
    });
    expect(cases.filter((c) => !c.pass)).toEqual([]);
    expect(cases.filter((c) => c.group === "s5")).toHaveLength(18);
    expect(cases.filter((c) => c.group === "wp2.1").length).toBeGreaterThanOrEqual(10);
    for (const c of cases) expect(c.reachedNext).toBe(c.expected === "ok");
  });

  it("deriveCases needs a genuine assertion, and reports a leak as a failure", async () => {
    await expect(
      deriveCases({ request: request("/"), config, keys: staticKeys([key]), nowMs: NOW_MS }),
    ).rejects.toThrow("assertion");
    expect(leakedIdentity(request("/", { headers: { cookie: "a=1, CF_Authorization=x" } }))).toBe(
      "cookie CF_Authorization",
    );
    expect(leakedIdentity(request("/", { headers: { "remote-user": "x" } }))).toBe("remote-user");
  });

  it("property: a request reaches the next step only with the owner's valid assertion, stripped", async () => {
    const otherOwner = await sign(key, claims(NOW, { email: "someone-else@example.invalid" }));
    const forged = await sign(rogue, claims(NOW));
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(HOST, "attacker.example", `x.${HOST}`),
        fc.constantFrom("GET", "POST", "DELETE"),
        fc.constantFrom(undefined, ORIGIN, "null", "https://attacker.example"),
        fc.constantFrom(undefined, genuine, otherOwner, forged, "", "x.y.z"),
        fc.boolean(),
        fc.subarray(["x-forwarded-email", "remote-user", "cf-access-client-id", "cookie"]),
        async (host, method, origin, token, inCookie, spoofed) => {
          const headers: Record<string, string> = {};
          if (origin !== undefined) headers.origin = origin;
          if (token !== undefined) {
            if (inCookie) headers.cookie = `CF_Authorization=${token}`;
            else headers["cf-access-jwt-assertion"] = token;
          }
          for (const name of spoofed) {
            headers[name] =
              name === "cookie" ? `${headers.cookie ?? "a=1"}; CF_Authorization=spoof` : "spoof";
          }
          const result = await harness().admit(
            new Request(`https://${host}/x`, {
              method,
              headers,
              ...(method === "GET" ? {} : { body: "b" }),
            }),
          );
          const shouldPass =
            host === HOST &&
            token === genuine &&
            !inCookie &&
            (method === "GET" || origin === undefined || origin === ORIGIN);
          expect(result.ok).toBe(shouldPass);
          if (result.ok) expect(leakedIdentity(result.request)).toBeUndefined();
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("withIngress and ingressFromEnv", () => {
  const env = (): IngressEnv & { OTHER?: string } => ({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: pin,
  });

  it("runs the next handler only for an admitted request, with the team's keys fetched once", async () => {
    const fetches: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetches.push(url);
      return jwksResponse(key);
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    try {
      const next = vi.fn(async (a: Admitted) => new Response(`hello ${a.identity.sub}`));
      const handler = withIngress(next);
      const ctx = {} as ExecutionContext;
      const ok = await handler(
        request("/", { headers: { "cf-access-jwt-assertion": genuine } }),
        env(),
        ctx,
      );
      expect(await ok.text()).toBe(`hello ${OWNER_SUB}`);
      const refused = await handler(request("/"), env(), ctx);
      expect(refused.status).toBe(403);
      const forged = await handler(
        request("/", { headers: { "cf-access-jwt-assertion": await sign(rogue, claims(NOW)) } }),
        env(),
        ctx,
      );
      expect(forged.status).toBe(403);
      expect(next).toHaveBeenCalledTimes(1);
      expect(fetches).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
      // The same configuration keeps the same instance; a new one gets a new instance.
      expect(ingressFromEnv(env())).toBe(ingressFromEnv(env()));
      expect(ingressFromEnv({ ...env(), ACCESS_AUD: "c".repeat(64) })).not.toBe(
        ingressFromEnv(env()),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers 503 without calling the next handler when unconfigured", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("no fetch expected");
    });
    const next = vi.fn();
    const response = await withIngress(next)(
      request("/", { headers: { "cf-access-jwt-assertion": genuine } }),
      { ...env(), OWNER_EMAIL_HASH: undefined },
      {} as ExecutionContext,
    );
    expect(response.status).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });
});
