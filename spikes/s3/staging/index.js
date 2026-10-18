// Spike S3 staging Worker: one Durable Object that starts the spike computer
// image (without an Omnigent host) and forwards the bench routes to its
// supervisor API on port 7070. Reached only through the owner-only Access
// application, and every change follows the campaign-control rule (IR-017):
// see controls.js.
import { DurableObject } from "cloudflare:workers";
import { handle } from "./controls.js";

const KEEP_ALIVE_MS = 30 * 60 * 1000;

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Bench extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // In memory only: a new instance gets a new token and starts disarmed.
    this.state = { token: randomToken(), armedUntil: 0 };
  }

  async fetch(request) {
    const container = this.ctx.container;
    const ports = {
      now: () => Date.now(),
      container: {
        running: () => container.running,
        start: () => container.start({ env: { S3_START_HOST: "0" }, enableInternet: false }),
        keepAlive: () => container.setInactivityTimeout(KEEP_ALIVE_MS),
        fetch: async (path, init) => {
          for (let attempt = 0; attempt < 120; attempt++) {
            try {
              return await container.getTcpPort(7070).fetch(`http://container${path}`, init);
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          return new Response("the container did not start", { status: 503 });
        },
      },
    };
    return handle(request, this.state, ports);
  }
}

export default {
  fetch(request, env) {
    return env.BENCH.get(env.BENCH.idFromName("s3")).fetch(request);
  },
};
