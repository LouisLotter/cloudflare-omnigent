// The web Worker (AR-17): the public hostname. Every request passes ingress (WP2.1) first; only
// an admitted one is routed. It holds no Durable Object class and no live connection, and reaches
// the platform Worker's objects only through cross-script bindings, so its deploys never drop a
// computer's connection. A browser stream through it can drop after one of its deploys and
// reconnects (FH-38, R-25).

import type { WebEnv } from "./env.ts";
import { type Admitted, withIngress } from "./ingress/index.ts";
import { refusedPage } from "./pages/computers.ts";
import { bindingsPagePersonBackend, memberSeam } from "./pages/member-seam.ts";
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

/** Owner admission's refusal of the platform pages to anyone but the installation's owner. */
const OWNER_PAGES = "These pages are the installation owner's. Use Omnigent instead.";

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
  const log = (fields: Readonly<Record<string, string>>) =>
    console.log(JSON.stringify({ ...fields, path: path.slice(0, 256) }));
  if (admitted.admission === "members") return routeMember(admitted, env, path, log);
  // Owner admission (a team of one): ingress admits only the pinned owner.
  if (admitted.identity.pin === false) {
    return isPlatformPath(path) ? refusedPage(403, OWNER_PAGES) : proxyToOmnigent(admitted, env);
  }
  if (isPlatformPath(path)) return routePlatform(admitted, env, { assets: loadPageAssets });
  const redirect = await firstVisitRedirect(
    admitted,
    bindingsPasswordBackend(env),
    firstVisit,
    log,
  );
  return redirect ?? proxyToOmnigent(admitted, env);
}

/**
 * Members admission (WP8.3): Omnigent is everyone's, and decides who they are itself. The
 * platform pages decide per person through the membership seam (`member-seam.ts`), and
 * WorkspaceDO per computer (WP8.4): a member reaches her own computers, an administrator the
 * fleet view, and only the installation's owner the owner's own pages. There is no first-visit
 * redirect: the owner chose a password before the team.
 */
function routeMember(
  admitted: Admitted,
  env: WebEnv,
  path: string,
  log: (fields: Readonly<Record<string, string>>) => void,
): Promise<Response> {
  if (!isPlatformPath(path)) return proxyToOmnigent(admitted, env);
  return routePlatform(admitted, env, {
    assets: loadPageAssets,
    person: memberSeam(bindingsPagePersonBackend(env), log),
  });
}

export default {
  fetch: withIngress<WebEnv>(routeAdmitted),
} satisfies ExportedHandler<WebEnv>;
