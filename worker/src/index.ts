import { ControlDO } from "./control/ControlDO.ts";
import { OmnigentServer } from "./server/OmnigentServer.ts";
import { PlatformInternal } from "./server/platform-internal.ts";

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
} satisfies ExportedHandler<Env>;
