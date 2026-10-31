// The browser-origin check at the entrance (SEC-09, RC-07): defence in depth beside Omnigent's
// own `OMNIGENT_WS_ALLOWED_ORIGINS` and the platform pages' stricter checks.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The `Origin` Omnigent's own non-browser clients announce themselves with (Omnigent's
 * `OMNIGENT_INTERNAL_WS_ORIGIN`): its host's tunnel, its runners' tunnels and REST calls, and
 * its Python SDK, which a personal machine connected as a host sends through Access (WP3.43).
 * Browsers never send it: `Origin` is a header page scripts cannot set, and a browser writes
 * its document's own origin, which for a non-special scheme such as `omnigent:` is `null`. So it
 * proves nothing about the caller, who must still pass Access as the owner; it only says the
 * request is not a browser's cross-site request. Omnigent's own origin policy admits it too.
 */
export const OMNIGENT_INTERNAL_ORIGIN = "omnigent://internal";

/**
 * Whether a request may proceed by its `Origin`. An unsafe method (anything but GET, HEAD and
 * OPTIONS) or a WebSocket upgrade whose `Origin` is present must carry exactly `origin`, or
 * exactly Omnigent's own non-browser marker (`OMNIGENT_INTERNAL_ORIGIN`): `null`, a foreign
 * origin and a same-site sibling are refused. A request without `Origin` passes, as non-browser
 * clients may send none; the platform pages refuse that case, and the marker, themselves.
 * The safe-method exemption assumes a GET changes nothing. One Omnigent route does:
 * `GET /auth/magic/redeem` consumes a one-time sign-in token and sets a session cookie
 * (docs/architecture.md, "Access and authority"). It needs a valid magic token.
 */
export function originAllowed(request: Request, origin: string): boolean {
  const sent = request.headers.get("origin");
  if (sent === null) return true;
  const unsafe = !SAFE_METHODS.has(request.method.toUpperCase());
  const upgrade = request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";
  if (!unsafe && !upgrade) return true;
  return sent === origin || sent === OMNIGENT_INTERNAL_ORIGIN;
}
