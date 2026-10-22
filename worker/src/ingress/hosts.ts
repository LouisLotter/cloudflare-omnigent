// The hostname allowlist, and the identity headers and Access cookie that never reach Omnigent.

/** A DNS hostname: lowercase labels of letters, digits and inner hyphens, at least two labels. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Hostnames of local end-to-end runs, which `wrangler dev` serves over plain HTTP on a port. */
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

/**
 * The installation's hostnames from a comma-separated list, lowercased. Undefined if the list is
 * empty or any entry is not a plain hostname (no scheme, port, path, wildcard or trailing dot).
 * `localhost` and `127.0.0.1` are accepted for local runs.
 */
export function parseHostnames(text: string | undefined): readonly string[] | undefined {
  const names = (text ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  const valid = (name: string) => HOSTNAME.test(name) || LOOPBACK.has(name);
  if (names.length === 0 || !names.every(valid)) return undefined;
  return names;
}

/**
 * Whether the request is for one of the installation's own origins: an allowed hostname, matched
 * exactly (`URL` has already lowercased it), over HTTPS on the default port, so that the exact
 * origin is `https://<hostname>`. A loopback hostname, if configured, may use HTTP and a port.
 */
export function isAllowedHost(url: URL, allowed: readonly string[]): boolean {
  if (!allowed.includes(url.hostname)) return false;
  if (LOOPBACK.has(url.hostname)) return url.protocol === "http:" || url.protocol === "https:";
  return url.protocol === "https:" && url.port === "";
}

/**
 * Identity headers removed from every request before it goes further. The Worker has decided who
 * the caller is; Omnigent runs in accounts mode, but must never see a header that its header mode
 * or another proxy convention would trust. Every `cf-access-*` header goes too.
 */
export const IDENTITY_HEADERS: readonly string[] = [
  "x-forwarded-email",
  "x-forwarded-user",
  "x-forwarded-preferred-username",
  "x-forwarded-groups",
  "x-auth-request-email",
  "x-auth-request-user",
  "x-auth-request-preferred-username",
  "x-auth-request-groups",
  "x-auth-request-access-token",
  "x-goog-authenticated-user-email",
  "x-goog-authenticated-user-id",
  "x-goog-iap-jwt-assertion",
  "x-ms-client-principal",
  "x-ms-client-principal-id",
  "x-ms-client-principal-name",
  "x-amzn-oidc-data",
  "x-amzn-oidc-identity",
  "x-amzn-oidc-accesstoken",
  "remote-user",
  "x-remote-user",
];

const ACCESS_HEADER_PREFIX = "cf-access-";
/** The Access cookie's name, matched case-insensitively. */
const ACCESS_COOKIE = /^cf_authorization$/i;
const ACCESS_COOKIE_INSIDE = /,\s*cf_authorization\s*=/i;

/**
 * The Cookie header without the `CF_Authorization` cookie, and only that cookie; undefined when
 * nothing else is left. Pairs are split on `;`, and also on `,` where a new `name=` pair starts
 * (whitespace allowed around the name), in case a client or proxy joined several Cookie headers
 * with commas.
 */
export function withoutAccessCookie(cookie: string): string | undefined {
  const pairs = cookie
    .split(/;|,(?=\s*[^\s=;,]+\s*=)/)
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "");
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    // The second test is a backstop: a pair that still holds a comma-joined Access cookie, in a
    // spelling the split did not foresee, is dropped whole.
    return !ACCESS_COOKIE.test(name) && !ACCESS_COOKIE_INSIDE.test(pair);
  });
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/** A copy of `incoming` without identity headers, `cf-access-*` headers and the Access cookie. */
export function strippedHeaders(incoming: Headers): Headers {
  const out = new Headers(incoming);
  const names = new Set<string>();
  for (const [name] of out) names.add(name);
  for (const name of names) {
    if (name.startsWith(ACCESS_HEADER_PREFIX) || IDENTITY_HEADERS.includes(name)) {
      out.delete(name);
    }
  }
  const cookie = out.get("cookie");
  if (cookie !== null) {
    const kept = withoutAccessCookie(cookie);
    if (kept === undefined) out.delete("cookie");
    else out.set("cookie", kept);
  }
  return out;
}
