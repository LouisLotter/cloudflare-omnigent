// The web Worker's public proxy to Omnigent: what happens to an admitted browser request before
// it takes the forwarding path. Pure: no Workers runtime import.
//
// Exact origins (design: "Browser origins (E4)", SEC-09). Omnigent's own origin check covers only
// its WebSocket handlers, so the forwarding path also refuses an unsafe method (anything but GET,
// HEAD and OPTIONS) or a WebSocket upgrade whose `Origin` is present and not this installation's
// exact origin, `null` and same-site siblings included. Ingress refuses the same requests first
// (WP2.1); this check keeps the forwarding path safe on its own.
//
// Everything else passes through unchanged in both directions, so Omnigent's own protections
// reach the browser as Omnigent sets them: attachments with `Content-Disposition: attachment` and
// `nosniff`, sandboxed previews, framing headers (RC-07's proxy part).

import type { Admitted } from "../ingress/index.ts";
import { forwardToServer, type ServerBinding } from "./forward.ts";
import { isSafeMethod, isUpgrade } from "./headers.ts";
import { errorResponse, logEvent } from "./responses.ts";

export interface ProxyEnv {
  readonly OMNIGENT: ServerBinding;
}

/** Whether `request` needs its `Origin` checked: a state change or a WebSocket upgrade. */
export function needsOriginCheck(request: Request): boolean {
  return !isSafeMethod(request.method) || isUpgrade(request);
}

/** True when the request's `Origin` is present and is not exactly `origin`. */
export function hasForeignOrigin(request: Request, origin: string): boolean {
  const presented = request.headers.get("origin");
  return presented !== null && presented !== origin;
}

export async function proxyToOmnigent(admitted: Admitted, env: ProxyEnv): Promise<Response> {
  const request = admitted.request;
  if (needsOriginCheck(request) && hasForeignOrigin(request, admitted.origin)) {
    logEvent("proxy", "refused", {
      reason: "foreign_origin",
      method: request.method,
      upgrade: isUpgrade(request),
      path: new URL(request.url).pathname,
    });
    return errorResponse(403, "forbidden", "Access denied.", false);
  }
  return forwardToServer(request, env.OMNIGENT);
}
