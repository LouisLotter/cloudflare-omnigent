// Staging-only parts of the S7 Worker: the Omnigent server container, an emulated computer
// container that reaches the server only through the private host route, a sink for its
// results, and owner-only test pages under /__s7/.
//
// Everything here is spike scaffolding. Production keeps the forwarding function and the
// guard; the test pages, the result sink and the generated password do not carry over.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import browserVariants from "./browser-variants.json";
import { MANAGED_ROOT } from "./guard.ts";
import { PAGE_HTML } from "./page.ts";

export interface StagingEnv {
  readonly SERVER: DurableObjectNamespace<OmnigentServer>;
  readonly COMPUTER: DurableObjectNamespace<ComputerSim>;
}

type AnyEnv = Partial<StagingEnv> & { readonly COMPUTER_TIMEOUT_MS?: string };

const SERVER_PORT = 8000;
const USERNAME = "owner";
const READY_TIMEOUT_MS = 600_000;
const COMPUTER_TIMEOUT_MS = 600_000;
const DATA_DIR = "/data/state";
const OVERRIDE_FILES = [
  "sharing_mode",
  "public_sharing",
  "public_sharing_max_level",
  "default_public_sessions",
];

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

interface Secrets {
  readonly password: string;
  readonly cookieSecret: string;
}

/** The singleton Omnigent server and its container. */
export class OmnigentServer extends DurableObject<AnyEnv> {
  private async secrets(): Promise<Secrets> {
    const stored = await this.ctx.storage.get<Secrets>("secrets");
    if (stored) return stored;
    const created = { password: randomHex(16), cookieSecret: randomHex(32) };
    await this.ctx.storage.put("secrets", created);
    return created;
  }

  private container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("no container attached to OmnigentServer");
    return container;
  }

  /** The public origin, learned from the first browser request, for cookies and origins. */
  async setOrigin(origin: string): Promise<void> {
    await this.ctx.storage.put("origin", origin);
  }

  private async start(): Promise<void> {
    const container = this.container();
    if (container.running) return;
    const { password, cookieSecret } = await this.secrets();
    const origin = (await this.ctx.storage.get<string>("origin")) ?? "https://localhost";
    container.start({
      enableInternet: false,
      env: {
        DATABASE_URL: "sqlite:////data/omnigent.db",
        ARTIFACT_DIR: "/data/artifacts",
        OMNIGENT_ADMIN_CREDENTIALS_PATH: `${DATA_DIR}/admin-credentials`,
        OMNIGENT_AUTH_PROVIDER: "accounts",
        OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: USERNAME,
        OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: password,
        OMNIGENT_ACCOUNTS_COOKIE_SECRET: cookieSecret,
        OMNIGENT_ACCOUNTS_BASE_URL: origin,
        OMNIGENT_WS_ALLOWED_ORIGINS: origin,
        OMNIGENT_SHARING_MODE: "read_only",
        OMNIGENT_PUBLIC_SHARING: "off",
        OMNIGENT_PUBLIC_SHARING_MAX_LEVEL: "read",
        OMNIGENT_DEFAULT_PUBLIC_SESSIONS: "off",
      },
    });
    const startedAt = Date.now();
    await this.ctx.storage.put("startedAt", startedAt);
    this.ctx.waitUntil(container.monitor().catch(() => undefined));
  }

  private async waitReady(): Promise<number> {
    const started = Date.now();
    const port = this.container().getTcpPort(SERVER_PORT);
    while (Date.now() - started < READY_TIMEOUT_MS) {
      try {
        const response = await port.fetch("http://omnigent-server/health");
        if (response.ok) return Date.now() - started;
      } catch {
        // Not listening yet.
      }
      await sleep(1000);
    }
    throw new Error("the Omnigent server did not become ready");
  }

  /** Starts the server if needed and waits until it answers. Returns milliseconds waited. */
  async ensureReady(): Promise<number> {
    await this.start();
    return this.waitReady();
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await this.ensureReady();
    } catch (error) {
      return json({ error: { code: "unavailable", message: String(error) } }, 503);
    }
    return this.container().getTcpPort(SERVER_PORT).fetch(request);
  }

  /**
   * Server replacement: destroy the container, so its disk with the data directory is gone,
   * and start a new one. The Durable Object keeps the generated secrets, as Worker secrets
   * would be kept in production. There is no database replica on staging yet (no R2), so the
   * new server starts with an empty database and the owner is provisioned again.
   */
  async replace(): Promise<Record<string, number>> {
    const container = this.container();
    const t0 = Date.now();
    if (container.running) await container.destroy();
    for (let i = 0; i < 60 && container.running; i++) await sleep(1000);
    const stopped = Date.now();
    await this.start();
    const waited = await this.waitReady();
    return { destroyMs: stopped - t0, readyMs: waited };
  }

  /** Logs in as the owner directly, bypassing the forwarding path. */
  async login(): Promise<{ token: string; setCookie: string }> {
    await this.ensureReady();
    const { password } = await this.secrets();
    const response = await this.container()
      .getTcpPort(SERVER_PORT)
      .fetch("http://omnigent-server/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password }),
      });
    if (!response.ok) throw new Error(`login failed with status ${response.status}`);
    const body = (await response.json()) as { token: string };
    return { token: body.token, setCookie: response.headers.get("set-cookie") ?? "" };
  }

  /** The password, for the emulated computer's own login. Never leaves the Worker. */
  async computerCredentials(): Promise<{ username: string; password: string }> {
    return { username: USERNAME, password: (await this.secrets()).password };
  }

  /** The settings as the server itself reports them, and any override files it has written. */
  async inspect(): Promise<Record<string, unknown>> {
    const { token } = await this.login();
    const response = await this.container()
      .getTcpPort(SERVER_PORT)
      .fetch(`http://omnigent-server${MANAGED_ROOT}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const state = response.ok ? await response.json() : { status: response.status };
    let overrideFiles: string[] | string;
    try {
      // The data directory does not exist until Omnigent first writes to it.
      const list = `import os; d=${JSON.stringify(DATA_DIR)}; print("\\n".join(os.listdir(d)) if os.path.isdir(d) else "")`;
      const process = await this.container().exec(["python", "-c", list], {
        stdout: "pipe",
        stderr: "combined",
      });
      const output = await process.output();
      const text = new TextDecoder().decode(output.stdout);
      overrideFiles = text
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => OVERRIDE_FILES.includes(s));
    } catch (error) {
      overrideFiles = `exec unavailable: ${String(error)}`;
    }
    return { direct: state, overrideFiles };
  }

  /**
   * Long steps run in the alarm handler, so the owner's page polls short requests instead of
   * holding one open for minutes.
   */
  async startJob(kind: "start" | "replace"): Promise<void> {
    await this.ctx.storage.put("job", { kind, state: "running", startedAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async job(): Promise<unknown> {
    return (await this.ctx.storage.get("job")) ?? null;
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<{ kind: string; state: string }>("job");
    if (job?.state !== "running") return;
    try {
      const result =
        job.kind === "replace" ? await this.replace() : { readyMs: await this.ensureReady() };
      await this.ctx.storage.put("job", { ...job, state: "done", result, finishedAt: Date.now() });
    } catch (error) {
      await this.ctx.storage.put("job", {
        ...job,
        state: "failed",
        error: String(error),
        finishedAt: Date.now(),
      });
    }
    console.log(JSON.stringify({ s7: "server-job", job: await this.ctx.storage.get("job") }));
  }

  async records(): Promise<unknown[]> {
    const all = await this.ctx.storage.list<unknown>({ prefix: "record:" });
    return [...all.values()];
  }

  async record(entry: unknown): Promise<void> {
    await this.ctx.storage.put(`record:${Date.now()}:${randomHex(4)}`, entry);
  }
}

interface ResultProps {
  readonly label: string;
}

/** Receives the emulated computer's results through interception of results.internal. */
export class ResultSink extends WorkerEntrypoint<AnyEnv, ResultProps> {
  override async fetch(request: Request): Promise<Response> {
    const computer = this.env.COMPUTER;
    if (!computer) return new Response("no computer namespace", { status: 500 });
    const body = await request.text();
    await computer.get(computer.idFromName("computer-a")).storeResults(this.ctx.props.label, body);
    return new Response(null, { status: 204 });
  }
}

/**
 * Computer A: a container that holds the owner's Omnigent login and replays every variant
 * against http://omnigent.internal, which is intercepted to the private host route.
 */
export class ComputerSim extends DurableObject<AnyEnv> {
  async storeResults(label: string, body: string): Promise<void> {
    await this.ctx.storage.put(`results:${label}`, body);
    console.log(JSON.stringify({ s7: "computer-results", label, results: JSON.parse(body) }));
  }

  /** Starts a run in the alarm handler; the page polls result(). */
  async startRun(label: string): Promise<void> {
    await this.ctx.storage.delete(`results:${label}`);
    await this.ctx.storage.put("job", { label, state: "running", startedAt: Date.now() });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async result(label: string): Promise<unknown> {
    const body = await this.ctx.storage.get<string>(`results:${label}`);
    return {
      job: (await this.ctx.storage.get("job")) ?? null,
      results: body ? JSON.parse(body) : null,
    };
  }

  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<{ label: string; state: string }>("job");
    if (job?.state !== "running") return;
    let outcome: unknown;
    try {
      outcome = await this.run(job.label);
    } catch (error) {
      outcome = { error: String(error) };
    }
    const error = (outcome as { error?: unknown } | null)?.error;
    const failed = Boolean(error);
    await this.ctx.storage.put("job", {
      ...job,
      state: failed ? "failed" : "done",
      ...(failed ? { error } : {}),
      finishedAt: Date.now(),
    });
  }

  async run(label: string): Promise<unknown> {
    const container = this.ctx.container;
    const server = this.env.SERVER;
    if (!container || !server) throw new Error("computer container or server binding missing");
    await this.ctx.storage.delete(`results:${label}`);
    if (container.running) {
      await container.destroy();
      for (let i = 0; i < 60 && container.running; i++) await sleep(1000);
    }
    const credentials = await server.get(server.idFromName("singleton")).computerCredentials();
    container.start({
      enableInternet: false,
      env: {
        S7_LABEL: label,
        S7_USERNAME: credentials.username,
        S7_PASSWORD: credentials.password,
      },
    });
    this.ctx.waitUntil(container.monitor().catch(() => undefined));
    const exports = this.ctx.exports as unknown as {
      ComputerRoute: (options: { props: Record<string, unknown> }) => Fetcher;
      ResultSink: (options: { props: ResultProps }) => Fetcher;
    };
    await container.interceptOutboundHttp(
      "omnigent.internal",
      exports.ComputerRoute({
        props: { computerId: "s7-computer-a", hostId: "s7-host-a", generation: 1 },
      }),
    );
    await container.interceptOutboundHttp(
      "results.internal",
      exports.ResultSink({ props: { label } }),
    );
    const started = Date.now();
    const limit = Number(this.env.COMPUTER_TIMEOUT_MS ?? COMPUTER_TIMEOUT_MS);
    while (Date.now() - started < limit) {
      const body = await this.ctx.storage.get<string>(`results:${label}`);
      if (body) return JSON.parse(body);
      await sleep(2000);
    }
    return { error: "the computer did not report results in time", label };
  }
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/**
 * Owner-only test pages under /__s7/, behind the deployment's Access application. Returns null
 * for every other path, which then goes through the forwarding function.
 */
export async function handlePlatform(
  request: Request,
  env: AnyEnv,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/__s7/") || !env.SERVER || !env.COMPUTER) return null;
  const server = env.SERVER.get(env.SERVER.idFromName("singleton"));
  const computer = env.COMPUTER.get(env.COMPUTER.idFromName("computer-a"));
  if (request.method === "GET" && url.pathname === "/__s7/") {
    return new Response(PAGE_HTML.replace("__VARIANTS__", JSON.stringify(browserVariants)), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "frame-ancestors 'none'",
      },
    });
  }
  if (request.method === "GET" && url.pathname === "/__s7/api/records") {
    return json(await server.records());
  }
  if (request.method !== "POST" || !sameOrigin(request)) {
    return json({ error: "not found" }, 404);
  }
  try {
    switch (url.pathname) {
      case "/__s7/api/start": {
        await server.setOrigin(url.origin);
        await server.startJob("start");
        return json({ ok: true });
      }
      case "/__s7/api/replace":
        await server.startJob("replace");
        return json({ ok: true });
      case "/__s7/api/job":
        return json(await server.job());
      case "/__s7/api/login": {
        // Sets Omnigent's own session cookie in the owner's browser; the token stays here.
        const { setCookie } = await server.login();
        return json({ ok: true }, 200, { "set-cookie": setCookie });
      }
      case "/__s7/api/inspect":
        return json(await server.inspect());
      case "/__s7/api/computer-run":
        await computer.startRun(url.searchParams.get("label") ?? "run");
        return json({ ok: true });
      case "/__s7/api/computer-result":
        return json(await computer.result(url.searchParams.get("label") ?? "run"));
      case "/__s7/api/record": {
        const entry = await request.json();
        await server.record(entry);
        console.log(JSON.stringify({ s7: "record", entry }));
        return json({ ok: true });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
}
