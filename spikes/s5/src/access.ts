// Spike S5: Worker-side validation of the Cloudflare Access assertion.
//
// Pure module: WebCrypto, TextEncoder and a fetch port only, so it runs unchanged in Node (unit
// tests) and in workerd (wrangler dev, staging). No dependency: RS256 is the only algorithm
// Access uses, and WebCrypto verifies it directly.
//
// What it checks, in order, so that an unsigned token never learns which claim was wrong:
//   1. presence and size of the `Cf-Access-Jwt-Assertion` header (never the cookie);
//   2. shape: three base64url parts, JSON header and payload;
//   3. header: `alg` is exactly RS256 (no `none`, no HS256 key confusion), `kid` present;
//   4. signature, with the key whose `kid` matches, from the team's own certs endpoint;
//   5. claims: `iss` is the team domain, `aud` holds this application's AUD tag, `exp`, `nbf`
//      and `iat` with a small leeway, `type` is `app` (not an `org` session token);
//   6. optionally, that the identity is the configured owner (by SHA-256 of the email).
// The request hostname is checked separately (checkHost), before any of this.

export type AccessFailure =
  | "not_configured"
  | "unknown_host"
  | "missing_assertion"
  | "oversized"
  | "malformed"
  | "unsupported_alg"
  | "unknown_kid"
  | "keys_unavailable"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "wrong_token_type"
  | "not_owner";

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, exactly as Access writes `iss`. */
  readonly issuer: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
  /** Hex SHA-256 of the owner's lowercased email. Unset: any identity Access admitted. */
  readonly ownerEmailSha256?: string;
  /** Clock skew allowed on `exp`, `nbf` and `iat`. */
  readonly leewaySeconds?: number;
}

export interface AccessIdentity {
  readonly sub: string;
  readonly email: string | undefined;
  readonly exp: number;
  readonly iat: number | undefined;
}

export type AccessResult =
  | { readonly ok: true; readonly identity: AccessIdentity }
  | { readonly ok: false; readonly reason: AccessFailure };

export const KEYS_UNAVAILABLE = Symbol("keys unavailable");

export interface KeySource {
  /** The verification key for `kid`, undefined if the team has no such key. */
  key(kid: string): Promise<CryptoKey | undefined | typeof KEYS_UNAVAILABLE>;
}

/** Access tokens are a few hundred bytes to a couple of KB; custom claims are trimmed at ~1 KB. */
export const MAX_ASSERTION_BYTES = 8192;
const DEFAULT_LEEWAY_SECONDS = 30;
const B64URL = /^[A-Za-z0-9_-]+$/;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export function issuerFor(teamDomain: string): string {
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
    throw new Error("team domain must be <team>.cloudflareaccess.com");
  }
  return `https://${teamDomain}`;
}

export function certsUrlFor(teamDomain: string): string {
  return `${issuerFor(teamDomain)}/cdn-cgi/access/certs`;
}

/** Strict: only the canonical unpadded encoding of some bytes is accepted. */
export function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(part) || part.length % 4 === 1) throw new Error("not base64url");
  const padded =
    part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // atob ignores the unused low bits of the last character, so two strings can decode to the
  // same bytes. Refuse the non-canonical one: a token has exactly one spelling.
  if (base64UrlEncode(bytes) !== part) throw new Error("non-canonical base64url");
  return bytes;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fail = (reason: AccessFailure): AccessResult => ({ ok: false, reason });

export async function validateAccessJwt(
  token: string | null | undefined,
  config: AccessConfig,
  keys: KeySource,
  nowSeconds: number,
): Promise<AccessResult> {
  if (!config.issuer || !config.audience) return fail("not_configured");
  if (token === null || token === undefined || token === "") return fail("missing_assertion");
  if (token.length > MAX_ASSERTION_BYTES) return fail("oversized");

  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [h, p, s] = parts as [string, string, string];
  let headerBytes: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    headerBytes = base64UrlDecode(h);
    payloadBytes = base64UrlDecode(p);
    signature = base64UrlDecode(s);
  } catch {
    return fail("malformed");
  }
  const header = jsonObject(headerBytes);
  const payload = jsonObject(payloadBytes);
  if (!header || !payload) return fail("malformed");
  if (header.alg !== "RS256") return fail("unsupported_alg");
  if (header.typ !== undefined && header.typ !== "JWT") return fail("malformed");
  if (typeof header.kid !== "string" || header.kid.length === 0 || header.kid.length > 128) {
    return fail("malformed");
  }

  const key = await keys.key(header.kid);
  if (key === KEYS_UNAVAILABLE) return fail("keys_unavailable");
  if (key === undefined) return fail("unknown_kid");
  const signed = new TextEncoder().encode(`${h}.${p}`);
  const valid = await crypto.subtle.verify(RS256, key, signature, signed);
  if (!valid) return fail("bad_signature");

  // Signed by the team's key: the claims are Cloudflare's, so now check what they say.
  const leeway = config.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS;
  if (payload.iss !== config.issuer) return fail("wrong_issuer");
  const aud = payload.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.some((a) => a === config.audience)) return fail("wrong_audience");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return fail("malformed");
  if (nowSeconds >= payload.exp + leeway) return fail("expired");
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== "number") return fail("malformed");
    if (nowSeconds + leeway < payload.nbf) return fail("not_yet_valid");
  }
  if (payload.iat !== undefined) {
    if (typeof payload.iat !== "number") return fail("malformed");
    if (nowSeconds + leeway < payload.iat) return fail("not_yet_valid");
  }
  if (payload.type !== "app") return fail("wrong_token_type");
  const email = typeof payload.email === "string" ? payload.email : undefined;
  if (config.ownerEmailSha256 !== undefined) {
    if (email === undefined) return fail("not_owner");
    if ((await sha256Hex(email.trim().toLowerCase())) !== config.ownerEmailSha256.toLowerCase()) {
      return fail("not_owner");
    }
  }
  if (typeof payload.sub !== "string") return fail("malformed");
  return {
    ok: true,
    identity: {
      sub: payload.sub,
      email,
      exp: payload.exp,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
    },
  };
}

/** Exact, case-insensitive match of the request hostname against the deployment's own names. */
export function checkHost(url: URL, allowed: readonly string[]): boolean {
  const host = url.hostname.toLowerCase();
  return allowed.some((name) => name.toLowerCase() === host);
}

/** One RSA verification key from a JWKS entry, or undefined if the entry is not an RS256 key. */
export async function importJwk(entry: unknown): Promise<[string, CryptoKey] | undefined> {
  const jwk = entry as Record<string, unknown> | null;
  if (
    jwk?.kty !== "RSA" ||
    typeof jwk.kid !== "string" ||
    typeof jwk.n !== "string" ||
    typeof jwk.e !== "string" ||
    (jwk.alg !== undefined && jwk.alg !== "RS256") ||
    (jwk.use !== undefined && jwk.use !== "sig")
  ) {
    return undefined;
  }
  try {
    // Node imports some malformed moduli without complaint, so check the encoding and size here.
    if (base64UrlDecode(jwk.n).length < 256 || base64UrlDecode(jwk.e).length === 0)
      return undefined;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      RS256,
      false,
      ["verify"],
    );
    return [jwk.kid, key];
  } catch {
    return undefined;
  }
}

export type Fetcher = (url: string) => Promise<Response>;

/**
 * The team's signing keys, fetched from its certs endpoint and cached in the isolate.
 *   - Fresh for `ttlMs`; an unknown `kid` refetches, but at most once per `minRefetchMs`, so a
 *     stream of forged tokens with random key IDs cannot turn the Worker into a fetch amplifier.
 *   - If a refetch fails, keys already known keep working for `maxStaleMs`: Access keeps the
 *     previous key valid for 7 days after a rotation, so a short outage of the certs endpoint
 *     does not lock the owner out. With no keys at all the answer is `keys_unavailable`.
 */
export class JwksCache implements KeySource {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;
  fetches = 0;

  private readonly certsUrl: string;
  private readonly fetcher: Fetcher;
  private readonly clockMs: () => number;
  private readonly options: { ttlMs: number; minRefetchMs: number; maxStaleMs: number };

  constructor(
    certsUrl: string,
    fetcher: Fetcher,
    clockMs: () => number,
    options = { ttlMs: 10 * 60_000, minRefetchMs: 30_000, maxStaleMs: 24 * 3_600_000 },
  ) {
    this.certsUrl = certsUrl;
    this.fetcher = fetcher;
    this.clockMs = clockMs;
    this.options = options;
  }

  async key(kid: string): Promise<CryptoKey | undefined | typeof KEYS_UNAVAILABLE> {
    const now = this.clockMs();
    const fresh = now - this.fetchedAt < this.options.ttlMs;
    const known = this.keys.get(kid);
    if (known && fresh) return known;
    if (now - this.attemptedAt >= this.options.minRefetchMs) await this.refresh();
    const after = this.keys.get(kid);
    if (after) {
      return this.clockMs() - this.fetchedAt < this.options.maxStaleMs ? after : KEYS_UNAVAILABLE;
    }
    return this.keys.size === 0 ? KEYS_UNAVAILABLE : undefined;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.attemptedAt = this.clockMs();
    this.fetches++;
    try {
      const response = await this.fetcher(this.certsUrl);
      if (!response.ok) return;
      const text = await response.text();
      if (text.length > 65_536) return;
      const body = JSON.parse(text) as { keys?: unknown };
      if (!Array.isArray(body.keys)) return;
      const next = new Map<string, CryptoKey>();
      for (const entry of body.keys.slice(0, 16)) {
        const imported = await importJwk(entry);
        if (imported) next.set(imported[0], imported[1]);
      }
      if (next.size === 0) return;
      this.keys = next;
      this.fetchedAt = this.clockMs();
    } catch {
      // Keep the previous keys; `key()` decides whether they are still usable.
    }
  }
}

/**
 * Identity and Access headers never reach Omnigent: the Worker has already decided who the
 * caller is, and Omnigent's accounts mode must not see a header it might one day trust.
 * The `CF_Authorization` cookie is removed from the Cookie header for the same reason.
 */
export const STRIPPED_HEADERS: readonly string[] = [
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cf-access-authenticated-user-id",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-access-token",
  "x-forwarded-email",
  "x-forwarded-user",
  "x-forwarded-preferred-username",
  "x-auth-request-email",
  "x-auth-request-user",
  "x-goog-authenticated-user-email",
  "x-ms-client-principal-name",
  "remote-user",
];

export function upstreamHeaders(incoming: Headers): Headers {
  const out = new Headers(incoming);
  for (const name of STRIPPED_HEADERS) out.delete(name);
  const cookie = out.get("cookie");
  if (cookie !== null) {
    const kept = cookie
      .split(";")
      .map((c) => c.trim())
      .filter((c) => c !== "" && !/^cf_authorization=/i.test(c));
    if (kept.length > 0) out.set("cookie", kept.join("; "));
    else out.delete("cookie");
  }
  return out;
}
