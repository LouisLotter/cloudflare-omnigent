// Spike S5: WebCrypto helpers for the platform's stored Omnigent login and the repair form.
// Pure: runs in Node and workerd alike.

import { base64UrlDecode, base64UrlEncode } from "./access.ts";

export interface Sealer {
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string>;
}

/**
 * AES-256-GCM with a random 96-bit nonce per value, and associated data that binds the value
 * to its purpose, so a sealed refresh token cannot be replayed as another field.
 * Format: `v1.<nonce>.<ciphertext+tag>`, base64url.
 */
export async function aesGcmSealer(keyBase64Url: string, purpose: string): Promise<Sealer> {
  const raw = base64UrlDecode(keyBase64Url);
  if (raw.length !== 32) throw new Error("the sealing key must be 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  const aad = new TextEncoder().encode(`cfo-s5:${purpose}`);
  return {
    async seal(plain) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad },
          key,
          new TextEncoder().encode(plain),
        ),
      );
      return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(data)}`;
    },
    async open(sealed) {
      const [version, iv, data] = sealed.split(".");
      if (version !== "v1" || !iv || !data) throw new Error("unknown sealed format");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64UrlDecode(iv), additionalData: aad },
        key,
        base64UrlDecode(data),
      );
      return new TextDecoder().decode(plain);
    },
  };
}

async function hmacKey(keyBase64Url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    base64UrlDecode(keyBase64Url),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * A form token bound to the Access identity (`sub`), the form's purpose and a time window.
 * The repair form is reachable only through Access with an exact Origin, so this is the second
 * of two checks, not the only one.
 */
export async function formToken(
  keyBase64Url: string,
  sub: string,
  purpose: string,
  nowMs: number,
): Promise<string> {
  const issued = Math.floor(nowMs / 1000);
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(keyBase64Url),
    new TextEncoder().encode(`${purpose}|${sub}|${issued}`),
  );
  return `${issued}.${base64UrlEncode(new Uint8Array(mac))}`;
}

export async function checkFormToken(
  keyBase64Url: string,
  token: string,
  sub: string,
  purpose: string,
  nowMs: number,
  maxAgeSeconds = 900,
): Promise<boolean> {
  const [issuedText, mac] = token.split(".");
  if (!issuedText || !mac || !/^\d{1,12}$/.test(issuedText)) return false;
  const issued = Number(issuedText);
  const now = Math.floor(nowMs / 1000);
  if (now - issued > maxAgeSeconds || issued - now > 60) return false;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmacKey(keyBase64Url),
      base64UrlDecode(mac),
      new TextEncoder().encode(`${purpose}|${sub}|${issued}`),
    );
  } catch {
    return false;
  }
}
