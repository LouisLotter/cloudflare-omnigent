// The probe's Worker: one Durable Object that starts the container and answers with its /health.
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  async fetch() {
    const container = this.ctx.container;
    if (!container.running) container.start();
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        return await container.getTcpPort(8080).fetch("http://container/health");
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    return new Response("the container did not start", { status: 503 });
  }
}

export default {
  fetch(request, env) {
    return env.PROBE.get(env.PROBE.idFromName("probe")).fetch(request);
  },
};
