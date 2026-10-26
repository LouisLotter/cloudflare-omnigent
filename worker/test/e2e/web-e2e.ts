/**
 * The web Worker as the local journeys run it (WP3.5, `wrangler dev`, never deployed): the
 * production web Worker (src/web.ts, ingress first), plus `/__e2e/*`, which reaches the e2e
 * platform Worker's seeding routes and nothing else.
 */
import type { WebEnv } from "../../src/env.ts";
import web from "../../src/web.ts";

type Env = WebEnv & { readonly E2E: Fetcher };

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/__e2e/")) return env.E2E.fetch(request);
    return web.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
