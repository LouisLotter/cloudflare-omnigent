/**
 * The key service as the GitHub-linking end-to-end test runs it (WP5.9, `wrangler dev`, never
 * deployed): the platform Worker's real `PlatformInternal` entrypoint, reached exactly as the
 * server container's intercept reaches it (with the props OmnigentServer registers), and the
 * Worker's own secrets (`--env-file`, synthetic). Only `/key-service/v1/` is forwarded: the
 * launcher API, which needs the Durable Objects, is not part of this harness.
 *
 *   images/server/tests/integration/github_linking/test_github_linking_e2e.py starts it.
 */
import { exports } from "cloudflare:workers";

export { PlatformInternal } from "../../src/internal/entrypoints.ts";

const SERVER_PROPS = { propsVersion: 1, caller: "omnigent-server" };

type Factory = (options: { props: unknown }) => Fetcher;

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (!new URL(request.url).pathname.startsWith("/key-service/v1/")) {
      return new Response("not part of this harness", { status: 404 });
    }
    const entry = (exports as unknown as Record<"PlatformInternal", Factory>).PlatformInternal;
    return entry({ props: SERVER_PROPS }).fetch(request);
  },
} satisfies ExportedHandler;
