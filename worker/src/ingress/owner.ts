// The pinned owner (R-29): ingress admits one identity, whatever Access admitted.
//
// The owner's address is stored at installation as a salted hash, so the Worker's configuration
// does not name the owner and a dictionary of addresses cannot be checked against it offline
// without the salt. The form is
//
//   hmac-sha256:<salt, base64url, 16 to 64 bytes>:<HMAC-SHA256(salt, address), 64 lowercase hex>
//
// where the address is trimmed and lowercased first. `makeOwnerPin` writes it; the bootstrap
// script (WP2.4) and the staging configuration use it.

import { base64UrlDecode, base64UrlEncode } from "./access.ts";

const PIN = /^hmac-sha256:([A-Za-z0-9_-]+):([0-9a-f]{64})$/;
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
const HMAC = { name: "HMAC", hash: "SHA-256" } as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function digest(salt: Uint8Array<ArrayBuffer>, email: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", salt, HMAC, false, ["sign"]);
  const mac = await crypto.subtle.sign(HMAC, key, new TextEncoder().encode(normalizeEmail(email)));
  return new Uint8Array(mac);
}

/** The pin for `email` with this salt, as the Worker variable `OWNER_EMAIL_HASH` holds it. */
export async function makeOwnerPin(email: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) {
    throw new Error(`the salt must be ${MIN_SALT_BYTES} to ${MAX_SALT_BYTES} bytes`);
  }
  if (normalizeEmail(email) === "") throw new Error("the owner's address is empty");
  return `hmac-sha256:${base64UrlEncode(salt)}:${hex(await digest(salt, email))}`;
}

export interface OwnerPin {
  /** Whether `email` is the pinned owner's address. Compares in constant time. */
  matches(email: string): Promise<boolean>;
}

/** The pin from its stored form, or undefined if it is not exactly that form. */
export function parseOwnerPin(text: string | undefined): OwnerPin | undefined {
  const match = PIN.exec(text ?? "");
  if (!match) return undefined;
  let salt: Uint8Array<ArrayBuffer>;
  try {
    salt = base64UrlDecode(match[1] as string);
  } catch {
    return undefined;
  }
  if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) return undefined;
  const expected = match[2] as string;
  return {
    async matches(email: string): Promise<boolean> {
      const got = hex(await digest(salt, email));
      let diff = 0;
      for (let i = 0; i < expected.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
      return diff === 0;
    },
  };
}
