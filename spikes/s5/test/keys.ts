// Test helpers: RSA keys generated at run time and an Access-shaped token signer.

import { base64UrlEncode, KEYS_UNAVAILABLE, type KeySource } from "../src/access.ts";

export const TEAM = "s5-test.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
export const AUD = "a".repeat(64);
export const OTHER_AUD = "b".repeat(64);

export interface TestKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
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

export function claims(now: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: [AUD],
    email: "owner@example.invalid",
    exp: now + 600,
    iat: now - 10,
    nbf: now - 10,
    iss: ISSUER,
    type: "app",
    identity_nonce: "synthetic",
    sub: "00000000-0000-4000-8000-000000000001",
    country: "XX",
    ...extra,
  };
}

export function staticKeys(keys: TestKey[]): KeySource {
  const map = new Map(keys.map((k) => [k.kid, k.publicKey]));
  return { key: async (kid) => map.get(kid) };
}

export const unavailableKeys: KeySource = { key: async () => KEYS_UNAVAILABLE };
