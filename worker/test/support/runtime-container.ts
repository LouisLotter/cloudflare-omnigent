/**
 * A simulated runtime container (`ctx.container`) for the assembled chain's Workers-runtime tests
 * (WP3.18). Only the container is simulated: WorkspaceDO's production `openPort()` wraps it in
 * WP3.3's adapter, the Sandbox SDK's real `DirectoryBackup` drives it, the real fenced gateway
 * moves the bytes to and from R2, and the supervisor's messages reach the real computer API route
 * through the intercept WorkspaceDO registered. It models:
 *   - `start`, `destroy`, `signal`, `running`, the images map of the `durable_object` policy, the
 *     start options the runtime receives (size, internet, image);
 *   - the supervisor's command port (8090), answered by `SimulatedComputer`'s fake supervisor;
 *   - `interceptOutboundHttp`, keeping the latest target per host, as the runtime does;
 *   - `exec` of `sandbox-shim directory-backup`: the shim's framed protocol (the lock, the grant's
 *     acknowledgement, the result), uploading a staged layer as one part through the intercepted
 *     `backups.sandbox.internal`, and restoring by a ranged read through it, with the size and the
 *     SHA-256 checked. A layer's bytes are its simulated content as JSON.
 * It never touches R2 or WorkspaceDO itself: everything goes through the registered intercepts.
 */
import {
  COMPUTER_API_HOST,
  COMPUTER_API_URL,
  type ComputerId,
  type InterceptProps,
  type SupervisorMessage,
  type SupervisorReply,
} from "@cfo/contracts";
import { BACKUP_GATEWAY_HOST } from "../../src/computer/network.ts";
import { type LayerContent, SimulatedComputer } from "./fake-supervisor.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The shim's frame header: magic "SBXF", protocol 1, kind, little-endian payload length. */
function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + payload.byteLength);
  out.set([83, 66, 88, 70], 0);
  out[4] = 1;
  out[5] = kind;
  new DataView(out.buffer).setUint32(6, payload.byteLength, true);
  out.set(payload, 10);
  return out;
}
const dataFrame = (value: unknown) => frame(2, encoder.encode(JSON.stringify(value)));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function layerBytes(content: LayerContent): Uint8Array {
  return encoder.encode(
    JSON.stringify({ kind: content.kind, files: [...content.files], deleted: content.deleted }),
  );
}

function layerOf(bytes: Uint8Array): LayerContent {
  const raw = JSON.parse(decoder.decode(bytes)) as {
    kind: LayerContent["kind"];
    files: [string, string][];
    deleted: string[];
  };
  return { kind: raw.kind, files: new Map(raw.files), deleted: raw.deleted };
}

interface ShimIo {
  write(bytes: Uint8Array): Promise<void>;
  /** The next acknowledgement byte, or null once the caller closed stdin. */
  ack(): Promise<number | null>;
}

/**
 * One `exec` of the shim, with piped stdin and stdout. The container's backup lock: the shim
 * reports `locked` only once the previous shim released it, and holds it until its stdin closes
 * (or it is killed), as the SDK requires, so a later operation's grant can never be replaced by
 * an earlier one's deny.
 */
function shimProcess(
  lock: { held: Promise<void> },
  run: (io: ShimIo) => Promise<number>,
): ExecProcess {
  // A queue: each shim waits for every one before it. A successor waits for this one's own part
  // and, through it, for the predecessor's, so a waiter killed while queued gives up only its own
  // turn, never its predecessor's hold (Codex WP3.18 r2-4).
  const previous = lock.held;
  let release: () => void = () => undefined;
  const own = new Promise<void>((resolve) => {
    release = resolve;
  });
  lock.held = previous.then(() => own);
  let killed = false;
  const stdin = new TransformStream<Uint8Array, Uint8Array>();
  const stdout = new TransformStream<Uint8Array, Uint8Array>();
  const out = stdout.writable.getWriter();
  const input = stdin.readable.getReader();
  let pending: Uint8Array = new Uint8Array();
  const io: ShimIo = {
    write: (bytes) => out.write(bytes),
    async ack() {
      while (pending.byteLength === 0) {
        const next = await input.read();
        if (next.done) return null;
        pending = next.value;
      }
      const byte = pending[0] as number;
      pending = pending.subarray(1);
      return byte;
    },
  };
  let settle: (code: number) => void = () => undefined;
  const exitCode = new Promise<number>((resolve) => {
    settle = resolve;
  });
  void previous
    .then(() => (killed ? 137 : run(io)))
    .catch(() => 1)
    .then(async (code) => {
      await out.close().catch(() => undefined);
      settle(code);
      // The lock is held until stdin closes: the caller's deny comes first, then the close.
      while ((await io.ack().catch(() => null)) !== null) {
        // Bytes after the last acknowledgement are ignored.
      }
      release();
    });
  return {
    stdin: stdin.writable,
    stdout: stdout.readable,
    stderr: null,
    pid: 4242,
    isPty: false,
    exitCode,
    output: () => Promise.reject(new Error("not used")),
    kill: () => {
      killed = true;
      void out.abort("killed").catch(() => undefined);
      void input.cancel("killed").catch(() => undefined);
      settle(137);
      release();
    },
    resize: () => undefined,
  } as unknown as ExecProcess;
}

/** What the runtime received at each start. */
export interface RuntimeStart {
  readonly instance: string | undefined;
  readonly enableInternet: boolean | undefined;
  readonly image: string | undefined;
  readonly env: Readonly<Record<string, string>>;
  /** The hosts intercepted, with their props' generation, before this start. */
  readonly interceptedBefore: readonly string[];
}

export class FakeRuntimeContainer {
  readonly sim: SimulatedComputer;
  /** The latest target registered for each host (a registration replaces the one before). */
  readonly intercepts = new Map<string, Fetcher>();
  /** Every registration, in order: `host`. */
  readonly registrations: string[] = [];
  readonly startsSeen: RuntimeStart[] = [];
  /** Every shim command run: `backup:<dir>` or `restore:<dir>`. */
  readonly shimRuns: string[] = [];
  /** The `durable_object` policy's images map, as the runtime reports it. */
  readonly images: Record<string, string> = {
    computer: "registry.cloudflare.example/cfo-computer@sha256:0000",
  };
  /** The next shim uploads fail as a part upload would. */
  failUploads = 0;
  /** `sandbox-shim`'s backup lock, one per container. */
  readonly #lock = { held: Promise.resolve() };
  /** The props WorkspaceDO built its intercepts with, in order (observed, not replaced). */
  readonly props: InterceptProps[] = [];

  constructor(computerId: ComputerId) {
    this.sim = new SimulatedComputer(computerId);
  }

  get running(): boolean {
    return this.sim.running;
  }

  start(options?: ContainerStartupOptions): void {
    const o = (options ?? {}) as {
      instance?: string;
      enableInternet?: boolean;
      image?: string;
      env?: Record<string, string>;
    };
    this.startsSeen.push({
      instance: o.instance,
      enableInternet: o.enableInternet,
      image: o.image,
      env: { ...(o.env ?? {}) },
      interceptedBefore: [...this.intercepts.keys()].sort(),
    });
    this.sim.start({ instance: o.instance as never, env: { ...(o.env ?? {}) } });
  }

  async monitor(): Promise<void> {
    return new Promise(() => undefined);
  }

  destroy(reason?: unknown): Promise<void> {
    return this.sim.destroy(String(reason ?? "destroy"));
  }

  signal(signo: number): void {
    this.sim.signal(signo);
  }

  getTcpPort(port: number): Fetcher {
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        this.sim.fetch(port, new Request(input, init)),
    } as unknown as Fetcher;
  }

  setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    return this.sim.setInactivityTimeout(Number(durationMs));
  }

  async interceptOutboundHttp(host: string, target: Fetcher): Promise<void> {
    this.intercepts.set(host, target);
    this.registrations.push(host);
    if (host !== BACKUP_GATEWAY_HOST) await this.sim.registerIntercept(host, target);
  }

  async exec(cmd: string[], _options?: ContainerExecOptions): Promise<ExecProcess> {
    if (!this.sim.running) throw new Error("Container is not running.");
    const [path, tool, command, json] = cmd;
    if (path !== "/usr/local/bin/sandbox-shim" || tool !== "directory-backup") {
      throw new Error(`unexpected exec: ${cmd.join(" ")}`);
    }
    const request = JSON.parse(json ?? "{}") as {
      gateway: string;
      dir: string;
      size?: number;
      sha256?: string;
    };
    this.shimRuns.push(`${command}:${request.dir}`);
    if (command === "backup") return shimProcess(this.#lock, (io) => this.#backup(io, request.dir));
    if (command === "restore") {
      return shimProcess(this.#lock, (io) =>
        this.#restore(io, request.dir, request.size ?? 0, request.sha256 ?? ""),
      );
    }
    throw new Error(`unexpected shim command ${command}`);
  }

  #gateway(): Fetcher {
    const gateway = this.intercepts.get(BACKUP_GATEWAY_HOST);
    if (gateway === undefined) throw new Error("no backup gateway intercepted");
    return gateway;
  }

  async #backup(io: ShimIo, dir: string): Promise<number> {
    await io.write(dataFrame({ kind: "locked" }));
    if ((await io.ack()) === null) return 1;
    const content = this.sim.sup?.stagedAt(dir);
    if (content === undefined) {
      await io.write(dataFrame({ kind: "error", code: "transfer", detail: "nothing staged" }));
      return 1;
    }
    const bytes = layerBytes(content);
    if (this.failUploads > 0) {
      this.failUploads -= 1;
      await io.write(dataFrame({ kind: "error", code: "transfer", detail: "a part failed" }));
      return 1;
    }
    const response = await this.#gateway().fetch(`http://${BACKUP_GATEWAY_HOST}/parts/1`, {
      method: "PUT",
      headers: { "content-length": String(bytes.byteLength) },
      body: bytes,
    });
    if (response.status !== 200) {
      // The real shim's report of a refused part (sandbox-shim 1.0.0).
      const detail = `gateway rejected the part upload with HTTP ${response.status}: ${(
        await response.text()
      ).slice(0, 200)}`;
      await io.write(dataFrame({ kind: "error", code: "transfer", detail }));
      return 1;
    }
    const { etag } = (await response.json()) as { etag: string };
    await io.write(
      dataFrame({
        kind: "done",
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        parts: [{ partNumber: 1, etag }],
      }),
    );
    return 0;
  }

  async #restore(io: ShimIo, dir: string, size: number, sha256: string): Promise<number> {
    await io.write(dataFrame({ kind: "locked" }));
    if ((await io.ack()) === null) return 1;
    const response = await this.#gateway().fetch(`http://${BACKUP_GATEWAY_HOST}/object`, {
      headers: { range: `bytes=0-${size - 1}` },
    });
    if (response.status === 404) {
      await response.arrayBuffer();
      await io.write(dataFrame({ kind: "error", code: "notFound", detail: "no such backup" }));
      return 1;
    }
    if (response.status !== 206) {
      const detail = (await response.text()).slice(0, 200);
      await io.write(dataFrame({ kind: "error", code: "transfer", detail }));
      return 1;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== size || (await sha256Hex(bytes)) !== sha256) {
      await io.write(dataFrame({ kind: "error", code: "integrity", detail: "digest mismatch" }));
      return 1;
    }
    await io.write(dataFrame({ kind: "verified" }));
    // Swapped in only once the caller acknowledges the verified download.
    if ((await io.ack()) === null) return 1;
    const sup = this.sim.sup;
    if (sup === null) {
      await io.write(dataFrame({ kind: "error", code: "transfer", detail: "no supervisor" }));
      return 1;
    }
    sup.restoredDirs.set(dir, layerOf(bytes));
    await io.write(dataFrame({ kind: "done" }));
    return 0;
  }

  /**
   * Sends the supervisor's queued messages to `computer.internal` through the intercept WorkspaceDO
   * registered, in order, until one is refused. `within` runs each send in the context that
   * created the intercept's target (the Durable Object's, `runInDurableObject`), as the runtime
   * would. Returns how many were delivered.
   */
  async deliver(within: <T>(send: () => Promise<T>) => Promise<T>): Promise<number> {
    const sup = this.sim.sup;
    const api = this.intercepts.get(COMPUTER_API_HOST);
    if (sup === null || api === undefined) return 0;
    const before = sup.sent.length;
    await sup.flush((message: SupervisorMessage) =>
      within(async () => {
        const response = await api.fetch(COMPUTER_API_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
        });
        const body = (await response.json()) as SupervisorReply;
        if (!response.ok) throw new Error(`computer API ${response.status}`);
        return body;
      }),
    );
    return sup.sent.length - before;
  }
}
