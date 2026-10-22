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
   * For a cron trigger, to keep the server always on without waiting for a browser: any call
   * constructs OmnigentServer, whose constructor arms the watchdog if no alarm is set. It would
   * start the server right after an installation, and restore the watchdog should its alarm
   * ever be lost. The trigger itself waits for the staging tool to accept `triggers` (a change
   * for the lead); until then the first browser request or RPC starts the server.
   */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME)
        .bootstrapStatus({ interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION })
        .then(() => undefined),
    );
  },
} satisfies ExportedHandler<Env>;
