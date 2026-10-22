// Negative cases derived from one genuine Access assertion (spike S5's method, WP2.1's key test).
//
// On staging, Access stops every request without a valid session before the Worker runs, so the
// Worker never sees a forged, expired or foreign assertion from outside. To exercise its checks
// in the real runtime with the team's real keys, the deployed harness takes the owner's genuine
// request and derives each case from it: a flipped signature byte, a payload edited after
// signing, the same token judged as another application, team or owner would judge it, a clock
// past its expiry, and so on. A token for another application differs from the owner's only in
// `aud`, so judging this token with another application's AUD tag is the same predicate.
//
// Every case runs through the whole ingress step (`createIngress(...).admit`), not the validator
// alone, and records whether the request would have reached the next handler.
//
// Used by the unit and Workers-runtime tests with a locally signed token, and by the staging
// harness (test/staging/ingress/harness.ts) with the owner's genuine one.

import { base64UrlDecode, base64UrlEncode, type KeySource } from "../../src/ingress/access.ts";
import { IDENTITY_HEADERS } from "../../src/ingress/hosts.ts";
import {
  createIngress,
  type IngressConfig,
  type IngressFailure,
  type IngressResult,
} from "../../src/ingress/index.ts";
import { LIMIT_DEFAULTS, RateLimiter } from "../../src/ingress/limits.ts";
import { makeOwnerPin, parseOwnerPin } from "../../src/ingress/owner.ts";

export interface DerivedCase {
  readonly name: string;
  /** "s5": the 18 cases of spike S5. "wp2.1": cases added for WP2.1. */
  readonly group: "s5" | "wp2.1";
  readonly expected: "ok" | IngressFailure;
  /** The outcome, or `leaked: <header>` when an admitted request kept an identity header. */
  readonly got: string;
  readonly pass: boolean;
  /** Whether the request would have reached the next handler (the forwarding path). */
  readonly reachedNext: boolean;
}

export interface DeriveInput {
  /** The genuine request as it reached the Worker, with its `Cf-Access-Jwt-Assertion`. */
  readonly request: Request;
  /** The deployed ingress configuration. */
  readonly config: IngressConfig;
  /** The deployed key source: on staging, the team's real keys. */
  readonly keys: KeySource;
  readonly nowMs: number;
  /** Another genuine key ID of the team, if it has one: a token claiming it must not verify. */
  readonly otherKid?: string;
}

const LEEWAY_SECONDS = 30;
const ASSERTION = "cf-access-jwt-assertion";

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Identity material left on an admitted request, or undefined if it is clean. */
export function leakedIdentity(request: Request): string | undefined {
  for (const [name] of request.headers) {
    if (name.startsWith("cf-access-") || IDENTITY_HEADERS.includes(name)) return name;
  }
  const cookie = request.headers.get("cookie") ?? "";
  if (/(^|[;,]\s*)cf_authorization=/i.test(cookie)) return "cookie CF_Authorization";
  return undefined;
}

interface Variant {
  readonly name: string;
  readonly group: "s5" | "wp2.1";
  readonly expected: "ok" | IngressFailure;
  readonly url?: string;
  readonly method?: string;
  /** Header changes: a string sets, undefined deletes. */
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly config?: IngressConfig;
  readonly nowMs?: number;
  /** Run as the second of two requests from one client against a burst of one. */
  readonly secondOfBurstOne?: boolean;
}

export async function deriveCases(input: DeriveInput): Promise<DerivedCase[]> {
  const token = input.request.headers.get(ASSERTION);
  if (!token) throw new Error("deriveCases needs the genuine request's assertion");
  const [h, p, s] = token.split(".") as [string, string, string];
  const header = decodeJson(h);
  const payload = decodeJson(p);
  const exp = typeof payload.exp === "number" ? payload.exp : Math.floor(input.nowMs / 1000);
  const notBefore =
    typeof payload.nbf === "number"
      ? payload.nbf
      : typeof payload.iat === "number"
        ? payload.iat
        : exp - 3600;
  const signature = base64UrlDecode(s);
  const flipped = new Uint8Array(signature);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
  const url = new URL(input.request.url);
  const origin = url.origin;
  const sibling = `https://sibling-${randomHex(4)}.${url.hostname.split(".").slice(1).join(".")}`;
  const other = (pin: string) => {
    const owner = parseOwnerPin(pin);
    if (!owner) throw new Error("could not build another owner's pin");
    return { ...input.config, owner };
  };
  const someoneElse = other(
    await makeOwnerPin("someone-else@example.invalid", crypto.getRandomValues(new Uint8Array(16))),
  );
  const withToken = (t: string | undefined) => ({ [ASSERTION]: t });
  const foreignUrl = new URL(input.request.url);
  foreignUrl.hostname = "attacker.example";

  const variants: Variant[] = [
    { name: "genuine assertion", group: "s5", expected: "ok" },
    {
      name: "missing assertion",
      group: "s5",
      expected: "missing_assertion",
      headers: withToken(undefined),
    },
    { name: "empty assertion", group: "s5", expected: "missing_assertion", headers: withToken("") },
    { name: "truncated", group: "s5", expected: "malformed", headers: withToken(`${h}.${p}`) },
    {
      name: "oversized",
      group: "s5",
      expected: "oversized",
      headers: withToken(`${h}.${p}.${"A".repeat(8192)}`),
    },
    {
      name: "signature byte flipped",
      group: "s5",
      expected: "bad_signature",
      headers: withToken(`${h}.${p}.${base64UrlEncode(flipped)}`),
    },
    {
      name: "payload edited after signing (aud swapped)",
      group: "s5",
      expected: "bad_signature",
      headers: withToken(`${h}.${encodeJson({ ...payload, aud: [randomHex(32)] })}.${s}`),
    },
    {
      name: "payload edited after signing (exp extended)",
      group: "s5",
      expected: "bad_signature",
      headers: withToken(`${h}.${encodeJson({ ...payload, exp: exp + 86_400 })}.${s}`),
    },
    {
      name: "alg none",
      group: "s5",
      expected: "unsupported_alg",
      headers: withToken(`${encodeJson({ ...header, alg: "none" })}.${p}.AA`),
    },
    {
      name: "alg HS256 (key confusion)",
      group: "s5",
      expected: "unsupported_alg",
      headers: withToken(`${encodeJson({ ...header, alg: "HS256" })}.${p}.${s}`),
    },
    {
      name: "unknown key id",
      group: "s5",
      expected: "unknown_kid",
      headers: withToken(`${encodeJson({ ...header, kid: "0".repeat(64) })}.${p}.${s}`),
    },
    {
      name: "another application (other AUD)",
      group: "s5",
      expected: "wrong_audience",
      config: {
        ...input.config,
        settings: { ...input.config.settings, audience: randomHex(32) },
      },
    },
    {
      name: "another team (other issuer)",
      group: "s5",
      expected: "wrong_issuer",
      config: {
        ...input.config,
        settings: {
          ...input.config.settings,
          issuer: "https://another-team.cloudflareaccess.com",
        },
      },
    },
    {
      name: "expired (clock past exp)",
      group: "s5",
      expected: "expired",
      nowMs: (exp + LEEWAY_SECONDS + 1) * 1000,
    },
    {
      name: "not yet valid (clock before nbf)",
      group: "s5",
      expected: "not_yet_valid",
      nowMs: (notBefore - LEEWAY_SECONDS - 120) * 1000,
    },
    {
      name: "another identity (owner pin)",
      group: "s5",
      expected: "not_owner",
      config: someoneElse,
    },
    { name: "unknown hostname", group: "s5", expected: "unknown_host", url: foreignUrl.href },
    { name: "this hostname", group: "s5", expected: "ok", url: url.href },
    {
      name: "cookie only (assertion moved to the CF_Authorization cookie)",
      group: "wp2.1",
      expected: "missing_assertion",
      headers: { [ASSERTION]: undefined, cookie: `CF_Authorization=${token}` },
    },
    {
      name: "crit header added after signing",
      group: "wp2.1",
      expected: "malformed",
      headers: withToken(`${encodeJson({ ...header, crit: ["exp"] })}.${p}.${s}`),
    },
    ...(input.otherKid !== undefined && input.otherKid !== header.kid
      ? [
          {
            name: "another genuine team key's ID",
            group: "wp2.1",
            expected: "bad_signature",
            headers: withToken(`${encodeJson({ ...header, kid: input.otherKid })}.${p}.${s}`),
          } satisfies Variant,
        ]
      : []),
    {
      name: "unsafe method with a foreign Origin",
      group: "wp2.1",
      expected: "bad_origin",
      method: "POST",
      headers: { origin: "https://attacker.example" },
    },
    {
      name: "unsafe method with Origin null",
      group: "wp2.1",
      expected: "bad_origin",
      method: "POST",
      headers: { origin: "null" },
    },
    {
      name: "unsafe method from a same-site sibling origin",
      group: "wp2.1",
      expected: "bad_origin",
      method: "DELETE",
      headers: { origin: sibling },
    },
    {
      name: "WebSocket upgrade with a foreign Origin",
      group: "wp2.1",
      expected: "bad_origin",
      headers: { upgrade: "websocket", origin: "https://attacker.example" },
    },
    {
      name: "unsafe method with this exact Origin",
      group: "wp2.1",
      expected: "ok",
      method: "POST",
      headers: { origin },
    },
    {
      name: "spoofed identity headers and the Access cookie are stripped",
      group: "wp2.1",
      expected: "ok",
      headers: {
        "x-forwarded-email": "spoof@example.invalid",
        "cf-access-authenticated-user-email": "spoof@example.invalid",
        "remote-user": "spoof",
        cookie: `theme=dark; CF_Authorization=${token}; session=kept`,
      },
    },
    {
      name: "rate limit (a second request against a burst of one)",
      group: "wp2.1",
      expected: "rate_limited",
      secondOfBurstOne: true,
    },
  ];

  const results: DerivedCase[] = [];
  for (const v of variants) {
    const headers = new Headers(input.request.headers);
    for (const [name, value] of Object.entries(v.headers ?? {})) {
      if (value === undefined) headers.delete(name);
      else headers.set(name, value);
    }
    const method = v.method ?? "GET";
    const request = () =>
      new Request(v.url ?? input.request.url, {
        method,
        headers,
        ...(method === "GET" || method === "HEAD" ? {} : { body: "derived" }),
      });
    const clock = v.nowMs ?? input.nowMs;
    const ingress = createIngress(v.config ?? input.config, {
      keys: input.keys,
      limiter: new RateLimiter(
        () => clock,
        v.secondOfBurstOne ? { burst: 1, perSecond: 0.001, maxClients: 8 } : LIMIT_DEFAULTS,
      ),
      nowMs: () => clock,
      log: () => {},
    });
    if (v.secondOfBurstOne) await ingress.admit(request());
    const result: IngressResult = await ingress.admit(request());
    let got: string = result.ok ? "ok" : result.reason;
    if (result.ok) {
      const leaked = leakedIdentity(result.request);
      if (leaked !== undefined) got = `leaked: ${leaked}`;
    }
    results.push({
      name: v.name,
      group: v.group,
      expected: v.expected,
      got,
      pass: got === v.expected,
      reachedNext: result.ok,
    });
  }
  return results;
}
