// Staging orchestration: deploy, teardown and sweep, written against small ports so that tests
// can drive them with a fake Cloudflare and interrupt them at any step.
//
// The invariant: a staging Worker is never reachable without its owner-only Access application.
//   - Every cloud mutation happens after the deployment's record is saved, and the record is
//     removed only after both resources are gone. An interrupted run leaves a record to finish.
//   - Deploy and teardown of one deployment hold its lock for their whole run, so they never
//     overlap, even when started from different worktrees. The lock outlives a crashed command
//     until its child processes exit (lock.ts). Registry updates are atomic (Store.update).
//   - The Worker configuration is checked before the first cloud call (validateDeployConfig):
//     the staging account, no other route, no resource the tool does not manage. The one way
//     out of the deployment it allows is a Durable Object binding to another deployment of the
//     same owner, which the registry shows deployed.
//   - Access is created, or claimed and checked, before the Worker is deployed, and a deploy
//     counts only once the Worker is found in the staging account.
//   - Teardown removes Access only after Cloudflare confirms that the Worker no longer exists.
//     An interrupted upload may still land for up to `settleMs` after its process ended. Once
//     a record shows one (markInterrupted), no later deploy clears that, and every teardown
//     waits the full `settleMs` on its own process's monotonic clock, then starts a fresh
//     lookup, before removing Access. No wall-clock deadline is trusted, and no lookup that
//     began before the wait counts. An unknown answer keeps Access and the record.
//   - Worker and Access share one record and one expiry, so a sweep removes them together.
//     Containers and R2 buckets the configuration declares carry the deployment's name, are
//     recorded before the deploy that creates them, and are removed by the same teardown,
//     after the Worker and before Access.
//   - Access applications set SameSite=lax on their cookie (D9). One written by an older tool is
//     rewritten, and every application is read back and checked before the Worker upload.
//   - Images are built with the record's creation time as their timestamp. A redeploy rebuilds
//     identical images and starts no container rollout; after a teardown, the new record gives
//     new digests, so Wrangler pushes the images again (DC-36).
//   - A staging manifest (guard.ts, MANIFEST_FILE) adds a Cloudflare Tunnel, its public
//     hostname and Workers VPC services. The Tunnel hostname gets its own owner-only Access
//     application before its DNS record exists, and loses it only after the DNS record is
//     confirmed gone. The tool writes the hostname's Worker route and the VPC bindings into a
//     rendered copy of the configuration, checked like the original, and passes the Tunnel's
//     token to the Worker as a secret with the upload, never in argv or logs.
//   - Every create of an Access application, Tunnel, DNS record or VPC service is preceded by a
//     create intent in the record (guard.ts) and followed by its ID. A create whose client died
//     may still take effect within `settleMs`, like an upload, so a command that finds an intent
//     unresolved waits that long once before deciding the create never happened (settleCreates),
//     and never removes a record that still holds one. Without an intent, nothing found under
//     the tool's name is adopted: a deploy refuses it, and a teardown leaves it alone.

import {
  ACCESS_SAME_SITE,
  type AccessApp,
  accessAppBody,
  accessAppFits,
  appNameFor,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  assertSameSite,
  claimNamed,
  type DeployConfigView,
  type Deployment,
  type DnsRecordInfo,
  declaredResources,
  expired,
  expiry,
  hostnameFor,
  type IngressRule,
  type Manifest,
  markInterrupted,
  type ProtectedHost,
  parseManifest,
  renderedConfigPath,
  resourceName,
  STAGING_PREFIX,
  type StagingConfig,
  sameIngress,
  type TunnelInfo,
  type TunnelRecord,
  tunnelHostnameFor,
  tunnelIngress,
  tunnelRoute,
  VPC_HOST,
  type VpcServiceInfo,
  type VpcServiceRecord,
  validateDeployConfig,
  vpcServiceName,
  type WorkerRoute,
} from "./guard.ts";

/** Lists by exact name, or, for the sweep, by name prefix. */
export type NameFilter = { readonly name: string } | { readonly prefix: string };

export interface Cloud {
  accountIds(): string[];
  /** The Access applications on exactly this hostname. */
  listAccessApps(hostname: string): AccessApp[];
  /** Returns the new application's ID. */
  createAccessApp(body: Record<string, unknown>): string;
  /** Replaces the application's settings with `body`. */
  updateAccessApp(id: string, body: Record<string, unknown>): void;
  deleteAccessApp(id: string): void;
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  workerExists(name: string): boolean;
  /**
   * Uploads the Worker and builds and pushes its container images, built with `buildEpoch`
   * (Unix seconds) as their timestamp (BuildKit's SOURCE_DATE_EPOCH). The same sources and
   * epoch give the same digests; another epoch gives new ones. `secrets`, if any, are uploaded
   * with the same version, never through argv or the output; secrets set earlier stay set.
   */
  deployWorker(
    name: string,
    hostname: string,
    configPath: string,
    buildEpoch: number,
    secrets?: Readonly<Record<string, string>>,
  ): void;
  deleteWorker(name: string): void;
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  bucketExists(name: string): boolean;
  createBucket(name: string): void;
  /** Deletes every object, then the bucket. */
  emptyAndDeleteBucket(name: string): void;
  /** IDs of the container applications with exactly this name. */
  containerApps(name: string): string[];
  deleteContainerApp(id: string): void;
  /** Image references (`repository:tag`) in this repository of the managed registry. */
  containerImages(repository: string): string[];
  deleteContainerImage(reference: string): void;
  /** Cloudflare Tunnels that exist (not deleted) under this name. */
  tunnels(filter: NameFilter): TunnelInfo[];
  /** Creates a remotely managed Tunnel and returns its ID, and nothing of its token. */
  createTunnel(name: string): string;
  /** The Tunnel's remotely managed ingress; [] when it has none yet. */
  tunnelIngress(id: string): IngressRule[];
  putTunnelIngress(id: string, ingress: readonly IngressRule[]): void;
  /** The Tunnel's connector token. A secret: it goes to deployWorker and nowhere else. */
  tunnelToken(id: string): string;
  /** Removes the Tunnel's connections, then the Tunnel. */
  deleteTunnel(id: string): void;
  /** DNS records in the staging zone under this name. */
  dnsRecords(filter: NameFilter): DnsRecordInfo[];
  /** Creates a proxied CNAME in the staging zone and returns its ID. */
  createDnsRecord(name: string, target: string, comment: string): string;
  deleteDnsRecord(id: string): void;
  /** Every Workers VPC service in the account. */
  vpcServices(): VpcServiceInfo[];
  /** Creates an HTTP VPC service to VPC_HOST:<port> through the Tunnel; returns its ID. */
  createVpcService(name: string, tunnelId: string, port: number): string;
  deleteVpcService(id: string): void;
}

export interface Store {
  load(): Deployment[];
  /** Replaces the registry with `change(current)`, atomically with respect to other commands. */
  update(change: (current: Deployment[]) => Deployment[]): void;
}

export interface Context {
  readonly config: StagingConfig;
  readonly cloud: Cloud;
  readonly store: Store;
  readonly readConfig: (path: string) => DeployConfigView;
  /**
   * The staging manifest next to a Wrangler configuration, parsed but not yet checked, or
   * undefined when there is none.
   */
  readonly readManifest: (configPath: string) => { path: string; json: unknown } | undefined;
  /** Writes a rendered configuration, readable by the owner only. */
  readonly writeFile: (path: string, text: string) => void;
  readonly removeFile: (path: string) => void;
  /** Takes the deployment's lock, or throws if another command holds it. Returns the release. */
  readonly lock: (name: string) => () => void;
  readonly sleep: (ms: number) => void;
  /** How long a request whose client died may still take effect at Cloudflare. */
  readonly settleMs: number;
  readonly now: () => Date;
  readonly log: (message: string) => void;
}

export interface DeployRequest {
  readonly suffix: string;
  readonly owner: string;
  readonly configPath: string;
  readonly days: number;
}

function put(ctx: Context, deployment: Deployment): Deployment {
  ctx.store.update((all) => [...all.filter((d) => d.name !== deployment.name), deployment]);
  return deployment;
}

function remove(ctx: Context, name: string): void {
  ctx.store.update((all) => all.filter((d) => d.name !== name));
}

/**
 * The registry repositories a record owns: one per default-policy container, named after it,
 * and the recorded ones, such as a `durable_object`-policy container's `<worker>-<class>-<image>`.
 */
function repositoriesOf(d: Deployment | undefined): string[] {
  return [...new Set([...(d?.containers ?? []), ...(d?.repositories ?? [])])];
}

/**
 * Everything a record claims. Deployment names can nest (cfo-stg-a owns cfo-stg-a-x, and so
 * does the deployment cfo-stg-a-x), and the Tunnel hostname of cfo-stg-a is the hostname of a
 * deployment named cfo-stg-a-tunnel, so no claim may appear in two records.
 */
function claimsOf(d: Deployment): string[] {
  return [
    ...(d.containers ?? []),
    ...(d.buckets ?? []),
    ...(d.repositories ?? []),
    `the hostname ${d.hostname}`,
    ...(d.tunnel ? [`Cloudflare Tunnel ${d.tunnel.name}`] : []),
    ...(d.tunnel?.hostname ? [`the hostname ${d.tunnel.hostname}`] : []),
    ...(d.vpcServices ?? []).map((s) => `Workers VPC service ${s.name}`),
  ];
}

function locked<T>(ctx: Context, name: string, run: () => T): T {
  const release = ctx.lock(name);
  try {
    return run();
  } finally {
    release();
  }
}

/** What a manifest asks of one deployment, with the names the tool gives it. */
interface ManifestPlan {
  readonly tunnel?: {
    readonly name: string;
    readonly hostname?: string;
    readonly origin?: string;
    readonly tokenSecret: string;
  };
  readonly vpcServices: readonly VpcServiceRecord[];
}

function planFor(name: string, zone: string, manifest: Manifest): ManifestPlan {
  const t = manifest.tunnel;
  return {
    ...(t
      ? {
          tunnel: {
            name,
            ...(t.publicHostname ? { hostname: tunnelHostnameFor(name, zone) } : {}),
            ...(t.origin !== undefined ? { origin: t.origin } : {}),
            tokenSecret: t.tokenSecret,
          },
        }
      : {}),
    vpcServices: manifest.vpcServices.map((s) => ({
      name: vpcServiceName(name, s.binding),
      binding: s.binding,
      port: s.port,
    })),
  };
}

/**
 * One resource the tool creates for a deployment, as its record describes it: what Cloudflare
 * lists under the name the tool gives it, which properties the tool gives it, and how the
 * record holds its ID and its create intent.
 */
interface Owned<T extends { readonly id: string }> {
  readonly label: string;
  readonly id: string | undefined;
  /** A create intent is recorded: a create was started and its outcome never seen. */
  readonly pending: boolean;
  list(): T[];
  /** Whether a listed resource has exactly the name and properties the tool gives it. */
  fits(resource: T): boolean;
  /** The record with a create intent for this resource, and no ID for it. */
  starting(record: Deployment, at: string): Deployment;
  /** The record with this resource's ID, or none, and no create intent. */
  settled(record: Deployment, id: string | undefined): Deployment;
}

function workerHost(record: Deployment): ProtectedHost {
  return { name: record.name, hostname: record.hostname, accessAppId: record.accessAppId };
}

function tunnelHost(record: Deployment, hostname: string): ProtectedHost {
  return { name: appNameFor(hostname), hostname, accessAppId: record.tunnel?.accessAppId };
}

/** The record with its Tunnel entry changed: `change` replaces fields, `drop` removes them. */
function withTunnel(
  record: Deployment,
  change: Partial<TunnelRecord>,
  drop: readonly (keyof TunnelRecord)[] = [],
): Deployment {
  const tunnel: Record<string, unknown> = {
    ...(record.tunnel ?? { name: record.name }),
    ...change,
  };
  for (const key of drop) delete tunnel[key];
  return { ...record, tunnel: tunnel as unknown as TunnelRecord };
}

function workerAccess(ctx: Context, record: Deployment): Owned<AccessApp> {
  const host = workerHost(record);
  return {
    label: `An Access application on ${host.hostname}`,
    id: record.accessAppId,
    pending: record.accessCreateStartedAt !== undefined,
    list: () => ctx.cloud.listAccessApps(host.hostname).filter((a) => a.domain === host.hostname),
    fits: (app) => accessAppFits(app, host),
    starting: (r, at) => {
      const { accessAppId: _, ...rest } = r;
      return { ...rest, accessCreateStartedAt: at };
    },
    settled: (r, id) => {
      const { accessAppId: _, accessCreateStartedAt: __, ...rest } = r;
      return id === undefined ? rest : { ...rest, accessAppId: id };
    },
  };
}

function tunnelAccess(ctx: Context, record: Deployment, hostname: string): Owned<AccessApp> {
  const host = tunnelHost(record, hostname);
  return {
    label: `An Access application on ${hostname}`,
    id: record.tunnel?.accessAppId,
    pending: record.tunnel?.accessCreateStartedAt !== undefined,
    list: () => ctx.cloud.listAccessApps(hostname).filter((a) => a.domain === hostname),
    fits: (app) => accessAppFits(app, host),
    starting: (r, at) => withTunnel(r, { accessCreateStartedAt: at }, ["accessAppId"]),
    settled: (r, id) =>
      withTunnel(r, id === undefined ? {} : { accessAppId: id }, [
        "accessCreateStartedAt",
        ...(id === undefined ? (["accessAppId"] as const) : []),
      ]),
  };
}

function tunnelOwned(ctx: Context, record: Deployment): Owned<TunnelInfo> {
  const name = record.tunnel?.name ?? record.name;
  return {
    label: `Cloudflare Tunnel ${name}`,
    id: record.tunnel?.id,
    pending: record.tunnel?.createStartedAt !== undefined,
    list: () => ctx.cloud.tunnels({ name }),
    fits: (tunnel) => tunnel.name === name,
    starting: (r, at) => withTunnel(r, { createStartedAt: at }, ["id"]),
    settled: (r, id) =>
      withTunnel(r, id === undefined ? {} : { id }, [
        "createStartedAt",
        ...(id === undefined ? (["id"] as const) : []),
      ]),
  };
}

/** The proxied CNAME from the Tunnel hostname to the Tunnel the record names. */
function dnsOwned(ctx: Context, record: Deployment, hostname: string): Owned<DnsRecordInfo> {
  const tunnelId = record.tunnel?.id;
  return {
    label: `DNS record ${hostname}`,
    id: record.tunnel?.dnsRecordId,
    pending: record.tunnel?.dnsCreateStartedAt !== undefined,
    list: () => ctx.cloud.dnsRecords({ name: hostname }),
    fits: (r) =>
      tunnelId !== undefined &&
      r.name === hostname &&
      r.type === "CNAME" &&
      r.content === `${tunnelId}.cfargotunnel.com` &&
      r.proxied,
    starting: (r, at) => withTunnel(r, { dnsCreateStartedAt: at }, ["dnsRecordId"]),
    settled: (r, id) =>
      withTunnel(r, id === undefined ? {} : { dnsRecordId: id }, [
        "dnsCreateStartedAt",
        ...(id === undefined ? (["dnsRecordId"] as const) : []),
      ]),
  };
}

/** An HTTP VPC service to VPC_HOST:<port> through the Tunnel the record names. */
function vpcOwned(
  ctx: Context,
  record: Deployment,
  service: VpcServiceRecord,
): Owned<VpcServiceInfo> {
  const tunnelId = record.tunnel?.id;
  const update = (r: Deployment, change: (s: VpcServiceRecord) => VpcServiceRecord) => ({
    ...r,
    vpcServices: (r.vpcServices ?? []).map((s) => (s.name === service.name ? change(s) : s)),
  });
  return {
    label: `Workers VPC service ${service.name}`,
    id: service.id,
    pending: service.createStartedAt !== undefined,
    list: () => ctx.cloud.vpcServices().filter((v) => v.name === service.name),
    fits: (v) =>
      tunnelId !== undefined &&
      v.name === service.name &&
      v.type === "http" &&
      v.ipv4 === VPC_HOST &&
      v.tunnelId === tunnelId &&
      v.httpPort === service.port,
    starting: (r, at) => update(r, ({ id: _, ...s }) => ({ ...s, createStartedAt: at })),
    settled: (r, id) =>
      update(r, ({ id: _, createStartedAt: __, ...s }) => (id === undefined ? s : { ...s, id })),
  };
}

/** Every resource the record says the tool created or started to create. */
function ownedOf(ctx: Context, record: Deployment): Owned<{ readonly id: string }>[] {
  const t = record.tunnel;
  return [
    workerAccess(ctx, record),
    ...(t?.hostname !== undefined ? [tunnelAccess(ctx, record, t.hostname)] : []),
    ...(t ? [tunnelOwned(ctx, record)] : []),
    ...(t?.hostname !== undefined ? [dnsOwned(ctx, record, t.hostname)] : []),
    ...(record.vpcServices ?? []).map((s) => vpcOwned(ctx, record, s)),
  ];
}

/**
 * Resolves every create intent in the record. A resource that is now listed with exactly the
 * expected name and properties is adopted; anything else under its name is refused. If one is
 * not listed, its create may still take effect: the command waits the settle time once, unless
 * it already has since taking the lock (`waited`), and lists again. A create still not visible
 * then never happened, and its intent is removed. Returns the record with no intent left.
 */
function settleCreates(ctx: Context, start: Deployment, waited = false): Deployment {
  let record = start;
  let slept = waited;
  for (;;) {
    const unseen: string[] = [];
    for (const owned of ownedOf(ctx, record).filter((o) => o.pending)) {
      const found = owned.list();
      if (found.length === 0) {
        unseen.push(owned.label);
        continue;
      }
      const [only] = found;
      if (found.length > 1 || only === undefined || !owned.fits(only)) {
        throw new Error(
          `${owned.label} exists but is not what this deployment started to create; inspect it in the dashboard`,
        );
      }
      record = put(ctx, owned.settled(record, only.id));
      ctx.log(`${owned.label}, created by an interrupted run, is recorded now`);
    }
    if (unseen.length === 0) return record;
    if (slept) {
      // A full settle time has passed since the run that started them ended: they never landed.
      for (const owned of ownedOf(ctx, record).filter((o) => unseen.includes(o.label))) {
        record = put(ctx, owned.settled(record, undefined));
      }
      return record;
    }
    ctx.log(
      `${record.name}: an interrupted run may still create ${unseen.join(", ")}; checking again in ${ctx.settleMs / 1000}s`,
    );
    ctx.sleep(ctx.settleMs);
    slept = true;
  }
}

/** Records a create intent, creates the resource, then records its ID in place of the intent. */
function createOwned<T extends { readonly id: string }>(
  ctx: Context,
  start: Deployment,
  owned: Owned<T>,
  create: () => string,
): { record: Deployment; id: string } {
  const intent = put(ctx, owned.starting(start, ctx.now().toISOString()));
  const id = create();
  return { record: put(ctx, owned.settled(intent, id)), id };
}

/**
 * An Access application, Tunnel, DNS record or VPC service that the record does not hold must
 * not exist yet, for the same reason as a container or bucket. Checked before recording, after
 * settleCreates has resolved the record's create intents.
 */
function checkNewResources(
  ctx: Context,
  existing: Deployment | undefined,
  hostname: string,
  plan: ManifestPlan | undefined,
): void {
  const foreignApp = (host: string, recorded: string | undefined) => {
    if (recorded === undefined && ctx.cloud.listAccessApps(host).some((a) => a.domain === host)) {
      throw new Error(
        `${host} has an Access application this deployment did not create; inspect it in the Zero Trust dashboard`,
      );
    }
  };
  foreignApp(hostname, existing?.accessAppId);
  const tunnel = plan?.tunnel;
  if (!tunnel) return;
  if (tunnel.hostname !== undefined) foreignApp(tunnel.hostname, existing?.tunnel?.accessAppId);
  if (existing?.tunnel?.id === undefined && ctx.cloud.tunnels({ name: tunnel.name }).length > 0) {
    throw new Error(
      `Cloudflare Tunnel ${tunnel.name} exists but this deployment did not create it`,
    );
  }
  if (
    tunnel.hostname !== undefined &&
    existing?.tunnel?.dnsRecordId === undefined &&
    ctx.cloud.dnsRecords({ name: tunnel.hostname }).length > 0
  ) {
    throw new Error(`${tunnel.hostname} has DNS records this deployment did not create`);
  }
  if (plan.vpcServices.length === 0) return;
  const services = ctx.cloud.vpcServices();
  for (const wanted of plan.vpcServices) {
    const recorded = existing?.vpcServices?.find((s) => s.name === wanted.name);
    if (recorded && recorded.port !== wanted.port) {
      throw new Error(
        `Workers VPC service ${wanted.name} is recorded with port ${recorded.port}; tear the deployment down to change it`,
      );
    }
    if (recorded?.id === undefined && services.some((s) => s.name === wanted.name)) {
      throw new Error(
        `Workers VPC service ${wanted.name} exists but this deployment did not create it`,
      );
    }
  }
}

/**
 * Adds the manifest's resources to the record before any is created. Like containers, they
 * accumulate: a resource a later manifest leaves out stays recorded until teardown.
 */
function withManifestIntent(record: Deployment, plan: ManifestPlan | undefined): Deployment {
  if (!plan?.tunnel) return record;
  const hostname = record.tunnel?.hostname ?? plan.tunnel.hostname;
  const recorded = record.vpcServices ?? [];
  const added = plan.vpcServices.filter((s) => !recorded.some((r) => r.name === s.name));
  const services = [...recorded, ...added];
  return {
    ...record,
    tunnel: { ...record.tunnel, name: plan.tunnel.name, ...(hostname ? { hostname } : {}) },
    ...(services.length > 0 ? { vpcServices: services } : {}),
  };
}

/**
 * Creates, or claims and checks, the owner-only Access application for one hostname, then reads
 * it back: what Access holds now, not what was sent, decides.
 */
function ensureAccess(
  ctx: Context,
  start: Deployment,
  host: ProtectedHost,
  ownedIn: (record: Deployment) => Owned<AccessApp>,
): Deployment {
  let record = start;
  const { hostname } = host;
  const body = accessAppBody(host.name, hostname, ctx.config);
  const owned = ownedIn(record);
  const app = claimNamed(owned.list(), owned.id, owned.label);
  let id: string;
  if (app) {
    assertOwnerOnly(app, hostname, ctx.config.ownerEmail);
    id = app.id;
    if (app.same_site_cookie_attribute !== ACCESS_SAME_SITE) {
      ctx.cloud.updateAccessApp(id, body);
      ctx.log(`set SameSite=${ACCESS_SAME_SITE} on the Access application for ${hostname}`);
    }
  } else {
    ({ record, id } = createOwned(ctx, record, owned, () => ctx.cloud.createAccessApp(body)));
    ctx.log(`created Access application for ${hostname}`);
  }
  const confirmed = claimNamed(owned.list(), id, owned.label);
  if (!confirmed) throw new Error(`${hostname} has no Access application after writing one`);
  assertOwnerOnly(confirmed, hostname, ctx.config.ownerEmail);
  assertSameSite(confirmed, hostname);
  return record;
}

/**
 * Creates or claims the deployment's Tunnel and sets its ingress, writing only when it differs:
 * every write starts a new configuration version, which the running connector reloads.
 */
function ensureTunnel(
  ctx: Context,
  start: Deployment,
  wanted: NonNullable<ManifestPlan["tunnel"]>,
): { record: Deployment; id: string } {
  let record = start;
  const owned = tunnelOwned(ctx, record);
  const found = claimNamed(owned.list(), owned.id, owned.label);
  if (!found && owned.id !== undefined) {
    // Its token is in the running containers and its DNS record points to it. Start over.
    throw new Error(
      `${owned.label} is recorded but gone; tear the deployment down and deploy again`,
    );
  }
  let id = found?.id;
  if (id === undefined) {
    ({ record, id } = createOwned(ctx, record, owned, () => ctx.cloud.createTunnel(wanted.name)));
    ctx.log(`created ${owned.label}`);
  }
  const desired = tunnelIngress(wanted.hostname, wanted.origin);
  if (!sameIngress(ctx.cloud.tunnelIngress(id), desired)) {
    ctx.cloud.putTunnelIngress(id, desired);
    if (!sameIngress(ctx.cloud.tunnelIngress(id), desired)) {
      throw new Error(`${owned.label} does not hold the ingress just written`);
    }
    ctx.log(`set the ingress of ${owned.label}`);
  }
  return { record, id };
}

/** The proxied CNAME from the Tunnel hostname to the Tunnel. Access protects it already. */
function ensureDns(ctx: Context, start: Deployment, hostname: string, tunnelId: string) {
  let record = start;
  const owned = dnsOwned(ctx, record, hostname);
  const found = claimNamed(owned.list(), owned.id, owned.label);
  if (found && !owned.fits(found)) {
    throw new Error(`DNS record ${hostname} no longer points to the deployment's Tunnel`);
  }
  if (!found) {
    const target = `${tunnelId}.cfargotunnel.com`;
    ({ record } = createOwned(ctx, record, owned, () =>
      ctx.cloud.createDnsRecord(hostname, target, `${record.name}: staging tool`),
    ));
    ctx.log(`created DNS record ${hostname}`);
  }
  return record;
}

/** HTTP VPC services to VPC_HOST on the Tunnel, one per manifest binding. */
function ensureVpcServices(
  ctx: Context,
  start: Deployment,
  wanted: readonly VpcServiceRecord[],
  tunnelId: string,
): Deployment {
  let record = start;
  for (const service of wanted) {
    const recorded = record.vpcServices?.find((s) => s.name === service.name) ?? service;
    const owned = vpcOwned(ctx, record, recorded);
    const found = claimNamed(owned.list(), owned.id, owned.label);
    if (found && !owned.fits(found)) {
      throw new Error(
        `${owned.label} no longer points to ${VPC_HOST}:${service.port} on the Tunnel`,
      );
    }
    if (!found) {
      ({ record } = createOwned(ctx, record, owned, () =>
        ctx.cloud.createVpcService(service.name, tunnelId, service.port),
      ));
      ctx.log(`created ${owned.label}`);
    }
  }
  return record;
}

export function deploy(ctx: Context, request: DeployRequest): Deployment {
  const name = resourceName(request.suffix);
  const hostname = hostnameFor(name, ctx.config.zone);
  // Local checks first: nothing below runs for a configuration that could reach outside
  // staging. A cross-script Durable Object binding is checked against the registry here, and
  // again under the lock just before anything is created.
  const view = ctx.readConfig(request.configPath);
  const check = (deployments: readonly Deployment[]) =>
    validateDeployConfig(view, ctx.config.accountId, name, {
      registry: { owner: request.owner, deployments },
    });
  check(ctx.store.load());
  const declared = declaredResources(view.raw, name);
  const manifest = ctx.readManifest(request.configPath);
  const plan =
    manifest && planFor(name, ctx.config.zone, parseManifest(manifest.json, manifest.path));
  return locked(ctx, name, () => {
    const now = ctx.now();
    const expiresAt = expiry(now, request.days);
    const registry = ctx.store.load();
    check(registry);
    const found = registry.find((d) => d.name === name);
    const interrupted = found && markInterrupted(found, now);
    if (interrupted?.state === "deleting") {
      throw new Error(`${name} is being torn down; run teardown --suffix ${request.suffix} first`);
    }
    if (interrupted && interrupted.owner !== request.owner) {
      throw new Error(`${name} belongs to ${interrupted.owner}, not ${request.owner}`);
    }
    if (interrupted && interrupted.hostname !== hostname) {
      throw new Error(`${name} is recorded at ${interrupted.hostname}; tear it down first`);
    }
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    const existing = interrupted && settleCreates(ctx, interrupted);

    // A container or bucket new to this deployment must not exist yet: otherwise it belongs to
    // someone else, and recording it would let teardown delete it. Checked before recording.
    for (const container of declared.containers) {
      if (
        !existing?.containers?.includes(container) &&
        ctx.cloud.containerApps(container).length > 0
      ) {
        throw new Error(
          `container application ${container} exists but this deployment did not create it`,
        );
      }
    }
    for (const bucket of declared.buckets) {
      if (!existing?.buckets?.includes(bucket) && ctx.cloud.bucketExists(bucket)) {
        throw new Error(`R2 bucket ${bucket} exists but this deployment did not create it`);
      }
    }
    const ownRepositories = repositoriesOf(existing);
    for (const repository of declared.repositories) {
      if (
        !ownRepositories.includes(repository) &&
        ctx.cloud.containerImages(repository).length > 0
      ) {
        throw new Error(
          `registry repository ${repository} has images this deployment did not push`,
        );
      }
    }

    // The record exists before anything is created, and one expiry covers every resource.
    // Containers and buckets accumulate across deploys, so none is ever forgotten.
    const union = (a: readonly string[] | undefined, b: string[]) => [
      ...new Set([...(a ?? []), ...b]),
    ];
    const intent: Deployment = withManifestIntent(
      {
        ...(existing ?? { name, hostname, owner: request.owner, createdAt: now.toISOString() }),
        expiresAt,
        state: "pending",
        containers: union(existing?.containers, declared.containers),
        buckets: union(existing?.buckets, declared.buckets),
        repositories: union(existing?.repositories, declared.repositories),
      },
      plan,
    );
    // A claim another record holds is refused before anything is looked up under it, and again,
    // since locks are per deployment, in the one atomic registry update that records the
    // intent: no resource is ever recorded for two deployments (claimsOf).
    const refuseClaimed = (all: readonly Deployment[]) => {
      const mine = claimsOf(intent);
      for (const other of all) {
        if (other.name === name) continue;
        const theirs = claimsOf(other);
        const clash = mine.find((r) => theirs.includes(r));
        if (clash) throw new Error(`${clash} is recorded for the deployment ${other.name}`);
      }
    };
    refuseClaimed(ctx.store.load());
    checkNewResources(ctx, existing, hostname, plan);
    ctx.store.update((all) => {
      refuseClaimed(all);
      return [...all.filter((d) => d.name !== name), intent];
    });
    let record = intent;

    // Access before the Worker: the hostname never serves traffic without the owner-only gate.
    // The same holds for the Tunnel hostname, whose Access comes before its DNS record.
    record = ensureAccess(ctx, record, workerHost(record), (r) => workerAccess(ctx, r));
    const recordedTunnelHost = record.tunnel?.hostname;
    if (recordedTunnelHost !== undefined) {
      record = ensureAccess(ctx, record, tunnelHost(record, recordedTunnelHost), (r) =>
        tunnelAccess(ctx, r, recordedTunnelHost),
      );
    }

    // Buckets before the Worker binds them, so Wrangler never provisions one itself. A bucket
    // that exists here is one this record already owned (checked above), or one an
    // interrupted run of this deploy created after recording it.
    for (const bucket of declared.buckets) {
      if (!ctx.cloud.bucketExists(bucket)) {
        ctx.cloud.createBucket(bucket);
        ctx.log(`created R2 bucket ${bucket}`);
      }
    }

    // Then the Tunnel, its DNS record and its VPC services, and what the Worker needs of them.
    let tunnelId: string | undefined;
    const routes: WorkerRoute[] = [];
    const vpcBindings: { binding: string; service_id: string }[] = [];
    if (plan?.tunnel) {
      ({ record, id: tunnelId } = ensureTunnel(ctx, record, plan.tunnel));
      if (plan.tunnel.hostname !== undefined) {
        record = ensureDns(ctx, record, plan.tunnel.hostname, tunnelId);
        routes.push(tunnelRoute(plan.tunnel.hostname, ctx.config.zone));
      }
      record = ensureVpcServices(ctx, record, plan.vpcServices, tunnelId);
      for (const service of plan.vpcServices) {
        const id = record.vpcServices?.find((s) => s.name === service.name)?.id;
        if (id !== undefined) vpcBindings.push({ binding: service.binding, service_id: id });
      }
    }

    // Wrangler skips pushing an image whose digest the registry answers for, and the registry
    // keeps answering for a digest after the image is deleted. An identical rebuild after a
    // teardown would then never be pushed, and creating its application fails (DC-36). Images
    // are therefore built with the record's creation time as their timestamp: every redeploy of
    // a live deployment rebuilds identical images and starts no container rollout, and a
    // teardown removes the record, so the next deployment's images get new digests.
    const buildEpoch = Math.floor(Date.parse(record.createdAt) / 1000);

    // The checked configuration is never edited. What the tool adds goes into a copy next to
    // it, so that its relative paths still resolve, and the copy is checked as Wrangler reads
    // it before the upload and removed afterwards, whatever happens.
    const rendered =
      routes.length + vpcBindings.length > 0
        ? renderedConfigPath(request.configPath, name)
        : undefined;
    try {
      if (rendered !== undefined) {
        const raw = {
          ...view.raw,
          ...(routes.length > 0 ? { routes } : {}),
          ...(vpcBindings.length > 0 ? { vpc_services: vpcBindings } : {}),
        };
        ctx.writeFile(rendered, `${JSON.stringify(raw, null, 2)}\n`);
        validateDeployConfig(ctx.readConfig(rendered), ctx.config.accountId, name, {
          registry: { owner: request.owner, deployments: ctx.store.load() },
          rendered: { routes, vpcServiceIds: vpcBindings.map((b) => b.service_id) },
        });
      }
      // The Tunnel's token is read only now and goes only to the upload. It never changes for
      // a live Tunnel, so a redeploy passes the same value, and the server container keeps
      // working with the one it started with.
      const secrets =
        plan?.tunnel && tunnelId !== undefined
          ? { [plan.tunnel.tokenSecret]: ctx.cloud.tunnelToken(tunnelId) }
          : undefined;

      // If the upload throws, the record keeps uploadStartedAt: the Worker may exist, or may
      // still appear, and the next command marks the upload interrupted.
      record = put(ctx, { ...record, uploadStartedAt: ctx.now().toISOString() });
      ctx.cloud.deployWorker(name, hostname, rendered ?? request.configPath, buildEpoch, secrets);
    } finally {
      if (rendered !== undefined) ctx.removeFile(rendered);
    }
    if (!ctx.cloud.workerExists(name)) {
      throw new Error(
        `${name}: Wrangler reported success, but the staging account has no such Worker`,
      );
    }
    const { uploadStartedAt: _, ...settled } = record;
    record = put(ctx, { ...settled, state: "deployed" });
    ctx.log(`deployed ${name} at https://${hostname} (expires ${expiresAt})`);
    return record;
  });
}

/**
 * Deletes a resource the record holds by ID and checks it is gone. A resource that is gone
 * already is skipped. Anything else under its name belongs to someone else and is refused.
 */
function removeOwned<T extends { readonly id: string }>(
  record: Deployment,
  owned: Owned<T>,
  remove: (id: string) => void,
): void {
  const found = claimNamed(owned.list(), owned.id, owned.label);
  if (!found) return;
  remove(found.id);
  if (owned.list().some((r) => r.id === found.id)) {
    throw new Error(`${record.name}: ${owned.label} still exists`);
  }
}

/**
 * Removes the Workers VPC services, the Tunnel's DNS record and the Tunnel, in that order, each
 * checked gone before the next. settleCreates has resolved every create intent, so each step
 * deletes only the resource the record holds by ID.
 */
function removeTunnelResources(ctx: Context, record: Deployment): void {
  for (const service of record.vpcServices ?? []) {
    removeOwned(record, vpcOwned(ctx, record, service), (id) => ctx.cloud.deleteVpcService(id));
  }
  const host = record.tunnel?.hostname;
  if (host !== undefined) {
    removeOwned(record, dnsOwned(ctx, record, host), (id) => ctx.cloud.deleteDnsRecord(id));
  }
  if (record.tunnel) {
    removeOwned(record, tunnelOwned(ctx, record), (id) => ctx.cloud.deleteTunnel(id));
  }
}

/** Deletes the Access application the record holds by ID, and nothing else on its hostname. */
function removeAccess(ctx: Context, owned: Owned<AccessApp>): void {
  const app = owned.list().find((a) => a.id === owned.id);
  if (app) ctx.cloud.deleteAccessApp(app.id);
}

/** Removes a deployment: its Worker first, then its Access application, then its record. */
export function teardown(
  ctx: Context,
  name: string,
  options: { readonly ifPresent?: boolean; readonly ifExpiredAt?: Date } = {},
): void {
  assertManaged(name);
  locked(ctx, name, () => {
    const found = ctx.store.load().find((d) => d.name === name);
    if (!found) {
      if (options.ifPresent) return;
      throw new Error(`no recorded deployment named ${name}`);
    }
    if (options.ifExpiredAt && expired([found], options.ifExpiredAt).length === 0) return;
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    let record = put(ctx, { ...markInterrupted(found, ctx.now()), state: "deleting" });

    if (ctx.cloud.workerExists(name)) {
      let failure: unknown;
      try {
        ctx.cloud.deleteWorker(name);
      } catch (error) {
        // The delete may still have taken effect; the check below decides.
        failure = error;
      }
      if (ctx.cloud.workerExists(name)) {
        throw new Error(`${name}: the Worker still exists, so its Access application was kept`, {
          cause: failure,
        });
      }
    }
    const waited = record.uploadInterruptedAt !== undefined;
    if (waited) {
      // The interrupted upload's process ended before this command took the lock, so after a
      // full settle time from here any request it left behind has landed or never will.
      ctx.log(`${name}: an upload was interrupted; checking again in ${ctx.settleMs / 1000}s`);
      ctx.sleep(ctx.settleMs);
      if (ctx.cloud.workerExists(name)) {
        throw new Error(
          `${name}: the Worker appeared after an interrupted upload, so its Access application was kept; run teardown again`,
        );
      }
    }
    // The same holds for creates an interrupted run started: after that wait, or one of its
    // own, every create intent is resolved, so nothing it started can land unrecorded.
    record = settleCreates(ctx, record, waited);

    // With the Worker gone, nothing reaches its containers or buckets. Remove them, checking
    // each, and keep the record (and Access) if any is left.
    for (const container of record.containers ?? []) {
      for (const id of ctx.cloud.containerApps(container)) ctx.cloud.deleteContainerApp(id);
      if (ctx.cloud.containerApps(container).length > 0) {
        throw new Error(`${name}: container application ${container} still exists`);
      }
    }
    for (const repository of repositoriesOf(record)) {
      for (const image of ctx.cloud.containerImages(repository)) {
        ctx.cloud.deleteContainerImage(image);
      }
      if (ctx.cloud.containerImages(repository).length > 0) {
        throw new Error(`${name}: images of ${repository} are still in the registry`);
      }
    }
    // The containers held the Tunnel's connector, so the Tunnel is idle now.
    removeTunnelResources(ctx, record);
    for (const bucket of record.buckets ?? []) {
      if (ctx.cloud.bucketExists(bucket)) ctx.cloud.emptyAndDeleteBucket(bucket);
      if (ctx.cloud.bucketExists(bucket))
        throw new Error(`${name}: R2 bucket ${bucket} still exists`);
    }

    // The Worker and the Tunnel hostname's DNS record are confirmed absent. Remove the Access
    // applications the record holds.
    const recordedTunnelHost = record.tunnel?.hostname;
    if (recordedTunnelHost !== undefined) {
      removeAccess(ctx, tunnelAccess(ctx, record, recordedTunnelHost));
    }
    removeAccess(ctx, workerAccess(ctx, record));
    remove(ctx, name);
    ctx.log(`removed ${name}: Worker, containers and buckets, then Access`);
  });
}

/**
 * Tunnels, Workers VPC services and DNS records that carry the staging prefix but that no
 * record owns, by ID or by a create intent under the same name: left by hand, by a lost
 * registry, or by a create that landed after its intent was given up. A deployment's own
 * hostname is a Workers custom domain, not an orphan. Orphans are reported and never deleted,
 * since nothing shows who made them.
 */
function orphans(ctx: Context): string[] {
  const deployments = ctx.store.load();
  const owns = (
    recordedId: string | undefined,
    pending: string | undefined,
    recordedName: string,
    id: string,
    name: string,
  ) =>
    recordedId === id ||
    (recordedId === undefined && pending !== undefined && recordedName === name);
  const found: string[] = [];
  for (const t of ctx.cloud.tunnels({ prefix: STAGING_PREFIX })) {
    const owned = deployments.some(
      (d) => d.tunnel && owns(d.tunnel.id, d.tunnel.createStartedAt, d.tunnel.name, t.id, t.name),
    );
    if (!owned) found.push(`Cloudflare Tunnel ${t.name}`);
  }
  for (const s of ctx.cloud.vpcServices()) {
    if (!s.name.startsWith(STAGING_PREFIX)) continue;
    const owned = deployments.some((d) =>
      d.vpcServices?.some((r) => owns(r.id, r.createStartedAt, r.name, s.id, s.name)),
    );
    if (!owned) found.push(`Workers VPC service ${s.name}`);
  }
  for (const r of ctx.cloud.dnsRecords({ prefix: STAGING_PREFIX })) {
    const owned = deployments.some(
      (d) =>
        d.hostname === r.name ||
        (d.tunnel?.hostname !== undefined &&
          owns(d.tunnel.dnsRecordId, d.tunnel.dnsCreateStartedAt, d.tunnel.hostname, r.id, r.name)),
    );
    if (!owned) found.push(`${r.type} record ${r.name}`);
  }
  return found;
}

/**
 * Lists expired deployments and, with `apply`, tears each one down, then reports orphaned
 * staging resources. Returns the failures.
 */
export function sweep(ctx: Context, apply: boolean): string[] {
  const now = ctx.now();
  const due = expired(ctx.store.load(), now);
  if (due.length === 0) ctx.log("no expired deployments");
  for (const d of due) ctx.log(`expired: ${d.name} (owner ${d.owner}, ${d.state})`);
  const failures: string[] = [];
  if (!apply) {
    if (due.length > 0) ctx.log("re-run with --yes to remove them");
  } else {
    for (const d of due) {
      try {
        // Another command may have removed or redeployed it since the list was read.
        teardown(ctx, d.name, { ifPresent: true, ifExpiredAt: now });
      } catch (error) {
        failures.push(`${d.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  try {
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    for (const orphan of orphans(ctx)) {
      ctx.log(`orphan: ${orphan} has the staging prefix, but no record owns it; left in place`);
    }
  } catch (error) {
    failures.push(`orphan check: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures;
}
