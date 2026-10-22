// Header rules shared by the forwarding path's two halves: the web Worker's forward.ts and the
// platform Worker's OmnigentServer. Pure: no Workers runtime import.

/**
 * Trust headers: headers that carry an identity, an authentication result or a platform-internal
 * fact. Nothing a client sends under these names may reach Omnigent, whose header auth mode
 * trusts `X-Forwarded-Email` (or the name in `OMNIGENT_AUTH_HEADER`, such as Access's own
 * `Cf-Access-Authenticated-User-Email`). Ingress (WP2.1) strips Access's headers first; this is
 * the forwarding path's own defence in depth.
 */
const TRUST_HEADER_PREFIXES = ["cf-access-", "x-cfo-", "x-auth-request-"] as const;

const TRUST_HEADER_NAMES: ReadonlySet<string> = new Set([
  "x-forwarded-email",
  "x-forwarded-user",
  "x-forwarded-preferred-username",
  "x-forwarded-groups",
  "x-forwarded-access-token",
  "remote-user",
  "x-remote-user",
  "x-user",
  "x-email",
]);

export function isTrustHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRUST_HEADER_NAMES.has(lower) ||
    TRUST_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/** Removes every trust header, in place, and returns the names removed (for tests and logs). */
export function stripTrustHeaders(headers: Headers): string[] {
  const removed = [...headers.keys()].filter(isTrustHeader);
  for (const name of removed) headers.delete(name);
  return removed;
}

/**
 * The headers of a 101 answered through the container egress or to a browser: at most the
 * subprotocol. The egress writes `Upgrade`, `Connection` and `Sec-WebSocket-Accept` itself and
 * appends the Response's own, and a second `Upgrade` makes Omnigent's host refuse the handshake
 * (spike S1, DC-34; the design's "Internal bridges").
 */
export function bareUpgradeHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  const protocol = upstream.get("sec-websocket-protocol");
  if (protocol) headers.set("sec-websocket-protocol", protocol);
  return headers;
}

/** True for a WebSocket upgrade request. */
export function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

/** Methods that change nothing, by the HTTP definition Omnigent follows. */
export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
