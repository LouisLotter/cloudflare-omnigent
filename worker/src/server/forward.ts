// The web Worker's one path to the Omnigent server (code-structure plan): through the OMNIGENT
// cross-script binding into the platform Worker's OmnigentServer. Pure: no Workers runtime import.
//
//   - Trust headers are stripped here, whatever ingress already removed.
//   - The call carries the interface version (R-26).
//   - The answer is passed through once and never retried, a 424 `durability_unconfirmed`
//     included: Omnigent applied that change, and repeating it blindly could apply it twice.
//     When the call itself fails, an unsafe request is reported as lost, not as retryable.

import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../shared/rpc.ts";
import { isSafeMethod, stripTrustHeaders } from "./headers.ts";
import { describeError, errorResponse, logEvent } from "./responses.ts";

/** The part of a Durable Object namespace the forwarding path uses. */
export interface ServerBinding {
  getByName(name: string): { fetch(request: Request): Promise<Response> };
}

export async function forwardToServer(request: Request, binding: ServerBinding): Promise<Response> {
  const headers = new Headers(request.headers);
  stripTrustHeaders(headers);
  headers.set(FORWARD_VERSION_HEADER, String(OMNIGENT_SERVER_INTERFACE_VERSION));
  const forwarded = new Request(request, { headers, redirect: "manual" });
  try {
    return await binding.getByName(OMNIGENT_SERVER_OBJECT_NAME).fetch(forwarded);
  } catch (error) {
    const path = new URL(request.url).pathname;
    logEvent("forward", "binding_error", {
      method: request.method,
      path,
      error: describeError(error),
    });
    return isSafeMethod(request.method)
      ? errorResponse(503, "unavailable", "Omnigent is not answering. Try again shortly.", true, {
          "retry-after": "5",
        })
      : errorResponse(
          502,
          "unavailable",
          "The answer from Omnigent was lost. Check the current state before repeating the change.",
          false,
        );
  }
}
