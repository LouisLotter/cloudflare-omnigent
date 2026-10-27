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
 *   - the server image's entrypoint (WP2.3): its status on port 8001 (`phase`, recovery),
 *     port 8000 refusing connections while it restores and answering 503 in recovery mode, a
 *     SIGTERM stop that takes time, and exit codes;
 * It records starts, signals, stops, intercepts, timeouts and every request it served.
 */
import type { ReplicationPosition } from "@cfo/contracts";
import type { ContainerExit, ServerContainer } from "../../src/server/container-port.ts";
import type { EntrypointPhase } from "../../src/server/watchdog.ts";

/** The runtime's cap on `setInactivityTimeout` (Cloudflare's Durable Object Container API). */
export const MAX_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60_000;

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
  /** Each start's environment and image, in order. */
  readonly starts: {
    readonly env: Readonly<Record<string, string>>;
    readonly image: string | null;
  }[] = [];
  readonly destroys: string[] = [];
  readonly inactivityTimeouts: number[] = [];
  /** Each inactivity timeout set, with the time on `clock` (the test clock, from the harness). */
  readonly timeoutRenewals: { readonly at: number; readonly ms: number }[] = [];
  clock: () => number = Date.now;
  readonly intercepts: { readonly host: string; readonly target: Fetcher }[] = [];
  readonly requests: RecordedRequest[] = [];
  /** Starts, stops, intercepts and timeouts, in the order they happened. */
  readonly ops: string[] = [];
  /**
   * Answers for the next health checks, in order (true: 200, false: 503); once used up, health
   * follows `listening`. Lets a test say exactly when the server stops or starts answering.
   */
  healthResults: (boolean | { readonly ok: boolean; readonly delayMs: number })[] = [];
  /**
   * How long `destroy` takes, so a test can act while the watchdog stops the server. A timer, not
   * a promise the test resolves: promises do not cross workerd's request contexts.
   */
  destroyMs = 0;
  /** What the entrypoint reports on `/status`; null answers 404. */
  entrypointPhase: EntrypointPhase | null = "running";
  /** The entrypoint's boot ID on `/status`: a new one models a container replaced unseen. */
  bootId = "f".repeat(32);
  recovery: { reason: string; transient: boolean } | null = null;
  readonly signals: number[] = [];
  /** How long a SIGTERM stop takes; null: SIGTERM is ignored. */
  stopMs: number | null = 0;
  /** The exit code a SIGTERM stop ends with. */
  exitCodeOnStop = 0;
  /** What `/v1/info` reports. */
  info = { accounts_enabled: true, needs_setup: true };
  /** What `/position` reports, or null for a 503. */
  position: ReplicationPosition | null = null;
  /** Called on each `/position` read, before it answers; may change `position`. */
  onPosition: ((read: number) => void) | null = null;
  /** Answers for port 8000 paths other than the fake's own; default: an echo. */
  handler: FakeHandler | null = null;
  /** The `replication` member of the entrypoint's `/status` (WP3.5's replication warning). */
  replication: unknown = null;
  #onExit: ((exit: ContainerExit) => void) | null = null;
  #positionReads = 0;

  start(env: Readonly<Record<string, string>>, image: string | null): void {
    if (this.running) throw new Error("start() called while the container is running");
    this.starts.push({ env: { ...env }, image });
    this.ops.push("start");
    if (this.refuseForever || this.refuseStarts > 0) {
      if (this.refuseStarts > 0) this.refuseStarts -= 1;
      queueMicrotask(() => this.#onExit?.({ error: new Error(NO_INSTANCE_MESSAGE) }));
      return;
    }
    this.running = true;
  }

  /** How many times an object instance attached its `monitor()` (`watch`). */
  watches = 0;

  watch(onExit: (exit: ContainerExit) => void): void {
    this.watches += 1;
    this.#onExit = onExit;
  }

  async destroy(reason: string): Promise<void> {
    this.destroys.push(reason);
    this.ops.push("destroy");
    if (this.destroyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.destroyMs));
    this.running = false;
  }

  /** The platform stops the container, as maintenance or a rollout would, or it exits. */
  stopByPlatform(exitCode: number | null = null): void {
    this.running = false;
    this.#exited(exitCode);
  }

  /** The container's main process ended with this code (null: by a signal). */
  #exited(exitCode: number | null): void {
    const error =
      exitCode === 0
        ? null
        : new Error(
            exitCode === null
              ? "Runtime signalled the container to exit: 15"
              : `Container exited with unexpected exit code: ${exitCode}`,
          );
    this.#onExit?.({ error });
  }

  signal(signo: number): void {
    this.signals.push(signo);
    this.ops.push(`signal:${signo}`);
    if (signo !== 15 || this.stopMs === null) return;
    this.entrypointPhase = "stopping";
    const stop = () => {
      this.running = false;
      this.entrypointPhase = "running";
      this.#exited(this.exitCodeOnStop);
    };
    if (this.stopMs === 0) stop();
    else setTimeout(stop, this.stopMs);
  }

  /** As the runtime: more than 0 and at most 6 hours, or the promise rejects. */
  async setInactivityTimeout(ms: number): Promise<void> {
    if (!(ms > 0 && ms <= MAX_INACTIVITY_TIMEOUT_MS)) {
      throw new RangeError("the inactivity timeout must be more than 0 and at most 6 hours");
    }
    this.inactivityTimeouts.push(ms);
    this.timeoutRenewals.push({ at: this.clock(), ms });
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
    const path = new URL(request.url).pathname;
    if (port === 8001 && path === "/status") {
      return this.entrypointPhase === null
        ? new Response("not found", { status: 404 })
        : Response.json({
            protocolVersion: 1,
            bootId: this.bootId,
            phase: this.entrypointPhase,
            recovery: this.recovery,
            finalSync: null,
            replication: this.replication,
          });
    }
    // Port 8000 refuses connections until the app listens: through the restore and while it
    // initializes (the entrypoint's `initializing`, WP2.6).
    const restoring =
      port === 8000 &&
      ["starting", "restoring", "initializing"].includes(this.entrypointPhase ?? "");
    if (!this.listening || restoring) {
      throw new Error(`The container is not listening on the TCP address 10.0.0.1:${port}`);
    }
    if (port === 8000 && this.entrypointPhase === "recovery") {
      return Response.json(
        { error: { code: "recovery_mode", reason: this.recovery?.reason ?? "unknown" } },
        { status: 503 },
      );
    }
    if (port === 8000 && path === "/health") {
      const next = this.healthResults.shift();
      const ok = typeof next === "object" ? next.ok : next;
      if (typeof next === "object")
        await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      return ok === false
        ? Response.json({ status: "unavailable" }, { status: 503 })
        : Response.json({ status: "ok" });
    }
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
