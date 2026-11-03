// Omnigent's signed identity envelope (WP8.3): what OmnigentServer adds to a forwarded request so
// that the server ties it to the Access identity ingress validated. Pure: WebCrypto only.
//
// The format is the fork's (`omnigent.server.external_identity`): `v1.<payload>.<mac>`, the
// payload base64url JSON `{aud, email?, exp, iat, iss, owner, sub, v: 1}` with its keys in that
// order, and the MAC an HMAC-SHA256 over `omnigent-external-identity/v1.` and the payload's text.
// The key is derived from the installation's Omnigent cookie secret, which only the platform
// Worker and the server hold (the server image derives the same key, `cfo_server/config.py`):
// whoever holds that secret can already mint any member's session, so the key gives nobody a new
// power. An envelope lasts ENVELOPE_LIFETIME_S at most, and never past the assertion's expiry.

import { ENVELOPE_LIFETIME_S, type ForwardedPerson } from "@cfo/contracts";

/** The label the envelope key is derived under. */
export const ENVELOPE_KEY_LABEL = "cfo/omnigent-external-identity/v1";
const MAC_LABEL = "omnigent-external-identity/v1.";
const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

/** The envelope key: lowercase hex of HMAC-SHA256(cookie secret's bytes, ENVELOPE_KEY_LABEL). */
export async function envelopeKey(cookieSecret: string): Promise<string> {
  return hex(await hmac(encoder.encode(cookieSecret), ENVELOPE_KEY_LABEL));
}

/** The envelope for *person*, signed now; null when the assertion has already expired. */
export async function signEnvelope(
  person: ForwardedPerson,
  key: string,
  nowSeconds: number,
): Promise<string | null> {
  const issuedAt = Math.floor(nowSeconds);
  const expiresAt = Math.min(issuedAt + ENVELOPE_LIFETIME_S, person.expiresAt);
  if (expiresAt <= issuedAt) return null;
  const claims = {
    aud: person.audience,
    ...(person.email === undefined ? {} : { email: person.email }),
    exp: expiresAt,
    iat: issuedAt,
    iss: person.issuer,
    owner: person.installationOwner,
    sub: person.subject,
    v: 1,
  };
  const payload = base64Url(encoder.encode(JSON.stringify(claims)));
  const mac = new Uint8Array(await hmac(encoder.encode(key), MAC_LABEL + payload));
  return `v1.${payload}.${base64Url(mac)}`;
}
