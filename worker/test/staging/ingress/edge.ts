// WP2.1 staging, without a session: what the deployed hostname shows to strangers, the team's
// real keys judged by the product's key cache and validator, and the Access application's
// cookie settings read back.
//
//   node worker/test/staging/ingress/edge.ts [out.json]
//
// 1. Anonymous and forged requests to the hostname. Access answers them itself, so the Worker
//    never runs: its answers carry `x-cfo-ingress-harness`, Access's do not. Forged assertions
//    use the team's real issuer, the application's real AUD tag and a real key ID, signed with a
//    key generated here.
// 2. The team's real signing keys, loaded by ingress's JwksCache: every key loads, a forged token
//    naming a real key ID is `bad_signature`, and an unknown key ID is `unknown_kid`.
// 3. The Access application as configured: SameSite=lax (D9), preflight bypass off, owner-only.
// Writes the result with the hostname, team domain and AUD tag redacted.

import { writeFileSync } from "node:fs";
import { JwksCache, validateAssertion } from "../../../src/ingress/access.ts";
import { makeKey, sign } from "../../support/access-keys.ts";
import { accessApp, generated, redact, stagingConfig } from "./config.ts";

const MARK = "x-cfo-ingress-harness";

async function main(): Promise<void> {
  const out = process.argv[2];
  const g = generated();
  const config = stagingConfig();
  const base = `https://${g.hostname}`;
  const issuer = `https://${g.team}`;
  const now = Math.floor(Date.now() / 1000);

  const certs = (await (await fetch(`${issuer}/cdn-cgi/access/certs`)).json()) as {
    keys: { kid: string; kty: string; alg?: string; use?: string; n?: string }[];
  };
  const realKid = certs.keys[0]?.kid ?? "none";
  const forged = await sign(await makeKey(realKid), {
    aud: [g.aud],
    email: "owner@example.invalid",
    exp: now + 600,
    iat: now - 5,
    nbf: now - 5,
    iss: issuer,
    type: "app",
    sub: "00000000-0000-4000-8000-0000000000cc",
  });

  const probes: [string, string, string, Record<string, string>, string?][] = [
    ["anonymous GET /", "GET", "/", {}],
    ["anonymous GET /__ingress/selftest", "GET", "/__ingress/selftest", {}],
    ["anonymous GET, encoded path", "GET", "/%5F%5Fingress/selftest", {}],
    ["anonymous HEAD /", "HEAD", "/", {}],
    ["anonymous POST /__ingress/echo", "POST", "/__ingress/echo", { origin: base }, "echo"],
    [
      "anonymous POST /auth/setup",
      "POST",
      "/auth/setup",
      { "content-type": "application/json" },
      JSON.stringify({ username: "intruder", password: "intruder-password" }),
    ],
    [
      "CORS preflight from another origin",
      "OPTIONS",
      "/__ingress/echo",
      { origin: "https://attacker.example", "access-control-request-method": "POST" },
    ],
    [
      "forged Cf-Access-Jwt-Assertion",
      "GET",
      "/__ingress/selftest",
      { "cf-access-jwt-assertion": forged },
    ],
    [
      "forged CF_Authorization cookie",
      "GET",
      "/__ingress/selftest",
      { cookie: `CF_Authorization=${forged}` },
    ],
    [
      "forged header and cookie together",
      "GET",
      "/",
      { "cf-access-jwt-assertion": forged, cookie: `CF_Authorization=${forged}` },
    ],
    ["garbage CF_Authorization cookie", "GET", "/", { cookie: "CF_Authorization=not-a-token" }],
    [
      "made-up service token credentials",
      "GET",
      "/",
      { "cf-access-client-id": "made-up.access", "cf-access-client-secret": "made-up" },
    ],
    [
      "spoofed identity headers",
      "GET",
      "/__ingress/selftest",
      {
        "cf-access-authenticated-user-email": "owner@example.invalid",
        "x-forwarded-email": "owner@example.invalid",
      },
    ],
  ];

  const results = [];
  for (const [name, method, path, headers, body] of probes) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
    });
    await r.body?.cancel();
    const location = r.headers.get("location");
    results.push({
      probe: name,
      status: r.status,
      location:
        location === null
          ? "none"
          : location.startsWith(`${issuer}/cdn-cgi/access/login`)
            ? "team login page"
            : location.startsWith(`${base}/cdn-cgi/access/login`)
              ? "app login path"
              : redact(location.split("?")[0] ?? "", g),
      workerRan: r.headers.get(MARK) === "1",
    });
  }

  const cache = new JwksCache(
    `${issuer}/cdn-cgi/access/certs`,
    (u) => fetch(u),
    () => Date.now(),
    (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  );
  const loaded = await Promise.all(
    certs.keys.map(async (k) => (await cache.key(k.kid)) !== undefined),
  );
  const settings = { issuer, audience: g.aud };
  const forgedVerdict = await validateAssertion(forged, settings, cache, now);
  const stranger = await sign(await makeKey("not-a-team-kid"), { iss: issuer, aud: [g.aud] });
  const strangerVerdict = await validateAssertion(stranger, settings, cache, now);
  const bits = (n: string | undefined) =>
    n === undefined ? 0 : Buffer.from(n, "base64url").length * 8;
  const teamKeys = {
    count: certs.keys.length,
    shapes: certs.keys.map((k) => `${k.kty}/${k.alg ?? "-"}/${k.use ?? "-"}/${bits(k.n)}`),
    allLoadedByJwksCache: loaded.every(Boolean),
    forgedTokenWithRealKid: forgedVerdict.ok ? "ok" : forgedVerdict.reason,
    tokenWithUnknownKid: strangerVerdict.ok ? "ok" : strangerVerdict.reason,
    certsFetches: cache.fetches,
  };

  const app = accessApp(config, g.hostname);
  const policies = (app.policies as { decision?: string; include?: object[] }[] | undefined) ?? [];
  const access = {
    same_site_cookie_attribute: app.same_site_cookie_attribute ?? "<not set>",
    http_only_cookie_attribute: app.http_only_cookie_attribute ?? "<not set>",
    options_preflight_bypass: app.options_preflight_bypass ?? "<not set>",
    enable_binding_cookie: app.enable_binding_cookie ?? "<not set>",
    session_duration: app.session_duration ?? "<not set>",
    policies: policies.map((p) => ({
      decision: p.decision,
      includeKinds: [...new Set((p.include ?? []).flatMap((i) => Object.keys(i)))].sort(),
    })),
  };

  const pass =
    results.every(
      (r) => !r.workerRan && (r.status === 302 || r.status === 401 || r.status === 403),
    ) &&
    teamKeys.allLoadedByJwksCache &&
    teamKeys.forgedTokenWithRealKid === "bad_signature" &&
    teamKeys.tokenWithUnknownKid === "unknown_kid" &&
    access.same_site_cookie_attribute === "lax" &&
    access.options_preflight_bypass !== true &&
    policies.length === 1 &&
    access.policies[0]?.decision === "allow" &&
    access.policies[0]?.includeKinds.join() === "email";
  const report = { at: new Date().toISOString(), pass, probes: results, teamKeys, access };
  const text = redact(JSON.stringify(report, null, 2), g);
  if (out) writeFileSync(out, `${text}\n`);
  console.log(text);
  console.log(pass ? "PASS" : "FAIL");
  if (!pass) process.exitCode = 1;
}

await main();
