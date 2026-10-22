// The Durable Objects' RPC surfaces. DOs call each other only through the methods declared here
// (code-structure plan, module rules). Owned by the integration lead: change it through a pull
// request to the lead, together with its fake in test/support/.

import type { BootstrapStatus, OutageRecord, Timestamp } from "@cfo/contracts";

// ---------------------------------------------------------------------------------------------
// OmnigentServer (WP2.2), in the platform Worker. The web Worker reaches it through a
// cross-script Durable Object binding (AR-17), so these calls are a versioned contract between
// two deployments released at different times (R-26, CF-03):
//   - every call carries `interfaceVersion`;
//   - changes are additive only, and the platform Worker ships an addition before the web
//     Worker uses it;
//   - unknown fields are tolerated; a version newer than the receiver knows is refused with
//     `unsupported_version`, so a release out of order fails visibly instead of half-working.

/** The interface version this source tree speaks. Raise it only when something is added. */
export const OMNIGENT_SERVER_INTERFACE_VERSION = 1;

/** The one OmnigentServer object: `env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME)`. */
export const OMNIGENT_SERVER_OBJECT_NAME = "omnigent-server";

/**
 * Forwarding: platform code passes a request to Omnigent with `stub.fetch(request)`, carrying
 * the interface version in this header. OmnigentServer reads it and removes every `x-cfo-`
 * header before the request reaches the server container. The request is the caller's to
 * prepare: the web Worker sends only what ingress admitted, with trust headers stripped.
 * The answer is Omnigent's, passed through once and never retried; a WebSocket upgrade is
 * answered with a bare 101 (R-24).
 */
export const FORWARD_VERSION_HEADER = "x-cfo-interface-version";

/** What every RPC call into OmnigentServer carries. */
export interface OmnigentServerCall {
  readonly interfaceVersion: number;
}

export interface OutagesQuery extends OmnigentServerCall {
  readonly from: Timestamp;
  readonly to: Timestamp;
}

/**
 * OmnigentServer, the always-on server's Durable Object. Browser traffic reaches it through
 * `fetch`, from the web Worker once ingress admitted the request (WP2.1); the computers' live
 * connection will reach it the same way from the platform Worker's `omnigent.internal` handler
 * (WP3.3). Other platform code, such as the cloud-computers page's outage notices (WP3.5), uses
 * these methods.
 */
export interface OmnigentServerRpc {
  /**
   * Outage records that overlap [from, to), oldest first, as `outageOverlaps` defines it. An
   * ongoing outage has `endedAt: null`.
   */
  outages(query: OutagesQuery): Promise<OutageRecord[]>;
  /**
   * The watchdog's latest bootstrap check (G1BR-002), or null before its first check.
   * `initialized` is true only when `/v1/info` showed the owner and the replicated position
   * covered a position read after that.
   */
  bootstrapStatus(call: OmnigentServerCall): Promise<BootstrapStatus | null>;
}
