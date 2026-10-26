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
import { objectPorts, StepRunner, type StepSummary } from "../g2/object.ts";
import { recordKill } from "../g2/steps.ts";
import { RunDriver, type RunPorts } from "./driver.ts";
import { INITIAL_RUN, type RunState, type SeedResult } from "./plan.ts";

export { PlatformInternal } from "../../../src/internal/entrypoints.ts";

interface StagingEnv {
  readonly OMNIGENT: DurableObjectNamespace<OmnigentServer>;
  readonly SEEDER: DurableObjectNamespace<Seeder>;
  readonly RUN: DurableObjectNamespace<RestoreRun>;
  readonly RESULTS: R2Bucket;
  readonly SEED_MB?: string;
  /** The run's object: a new name starts a new run on a redeploy (a finished one stays done). */
  readonly RUN_NAME?: string;
  /**
   * G2's 1 GB re-snapshot run (worker/test/staging/g2/resnapshot): "true" adds the G2 probe
   * after the replacement (steps.ts, "resnapshot").
   */
  readonly G2_RESNAPSHOT?: string;
  /** "true": the run waits for WP26_GO = "go" as well as the token (one token, two runs). */
  readonly WP26_HOLD?: string;
  readonly WP26_GO?: string;
}

const SEEDER_PORT = 8080;
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "wp26_staging", event, ...fields }));
}

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

  readonly #steps = new StepRunner(() => ({
    ctx: this.ctx,
    env: this.env as unknown as Record<string, unknown>,
    forward: (request) => this.fetch(request),
  }));

  /** G2: the re-snapshot probe after this run's replacement, as the run's generated owner. */
  async g2Run(step: string): Promise<StepSummary> {
    const env = this.env as unknown as Record<string, unknown>;
    return this.#steps.run(
      step,
      env.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD,
      env.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME,
    );
  }

  /** Kills the server container, as a platform loss would; the watchdog replaces it. */
  async stagingDestroy(): Promise<{ wasRunning: boolean }> {
    const container = this.ctx.container;
    const wasRunning = container?.running ?? false;
    if ((this.env as unknown as StagingEnv).G2_RESNAPSHOT === "true" && wasRunning) {
      // Before the kill (persist before effect): the G2 probe's watch starts from it.
      await recordKill(
        objectPorts({
          ctx: this.ctx,
          env: this.env as unknown as Record<string, unknown>,
          forward: (request) => this.fetch(request),
        }),
        "resnapshot",
      );
    }
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

/** The run: one per deployment. Its ticks go through one driver, one at a time. */
export class RestoreRun extends DurableObject<StagingEnv> {
  readonly #driver = new RunDriver(this.#ports());

  async status(): Promise<RunState> {
    return (await this.ctx.storage.get<RunState>("run")) ?? INITIAL_RUN;
  }

  tick(): Promise<void> {
    return this.#driver.tick();
  }

  override async alarm(): Promise<void> {
    await this.#driver.tick();
  }

  #ports(): RunPorts {
    const seeder = () => this.env.SEEDER.getByName("seeder");
    // The server object is not touched before the seeding ends: its constructor arms the
    // watchdog, which would start a server on a replica still being written.
    const server = () => this.env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    const outagesSince = (from: number) =>
      server().outages({
        ...call,
        from: new Date(from - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      });
    return {
      load: () => this.ctx.storage.get<RunState>("run"),
      save: (state) => this.ctx.storage.put("run", state),
      now: () => Date.now(),
      observe: async (state) => {
        const env = this.env as unknown as Record<string, unknown>;
        const seeding = state.stage === "seeding";
        const serverUsed = state.firstStartAt !== null;
        const [seederRunning, seedResult, serverState, outages] = await Promise.all([
          seeding ? seeder().running() : Promise.resolve(false),
          seeding ? seeder().result() : Promise.resolve(null),
          serverUsed ? server().stagingState() : Promise.resolve(null),
          serverUsed && state.killedAt !== null
            ? outagesSince(state.killSentAt ?? state.killedAt)
            : Promise.resolve([]),
        ]);
        return {
          tokenPresent:
            typeof env.SERVER_ENV_LITESTREAM_ACCESS_KEY_ID === "string" &&
            typeof env.SERVER_ENV_LITESTREAM_SECRET_ACCESS_KEY === "string" &&
            // G2: one token for two runs; this one starts only when released.
            (this.env.WP26_HOLD !== "true" || this.env.WP26_GO === "go"),
          seederRunning,
          seedResult,
          serverLastAnsweredAt: serverState?.lastAnsweredAt ?? null,
          outages: outages.map((o) => ({
            detectedAt: Date.parse(o.detectedAt),
            endedAt: o.endedAt === null ? null : Date.parse(o.endedAt),
          })),
        };
      },
      startSeeder: () => seeder().start(Number(this.env.SEED_MB ?? "1200")),
      stopSeeder: () => seeder().stop(),
      ensureServer: () => server().ensureStarted(call),
      destroyServer: () => server().stagingDestroy(),
      writeSummary: async (state) => {
        const outages = state.firstStartAt ? await outagesSince(state.t0 ?? Date.now()) : [];
        const seconds = (from: number | null, to: number | null) =>
          from === null || to === null ? null : Math.round((to - from) / 100) / 10;
        const summary = {
          ...state,
          firstStartToAnswerSeconds: seconds(state.firstStartAt, state.firstAnsweredAt),
          killToAnswerSeconds: seconds(
            state.killSentAt ?? state.killedAt,
            state.replacedAnsweredAt,
          ),
          outages,
        };
        await this.env.RESULTS.put(
          `results/${state.runId || "run"}/summary.json`,
          JSON.stringify(summary, null, 2),
        );
      },
      log,
      scheduleNext: (at) => this.ctx.storage.setAlarm(at),
    };
  }
}

export default {
  async scheduled(_controller, env, ctx): Promise<void> {
    const run = env.RUN.getByName(env.RUN_NAME ?? "run");
    await run.tick();
    // G2: the probe, only once the run has killed the server (before that, touching the server
    // object would arm its watchdog on a replica still being seeded).
    if (env.G2_RESNAPSHOT !== "true" || (await run.status()).killSentAt === null) return;
    const server = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    ctx.waitUntil(
      server.g2Run("resnapshot").then(
        (result) => log("g2_tick", { result }),
        (error: unknown) => log("g2_tick_error", { error: String(error).slice(0, 200) }),
      ),
    );
  },
  async fetch(request, env): Promise<Response> {
    // Behind the staging tool's owner-only Access application; read-only.
    if (new URL(request.url).pathname !== "/" || request.method !== "GET") {
      return new Response("not found", { status: 404 });
    }
    return Response.json(await env.RUN.getByName(env.RUN_NAME ?? "run").status(), {
      headers: { "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<StagingEnv>;
