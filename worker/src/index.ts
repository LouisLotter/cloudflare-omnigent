import { ControlDO } from "./control/ControlDO.ts";

export { ControlDO };

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
