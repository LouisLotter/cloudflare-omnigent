// The browser-origin check at the entrance (SEC-09, RC-07): defence in depth beside Omnigent's
// own `OMNIGENT_WS_ALLOWED_ORIGINS` and the platform pages' stricter checks.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Whether a request may proceed by its `Origin`. An unsafe method (anything but GET, HEAD and
 * OPTIONS) or a WebSocket upgrade whose `Origin` is present must carry exactly `origin`:
 * `null`, a foreign origin and a same-site sibling are refused. A request without `Origin`
 * passes, as non-browser clients send none; the platform pages refuse that case themselves.
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
  return sent === origin;
}
