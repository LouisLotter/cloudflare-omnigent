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
// What it never does: create, change or delete an Access application, policy or service
// token; send a request to the installation's hostname; create a Worker by a secret change;
// delete or empty an R2 bucket. The only thing it creates outside the deploys is a missing R2
// bucket of the plan (`bootstrap.ts buckets`), before the installer makes the R2 token for it.
// The release goes through `cf workers secrets bulk` (`PATCH …/secrets-bulk`), which fails for
// a missing Worker, where `wrangler secret bulk` would create a draft one.

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
import type { BootstrapCloud, WorkerIdentity } from "./machine.ts";
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
  const named = bindings.find((b) => {
    const binding = b as { type?: unknown; name?: unknown } | null;
    return binding?.type === "plain_text" && binding.name === INSTALLATION_ID_VAR;
  }) as { text?: unknown } | undefined;
  return {
    exists: true,
    installationId: typeof named?.text === "string" ? named.text : undefined,
  };
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
