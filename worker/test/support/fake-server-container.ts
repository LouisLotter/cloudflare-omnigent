/**
 * A fake of the server container's port (src/server/container-port.ts) for Workers-runtime
 * tests: a fake Omnigent on port 8000 and the entrypoint's replication position on port 8001.
 * It models what the server controller must handle (DC-37, S1):
 *   - a start Cloudflare refuses right after a stop: `start()` returns, the container does not
 *     run, and `watch` reports "no container instance" (a few times, or always);
 *   - a server that runs but does not listen yet, or stops answering;
 *   - a stop by the platform (maintenance, a deploy's rollout);
 *   - a WebSocket answered with the container's own handshake headers, which must not reach the
 *     egress.
 * It records starts, stops, intercepts, timeouts and every request it served.
 */
import type { ReplicationPosition } from "@cfo/contracts";
import type { ContainerExit, ServerContainer } from "../../src/server/container-port.ts";

export const NO_INSTANCE_MESSAGE =
  "There is no container instance that can be provided to this Durable Object, try again later";

export interface RecordedRequest {
  readonly port: number;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export type FakeHandler = (port: number, request: Request) => Response | Promise<Response>;

export class FakeServerContainer implements ServerContainer {
  running = false;
  /** Whether the server answers on its ports. False models a boot or a hung server. */
  listening = true;
  /** How many of the next starts Cloudflare refuses (DC-37). */
  refuseStarts = 0;
  refuseForever = false;
  readonly starts: { readonly env: Readonly<Record<string, string>> }[] = [];
  readonly destroys: string[] = [];
  readonly inactivityTimeouts: number[] = [];
  readonly intercepts: { readonly host: string; readonly target: Fetcher }[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Starts, stops, intercepts and timeouts, in the order they happened. */
  readonly ops: string[] = [];
  /** What `/v1/info` reports. */
  info = { accounts_enabled: true, needs_setup: true };
  /** What `/position` reports, or null for a 503. */
  position: ReplicationPosition | null = null;
  /** Called on each `/position` read, before it answers; may change `position`. */
  onPosition: ((read: number) => void) | null = null;
  /** Answers for port 8000 paths other than the fake's own; default: an echo. */
  handler: FakeHandler | null = null;
  #onExit: ((exit: ContainerExit) => void) | null = null;
  #positionReads = 0;

  start(env: Readonly<Record<string, string>>): void {
    if (this.running) throw new Error("start() called while the container is running");
    this.starts.push({ env: { ...env } });
    this.ops.push("start");
    if (this.refuseForever || this.refuseStarts > 0) {
      if (this.refuseStarts > 0) this.refuseStarts -= 1;
      queueMicrotask(() => this.#onExit?.({ error: new Error(NO_INSTANCE_MESSAGE) }));
      return;
    }
    this.running = true;
  }

  watch(onExit: (exit: ContainerExit) => void): void {
    this.#onExit = onExit;
  }

  async destroy(reason: string): Promise<void> {
    this.destroys.push(reason);
    this.ops.push("destroy");
    this.running = false;
  }

  /** The platform stops the container, as maintenance or a rollout would. */
  stopByPlatform(): void {
    this.running = false;
    this.#onExit?.({ error: new Error("Runtime signalled the container to exit: 15") });
  }

  async setInactivityTimeout(ms: number): Promise<void> {
    this.inactivityTimeouts.push(ms);
    this.ops.push("timeout");
  }

  async interceptOutboundHttp(host: string, target: Fetcher): Promise<void> {
    this.intercepts.push({ host, target });
    this.ops.push(`intercept:${host}`);
  }

  async fetch(port: number, request: Request): Promise<Response> {
    const body =
      request.method === "GET" || request.method === "HEAD" ? null : await request.text();
    this.requests.push({
      port,
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body,
    });
    if (!this.running) throw new Error("Container is not running.");
    if (!this.listening) {
      throw new Error(`The container is not listening on the TCP address 10.0.0.1:${port}`);
    }
    const path = new URL(request.url).pathname;
    if (port === 8000 && path === "/health") return Response.json({ status: "ok" });
    if (port === 8000 && path === "/v1/info") return Response.json({ ...this.info, extra: 1 });
    if (port === 8001 && path === "/position") {
      this.#positionReads += 1;
      this.onPosition?.(this.#positionReads);
      return this.position === null
        ? new Response("not yet", { status: 503 })
        : Response.json(this.position);
    }
    if (port !== 8000) throw new Error(`The container is not listening on port ${port}`);
    if (this.handler) {
      return this.handler(
        port,
        new Request(request.url, { method: request.method, headers: request.headers, body }),
      );
    }
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return echoSocket();
    return Response.json({ method: request.method, path, body });
  }

  /** Requests the fake Omnigent served on port 8000, other than the watchdog's own reads. */
  forwarded(): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.port === 8000 && !["/health", "/v1/info"].includes(new URL(r.url).pathname),
    );
  }
}

/**
 * A WebSocket that echoes each message, answered as a server's port answers: with its own
 * `Upgrade`, `Connection` and `Sec-WebSocket-Accept`, a subprotocol and one more header.
 */
export function echoSocket(): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.binaryType = "arraybuffer";
  server.accept();
  server.addEventListener("message", (event) => server.send(event.data));
  server.addEventListener("close", (event) =>
    server.close(event.code === 1005 ? 1000 : event.code),
  );
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Accept": "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
      "Sec-WebSocket-Protocol": "omnigent.v1",
      "X-Server-Extra": "1",
    },
  });
}
