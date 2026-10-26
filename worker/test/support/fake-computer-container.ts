/**
 * A fake of the computer's container port (src/shared/computer-port.ts), for WorkspaceDO's tests
 * (WP3.1) and the routes' (WP3.3). Web-standard APIs only, so it runs in Node and in workerd. It
 * models what the controller must handle:
 *   - a start Cloudflare refuses right after a stop (DC-37): `start()` returns and the container
 *     never runs, for the next N starts or for every start;
 *   - a stop by the platform with no stop record (maintenance; the supervisor dying, FH-34);
 *   - "Network connection lost." on a request to the container, before or after the supervisor
 *     received it, so the outcome is ambiguous (S3's staging runs);
 *   - `DirectoryBackup` uploads and restores, kept in memory, which can fail or be held.
 * It keeps a record of every stop: the reason, who stopped it and the generation it ran, so a test
 * can tell a planned stop from an unexpected one. Every start, stop, signal, intercept and timeout
 * is also logged in order in `ops`.
 */
import {
  COMPUTER_START_ENV,
  type DirectoryBackupRecord,
  type InstanceSize,
  TERMINAL_PORT,
} from "@cfo/contracts";
import {
  type BackupOptions,
  CONNECTION_LOST_MESSAGE,
  type ComputerContainerPort,
  type ComputerStartOptions,
  NO_INSTANCE_MESSAGE,
  type RestoreOptions,
} from "../../src/shared/computer-port.ts";

export interface StopRecord {
  /** `destroy`: WorkspaceDO stopped it. `platform`: it stopped on its own. `signal`: SIGTERM. */
  readonly by: "destroy" | "platform" | "signal";
  readonly reason: string;
  /** The generation in the stopped container's start environment, or null if none was set. */
  readonly generation: string | null;
  readonly at: number;
}

export interface StartRecord {
  readonly instance: InstanceSize;
  readonly env: Readonly<Record<string, string>>;
  /** Whether Cloudflare refused it (the container never ran). */
  readonly refused: boolean;
}

export type SupervisorHandler = (request: Request) => Response | Promise<Response>;

export class FakeComputerContainer implements ComputerContainerPort {
  running = false;
  /** How many of the next starts Cloudflare refuses right after a stop (DC-37). */
  refuseStarts = 0;
  /** Every start is refused. */
  refuseForever = false;
  /**
   * How many of the next requests to the container drop with "Network connection lost.":
   * `before` drops them unsent; `after` lets the supervisor handle them, then drops the reply.
   */
  dropRequests: { count: number; when: "before" | "after" } = { count: 0, when: "before" };
  /** The supervisor's command API; without one, the container is not listening. */
  supervisor: SupervisorHandler | null = null;
  /** ttyd on the setup terminal's port (WP3.5); without one, that port is not listening. */
  terminal: SupervisorHandler | null = null;
  /** The next backup uploads fail; `holdBackups` makes them wait for their abort signal. */
  failBackups = 0;
  holdBackups = false;
  clock: () => number = () => Date.now();

  readonly starts: StartRecord[] = [];
  readonly stops: StopRecord[] = [];
  readonly signals: number[] = [];
  readonly intercepts: { readonly host: string; readonly target: Fetcher }[] = [];
  readonly inactivityTimeouts: number[] = [];
  readonly requests: { readonly port: number; readonly url: string; readonly body: string }[] = [];
  readonly restores: { readonly id: string; readonly dir: string }[] = [];
  /** Uploaded layers, by backup ID, under their key prefix. */
  readonly backups = new Map<
    string,
    { readonly prefix: string; readonly record: DirectoryBackupRecord }
  >();
  readonly ops: string[] = [];
  #env: Readonly<Record<string, string>> | null = null;
  #lastStartRefused = false;
  #nextBackup = 0;

  start(options: ComputerStartOptions): void {
    if (this.running) throw new Error("start() called while the container is running");
    const refused = this.refuseForever || this.refuseStarts > 0;
    if (this.refuseStarts > 0) this.refuseStarts -= 1;
    this.starts.push({ instance: options.instance, env: { ...options.env }, refused });
    this.ops.push(refused ? "start:refused" : "start");
    this.#lastStartRefused = refused;
    if (refused) return;
    this.#env = { ...options.env };
    this.running = true;
  }

  async destroy(reason: string): Promise<void> {
    this.ops.push("destroy");
    this.#stopped("destroy", reason);
  }

  signal(signo: number): void {
    this.signals.push(signo);
    this.ops.push(`signal:${signo}`);
    if (signo === 15 || signo === 9) this.#stopped("signal", `signal ${signo}`);
  }

  /** The platform stops the container with no stop record, or the supervisor died (FH-34). */
  stopByPlatform(reason = "platform maintenance"): void {
    this.ops.push("platform-stop");
    this.#stopped("platform", reason);
  }

  #stopped(by: StopRecord["by"], reason: string): void {
    if (!this.running) return;
    this.running = false;
    this.stops.push({
      by,
      reason,
      generation: this.#env?.[COMPUTER_START_ENV.generation] ?? null,
      at: this.clock(),
    });
    this.#env = null;
  }

  async fetch(port: number, request: Request): Promise<Response> {
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    this.requests.push({ port, url: request.url, body });
    if (!request.url.startsWith("http://"))
      throw new Error("only http:// reaches a container port");
    const drop = this.dropRequests.count > 0 ? this.dropRequests.when : null;
    if (drop) this.dropRequests = { ...this.dropRequests, count: this.dropRequests.count - 1 };
    if (drop === "before") throw new Error(CONNECTION_LOST_MESSAGE);
    // A refused start surfaces in the next container call (CF-05).
    if (!this.running && this.#lastStartRefused) throw new Error(NO_INSTANCE_MESSAGE);
    if (!this.running) throw new Error("Container is not running.");
    if (port === TERMINAL_PORT) {
      if (!this.terminal) {
        throw new Error(`The container is not listening on the TCP address 10.0.0.1:${port}`);
      }
      return this.terminal(request);
    }
    if (!this.supervisor) {
      throw new Error(`The container is not listening on the TCP address 10.0.0.1:${port}`);
    }
    const response = await this.supervisor(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body || null,
      }),
    );
    if (drop === "after") throw new Error(CONNECTION_LOST_MESSAGE);
    return response;
  }

  async registerIntercept(host: string, target: Fetcher): Promise<void> {
    this.intercepts.push({ host, target });
    this.ops.push(`intercept:${host}`);
  }

  async setInactivityTimeout(ms: number): Promise<void> {
    this.inactivityTimeouts.push(ms);
    this.ops.push("timeout");
  }

  async backup(options: BackupOptions): Promise<DirectoryBackupRecord> {
    if (!this.running) throw new Error("Container is not running.");
    if (this.holdBackups) {
      await new Promise<never>((_, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
      });
    }
    if (this.failBackups > 0) {
      this.failBackups -= 1;
      throw new Error("BACKUP_TRANSFER: a part upload failed");
    }
    this.#nextBackup += 1;
    const n = this.#nextBackup.toString(16).padStart(12, "0");
    const record: DirectoryBackupRecord = {
      id: `00000000-0000-4000-8000-${n}`,
      dir: options.dir,
      size: 1000 + this.#nextBackup,
      name: options.name,
      sha256: n.padStart(64, "0"),
      format: "tar+zstd/1",
    };
    this.backups.set(record.id, { prefix: options.prefix, record });
    this.ops.push(`backup:${options.name}`);
    return record;
  }

  async restore(record: DirectoryBackupRecord, options: RestoreOptions): Promise<void> {
    if (!this.running) throw new Error("Container is not running.");
    const stored = this.backups.get(record.id);
    if (!stored || stored.prefix !== options.prefix) throw new Error("BACKUP_NOT_FOUND");
    this.restores.push({ id: record.id, dir: options.dir });
    this.ops.push(`restore:${record.id}`);
  }

  async deleteBackup(
    record: DirectoryBackupRecord,
    options: { readonly prefix: string },
  ): Promise<void> {
    const stored = this.backups.get(record.id);
    if (stored && stored.prefix === options.prefix) this.backups.delete(record.id);
  }

  /** Stops WorkspaceDO itself recorded, as opposed to the platform's. */
  plannedStops(): StopRecord[] {
    return this.stops.filter((s) => s.by !== "platform");
  }
}
