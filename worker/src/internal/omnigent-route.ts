// `omnigent.internal`: a cloud computer's live connection to the Omnigent server (A′, D18), and
// the policy point for everything a computer sends to Omnigent. Pure: no Workers runtime import.
// The entrypoint that runs it is `OmnigentRoute` in `internal/entrypoints.ts`.
//
// Every request from a computer passes, in this order, before the server is contacted:
//   1. the intercept's trusted props: a version this code knows, the computer and generation;
//   2. the computer's current identity from its WorkspaceDO: a request from an older generation
//      is refused (`stale_generation`), and a host tunnel only for the host ID Omnigent bound to
//      this computer at its first `start_host` (RC-23, FH-25);
//   3. per-computer request limits, kept apart for upgrades (reconnect storms) and HTTP;
//   4. the block list (design, "The computer's authority in Omnigent"; R-28), matched on a
//      canonical form of the path, with method overrides refused everywhere.
// Then the request goes to the server's Durable Object with the trust headers stripped, the
// interface version set and `redirect: "manual"`, once, never retried. The server's 101 comes
// back through `closeOnEnd`, which makes every end of the server's side reach the computer as a
// close frame (WP2.2's design change 7). Requests are logged by method, path (no query string)
// and status; bodies are never read.

import {
  type ComputerId,
  type Generation,
  HostId,
  InterceptProps,
  LaunchToken,
  SUPPORTED_INTERCEPT_PROPS_VERSIONS,
} from "@cfo/contracts";
import type { LimitOptions, RateLimiter } from "../ingress/limits.ts";
import { isUpgrade, stripTrustHeaders } from "../server/headers.ts";
import { errorResponse } from "../server/responses.ts";
import { FORWARD_VERSION_HEADER, OMNIGENT_SERVER_INTERFACE_VERSION } from "../shared/rpc.ts";

/** The header a managed host sends its launch token in (Omnigent's `MANAGED_HOST_TOKEN_HEADER`). */
export const LAUNCH_TOKEN_HEADER = "x-omnigent-host-token";

/** Headers and the query key that would let a request claim another method. Refused everywhere. */
const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"];
const METHOD_OVERRIDE_QUERY_KEY = "_method";

// ---------------------------------------------------------------------------------------------
// Canonical paths

/** Percent-decoding rounds before a path counts as hostile. */
const MAX_DECODE_ROUNDS = 4;

/** Decodes every valid `%XX`, as UTF-8 where it can; an invalid sequence stays literal. */
function percentDecodeOnce(text: string): string {
  if (!text.includes("%")) return text;
  const bytes: number[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    if (c === 0x25 && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      const char = String.fromCodePoint(text.codePointAt(i) as number);
      for (const b of new TextEncoder().encode(char)) bytes.push(b);
      i += char.length;
    }
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(new Uint8Array(bytes));
}

export interface CanonicalPath {
  /** The path as matched: decoded, normalized, lowercased. */
  readonly path: string;
  /** The fully decoded path held `#` or `?`, which a canonical match drops. */
  readonly decodedDelimiter: boolean;
  /** Decoding had not settled after MAX_DECODE_ROUNDS rounds. */
  readonly undecodable: boolean;
}

/**
 * The form a path is matched in, used only for matching (the request is forwarded unchanged): the
 * path repeatedly percent-decoded, backslashes as slashes, control characters removed, matrix
 * parameters and trailing dots and spaces dropped from each segment, slashes collapsed, dot
 * segments resolved, lowercase (the 19 Oct design's rules, kept by the current design). It is
 * at least as broad as what Omnigent's router sees (one decoding, case-sensitive), so a path
 * Omnigent would route to a blocked endpoint always matches here too.
 */
export function canonicalPath(rawPath: string): CanonicalPath {
  let decoded = rawPath;
  let undecodable = true;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = percentDecodeOnce(decoded);
    if (next === decoded) {
      undecodable = false;
      break;
    }
    decoded = next;
  }
  const decodedDelimiter = decoded.includes("#") || decoded.includes("?");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed
  const cleaned = decoded.replace(/\\/g, "/").replace(/[\u0000-\u001f\u007f]/g, "");
  const out: string[] = [];
  for (const raw of cleaned.split("/")) {
    // Matrix parameters dropped: "setup;x" matches "setup".
    const segment = raw.split(";")[0] ?? "";
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    // Trailing dots and spaces dropped: "setup." and "setup " match "setup".
    const trimmed = segment.replace(/[. ]+$/, "");
    if (trimmed === "") continue;
    out.push(trimmed.toLowerCase());
  }
  return { path: `/${out.join("/")}`, decodedDelimiter, undecodable };
}

// ---------------------------------------------------------------------------------------------
// The block list (design, "The computer's authority in Omnigent"; R-28, D21)

type Rule =
  | {
      readonly kind: "exact";
      readonly path: string;
      readonly methods: "unsafe" | readonly string[];
    }
  | {
      readonly kind: "prefix";
      readonly path: string;
      readonly methods: "unsafe" | readonly string[];
    }
  | {
      readonly kind: "pattern";
      readonly re: RegExp;
      readonly methods: "unsafe" | readonly string[];
    };

/**
 * Blocked paths. `methods: "unsafe"` refuses every method but GET and HEAD; a list refuses only
 * those methods (the design names the methods for sharing changes).
 */
const BLOCK_LIST: readonly { readonly name: string; readonly rule: Rule }[] = [
  // Account administration.
  { name: "account", rule: { kind: "exact", path: "/auth/invite", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/auth/register", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/auth/magic", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/auth/magic/redeem", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/auth/setup", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/auth/users", methods: "unsafe" } },
  { name: "account", rule: { kind: "prefix", path: "/auth/users/", methods: "unsafe" } },
  { name: "account", rule: { kind: "exact", path: "/oauth", methods: "unsafe" } },
  { name: "account", rule: { kind: "prefix", path: "/oauth/", methods: "unsafe" } },
  // Sharing changes.
  { name: "sharing", rule: { kind: "exact", path: "/v1/sharing", methods: ["PUT"] } },
  {
    name: "sharing",
    rule: {
      kind: "pattern",
      // `permissions*`: the segment and anything after it.
      re: /^\/v1\/sessions\/[^/]+\/permissions/,
      methods: ["POST", "DELETE"],
    },
  },
  // The dedicated approval route.
  {
    name: "approval",
    rule: {
      kind: "pattern",
      re: /^\/v1\/sessions\/[^/]+\/elicitations\/[^/]+\/resolve$/,
      methods: "unsafe",
    },
  },
];

/** Prefixes on which a decoded `#` or `?` in the path is refused. */
const MANAGED_PREFIXES = ["/auth", "/oauth", "/v1/sharing", "/v1/sessions", "/v1/hosts"];

const SAFE_METHODS = new Set(["GET", "HEAD"]);

function methodBlocked(methods: "unsafe" | readonly string[], method: string): boolean {
  return methods === "unsafe" ? !SAFE_METHODS.has(method) : methods.includes(method);
}

function ruleMatches(rule: Rule, path: string): boolean {
  switch (rule.kind) {
    case "exact":
      return path === rule.path;
    case "prefix":
      return path.startsWith(rule.path);
    case "pattern":
      return rule.re.test(path);
  }
}

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Removes a configured base path (Omnigent's `BasePathMiddleware`), if the path carries it. */
function withoutBasePath(path: string, basePath: string): string {
  if (basePath === "" || basePath === "/") return path;
  const base = canonicalPath(basePath).path;
  if (path === base) return "/";
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path;
}

export type PolicyDecision =
  | { readonly allowed: true; readonly hostTunnel: string | null }
  | { readonly allowed: false; readonly reason: string };

/**
 * Omnigent's normalization of a host ID (`omnigent.util.uuid.uuid_to_bytes`): dashes removed, a
 * known legacy prefix dropped, 32 hex digits. Lowercase here; Omnigent's hex parse is
 * case-insensitive, and its prefix match case-sensitive, so this accepts more than Omnigent does,
 * never less. Null when Omnigent would refuse it too.
 */
const LEGACY_ID_PREFIXES = new Set([
  "ag",
  "conv",
  "host",
  "pol",
  "file",
  "cmt",
  "msg",
  "fc",
  "fco",
  "err",
  "rs",
  "cmp",
  "nt",
  "rse",
  "sc",
  "tc",
  "rd",
  "agy_conv",
]);

export function normalizeHostId(segment: string): string | null {
  let value = segment.toLowerCase().replaceAll("-", "");
  const underscore = value.lastIndexOf("_");
  if (underscore >= 0) {
    const prefix = value.slice(0, underscore);
    const tail = value.slice(underscore + 1);
    if (LEGACY_ID_PREFIXES.has(prefix) && tail.length === 32) value = tail;
  }
  return /^[0-9a-f]{32}$/.test(value) ? value : null;
}

const HOST_TUNNEL = /^\/v1\/hosts\/([^/]+)\/tunnel(?:\/|$)/;

/**
 * The block list's decision for a request. Bodies are never read. A host tunnel's host ID, if
 * the request is one, is returned for the identity binding.
 */
export function policyDecision(
  method: string,
  url: URL,
  headers: Headers,
  basePath = "",
): PolicyDecision {
  const upper = method.toUpperCase();
  if (METHOD_OVERRIDE_HEADERS.some((name) => headers.has(name))) {
    return { allowed: false, reason: "method_override" };
  }
  for (const key of url.searchParams.keys()) {
    if (canonicalPath(key).path.replace(/^\//, "") === METHOD_OVERRIDE_QUERY_KEY) {
      return { allowed: false, reason: "method_override" };
    }
  }
  const canonical = canonicalPath(url.pathname);
  if (canonical.undecodable) return { allowed: false, reason: "undecodable_path" };
  const path = withoutBasePath(canonical.path, basePath);
  const managed = MANAGED_PREFIXES.some((prefix) => underPrefix(path, prefix));
  if (managed && canonical.decodedDelimiter) return { allowed: false, reason: "encoded_delimiter" };
  for (const { name, rule } of BLOCK_LIST) {
    if (ruleMatches(rule, path) && methodBlocked(rule.methods, upper)) {
      return { allowed: false, reason: name };
    }
  }
  const tunnel = HOST_TUNNEL.exec(path);
  if (tunnel) {
    const hostId = normalizeHostId(tunnel[1] as string);
    if (hostId === null) return { allowed: false, reason: "host_id_malformed" };
    return { allowed: true, hostTunnel: hostId };
  }
  return { allowed: true, hostTunnel: null };
}

/**
 * A host tunnel's credentials, as the route requires them on top of Omnigent's own checks
 * (core change 16): exactly one launch token, of the launch token's form, and no other credential
 * beside it. Two `X-Omnigent-Host-Token` headers arrive joined by ", ", which is not a token.
 */
export function hostTunnelCredentials(headers: Headers): "ok" | "no_launch_token" | "conflicting" {
  const token = headers.get(LAUNCH_TOKEN_HEADER);
  if (token === null || token.trim() === "") return "no_launch_token";
  if (!LaunchToken.safeParse(token.trim()).success) return "conflicting";
  if (headers.has("authorization") || headers.has("cookie")) return "conflicting";
  return "ok";
}

// ---------------------------------------------------------------------------------------------
// The computer's identity

export interface ComputerIdentity {
  readonly generation: Generation;
  /** The host ID Omnigent named at the computer's first accepted `start_host`, if any. */
  readonly hostId: string | null;
}

/**
 * The computer's current identity from its WorkspaceDO, cached per isolate for a few seconds so
 * that ordinary HTTP calls do not each cost a Durable Object call. A host tunnel always reads it
 * fresh. A failed read is retried at the next request, never cached.
 */
export class IdentityCache {
  readonly #entries = new Map<string, { identity: ComputerIdentity; at: number }>();
  readonly #clock: () => number;
  readonly #ttlMs: number;

  constructor(clock: () => number, ttlMs = 5_000) {
    this.#clock = clock;
    this.#ttlMs = ttlMs;
  }

  /**
   * The identity, read with `read`: fresh when `fresh` is set or when the props name a newer
   * generation than the cached one (the computer started again since).
   */
  async get(
    computerId: ComputerId,
    propsGeneration: number,
    fresh: boolean,
    read: (computerId: ComputerId) => Promise<ComputerIdentity>,
  ): Promise<ComputerIdentity> {
    const now = this.#clock();
    const cached = this.#entries.get(computerId);
    if (
      !fresh &&
      cached !== undefined &&
      now - cached.at < this.#ttlMs &&
      propsGeneration <= cached.identity.generation
    ) {
      return cached.identity;
    }
    const identity = await read(computerId);
    this.#entries.set(computerId, { identity, at: now });
    if (this.#entries.size > 256) {
      const oldest = this.#entries.keys().next().value as string;
      this.#entries.delete(oldest);
    }
    return identity;
  }
}

// ---------------------------------------------------------------------------------------------
// The handler

/** HTTP requests per computer: generous, so a busy computer's runners are never slowed. */
export const ROUTE_HTTP_LIMITS: LimitOptions = { burst: 1_000, perSecond: 100, maxClients: 1_024 };
/** WebSocket upgrades per computer: bounds a reconnect storm. */
export const ROUTE_UPGRADE_LIMITS: LimitOptions = { burst: 60, perSecond: 2, maxClients: 1_024 };

export interface RouteDeps {
  readonly identities: IdentityCache;
  /** The computer's current identity, from its WorkspaceDO. */
  readIdentity(computerId: ComputerId): Promise<ComputerIdentity>;
  readonly httpLimiter: RateLimiter;
  readonly upgradeLimiter: RateLimiter;
  /** One call into OmnigentServer's `fetch`. */
  forward(request: Request): Promise<Response>;
  /** What happens to the server's 101: see `closeOnEnd`. */
  answerUpgrade(response: Response): Response;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
  readonly basePath?: string;
}

function refuse(
  status: number,
  code: "forbidden" | "stale_generation" | "unavailable",
  message: string,
  retryable: boolean,
  headers: Record<string, string> = {},
): Response {
  return errorResponse(status, code, message, retryable, headers);
}

/** Handles one request from a computer. Never throws. */
export async function handleComputerRequest(
  request: Request,
  rawProps: unknown,
  deps: RouteDeps,
): Promise<Response> {
  const started = Date.now();
  const url = new URL(request.url);
  const upgrade = isUpgrade(request);
  const base = { method: request.method, path: url.pathname.slice(0, 200), upgrade };
  const done = (response: Response, fields: Record<string, unknown> = {}) => {
    deps.log("request", { ...base, status: response.status, ms: Date.now() - started, ...fields });
    return response;
  };

  const props = InterceptProps.safeParse(rawProps);
  if (
    !props.success ||
    !(SUPPORTED_INTERCEPT_PROPS_VERSIONS as readonly number[]).includes(props.data.propsVersion)
  ) {
    return done(refuse(503, "unavailable", "This route is not available.", true), {
      refused: "props",
    });
  }
  const { computerId, generation } = props.data;
  const who = { computerId, generation };

  const decision = policyDecision(request.method, url, request.headers, deps.basePath ?? "");
  if (!decision.allowed) {
    return done(refuse(403, "forbidden", "Not allowed from a cloud computer.", false), {
      ...who,
      refused: decision.reason,
    });
  }

  const limiter = upgrade ? deps.upgradeLimiter : deps.httpLimiter;
  const limit = limiter.take(computerId);
  if (!limit.allowed) {
    return done(
      refuse(429, "unavailable", "Too many requests from this computer.", true, {
        "retry-after": String(limit.retryAfterSeconds),
      }),
      { ...who, refused: "rate_limit" },
    );
  }

  let identity: ComputerIdentity;
  try {
    identity = await deps.identities.get(
      computerId,
      generation,
      decision.hostTunnel !== null,
      (id) => deps.readIdentity(id),
    );
  } catch {
    return done(refuse(503, "unavailable", "The computer's state cannot be read now.", true), {
      ...who,
      refused: "identity_unavailable",
    });
  }
  if (generation !== identity.generation) {
    return done(
      refuse(409, "stale_generation", "This computer's generation is not current.", false),
      { ...who, refused: "stale_generation", current: identity.generation },
    );
  }

  if (decision.hostTunnel !== null) {
    const bound = identity.hostId === null ? null : HostId.safeParse(identity.hostId);
    const propsHost = props.data.hostId;
    if (
      bound === null ||
      !bound.success ||
      decision.hostTunnel !== bound.data ||
      (propsHost !== null && propsHost !== bound.data)
    ) {
      return done(refuse(403, "forbidden", "Not this computer's host.", false), {
        ...who,
        refused: "host_identity",
      });
    }
    const credentials = hostTunnelCredentials(request.headers);
    if (credentials !== "ok") {
      return done(refuse(403, "forbidden", "Not this computer's host.", false), {
        ...who,
        refused: `host_${credentials}`,
      });
    }
  }

  const headers = new Headers(request.headers);
  stripTrustHeaders(headers);
  headers.set(FORWARD_VERSION_HEADER, String(OMNIGENT_SERVER_INTERFACE_VERSION));
  let response: Response;
  try {
    response = await deps.forward(new Request(request, { headers, redirect: "manual" }));
  } catch {
    // The call into the server's object failed: never repeated here, since it may have arrived.
    return done(refuse(502, "unavailable", "The server did not answer.", true), {
      ...who,
      refused: "forward_failed",
    });
  }
  if (response.webSocket) return done(deps.answerUpgrade(response), who);
  return done(response, who);
}
