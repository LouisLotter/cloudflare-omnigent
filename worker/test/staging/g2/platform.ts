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
import platform, {
  ControlDO,
  PlatformInternal,
  OmnigentServer as ProductionOmnigentServer,
} from "../../../src/index.ts";
import {
  bootstrapSecretPresent,
  configFingerprint,
  serverContainerEnv,
} from "../../../src/server/server-env.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../../src/shared/rpc.ts";
import {
  type ConfigView,
  type EntrypointStatus,
  type G2Ports,
  type HttpAnswer,
  type HttpInit,
  type KeptSession,
  type Position,
  runStep,
  STEP_NAMES,
  type StepName,
  type StepRecord,
} from "./steps.ts";

export { ControlDO, PlatformInternal };

/** The staging-only settings: secrets that never reach the container (no SERVER_ENV_ prefix). */
interface G2Settings {
  readonly G2_STEP?: string;
  readonly G2_OWNER_PASSWORD?: string;
}

type G2Env = Omit<PlatformEnv, "OMNIGENT"> &
  G2Settings & { readonly OMNIGENT: DurableObjectNamespace<OmnigentServer> };

const CONTROL_PORT = 8001;
/** The watchdog's record of the configuration a container was started with (OmnigentServer). */
const START_CONFIG_KEY = "start_config";
const KEPT_KEY = "g2:kept";

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "g2_sitting", event, ...fields }));
}

/** What a tick reports: the step's progress, never a credential. */
export interface StepSummary {
  readonly step: string;
  readonly stage: string;
  readonly waiting?: string;
  readonly failure?: string;
  readonly invocations?: number;
}

function summary(record: StepRecord): StepSummary {
  return {
    step: record.step,
    stage: record.stage,
    ...(record.waiting ? { waiting: record.waiting } : {}),
    ...(record.failure ? { failure: record.failure } : {}),
    invocations: record.invocations,
  };
}

export class OmnigentServer extends ProductionOmnigentServer {
  #g2: Promise<StepRecord> | null = null;

  /** Runs (or resumes) one step; a second call while one runs only reports. */
  async g2Run(step: string): Promise<StepSummary> {
    if (!(STEP_NAMES as readonly string[]).includes(step)) {
      return { step, stage: "unknown step" };
    }
    if (this.#g2 !== null) return { step, stage: "running in this instance" };
    const env = this.env as unknown as G2Settings & Record<string, unknown>;
    const owner = env.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME;
    this.#g2 = runStep(this.#ports(), {
      step: step as StepName,
      ownerPassword: env.G2_OWNER_PASSWORD,
      ownerUsername: typeof owner === "string" ? owner : "owner",
    }).finally(() => {
      this.#g2 = null;
    });
    return summary(await this.#g2);
  }

  /** Every step's record, for the run's status line. Records hold no credential. */
  async g2Records(): Promise<StepRecord[]> {
    const found = await this.ctx.storage.list<StepRecord>({ prefix: "g2:step:" });
    return [...found.values()];
  }

  #container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("no container configured for OmnigentServer");
    return container;
  }

  async #control(path: string): Promise<Response | null> {
    const container = this.ctx.container;
    if (!container?.running) return null;
    try {
      return await container
        .getTcpPort(CONTROL_PORT)
        .fetch(`http://container${path}`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      return null;
    }
  }

  #ports(): G2Ports {
    const env = this.env as unknown as Record<string, unknown>;
    const base = String(env.SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL ?? "https://g2-sitting.invalid");
    return {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      running: () => this.ctx.container?.running ?? false,
      destroy: async () => {
        const container = this.#container();
        if (container.running) await container.destroy("g2 sitting: the replacement");
      },
      status: async () => {
        const response = await this.#control("/status");
        if (response?.status !== 200) {
          await response?.body?.cancel();
          return null;
        }
        return (await response.json()) as EntrypointStatus;
      },
      position: async () => {
        const response = await this.#control("/position");
        if (response === null) return { status: 0, body: null };
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: response.status, body: null };
        }
        return { status: 200, body: (await response.json()) as Position };
      },
      http: (method, path, init) => this.#http(base, method, path, init),
      config: async (): Promise<ConfigView> => {
        const row = this.ctx.storage.sql
          .exec<{ value: string }>("SELECT value FROM server_state WHERE key = ?", START_CONFIG_KEY)
          .toArray()[0];
        let startedWith: string | null = null;
        try {
          const parsed: unknown = row === undefined ? null : JSON.parse(row.value);
          startedWith = typeof parsed === "string" ? parsed : null;
        } catch {
          startedWith = null;
        }
        const initialized = env.SERVER_ENV_CFO_INSTALLATION_INITIALIZED;
        const replicaUrl = env.SERVER_ENV_CFO_REPLICA_URL;
        return {
          startedWith,
          current: await configFingerprint(serverContainerEnv(env).vars),
          initialized: typeof initialized === "string" ? initialized : null,
          bootstrapPassword: bootstrapSecretPresent(env),
          replicaUrl: typeof replicaUrl === "string" ? replicaUrl : null,
        };
      },
      load: (step) => this.ctx.storage.get<StepRecord>(`g2:step:${step}`),
      save: (record) => this.ctx.storage.put(`g2:step:${record.step}`, record),
      keep: (session) => this.ctx.storage.put(KEPT_KEY, session),
      kept: () => this.ctx.storage.get<KeptSession>(KEPT_KEY),
      forget: async () => {
        await this.ctx.storage.delete(KEPT_KEY);
      },
      log,
    };
  }

  /** One request through the production forward, as the web Worker sends it after ingress. */
  async #http(base: string, method: string, path: string, init?: HttpInit): Promise<HttpAnswer> {
    const headers = new Headers({
      [FORWARD_VERSION_HEADER]: String(OMNIGENT_SERVER_INTERFACE_VERSION),
      "user-agent": "cfo-g2-sitting/1",
    });
    if (init?.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    if (init?.cookie) headers.set("cookie", init.cookie);
    let body: BodyInit | null = null;
    if (init?.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    } else if (init?.upload !== undefined) {
      const form = new FormData();
      const { content, filename, type } = init.upload;
      form.append("file", new File([content], filename, { type }));
      body = form;
    }
    const sent = Date.now();
    const response = await this.fetch(new Request(new URL(path, base), { method, headers, body }));
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const recorded: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") recorded[name] = value;
    });
    return {
      status: response.status,
      headers: recorded,
      cookies: response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? ""),
      json,
      ms: Date.now() - sent,
    };
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
