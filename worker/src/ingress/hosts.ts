// The hostname allowlist, and the identity headers and Access cookie that never reach Omnigent.

/** A DNS hostname: lowercase labels of letters, digits and inner hyphens, at least two labels. */
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The installation's hostnames from a comma-separated list, lowercased. Undefined if the list is
 * empty or any entry is not a plain hostname (no scheme, port, path, wildcard or trailing dot).
 */
export function parseHostnames(text: string | undefined): readonly string[] | undefined {
  const names = (text ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");
  if (names.length === 0 || !names.every((name) => HOSTNAME.test(name))) return undefined;
  return names;
}

/** Exact match of the request's hostname. `URL` has already lowercased it. */
export function isAllowedHost(url: URL, allowed: readonly string[]): boolean {
  return allowed.includes(url.hostname);
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

/**
 * The Cookie header without the `CF_Authorization` cookie, and only that cookie; undefined when
 * nothing else is left. Pairs are split on `;`, and also on `,` where a new `name=` pair starts,
 * in case a client or proxy joined several Cookie headers with commas.
 */
export function withoutAccessCookie(cookie: string): string | undefined {
  const pairs = cookie
    .split(/;|,(?=\s*[^\s=;,]+=)/)
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "");
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf("=");
    const name = (eq === -1 ? pair : pair.slice(0, eq)).trim();
    return !ACCESS_COOKIE.test(name);
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
