import { ControlDO } from "./control/ControlDO.ts";
import { OmnigentServer } from "./server/OmnigentServer.ts";
import { PlatformInternal } from "./server/platform-internal.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION, OMNIGENT_SERVER_OBJECT_NAME } from "./shared/rpc.ts";

// The platform Worker (AR-17): every Durable Object and container class, the private virtual
// hosts' entrypoints, and no public route. Browser traffic reaches OmnigentServer only through
// the web Worker's cross-script binding (src/web.ts).
export { ControlDO, OmnigentServer, PlatformInternal };

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__health") {
      return Response.json({ status: "ok" });
    }
    return Response.json(
      { error: { code: "not_found", message: "Not found.", retryable: false } },
      { status: 404 },
    );
  },

  /**
   * The cron trigger (wrangler.jsonc, every minute): the always-on backstop and the first start
   * after an installation. It makes sure the watchdog's alarm is armed and a stopped server is
   * started, and does nothing else (OmnigentServer.ensureStarted).
   */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).ensureStarted({
        interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
      }),
    );
  },
} satisfies ExportedHandler<Env>;
