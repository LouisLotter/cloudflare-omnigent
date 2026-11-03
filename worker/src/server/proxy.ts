// The web Worker's public proxy to Omnigent: what happens to an admitted browser request before
// it takes the forwarding path. Pure: no Workers runtime import.
//
// Exact origins (design: "Browser origins (E4)", SEC-09). Omnigent's own origin check covers only
// its WebSocket handlers, so the forwarding path also refuses an unsafe method (anything but GET,
// HEAD and OPTIONS) or a WebSocket upgrade whose `Origin` is present and not this installation's
// exact origin, `null` and same-site siblings included. Omnigent's own non-browser marker,
// `omnigent://internal`, which no web page can send, is admitted like no `Origin` at all: a
// personal machine's host, its runners and Omnigent's CLI send it (WP3.43). Ingress refuses the
// same requests first (WP2.1); this check keeps the forwarding path safe on its own.
//
// Everything else passes through unchanged in both directions, so Omnigent's own protections
// reach the browser as Omnigent sets them: attachments with `Content-Disposition: attachment` and
// `nosniff`, sandboxed previews, framing headers (RC-07's proxy part).

import type { ForwardedPerson } from "@cfo/contracts";
import type { Admitted, OwnerIdentity } from "../ingress/index.ts";
import { OMNIGENT_INTERNAL_ORIGIN } from "../ingress/origin.ts";
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

/**
 * True when the request's `Origin` is present and is neither exactly `origin` nor Omnigent's own
 * non-browser marker (`OMNIGENT_INTERNAL_ORIGIN`).
 */
export function hasForeignOrigin(request: Request, origin: string): boolean {
  const presented = request.headers.get("origin");
  return presented !== null && presented !== origin && presented !== OMNIGENT_INTERNAL_ORIGIN;
}

/** The person to forward for an admitted identity; undefined for one built without its claims. */
export function forwardedPersonOf(identity: OwnerIdentity): ForwardedPerson | undefined {
  if (identity.issuer === undefined || identity.audience === undefined) return undefined;
  return {
    issuer: identity.issuer,
    subject: identity.sub,
    audience: identity.audience,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    installationOwner: identity.pin !== false,
    expiresAt: identity.expiresAt,
  };
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
  return forwardToServer(request, env.OMNIGENT, forwardedPersonOf(admitted.identity));
}
