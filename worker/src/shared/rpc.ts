// The Durable Objects' RPC surfaces. DOs call each other only through the methods declared here
// (code-structure plan, module rules). Owned by the integration lead: change it through a pull
// request to the lead, together with its fake in test/support/.

import type { OutageRecord, Timestamp } from "@cfo/contracts";

/**
 * OmnigentServer (WP2.2), the always-on server's Durable Object. Browser traffic reaches it
 * through `fetch`, from ingress once the Access check has passed (WP2.1). Other platform code,
 * such as the cloud-computers page's outage notices (WP3.5), uses these methods.
 */
export interface OmnigentServerRpc {
  /**
   * Outage records that overlap [from, to), oldest first, as `outageOverlaps` defines it. An
   * ongoing outage has `endedAt: null`.
   */
  outages(from: Timestamp, to: Timestamp): Promise<OutageRecord[]>;
}
