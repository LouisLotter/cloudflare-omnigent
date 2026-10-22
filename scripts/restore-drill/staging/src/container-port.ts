// The only module that touches `ctx.container` (the repository's rule for beta APIs).

export const HARNESS_PORT = 8002;
export const SERVER_PORT = 8000;
const STOP_WAIT_MS = 120_000;

export interface ContainerPort {
  readonly running: boolean;
  /** Starts the harness image with this environment, with internet access (R2's S3 API). */
  start(env: Record<string, string>): void;
  /** SIGKILL, then destroy: everything on the container's disk is gone, as in a lost server. */
  kill(): Promise<void>;
  /** A GET to the harness's status port. */
  harness(path: string): Promise<Response>;
  /** Whether the server inside answers Omnigent's /health with 200. */
  serverHealthy(): Promise<boolean>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function containerPort(ctx: DurableObjectState): ContainerPort {
  const container = ctx.container;
  if (container === undefined) throw new Error("no container is attached to this Durable Object");
  return {
    get running() {
      return container.running;
    },
    start(env) {
      container.start({ enableInternet: true, env });
      ctx.waitUntil(container.monitor().catch(() => undefined));
    },
    async kill() {
      if (container.running) {
        try {
          container.signal(9);
        } catch {
          // Already stopping.
        }
      }
      try {
        await container.destroy();
      } catch {
        // Already gone.
      }
      const deadline = Date.now() + STOP_WAIT_MS;
      while (container.running && Date.now() < deadline) await sleep(500);
    },
    harness(path) {
      return container.getTcpPort(HARNESS_PORT).fetch(`http://harness${path}`);
    },
    async serverHealthy() {
      try {
        const response = await container.getTcpPort(SERVER_PORT).fetch("http://server/health");
        return response.status === 200;
      } catch {
        return false;
      }
    },
  };
}
