// The web Worker (AR-17): the public hostname. Every request passes ingress (WP2.1) first; only
// an admitted one is routed. It holds no Durable Object class and no live connection, and reaches
// the platform Worker's objects only through cross-script bindings, so its deploys never drop a
// computer's connection. A browser stream through it can drop after one of its deploys and
// reconnects (FH-38, R-25).

import type { WebEnv } from "./env.ts";
import { type Admitted, withIngress } from "./ingress/index.ts";
import { proxyToOmnigent } from "./server/proxy.ts";

/**
 * Routes an admitted request. The platform pages (WP3.5) will add their paths here; everything
 * else is Omnigent's, through the forwarding path.
 */
export function routeAdmitted(
  admitted: Admitted,
  env: WebEnv,
  _ctx: ExecutionContext,
): Promise<Response> {
  return proxyToOmnigent(admitted, env);
}

export default {
  fetch: withIngress<WebEnv>(routeAdmitted),
} satisfies ExportedHandler<WebEnv>;
