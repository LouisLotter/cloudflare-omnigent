// Spike S5's 16 negative assertion cases, signed locally, for the "four paths" tests in Node and
// workerd (implementation plan, WP2.1's key tests). Each is a header set for one request.

import type { IngressFailure } from "../../src/ingress/index.ts";
import { claims, OTHER_AUD, sign, type TestKey } from "./access-keys.ts";

export interface LocalCase {
  readonly name: string;
  readonly expected: IngressFailure;
  /** Request headers: a string sets the header. */
  readonly headers: Readonly<Record<string, string>>;
}

export interface S5Keys {
  /** The team's key, as the key source serves it. */
  readonly key: TestKey;
  /** A forger's key under the same `kid`. */
  readonly rogue: TestKey;
  /** A key the team does not have. */
  readonly stranger: TestKey;
}

const assertion = (token: string) => ({ "cf-access-jwt-assertion": token });

/** The 16 cases of S5's local run, then service tokens, which WP2.1 adds. */
export async function s5Cases({ key, rogue, stranger }: S5Keys, now: number): Promise<LocalCase[]> {
  const genuine = await sign(key, claims(now));
  const [h, , s] = genuine.split(".") as [string, string, string];
  const edited = await sign(key, claims(now, { aud: [OTHER_AUD] }));
  const editedPayload = edited.split(".")[1] as string;
  const enc = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    { name: "missing", expected: "missing_assertion", headers: {} },
    {
      name: "cookie only",
      expected: "missing_assertion",
      headers: { cookie: `CF_Authorization=${genuine}` },
    },
    { name: "empty", expected: "missing_assertion", headers: assertion("") },
    { name: "oversized", expected: "oversized", headers: assertion("a".repeat(8193)) },
    { name: "malformed", expected: "malformed", headers: assertion("not.a.jwt") },
    {
      name: "forged signature under the genuine kid",
      expected: "bad_signature",
      headers: assertion(await sign(rogue, claims(now))),
    },
    {
      name: "payload edited after signing",
      expected: "bad_signature",
      headers: assertion(`${h}.${editedPayload}.${s}`),
    },
    {
      name: "alg none",
      expected: "unsupported_alg",
      headers: assertion(`${enc({ alg: "none", kid: key.kid })}.${editedPayload}.`),
    },
    {
      name: "alg HS256",
      expected: "unsupported_alg",
      headers: assertion(`${enc({ alg: "HS256", kid: key.kid })}.${editedPayload}.${s}`),
    },
    {
      name: "unknown kid",
      expected: "unknown_kid",
      headers: assertion(await sign(stranger, claims(now))),
    },
    {
      name: "wrong issuer",
      expected: "wrong_issuer",
      headers: assertion(
        await sign(key, claims(now, { iss: "https://another-team.cloudflareaccess.com" })),
      ),
    },
    {
      name: "another application's AUD",
      expected: "wrong_audience",
      headers: assertion(edited),
    },
    {
      name: "expired",
      expected: "expired",
      headers: assertion(await sign(key, claims(now - 3600, { exp: now - 31 }))),
    },
    {
      name: "not yet valid",
      expected: "not_yet_valid",
      headers: assertion(await sign(key, claims(now, { nbf: now + 120, iat: now + 120 }))),
    },
    {
      name: "org token",
      expected: "wrong_token_type",
      headers: assertion(await sign(key, claims(now, { type: "org" }))),
    },
    {
      name: "another identity",
      expected: "not_owner",
      headers: assertion(await sign(key, claims(now, { email: "someone-else@example.invalid" }))),
    },
    {
      name: "service token (empty sub, no email)",
      expected: "service_token",
      headers: assertion(
        await sign(key, claims(now, { sub: "", email: undefined, common_name: "svc.access" })),
      ),
    },
  ];
}

/** The four paths S5 checked each case on, as the product's routes: UI, API, setup, a page. */
export const FOUR_PATHS: readonly { readonly method: string; readonly path: string }[] = [
  { method: "GET", path: "/" },
  { method: "GET", path: "/v1/sessions?limit=5&secret-query=canary" },
  { method: "POST", path: "/auth/setup" },
  { method: "GET", path: "/computers" },
];
