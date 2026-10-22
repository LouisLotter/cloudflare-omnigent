// Ingress for the web Worker (WP2.1): the one gate every browser request passes before anything
// else in the web Worker runs. The design's "Ingress (E1, E2, E5)" and R-29.
//
// The interface for the forwarding path and the platform pages (WP2.2, WP3.5):
//
//   export default {
//     fetch: withIngress(async (admitted, env, ctx) => {
//       // admitted.identity is the pinned owner; admitted.request is stripped. Route it.
//     }),
//   } satisfies ExportedHandler<WebEnv>;
//
// `next` runs only for an admitted request, so a rejected request never reaches a Durable
// Object or wakes a container. Forward `admitted.request`, never the original request.
//
// In order, `admit` refuses:
//   1. an unconfigured or misconfigured Worker: 503, fail closed;
//   2. a hostname outside the allowlist: 404;
//   3. a client over its coarse rate limit: 429 with Retry-After;
//   4. a missing, malformed, forged, expired, foreign or otherwise invalid Access assertion,
//      read from the `Cf-Access-Jwt-Assertion` header only, never the cookie: 403
//      (503 while the team's keys cannot be loaded at all);
//   5. any identity other than the pinned owner, even when Access admitted it: 403;
//   6. an unsafe method (anything but GET, HEAD and OPTIONS) or a WebSocket upgrade whose
//      `Origin` is present and not this installation's exact origin, `null` included: 403.
// Then it strips identity headers and the `CF_Authorization` cookie, and only that cookie.
// A refusal answers with an `ErrorBody` that names no reason; the reason is logged, with the
// path but never the query string, the assertion or the email.

import type { ErrorBody, ErrorCode } from "@cfo/contracts";
import {
  type AccessSettings,
  certsUrlFor,
  issuerFor,
  JwksCache,
  type KeySource,
  validateAssertion,
} from "./access.ts";
import { isAllowedHost, parseHostnames, strippedHeaders } from "./hosts.ts";
import { clientKey, type LimitDecision, RateLimiter } from "./limits.ts";
import { originAllowed } from "./origin.ts";
import { type OwnerPin, parseOwnerPin } from "./owner.ts";

/**
 * The Worker variables ingress reads. All are plain configuration, written at installation
 * (WP2.4) or by the staging tool; none is a secret, but they stay out of the repository.
 */
export interface IngressEnv {
  /** The Zero Trust team domain, `<team>.cloudflareaccess.com`. */
  readonly ACCESS_TEAM_DOMAIN?: string | undefined;
  /** The Access application's AUD tag. Until it is set, every request answers 503. */
  readonly ACCESS_AUD?: string | undefined;
  /** The installation's public hostnames, comma-separated, matched exactly. */
  readonly ALLOWED_HOSTNAMES?: string | undefined;
  /** The owner's address as a salted hash (`makeOwnerPin` in owner.ts). Required. */
  readonly OWNER_EMAIL_HASH?: string | undefined;
  /**
   * Local end-to-end runs only: a certs origin on `http://127.0.0.1:<port>` or
   * `http://localhost:<port>`. Ignored in any other form. A deployed Worker cannot reach either,
   * so a stray value fails closed.
   */
  readonly ACCESS_CERTS_URL_LOCAL_ONLY?: string | undefined;
}

/** Who ingress admitted. Always the pinned owner (R-29); the email is deliberately not passed on. */
export interface OwnerIdentity {
  /** Access's user ID (`sub`), stable for this person in this Access account. */
  readonly sub: string;
  /**
   * The Access session this request belongs to: a hash of `sub` and the assertion's `iat` (its
   * `exp` when `iat` is absent). Capabilities bind to it (WP3.5). Not secret.
   */
  readonly sessionId: string;
  /** When Access issued the assertion, in seconds since the epoch, if it says. */
  readonly issuedAt: number | undefined;
  /** When the assertion expires, in seconds since the epoch. */
  readonly expiresAt: number;
}

/** Why a request was refused. Logged, never sent to the client. */
export type IngressFailure =
  | "not_configured"
  | "unknown_host"
  | "rate_limited"
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
  | "service_token"
  | "not_owner"
  | "bad_origin";

export interface Admitted {
  readonly ok: true;
  readonly identity: OwnerIdentity;
  /**
   * The request to pass on: the same method, URL, body and upgrade, with identity headers and
   * the `CF_Authorization` cookie removed. Omnigent's own `Authorization` header and session
   * cookie pass through.
   */
  readonly request: Request;
  /** This installation's exact browser origin for this request, `https://<hostname>`. */
  readonly origin: string;
}

export interface Rejected {
  readonly ok: false;
  readonly reason: IngressFailure;
  /** The answer to send as it is: an `ErrorBody` without detail, `no-store`. */
  readonly response: Response;
}

export type IngressResult = Admitted | Rejected;

/** The HTTP status and error code each refusal answers with. */
export const REFUSALS: Readonly<
  Record<IngressFailure, { status: number; code: ErrorCode; retryable: boolean }>
> = {
  not_configured: { status: 503, code: "unavailable", retryable: false },
  unknown_host: { status: 404, code: "not_found", retryable: false },
  rate_limited: { status: 429, code: "unavailable", retryable: true },
  keys_unavailable: { status: 503, code: "unavailable", retryable: true },
  missing_assertion: { status: 403, code: "forbidden", retryable: false },
  oversized: { status: 403, code: "forbidden", retryable: false },
  malformed: { status: 403, code: "forbidden", retryable: false },
  unsupported_alg: { status: 403, code: "forbidden", retryable: false },
  unknown_kid: { status: 403, code: "forbidden", retryable: false },
  bad_signature: { status: 403, code: "forbidden", retryable: false },
  wrong_issuer: { status: 403, code: "forbidden", retryable: false },
  wrong_audience: { status: 403, code: "forbidden", retryable: false },
  expired: { status: 403, code: "forbidden", retryable: false },
  not_yet_valid: { status: 403, code: "forbidden", retryable: false },
  wrong_token_type: { status: 403, code: "forbidden", retryable: false },
  service_token: { status: 403, code: "forbidden", retryable: false },
  not_owner: { status: 403, code: "forbidden", retryable: false },
  bad_origin: { status: 403, code: "forbidden", retryable: false },
};

/** The ingress step. One instance per isolate keeps the key cache and the rate limiter. */
export interface Ingress {
  admit(request: Request): Promise<IngressResult>;
}

/** The handler that runs after admission: the forwarding path, the platform pages. */
export type AdmittedHandler<E> = (
  admitted: Admitted,
  env: E,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

const MESSAGES: Readonly<Partial<Record<IngressFailure, string>>> = {
  unknown_host: "Not found.",
  rate_limited: "Too many requests; try again shortly.",
  keys_unavailable: "Access could not be checked; try again shortly.",
};

/** The refusal for `reason`: an `ErrorBody` that names no reason. */
export function refusal(reason: IngressFailure, retryAfterSeconds?: number): Response {
  const { status, code, retryable } = REFUSALS[reason];
  const body: ErrorBody = {
    error: { code, message: MESSAGES[reason] ?? "Access denied.", retryable },
  };
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  if (retryAfterSeconds !== undefined) headers["retry-after"] = String(retryAfterSeconds);
  return Response.json(body, { status, headers });
}

/** What ingress needs to know about this installation, parsed from `IngressEnv`. */
export interface IngressConfig {
  readonly settings: AccessSettings;
  readonly hostnames: readonly string[];
  readonly owner: OwnerPin;
  /** The team's certs endpoint, or the local stand-in's. */
  readonly certsUrl: string;
}

const AUD_TAG = /^[A-Za-z0-9_-]{1,256}$/;
const LOCAL_CERTS = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

/** The configuration, or undefined if any part is missing or malformed: ingress then fails closed. */
export function parseIngressEnv(env: IngressEnv): IngressConfig | undefined {
  const issuer = issuerFor(env.ACCESS_TEAM_DOMAIN?.trim() ?? "");
  const audience = env.ACCESS_AUD?.trim() ?? "";
  const hostnames = parseHostnames(env.ALLOWED_HOSTNAMES);
  const owner = parseOwnerPin(env.OWNER_EMAIL_HASH?.trim());
  if (issuer === undefined || !AUD_TAG.test(audience) || !hostnames || !owner) return undefined;
  const local = env.ACCESS_CERTS_URL_LOCAL_ONLY?.trim();
  const certsUrl =
    local !== undefined && LOCAL_CERTS.test(local)
      ? `${local}/cdn-cgi/access/certs`
      : certsUrlFor(issuer);
  return { settings: { issuer, audience }, hostnames, owner, certsUrl };
}

/** What `createIngress` runs on: injected so that tests drive the clock, keys and limits. */
export interface IngressDeps {
  readonly keys: KeySource;
  readonly limiter: { take(client: string): LimitDecision };
  readonly nowMs: () => number;
  /** One structured log line. Never given the assertion, an email or a query string. */
  readonly log: (line: Readonly<Record<string, string>>) => void;
}

const MAX_LOGGED_PATH = 256;

async function sessionIdOf(sub: string, issuedOrExpires: number): Promise<string> {
  const text = `cfo-ingress-session/v1\n${sub}\n${issuedOrExpires}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The ingress step for a parsed configuration; undefined configuration refuses everything. */
export function createIngress(config: IngressConfig | undefined, deps: IngressDeps): Ingress {
  const refuse = (
    reason: IngressFailure,
    request: Request,
    url: URL,
    retryAfterSeconds?: number,
  ): Rejected => {
    deps.log({
      event: "ingress_refused",
      reason,
      method: request.method,
      path: url.pathname.slice(0, MAX_LOGGED_PATH),
    });
    return { ok: false, reason, response: refusal(reason, retryAfterSeconds) };
  };

  return {
    async admit(request: Request): Promise<IngressResult> {
      const url = new URL(request.url);
      if (config === undefined) return refuse("not_configured", request, url);
      if (!isAllowedHost(url, config.hostnames)) return refuse("unknown_host", request, url);
      const limit = deps.limiter.take(clientKey(request.headers));
      if (!limit.allowed) return refuse("rate_limited", request, url, limit.retryAfterSeconds);

      const assertion = await validateAssertion(
        request.headers.get("cf-access-jwt-assertion"),
        config.settings,
        deps.keys,
        Math.floor(deps.nowMs() / 1000),
      );
      if (!assertion.ok) return refuse(assertion.reason, request, url);
      const { sub, email, iat, exp } = assertion.claims;
      if (email === undefined || !(await config.owner.matches(email))) {
        return refuse("not_owner", request, url);
      }

      const origin = url.origin;
      if (!originAllowed(request, origin)) return refuse("bad_origin", request, url);

      return {
        ok: true,
        identity: {
          sub,
          sessionId: await sessionIdOf(sub, iat ?? exp),
          issuedAt: iat,
          expiresAt: exp,
        },
        request: new Request(request, { headers: strippedHeaders(request.headers) }),
        origin,
      };
    },
  };
}

/** How long one fetch of the team's certs may take. */
const CERTS_FETCH_TIMEOUT_MS = 5_000;

let cached: { readonly key: string; readonly ingress: Ingress } | undefined;

/**
 * The ingress for this isolate's configuration, created on first use and kept while the
 * configuration is unchanged, so that the key cache and the rate limiter persist.
 */
export function ingressFromEnv(env: IngressEnv): Ingress {
  const key = JSON.stringify([
    env.ACCESS_TEAM_DOMAIN,
    env.ACCESS_AUD,
    env.ALLOWED_HOSTNAMES,
    env.OWNER_EMAIL_HASH,
    env.ACCESS_CERTS_URL_LOCAL_ONLY,
  ]);
  if (cached?.key === key) return cached.ingress;
  const config = parseIngressEnv(env);
  const nowMs = () => Date.now();
  const ingress = createIngress(config, {
    keys: new JwksCache(
      config?.certsUrl ?? "",
      (url) => fetch(url, { signal: AbortSignal.timeout(CERTS_FETCH_TIMEOUT_MS) }),
      nowMs,
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ),
    limiter: new RateLimiter(nowMs),
    nowMs,
    log: (line) => console.log(JSON.stringify(line)),
  });
  cached = { key, ingress };
  return ingress;
}

/** Wraps the web Worker's handler: `next` runs only for a request ingress admitted. */
export function withIngress<E extends IngressEnv>(
  next: AdmittedHandler<E>,
): (request: Request, env: E, ctx: ExecutionContext) => Promise<Response> {
  return async (request, env, ctx) => {
    const result = await ingressFromEnv(env).admit(request);
    if (!result.ok) return result.response;
    return next(result, env, ctx);
  };
}
