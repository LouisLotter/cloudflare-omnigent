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
  /**
   * Container applications the deployment's configuration declared, by name. Each name, which
   * is also its image repository, is the deployment's name or starts with it. Recorded before
   * the deploy that creates them; teardown deletes the applications and their images.
   */
  readonly containers?: readonly string[];
  /** R2 buckets the deployment created, named like its containers. Teardown empties and deletes them. */
  readonly buckets?: readonly string[];
  /**
   * Registry repositories the deployment's containers push to, besides the ones named after a
   * container (the default scheduling policy): a `durable_object`-policy container pushes to
   * `<worker>-<class>-<image>`. Teardown deletes every tag in each.
   */
  readonly repositories?: readonly string[];
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
 * because the staging tool records and tears down only what it manages: the Worker, its Access
 * application, its containers and its R2 buckets. Bindings such as `kv_namespaces`,
 * `d1_databases`, `services` or `queues` would attach existing resources, perhaps outside
 * staging, or provision new ones that teardown never removes. Support for each comes with its
 * own lifecycle in the tool.
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
  "containers",
  "r2_buckets",
];

/**
 * Keys a container entry may use, and the instance types and count the staging budget allows.
 * A `durable_object`-policy container has its own keys: Wrangler rejects `max_instances` and the
 * image keys for it, and its images are a map. The staging tool leaves out `ssh`,
 * `authorized_keys` and `unsafe`. Its instance size is chosen in code at each start, so the
 * configuration cannot cap it; teardown and expiry bound its cost.
 */
const DO_CONTAINER_KEYS = ["name", "class_name", "scheduling_policy", "images", "observability"];
const CONTAINER_KEYS = [
  "name",
  "class_name",
  "image",
  "max_instances",
  "instance_type",
  "image_build_context",
  "image_vars",
];
export const STAGING_INSTANCE_TYPES: readonly string[] = [
  "lite",
  "basic",
  "standard-1",
  "standard-2",
];
export const STAGING_MAX_INSTANCES = 3;
const RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** A managed-registry image pinned by digest: registry.cloudflare.com/<account>/<repo>@sha256:… */
const PINNED_IMAGE =
  /^registry\.cloudflare\.com\/([0-9a-f]{32})\/([a-z0-9._-]+)@sha256:[0-9a-f]{64}$/;

/** Wrangler's repository for a `durable_object`-policy image: `<worker>-<class>-<image>`, sanitised. */
export function policyRepository(worker: string, className: string, image: string): string {
  return `${worker}-${className}-${image}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isPolicyContainer(entry: unknown): boolean {
  return (entry as Record<string, unknown> | null)?.scheduling_policy === "durable_object";
}

/**
 * The containers, R2 buckets and registry repositories a configuration declares, for the
 * deployment `name`, which is also the Worker's name.
 */
export function declaredResources(
  raw: Readonly<Record<string, unknown>>,
  name: string,
): { containers: string[]; buckets: string[]; repositories: string[] } {
  const list = (value: unknown, key: string): string[] =>
    Array.isArray(value)
      ? value
          .map((entry) => (entry as Record<string, unknown> | null)?.[key])
          .filter((item): item is string => typeof item === "string")
      : [];
  const repositories: string[] = [];
  for (const entry of Array.isArray(raw.containers) ? raw.containers : []) {
    const c = (entry ?? {}) as Record<string, unknown>;
    if (!isPolicyContainer(c)) {
      if (typeof c.name === "string") repositories.push(c.name);
      continue;
    }
    const images = c.images;
    if (images === null || typeof images !== "object" || Array.isArray(images)) continue;
    for (const [key, value] of Object.entries(images)) {
      const pinned = (value as { image?: unknown } | null)?.image;
      const match = typeof pinned === "string" ? PINNED_IMAGE.exec(pinned) : null;
      if (match?.[2]) repositories.push(match[2]);
      else if (typeof c.class_name === "string") {
        repositories.push(policyRepository(name, c.class_name, key));
      }
    }
  }
  return {
    containers: list(raw.containers, "name"),
    buckets: list(raw.r2_buckets, "bucket_name"),
    repositories: [...new Set(repositories)],
  };
}

/** True when a resource name belongs to the deployment `name`: equal to it, or `name-…`. */
export function ownedBy(resource: string, name: string): boolean {
  return resource === name || resource.startsWith(`${name}-`);
}

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
  const containers = Array.isArray(raw.containers) ? raw.containers : [];
  containers.forEach((container, i) => {
    if (!isPolicyContainer(container)) {
      shapes.push([`containers[${i}]`, container, CONTAINER_KEYS]);
      return;
    }
    const c = (container ?? {}) as Record<string, unknown>;
    shapes.push([`containers[${i}]`, c, DO_CONTAINER_KEYS]);
    // Wrangler allows only logs on or off for this policy.
    shapes.push([`containers[${i}].observability`, c.observability, ["logs"]]);
    shapes.push([
      `containers[${i}].observability.logs`,
      (c.observability as { logs?: unknown } | undefined)?.logs,
      ["enabled"],
    ]);
    const images = c.images;
    if (images !== null && typeof images === "object" && !Array.isArray(images)) {
      for (const [key, value] of Object.entries(images)) {
        const keys =
          (value as { image?: unknown } | null)?.image !== undefined
            ? ["image"]
            : ["dockerfile", "build_context", "build_vars"];
        shapes.push([`containers[${i}].images.${key}`, value, keys]);
      }
    }
  });
  const buckets = Array.isArray(raw.r2_buckets) ? raw.r2_buckets : [];
  buckets.forEach((bucket, i) => {
    shapes.push([`r2_buckets[${i}]`, bucket, ["binding", "bucket_name"]]);
  });
  return shapes;
}

/**
 * A `durable_object`-policy container: 1 to 100 images, each either built from a Dockerfile or
 * pinned by digest to a repository of this deployment in the staging account's registry.
 */
function policyContainerProblems(
  c: Record<string, unknown>,
  i: number,
  name: string,
  accountId: string,
): string[] {
  const problems: string[] = [];
  if (typeof c.class_name !== "string" || c.class_name === "") {
    problems.push(`containers[${i}] needs a "class_name"`);
  }
  const images = c.images;
  if (images === null || typeof images !== "object" || Array.isArray(images)) {
    return [...problems, `containers[${i}] needs an "images" map`];
  }
  const entries = Object.entries(images);
  if (entries.length < 1 || entries.length > 100) {
    problems.push(`containers[${i}] needs 1 to 100 "images"`);
  }
  for (const [key, value] of entries) {
    const v = (value ?? {}) as Record<string, unknown>;
    if (key.length < 1 || key.length > 128) problems.push(`containers[${i}].images has a bad key`);
    if ((v.dockerfile === undefined) === (v.image === undefined)) {
      problems.push(`containers[${i}].images.${key} needs exactly one of "dockerfile" and "image"`);
    }
    if (v.image !== undefined) {
      const match = typeof v.image === "string" ? PINNED_IMAGE.exec(v.image) : null;
      if (!match || match[1] !== accountId || !ownedBy(match[2] ?? "", name)) {
        problems.push(
          `containers[${i}].images.${key} may only pin an image of ${name} in the staging account's registry by digest`,
        );
      }
    }
  }
  return problems;
}

/**
 * Containers and buckets must carry the deployment's name, so that teardown can find them and
 * nothing outside staging is attached. Containers stay within the staging budget.
 */
function resourceProblems(
  raw: Readonly<Record<string, unknown>>,
  name: string,
  accountId: string,
): string[] {
  const problems: string[] = [];
  for (const key of ["containers", "r2_buckets"]) {
    if (raw[key] !== undefined && !Array.isArray(raw[key]))
      problems.push(`"${key}" must be a list`);
  }
  const containers = Array.isArray(raw.containers) ? raw.containers : [];
  containers.forEach((entry, i) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    if (typeof c.name !== "string" || !RESOURCE_NAME.test(c.name) || !ownedBy(c.name, name)) {
      problems.push(`containers[${i}] needs a lowercase "name" of ${name} or ${name}-…`);
    }
    if (c.scheduling_policy !== undefined && c.scheduling_policy !== "durable_object") {
      problems.push(`containers[${i}] "scheduling_policy" may only be "durable_object"`);
    }
    if (isPolicyContainer(c)) {
      problems.push(...policyContainerProblems(c, i, name, accountId));
      return;
    }
    if (
      !Number.isInteger(c.max_instances) ||
      (c.max_instances as number) < 1 ||
      (c.max_instances as number) > STAGING_MAX_INSTANCES
    ) {
      problems.push(`containers[${i}] needs "max_instances" from 1 to ${STAGING_MAX_INSTANCES}`);
    }
    if (
      c.instance_type !== undefined &&
      !STAGING_INSTANCE_TYPES.includes(c.instance_type as string)
    ) {
      problems.push(
        `containers[${i}] "instance_type" must be one of ${STAGING_INSTANCE_TYPES.join(", ")}`,
      );
    }
  });
  const buckets = Array.isArray(raw.r2_buckets) ? raw.r2_buckets : [];
  buckets.forEach((entry, i) => {
    const b = (entry ?? {}) as Record<string, unknown>;
    const bucket = b.bucket_name;
    if (typeof bucket !== "string" || !RESOURCE_NAME.test(bucket) || !ownedBy(bucket, name)) {
      problems.push(`r2_buckets[${i}] needs a "bucket_name" of ${name} or ${name}-…`);
    }
  });
  return problems;
}

/**
 * Refuses a Wrangler configuration that could reach outside the staging deployment:
 *   - Another account. Wrangler prefers the config's `account_id` to CLOUDFLARE_ACCOUNT_ID.
 *   - Another route. The staging tool adds its hostname with `--domain`, and Wrangler appends
 *     that to the configured routes rather than replacing them, so the configuration must have
 *     no routes of its own and must disable workers.dev and preview URLs explicitly: both
 *     default to on.
 *   - Another resource: anything outside ALLOWED_CONFIG_KEYS, the nested structures in
 *     nestedShapes, and containers or buckets that do not carry the deployment's name.
 */
export function validateDeployConfig(
  view: DeployConfigView,
  accountId: string,
  name: string,
): void {
  assertManaged(name);
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
  problems.push(...resourceProblems(view.raw, name, accountId));
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
    const names = (value: unknown) =>
      value === undefined ||
      (Array.isArray(value) &&
        value.every((n) => typeof n === "string" && n.startsWith(STAGING_PREFIX)));
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
      (d.uploadInterruptedAt !== undefined && !text("uploadInterruptedAt")) ||
      !names(d.containers) ||
      !names(d.buckets) ||
      !names(d.repositories)
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
