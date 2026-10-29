/**
 * The platform Worker as the GitHub setup flow's local end-to-end run uses it (WP3.36,
 * `github-setup-e2e.ts`, `wrangler dev`, never deployed): the production OmnigentServer, whose
 * container port drives the server image's real container through Docker, by way of the run's
 * control server on the loopback interface (`CFO_E2E_CONTROL`). So the watchdog itself starts the
 * server with the environment it computes, and, when a new version brings the GitHub App's
 * settings, finds the configuration changed, stops the server (SIGTERM) and starts it again with
 * them: the replacement the installer waits for. The container's state lives in the object's own
 * storage, as the runtime keeps it across instances. Everything else, the watchdog, its status
 * line, `githubSetup` and the cron's `scheduled` handler (`/__e2e/cron`), is production code.
 * WorkspaceDO and ControlDO are the production classes, for the web Worker's bindings.
 */
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import type { PlatformEnv } from "../../src/env.ts";
import platform from "../../src/index.ts";
import type { ContainerExit, ServerContainer } from "../../src/server/container-port.ts";
import {
  OmnigentServer as PlatformOmnigentServer,
  type ServerTiming,
} from "../../src/server/OmnigentServer.ts";

type Env = PlatformEnv & {
  readonly CFO_E2E_SERVER_PORTS?: string;
  readonly CFO_E2E_CONTROL?: string;
  readonly CFO_E2E_CONTROL_TOKEN?: string;
};

/** The real container, through the run's control server; its state in the object's storage. */
class DockerContainer implements ServerContainer {
  readonly #sql: SqlStorage;
  readonly #control: string;
  readonly #token: string;
  readonly #ports: Readonly<Record<string, number>>;
  #onExit: ((exit: ContainerExit) => void) | null = null;

  constructor(sql: SqlStorage, control: string, token: string, ports: Record<string, number>) {
    this.#sql = sql;
    this.#control = control;
    this.#token = token;
    this.#ports = ports;
    sql.exec("CREATE TABLE IF NOT EXISTS e2e_container (key TEXT PRIMARY KEY, value INTEGER)");
  }

  get running(): boolean {
    const row = this.#sql
      .exec<{ value: number }>("SELECT value FROM e2e_container WHERE key = 'running'")
      .toArray()[0];
    return row?.value === 1;
  }

  #set(running: boolean): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO e2e_container (key, value) VALUES ('running', ?)",
      running ? 1 : 0,
    );
  }

  #exited(code: number | null): void {
    this.#set(false);
    const onExit = this.#onExit;
    this.#onExit = null;
    onExit?.({
      error: code === 0 ? null : new Error(`container exited with unexpected exit code: ${code}`),
    });
  }

  async #call(path: string, body: unknown = {}): Promise<{ exitCode?: number | null }> {
    const response = await fetch(`${this.#control}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-e2e-token": this.#token },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`control ${path}: ${response.status}`);
    return (await response.json()) as { exitCode?: number | null };
  }

  start(env: Readonly<Record<string, string>>): void {
    if (this.running) throw new Error("the container is already running");
    this.#set(true);
    void this.#call("/start", { env }).then(
      (answer) => {
        if (answer.exitCode !== undefined) this.#exited(answer.exitCode);
      },
      () => this.#exited(null),
    );
  }

  watch(onExit: (exit: ContainerExit) => void): void {
    this.#onExit = onExit;
  }

  async fetch(port: number, request: Request): Promise<Response> {
    const local = this.#ports[String(port)];
    if (local === undefined || !this.running) {
      throw new Error(`The container is not listening on the TCP address 10.0.0.1:${port}`);
    }
    const url = new URL(request.url);
    try {
      return await fetch(`http://127.0.0.1:${local}${url.pathname}${url.search}`, request);
    } catch (error) {
      throw new Error(
        `The container is not listening on the TCP address 10.0.0.1:${port}: ${String(error)}`,
      );
    }
  }

  async destroy(): Promise<void> {
    const answer = await this.#call("/kill");
    this.#exited(answer.exitCode ?? null);
  }

  signal(signo: number): void {
    if (signo !== 15) return;
    void this.#call("/stop").then(
      (answer) => this.#exited(answer.exitCode ?? null),
      () => undefined,
    );
  }

  async setInactivityTimeout(): Promise<void> {}
  async interceptOutboundHttp(): Promise<void> {}
}

export class OmnigentServer extends PlatformOmnigentServer {
  protected override openContainer(): ServerContainer {
    const env = this.env as Env;
    const ports = JSON.parse(env.CFO_E2E_SERVER_PORTS ?? "{}") as Record<string, number>;
    return new DockerContainer(
      this.ctx.storage.sql,
      env.CFO_E2E_CONTROL ?? "",
      env.CFO_E2E_CONTROL_TOKEN ?? "",
      ports,
    );
  }

  protected override serverImage(): string | null {
    return null;
  }

  /** Checks every 10 s instead of every minute, so the run waits less; nothing else changes. */
  protected override timing(): ServerTiming {
    return { ...super.timing(), intervalMs: 10_000 };
  }
}

// The server's own virtual host: the watchdog registers it before every start (the key service,
// the launcher API), as in production.
export { PlatformInternal } from "../../src/internal/entrypoints.ts";

export class WorkspaceDO extends PlatformWorkspaceDO {}
export class ControlDO extends PlatformControlDO {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // The production cron handler, on demand: wrangler dev runs no cron by itself.
    if (new URL(request.url).pathname === "/__e2e/cron") {
      await platform.scheduled?.({} as ScheduledController, env, ctx);
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
