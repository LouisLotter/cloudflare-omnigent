// Test helpers for ingress: RSA keys generated at run time and an Access-shaped token signer.
// Runs in Node and in workerd. Every identity here is synthetic (example.invalid).

import { base64UrlEncode, KEYS_UNAVAILABLE, type KeySource } from "../../src/ingress/access.ts";

export const TEAM = "cfo-test.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const AUD = "a".repeat(64);
export const OTHER_AUD = "b".repeat(64);
export const OWNER_EMAIL = "owner@example.invalid";
export const OWNER_SUB = "00000000-0000-4000-8000-000000000001";
export const HOST = "cfo.example.invalid";
/** A fixed salt for tests; installations draw a random one. */
export const SALT = new Uint8Array(16).fill(7);

export interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string, modulusLength = 2048): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    jwk: { kty: "RSA", n: exported.n ?? "", e: exported.e ?? "", alg: "RS256", use: "sig", kid },
  };
}

const json = (value: unknown) => base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

export async function sign(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = json({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = json(payload);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${base64UrlEncode(new Uint8Array(sig))}`;
}

/** Claims as Access writes them for an application token; `extra` overrides or removes. */
export function claims(now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    aud: [AUD],
    email: OWNER_EMAIL,
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    iss: ISSUER,
    type: "app",
    identity_nonce: "synthetic",
    sub: OWNER_SUB,
    country: "XX",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function staticKeys(keys: readonly TestKey[]): KeySource {
  const map = new Map(keys.map((k) => [k.kid, k.publicKey]));
  return { key: async (kid) => map.get(kid) };
}

export const unavailableKeys: KeySource = { key: async () => KEYS_UNAVAILABLE };

export const jwksResponse = (...keys: TestKey[]) => Response.json({ keys: keys.map((k) => k.jwk) });
