// G2 sitting (test code, never shipped): the steps' ports (steps.ts) on a production
// OmnigentServer object, shared by the sitting's platform entry (platform.ts) and WP2.6's 1 GB
// harness (../wp26/harness.ts), which subclass the production class. The container is reached
// as the watchdog reaches it (the control port), requests go through the production forward,
// and the records live in the object's own storage. Nothing here logs a credential.

import {
  bootstrapSecretPresent,
  configFingerprint,
  serverContainerEnv,
} from "../../../src/server/server-env.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
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

const CONTROL_PORT = 8001;
/** The watchdog's record of the configuration a container was started with (OmnigentServer). */
export const START_CONFIG_KEY = "start_config";
const KEPT_KEY = "g2:kept";

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ cfo: "g2_sitting", event, ...fields }));
}

/** What the object gives the ports: its state, its environment and its own forward. */
export interface ObjectParts {
  readonly ctx: DurableObjectState;
  readonly env: Readonly<Record<string, unknown>>;
  /** The production OmnigentServer.fetch: the path the web Worker's requests take. */
  readonly forward: (request: Request) => Promise<Response>;
}

/** What a tick reports: the step's progress, never a credential. */
export interface StepSummary {
  readonly step: string;
  readonly stage: string;
  readonly waiting?: string;
  readonly failure?: string;
  readonly invocations?: number;
}

/** Runs the steps on one object instance, one at a time. */
export class StepRunner {
  readonly #parts: () => ObjectParts;
  #active: Promise<StepRecord> | null = null;

  constructor(parts: () => ObjectParts) {
    this.#parts = parts;
  }

  /** Runs (or resumes) one step; a call while one runs in this instance only reports. */
  async run(step: string, ownerPassword: unknown, ownerUsername: unknown): Promise<StepSummary> {
    if (!(STEP_NAMES as readonly string[]).includes(step)) return { step, stage: "unknown step" };
    if (this.#active !== null) return { step, stage: "running in this instance" };
    this.#active = runStep(objectPorts(this.#parts()), {
      step: step as StepName,
      ownerPassword: typeof ownerPassword === "string" ? ownerPassword : undefined,
      ownerUsername: typeof ownerUsername === "string" ? ownerUsername : "owner",
    }).finally(() => {
      this.#active = null;
    });
    const record = await this.#active;
    return {
      step: record.step,
      stage: record.stage,
      ...(record.waiting ? { waiting: record.waiting } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
      invocations: record.invocations,
    };
  }
}

async function control(ctx: DurableObjectState, path: string): Promise<Response | null> {
  const container = ctx.container;
  if (!container?.running) return null;
  try {
    return await container
      .getTcpPort(CONTROL_PORT)
      .fetch(`http://container${path}`, { signal: AbortSignal.timeout(5_000) });
  } catch {
    return null;
  }
}

export function objectPorts({ ctx, env, forward }: ObjectParts): G2Ports {
  const base = String(env.SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL ?? "https://g2-sitting.invalid");
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    running: () => ctx.container?.running ?? false,
    destroy: async () => {
      const container = ctx.container;
      if (!container) throw new Error("no container configured for OmnigentServer");
      if (container.running) await container.destroy("g2 sitting: the replacement");
    },
    status: async () => {
      const response = await control(ctx, "/status");
      if (response?.status !== 200) {
        await response?.body?.cancel();
        return null;
      }
      return (await response.json()) as EntrypointStatus;
    },
    position: async () => {
      const response = await control(ctx, "/position");
      if (response === null) return { status: 0, body: null };
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: response.status, body: null };
      }
      return { status: 200, body: (await response.json()) as Position };
    },
    http: (method, path, init) => request(forward, base, method, path, init),
    config: async (): Promise<ConfigView> => {
      const row = ctx.storage.sql
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
    load: (step) => ctx.storage.get<StepRecord>(`g2:step:${step}`),
    save: (record) => ctx.storage.put(`g2:step:${record.step}`, record),
    keep: (session) => ctx.storage.put(KEPT_KEY, session),
    kept: () => ctx.storage.get<KeptSession>(KEPT_KEY),
    forget: async () => {
      await ctx.storage.delete(KEPT_KEY);
    },
    log,
  };
}

/** One request through the production forward, as the web Worker sends it after ingress. */
async function request(
  forward: (request: Request) => Promise<Response>,
  base: string,
  method: string,
  path: string,
  init?: HttpInit,
): Promise<HttpAnswer> {
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
  const response = await forward(new Request(new URL(path, base), { method, headers, body }));
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
