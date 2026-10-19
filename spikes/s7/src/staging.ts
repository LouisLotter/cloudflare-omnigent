// Staging-only parts of the S7 Worker: the Omnigent server container, an emulated computer
// container that reaches the server only through the private host route, a sink for its
// results, and owner-only test pages under /__s7/.
//
// Everything here is spike scaffolding. Production keeps the forwarding function and the
// guard; the test pages, the result sink and the generated password do not carry over.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import browserVariants from "./browser-variants.json";
import {
  CAMPAIGN_ROUTES,
  CAMPAIGN_WINDOW_MS,
  checkOrigin,
  confirmationPage,
  INTENT_HEADER,
  INTENT_TTL_MS,
  intentMatches,
  newIntentToken,
  POST_ROUTES,
  pruneIntents,
  type StoredIntent,
  sha256Hex,
} from "./controls.ts";
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
  private async ensureReady(): Promise<number> {
    await this.start();
    return this.waitReady();
  }

  /**
   * Forwarded traffic never starts the container (IR-017): only an armed campaign does. A
   * request while it is stopped gets 503, so a cross-site GET has no effect.
   */
  override async fetch(request: Request): Promise<Response> {
    if (!this.container().running) {
      return json(
        { error: { code: "unavailable", message: "The S7 server is not running." } },
        503,
      );
    }
    try {
      return await this.container().getTcpPort(SERVER_PORT).fetch(request);
    } catch (error) {
      return json({ error: { code: "unavailable", message: String(error) } }, 503);
    }
  }

  // Campaign controls. The Worker checks origin and token before calling any of these.

  /** Stores a new request-intent token (only its hash) and returns it for the page. */
  async issueIntent(): Promise<string> {
    const now = Date.now();
    const token = newIntentToken();
    const kept = pruneIntents((await this.ctx.storage.get<StoredIntent[]>("intents")) ?? [], now);
    kept.push({ hash: await sha256Hex(token), expiresAt: now + INTENT_TTL_MS });
    await this.ctx.storage.put("intents", kept);
    return token;
  }

  /** Read-only: whether the token matches a stored, unexpired intent. */
  async checkIntent(token: string | null): Promise<boolean> {
    const intents = (await this.ctx.storage.get<StoredIntent[]>("intents")) ?? [];
    return intentMatches(token, intents, Date.now());
  }

  async isArmed(): Promise<boolean> {
    const until = await this.ctx.storage.get<number>("armedUntil");
    return until !== undefined && until > Date.now();
  }

  /** Arms the campaign for CAMPAIGN_WINDOW_MS; an alarm then disarms it and stops containers. */
  async arm(): Promise<number> {
    const until = Date.now() + CAMPAIGN_WINDOW_MS;
    await this.ctx.storage.put("armedUntil", until);
    const pending = await this.ctx.storage.getAlarm();
    if (pending === null || pending > until) await this.ctx.storage.setAlarm(until);
    return until;
  }

  /** Disarms now and stops both containers. */
  async disarm(): Promise<void> {
    await this.ctx.storage.delete("armedUntil");
    await this.stopAll();
  }

  private async stopAll(): Promise<void> {
    const container = this.container();
    if (container.running) await container.destroy();
    const computer = this.env.COMPUTER;
    if (computer) await computer.get(computer.idFromName("computer-a")).stop();
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
    if (!this.container().running) throw new Error("the S7 server is not running; start it first");
    await this.waitReady();
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

  /** Runs a pending job, then disarms and stops everything once the campaign window is over. */
  override async alarm(): Promise<void> {
    const job = await this.ctx.storage.get<{ kind: string; state: string }>("job");
    if (job?.state === "running" && (await this.isArmed())) {
      try {
        const result =
          job.kind === "replace" ? await this.replace() : { readyMs: await this.ensureReady() };
        await this.ctx.storage.put("job", {
          ...job,
          state: "done",
          result,
          finishedAt: Date.now(),
        });
      } catch (error) {
        await this.ctx.storage.put("job", {
          ...job,
          state: "failed",
          error: String(error),
          finishedAt: Date.now(),
        });
      }
      console.log(JSON.stringify({ s7: "server-job", job: await this.ctx.storage.get("job") }));
    } else if (job?.state === "running") {
      await this.ctx.storage.put("job", { ...job, state: "failed", error: "campaign not armed" });
    }
    const until = await this.ctx.storage.get<number>("armedUntil");
    if (until !== undefined && until > Date.now()) {
      await this.ctx.storage.setAlarm(until);
    } else {
      await this.ctx.storage.delete("armedUntil");
      await this.stopAll();
      console.log(JSON.stringify({ s7: "campaign-disarmed" }));
    }
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

  /** Stops the computer container; called when the campaign is disarmed. */
  async stop(): Promise<void> {
    const container = this.ctx.container;
    if (container?.running) await container.destroy();
    const job = await this.ctx.storage.get<{ state: string }>("job");
    if (job?.state === "running") {
      await this.ctx.storage.put("job", { ...job, state: "failed", error: "campaign disarmed" });
    }
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

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "frame-ancestors 'none'",
};

function html(body: string, method: string): Response {
  return new Response(method === "HEAD" ? null : body, { headers: HTML_HEADERS });
}

/**
 * Owner-only test pages under /__s7/, behind the deployment's Access application, following
 * the campaign-control rule (IR-017; see controls.ts). Returns null for every other path, which
 * then goes through the forwarding function.
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
  const method = request.method.toUpperCase();

  // GET and HEAD never change the experiment. The only write is the page's request-intent token.
  if (method === "GET" || method === "HEAD") {
    if (url.pathname === "/__s7/") {
      const token = await server.issueIntent();
      const page = PAGE_HTML.replace("__VARIANTS__", JSON.stringify(browserVariants)).replace(
        "__INTENT__",
        JSON.stringify(token),
      );
      return html(page, method);
    }
    if (url.pathname === "/__s7/api/records") return json(await server.records());
    if (POST_ROUTES.includes(url.pathname)) {
      return html(confirmationPage(url.pathname, await server.issueIntent()), method);
    }
    return json({ error: "not found" }, 404);
  }
  if (method !== "POST") return json({ error: "method not allowed" }, 405);

  // Every check comes before any effect.
  const origin = checkOrigin(request);
  if (!origin.ok) return json({ error: `refused: ${origin.reason}` }, 403);
  if (!(await server.checkIntent(request.headers.get(INTENT_HEADER)))) {
    return json({ error: "refused: missing or invalid request-intent token" }, 403);
  }
  if (!POST_ROUTES.includes(url.pathname)) return json({ error: "not found" }, 404);
  if (CAMPAIGN_ROUTES.includes(url.pathname) && !(await server.isArmed())) {
    return json({ error: "refused: no campaign is armed" }, 403);
  }
  try {
    switch (url.pathname) {
      case "/__s7/api/arm":
        return json({ armedUntil: await server.arm() });
      case "/__s7/api/disarm":
        await server.disarm();
        return json({ ok: true });
      case "/__s7/api/job":
        return json(await server.job());
      case "/__s7/api/computer-result":
        return json(await computer.result(url.searchParams.get("label") ?? "run"));
      case "/__s7/api/start":
        await server.setOrigin(url.origin);
        await server.startJob("start");
        return json({ ok: true });
      case "/__s7/api/replace":
        await server.startJob("replace");
        return json({ ok: true });
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
