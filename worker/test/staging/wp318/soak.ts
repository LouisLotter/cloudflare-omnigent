// WP3.18 staging soak (RC-26): the platform Worker as the soak deploys it. Test code only, never
// shipped. Every production class, entrypoint and handler runs unchanged; this module adds only
// staging-only parts, reachable only on the platform Worker's own staging hostname, which the
// guarded staging tool puts behind an owner-only Access application:
//   - `OmnigentServer.stagingReset` and `WorkspaceDO.stagingReset`: a forced reset (ctx.abort),
//     the disruption RC-26 and FH-36 name, without a deploy;
//   - SoakRun: the schedule (plan.ts), started by the owner's Start click on /__soak, ticked by
//     the production cron; its events go to Workers Logs and the results bucket. Around each
//     platform deploy it has OmnigentServer log a heartbeat every 5 s, which brackets that
//     object's version switch.
//   - the G3 sitting's one-shot commands (WP3.33, commands.ts): `computer-kill`, `workspace-reset`,
//     `server-reset`, `soak-start` and the read-only `limits`, which run.sh writes into the results
//     bucket and the cron hands to SoakRun, which runs each once and records its outcome. The kill is WorkspaceDO's
//     production `stagingKill`, refused unless the bootstrap marked the installation as staging;
//   - `OmnigentServer.m3Replace`: the M3 sitting's forced server replacement (WP3.19, lead only),
//     G2's `replace-2` step (../g2/steps.ts) on the production object: the container destroyed,
//     the production watchdog's start under the `durable_object` policy, timed to the new boot's
//     readiness, then the configuration (environment, image, size), /health, /v1/info and the
//     replica. The cron runs it while the Worker secret M3_STEP is `replace` (`run.sh replace`
//     sets it), and never once a soak run exists. Its lines are G2's (`"cfo":"g2_sitting"`).
// The launcher's signing key, set after the bootstrap, reaches the server through the watchdog's
// controlled restart (G2-SEC-001's `config_changed`); run.sh waits for it, so this module needs no
// restart of its own.
// soak-config.ts renders the configuration: the bootstrap's own, with this module as main, the
// SOAK binding and the RESULTS bucket added. The setup terminal is the platform pages' own (WP3.5:
// the web Worker's /platform/computers/<computer>, bridged in WorkspaceDO); this module never
// overrides WorkspaceDO's `fetch`, so the soak runs the production bridge.

import { DurableObject } from "cloudflare:workers";
import { WORKSPACE_INTERFACE_VERSION } from "@cfo/contracts";
import { WorkspaceDO as PlatformWorkspaceDO } from "../../../src/computer/WorkspaceDO.ts";
import production from "../../../src/index.ts";
import { OmnigentServer as PlatformOmnigentServer } from "../../../src/server/OmnigentServer.ts";
import { logEvent } from "../../../src/server/responses.ts";
import { CONTROL_OBJECT_NAME, OMNIGENT_SERVER_OBJECT_NAME } from "../../../src/shared/rpc.ts";
import { StepRunner, type StepSummary, log as stepLog } from "../g2/object.ts";
import {
  COMMAND_PREFIX,
  COMMANDS_LOG_KEY,
  type CommandResult,
  type RunOutcome,
  resetOutcome,
  resultKey,
  runCommands,
  type SoakCommand,
} from "./commands.ts";
import { dueEvents, nextHeartbeat, SOAK_SCHEDULE, type SoakEventKind } from "./plan.ts";

export { ControlDO } from "../../../src/control/ControlDO.ts";
export { DirectoryBackupGateway } from "../../../src/egress/backups.ts";
export { ComputerApi, OmnigentRoute, PlatformInternal } from "../../../src/internal/entrypoints.ts";

interface SoakEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
  readonly WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  readonly CONTROL: DurableObjectNamespace;
  readonly SOAK: DurableObjectNamespace<SoakRun>;
  readonly RESULTS: R2Bucket;
  /** Omnigent's public URL (the web Worker's hostname), set by the bootstrap. */
  readonly SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL?: string;
  /** `replace`: the forced server replacement before the soak (a secret, never the server's). */
  readonly M3_STEP?: string;
}

export class OmnigentServer extends PlatformOmnigentServer {
  readonly #steps = new StepRunner(() => ({
    ctx: this.ctx,
    env: this.env as unknown as Record<string, unknown>,
    forward: (request) => this.fetch(request),
    outages: (query) => this.outages(query),
  }));

  /** Runs (or resumes) the forced replacement, G2's `replace-2` (staging only). */
  async m3Replace(): Promise<StepSummary> {
    const env = this.env as unknown as Record<string, unknown>;
    return this.#steps.run(
      "replace-2",
      undefined,
      env.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME,
    );
  }

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
}

export class WorkspaceDO extends PlatformWorkspaceDO {
  /** A forced reset of this object (staging only): the container keeps running (FH-36). */
  async stagingReset(reason: string): Promise<void> {
    logEvent("soak", "workspace_reset", { reason });
    this.ctx.abort(reason);
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

  /**
   * The lead's commands and the soak's start run one at a time (Codex WP3.33 r1-2): a command is
   * decided and run with no soak starting in between, whichever path starts it.
   */
  #queue: Promise<unknown> = Promise.resolve();

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** The owner's Start click (or `run.sh soak-start`): T0 is now. Never restarted. */
  start(): Promise<SoakState> {
    return this.#serial(() => this.#start());
  }

  async #start(): Promise<SoakState> {
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

  /**
   * Each cron minute: the lead's one-shot commands (WP3.33, commands.ts). Each is claimed in this
   * object's storage before it runs, in one SQL statement, so two passes at once (the cron firing
   * twice) never both run it, and passes run one at a time with the soak's start. Returns how
   * many outcomes this pass recorded.
   */
  commands(): Promise<number> {
    return this.#serial(() => this.#commands());
  }

  async #commands(): Promise<number> {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS soak_commands (
         id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL, result TEXT)`,
    );
    const results = this.env.RESULTS;
    const recorded = await runCommands({
      now: () => Date.now(),
      list: async () => {
        const listed = await results.list({ prefix: COMMAND_PREFIX, limit: 100 });
        return listed.objects.map((o) => o.key);
      },
      read: async (key) => (await results.get(key))?.text() ?? null,
      remove: (key) => results.delete(key),
      claim: (id, at) => {
        const inserted = sql
          .exec(
            "INSERT INTO soak_commands (id, claimed_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING RETURNING id",
            id,
            at,
          )
          .toArray();
        if (inserted.length > 0) return { fresh: true };
        const row = sql
          .exec<{ claimed_at: number; result: string | null }>(
            "SELECT claimed_at, result FROM soak_commands WHERE id = ?",
            id,
          )
          .one();
        return {
          fresh: false,
          claimedAt: row.claimed_at,
          result: row.result === null ? null : (JSON.parse(row.result) as CommandResult),
        };
      },
      record: (result) => {
        sql.exec(
          "UPDATE soak_commands SET result = ? WHERE id = ?",
          JSON.stringify(result),
          result.id,
        );
      },
      publish: async (result) => {
        await results.put(resultKey(result.id), JSON.stringify(result));
        const all = sql
          .exec<{ result: string }>(
            "SELECT result FROM soak_commands WHERE result IS NOT NULL ORDER BY claimed_at, id",
          )
          .toArray()
          .map((r) => JSON.parse(r.result) as unknown);
        await results.put(COMMANDS_LOG_KEY, JSON.stringify(all));
      },
      soak: async () => {
        const state = await this.#state();
        return state === null ? null : { runId: state.runId, ended: state.ended };
      },
      computers: async () => {
        const control = this.env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as {
          control(call: unknown): Promise<{ computers?: { computerId: string }[] }>;
        };
        const listed = await control.control({ method: "list_computers", interfaceVersion: 1 });
        return (listed.computers ?? []).map((c) => c.computerId);
      },
      run: (command) => this.#run(command),
      log: (event, fields) => logEvent("soak", event, fields),
    });
    return recorded.length;
  }

  /** One command's effect (decided and claimed by `runCommands`). */
  async #run(command: SoakCommand): Promise<RunOutcome> {
    const reason = `soak command ${command.id}`;
    // A forced reset ends the callee's invocation (ctx.abort): its call rejects with the reset's
    // own message, which is the outcome looked for (resetOutcome).
    const reset = (call: Promise<void>) =>
      call.then(
        () => resetOutcome(reason, { ok: true }),
        (error: unknown) => resetOutcome(reason, { ok: false, error }),
      );
    switch (command.command) {
      case "soak-start": {
        const state = await this.#start();
        return { outcome: "ok", detail: { runId: state.runId, t0: state.t0 } };
      }
      case "limits": {
        // Read-only: the limits ControlDO answers with now, from its own environment.
        const control = this.env.CONTROL.getByName(CONTROL_OBJECT_NAME) as unknown as {
          control(
            call: unknown,
          ): Promise<{ maxAwakeComputers?: unknown; maxInstanceSize?: unknown }>;
        };
        const limits = await control.control({ method: "limits", interfaceVersion: 1 });
        return {
          outcome: "ok",
          detail: {
            maxAwakeComputers: limits.maxAwakeComputers ?? null,
            maxInstanceSize: limits.maxInstanceSize ?? null,
          },
        };
      }
      case "server-reset":
        return reset(this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).stagingReset(reason));
      case "workspace-reset":
        return reset(this.env.WORKSPACE.getByName(command.computerId ?? "").stagingReset(reason));
      case "computer-kill": {
        const killed = await this.env.WORKSPACE.getByName(command.computerId ?? "").stagingKill({
          interfaceVersion: WORKSPACE_INTERFACE_VERSION,
        });
        if (killed.outcome !== "killed") return { outcome: "refused", reason: killed.reason };
        // The host ID's first 8 characters only: enough to see it unchanged after the wake
        // (RC-10), and not the 32-hex form the redaction masks.
        return {
          outcome: "ok",
          detail: { generation: killed.generation, host: killed.hostId?.slice(0, 8) ?? null },
        };
      }
    }
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

function page(status: unknown, list: unknown[], web: string | null): Response {
  // The setup page is the platform pages' own, on the web Worker's hostname (WP3.5).
  const setup = (id: string) =>
    web === null ? "" : ` <a href="${web}/platform/computers/${id}">set up this computer</a>`;
  const rows = (list as { computerId: string; name: string }[])
    .map(
      (c) =>
        `<li><code>${c.computerId}</code> ${c.name.replace(/[<>&"]/g, "")}${setup(c.computerId)}</li>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><title>WP3.18 soak</title>
<h1>WP3.18 soak (staging only)</h1>
<form method="post" action="/__soak/start"><button>Start the 3-hour soak (T0 = now)</button></form>
<h2>Computers</h2><ul>${rows}</ul>
<h2>Status</h2><pre>${JSON.stringify(status, null, 2).replace(/[<>&]/g, "")}</pre>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/** The web Worker's origin, from the bootstrap's setting; null if it is not a plain https origin. */
function webOrigin(env: SoakEnv): string | null {
  const base = env.SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL;
  return base !== undefined && /^https:\/\/[a-z0-9.-]+$/.test(base) ? base : null;
}

async function soakRoute(request: Request, env: SoakEnv): Promise<Response> {
  const url = new URL(request.url);
  const run = env.SOAK.getByName("soak");
  if (request.method === "POST") {
    // Same-origin form posts only (the hostname is behind owner-only Access as well).
    if (request.headers.get("origin") !== url.origin) {
      return new Response("Forbidden.", { status: 403 });
    }
    if (url.pathname === "/__soak/start") await run.start();
    else return new Response("Not found.", { status: 404 });
    return Response.redirect(`${url.origin}/__soak`, 303);
  }
  const status = await run.status();
  if (url.pathname === "/__soak/status") return Response.json(status);
  if (url.pathname === "/__soak") return page(status, await computers(env), webOrigin(env));
  return new Response("Not found.", { status: 404 });
}

/**
 * The forced replacement, once a minute until it is done: never once a soak run exists, where a
 * kill would be a disruption RC-26 does not schedule. A finished step logs nothing more.
 */
async function replaceBeforeTheSoak(env: SoakEnv): Promise<void> {
  try {
    if ((await env.SOAK.getByName("soak").status()) !== null) return;
    const result = await env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME).m3Replace();
    if (result.stage !== "done" && result.stage !== "failed") stepLog("tick", { result });
  } catch (error) {
    // Before the object runs this build (a version switch pending), m3Replace is unknown.
    stepLog("tick_error", { step: "replace-2", error: String(error).slice(0, 200) });
  }
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
    const soak = env as unknown as SoakEnv;
    ctx.waitUntil(soak.SOAK.getByName("soak").tick());
    // The lead's one-shot commands (WP3.33): each runs once, within a minute.
    ctx.waitUntil(
      soak.SOAK.getByName("soak")
        .commands()
        .then(
          () => undefined,
          (error: unknown) =>
            logEvent("soak", "commands_failed", { error: String(error).slice(0, 200) }),
        ),
    );
    if (soak.M3_STEP === "replace") ctx.waitUntil(replaceBeforeTheSoak(soak));
  },
} satisfies ExportedHandler<Env>;
