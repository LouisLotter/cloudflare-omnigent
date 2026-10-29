// The web Worker (AR-17): the public hostname. Every request passes ingress (WP2.1) first; only
// an admitted one is routed. It holds no Durable Object class and no live connection, and reaches
// the platform Worker's objects only through cross-script bindings, so its deploys never drop a
// computer's connection. A browser stream through it can drop after one of its deploys and
// reconnects (FH-38, R-25).

import type { WebEnv } from "./env.ts";
import { type Admitted, withIngress } from "./ingress/index.ts";
import {
  bindingsPasswordBackend,
  type FirstVisitMemo,
  firstVisitRedirect,
} from "./pages/password.ts";
import { isPlatformPath, routePlatform } from "./pages/router.ts";
import { proxyToOmnigent } from "./server/proxy.ts";

/** The pages' scripts and styles, bundled as text modules: loaded on first use. */
async function loadPageAssets() {
  return (await import("./pages/assets.ts")).ASSETS;
}

/** This isolate's memory of the owner's password (WP3.34): once chosen, it stops asking. */
const firstVisit: FirstVisitMemo = { chosen: false };

/**
 * Routes an admitted request. `/platform/` is the platform pages' (WP3.5) and never reaches
 * Omnigent; everything else is Omnigent's, through the forwarding path, except a page load while
 * the owner still has to choose a password, which goes to the password page (WP3.34).
 */
export async function routeAdmitted(
  admitted: Admitted,
  env: WebEnv,
  _ctx: ExecutionContext,
): Promise<Response> {
  const path = new URL(admitted.request.url).pathname;
  if (isPlatformPath(path)) {
    return routePlatform(admitted, env, { assets: loadPageAssets });
  }
  const redirect = await firstVisitRedirect(
    admitted,
    bindingsPasswordBackend(env),
    firstVisit,
    (fields) => console.log(JSON.stringify({ ...fields, path: path.slice(0, 256) })),
  );
  return redirect ?? proxyToOmnigent(admitted, env);
}

export default {
  fetch: withIngress<WebEnv>(routeAdmitted),
} satisfies ExportedHandler<WebEnv>;
