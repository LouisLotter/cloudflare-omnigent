// The bootstrap's Cloudflare adapter for the installer's own account (WP2.4): Wrangler, with the
// installer's Wrangler login, for deploys and reading secret names; the `cf` CLI for Workers
// Logs, the Access application and the deployed version (read-only), and for the release.
// Wrangler has no command that reads Workers Logs.
//
// Secret values reach Wrangler and cf only as an unlinked file on descriptor 3 (the staging
// tool's withSecretsDescriptor), never in argv, the output or a file that stays. Wrangler runs
// with sanitised logging and writes no log file (WRANGLER_QUIET_LOGS). Rendered configurations,
// which hold no secret, are written next to the checked-in ones under a name unique to the run,
// mode 0600, and removed after the deploy.
//
// What it never does: change an Access application, create or change a policy or service token;
// send a request to the installation's hostname; create a Worker by a secret change; delete or
// empty an R2 bucket. Outside the deploys it creates only a missing R2 bucket of the plan; the
// installation's own R2 user API tokens (r2-token.ts, through `cf user tokens`), which it also
// deletes where Cloudflare allows, and reads by ID to see whether a person has deleted one; it
// never touches another token; and, in the installer's own account (cfAccessApi, WP3.31), the
// hostname's owner-only Access application when the hostname has none, and the one-time PIN
// login method when the account has no login method (access-app.ts). Removal deletes only the
// application the state file records as the bootstrap's. A token's value comes back on
// cf's captured stdout and never leaves this process except as the Worker's secrets, on
// descriptor 3. The release goes through `cf workers secrets bulk` (`PATCH …/secrets-bulk`),
// which fails for a missing Worker, where `wrangler secret bulk` would create a draft one.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bucketLookup,
  type CommandResult,
  diagnostic,
  type Runner,
  secretNamesOf,
  secretsBulkBody,
  spawnRunner,
  WRANGLER_QUIET_LOGS,
  withSecretsDescriptor,
  wranglerCli,
} from "../staging/cloud.ts";
import { ownerOnlyAccess } from "./access.ts";
import { type AccessApi, AccessUnavailable, type IdentityProvider } from "./access-app.ts";
import type { BootstrapCloud, WorkerIdentity } from "./machine.ts";
import type { PreflightApi } from "./preflight.ts";
import { type ApiToken, R2_BUCKET_SCOPE, type TokenApi, TokensUnavailable } from "./r2-token.ts";
import { INSTALLATION_ID_VAR, type Installation } from "./settings.ts";

/** At most this many pages of 100 Workers Logs events per query. */
const MAX_LOG_PAGES = 20;
const LOG_PAGE = 100;

export function cfJson(run: Runner, args: readonly string[]): unknown {
  return cfAnswer(run("cf", args, { inherit: false }), args);
}

/** cf's JSON answer without the `result` wrapper, or an error naming the command only. */
function cfAnswer(result: CommandResult, args: readonly string[]): unknown {
  if (result.status !== 0) {
    throw new Error(`cf ${args.slice(0, 3).join(" ")} failed: ${diagnostic(result.stderr)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`cf ${args.slice(0, 3).join(" ")} printed something other than JSON`);
  }
  const wrapped = parsed as { result?: unknown } | null;
  return wrapped !== null && typeof wrapped === "object" && "result" in wrapped
    ? wrapped.result
    : parsed;
}

/**
 * The Worker's Workers Logs events between two times, newest first, read-only through
 * `cf o11y telemetry query`, as the staging harnesses read them.
 */
export function queryWorkerLogs(
  run: Runner,
  worker: string,
  fromMs: number,
  toMs: number,
): unknown[] {
  const events: unknown[] = [];
  let offset: string | undefined;
  for (let page = 0; page < MAX_LOG_PAGES; page++) {
    const body = {
      queryId: "cfo-bootstrap",
      timeframe: { from: Math.floor(fromMs), to: Math.ceil(toMs) },
      view: "events",
      limit: LOG_PAGE,
      ...(offset === undefined ? {} : { offset }),
      parameters: {
        filters: [{ key: "$workers.scriptName", operation: "eq", type: "string", value: worker }],
      },
    };
    const answer = cfJson(run, ["o11y", "telemetry", "query", "--body", JSON.stringify(body)]) as {
      events?: { events?: unknown };
    } | null;
    const listed = answer?.events?.events;
    if (!Array.isArray(listed)) break;
    events.push(...listed);
    const last = (listed.at(-1) as { $metadata?: { id?: unknown } } | undefined)?.$metadata?.id;
    if (listed.length < LOG_PAGE || typeof last !== "string") break;
    offset = last;
  }
  return events;
}

/** The hostname's Access application and the team's domain, read-only, checked owner-only. */
export async function readAccess(run: Runner, plan: Installation) {
  const apps = cfJson(run, [
    "zero-trust",
    "access",
    "applications",
    "list",
    "--domain",
    plan.hostname,
    "--exact",
  ]);
  const org = cfJson(run, ["zero-trust", "organization", "get"]) as {
    auth_domain?: unknown;
  } | null;
  return ownerOnlyAccess(
    Array.isArray(apps) ? apps : [],
    plan.hostname,
    plan.ownerPin,
    org?.auth_domain,
  );
}

/**
 * One change of a Worker's secrets: `cf workers secrets bulk`, one request, one new deployed
 * version. It fails for a missing Worker. The changes reach cf only as an unlinked file on
 * descriptor 3; an error carries only the first line of cf's output, masked.
 */
export function bulkSecrets(
  run: Runner,
  worker: string,
  changes: Readonly<Record<string, string | null>>,
  notAfter?: number,
  now: () => number = Date.now,
): "sent" | "expired" {
  // Nothing is read between this check and the request.
  if (notAfter !== undefined && now() > notAfter) return "expired";
  const result = withSecretsDescriptor(secretsBulkBody(changes), (fd) =>
    run("cf", ["workers", "secrets", "bulk", "--worker", worker, "--secrets", "@/dev/fd/3"], {
      inherit: false,
      fds: [fd],
    }),
  );
  if (result.status !== 0) {
    throw new Error(`cf workers secrets bulk failed: ${diagnostic(result.stderr)}`);
  }
  return "sent";
}

/** Whether the account holds the R2 bucket; read-only (`cf r2 buckets get`). */
export function bucketExists(run: Runner, name: string): boolean {
  return bucketLookup(run("cf", ["r2", "buckets", "get", name], { inherit: false }), name);
}

/**
 * Creates the plan's R2 buckets that do not exist yet, in the account's default location, and
 * says which it created. An existing bucket is left as it is; nothing is ever deleted.
 */
export function ensureBuckets(run: Runner, names: readonly string[]): string[] {
  const created: string[] = [];
  for (const name of names) {
    if (bucketExists(run, name)) continue;
    cfJson(run, ["r2", "buckets", "create", "--body", JSON.stringify({ name })]);
    if (!bucketExists(run, name)) throw new Error(`R2 bucket ${name} was not created`);
    created.push(name);
  }
  return created;
}

/** At most this many pages of user API tokens are read. */
const MAX_TOKEN_PAGES = 40;
const TOKEN_PAGE = 50;

/** Whether cf's failure is Cloudflare's HTTP 403: the login may not do this. */
export function forbidden(result: CommandResult): boolean {
  return /\b403 Forbidden\b/.test(result.stderr);
}

/** Whether cf's failure says the token does not exist (HTTP 404, Cloudflare's error 1003). */
function tokenMissing(result: CommandResult): boolean {
  return /\b404 Not Found\b/.test(result.stderr) || /\[1003\]/.test(result.stderr);
}

/**
 * A user-token command's JSON answer. Its errors name the command and, masked, cf's first
 * line of error output; never anything cf printed on stdout, where a token's value would be.
 * A 403 is TokensUnavailable.
 */
function tokenCf(run: Runner, args: readonly string[]): unknown {
  const result = run("cf", args, { inherit: false });
  if (result.status !== 0 && forbidden(result)) {
    throw new TokensUnavailable(
      `Cloudflare refused \`cf ${args.slice(0, 3).join(" ")}\` (403): this cf login cannot make API tokens`,
    );
  }
  return cfAnswer(result, args);
}

function text(o: Record<string, unknown>, key: string): string | undefined {
  const value = o[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** One token of `cf user tokens list`, or undefined for an entry without an ID and a name. */
export function apiTokenOf(entry: unknown): ApiToken | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const t = entry as Record<string, unknown>;
  const id = text(t, "id");
  const name = typeof t.name === "string" ? t.name : undefined;
  if (id === undefined || name === undefined) return undefined;
  const ip = ((t.condition ?? {}) as { request_ip?: { in?: unknown; not_in?: unknown } })
    .request_ip;
  const listed = (v: unknown) => Array.isArray(v) && v.length > 0;
  const policies = (Array.isArray(t.policies) ? t.policies : []).map((entry: unknown) => {
    const p = (entry ?? {}) as Record<string, unknown>;
    const groups = Array.isArray(p.permission_groups) ? p.permission_groups : [];
    const resources = p.resources;
    return {
      ...(typeof p.effect === "string" ? { effect: p.effect } : {}),
      permissionGroups: groups.map((g: unknown) => String((g as { id?: unknown } | null)?.id)),
      resources:
        resources !== null && typeof resources === "object" && !Array.isArray(resources)
          ? (resources as Record<string, unknown>)
          : {},
    };
  });
  const status = text(t, "status");
  const expiresOn = text(t, "expires_on");
  const notBefore = text(t, "not_before");
  return {
    id,
    name,
    ...(status === undefined ? {} : { status }),
    ...(expiresOn === undefined ? {} : { expiresOn }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ipLimited: listed(ip?.in) || listed(ip?.not_in),
    policies,
  };
}

/**
 * The installer's user API tokens through `cf user tokens` (WP3.25). Every answer is captured,
 * never shown; a created token's value stays in this process. Its arguments carry the name, the
 * policies and the expiry, none of them secret. A 403 is TokensUnavailable: cf's OAuth login
 * may create tokens but not list or delete them.
 */
export function cfTokenApi(run: Runner): TokenApi {
  return {
    permissionGroup: (name) => {
      const listed = tokenCf(run, [
        "user",
        "tokens",
        "permission-groups",
        "list",
        "--name",
        name,
        "--scope",
        R2_BUCKET_SCOPE,
      ]);
      const ids = (Array.isArray(listed) ? listed : []).flatMap((entry: unknown) => {
        const g = (entry ?? {}) as { id?: unknown; name?: unknown; scopes?: unknown };
        const scoped = Array.isArray(g.scopes) && g.scopes.includes(R2_BUCKET_SCOPE);
        return g.name === name && scoped && typeof g.id === "string" ? [g.id] : [];
      });
      if (ids.length !== 1) {
        throw new Error(`Cloudflare lists ${ids.length} permission groups named "${name}"`);
      }
      return ids[0] as string;
    },
    list: () => {
      const tokens: ApiToken[] = [];
      for (let page = 1; page <= MAX_TOKEN_PAGES; page++) {
        const listed = tokenCf(run, [
          "user",
          "tokens",
          "list",
          "--per-page",
          String(TOKEN_PAGE),
          "--page",
          String(page),
          "--include-expired",
        ]);
        const entries = Array.isArray(listed) ? listed : [];
        for (const entry of entries) {
          const token = apiTokenOf(entry);
          if (token !== undefined) tokens.push(token);
        }
        if (entries.length < TOKEN_PAGE) return tokens;
      }
      throw new Error(`more than ${MAX_TOKEN_PAGES * TOKEN_PAGE} user API tokens to look through`);
    },
    create: (request) => {
      const answer = tokenCf(run, [
        "user",
        "tokens",
        "create",
        "--name",
        request.name,
        "--policies",
        JSON.stringify(request.policies),
        ...(request.expiresOn === undefined ? [] : ["--expires-on", request.expiresOn]),
      ]) as Record<string, unknown> | null;
      const id = answer === null || typeof answer !== "object" ? undefined : text(answer, "id");
      const value =
        answer === null || typeof answer !== "object" ? undefined : text(answer, "value");
      if (id === undefined || value === undefined) {
        throw new Error("cf user tokens create answered without the token's ID and value");
      }
      return { id, value };
    },
    get: (id) => {
      const args = ["user", "tokens", "get", id];
      const result = run("cf", args, { inherit: false });
      if (result.status !== 0 && tokenMissing(result)) return undefined;
      if (result.status !== 0 && forbidden(result)) {
        throw new TokensUnavailable(
          "Cloudflare refused `cf user tokens get` (403): this cf login cannot read API tokens",
        );
      }
      const token = apiTokenOf(cfAnswer(result, args));
      if (token === undefined) throw new Error("cf user tokens get answered without a token");
      return token;
    },
    remove: (id) => {
      const args = ["user", "tokens", "delete", id, "--force"];
      const result = run("cf", args, { inherit: false });
      if (result.status === 0) return "deleted";
      if (tokenMissing(result)) return "absent";
      if (forbidden(result)) {
        throw new TokensUnavailable(
          "Cloudflare refused `cf user tokens delete` (403): this cf login cannot delete API tokens",
        );
      }
      throw new Error(`cf user tokens delete failed: ${diagnostic(result.stderr)}`);
    },
  };
}

/** The one account the installer's cf login reaches; refused when there are several. */
export function soleAccount(run: Runner): string {
  const listed = cfJson(run, ["accounts", "list"]);
  const ids = (Array.isArray(listed) ? listed : []).flatMap((entry: unknown) => {
    const id = (entry as { id?: unknown } | null)?.id;
    return typeof id === "string" ? [id] : [];
  });
  if (ids.length !== 1) {
    throw new Error(
      ids.length === 0
        ? "your cf login reaches no Cloudflare account; run cf auth login"
        : `your cf login reaches ${ids.length} accounts; choose one with --account (cf accounts list shows them)`,
    );
  }
  return ids[0] as string;
}

/** Whether cf's failure says the Worker does not exist (Cloudflare's error 10007). */
export function missingWorker(result: CommandResult): boolean {
  return /\[10007\]/.test(result.stderr);
}

/** The version serving all of the Worker's traffic now, from its newest deployment. Read-only. */
export function activeVersion(run: Runner, worker: string): string | undefined {
  return activeVersionOf(cfJson(run, ["workers", "deployments", "list", "--worker", worker]));
}

/** Which installation a Worker belongs to: its active version's CFO_INSTALLATION_ID. Read-only. */
export function workerInstallation(run: Runner, worker: string): WorkerIdentity {
  const args = ["workers", "deployments", "list", "--worker", worker];
  const listed = run("cf", args, { inherit: false });
  if (listed.status !== 0 && missingWorker(listed)) return { exists: false };
  const version = activeVersionOf(cfAnswer(listed, args));
  if (version === undefined) return { exists: true, installationId: undefined };
  const answer = cfJson(run, ["workers", "versions", "get", "--worker-id", worker, version]) as {
    bindings?: unknown;
  } | null;
  const bindings = Array.isArray(answer?.bindings) ? answer.bindings : [];
  // Its plain-text variables (none of them secret): the installation's ID and, since WP3.35,
  // the platform features an installer step may check.
  const vars: Record<string, string> = {};
  for (const b of bindings) {
    const binding = b as { type?: unknown; name?: unknown; text?: unknown } | null;
    if (
      binding?.type === "plain_text" &&
      typeof binding.name === "string" &&
      typeof binding.text === "string"
    ) {
      vars[binding.name] = binding.text;
    }
  }
  return { exists: true, installationId: vars[INSTALLATION_ID_VAR], versionId: version, vars };
}

function activeVersionOf(listing: unknown): string | undefined {
  const answer = listing as { deployments?: unknown } | null;
  const deployments = Array.isArray(answer?.deployments) ? answer.deployments : [];
  const versions = (deployments[0] as { versions?: unknown } | undefined)?.versions;
  const whole = (Array.isArray(versions) ? versions : []).find(
    (v) => (v as { percentage?: unknown } | null)?.percentage === 100,
  ) as { version_id?: unknown } | undefined;
  return typeof whole?.version_id === "string" && whole.version_id !== ""
    ? whole.version_id
    : undefined;
}

/**
 * A rendered configuration next to the checked-in ones, so that their relative paths resolve,
 * under a name no other run uses: created exclusively, mode 0600, removed after `use`.
 */
export function withRenderedConfig<T>(
  dir: string,
  config: Readonly<Record<string, unknown>>,
  use: (path: string) => T,
): T {
  const unique = randomBytes(6).toString("hex");
  const path = join(dir, `.cfo-bootstrap.${String(config.name)}.${unique}.jsonc`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    return use(path);
  } finally {
    rmSync(path, { force: true });
  }
}

/** Whether Wrangler's failure says the Worker does not exist. */
export function workerMissing(result: CommandResult): boolean {
  return /not found|does not exist|\[code: 10007\]/i.test(`${result.stdout}\n${result.stderr}`);
}

export interface AccountCloudOptions {
  /** The repository's worker/ directory: Wrangler's working directory and config location. */
  readonly workerDir: string;
  readonly runner?: Runner;
}

export function accountCloud(plan: Installation, options: AccountCloudOptions): BootstrapCloud {
  const run = options.runner ?? spawnRunner(plan.accountId);
  const cli = ["--no-warnings", wranglerCli(options.workerDir)];
  const wrangler = (
    args: readonly string[],
    cwd: string,
    fds: readonly number[] = [],
    inherit = true,
  ) =>
    run(process.execPath, [...cli, ...args], {
      inherit,
      cwd,
      env: { ...WRANGLER_QUIET_LOGS },
      ...(fds.length > 0 ? { fds } : {}),
    });
  // Wrangler prefers a configuration's account_id, and reads whatever configuration its working
  // directory holds: a generated one in an empty directory pins the account and the name.
  const pinned = <T>(worker: string, use: (file: string, dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "cfo-bootstrap-"));
    try {
      const file = join(dir, "wrangler.json");
      writeFileSync(file, JSON.stringify({ name: worker, account_id: plan.accountId }), {
        mode: 0o600,
      });
      return use(file, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const deploy = (
    config: Readonly<Record<string, unknown>>,
    secrets: Readonly<Record<string, string>>,
  ) =>
    withRenderedConfig(options.workerDir, config, (path) => {
      const args = ["deploy", "--config", path];
      const result =
        Object.keys(secrets).length === 0
          ? wrangler(args, options.workerDir)
          : withSecretsDescriptor(secrets, (fd) =>
              wrangler([...args, "--secrets-file", "/dev/fd/3"], options.workerDir, [fd]),
            );
      if (result.status !== 0) throw new Error(`wrangler deploy exited with ${result.status}`);
    });
  return {
    secretNames: async (worker) =>
      pinned(worker, (file, dir) => {
        const result = wrangler(
          ["secret", "list", "--config", file, "--name", worker, "--format", "json"],
          dir,
          [],
          false,
        );
        if (result.status === 0) return secretNamesOf(result.stdout);
        if (workerMissing(result)) return null;
        throw new Error(`wrangler secret list exited with ${result.status}`);
      }),
    access: (p) => readAccess(run, p),
    deployPlatform: async (_plan, config, secrets) => deploy(config, secrets),
    deployWeb: async (_plan, config) => deploy(config, {}),
    workerInstallation: async (worker) => workerInstallation(run, worker),
    updateSecrets: async (worker, changes, notAfter) => bulkSecrets(run, worker, changes, notAfter),
    activeVersion: async (worker) => activeVersion(run, worker),
    logs: async (worker, fromMs, toMs) => queryWorkerLogs(run, worker, fromMs, toMs),
  };
}

/** Whether cf's failure says the Access application does not exist (404, Access's 11021). */
function accessAppMissing(result: CommandResult): boolean {
  return /\[11021\]/.test(result.stderr) || /\b404 Not Found\b/.test(result.stderr);
}

/** An Access command's JSON answer; a 403 is AccessUnavailable. */
function accessCf(run: Runner, args: readonly string[]): unknown {
  const result = run("cf", args, { inherit: false });
  if (result.status !== 0 && forbidden(result)) {
    throw new AccessUnavailable(
      `Cloudflare refused \`cf ${args.slice(0, 4).join(" ")}\` (403): this cf login may not do that`,
    );
  }
  return cfAnswer(result, args);
}

/** At most this many pages of 100 Access applications are read. */
const MAX_ACCESS_PAGES = 20;

/**
 * Access in the installer's own account through their `cf` login (WP3.25's OAuth login holds
 * `access-app.write` and `access-idp.write`). Creates only what access-app.ts asks for: an
 * owner-only application, the one-time PIN login method; deletes only for removal. Answers are
 * captured, never shown; errors carry cf's first line of error output, masked.
 */
export function cfAccessApi(run: Runner): AccessApi {
  return {
    teamDomain: () => {
      const args = ["zero-trust", "organization", "get"];
      const result = run("cf", args, { inherit: false });
      // No organization: Cloudflare answers 404. Any other answer without a team domain is
      // uncertainty, never "none" (Codex WP3.31 r1-4).
      if (result.status !== 0 && /\b404 Not Found\b/.test(result.stderr)) return undefined;
      const org = cfAnswer(result, args) as { auth_domain?: unknown } | null;
      const domain = org?.auth_domain;
      if (typeof domain !== "string" || domain === "") {
        throw new Error("cf zero-trust organization get answered without a team domain");
      }
      return domain;
    },
    // Every application, filtered by the caller: cf's --domain filter with --exact matches the
    // string exactly, and would miss one on a path of the hostname or behind a wildcard.
    apps: () => {
      const apps: unknown[] = [];
      for (let page = 1; page <= MAX_ACCESS_PAGES; page++) {
        const listed = accessCf(run, [
          "zero-trust",
          "access",
          "applications",
          "list",
          "--per-page",
          "100",
          "--page",
          String(page),
        ]);
        if (!Array.isArray(listed)) {
          throw new Error("cf zero-trust access applications list answered no list");
        }
        apps.push(...listed);
        if (listed.length < 100) return apps;
      }
      throw new Error(
        `more than ${MAX_ACCESS_PAGES * 100} Access applications in the account: too many to check`,
      );
    },
    app: (id) => {
      const args = ["zero-trust", "access", "applications", "get", id];
      const result = run("cf", args, { inherit: false });
      if (result.status !== 0 && accessAppMissing(result)) return undefined;
      if (result.status !== 0 && forbidden(result)) {
        throw new AccessUnavailable(
          "Cloudflare refused `cf zero-trust access applications get` (403)",
        );
      }
      const app = cfAnswer(result, args);
      if (app === null || typeof app !== "object") {
        throw new Error("cf zero-trust access applications get answered without an application");
      }
      return app;
    },
    create: (body) => {
      const answer = accessCf(run, [
        "zero-trust",
        "access",
        "applications",
        "create",
        "--body",
        JSON.stringify(body),
      ]) as { id?: unknown } | null;
      if (typeof answer?.id !== "string" || answer.id === "") {
        throw new Error("cf zero-trust access applications create answered without an ID");
      }
      return answer.id;
    },
    identityProviders: () => {
      const listed = accessCf(run, [
        "zero-trust",
        "identity-providers",
        "list",
        "--per-page",
        "100",
      ]);
      return (Array.isArray(listed) ? listed : []).flatMap((entry: unknown): IdentityProvider[] => {
        const p = (entry ?? {}) as { id?: unknown; type?: unknown };
        return typeof p.id === "string" && typeof p.type === "string"
          ? [{ id: p.id, type: p.type }]
          : [];
      });
    },
    createOneTimePin: () => {
      const answer = accessCf(run, [
        "zero-trust",
        "identity-providers",
        "create",
        "--body",
        JSON.stringify({ name: "One-time PIN", type: "onetimepin", config: {} }),
      ]) as { id?: unknown } | null;
      if (typeof answer?.id !== "string" || answer.id === "") {
        throw new Error("cf zero-trust identity-providers create answered without an ID");
      }
      return answer.id;
    },
    remove: (id) => {
      const args = ["zero-trust", "access", "applications", "delete", id, "--force"];
      const result = run("cf", args, { inherit: false });
      if (result.status === 0) return "deleted";
      if (accessAppMissing(result)) return "absent";
      if (forbidden(result)) {
        throw new AccessUnavailable(
          "Cloudflare refused `cf zero-trust access applications delete` (403)",
        );
      }
      throw new Error(
        `cf zero-trust access applications delete failed: ${diagnostic(result.stderr)}`,
      );
    },
  };
}

/**
 * The preflight's reads (preflight.ts) through the installer's `cf` login: subscriptions, R2,
 * zones and the Zero Trust organization. Read-only; errors carry cf's first line, masked.
 */
export function cfPreflightApi(run: Runner): PreflightApi {
  return {
    subscriptions: () => {
      const listed = cfJson(run, ["accounts", "subscriptions", "get"]);
      if (!Array.isArray(listed)) throw new Error("cf accounts subscriptions get answered no list");
      return listed;
    },
    r2Enabled: () => {
      const args = ["r2", "buckets", "list", "--per-page", "1"];
      const result = run("cf", args, { inherit: false });
      if (result.status === 0) return true;
      // "Please enable R2 through the Cloudflare Dashboard."
      if (/\[10042\]/.test(result.stderr)) return false;
      throw new Error(`cf r2 buckets list failed: ${diagnostic(result.stderr)}`);
    },
    // cf 1.0.0-beta.18 ignores dotted filters such as --account.id: the caller filters.
    zones: (name) => {
      const listed = cfJson(run, ["zones", "list", "--name", name]);
      if (!Array.isArray(listed)) throw new Error("cf zones list answered no list");
      return listed;
    },
    teamDomain: () => cfAccessApi(run).teamDomain(),
  };
}
