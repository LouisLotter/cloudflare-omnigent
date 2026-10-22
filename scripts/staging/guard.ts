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
  /** A create intent for the Access application (see the create intents below). */
  readonly accessCreateStartedAt?: string;
  /** The nonce of the Access application's create (see the create intents below). */
  readonly accessNonce?: string;
  /**
   * When the tool first started uploading this Worker. From then on the Worker name and the
   * custom domain on `hostname` are this deployment's; before, both must be free (ops.ts,
   * checkWorkerAndDomain).
   */
  readonly workerSince?: string;
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
  /** Create intents for buckets, by name (see the create intents below). */
  readonly pendingBuckets?: readonly string[];
  /**
   * Registry repositories the deployment's containers push to, besides the ones named after a
   * container (the default scheduling policy): a `durable_object`-policy container pushes to
   * `<worker>-<class>-<image>`. Teardown deletes every tag in each.
   */
  readonly repositories?: readonly string[];
  /** The deployment's Cloudflare Tunnel, when its staging manifest asks for one. */
  readonly tunnel?: TunnelRecord;
  /** Workers VPC services on that Tunnel. They accumulate across deploys, like containers. */
  readonly vpcServices?: readonly VpcServiceRecord[];
  /**
   * The deployments whose Durable Objects this one's Worker binds. A deployment that another
   * record depends on is not torn down. A deploy adds its bindings' targets before the upload
   * and drops those it no longer binds only after an upload without them succeeded.
   */
  readonly dependsOn?: readonly string[];
  /** F7-staging: the deployment's Access service token, when its manifest asks for one. */
  readonly serviceToken?: ServiceTokenRecord;
}

/**
 * An Access service token named `<deployment>-svc--<nonce>`. Cloudflare shows its client secret
 * only when it creates or rotates the token, so the record says which Worker secrets hold the
 * current one. A run that cannot show the secret arrived rotates the token and sends the new
 * one; the record forgets `deliveredTo` before every rotation. Its create has an intent and a
 * nonce like every other.
 */
export interface ServiceTokenRecord {
  /** `<deployment>-svc`, before the nonce. */
  readonly name: string;
  readonly id?: string;
  readonly createStartedAt?: string;
  readonly nonce?: string;
  /** The client ID and secret Worker secrets that hold the current credentials. */
  readonly deliveredTo?: readonly string[];
}

/**
 * A remotely managed Cloudflare Tunnel named after the deployment. Each field is recorded before
 * the resource it names is created, and each ID as soon as Cloudflare returns it, so teardown
 * finds everything an interrupted run made.
 */
export interface TunnelRecord {
  /** The deployment's name: the Tunnel is named `<name>--<nonce>`. */
  readonly name: string;
  readonly id?: string;
  readonly createStartedAt?: string;
  readonly nonce?: string;
  /**
   * The public hostname `<deployment>-tunnel.<zone>`, when the manifest asks for one. It has
   * its own owner-only Access application, a proxied DNS record to the Tunnel, and a route to
   * the deployment's Worker.
   */
  readonly hostname?: string;
  readonly accessAppId?: string;
  readonly accessCreateStartedAt?: string;
  readonly accessNonce?: string;
  readonly dnsRecordId?: string;
  readonly dnsCreateStartedAt?: string;
  readonly dnsNonce?: string;
}

/** An HTTP Workers VPC service on the deployment's Tunnel, to 127.0.0.1:<port>. */
export interface VpcServiceRecord {
  /** `<deployment>-<binding>`, lowercased, with hyphens for underscores; `--<nonce>` follows. */
  readonly name: string;
  readonly binding: string;
  readonly port: number;
  readonly id?: string;
  readonly createStartedAt?: string;
  readonly nonce?: string;
}

/*
 * Create intents. Each `…CreateStartedAt` is written before the tool asks Cloudflare to create
 * the resource and removed together with recording its ID. A command that finds one set does
 * not know whether that create took effect, or will: it lists the resource, waits the settle
 * time once if it is not there, and lists again (ops.ts, settleCreates).
 *
 * Each intent also records a nonce, fresh for that create, and the resource carries it: in its
 * name (nonceName) or, for a DNS record, in its comment (dnsComment). The nonce stays with the
 * ID. Recovery adopts only a resource that carries the intent's own nonce, with exactly the
 * properties the tool gave it; anything else under the tool's names is refused, never adopted.
 * A record from before nonces holds IDs without one, for resources named exactly the base.
 *
 * R2 gives a bucket no field for a nonce, and the Wrangler configuration fixes its name, so a
 * bucket's intent (`pendingBuckets`) adopts the bucket by name: the record named it before the
 * create, after checking that no bucket had the name.
 */

/**
 * A create nonce: 8 or more lower-case hex digits. The tool draws 8 at random (stg.ts), so two
 * creates of one resource collide with odds of one in four billion.
 */
export const NONCE = /^[0-9a-f]{8,}$/;

/**
 * The name the tool gives a resource whose create carries `nonce`: `<base>--<nonce>`. A staging
 * name never holds `--` (resourceName, vpcServiceName), so the nonce is unambiguous. Without a
 * nonce, the base: what a record from before nonces holds.
 *
 * Workers VPC refuses a service name with consecutive hyphens ([5101], X1 staging deploy, 20 Oct
 * 2026), so a VPC service's nonce follows a single hyphen (VPC_NONCE_SEPARATOR). Another name
 * that merely looks like one of its nonces can then only make the tool refuse a create
 * (refuseOthers): adoption and deletion match the exact name.
 */
export function nonceName(base: string, nonce: string | undefined, separator = "--"): string {
  if (nonce === undefined) return base;
  if (!NONCE.test(nonce)) throw new Error(`invalid create nonce "${nonce}"`);
  return `${base}${separator}${nonce}`;
}

export const VPC_NONCE_SEPARATOR = "-";

/** Whether `name` is one the tool gives a resource named after `base`, with any nonce or none. */
export function namedFor(name: string, base: string, separator = "--"): boolean {
  return (
    name === base ||
    (name.startsWith(`${base}${separator}`) &&
      NONCE.test(name.slice(base.length + separator.length)))
  );
}

/** The comment the tool gives a DNS record: its deployment and the create's nonce. */
export function dnsComment(deployment: string, nonce: string): string {
  return `${deployment}: staging tool ${nonce}`;
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
  readonly same_site_cookie_attribute?: string;
  readonly policies?: readonly {
    readonly decision?: string;
    readonly include?: readonly unknown[];
  }[];
}

/** A Cloudflare Tunnel as the staging tool reads it: only live ones are listed. */
export interface TunnelInfo {
  readonly id: string;
  readonly name: string;
}

/** One rule of a remotely managed Tunnel's ingress. */
export interface IngressRule {
  readonly hostname?: string;
  readonly path?: string;
  readonly service: string;
}

export interface DnsRecordInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: string;
  readonly proxied: boolean;
  readonly comment?: string;
}

/** A Workers custom domain: a hostname and the Worker it serves. */
export interface WorkerDomain {
  readonly hostname: string;
  readonly service: string;
}

export interface ServiceTokenInfo {
  readonly id: string;
  readonly name: string;
}

/** What creating or rotating a service token returns. The secret is shown only then. */
export interface ServiceTokenCredentials {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** A Workers VPC service, flattened to the fields the staging tool checks. */
export interface VpcServiceInfo {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
  readonly ipv4?: string;
  readonly tunnelId?: string;
  readonly httpPort?: number;
  readonly httpsPort?: number;
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

/**
 * The Tunnel's public hostname, `<deployment>-tunnel.<zone>`, with its own Access application
 * named `<deployment>-tunnel`. A deployment of that name would share the hostname, so the
 * registry claims it for one deployment only (see claimKeys).
 */
export function tunnelHostnameFor(name: string, zone: string): string {
  const label = `${name}-tunnel`;
  if (label.length > 63) throw new Error(`${name} is too long for a Tunnel hostname`);
  return hostnameFor(label, zone);
}

/** The Access application name for a hostname this tool made: its first label. */
export function appNameFor(hostname: string): string {
  return hostname.slice(0, hostname.indexOf("."));
}

/** Where a Workers VPC service reaches: the Tunnel connector's own host. */
export const VPC_HOST = "127.0.0.1";

/**
 * The configuration the tool renders for a deploy: a hidden file next to the checked one, so
 * that its relative paths still resolve, matched by the `.gitignore` pattern
 * `.stg-rendered.*.jsonc`.
 */
export function renderedConfigPath(configPath: string, name: string): string {
  assertManaged(name);
  return `${configPath.slice(0, configPath.lastIndexOf("/") + 1)}.stg-rendered.${name}.jsonc`;
}

/** A Workers VPC service's name: `<deployment>-<binding>`, lowercased, hyphens for underscores. */
export function vpcServiceName(name: string, binding: string): string {
  assertManaged(name);
  const service = `${name}-${binding.toLowerCase().replaceAll("_", "-")}`;
  // `--` comes before a create nonce only (nonceName).
  if (service.includes("--")) throw new Error(`VPC binding ${binding} has a double underscore`);
  return service;
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
  // Cron triggers only (triggerProblems): they schedule this Worker and go with it at teardown.
  "triggers",
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

/**
 * The names a deployment's secrets may have, as a Worker binding: what Wrangler and the Worker's
 * environment accept. The values are never checked or shown here.
 */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Problems with secret names given to deploy --secrets-stdin or the secrets command. */
export function secretNameProblems(names: readonly string[]): string[] {
  const bad = names.filter((name) => !SECRET_NAME.test(name));
  return bad.length > 0
    ? [`invalid secret names: ${bad.map((n) => JSON.stringify(n.slice(0, 40))).join(", ")}`]
    : [];
}

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
/**
 * The configuration as a staging deploy uploads it: a container without a `name` gets
 * `<deployment>-<class name>`, lowercased, the name Wrangler would derive from the Worker's
 * name and the class. So the checked-in production configuration, which leaves its container
 * names to Wrangler, deploys to staging under the deployment's names, as its Worker does under
 * `--name`. A container that names itself keeps its name, which must then be the deployment's
 * (resourceProblems), so nothing is deployed under another or a production name. Idempotent.
 */
export function withStagingNames(
  raw: Readonly<Record<string, unknown>>,
  name: string,
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(raw.containers)) return raw;
  let changed = false;
  const containers = raw.containers.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const c = entry as Record<string, unknown>;
    if (c.name !== undefined || typeof c.class_name !== "string") return c;
    const slug = c.class_name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug === "") return c;
    changed = true;
    return { ...c, name: `${name}-${slug}` };
  });
  return changed ? { ...raw, containers } : raw;
}

/** True when a staging deploy uploads this configuration with names it did not carry. */
export function needsStagingNames(raw: Readonly<Record<string, unknown>>, name: string): boolean {
  return withStagingNames(raw, name) !== raw;
}

/** A cron expression of five fields, numbers and the plain operators only. */
const CRON = /^[0-9*/,-]+( [0-9*/,-]+){4}$/;
const MAX_CRONS = 3;

/** `triggers` may hold cron schedules and nothing else (ALLOWED_CONFIG_KEYS). */
function triggerProblems(triggers: unknown): string[] {
  if (triggers === undefined || triggers === null) return [];
  if (triggers === null || typeof triggers !== "object" || Array.isArray(triggers)) {
    return ['"triggers" must be an object with "crons" only'];
  }
  const crons = (triggers as { crons?: unknown }).crons;
  if (
    !Array.isArray(crons) ||
    crons.length === 0 ||
    crons.length > MAX_CRONS ||
    !crons.every((cron) => typeof cron === "string" && CRON.test(cron))
  ) {
    return [`"triggers.crons" must list 1 to ${MAX_CRONS} cron expressions of five numeric fields`];
  }
  return [];
}

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

function doBindings(raw: Readonly<Record<string, unknown>>): unknown[] {
  const objects = raw.durable_objects as { bindings?: unknown } | undefined;
  return Array.isArray(objects?.bindings) ? objects.bindings : [];
}

/**
 * The dependency cycle that recording `dependsOn` for the deployment `name` would close, from
 * `name` back to it, or undefined when there is none. The other deployments' dependencies come
 * from the registry, including those kept from interrupted uploads. In a cycle, each teardown
 * would refuse because another deployment depends on it.
 */
export function dependencyCycle(
  deployments: readonly Deployment[],
  name: string,
  dependsOn: readonly string[],
): string[] | undefined {
  const next = (node: string) =>
    node === name ? dependsOn : (deployments.find((d) => d.name === node)?.dependsOn ?? []);
  const seen = new Set<string>();
  const search = (node: string, trail: readonly string[]): string[] | undefined => {
    for (const target of next(node)) {
      if (target === name) return [...trail, target];
      if (seen.has(target)) continue;
      seen.add(target);
      const cycle = search(target, [...trail, target]);
      if (cycle) return cycle;
    }
    return undefined;
  };
  return search(name, [name]);
}

/**
 * The other deployments whose Durable Objects a configuration binds, by name, sorted. Only names
 * a staging deployment can have count; validateDeployConfig refuses any other.
 */
export function boundDeployments(raw: Readonly<Record<string, unknown>>, name: string): string[] {
  const names = doBindings(raw)
    .map((entry) => (entry as Record<string, unknown> | null)?.script_name)
    .filter(
      (script): script is string =>
        typeof script === "string" && /^cfo-stg-[a-z0-9-]+$/.test(script) && script !== name,
    );
  return [...new Set(names)].sort();
}

/**
 * A Durable Object binding to another Worker reaches that Worker's stored objects, so it may
 * name only a staging deployment of the same owner that is deployed: one this tool created,
 * whose objects belong to the same work, and whose teardown is recorded.
 */
function crossScriptProblems(
  raw: Readonly<Record<string, unknown>>,
  name: string,
  registry: NonNullable<ConfigAllowances["registry"]>,
): string[] {
  const problems: string[] = [];
  for (const [i, entry] of doBindings(raw).entries()) {
    const script = (entry as Record<string, unknown> | null)?.script_name;
    if (script === undefined) continue;
    const target = registry.deployments.find((d) => d.name === script);
    let why: string | undefined;
    if (typeof script !== "string" || !script.startsWith(STAGING_PREFIX)) {
      why = "is not a staging deployment";
    } else if (script === name) {
      why = "is this deployment itself; leave script_name out";
    } else if (!target) {
      why = "has no record in the staging registry";
    } else if (target.owner !== registry.owner) {
      why = `belongs to ${target.owner}, not ${registry.owner}`;
    } else if (target.state !== "deployed") {
      why = `is ${target.state}, not deployed`;
    }
    if (why) {
      problems.push(
        `durable_objects.bindings[${i}] "script_name" ${JSON.stringify(script)} ${why}`,
      );
    }
  }
  return problems;
}

/**
 * What a configuration may use besides its own resources, given by the caller because it
 * depends on state outside the file.
 */
export interface ConfigAllowances {
  /**
   * The registry and the deploying owner. With them, a Durable Object binding may name another
   * Worker in `script_name`, if that Worker is a staging deployment of the same owner in state
   * `deployed`. The bound Worker keeps its own migrations.
   */
  readonly registry?: { readonly owner: string; readonly deployments: readonly Deployment[] };
  /**
   * For a configuration the staging tool rendered from a checked one: what it added. Exactly
   * these routes, and `vpc_services` entries that bind the services this deployment recorded.
   */
  readonly rendered?: {
    readonly routes: readonly WorkerRoute[];
    readonly vpcServiceIds: readonly string[];
  };
}

/** A zone route the staging tool adds for the Tunnel hostname. */
export interface WorkerRoute {
  readonly pattern: string;
  readonly zone_name: string;
}

/** The Worker route that sends the Tunnel hostname's requests to the deployment's Worker. */
export function tunnelRoute(tunnelHostname: string, zone: string): WorkerRoute {
  return { pattern: `${tunnelHostname}/*`, zone_name: zone };
}

function sameRoutes(actual: unknown, expected: readonly WorkerRoute[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((route, i) => {
    const r = actual[i] as Record<string, unknown> | null;
    return (
      r !== null &&
      typeof r === "object" &&
      keysOutside(r, ["pattern", "zone_name"]).length === 0 &&
      r.pattern === route.pattern &&
      r.zone_name === route.zone_name
    );
  });
}

/**
 * The keys a rendered configuration adds to the checked ones: `routes` only when the tool adds
 * a route, `vpc_services` only when the deployment recorded VPC services.
 */
function renderedKeys(rendered: ConfigAllowances["rendered"]): string[] {
  return [
    ...(rendered && rendered.routes.length > 0 ? ["routes"] : []),
    ...(rendered && rendered.vpcServiceIds.length > 0 ? ["vpc_services"] : []),
  ];
}

/** The rendered configuration's additions, each checked against what the tool recorded. */
function renderedProblems(
  view: DeployConfigView,
  rendered: NonNullable<ConfigAllowances["rendered"]>,
): string[] {
  const problems: string[] = [];
  const raw = view.raw;
  if (
    rendered.routes.length > 0 &&
    !(sameRoutes(raw.routes, rendered.routes) && sameRoutes(view.effective.routes, rendered.routes))
  ) {
    problems.push('"routes" differs from the Tunnel route the staging tool adds');
  }
  const services = raw.vpc_services;
  if (services === undefined || rendered.vpcServiceIds.length === 0) return problems;
  if (!Array.isArray(services)) return [...problems, '"vpc_services" must be a list'];
  const bindings = new Set<unknown>();
  services.forEach((entry, i) => {
    const s = (entry ?? {}) as Record<string, unknown>;
    const outside = keysOutside(s, ["binding", "service_id"]);
    if (outside.length > 0) problems.push(`vpc_services[${i}] uses ${outside.join(", ")}`);
    if (typeof s.binding !== "string" || s.binding === "" || bindings.has(s.binding)) {
      problems.push(`vpc_services[${i}] needs its own "binding"`);
    }
    bindings.add(s.binding);
    if (!rendered.vpcServiceIds.includes(s.service_id as string)) {
      problems.push(`vpc_services[${i}] binds a VPC service this deployment did not record`);
    }
  });
  return problems;
}

/**
 * The nested structures of the allowed keys that could still reach outside the deployment,
 * each with the keys it may use:
 *   - a Durable Object binding names only its own class: no `environment`, and no
 *     `script_name` unless the registry allows it (crossScriptProblems), since either would
 *     bind another Worker's objects;
 *   - a migration only creates, renames or deletes this Worker's own classes: no
 *     `transferred_classes`, which would move another Worker's stored objects into this one;
 *   - observability stays inside the Worker: no `destinations`, which would export logs or
 *     traces to existing account-level destinations.
 */
function nestedShapes(
  raw: Readonly<Record<string, unknown>>,
  allowances: ConfigAllowances,
): [string, unknown, string[]][] {
  const shapes: [string, unknown, string[]][] = [];
  const objects = raw.durable_objects as { bindings?: unknown } | undefined;
  shapes.push(["durable_objects", objects, ["bindings"]]);
  const bindingKeys = ["name", "class_name", ...(allowances.registry ? ["script_name"] : [])];
  for (const [i, binding] of doBindings(raw).entries()) {
    shapes.push([`durable_objects.bindings[${i}]`, binding, bindingKeys]);
  }
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
  shapes.push(["triggers", raw.triggers, ["crons"]]);
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
  const seen = new Set<string>();
  containers.forEach((entry, i) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    if (typeof c.name !== "string" || !RESOURCE_NAME.test(c.name) || !ownedBy(c.name, name)) {
      problems.push(`containers[${i}] needs a lowercase "name" of ${name} or ${name}-…`);
    } else if (seen.has(c.name)) {
      problems.push(`containers[${i}] repeats the name ${c.name}`);
    } else seen.add(c.name);
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
 *     default to on. The only other route is the Tunnel hostname's, which the tool itself
 *     writes into the configuration it renders (ConfigAllowances.rendered).
 *   - Another resource: anything outside ALLOWED_CONFIG_KEYS, the nested structures in
 *     nestedShapes, and containers or buckets that do not carry the deployment's name.
 *     `allowances` widens this only as each of its fields describes.
 */
export function validateDeployConfig(
  view: DeployConfigView,
  accountId: string,
  name: string,
  allowances: ConfigAllowances = {},
): void {
  assertManaged(name);
  const { rendered } = allowances;
  const problems: string[] = [];
  if (view.effective.account_id !== undefined && view.effective.account_id !== accountId) {
    problems.push('"account_id" names another account than the staging account');
  }
  const allowedKeys = [...ALLOWED_CONFIG_KEYS, ...renderedKeys(rendered)];
  const extra = Object.keys(view.raw).filter((key) => !allowedKeys.includes(key));
  if (extra.length > 0) {
    problems.push(`the staging tool does not manage ${extra.map((k) => `"${k}"`).join(", ")}`);
  }
  for (const [path, value, allowed] of nestedShapes(view.raw, allowances)) {
    const outside = keysOutside(value, allowed);
    if (outside.length > 0) {
      problems.push(
        `${path} uses ${outside.map((k) => `"${k}"`).join(", ")}, which the staging tool does not manage`,
      );
    }
  }
  if (allowances.registry) {
    problems.push(...crossScriptProblems(view.raw, name, allowances.registry));
  }
  if (rendered) problems.push(...renderedProblems(view, rendered));
  // Containers are checked under the names a staging deploy gives them (withStagingNames).
  problems.push(...resourceProblems(withStagingNames(view.raw, name), name, accountId));
  problems.push(...triggerProblems(view.raw.triggers));
  if (view.redirected) problems.push("it redirects to another configuration file");
  if ("env" in view.raw) problems.push("it defines environments; use a separate file instead");
  if (view.effective.targetEnvironment !== undefined) {
    problems.push("Wrangler selected an environment");
  }
  if (view.effective.workers_dev !== false) problems.push('"workers_dev" must be false');
  if (view.effective.preview_urls !== false) problems.push('"preview_urls" must be false');
  if (view.effective.route !== undefined) problems.push('it sets "route"');
  const routes = view.effective.routes;
  const toolRoutes = rendered !== undefined && rendered.routes.length > 0;
  if (!toolRoutes && routes !== undefined && !(Array.isArray(routes) && routes.length === 0)) {
    problems.push('it sets "routes"; the staging hostname is the only route');
  }
  if (problems.length > 0) {
    throw new Error(`refusing Wrangler config ${view.path}: ${problems.join("; ")}`);
  }
}

/**
 * Whether an Access application has the name and type the tool gives the one on `target`. Only
 * such an application is adopted, and only while a create intent for it is recorded: a name
 * alone proves nothing (ops.ts, settleCreates).
 */
export function accessAppFits(app: AccessApp, target: ProtectedHost): boolean {
  return app.domain === target.hostname && app.name === target.name && app.type === "self_hosted";
}

/**
 * A hostname the staging tool puts Access in front of: the deployment's own, or its Tunnel's.
 * `name` is the Access application's name, and `accessAppId` the recorded ID, if any.
 */
export interface ProtectedHost {
  readonly name: string;
  readonly hostname: string;
  readonly accessAppId?: string | undefined;
}

/**
 * The ingress of the deployment's Tunnel: its public hostname to the origin, if it has one,
 * then the catch-all 404 that Cloudflare requires last. Workers VPC services route by their own
 * host and port and need no ingress rule.
 */
export function tunnelIngress(
  hostname: string | undefined,
  origin: string | undefined,
): IngressRule[] {
  return [
    ...(hostname !== undefined && origin !== undefined ? [{ hostname, service: origin }] : []),
    { service: "http_status:404" },
  ];
}

/**
 * True when a Tunnel's ingress routes exactly as `desired` does: the same hostnames and paths
 * to the same services, in order. Origin request settings are not compared; the tool sets none.
 */
export function sameIngress(
  actual: readonly IngressRule[],
  desired: readonly IngressRule[],
): boolean {
  return (
    actual.length === desired.length &&
    desired.every(
      (rule, i) =>
        actual[i]?.hostname === rule.hostname &&
        actual[i]?.path === rule.path &&
        actual[i]?.service === rule.service,
    )
  );
}

/**
 * Refuses an Access application that would let anyone but the owner through. With
 * `serviceTokenId`, the application may also hold one policy that admits exactly that token
 * (isServiceTokenPolicy); callers pass it only for the deployment's own recorded token.
 */
export function assertOwnerOnly(
  app: AccessApp,
  hostname: string,
  ownerEmail: string,
  serviceTokenId?: string,
): void {
  const ownerOnly = (rule: unknown) =>
    JSON.stringify(rule) === JSON.stringify({ email: { email: ownerEmail } });
  type Policy = NonNullable<AccessApp["policies"]>[number];
  const ownerPolicy = (p: Policy) =>
    p.decision === "allow" &&
    p.include !== undefined &&
    p.include.length > 0 &&
    p.include.every(ownerOnly);
  const tokenPolicy = (p: Policy) =>
    serviceTokenId !== undefined && isServiceTokenPolicy(p, serviceTokenId);
  const policies = app.policies ?? [];
  const ok =
    app.type === "self_hosted" &&
    app.domain === hostname &&
    policies.some(ownerPolicy) &&
    policies.every((p) => ownerPolicy(p) || tokenPolicy(p)) &&
    policies.filter(tokenPolicy).length <= 1;
  if (!ok) {
    throw new Error(`the Access application for ${hostname} is not owner-only; not deploying`);
  }
}

/**
 * F7-staging (X1 pre-registration, section 10): the one policy besides the owner's that a
 * staging application may hold. It admits exactly one service token, the deployment's own,
 * without an identity, and only on a hostname the deployment's manifest names. assertOwnerOnly
 * accepts it only when given that token's ID, and at most once.
 */
export function isServiceTokenPolicy(
  policy: NonNullable<AccessApp["policies"]>[number],
  serviceTokenId: string,
): boolean {
  return (
    policy.decision === "non_identity" &&
    JSON.stringify(policy.include) ===
      JSON.stringify([{ service_token: { token_id: serviceTokenId } }])
  );
}

/** How long the staging service token lasts: one day, enough for X1's preflight and run. */
export const SERVICE_TOKEN_DURATION = "24h";

/**
 * The SameSite attribute of every staging application's CF_Authorization cookie (owner decision
 * D9). Left unset, Access sends SameSite=None, and cross-site requests from a signed-in browser
 * reach the Worker carrying the cookie (spike S6).
 */
export const ACCESS_SAME_SITE = "lax";

/** Refuses an Access application whose cookie is not SameSite=lax. */
export function assertSameSite(app: AccessApp, hostname: string): void {
  if (app.same_site_cookie_attribute !== ACCESS_SAME_SITE) {
    throw new Error(
      `the Access application for ${hostname} does not set SameSite=${ACCESS_SAME_SITE}; not deploying`,
    );
  }
}

/** Owner-only Access application for one staging hostname. */
export function accessAppBody(
  name: string,
  hostname: string,
  config: StagingConfig,
  serviceTokenId?: string,
): Record<string, unknown> {
  assertManaged(name);
  // The application is named after the hostname's first label, with its create nonce.
  if (!hostname.includes(".") || !namedFor(name, appNameFor(hostname)))
    throw new Error("hostname does not belong to this resource");
  return {
    type: "self_hosted",
    name,
    domain: hostname,
    session_duration: "24h",
    app_launcher_visible: false,
    same_site_cookie_attribute: ACCESS_SAME_SITE,
    ...(config.identityProviderId
      ? { allowed_idps: [config.identityProviderId], auto_redirect_to_identity: true }
      : {}),
    policies: [
      {
        name: "Allow owner",
        decision: "allow",
        include: [{ email: { email: config.ownerEmail } }],
      },
      ...(serviceTokenId !== undefined
        ? [
            {
              name: "Allow the staging service token",
              decision: "non_identity",
              include: [{ service_token: { token_id: serviceTokenId } }],
            },
          ]
        : []),
    ],
  };
}

/**
 * The staging manifest: an optional `staging.jsonc` next to a Wrangler configuration that asks
 * for resources a Wrangler configuration cannot declare. Without one, deploy runs exactly as
 * before. It applies to every configuration in its directory.
 */
export const MANIFEST_FILE = "staging.jsonc";

export interface Manifest {
  readonly tunnel?: TunnelManifest;
  readonly vpcServices: readonly VpcServiceManifest[];
  readonly serviceToken?: ServiceTokenManifest;
}

/** The deployment's own hostnames that a service token may be admitted to. */
export type TokenHostname = "worker" | "tunnel";

/**
 * F7-staging, only with the owner's approval: an Access service token `<deployment>-svc`,
 * lasting SERVICE_TOKEN_DURATION, admitted by a second policy on the named hostnames of this
 * deployment only. Its client ID and secret go only to the two named Worker secrets.
 */
export interface ServiceTokenManifest {
  readonly hostnames: readonly TokenHostname[];
  readonly clientIdSecret: string;
  readonly clientSecretSecret: string;
}

/** A remotely managed Tunnel owned by the deployment and named after it. */
export interface TunnelManifest {
  /** Gives the Tunnel the public hostname `<deployment>-tunnel.<zone>`; see TunnelRecord. */
  readonly publicHostname: boolean;
  /** The public hostname's ingress service, `http://localhost:<port>`. */
  readonly origin?: string;
  /** The Worker secret that receives the connector token. */
  readonly tokenSecret: string;
}

/** An HTTP Workers VPC service on the Tunnel, to 127.0.0.1:<port>, bound as `binding`. */
export interface VpcServiceManifest {
  readonly binding: string;
  readonly port: number;
}

/** Worker binding and secret names: upper case, digits and underscores. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ORIGIN = /^http:\/\/localhost:([0-9]{1,5})$/;

function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Checks a parsed staging manifest. Like a Wrangler configuration, anything the tool does not
 * manage is refused, and every problem is named at once.
 */
export function parseManifest(json: unknown, path: string): Manifest {
  const problems: string[] = [];
  const refuse = (): never => {
    throw new Error(`refusing staging manifest ${path}: ${problems.join("; ")}`);
  };
  if (!isObject(json)) {
    problems.push("it must be an object");
    return refuse();
  }
  const unknown = keysOutside(json, ["tunnel", "vpcServices", "serviceToken"]);
  if (unknown.length > 0) problems.push(`it has unknown keys ${unknown.join(", ")}`);
  const names: string[] = [];
  const name = (value: unknown, where: string): string => {
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
      problems.push(`${where} must be an upper-case name such as X1_TUNNEL_TOKEN`);
    } else if (names.includes(value)) {
      problems.push(`${where} ${value} is used twice`);
    }
    names.push(String(value));
    return String(value);
  };

  let tunnel: TunnelManifest | undefined;
  if (json.tunnel !== undefined) {
    const t = isObject(json.tunnel) ? json.tunnel : {};
    if (!isObject(json.tunnel)) problems.push('"tunnel" must be an object');
    const outside = keysOutside(t, ["origin", "publicHostname", "tokenSecret"]);
    if (outside.length > 0) problems.push(`"tunnel" has unknown keys ${outside.join(", ")}`);
    const publicHostname = t.publicHostname ?? false;
    if (typeof publicHostname !== "boolean")
      problems.push('"tunnel.publicHostname" is true or false');
    const port = typeof t.origin === "string" ? ORIGIN.exec(t.origin)?.[1] : undefined;
    if (publicHostname === true && (port === undefined || !isPort(Number(port)))) {
      problems.push('"tunnel.origin" must be http://localhost:<port> for the public hostname');
    }
    if (publicHostname !== true && t.origin !== undefined) {
      problems.push('"tunnel.origin" serves only the public hostname; set "publicHostname"');
    }
    tunnel = {
      publicHostname: publicHostname === true,
      ...(typeof t.origin === "string" ? { origin: t.origin } : {}),
      tokenSecret: name(t.tokenSecret, '"tunnel.tokenSecret"'),
    };
  }

  const vpcServices: VpcServiceManifest[] = [];
  if (json.vpcServices !== undefined) {
    if (!Array.isArray(json.vpcServices)) problems.push('"vpcServices" must be a list');
    else if (!tunnel) problems.push('"vpcServices" need a "tunnel"');
    for (const [i, entry] of (Array.isArray(json.vpcServices) ? json.vpcServices : []).entries()) {
      const s = isObject(entry) ? entry : {};
      const outside = keysOutside(entry, ["binding", "port"]);
      if (!isObject(entry) || outside.length > 0) {
        problems.push(`vpcServices[${i}] takes only "binding" and "port"`);
      }
      if (!isPort(s.port)) problems.push(`vpcServices[${i}].port must be a port number`);
      vpcServices.push({
        binding: name(s.binding, `vpcServices[${i}].binding`),
        port: Number(s.port),
      });
    }
  }

  let serviceToken: ServiceTokenManifest | undefined;
  if (json.serviceToken !== undefined) {
    const t = isObject(json.serviceToken) ? json.serviceToken : {};
    const outside = keysOutside(t, ["hostnames", "clientIdSecret", "clientSecretSecret"]);
    if (!isObject(json.serviceToken) || outside.length > 0) {
      problems.push('"serviceToken" takes "hostnames", "clientIdSecret" and "clientSecretSecret"');
    }
    const hostnames = Array.isArray(t.hostnames) ? t.hostnames : [];
    const known: readonly unknown[] = ["worker", "tunnel"];
    if (
      hostnames.length === 0 ||
      !hostnames.every((h) => known.includes(h)) ||
      new Set(hostnames).size !== hostnames.length
    ) {
      problems.push('"serviceToken.hostnames" lists "worker", "tunnel" or both, once each');
    }
    if (hostnames.includes("tunnel") && tunnel?.publicHostname !== true) {
      problems.push('"serviceToken.hostnames" names "tunnel", which has no public hostname');
    }
    serviceToken = {
      hostnames: hostnames as TokenHostname[],
      clientIdSecret: name(t.clientIdSecret, '"serviceToken.clientIdSecret"'),
      clientSecretSecret: name(t.clientSecretSecret, '"serviceToken.clientSecretSecret"'),
    };
  }
  if (problems.length > 0) refuse();
  return {
    ...(tunnel ? { tunnel } : {}),
    vpcServices,
    ...(serviceToken ? { serviceToken } : {}),
  };
}

/**
 * Parses JSON with comments and trailing commas, as Wrangler's own JSONC files allow. Comments
 * and trailing commas are removed outside strings; the rest is strict JSON.
 */
export function parseJsonc(text: string): unknown {
  let json = "";
  let i = 0;
  const copyString = (source: string, start: number): number => {
    let end = start + 1;
    while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
    return end + 1;
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = copyString(text, i);
      json += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      json += " ";
      i = end + 2;
    } else {
      json += c;
      i++;
    }
  }
  // Without comments, a trailing comma is one followed only by white space and a closing bracket.
  let strict = "";
  for (let j = 0; j < json.length; ) {
    if (json[j] === '"') {
      const end = copyString(json, j);
      strict += json.slice(j, end);
      j = end;
      continue;
    }
    if (json[j] === "," && /^\s*[}\]]/.test(json.slice(j + 1))) {
      j++;
      continue;
    }
    strict += json[j];
    j++;
  }
  return JSON.parse(strict);
}

const STATES: readonly string[] = ["pending", "deployed", "deleting"];

/**
 * The registry format. Version 3 changed what an interrupted upload means (IR-001): version 2
 * files from earlier tools may carry `settleUntil`, a wall-clock deadline the current tool no
 * longer trusts. Version 4 adds `lateCreates`, which an earlier tool would drop. Each version's
 * tools accept only the versions they know, so they refuse a newer file instead of misreading it.
 */
export const REGISTRY_VERSION = 4;

export type LateCreateKind = "access" | "tunnel" | "dns" | "vpc" | "bucket" | "token";
const LATE_KINDS: readonly string[] = ["access", "tunnel", "dns", "vpc", "bucket", "token"];

/**
 * A create the tool gave up on: after the settle wait Cloudflare still showed nothing, so the
 * intent left its record (ops.ts, settleCreates). Nothing proves such a create never lands, or
 * bounds how late it may (review r2, finding 5, accepted as open), so the registry keeps it
 * for as long as it has not landed. Sweep flags a resource that carries its
 * nonce as this tool's, landed late, and `sweep --yes` deletes exactly those. A bucket has no
 * place for a nonce, and an intent from before nonces has none: one under the name is reported
 * as maybe this tool's, and left for the owner.
 */
export interface LateCreate {
  readonly kind: LateCreateKind;
  readonly deployment: string;
  /** The name the tool gives the resource, before its nonce; for a DNS record, its hostname. */
  readonly name: string;
  readonly nonce?: string;
  readonly givenUpAt: string;
}

/** Whether `resource` is what a create made: it carries that create's nonce. */
export function madeBy(
  create: Omit<LateCreate, "givenUpAt">,
  resource: { readonly name: string; readonly comment?: string | undefined },
): boolean {
  if (create.nonce === undefined) return false;
  if (create.kind === "dns") {
    return (
      resource.name === create.name &&
      resource.comment === dnsComment(create.deployment, create.nonce)
    );
  }
  const separator = create.kind === "vpc" ? VPC_NONCE_SEPARATOR : undefined;
  return resource.name === nonceName(create.name, create.nonce, separator);
}

const DEPLOYMENT_KEYS = [
  "name",
  "hostname",
  "owner",
  "createdAt",
  "expiresAt",
  "state",
  "accessAppId",
  "accessCreateStartedAt",
  "accessNonce",
  "workerSince",
  "uploadStartedAt",
  "uploadInterruptedAt",
  "containers",
  "buckets",
  "pendingBuckets",
  "repositories",
  "tunnel",
  "vpcServices",
  "dependsOn",
  "serviceToken",
];

const TUNNEL_IDS = [
  "id",
  "createStartedAt",
  "hostname",
  "accessAppId",
  "accessCreateStartedAt",
  "dnsRecordId",
  "dnsCreateStartedAt",
];
const TUNNEL_NONCES = ["nonce", "accessNonce", "dnsNonce"];

/** A nonce field is absent or a nonce. */
function validNonce(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && NONCE.test(value));
}

function validTunnel(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  return (
    keysOutside(value, ["name", ...TUNNEL_IDS, ...TUNNEL_NONCES]).length === 0 &&
    typeof value.name === "string" &&
    value.name.startsWith(STAGING_PREFIX) &&
    TUNNEL_IDS.every(
      (key) => value[key] === undefined || (typeof value[key] === "string" && value[key] !== ""),
    ) &&
    TUNNEL_NONCES.every((key) => validNonce(value[key]))
  );
}

function validVpcServices(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        isObject(s) &&
        keysOutside(s, ["name", "binding", "port", "id", "createStartedAt", "nonce"]).length ===
          0 &&
        typeof s.name === "string" &&
        s.name.startsWith(STAGING_PREFIX) &&
        typeof s.binding === "string" &&
        isPort(s.port) &&
        (s.id === undefined || (typeof s.id === "string" && s.id !== "")) &&
        (s.createStartedAt === undefined || typeof s.createStartedAt === "string") &&
        validNonce(s.nonce),
    )
  );
}

function validServiceToken(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isObject(value)) return false;
  const delivered = value.deliveredTo;
  return (
    keysOutside(value, ["name", "id", "createStartedAt", "nonce", "deliveredTo"]).length === 0 &&
    typeof value.name === "string" &&
    value.name.startsWith(STAGING_PREFIX) &&
    (value.id === undefined || (typeof value.id === "string" && value.id !== "")) &&
    (value.createStartedAt === undefined || typeof value.createStartedAt === "string") &&
    validNonce(value.nonce) &&
    (delivered === undefined ||
      (Array.isArray(delivered) && delivered.every((n) => typeof n === "string")))
  );
}

/**
 * Parses the staging registry. Unknown formats and unknown fields are refused, never guessed at.
 * A version 2 entry's `settleUntil`, elapsed or not, becomes `uploadInterruptedAt`: whatever
 * upload it guarded may still land, so the next teardown makes the full settle wait.
 */
export function parseRegistry(json: unknown): Deployment[] {
  const file = json as { version?: unknown; deployments?: unknown };
  const version = file && typeof file === "object" ? file.version : undefined;
  if (![2, 3, REGISTRY_VERSION].includes(version as number) || !Array.isArray(file.deployments)) {
    throw new Error(
      `unrecognised staging registry format; expected version 2 to ${REGISTRY_VERSION}`,
    );
  }
  return file.deployments.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("malformed entry in the staging registry");
    }
    const raw = { ...(entry as Record<string, unknown>) };
    if (version === 2 && "settleUntil" in raw) {
      if (typeof raw.settleUntil !== "string" || raw.settleUntil === "") {
        throw new Error("malformed entry in the staging registry");
      }
      raw.uploadInterruptedAt ??= raw.settleUntil;
      delete raw.settleUntil;
    }
    const unknown = Object.keys(raw).filter((key) => !DEPLOYMENT_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`unknown field in the staging registry: ${unknown.join(", ")}`);
    }
    const d = raw;
    const text = (key: string) => typeof d[key] === "string" && d[key] !== "";
    const names = (value: unknown) =>
      value === undefined ||
      (Array.isArray(value) &&
        value.every((n) => typeof n === "string" && n.startsWith(STAGING_PREFIX)));
    if (
      !text("name") ||
      !text("hostname") ||
      !text("owner") ||
      !text("createdAt") ||
      !text("expiresAt") ||
      !STATES.includes(d.state as string) ||
      (d.accessAppId !== undefined && !text("accessAppId")) ||
      (d.accessCreateStartedAt !== undefined && !text("accessCreateStartedAt")) ||
      !validNonce(d.accessNonce) ||
      (d.workerSince !== undefined && !text("workerSince")) ||
      (d.uploadStartedAt !== undefined && !text("uploadStartedAt")) ||
      (d.uploadInterruptedAt !== undefined && !text("uploadInterruptedAt")) ||
      !names(d.containers) ||
      !names(d.buckets) ||
      !names(d.pendingBuckets) ||
      !names(d.repositories) ||
      !validTunnel(d.tunnel) ||
      !validVpcServices(d.vpcServices) ||
      !names(d.dependsOn) ||
      !validServiceToken(d.serviceToken)
    ) {
      throw new Error("malformed entry in the staging registry");
    }
    assertManaged(d.name as string);
    return d as unknown as Deployment;
  });
}

/** The registry's late creates; a file before version 4 has none. */
export function parseLateCreates(json: unknown): LateCreate[] {
  parseRegistry(json);
  const file = json as { version: unknown; lateCreates?: unknown };
  if (file.version !== REGISTRY_VERSION || file.lateCreates === undefined) return [];
  if (!Array.isArray(file.lateCreates)) throw new Error("malformed late creates in the registry");
  return file.lateCreates.map((entry: unknown) => {
    const ok =
      isObject(entry) &&
      keysOutside(entry, ["kind", "deployment", "name", "nonce", "givenUpAt"]).length === 0 &&
      LATE_KINDS.includes(entry.kind as string) &&
      typeof entry.deployment === "string" &&
      typeof entry.name === "string" &&
      entry.name.startsWith(STAGING_PREFIX) &&
      validNonce(entry.nonce) &&
      typeof entry.givenUpAt === "string" &&
      entry.givenUpAt !== "";
    if (!ok) throw new Error("malformed late create in the staging registry");
    assertManaged(entry.deployment as string);
    return entry as unknown as LateCreate;
  });
}

export function serializeRegistry(
  deployments: readonly Deployment[],
  lateCreates: readonly LateCreate[] = [],
): string {
  return `${JSON.stringify({ version: REGISTRY_VERSION, deployments, lateCreates }, null, 2)}\n`;
}
