// WP3.18 staging soak (RC-26): the platform Worker as the soak deploys it. Test code only, never
// shipped. Every production class, entrypoint and handler runs unchanged; this module adds only
// staging-only parts, reachable only on the platform Worker's own staging hostname, which the
// guarded staging tool puts behind an owner-only Access application:
//   - `OmnigentServer.stagingReset` and `WorkspaceDO.stagingReset`: a forced reset (ctx.abort),
//     the disruption RC-26 and FH-36 name, without a deploy;
//   - `OmnigentServer.stagingRestartContainer`: stops the server container once, so the watchdog
//     starts it again with the Worker's current secrets (the launcher's signing key, set after
//     the bootstrap, reaches the server only at its next start);
//   - `WorkspaceDO.fetch` under /__soak/terminal/<computer>/: the computer's setup terminal
//     (ttyd, port 7681), forwarded natively, until the platform pages (WP3.5) provide it;
//   - SoakRun: the schedule (plan.ts), started by the owner's Start click on /__soak, ticked by
//     the production cron; its events go to Workers Logs and the results bucket. Around each
//     platform deploy it has OmnigentServer log a heartbeat every 5 s, which brackets that
//     object's version switch.
// soak-config.ts renders the configuration: the bootstrap's own, with this module as main, the
// SOAK binding and the RESULTS bucket added.

import { DurableObject } from "cloudflare:workers";
import { ComputerId, WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../../src/computer/WorkspaceDO.ts";
import production from "../../../src/index.ts";
import { serverContainerOf } from "../../../src/server/container-port.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../../src/server/OmnigentServer.ts";
import { logEvent } from "../../../src/server/responses.ts";
import { CONTROL_OBJECT_NAME, OMNIGENT_SERVER_OBJECT_NAME } from "../../../src/shared/rpc.ts";
import { dueEvents, nextHeartbeat, SOAK_SCHEDULE, type SoakEventKind } from "./plan.ts";

export { ControlDO } from "../../../src/control/ControlDO.ts";
export { DirectoryBackupGateway } from "../../../src/egress/backups.ts";
export { ComputerApi, OmnigentRoute, PlatformInternal } from "../../../src/internal/entrypoints.ts";

/** The setup terminal's port (the supervisor's ttyd, WP3.4). */
const TERMINAL_PORT = 7681;
const TERMINAL_PREFIX = "/__soak/terminal/";

interface SoakEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  readonly CONTROL: DurableObjectNamespace;
  readonly SOAK: DurableObjectNamespace<SoakRun>;
  readonly RESULTS: R2Bucket;
}

export class OmnigentServer extends PlatformOmnigentServer {
  /** A forced reset of this object (staging only). */
  async stagingReset(reason: string): Promise<void> {
    logEvent("soak", "server_reset", { reason });
    this.ctx.abort(reason);
  }

  /**
   * A heartbeat logged by this object, in the version it runs (staging only): it brackets this
   * object's own version switch, which is what drops every host tunnel (plan.ts).
   */
  async stagingBeat(runId: string): Promise<void> {
    logEvent("soak", "heartbeat", { runId, from: "server" });
  }

  /** Stops the server container once; the watchdog starts it with the current secrets. */
  async stagingRestartContainer(): Promise<boolean> {
    const container = serverContainerOf(this.ctx);
    if (container === null || !container.running) return false;
    logEvent("soak", "server_container_restart", {});
    await container.destroy("soak: start again with the current secrets");
    return true;
  }
}

export class WorkspaceDO extends PlatformWorkspaceDO {
  /** A forced reset of this object (staging only): the container keeps running (FH-36). */
  async stagingReset(reason: string): Promise<void> {
    logEvent("soak", "workspace_reset", { reason });
    this.ctx.abort(reason);
  }

  /** The setup terminal, forwarded natively to the container's ttyd (staging only). */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rest = url.pathname.split("/").slice(4).join("/");
    const container = this.runtimeContainer();
    if (container === null || !container.running) {
      return new Response("The computer is not running.", { status: 503 });
    }
    const target = new URL(`http://computer/${rest}${url.search}`);
    return container.getTcpPort(TERMINAL_PORT).fetch(new Request(target, request));
  }
}

interface SoakState {
  readonly runId: string;
  readonly t0: number;
  readonly done: number[];
  readonly events: { kind: SoakEventKind; at: number; detail?: unknown }[];
  readonly ended: boolean;
}

export class SoakRun extends DurableObject<SoakEnv> {
  async #state(): Promise<SoakState | null> {
    return (await this.ctx.storage.get<SoakState>("state")) ?? null;
  }

  async #save(state: SoakState): Promise<void> {
    await this.ctx.storage.put("state", state);
    const status = { runId: state.runId, t0: state.t0, ended: state.ended, events: state.events };
    await this.env.RESULTS.put("soak/current.json", JSON.stringify(status));
    await this.env.RESULTS.put(`soak/${state.runId}/events.json`, JSON.stringify(status));
  }

  async status(): Promise<SoakState | null> {
    return this.#state();
  }

  /** The owner's Start click: T0 is now. A started run is never restarted. */
  async start(): Promise<SoakState> {
    const existing = await this.#state();
    if (existing !== null) return existing;
    const t0 = Date.now();
    const state: SoakState = {
      runId: `soak-${new Date(t0).toISOString().replace(/[-:.]/g, "")}`,
      t0,
      done: [],
      events: [],
      ended: false,
    };
    logEvent("soak", "start", { runId: state.runId, t0 });
    await this.#save(state);
    await this.#armHeartbeat(t0, t0);
    return state;
  }

  /** The next heartbeat's alarm, if any is left (plan.ts, nextHeartbeat). */
  async #armHeartbeat(t0: number, now: number): Promise<void> {
    const at = nextHeartbeat(t0, now);
    if (at !== null) await this.ctx.storage.setAlarm(at);
  }

  /**
   * The heartbeat around each platform deploy: OmnigentServer logs it in the version it runs, so
   * Workers Logs bracket that object's own switch, independently of any host (plan.ts).
   */
  override async alarm(): Promise<void> {
    const state = await this.#state();
    if (state === null || state.ended) return;
    await this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME)
      .stagingBeat(state.runId)
      .catch((error: unknown) =>
        logEvent("soak", "heartbeat_failed", { error: String(error).slice(0, 120) }),
      );
    await this.#armHeartbeat(state.t0, Date.now());
  }

  /** Each cron minute: the worker's events now due. */
  async tick(): Promise<void> {
    const state = await this.#state();
    if (state === null || state.ended) return;
    const now = Date.now();
    // A heartbeat alarm lost to a reset is set again within a minute.
    if ((await this.ctx.storage.getAlarm()) === null) await this.#armHeartbeat(state.t0, now);
    const due = dueEvents(state.t0, new Set(state.done), now);
    if (due.length === 0) return;
    const done = [...state.done];
    const events = [...state.events];
    let ended = false;
    for (const index of due) {
      const kind = SOAK_SCHEDULE[index]?.kind;
      if (kind === undefined) continue;
      // Recorded before the effect: a reset may end this invocation's callee, never repeated.
      done.push(index);
      const at = Date.now();
      let detail: unknown = null;
      if (kind === "server_reset") {
        detail = await this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME)
          .stagingReset("soak: forced reset")
          .then(
            () => "no error",
            (error: unknown) => String(error).slice(0, 120),
          );
      } else if (kind === "workspace_reset") {
        detail = await this.#resetComputers();
      } else if (kind === "end") {
        ended = true;
      }
      events.push({ kind, at, detail });
      logEvent("soak", kind, { runId: state.runId, at });
    }
    await this.#save({ ...state, done, events, ended });
  }

  async #resetComputers(): Promise<string[]> {
    const control = this.env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as {
      control(call: unknown): Promise<{ computers?: { computerId: string }[] }>;
    };
    const listed = await control.control({ method: "list_computers", interfaceVersion: 1 });
    const reset: string[] = [];
    for (const { computerId } of listed.computers ?? []) {
      await this.env.WORKSPACE.getByName(computerId)
        .stagingReset("soak: forced reset")
        .catch(() => undefined);
      reset.push(computerId);
    }
    return reset;
  }
}

/** The computers the soak page lists, with their identity (read-only). */
async function computers(env: SoakEnv): Promise<unknown[]> {
  const control = env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as {
    control(call: unknown): Promise<{ computers?: { computerId: string; name: string }[] }>;
  };
  const listed = await control.control({ method: "list_computers", interfaceVersion: 1 });
  return Promise.all(
    (listed.computers ?? []).map(async (c) => ({
      ...c,
      identity: await env.WORKSPACE.getByName(c.computerId)
        .identity({ interfaceVersion: WORKSPACE_INTERFACE_VERSION })
        .catch((error: unknown) => String(error).slice(0, 80)),
    })),
  );
}

function page(status: unknown, list: unknown[]): Response {
  const rows = (list as { computerId: string; name: string }[])
    .map(
      (c) =>
        `<li><code>${c.computerId}</code> ${c.name.replace(/[<>&"]/g, "")} ` +
        `<a href="${TERMINAL_PREFIX}${c.computerId}/">setup terminal</a></li>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><title>WP3.18 soak</title>
<h1>WP3.18 soak (staging only)</h1>
<form method="post" action="/__soak/prepare"><button>1. Restart the server with the current secrets</button></form>
<form method="post" action="/__soak/start"><button>2. Start the 3-hour soak (T0 = now)</button></form>
<h2>Computers</h2><ul>${rows}</ul>
<h2>Status</h2><pre>${JSON.stringify(status, null, 2).replace(/[<>&]/g, "")}</pre>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function soakRoute(request: Request, env: SoakEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith(TERMINAL_PREFIX)) {
    const computerId = ComputerId.safeParse(url.pathname.split("/")[3]);
    if (!computerId.success) return new Response("Not found.", { status: 404 });
    return env.WORKSPACE.getByName(computerId.data).fetch(request);
  }
  const run = env.SOAK.getByName("soak");
  if (request.method === "POST") {
    // Same-origin form posts only (the hostname is behind owner-only Access as well).
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Forbidden.", { status: 403 });
    }
    if (url.pathname === "/__soak/start") await run.start();
    else if (url.pathname === "/__soak/prepare") {
      await env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).stagingRestartContainer();
    } else return new Response("Not found.", { status: 404 });
    return Response.redirect(`${url.origin}/__soak`, 303);
  }
  const status = await run.status();
  if (url.pathname === "/__soak/status") return Response.json(status);
  if (url.pathname === "/__soak") return page(status, await computers(env));
  return new Response("Not found.", { status: 404 });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/__soak" || url.pathname.startsWith("/__soak/")) {
      return soakRoute(request, env as unknown as SoakEnv);
    }
    // The production handler: the health check and 404 for everything else.
    const handler = production.fetch as unknown as (
      request: Request,
      env: Env,
      ctx: ExecutionContext,
    ) => Promise<Response>;
    return handler(request as unknown as Request, env, ctx);
  },

  async scheduled(controller, env, ctx): Promise<void> {
    await production.scheduled?.(controller, env, ctx);
    ctx.waitUntil((env as unknown as SoakEnv).SOAK.getByName("soak").tick());
  },
} satisfies ExportedHandler<Env>;
