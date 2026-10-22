// Ingress inside workerd: its WebCrypto (RS256 verify, JWK import, HMAC), its Request and Headers,
// and the composed step, with keys generated in the runtime itself.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JwksCache } from "../../src/ingress/access.ts";
import {
  type Admitted,
  createIngress,
  type IngressConfig,
  type IngressEnv,
  parseIngressEnv,
  withIngress,
} from "../../src/ingress/index.ts";
import { RateLimiter } from "../../src/ingress/limits.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
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
  TEAM,
  type TestKey,
} from "../support/access-keys.ts";
import { deriveCases, leakedIdentity } from "../support/ingress-derived.ts";
import { FOUR_PATHS, s5Cases } from "../support/ingress-s5-cases.ts";

const ORIGIN = `https://${HOST}`;
let key: TestKey;
let rogue: TestKey;
let stranger: TestKey;
let other: TestKey;
let env: IngressEnv;
let config: IngressConfig;

beforeAll(async () => {
  [key, rogue, stranger, other] = await Promise.all([
    makeKey("kid-current"),
    makeKey("kid-current"),
    makeKey("kid-stranger"),
    makeKey("kid-previous"),
  ]);
  env = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
  };
  const parsed = parseIngressEnv(env);
  if (!parsed) throw new Error("configuration did not parse");
  config = parsed;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ingress as deployed, but with the certs endpoint served from memory. */
function ingress() {
  let fetches = 0;
  const keys = new JwksCache(
    config.certsUrl,
    async (url) => {
      fetches++;
      expect(url).toBe(`${ISSUER}/cdn-cgi/access/certs`);
      return jwksResponse(key, other);
    },
    () => Date.now(),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  const logs: string[] = [];
  const step = createIngress(config, {
    keys,
    limiter: new RateLimiter(() => Date.now()),
    nowMs: () => Date.now(),
    log: (line) => logs.push(JSON.stringify(line)),
  });
  return { step, keys, logs, fetches: () => fetches };
}

const now = () => Math.floor(Date.now() / 1000);

describe("ingress in workerd", () => {
  it("admits the owner, keeps the body and the upgrade, and strips identity", async () => {
    const { step, fetches } = ingress();
    const token = await sign(key, claims(now()));
    const post = await step.admit(
      new Request(`${ORIGIN}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "owner" }),
        headers: {
          "cf-access-jwt-assertion": token,
          "cf-access-authenticated-user-email": OWNER_EMAIL,
          "x-forwarded-email": "spoof@example.invalid",
          cookie: `CF_Authorization=${token}; omnigent_session=s1`,
          origin: ORIGIN,
          "content-type": "application/json",
        },
      }),
    );
    expect(post.ok).toBe(true);
    if (post.ok) {
      expect(post.identity.sub).toBe(OWNER_SUB);
      expect(leakedIdentity(post.request)).toBeUndefined();
      expect(post.request.headers.get("cookie")).toBe("omnigent_session=s1");
      expect(await post.request.json()).toEqual({ username: "owner" });
    }
    const upgrade = await step.admit(
      new Request(`${ORIGIN}/v1/ws`, {
        headers: { "cf-access-jwt-assertion": token, upgrade: "websocket", origin: ORIGIN },
      }),
    );
    expect(upgrade.ok && upgrade.request.headers.get("upgrade")).toBe("websocket");
    // A token from the previous key works too, as during a rotation; one certs fetch in all.
    expect(
      (
        await step.admit(
          new Request(`${ORIGIN}/`, {
            headers: { "cf-access-jwt-assertion": await sign(other, claims(now())) },
          }),
        )
      ).ok,
    ).toBe(true);
    expect(fetches()).toBe(1);
  });

  it("refuses S5's 16 cases and service tokens on four paths, never reaching the next step", async () => {
    const { step, logs } = ingress();
    const cases = await s5Cases({ key, rogue, stranger }, now());
    let refused = 0;
    for (const { method, path } of FOUR_PATHS) {
      for (const c of cases) {
        const result = await step.admit(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { ...c.headers, "cf-connecting-ip": `192.0.2.${refused % 250}` },
            ...(method === "POST" ? { body: "{}" } : {}),
          }),
        );
        expect(result.ok ? "ok" : result.reason, `${c.name} on ${path}`).toBe(c.expected);
        if (!result.ok) {
          refused++;
          expect(result.response.status).toBeGreaterThanOrEqual(400);
        }
      }
    }
    expect(refused).toBe(cases.length * FOUR_PATHS.length);
    expect(logs).toHaveLength(refused);
    for (const line of logs) {
      expect(line).not.toContain("canary");
      expect(line).not.toContain("example.invalid");
    }
  });

  it("passes every case derived from one genuine assertion", async () => {
    const { keys } = ingress();
    const token = await sign(key, claims(now()));
    const cases = await deriveCases({
      request: new Request(`${ORIGIN}/`, {
        headers: {
          "cf-access-jwt-assertion": token,
          "cf-access-authenticated-user-email": OWNER_EMAIL,
          cookie: `CF_Authorization=${token}`,
        },
      }),
      config,
      keys,
      nowMs: Date.now(),
      otherKid: other.kid,
    });
    expect(cases.filter((c) => !c.pass)).toEqual([]);
    expect(cases.filter((c) => c.group === "s5")).toHaveLength(18);
  });

  it("withIngress runs the next handler only for the owner, with the real fetch path", async () => {
    const certs: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      certs.push(String(input));
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jwksResponse(key);
    });
    const seen: Admitted[] = [];
    const handler = withIngress(async (admitted) => {
      seen.push(admitted);
      return new Response("forwarded");
    });
    const ctx = {} as ExecutionContext;
    const ok = await handler(
      new Request(`${ORIGIN}/`, {
        headers: { "cf-access-jwt-assertion": await sign(key, claims(now())) },
      }),
      env,
      ctx,
    );
    expect(await ok.text()).toBe("forwarded");
    for (const headers of [
      {},
      { "cf-access-jwt-assertion": await sign(rogue, claims(now())) },
      {
        "cf-access-jwt-assertion": await sign(
          key,
          claims(now(), { email: "someone-else@example.invalid" }),
        ),
      },
    ]) {
      const refused = await handler(new Request(`${ORIGIN}/`, { headers }), env, ctx);
      expect(refused.status).toBe(403);
    }
    const foreign = await handler(new Request("https://attacker.example/"), env, ctx);
    expect(foreign.status).toBe(404);
    const unconfigured = await handler(
      new Request(`${ORIGIN}/`),
      { ...env, ACCESS_AUD: undefined },
      ctx,
    );
    expect(unconfigured.status).toBe(503);
    expect(seen).toHaveLength(1);
    expect(certs).toEqual([`${ISSUER}/cdn-cgi/access/certs`]);
  });
});
