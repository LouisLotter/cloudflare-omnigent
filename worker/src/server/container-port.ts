// The server controller's container port: the only server module that touches `ctx.container`
// (code-structure plan, "Beta APIs only behind adapters"). It uses the Durable Object Container
// API directly, as X1's native forwarding did, never the containers library: its default fetch
// accepts both sockets and returns the container's handshake headers (R-24).

/** The port the Omnigent server listens on inside its container. */
export const OMNIGENT_PORT = 8000;

/** Why `monitor()` settled: a clean exit, or the error it rejected with. */
export interface ContainerExit {
  readonly error: unknown;
}

/** The parts of a container the server controller uses. */
export interface ServerContainer {
  readonly running: boolean;
  /** Starts the container with this environment and internet access. Throws if it runs. */
  start(env: Readonly<Record<string, string>>): void;
  /** Calls `onExit` once the container started last stops, or its start fails. */
  watch(onExit: (exit: ContainerExit) => void): void;
  /** HTTP to a container port, over `http://` (an `https://` URL throws on Cloudflare). */
  fetch(port: number, request: Request): Promise<Response>;
  destroy(reason: string): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  interceptOutboundHttp(host: string, target: Fetcher): Promise<void>;
}

/** The container of this Durable Object, or null when its class has none configured. */
export function serverContainerOf(ctx: DurableObjectState): ServerContainer | null {
  return ctx.container ? nativeServerContainer(ctx.container) : null;
}

/** The adapter over the runtime's container. */
export function nativeServerContainer(container: Container): ServerContainer {
  return {
    get running() {
      return container.running;
    },
    start(env) {
      container.start({ enableInternet: true, env: { ...env } });
    },
    watch(onExit) {
      container.monitor().then(
        () => onExit({ error: null }),
        (error: unknown) => onExit({ error }),
      );
    },
    fetch(port, request) {
      return container.getTcpPort(port).fetch(request);
    },
    destroy(reason) {
      return container.destroy(reason);
    },
    setInactivityTimeout(ms) {
      return container.setInactivityTimeout(ms);
    },
    interceptOutboundHttp(host, target) {
      return container.interceptOutboundHttp(host, target);
    },
  };
}

const NO_INSTANCE = "there is no container instance that can be provided to this durable object";
const NOT_LISTENING = "the container is not listening";

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

/** Cloudflare's refusal of a start right after a stop (DC-37). */
export function isNoInstanceError(error: unknown): boolean {
  return messageOf(error).includes(NO_INSTANCE);
}

/** A port fetch that never reached a listening server: the request was not sent. */
export function isNotListeningError(error: unknown): boolean {
  return messageOf(error).includes(NOT_LISTENING);
}
