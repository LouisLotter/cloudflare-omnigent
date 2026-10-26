// G2 sitting (test code, never shipped): the platform Worker's entry for the sitting's harness.
// It is the production platform Worker (src/index.ts) with one addition: OmnigentServer is the
// production class plus one staging call, `g2Run`, which runs the sitting's steps (steps.ts)
// on the production object: a container kill that the production watchdog then repairs, and
// timed requests through the production forward. The cron runs the production `scheduled`
// first, then the step named by the Worker secret G2_STEP (run.sh sets it).
//
// Deployed only by run.sh through the guarded staging tool, after the bootstrap has installed
// the production Workers (deploy.ts renders the bootstrap's own configuration with this entry).

import type { PlatformEnv } from "../../../src/env.ts";
import platform, { OmnigentServer as ProductionOmnigentServer } from "../../../src/index.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../../src/shared/rpc.ts";
import { log, StepRunner, type StepSummary } from "./object.ts";

// Every other class and entrypoint of the production platform Worker, unchanged.
export {
  ComputerApi,
  ControlDO,
  DirectoryBackupGateway,
  OmnigentRoute,
  PlatformInternal,
  WorkspaceDO,
} from "../../../src/index.ts";

/** The staging-only settings: secrets that never reach the container (no SERVER_ENV_ prefix). */
interface G2Settings {
  readonly G2_STEP?: string;
  readonly G2_OWNER_PASSWORD?: string;
}

type G2Env = Omit<PlatformEnv, "OMNIGENT"> &
  G2Settings & { readonly OMNIGENT: DurableObjectNamespace<OmnigentServer> };

export class OmnigentServer extends ProductionOmnigentServer {
  readonly #steps = new StepRunner(() => ({
    ctx: this.ctx,
    env: this.env as unknown as Record<string, unknown>,
    forward: (request) => this.fetch(request),
  }));

  /** Runs (or resumes) one step of the sitting (steps.ts). */
  async g2Run(step: string): Promise<StepSummary> {
    const env = this.env as unknown as G2Settings & Record<string, unknown>;
    return this.#steps.run(
      step,
      env.G2_OWNER_PASSWORD,
      env.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME,
    );
  }
}

export default {
  fetch: platform.fetch,

  /** The production cron first (the always-on backstop), then the sitting's step, if any. */
  async scheduled(controller, env, ctx): Promise<void> {
    await platform.scheduled?.(controller, env as unknown as Env, ctx);
    const step = env.G2_STEP;
    if (!step) return;
    const server = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME);
    ctx.waitUntil(
      (async () => {
        try {
          log("tick", { result: await server.g2Run(step) });
        } catch (error) {
          // Before the object runs this build (a version switch pending), g2Run is unknown.
          log("tick_error", { step, error: String(error).slice(0, 200) });
        }
      })(),
    );
  },
} satisfies ExportedHandler<G2Env>;
