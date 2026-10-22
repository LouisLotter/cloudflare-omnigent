// Validation of the Cloudflare Access assertion (the design's "Ingress", from spike S5).
//
// Pure: WebCrypto, TextEncoder and injected ports only, so it runs unchanged in Node and workerd.
// RS256 is the only algorithm Access uses, and WebCrypto verifies it directly.
//
// In order, so that an unverified token never learns which claim was wrong:
//   1. the `Cf-Access-Jwt-Assertion` header's presence and size (the caller never reads the
//      cookie);
//   2. shape: three parts, the first a canonical base64url JSON object;
//   3. header: `alg` exactly RS256 (no `none`, no HS256 key confusion), `kid` present, no `crit`;
//      then the other two parts canonical base64url;
//   4. the signature, with the team key whose `kid` matches, from the team's certs endpoint;
//   5. only then the claims: `iss` is the team domain, `aud` holds this application's AUD tag,
//      `exp`, `nbf` and `iat` within a small leeway, `type` is `app` (not an `org` session),
//      `sub` is not empty (service tokens have an empty `sub`), and the whole payload parses as
//      the `AccessAssertionClaims` contract.
// The owner pin (owner.ts) and the hostname allowlist (hosts.ts) are separate steps.

import { AccessAssertionClaims } from "@cfo/contracts";

export type AssertionFailure =
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
  | "service_token";

export interface AccessSettings {
  /** `https://<team>.cloudflareaccess.com`, exactly as Access writes `iss`. */
  readonly issuer: string;
  /** The Access application's AUD tag. */
  readonly audience: string;
  /** Clock skew allowed on `exp`, `nbf` and `iat`. Default 30 s. */
  readonly leewaySeconds?: number;
}

export type AssertionResult =
  | { readonly ok: true; readonly claims: AccessAssertionClaims }
  | { readonly ok: false; readonly reason: AssertionFailure };

export const KEYS_UNAVAILABLE = Symbol("keys unavailable");

export interface KeySource {
  /** The verification key for `kid`; undefined if the team has no such key. */
  key(kid: string): Promise<CryptoKey | undefined | typeof KEYS_UNAVAILABLE>;
}

/** Access tokens are a few hundred bytes to a couple of KB; custom claims are trimmed at ~1 KB. */
export const MAX_ASSERTION_LENGTH = 8192;
export const DEFAULT_LEEWAY_SECONDS = 30;
const MAX_KID_LENGTH = 128;
const B64URL = /^[A-Za-z0-9_-]+$/;
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** The issuer for a team domain; undefined unless it is exactly `<team>.cloudflareaccess.com`. */
export function issuerFor(teamDomain: string): string | undefined {
  return TEAM_DOMAIN.test(teamDomain) ? `https://${teamDomain}` : undefined;
}

export function certsUrlFor(issuer: string): string {
  return `${issuer}/cdn-cgi/access/certs`;
}

/** Strict: only the canonical unpadded encoding of some bytes is accepted. */
export function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(part) || part.length % 4 === 1) throw new Error("not base64url");
  const padded =
    part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // atob ignores the unused low bits of the last character, so two spellings can decode to the
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

const fail = (reason: AssertionFailure): AssertionResult => ({ ok: false, reason });

export async function validateAssertion(
  token: string | null | undefined,
  settings: AccessSettings,
  keys: KeySource,
  nowSeconds: number,
): Promise<AssertionResult> {
  if (token === null || token === undefined || token === "") return fail("missing_assertion");
  if (token.length > MAX_ASSERTION_LENGTH) return fail("oversized");

  const parts = token.split(".");
  if (parts.length !== 3) return fail("malformed");
  const [h, p, s] = parts as [string, string, string];
  const decode = (part: string): Uint8Array<ArrayBuffer> | undefined => {
    try {
      return base64UrlDecode(part);
    } catch {
      return undefined;
    }
  };
  const headerBytes = decode(h);
  const header = headerBytes && jsonObject(headerBytes);
  if (!header) return fail("malformed");
  if (header.alg !== "RS256") return fail("unsupported_alg");
  if (header.typ !== undefined && header.typ !== "JWT") return fail("malformed");
  // RFC 7515: a recipient must refuse critical extensions it does not understand.
  if (header.crit !== undefined) return fail("malformed");
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
    return fail("malformed");
  }
  const payloadBytes = decode(p);
  const signature = decode(s);
  if (!payloadBytes || !signature) return fail("malformed");

  const key = await keys.key(kid);
  if (key === KEYS_UNAVAILABLE) return fail("keys_unavailable");
  if (key === undefined) return fail("unknown_kid");
  const signed = new TextEncoder().encode(`${h}.${p}`);
  if (!(await crypto.subtle.verify(RS256, key, signature, signed))) return fail("bad_signature");

  // Signed by the team's key: the payload is Cloudflare's, so now read what it says.
  const payload = jsonObject(payloadBytes);
  if (!payload) return fail("malformed");
  const leeway = settings.leewaySeconds ?? DEFAULT_LEEWAY_SECONDS;
  if (payload.iss !== settings.issuer) return fail("wrong_issuer");
  const aud = payload.aud;
  const audiences: unknown[] = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(settings.audience)) return fail("wrong_audience");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return fail("malformed");
  if (nowSeconds >= payload.exp + leeway) return fail("expired");
  for (const claim of ["nbf", "iat"] as const) {
    const value = payload[claim];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("malformed");
    if (nowSeconds + leeway < value) return fail("not_yet_valid");
  }
  if (payload.type !== "app") return fail("wrong_token_type");
  if (payload.sub === "") return fail("service_token");
  const claims = AccessAssertionClaims.safeParse(payload);
  if (!claims.success) return fail("malformed");
  return { ok: true, claims: claims.data };
}

/** The bit length of a big-endian unsigned integer. */
function bitLength(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i] as number));
}

export const MIN_RSA_BITS = 2048;
export const MAX_RSA_BITS = 8192;

/**
 * One RSA verification key from a JWKS entry, or undefined unless it is an RS256 signing key
 * with a modulus of 2048 to 8192 bits and an odd public exponent of at most 32 bits.
 */
export async function importJwk(entry: unknown): Promise<[string, CryptoKey] | undefined> {
  if (entry === null || typeof entry !== "object") return undefined;
  const jwk = entry as Record<string, unknown>;
  if (
    jwk.kty !== "RSA" ||
    typeof jwk.kid !== "string" ||
    jwk.kid.length === 0 ||
    jwk.kid.length > MAX_KID_LENGTH ||
    typeof jwk.n !== "string" ||
    typeof jwk.e !== "string" ||
    (jwk.alg !== undefined && jwk.alg !== "RS256") ||
    (jwk.use !== undefined && jwk.use !== "sig")
  ) {
    return undefined;
  }
  try {
    // Node imports some malformed or short moduli without complaint, so check them here.
    const bits = bitLength(base64UrlDecode(jwk.n));
    const e = base64UrlDecode(jwk.e);
    if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS) return undefined;
    const exponentBits = bitLength(e);
    if (exponentBits < 2 || exponentBits > 32 || ((e[e.length - 1] as number) & 1) === 0) {
      return undefined;
    }
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

export interface JwksOptions {
  /** How long fetched keys are used without asking again. */
  readonly ttlMs: number;
  /** The least time between two fetches, so random key IDs cannot make the Worker a fetcher. */
  readonly minRefetchMs: number;
  /** How long known keys keep working while the certs endpoint is down. */
  readonly maxStaleMs: number;
  /** How long a lookup waits for a fetch, its own or another request's, before giving up. */
  readonly refreshDeadlineMs: number;
}

export const JWKS_DEFAULTS: JwksOptions = {
  ttlMs: 10 * 60_000,
  minRefetchMs: 30_000,
  maxStaleMs: 24 * 3_600_000,
  refreshDeadlineMs: 10_000,
};

const MAX_JWKS_LENGTH = 65_536;
const MAX_JWKS_KEYS = 16;

/**
 * The team's signing keys, fetched from its certs endpoint and kept in the isolate.
 *   - Fresh for `ttlMs`. An unknown `kid`, or a stale cache, fetches again, but at most once per
 *     `minRefetchMs`.
 *   - If a fetch fails, the keys of the last good fetch keep working for `maxStaleMs` after it:
 *     Access keeps a previous key valid for days after a rotation, so a short outage of the
 *     certs endpoint does not lock the owner out. Past that, or with no keys at all, the answer
 *     is `KEYS_UNAVAILABLE`, which ingress turns into a retryable 503.
 *   - A good fetch replaces the whole set, so a key Cloudflare withdrew stops working.
 *   - Concurrent lookups share one fetch. Each waits at most `refreshDeadlineMs`, measured in its
 *     own request, so a fetch stranded by another request's cancellation cannot hold up later
 *     requests.
 */
export class JwksCache implements KeySource {
  private keys = new Map<string, CryptoKey>();
  private fetchedAt = Number.NEGATIVE_INFINITY;
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private inflight: { readonly promise: Promise<void>; readonly startedAt: number } | undefined;
  /** Fetches started, for tests and the staging harness. */
  fetches = 0;

  private readonly certsUrl: string;
  private readonly fetcher: Fetcher;
  private readonly clockMs: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly options: JwksOptions;

  constructor(
    certsUrl: string,
    fetcher: Fetcher,
    clockMs: () => number,
    wait: (ms: number) => Promise<void>,
    options: JwksOptions = JWKS_DEFAULTS,
  ) {
    this.certsUrl = certsUrl;
    this.fetcher = fetcher;
    this.clockMs = clockMs;
    this.wait = wait;
    this.options = options;
  }

  async key(kid: string): Promise<CryptoKey | undefined | typeof KEYS_UNAVAILABLE> {
    const now = this.clockMs();
    const known = this.keys.get(kid);
    if (known !== undefined && now - this.fetchedAt < this.options.ttlMs) return known;
    await this.refresh(now);
    if (this.clockMs() - this.fetchedAt >= this.options.maxStaleMs) return KEYS_UNAVAILABLE;
    return this.keys.get(kid);
  }

  private async refresh(now: number): Promise<void> {
    const deadline = this.options.refreshDeadlineMs;
    const running = this.inflight;
    if (running !== undefined && now - running.startedAt < deadline) {
      await Promise.race([running.promise, this.wait(running.startedAt + deadline - now)]);
      return;
    }
    if (now - this.attemptedAt < this.options.minRefetchMs) return;
    this.attemptedAt = now;
    this.fetches++;
    const promise = this.load();
    const entry = { promise, startedAt: now };
    this.inflight = entry;
    void promise.then(() => {
      if (this.inflight === entry) this.inflight = undefined;
    });
    await Promise.race([promise, this.wait(deadline)]);
  }

  /** Never rejects: a failure keeps the previous keys. */
  private async load(): Promise<void> {
    try {
      const response = await this.fetcher(this.certsUrl);
      if (!response.ok) {
        await response.body?.cancel();
        return;
      }
      const text = await response.text();
      if (text.length > MAX_JWKS_LENGTH) return;
      const body: unknown = JSON.parse(text);
      if (body === null || typeof body !== "object") return;
      const list = (body as { keys?: unknown }).keys;
      if (!Array.isArray(list)) return;
      const next = new Map<string, CryptoKey>();
      for (const entry of list.slice(0, MAX_JWKS_KEYS)) {
        const imported = await importJwk(entry);
        if (imported && !next.has(imported[0])) next.set(imported[0], imported[1]);
      }
      if (next.size === 0) return;
      this.keys = next;
      this.fetchedAt = this.clockMs();
    } catch {
      // Keep the previous keys; `key()` decides whether they are still usable.
    }
  }
}
