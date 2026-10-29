/**
 * The platform Worker as the password page's local end-to-end run uses it (WP3.34,
 * `password-e2e.ts`, `wrangler dev`, never deployed): the production OmnigentServer, whose
 * container port reaches the server image's real container, started by the run with Docker, on
 * the ports it publishes on the loopback interface (`CFO_E2E_SERVER_PORTS`). The container was
 * started by the run, so the object adopts it as if it had started it with this version's
 * configuration: the start fingerprint is recorded once, and the watchdog does not replace it.
 * Everything else, the forwarding path, the watchdog's reads and the password page's platform
 * call included, is production code. WorkspaceDO and ControlDO are the production classes, for the
 * web Worker's bindings; the run does not use them.
 */
import { WorkspaceDO as PlatformWorkspaceDO } from "../../src/computer/WorkspaceDO.ts";
import { ControlDO as PlatformControlDO } from "../../src/control/ControlDO.ts";
import type { PlatformEnv } from "../../src/env.ts";
import type { ContainerExit, ServerContainer } from "../../src/server/container-port.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../src/server/OmnigentServer.ts";
import { startFingerprint } from "../../src/server/server-env.ts";

type Env = PlatformEnv & { readonly CFO_E2E_SERVER_PORTS?: string };

/** The real container's ports, as Docker published them. */
class LocalContainer implements ServerContainer {
  running = true;
  readonly #ports: Readonly<Record<string, number>>;
  constructor(ports: Readonly<Record<string, number>>) {
    this.#ports = ports;
  }

  start(): void {
    // The run started the container; a second start would be a bug in the run.
    throw new Error("the e2e container is started by the run");
  }
  watch(_onExit: (exit: ContainerExit) => void): void {}
  async fetch(port: number, request: Request): Promise<Response> {
    const local = this.#ports[String(port)];
    if (local === undefined) throw new Error(`The container is not listening on port ${port}`);
    const url = new URL(request.url);
    try {
      return await fetch(`http://127.0.0.1:${local}${url.pathname}${url.search}`, request);
    } catch (error) {
      // As the runtime says it for a container that does not listen.
      throw new Error(
        `The container is not listening on the TCP address 10.0.0.1:${port}: ${String(error)}`,
      );
    }
  }
  async destroy(): Promise<void> {}
  signal(): void {}
  async setInactivityTimeout(): Promise<void> {}
  async interceptOutboundHttp(): Promise<void> {}
}

export class OmnigentServer extends PlatformOmnigentServer {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const fingerprint = await startFingerprint(env as unknown as Record<string, unknown>, null);
      ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO server_state (key, value) VALUES ('start_config', ?)",
        JSON.stringify(fingerprint),
      );
    });
  }

  protected override openContainer(): ServerContainer {
    const ports = JSON.parse((this.env as Env).CFO_E2E_SERVER_PORTS ?? "{}") as Record<
      string,
      number
    >;
    return new LocalContainer(ports);
  }

  protected override serverImage(): string | null {
    return null;
  }
}

export class WorkspaceDO extends PlatformWorkspaceDO {}
export class ControlDO extends PlatformControlDO {}

export default {
  fetch: async () => new Response("not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
