// Spike S7 Worker: both entry points to the Omnigent server, through one forwarding function.
//
//   default fetch   the browser entry: the public hostname, behind owner-only Access.
//   ComputerRoute   the computer entry: the private host route. In production a computer's
//                   container reaches it through interceptOutboundHttp("omnigent.internal", …),
//                   with the computer's identity in props.
//
// Locally (wrangler.jsonc) the upstream is an Omnigent container on 127.0.0.1, and a second
// `wrangler dev` with ENTRY=computer stands in for container interception by handing every
// request to ComputerRoute through ctx.exports, with synthetic props. On staging
// (wrangler.staging.jsonc) the upstream is the OmnigentServer Durable Object and its container,
// and a real computer container reaches ComputerRoute through interception.

import { WorkerEntrypoint } from "cloudflare:workers";
import { type Entry, type ForwardDeps, forwardToServer, type GuardMode } from "./forward.ts";
import { normalizeBasePath } from "./guard.ts";
import { handlePlatform, type StagingEnv } from "./staging.ts";

export { ComputerSim, OmnigentServer, ResultSink } from "./staging.ts";

export interface ComputerProps {
  readonly computerId: string;
  readonly hostId: string;
  readonly generation: number;
}

export interface S7Env extends Partial<StagingEnv> {
  /** Local only: the Omnigent server's origin. */
  readonly UPSTREAM_ORIGIN?: string;
  /** Local only: "computer" makes the default handler emulate container interception. */
  readonly ENTRY?: string;
  readonly BASE_PATH?: string;
  readonly GUARD_MODE?: string;
}

const UPSTREAM_ORIGIN_STAGING = "http://omnigent-server";

function deps(env: S7Env): ForwardDeps {
  const mode: GuardMode =
    env.GUARD_MODE === "naive" || env.GUARD_MODE === "off" ? env.GUARD_MODE : "strict";
  const base = {
    basePath: normalizeBasePath(env.BASE_PATH),
    mode,
    log: (entry: Record<string, unknown>) => console.log(JSON.stringify(entry)),
  };
  if (env.SERVER) {
    const server = env.SERVER;
    return {
      ...base,
      upstreamOrigin: UPSTREAM_ORIGIN_STAGING,
      upstream: (request) => server.get(server.idFromName("singleton")).fetch(request),
    };
  }
  if (!env.UPSTREAM_ORIGIN) throw new Error("UPSTREAM_ORIGIN or SERVER must be configured");
  return { ...base, upstreamOrigin: env.UPSTREAM_ORIGIN, upstream: (request) => fetch(request) };
}

export function forward(request: Request, entry: Entry, env: S7Env): Promise<Response> {
  return forwardToServer(request, entry, deps(env));
}

/** The private host route. Its identity comes from props, never from the request. */
export class ComputerRoute extends WorkerEntrypoint<S7Env, ComputerProps> {
  override fetch(request: Request): Promise<Response> {
    return forward(request, "computer", this.env);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (env.ENTRY === "computer") {
      const exports = ctx.exports as unknown as {
        ComputerRoute: (options: { props: ComputerProps }) => Fetcher;
      };
      const route = exports.ComputerRoute({
        props: { computerId: "s7-local-computer", hostId: "s7-local-host", generation: 1 },
      });
      return route.fetch(request);
    }
    const platform = await handlePlatform(request, env, ctx);
    if (platform) return platform;
    return forward(request, "browser", env);
  },
} satisfies ExportedHandler<S7Env>;
