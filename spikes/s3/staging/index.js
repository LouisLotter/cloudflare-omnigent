// Spike S3 staging Worker: one Durable Object that starts the spike computer
// image (without an Omnigent host) and forwards a few read-mostly routes to its
// supervisor API on port 7070. Reached only through the owner-only Access app.
//
//   GET /probe                         filesystem, disk, cgroupfs, capabilities
//   GET /bench?profile=realistic&runs=5&methods=rsync,tar   starts a job
//   GET /jobs/<id>                     job result
import { DurableObject } from "cloudflare:workers";

const KEEP_ALIVE_MS = 30 * 60 * 1000;

export class Bench extends DurableObject {
  async fetch(request) {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({ env: { S3_START_HOST: "0" }, enableInternet: false });
    }
    await container.setInactivityTimeout(KEEP_ALIVE_MS);
    const url = new URL(request.url);
    let init = { method: "GET" };
    const path = url.pathname;
    if (path === "/bench") {
      const body = {
        profile: url.searchParams.get("profile") ?? "realistic",
        runs: Number(url.searchParams.get("runs") ?? "5"),
        methods: (url.searchParams.get("methods") ?? "rsync,tar").split(","),
      };
      init = {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      };
    } else if (path !== "/probe" && path !== "/health" && !path.startsWith("/jobs/")) {
      return new Response("not found", { status: 404 });
    }
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        return await container.getTcpPort(7070).fetch(`http://container${path}`, init);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return new Response("the container did not start", { status: 503 });
  }
}

export default {
  fetch(request, env) {
    return env.BENCH.get(env.BENCH.idFromName("s3")).fetch(request);
  },
};
