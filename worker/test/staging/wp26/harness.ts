// WP2.6 staging harness (test code, never shipped): the representative 1 GB restore through the
// production OmnigentServer watchdog and the final server image, on `basic`, against R2.
//
//   - OmnigentServer: the production class, unchanged, with two staging-only calls (its stored
//     watchdog state, and a container kill for the replacement). Its container is the final
//     image, built from images/server/Dockerfile exactly as the platform Worker builds it.
//   - Seeder: a container of the same image that grows a fresh installation's database to the
//     target size beside its running server, waits until R2 covers every commit, stops that
//     server with a confirmed final sync, and reports (seeder/seed.py).
//   - RestoreRun: the run (plan.ts), ticked by the cron every minute and by its own alarm. It
//     starts as soon as the owner's R2 token is on the Worker (run.sh token): no click.
//
// Results: console lines {"cfo":"wp26_staging",...} and the watchdog's own lines in Workers Logs
// (invocation logs are off: they would record request headers), and results/<run>/summary.json
// in the bucket. No credential is logged or stored in a result.

import { DurableObject } from "cloudflare:workers";
import { OmnigentServer as PlatformOmnigentServer } from "../../../src/server/OmnigentServer.ts";
import { serverContainerEnv } from "../../../src/server/server-env.ts";
import {
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../../src/shared/rpc.ts";
import { type Action, decide, INITIAL_RUN, type RunState, type SeedResult } from "./plan.ts";

export { PlatformInternal } from "../../../src/server/platform-internal.ts";

interface StagingEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
  readonly SEEDER: DurableObjectNamespace<Seeder>;
  readonly RUN: DurableObjectNamespace<RestoreRun>;
  readonly RESULTS: R2Bucket;
  readonly SEED_MB?: string;
}

const TICK_MS = 15_000;
const SEEDER_PORT = 8080;
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "wp26_staging", event, ...fields }));
}

const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** The production class, with the harness's two calls. */
export class OmnigentServer extends PlatformOmnigentServer {
  /** The watchdog's stored state, as the production object keeps it. */
  async stagingState(): Promise<{ lastAnsweredAt: number | null; phase: string | null }> {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM server_state WHERE key = 'watchdog'")
      .toArray()[0];
    if (row === undefined) return { lastAnsweredAt: null, phase: null };
    const state = JSON.parse(row.value) as { lastAnsweredAt?: number | null; phase?: string };
    return { lastAnsweredAt: state.lastAnsweredAt ?? null, phase: state.phase ?? null };
  }

  /** Kills the server container, as a platform loss would; the watchdog replaces it. */
  async stagingDestroy(): Promise<{ wasRunning: boolean }> {
    const container = this.ctx.container;
    const wasRunning = container?.running ?? false;
    if (container && wasRunning) await container.destroy("wp26 staging: the replacement");
    return { wasRunning };
  }
}

/** The seeder: one container of the server image, run once before the production server. */
export class Seeder extends DurableObject<StagingEnv> {
  async start(seedMb: number): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container configured for Seeder");
    if (container.running) return;
    // The server's own environment, as OmnigentServer passes it, for a fresh installation.
    const { vars } = serverContainerEnv(this.env as unknown as Record<string, unknown>);
    container.start({
      enableInternet: true,
      env: { ...vars, CFO_INSTALLATION_INITIALIZED: "false", SEED_MB: String(seedMb) },
    });
    await container.setInactivityTimeout(2 * 3_600_000);
  }

  async running(): Promise<boolean> {
    return this.ctx.container?.running ?? false;
  }

  /** The seeder's report once it finished, else null. Never throws. */
  async result(): Promise<SeedResult | null> {
    const container = this.ctx.container;
    if (!container?.running) return null;
    try {
      const response = await container
        .getTcpPort(SEEDER_PORT)
        .fetch("http://seeder/result", { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      const body = (await response.json()) as {
        done?: boolean;
        ok?: boolean;
        detail?: string;
        fields?: Record<string, number | string | boolean | null>;
      };
      if (body.done !== true) return null;
      return { ok: body.ok === true, detail: String(body.detail ?? ""), fields: body.fields ?? {} };
    } catch {
      return null;
    }
  }

  async stop(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy("wp26 staging: seeded");
  }
}

/** The run: one per deployment. */
export class RestoreRun extends DurableObject<StagingEnv> {
  async status(): Promise<RunState> {
    return (await this.ctx.storage.get<RunState>("run")) ?? INITIAL_RUN;
  }

  async tick(): Promise<void> {
    try {
      await this.#tick();
    } catch (error) {
      log("tick_error", { error: describe(error) });
    }
  }

  override async alarm(): Promise<void> {
    await this.tick();
  }

  async #tick(): Promise<void> {
    const state = await this.status();
    if (state.stage === "done" && state.summaryWritten) return;
    const env = this.env as unknown as Record<string, unknown>;
    const seeder = this.env.SEEDER.getByName("seeder");
    const server = this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    const serverUsed = state.firstStartAt !== null;
    const [seederRunning, seedResult, serverState, outages] = await Promise.all([
      state.stage === "seeding" ? seeder.running() : Promise.resolve(false),
      state.stage === "seeding" ? seeder.result() : Promise.resolve(null),
      // The server object is not touched before the seeding ends: its constructor arms the
      // watchdog, which would start a server on a replica still being written.
      serverUsed ? server.stagingState() : Promise.resolve(null),
      serverUsed && state.killedAt !== null
        ? server.outages({
            ...call,
            from: new Date(state.killedAt - 60_000).toISOString(),
            to: new Date(Date.now() + 60_000).toISOString(),
          })
        : Promise.resolve([]),
    ]);
    const now = Date.now();
    const step = decide(state, {
      now,
      tokenPresent:
        typeof env.SERVER_ENV_LITESTREAM_ACCESS_KEY_ID === "string" &&
        typeof env.SERVER_ENV_LITESTREAM_SECRET_ACCESS_KEY === "string",
      seederRunning,
      seedResult,
      serverLastAnsweredAt: serverState?.lastAnsweredAt ?? null,
      outages: outages.map((o) => ({
        detectedAt: Date.parse(o.detectedAt),
        endedAt: o.endedAt === null ? null : Date.parse(o.endedAt),
      })),
    });
    let next = step.state;
    await this.ctx.storage.put("run", next); // persist before effect
    for (const action of step.actions) next = await this.#apply(action, next);
    if (next !== step.state) await this.ctx.storage.put("run", next);
    if (!(next.stage === "done" && next.summaryWritten) && next.stage !== "waiting_token") {
      await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    }
  }

  async #apply(action: Action, state: RunState): Promise<RunState> {
    const seeder = this.env.SEEDER.getByName("seeder");
    const server = this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    switch (action.type) {
      case "log":
        log(action.event, { runId: state.runId, ...action.fields });
        return state;
      case "start_seeder":
        await seeder.start(Number(this.env.SEED_MB ?? "1200"));
        return state;
      case "stop_seeder":
        await seeder.stop();
        return state;
      case "ensure_server":
        await server.ensureStarted(call);
        return state;
      case "destroy_server":
        log("destroy", { runId: state.runId, ...(await server.stagingDestroy()) });
        return state;
      case "write_summary": {
        const outages = state.firstStartAt
          ? await server.outages({
              ...call,
              from: new Date((state.t0 ?? Date.now()) - 60_000).toISOString(),
              to: new Date(Date.now() + 60_000).toISOString(),
            })
          : [];
        const seconds = (from: number | null, to: number | null) =>
          from === null || to === null ? null : Math.round((to - from) / 100) / 10;
        const summary = {
          ...state,
          firstStartToAnswerSeconds: seconds(state.firstStartAt, state.firstAnsweredAt),
          killToAnswerSeconds: seconds(state.killedAt, state.replacedAnsweredAt),
          outages,
        };
        await this.env.RESULTS.put(
          `results/${state.runId || "run"}/summary.json`,
          JSON.stringify(summary, null, 2),
        );
        log("summary_written", { runId: state.runId });
        return { ...state, summaryWritten: true };
      }
    }
  }
}

export default {
  async scheduled(_controller, env): Promise<void> {
    await env.RUN.getByName("run").tick();
  },
  async fetch(request, env): Promise<Response> {
    // Behind the staging tool's owner-only Access application; read-only.
    if (new URL(request.url).pathname !== "/" || request.method !== "GET") {
      return new Response("not found", { status: 404 });
    }
    return Response.json(await env.RUN.getByName("run").status(), {
      headers: { "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<StagingEnv>;
