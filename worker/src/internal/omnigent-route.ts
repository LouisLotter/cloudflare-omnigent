// `omnigent.internal`: a cloud computer's live connection to the Omnigent server (A′, D18), and
// the policy point for everything a computer sends to Omnigent. Pure: no Workers runtime import.
// The entrypoint that runs it is `OmnigentRoute` in `internal/entrypoints.ts`.
//
// Every request from a computer passes, in this order, before the server is contacted:
//   1. the intercept's trusted props: a version this code knows, the computer and generation;
//   2. the block list (design, "The computer's authority in Omnigent"; R-28), matched on a
//      canonical form of the path, with and without Omnigent's configured base path, with method
//      overrides refused everywhere and upgrades refused on blocked paths;
//   3. per-computer request limits, kept apart for upgrades (reconnect storms) and HTTP;
//   4. the computer's current identity, read from its WorkspaceDO for every request (no cache:
//      the generation fence is authoritative, Codex WP3.3 r1-2): a request from another
//      generation is refused (`stale_generation`), and a host tunnel only for the host ID
//      Omnigent bound to this computer at its first `start_host` (RC-23, FH-25).
// Then the request goes to the server's Durable Object with the trust headers stripped, the
// interface version set and `redirect: "manual"`, once, never retried. The server's 101 goes
// back unaccepted (`upgrade-answer.ts`). Requests are logged by method, path (no query string)
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
import { isSafeMethod, isUpgrade, stripTrustHeaders } from "../server/headers.ts";
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

/**
 * Omnigent's base path (`OMNIGENT_WEB_BASE_PATH`), normalized as Omnigent's
 * `_normalize_base_path` does: "" for none, else a leading slash and no trailing one. Null when
 * Omnigent would refuse it (then the server does not start; the route refuses everything).
 */
/** First segments Omnigent refuses for a base path (`_WEB_UI_API_FALLBACK_PREFIXES` and
 * `_WEB_UI_ROUTE_PREFIXES`, fork `184b5cf8b`), compared case-sensitively as Omnigent does. */
const RESERVED_BASE_SEGMENTS: ReadonlySet<string> = new Set([
  "api",
  "assets",
  "auth",
  "docs",
  "health",
  "oauth",
  "openapi.json",
  "redoc",
  "v1",
  ".well-known",
  "approve",
  "c",
  "canvas",
  "extensions",
  "inbox",
  "login",
  "members",
  "policies",
  "register",
  "settings",
  "tasks",
  "usage",
]);

export function normalizeBasePath(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (leading.startsWith("//")) return null;
  const path = leading.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9\-._~/]+$/.test(path)) return null;
  const segments = path.split("/");
  if (segments.includes(".") || segments.includes("..")) return null;
  if (RESERVED_BASE_SEGMENTS.has(segments[1] ?? "")) return null;
  return path;
}

/**
 * The path Omnigent routes: ASGI's path (percent-decoded once), with a configured base path
 * removed when the decoded path starts with it literally and case-sensitively, as Omnigent's
 * `BasePathMiddleware` does; otherwise routed as it is.
 */
export function serverRoutedPath(rawPath: string, basePath: string): string {
  const decoded = percentDecodeOnce(rawPath);
  if (basePath === "") return decoded;
  if (decoded === basePath) return "/";
  return decoded.startsWith(`${basePath}/`) ? decoded.slice(basePath.length) : decoded;
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
  const upgrade = headers.get("upgrade") !== null;
  if (METHOD_OVERRIDE_HEADERS.some((name) => headers.has(name))) {
    return { allowed: false, reason: "method_override" };
  }
  for (const key of url.searchParams.keys()) {
    if (canonicalPath(key).path.replace(/^\//, "") === METHOD_OVERRIDE_QUERY_KEY) {
      return { allowed: false, reason: "method_override" };
    }
  }
  // Every rule applies to both forms: the request's own canonical path, and the canonical form of
  // the path Omnigent will route once its base path is removed (Codex WP3.3 r2-1). A request is
  // refused if either form is blocked, and a host tunnel in either form is bound.
  const forms = [
    canonicalPath(url.pathname),
    canonicalPath(serverRoutedPath(url.pathname, basePath)),
  ];
  if (forms.some((form) => form.undecodable)) return { allowed: false, reason: "undecodable_path" };
  let hostTunnel: string | null = null;
  for (const form of forms) {
    const path = form.path;
    const managed = MANAGED_PREFIXES.some((prefix) => underPrefix(path, prefix));
    if (managed && form.decodedDelimiter) return { allowed: false, reason: "encoded_delimiter" };
    for (const { name, rule } of BLOCK_LIST) {
      // A blocked path allows only GET and HEAD, and never an upgrade (the 19 Oct rule).
      if (ruleMatches(rule, path) && (upgrade || methodBlocked(rule.methods, upper))) {
        return { allowed: false, reason: name };
      }
    }
    const tunnel = HOST_TUNNEL.exec(path);
    if (tunnel) {
      const hostId = normalizeHostId(tunnel[1] as string);
      if (hostId === null) return { allowed: false, reason: "host_id_malformed" };
      if (hostTunnel !== null && hostTunnel !== hostId) {
        return { allowed: false, reason: "host_id_ambiguous" };
      }
      hostTunnel = hostId;
    }
  }
  return { allowed: true, hostTunnel };
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

// ---------------------------------------------------------------------------------------------
// The handler

/** HTTP requests per computer: generous, so a busy computer's runners are never slowed. */
export const ROUTE_HTTP_LIMITS: LimitOptions = { burst: 1_000, perSecond: 100, maxClients: 1_024 };
/** WebSocket upgrades per computer: bounds a reconnect storm. */
export const ROUTE_UPGRADE_LIMITS: LimitOptions = { burst: 60, perSecond: 2, maxClients: 1_024 };

export interface RouteDeps {
  /**
   * The computer's current identity, read from its WorkspaceDO for this request. Read-only, so a
   * failed read is repeated once before the request is refused.
   */
  readIdentity(computerId: ComputerId): Promise<ComputerIdentity>;
  readonly httpLimiter: RateLimiter;
  readonly upgradeLimiter: RateLimiter;
  /** One call into OmnigentServer's `fetch`. */
  forward(request: Request): Promise<Response>;
  /** What happens to the server's 101 (`upgrade-answer.ts`). */
  answerUpgrade(response: Response): Response;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
  /** Omnigent's base path, normalized (`normalizeBasePath`); null refuses every request. */
  readonly basePath?: string | null;
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

  if (deps.basePath === null) {
    return done(refuse(503, "unavailable", "This route is not available.", false), {
      ...who,
      refused: "base_path",
    });
  }
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
    identity = await deps.readIdentity(computerId).catch(() => deps.readIdentity(computerId));
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
    // The call into the server's object failed, and is never repeated here: it may have arrived.
    // As the web Worker's forward.ts: a request that changes nothing may be repeated; a change
    // may have been applied, so it is reported as lost, not as retryable (Codex WP3.3 r1-3).
    return done(
      isSafeMethod(request.method)
        ? refuse(503, "unavailable", "The server did not answer. Try again shortly.", true, {
            "retry-after": "1",
          })
        : refuse(
            502,
            "unavailable",
            "The answer from the server was lost. Check the current state before repeating the change.",
            false,
          ),
      { ...who, refused: "forward_failed" },
    );
  }
  if (response.webSocket) return done(deps.answerUpgrade(response), who);
  return done(response, who);
}
