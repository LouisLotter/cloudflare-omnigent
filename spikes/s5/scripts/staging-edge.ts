// Spike S5: what staging shows without an owner session.
//
//   node spikes/s5/scripts/staging-edge.ts
//
// 1. Anonymous and forged requests to the deployed hostname. Access answers them itself: the
//    Worker never runs (its responses carry `x-s5-worker`; Access's do not), so it cannot wake the
//    container either. Forged assertions use the real team issuer, the real AUD tag and a real
//    key ID, signed with a key generated here.
// 2. The team's real signing keys, fetched from its public certs endpoint and loaded by the
//    spike's own JwksCache: the validator accepts their format, and refuses a forged token that
//    names a real key ID.
// Writes results/staging-edge.json with the hostname, team domain and AUD redacted.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JwksCache, validateAccessJwt } from "../src/access.ts";
import { makeKey, sign } from "../test/keys.ts";

const SPIKE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const staging = JSON.parse(readFileSync(join(SPIKE, "generated", "staging.json"), "utf8")) as {
  hostname: string;
  team: string;
  aud: string;
};
const base = `https://${staging.hostname}`;
const issuer = `https://${staging.team}`;

function redact(text: string): string {
  return text
    .replaceAll(staging.hostname, "<host>")
    .replaceAll(staging.team, "<team>")
    .replaceAll(staging.aud, "<aud>");
}

function locationKind(location: string | null): string {
  if (location === null) return "none";
  if (location.startsWith(`${issuer}/cdn-cgi/access/login`)) return "team login page";
  if (location.startsWith(`${base}/cdn-cgi/access/login`)) return "app login path";
  return redact(location.split("?")[0] ?? "");
}

async function main(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const certs = (await (await fetch(`${issuer}/cdn-cgi/access/certs`)).json()) as {
    keys: { kid: string; kty: string; alg: string; use?: string }[];
    public_cert?: { kid: string };
    public_certs?: { kid: string }[];
  };
  const realKid = certs.public_cert?.kid ?? certs.keys[0]?.kid ?? "none";
  const forger = await makeKey(realKid);
  const forged = await sign(forger, {
    aud: [staging.aud],
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
    ["anonymous GET /__s5/whoami", "GET", "/__s5/whoami", {}],
    ["anonymous GET /%5F%5Fs5/whoami", "GET", "/%5F%5Fs5/whoami", {}],
    ["anonymous GET /platform/login", "GET", "/platform/login", {}],
    ["anonymous GET /v1/scheduled-tasks", "GET", "/v1/scheduled-tasks", {}],
    ["anonymous HEAD /", "HEAD", "/", {}],
    [
      "anonymous POST /auth/setup",
      "POST",
      "/auth/setup",
      { "content-type": "application/json" },
      JSON.stringify({ username: "intruder", password: "intruder-password" }),
    ],
    [
      "anonymous POST /platform/login/repair",
      "POST",
      "/platform/login/repair",
      { "content-type": "application/x-www-form-urlencoded", origin: base },
      "form_token=x&password=y",
    ],
    [
      "CORS preflight OPTIONS /v1/scheduled-tasks",
      "OPTIONS",
      "/v1/scheduled-tasks",
      { origin: "https://attacker.example", "access-control-request-method": "GET" },
    ],
    [
      "forged Cf-Access-Jwt-Assertion header",
      "GET",
      "/__s5/whoami",
      { "cf-access-jwt-assertion": forged },
    ],
    [
      "forged CF_Authorization cookie",
      "GET",
      "/__s5/whoami",
      { cookie: `CF_Authorization=${forged}` },
    ],
    [
      "forged header and cookie together",
      "GET",
      "/v1/scheduled-tasks",
      { "cf-access-jwt-assertion": forged, cookie: `CF_Authorization=${forged}` },
    ],
    ["garbage CF_Authorization cookie", "GET", "/", { cookie: "CF_Authorization=not-a-token" }],
    [
      "spoofed identity headers",
      "GET",
      "/__s5/whoami",
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
    const result = {
      probe: name,
      status: r.status,
      location: locationKind(r.headers.get("location")),
      workerRan: r.headers.get("x-s5-worker") === "1",
      server: r.headers.get("server"),
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }

  // The real keys, through the spike's own cache and validator.
  const cache = new JwksCache(
    `${issuer}/cdn-cgi/access/certs`,
    (u) => fetch(u),
    () => Date.now(),
  );
  const loaded = await Promise.all(
    certs.keys.map(async (k) => (await cache.key(k.kid)) !== undefined),
  );
  const config = { issuer, audience: staging.aud };
  const forgedVerdict = await validateAccessJwt(forged, config, cache, now);
  const stranger = await sign(await makeKey("not-a-team-kid"), { iss: issuer, aud: [staging.aud] });
  const strangerVerdict = await validateAccessJwt(stranger, config, cache, now);
  const keys = {
    count: certs.keys.length,
    shapes: certs.keys.map((k) => `${k.kty}/${k.alg}/${k.use ?? "-"}`),
    publicCertsListed: certs.public_certs?.length ?? 0,
    allLoadedByJwksCache: loaded.every(Boolean),
    forgedTokenWithRealKid: forgedVerdict.ok ? "ok" : forgedVerdict.reason,
    tokenWithUnknownKid: strangerVerdict.ok ? "ok" : strangerVerdict.reason,
    certsFetches: cache.fetches,
  };
  console.log(JSON.stringify(keys));

  const pass =
    results.every(
      (r) => !r.workerRan && (r.status === 302 || r.status === 401 || r.status === 403),
    ) &&
    keys.allLoadedByJwksCache &&
    keys.forgedTokenWithRealKid === "bad_signature" &&
    keys.tokenWithUnknownKid === "unknown_kid";
  const out = { at: new Date().toISOString(), pass, probes: results, teamKeys: keys };
  writeFileSync(
    join(SPIKE, "results", "staging-edge.json"),
    `${redact(JSON.stringify(out, null, 2))}\n`,
  );
  console.log(pass ? "PASS" : "FAIL");
}

await main();
