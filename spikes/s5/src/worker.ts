// Spike S5 Worker: Access ingress in front of Omnigent, and the platform's own Omnigent login.
//
//   Browser -> Access -> this Worker (hostname allowlist, assertion check, header stripping)
//     -> OmnigentServerDO -> Omnigent (staging: the container; local: a Docker container)
//   PlatformLoginDO (ControlDO's login, prototyped) -> OmnigentServerDO -> Omnigent
//
// Spike-only parts, never for the product: the `/__s5/*` routes (self-test, scenario runner,
// fault injection), failure reasons in 403 bodies, synthetic secrets passed as variables, and
// the `*_LOCAL_ONLY` origins, which are honoured only for http://127.0.0.1.

import { DurableObject } from "cloudflare:workers";
import {
  type AccessConfig,
  type AccessIdentity,
  certsUrlFor,
  checkHost,
  issuerFor,
  JwksCache,
  upstreamHeaders,
  validateAccessJwt,
} from "./access.ts";
import { aesGcmSealer, checkFormToken, formToken } from "./crypto.ts";
import { type LoginRecord, PlatformLogin } from "./platform-login.ts";
import { CARD_HEADERS, renderLoginCard } from "./repair-card.ts";
import { runScenarios, type ScenarioPorts, type StepResult } from "./scenarios.ts";
import { deriveNegativeCases } from "./selftest.ts";

export interface Env {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_HOSTNAMES?: string;
  OWNER_EMAIL_SHA256?: string;
  OTHER_APP_AUD?: string;
  ACCESS_CERTS_URL_LOCAL_ONLY?: string;
  OMNIGENT_ORIGIN_LOCAL_ONLY?: string;
  FAULT_HELPER_LOCAL_ONLY?: string;
  OMNIGENT_USERNAME?: string;
  OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD?: string;
  OMNIGENT_COOKIE_SECRET?: string;
  OMNIGENT_BASE_URL?: string;
  PLATFORM_LOGIN_KEY?: string;
  GRANT_LIFETIME_DAYS?: string;
  S5_FAULTS?: string;
  PLATFORM_LOGIN: DurableObjectNamespace<PlatformLoginDO>;
  OMNIGENT_SERVER: DurableObjectNamespace<OmnigentServerDO>;
}

const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const OMNIGENT_PORT = 8000;
const MARK = { "x-s5-worker": "1" } as const;

function localOnly(value: string | undefined): string | undefined {
  return value !== undefined && LOCAL_ORIGIN.test(value) ? value : undefined;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { ...MARK, "cache-control": "no-store", ...extra },
  });
}

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ s5: event, ...data }));
}

// ---- Ingress ----

let jwks: { url: string; cache: JwksCache } | undefined;

function accessConfig(env: Env): { config: AccessConfig; certsUrl: string } | undefined {
  const team = env.ACCESS_TEAM_DOMAIN ?? "";
  if (!team || !env.ACCESS_AUD || !env.ALLOWED_HOSTNAMES) return undefined;
  let issuer: string;
  try {
    issuer = issuerFor(team);
  } catch {
    return undefined;
  }
  const localCerts = localOnly(env.ACCESS_CERTS_URL_LOCAL_ONLY);
  return {
    config: {
      issuer,
      audience: env.ACCESS_AUD,
      ...(env.OWNER_EMAIL_SHA256 ? { ownerEmailSha256: env.OWNER_EMAIL_SHA256 } : {}),
    },
    certsUrl: localCerts ? `${localCerts}/cdn-cgi/access/certs` : certsUrlFor(team),
  };
}

function keysFor(certsUrl: string): JwksCache {
  if (jwks?.url !== certsUrl) {
    jwks = {
      url: certsUrl,
      cache: new JwksCache(
        certsUrl,
        (u) => fetch(u),
        () => Date.now(),
      ),
    };
  }
  return jwks.cache;
}

function allowedHosts(env: Env): string[] {
  return (env.ALLOWED_HOSTNAMES ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
}

type Admitted = { identity: AccessIdentity; token: string; config: AccessConfig; keys: JwksCache };

async function admit(request: Request, env: Env): Promise<Admitted | Response> {
  const setup = accessConfig(env);
  if (!setup) return json({ error: { code: "not_configured" } }, 503);
  const url = new URL(request.url);
  if (!checkHost(url, allowedHosts(env))) {
    log("ingress_reject", { reason: "unknown_host" });
    return json({ error: { code: "access_denied", reason: "unknown_host" } }, 404);
  }
  const keys = keysFor(setup.certsUrl);
  const token = request.headers.get("cf-access-jwt-assertion");
  const result = await validateAccessJwt(token, setup.config, keys, Math.floor(Date.now() / 1000));
  if (!result.ok) {
    log("ingress_reject", { reason: result.reason, path: url.pathname });
    return json({ error: { code: "access_denied", reason: result.reason } }, 403);
  }
  return { identity: result.identity, token: token ?? "", config: setup.config, keys };
}

// ---- The Omnigent server (the OmnigentServer DO's role) ----

export class OmnigentServerDO extends DurableObject<Env> {
  private ready: Promise<void> | undefined;

  private origin(): string | undefined {
    return localOnly(this.env.OMNIGENT_ORIGIN_LOCAL_ONLY);
  }

  private containerEnv(): Record<string, string> {
    const e = this.env;
    if (!e.OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD || !e.OMNIGENT_COOKIE_SECRET) {
      throw new Error("bootstrap variables are not set");
    }
    return {
      DATABASE_URL: "sqlite:////data/omnigent.db",
      OMNIGENT_AUTH_PROVIDER: "accounts",
      OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: e.OMNIGENT_USERNAME ?? "owner",
      OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: e.OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD,
      OMNIGENT_ACCOUNTS_COOKIE_SECRET: e.OMNIGENT_COOKIE_SECRET,
      OMNIGENT_ACCOUNTS_BASE_URL: e.OMNIGENT_BASE_URL ?? "http://127.0.0.1:8000",
      OMNIGENT_WS_ALLOWED_ORIGINS: e.OMNIGENT_BASE_URL ?? "",
      OMNIGENT_GRANT_MAX_LIFETIME_DAYS: e.GRANT_LIFETIME_DAYS ?? "1",
    };
  }

  private async ensureStarted(): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error("no container and no local origin");
    if (container.running && this.ready === undefined) this.ready = Promise.resolve();
    if (!container.running) {
      container.start({ env: this.containerEnv(), enableInternet: false });
      this.ready = undefined;
    }
    this.ready ??= (async () => {
      await container.setInactivityTimeout(30 * 60_000);
      const started = Date.now();
      for (let i = 0; i < 180; i++) {
        try {
          const r = await container.getTcpPort(OMNIGENT_PORT).fetch("http://omnigent/health");
          if (r.status === 200) {
            log("container_ready", { ms: Date.now() - started });
            return;
          }
        } catch {
          // not listening yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      throw new Error("Omnigent did not become healthy");
    })().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    // Never follow Omnigent's redirects here: the browser must see them.
    const origin = this.origin();
    if (origin) return fetch(new Request(`${origin}${path}`, request), { redirect: "manual" });
    await this.ensureStarted();
    const container = this.ctx.container;
    if (!container) return json({ error: { code: "no_upstream" } }, 503);
    return container
      .getTcpPort(OMNIGENT_PORT)
      .fetch(new Request(`http://omnigent${path}`, request), { redirect: "manual" });
  }

  /** Spike-only: run SQL against the server's database (fault injection). */
  async faultSql(sql: string): Promise<{ exitCode: number; output: string }> {
    if (this.env.S5_FAULTS !== "1") throw new Error("faults are disabled");
    const helper = localOnly(this.env.FAULT_HELPER_LOCAL_ONLY);
    if (helper) {
      const r = await fetch(`${helper}/sql`, { method: "POST", body: sql });
      return { exitCode: r.ok ? 0 : 1, output: (await r.text()).slice(0, 500) };
    }
    await this.ensureStarted();
    const container = this.ctx.container;
    if (!container) throw new Error("no container");
    const code = [
      "import sqlite3, sys",
      "c = sqlite3.connect('/data/omnigent.db')",
      "c.executescript(sys.argv[1])",
      "c.commit()",
      "print(c.total_changes)",
    ].join("\n");
    const process = await container.exec(["python", "-c", code, sql]);
    const out = await process.output();
    const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
    return { exitCode: out.exitCode, output: text.slice(0, 500) };
  }
}

function server(env: Env): DurableObjectStub<OmnigentServerDO> {
  return env.OMNIGENT_SERVER.get(env.OMNIGENT_SERVER.idFromName("singleton"));
}

// ---- The platform's own login (ControlDO's role) ----

export class PlatformLoginDO extends DurableObject<Env> {
  private cores = new Map<string, PlatformLogin>();

  private async core(name: string): Promise<PlatformLogin> {
    let core = this.cores.get(name);
    if (core) return core;
    if (!this.env.PLATFORM_LOGIN_KEY) throw new Error("PLATFORM_LOGIN_KEY is not set");
    const stub = server(this.env);
    const storage = this.ctx.storage;
    core = new PlatformLogin({
      omnigent: {
        request: (path, init) => stub.fetch(new Request(`http://omnigent.internal${path}`, init)),
      },
      store: {
        load: () => storage.get<LoginRecord>(`login:${name}`),
        save: (record) => storage.put(`login:${name}`, record),
      },
      sealer: await aesGcmSealer(this.env.PLATFORM_LOGIN_KEY, "platform-login"),
      nowSeconds: () => Math.floor(Date.now() / 1000),
      username: this.env.OMNIGENT_USERNAME ?? "owner",
      grantLifetimeSeconds: Number(this.env.GRANT_LIFETIME_DAYS ?? "30") * 86_400,
    });
    this.cores.set(name, core);
    return core;
  }

  async bootstrap(name = "main") {
    const result = await (await this.core(name)).bootstrap(
      this.env.OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD,
    );
    // The signal a bootstrap script can read from Workers Logs before deleting the secret.
    if (result.secretRemovable) log("platform_login_stored", { login: name });
    return result;
  }

  async status(name = "main") {
    return (await this.core(name)).status();
  }

  async readSchedules(name = "main") {
    return (await this.core(name)).readSchedules();
  }

  async repair(password: string, name = "main") {
    return (await this.core(name)).repair(password);
  }

  async faultRevoke(name = "main") {
    return (await this.core(name)).faultRevokeStoredGrant();
  }

  async faultDropAccess(name = "main") {
    return (await this.core(name)).faultDropAccessToken();
  }

  async startScenarios(): Promise<void> {
    await this.ctx.storage.put("scenario-report", { state: "running", steps: [] });
    await this.ctx.storage.setAlarm(Date.now());
  }

  async report(): Promise<unknown> {
    return (await this.ctx.storage.get("scenario-report")) ?? { state: "not_started" };
  }

  override async alarm(): Promise<void> {
    const steps: StepResult[] = [];
    const save = async (state: string) => this.ctx.storage.put("scenario-report", { state, steps });
    const ports: ScenarioPorts = {
      login: (name) => this.core(name),
      bootstrapSecret: this.env.OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD ?? "",
      username: this.env.OMNIGENT_USERNAME ?? "owner",
      server: (path, init) =>
        server(this.env).fetch(new Request(`http://omnigent.internal${path}`, init)),
      faultSql: (sql) => server(this.env).faultSql(sql),
      record: async (step) => {
        steps.push(step);
        log("scenario_step", { ...step });
        await save("running");
      },
      renderCard: async (name) =>
        renderLoginCard(await (await this.core(name)).status(), "form-token-placeholder"),
    };
    try {
      await runScenarios(ports);
      await save("done");
      log("scenario_done", {
        passed: steps.filter((s) => s.pass).length,
        failed: steps.filter((s) => !s.pass).length,
      });
    } catch (error) {
      steps.push({
        scenario: "runner",
        step: "uncaught",
        expect: "no error",
        got: error instanceof Error ? error.message.slice(0, 200) : "error",
        pass: false,
      });
      await save("failed");
      log("scenario_failed", { error: error instanceof Error ? error.message : "error" });
    }
  }
}

function platform(env: Env): DurableObjectStub<PlatformLoginDO> {
  return env.PLATFORM_LOGIN.get(env.PLATFORM_LOGIN.idFromName("installation"));
}

// ---- Routes ----

async function repairForm(request: Request, env: Env, admitted: Admitted): Promise<Response> {
  const url = new URL(request.url);
  // Exact origin: the form posts only from this page.
  if (request.headers.get("origin") !== url.origin) {
    return json({ error: { code: "bad_origin" } }, 403);
  }
  const form = await request.formData();
  const token = String(form.get("form_token") ?? "");
  const password = String(form.get("password") ?? "");
  const key = env.PLATFORM_LOGIN_KEY ?? "";
  if (!(await checkFormToken(key, token, admitted.identity.sub, "repair", Date.now()))) {
    return json({ error: { code: "bad_form_token" } }, 403);
  }
  const stub = platform(env);
  const outcome = await stub.repair(password);
  log("repair", { outcome: outcome.kind });
  const message =
    outcome.kind === "stored"
      ? "repaired"
      : outcome.kind === "rejected"
        ? "wrong_password"
        : "failed";
  const fresh = await formToken(key, admitted.identity.sub, "repair", Date.now());
  return new Response(renderLoginCard(await stub.status(), fresh, message), {
    status: outcome.kind === "stored" ? 200 : 400,
    headers: { ...CARD_HEADERS, ...MARK },
  });
}

async function selfTest(request: Request, env: Env, admitted: Admitted) {
  const url = new URL(request.url);
  const other = env.OTHER_APP_AUD ?? "f".repeat(64);
  const cases = await deriveNegativeCases(
    admitted.token,
    admitted.config,
    admitted.keys,
    Math.floor(Date.now() / 1000),
    { url, allowed: allowedHosts(env) },
    other,
  );
  const summary = {
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
    keyFetches: admitted.keys.fetches,
    cases,
  };
  log("selftest", summary);
  return summary;
}

export default {
  async fetch(request, env): Promise<Response> {
    const admitted = await admit(request, env);
    if (admitted instanceof Response) return admitted;
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    const faults = env.S5_FAULTS === "1";

    switch (route) {
      case "GET /__s5/whoami":
        return json({
          ok: true,
          sub: `${admitted.identity.sub.slice(0, 8)}…`,
          exp: admitted.identity.exp,
          ownerPinned: env.OWNER_EMAIL_SHA256 !== undefined,
        });
      case "GET /__s5/selftest":
        return json(await selfTest(request, env, admitted));
      case "GET /__s5/run": {
        // One owner visit in staging: the assertion self-test on this genuine assertion,
        // requests through the public proxy path to the Omnigent container (with this request's
        // own Access headers and cookies, which the proxy strips), and the platform-login
        // scenarios started in the background.
        const access = await selfTest(request, env, admitted);
        const started = Date.now();
        const viaProxy = async (method: string, path: string, body?: string) => {
          const headers = new Headers(request.headers);
          if (body !== undefined) headers.set("content-type", "application/json");
          try {
            const r = await proxy(
              new Request(new URL(path, url), { method, headers, ...(body ? { body } : {}) }),
              env,
            );
            return `${r.status}${r.headers.get("x-s5-worker") === "1" ? " via worker" : ""}`;
          } catch (error) {
            return error instanceof Error ? error.message.slice(0, 200) : "error";
          }
        };
        const behindAccess = {
          health: await viaProxy("GET", "/health"),
          coldStartMs: Date.now() - started,
          scheduledTasksWithoutOmnigentLogin: await viaProxy("GET", "/v1/scheduled-tasks"),
          firstVisitorSetup: await viaProxy(
            "POST",
            "/auth/setup",
            JSON.stringify({ username: "intruder", password: "intruder-password" }),
          ),
          loginPage: await viaProxy("GET", "/"),
        };
        log("behind_access", behindAccess);
        if (faults) await platform(env).startScenarios();
        return json({
          access: { passed: access.passed, failed: access.failed, cases: access.cases },
          behindAccess,
          scenarios: faults ? "started; see /__s5/report" : "disabled",
        });
      }
      case "POST /__s5/scenarios/run":
        if (!faults) break;
        await platform(env).startScenarios();
        return json({ started: true });
      case "GET /__s5/report":
        return json(await platform(env).report());
      case "GET /platform/login": {
        const token = await formToken(
          env.PLATFORM_LOGIN_KEY ?? "",
          admitted.identity.sub,
          "repair",
          Date.now(),
        );
        return new Response(renderLoginCard(await platform(env).status(), token), {
          headers: { ...CARD_HEADERS, ...MARK },
        });
      }
      case "POST /platform/login/repair":
        return repairForm(request, env, admitted);
      case "GET /platform/status":
        return json(await platform(env).status());
      case "POST /platform/bootstrap":
        return json(await platform(env).bootstrap());
      case "GET /platform/schedules":
        return json(await platform(env).readSchedules());
      case "POST /__s5/fault/revoke-grant":
        if (!faults) break;
        return json({ revokeStatus: (await platform(env).faultRevoke()) ?? null });
      case "POST /__s5/fault/drop-access":
        if (!faults) break;
        await platform(env).faultDropAccess();
        return json({ dropped: true });
    }
    if (url.pathname.startsWith("/__s5/") || url.pathname.startsWith("/platform/")) {
      return json({ error: { code: "not_found" } }, 404);
    }

    return proxy(request, env);
  },
} satisfies ExportedHandler<Env>;

/** Everything else is Omnigent, behind the same check, with identity headers stripped. */
async function proxy(request: Request, env: Env): Promise<Response> {
  const forwarded = new Request(request, { headers: upstreamHeaders(request.headers) });
  const response = await server(env).fetch(forwarded);
  if (response.webSocket) return response;
  const out = new Response(response.body, response);
  out.headers.set("x-s5-worker", "1");
  return out;
}
