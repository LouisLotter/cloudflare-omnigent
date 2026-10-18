// Pure rules for staging resources. Every mutation the staging tool performs goes through these.

export const STAGING_PREFIX = "cfo-stg-";
const SUFFIX = /^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/;

/**
 * One staging deployment: a Worker on its own hostname and the owner-only Access application in
 * front of it. The two share one record and one expiry, so they are created, kept and removed as
 * a unit. The record is written before the first cloud mutation and removed only after both
 * resources are gone, so an interrupted run always leaves a record to reconcile.
 *
 *   pending   Access exists or may exist; the Worker may or may not exist.
 *   deployed  The last deploy of the Worker succeeded.
 *   deleting  Teardown started. Deploy refuses until teardown finishes.
 */
export type DeploymentState = "pending" | "deployed" | "deleting";

export interface Deployment {
  readonly name: string;
  readonly hostname: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: DeploymentState;
  /** Set as soon as the Access application exists. */
  readonly accessAppId?: string;
  /**
   * Set just before a Worker upload and cleared when it succeeds. If the next command finds it
   * still set, that upload was interrupted, and the command records `uploadInterruptedAt`.
   */
  readonly uploadStartedAt?: string;
  /**
   * When a command first found an interrupted upload. While it is set, a request may still take
   * effect at Cloudflare, so every teardown waits the full settle time, measured by its own
   * process, before its final check. Only the teardown that removes the record clears it: a
   * later successful upload says nothing about the earlier request, and no wall-clock deadline
   * is trusted, because the clock can jump.
   */
  readonly uploadInterruptedAt?: string;
}

export interface StagingConfig {
  readonly accountId: string;
  readonly zone: string;
  readonly ownerEmail: string;
  readonly identityProviderId?: string;
}

/** The fields of a Cloudflare Access application that the guard inspects. */
export interface AccessApp {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly type?: string;
  readonly policies?: readonly {
    readonly decision?: string;
    readonly include?: readonly unknown[];
  }[];
}

/**
 * A Wrangler configuration as Wrangler itself reads it: `raw` is the parsed file, `effective`
 * the configuration `wrangler deploy` would use without `--env`.
 */
export interface DeployConfigView {
  readonly path: string;
  readonly redirected: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly effective: {
    readonly account_id?: unknown;
    readonly workers_dev?: unknown;
    readonly preview_urls?: unknown;
    readonly route?: unknown;
    readonly routes?: unknown;
    readonly targetEnvironment?: unknown;
  };
}

export function resourceName(suffix: string): string {
  if (!SUFFIX.test(suffix) || suffix.includes("--")) {
    throw new Error(
      `invalid staging suffix "${suffix}": use lowercase letters, digits and single hyphens`,
    );
  }
  const name = `${STAGING_PREFIX}${suffix}`;
  if (name.length > 63) throw new Error(`staging name "${name}" is longer than a DNS label allows`);
  return name;
}

/** Refuses to act on anything the staging tool did not name. */
export function assertManaged(name: string): void {
  if (!name.startsWith(STAGING_PREFIX) || name.length === STAGING_PREFIX.length) {
    throw new Error(`refusing to touch "${name}": not a ${STAGING_PREFIX} staging resource`);
  }
}

export function hostnameFor(name: string, zone: string): string {
  assertManaged(name);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) throw new Error(`invalid zone "${zone}"`);
  return `${name}.${zone}`;
}

export function assertAccount(expected: string, accessible: readonly string[]): void {
  if (!/^[0-9a-f]{32}$/.test(expected)) throw new Error("staging config has no valid account ID");
  if (!accessible.includes(expected)) {
    throw new Error("the configured staging account is not accessible with the current login");
  }
}

export function expiry(now: Date, lifetimeDays: number): string {
  if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 30) {
    throw new Error("lifetime must be 1 to 30 days");
  }
  return new Date(now.getTime() + lifetimeDays * 86_400_000).toISOString();
}

export function expired(deployments: readonly Deployment[], now: Date): Deployment[] {
  return deployments.filter((d) => Date.parse(d.expiresAt) <= now.getTime());
}

/**
 * Called by every command when it takes a deployment's lock. If the record still shows an upload
 * in progress, no process is running it any more (the lock proves that), so it was interrupted.
 * The earliest such time is kept, for the record only.
 */
export function markInterrupted(d: Deployment, now: Date): Deployment {
  if (d.uploadStartedAt === undefined) return d;
  const { uploadStartedAt: _, ...rest } = d;
  return { ...rest, uploadInterruptedAt: d.uploadInterruptedAt ?? now.toISOString() };
}

/**
 * The top-level keys a staging Wrangler configuration may use. Everything else is refused,
 * because the staging tool records and tears down only the Worker and its Access application:
 * bindings such as `r2_buckets`, `kv_namespaces`, `d1_databases`, `services`, `queues` or
 * `containers` would attach existing resources, perhaps outside staging, or provision new ones
 * that teardown never removes. Support for each comes with its own lifecycle in the tool.
 */
export const ALLOWED_CONFIG_KEYS: readonly string[] = [
  "$schema",
  "name",
  "main",
  "account_id",
  "compatibility_date",
  "compatibility_flags",
  "workers_dev",
  "preview_urls",
  "durable_objects",
  "migrations",
  "observability",
  "vars",
  "limits",
  "placement",
  "rules",
  "find_additional_modules",
  "base_dir",
  "no_bundle",
  "minify",
  "keep_names",
  "define",
  "alias",
  "tsconfig",
  "upload_source_maps",
];

function keysOutside(value: unknown, allowed: readonly string[]): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/**
 * The nested structures of the allowed keys that could still reach outside the deployment,
 * each with the keys it may use:
 *   - a Durable Object binding names only its own class: no `script_name` or `environment`,
 *     which would bind another Worker's objects;
 *   - a migration only creates, renames or deletes this Worker's own classes: no
 *     `transferred_classes`, which would move another Worker's stored objects into this one;
 *   - observability stays inside the Worker: no `destinations`, which would export logs or
 *     traces to existing account-level destinations.
 */
function nestedShapes(raw: Readonly<Record<string, unknown>>): [string, unknown, string[]][] {
  const shapes: [string, unknown, string[]][] = [];
  const objects = raw.durable_objects as { bindings?: unknown } | undefined;
  shapes.push(["durable_objects", objects, ["bindings"]]);
  const bindings = Array.isArray(objects?.bindings) ? objects.bindings : [];
  bindings.forEach((binding, i) => {
    shapes.push([`durable_objects.bindings[${i}]`, binding, ["name", "class_name"]]);
  });
  const migrations = Array.isArray(raw.migrations) ? raw.migrations : [];
  migrations.forEach((migration, i) => {
    shapes.push([
      `migrations[${i}]`,
      migration,
      ["tag", "new_classes", "new_sqlite_classes", "renamed_classes", "deleted_classes"],
    ]);
  });
  const observability = raw.observability as { logs?: unknown; traces?: unknown } | undefined;
  shapes.push([
    "observability",
    observability,
    ["enabled", "head_sampling_rate", "logs", "traces"],
  ]);
  shapes.push([
    "observability.logs",
    observability?.logs,
    ["enabled", "head_sampling_rate", "invocation_logs", "persist"],
  ]);
  shapes.push([
    "observability.traces",
    observability?.traces,
    ["enabled", "head_sampling_rate", "persist"],
  ]);
  return shapes;
}

/**
 * Refuses a Wrangler configuration that could reach outside the staging deployment:
 *   - Another account. Wrangler prefers the config's `account_id` to CLOUDFLARE_ACCOUNT_ID.
 *   - Another route. The staging tool adds its hostname with `--domain`, and Wrangler appends
 *     that to the configured routes rather than replacing them, so the configuration must have
 *     no routes of its own and must disable workers.dev and preview URLs explicitly: both
 *     default to on.
 *   - Another resource: anything outside ALLOWED_CONFIG_KEYS, and the nested structures in
 *     nestedShapes.
 */
export function validateDeployConfig(view: DeployConfigView, accountId: string): void {
  const problems: string[] = [];
  if (view.effective.account_id !== undefined && view.effective.account_id !== accountId) {
    problems.push('"account_id" names another account than the staging account');
  }
  const extra = Object.keys(view.raw).filter((key) => !ALLOWED_CONFIG_KEYS.includes(key));
  if (extra.length > 0) {
    problems.push(`the staging tool does not manage ${extra.map((k) => `"${k}"`).join(", ")}`);
  }
  for (const [path, value, allowed] of nestedShapes(view.raw)) {
    const outside = keysOutside(value, allowed);
    if (outside.length > 0) {
      problems.push(
        `${path} uses ${outside.map((k) => `"${k}"`).join(", ")}, which the staging tool does not manage`,
      );
    }
  }
  if (view.redirected) problems.push("it redirects to another configuration file");
  if ("env" in view.raw) problems.push("it defines environments; use a separate file instead");
  if (view.effective.targetEnvironment !== undefined) {
    problems.push("Wrangler selected an environment");
  }
  if (view.effective.workers_dev !== false) problems.push('"workers_dev" must be false');
  if (view.effective.preview_urls !== false) problems.push('"preview_urls" must be false');
  if (view.effective.route !== undefined) problems.push('it sets "route"');
  const routes = view.effective.routes;
  if (routes !== undefined && !(Array.isArray(routes) && routes.length === 0)) {
    problems.push('it sets "routes"; the staging hostname is the only route');
  }
  if (problems.length > 0) {
    throw new Error(`refusing Wrangler config ${view.path}: ${problems.join("; ")}`);
  }
}

/**
 * Picks the Access application that protects a deployment's hostname, or returns undefined when
 * there is none and one must be created. An application without a recorded ID is claimed only
 * if it carries the deployment's own name: that is the one an interrupted deploy created before
 * it could record the ID. Any other application on the hostname is refused.
 */
export function claimAccessApp(
  apps: readonly AccessApp[],
  deployment: Deployment,
): AccessApp | undefined {
  const onHost = apps.filter((app) => app.domain === deployment.hostname);
  if (onHost.length === 0) return undefined;
  const [only] = onHost;
  const ours =
    onHost.length === 1 &&
    only !== undefined &&
    (only.id === deployment.accessAppId ||
      (deployment.accessAppId === undefined && only.name === deployment.name));
  if (!ours) {
    throw new Error(
      `${deployment.hostname} has an Access application this tool did not record; inspect it in the Zero Trust dashboard`,
    );
  }
  return only;
}

/** Refuses an Access application that would let anyone but the owner through. */
export function assertOwnerOnly(app: AccessApp, hostname: string, ownerEmail: string): void {
  const ownerOnly = (rule: unknown) =>
    JSON.stringify(rule) === JSON.stringify({ email: { email: ownerEmail } });
  const ok =
    app.type === "self_hosted" &&
    app.domain === hostname &&
    app.policies !== undefined &&
    app.policies.length > 0 &&
    app.policies.every(
      (p) =>
        p.decision === "allow" &&
        p.include !== undefined &&
        p.include.length > 0 &&
        p.include.every(ownerOnly),
    );
  if (!ok) {
    throw new Error(`the Access application for ${hostname} is not owner-only; not deploying`);
  }
}

/** Owner-only Access application for one staging hostname. */
export function accessAppBody(
  name: string,
  hostname: string,
  config: StagingConfig,
): Record<string, unknown> {
  assertManaged(name);
  if (!hostname.startsWith(`${name}.`))
    throw new Error("hostname does not belong to this resource");
  return {
    type: "self_hosted",
    name,
    domain: hostname,
    session_duration: "24h",
    app_launcher_visible: false,
    ...(config.identityProviderId
      ? { allowed_idps: [config.identityProviderId], auto_redirect_to_identity: true }
      : {}),
    policies: [
      {
        name: "Allow owner",
        decision: "allow",
        include: [{ email: { email: config.ownerEmail } }],
      },
    ],
  };
}

const STATES: readonly string[] = ["pending", "deployed", "deleting"];

/** Parses `.staging/resources.json`. Unknown formats are refused, never guessed at. */
export function parseRegistry(json: unknown): Deployment[] {
  const file = json as { version?: unknown; deployments?: unknown };
  if (!file || typeof file !== "object" || file.version !== 2 || !Array.isArray(file.deployments)) {
    throw new Error("unrecognised staging registry format; expected version 2");
  }
  return file.deployments.map((entry: unknown) => {
    const d = entry as Record<string, unknown>;
    const text = (key: string) => typeof d[key] === "string" && d[key] !== "";
    if (
      !d ||
      !text("name") ||
      !text("hostname") ||
      !text("owner") ||
      !text("createdAt") ||
      !text("expiresAt") ||
      !STATES.includes(d.state as string) ||
      (d.accessAppId !== undefined && !text("accessAppId")) ||
      (d.uploadStartedAt !== undefined && !text("uploadStartedAt")) ||
      (d.uploadInterruptedAt !== undefined && !text("uploadInterruptedAt"))
    ) {
      throw new Error("malformed entry in the staging registry");
    }
    assertManaged(d.name as string);
    return d as unknown as Deployment;
  });
}

export function serializeRegistry(deployments: readonly Deployment[]): string {
  return `${JSON.stringify({ version: 2, deployments }, null, 2)}\n`;
}
