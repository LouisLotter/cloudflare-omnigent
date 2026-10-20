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
//     hostname and Workers VPC services. Each is recorded before it is created and its ID as
//     soon as Cloudflare returns it; a resource found under the tool's name for it is adopted
//     only as described in claimNamed. The Tunnel hostname gets its own owner-only Access
//     application before its DNS record exists, and loses it only after the DNS record is
//     confirmed gone. The tool writes the hostname's Worker route and the VPC bindings into a
//     rendered copy of the configuration, checked like the original, and passes the Tunnel's
//     token to the Worker as a secret with the upload, never in argv or logs.

import {
  ACCESS_SAME_SITE,
  type AccessApp,
  accessAppBody,
  appNameFor,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  assertSameSite,
  claimAccessApp,
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
  type StagingConfig,
  sameIngress,
  type TunnelInfo,
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
 * A Tunnel, DNS record or VPC service new to this deployment must not exist yet, for the same
 * reason as a container or bucket. Checked before recording.
 */
function checkManifestResourcesAreNew(
  ctx: Context,
  existing: Deployment | undefined,
  plan: ManifestPlan,
): void {
  const { tunnel } = plan;
  if (!tunnel) return;
  if (!existing?.tunnel && ctx.cloud.tunnels({ name: tunnel.name }).length > 0) {
    throw new Error(
      `Cloudflare Tunnel ${tunnel.name} exists but this deployment did not create it`,
    );
  }
  if (
    tunnel.hostname !== undefined &&
    existing?.tunnel?.hostname === undefined &&
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
    if (!recorded && services.some((s) => s.name === wanted.name)) {
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
 * it back: what Access holds now, not what was sent, decides. `withId` records its ID.
 */
function ensureAccess(
  ctx: Context,
  start: Deployment,
  host: ProtectedHost,
  withId: (record: Deployment, id: string) => Deployment,
): Deployment {
  let record = start;
  const { hostname } = host;
  const body = accessAppBody(host.name, hostname, ctx.config);
  const app = claimAccessApp(ctx.cloud.listAccessApps(hostname), host);
  let id: string;
  if (app) {
    assertOwnerOnly(app, hostname, ctx.config.ownerEmail);
    id = app.id;
    if (host.accessAppId !== id) record = put(ctx, withId(record, id));
    if (app.same_site_cookie_attribute !== ACCESS_SAME_SITE) {
      ctx.cloud.updateAccessApp(id, body);
      ctx.log(`set SameSite=${ACCESS_SAME_SITE} on the Access application for ${hostname}`);
    }
  } else {
    id = ctx.cloud.createAccessApp(body);
    record = put(ctx, withId(record, id));
    ctx.log(`created Access application for ${hostname}`);
  }
  const confirmed = claimAccessApp(ctx.cloud.listAccessApps(hostname), {
    ...host,
    accessAppId: id,
  });
  if (!confirmed) throw new Error(`${hostname} has no Access application after writing one`);
  assertOwnerOnly(confirmed, hostname, ctx.config.ownerEmail);
  assertSameSite(confirmed, hostname);
  return record;
}

function workerHost(record: Deployment): ProtectedHost {
  return { name: record.name, hostname: record.hostname, accessAppId: record.accessAppId };
}

function tunnelHost(record: Deployment, hostname: string): ProtectedHost {
  return { name: appNameFor(hostname), hostname, accessAppId: record.tunnel?.accessAppId };
}

function withTunnel(record: Deployment, change: Partial<NonNullable<Deployment["tunnel"]>>) {
  const tunnel = record.tunnel ?? { name: record.name };
  return { ...record, tunnel: { ...tunnel, ...change } };
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
  const label = `Cloudflare Tunnel ${wanted.name}`;
  const recordedId = record.tunnel?.id;
  const found = claimNamed(ctx.cloud.tunnels({ name: wanted.name }), recordedId, label);
  if (!found && recordedId !== undefined) {
    // Its token is in the running containers and its DNS record points to it. Start over.
    throw new Error(`${label} is recorded but gone; tear the deployment down and deploy again`);
  }
  let id = found?.id;
  if (id === undefined) {
    id = ctx.cloud.createTunnel(wanted.name);
    ctx.log(`created ${label}`);
  }
  if (recordedId !== id) record = put(ctx, withTunnel(record, { id }));
  const desired = tunnelIngress(wanted.hostname, wanted.origin);
  if (!sameIngress(ctx.cloud.tunnelIngress(id), desired)) {
    ctx.cloud.putTunnelIngress(id, desired);
    if (!sameIngress(ctx.cloud.tunnelIngress(id), desired)) {
      throw new Error(`${label} does not hold the ingress just written`);
    }
    ctx.log(`set the ingress of ${label}`);
  }
  return { record, id };
}

/** The proxied CNAME from the Tunnel hostname to the Tunnel. Access protects it already. */
function ensureDns(ctx: Context, start: Deployment, hostname: string, tunnelId: string) {
  let record = start;
  const target = `${tunnelId}.cfargotunnel.com`;
  const pointsHere = (r: DnsRecordInfo) => r.type === "CNAME" && r.content === target && r.proxied;
  const recordedId = record.tunnel?.dnsRecordId;
  const found = claimNamed(
    ctx.cloud.dnsRecords({ name: hostname }),
    recordedId,
    `DNS record ${hostname}`,
    pointsHere,
  );
  if (found && !pointsHere(found)) {
    throw new Error(`DNS record ${hostname} no longer points to the deployment's Tunnel`);
  }
  let id = found?.id;
  if (id === undefined) {
    id = ctx.cloud.createDnsRecord(hostname, target, `${record.name}: staging tool`);
    ctx.log(`created DNS record ${hostname}`);
  }
  if (recordedId !== id) record = put(ctx, withTunnel(record, { dnsRecordId: id }));
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
  if (wanted.length === 0) return record;
  const all = ctx.cloud.vpcServices();
  for (const service of wanted) {
    const label = `Workers VPC service ${service.name}`;
    const fits = (v: VpcServiceInfo) =>
      v.type === "http" &&
      v.ipv4 === VPC_HOST &&
      v.tunnelId === tunnelId &&
      v.httpPort === service.port;
    const recordedId = record.vpcServices?.find((s) => s.name === service.name)?.id;
    const found = claimNamed(
      all.filter((v) => v.name === service.name),
      recordedId,
      label,
      fits,
    );
    if (found && !fits(found)) {
      throw new Error(`${label} no longer points to ${VPC_HOST}:${service.port} on the Tunnel`);
    }
    let id = found?.id;
    if (id === undefined) {
      id = ctx.cloud.createVpcService(service.name, tunnelId, service.port);
      ctx.log(`created ${label}`);
    }
    if (recordedId !== id) {
      const created = id;
      record = put(ctx, {
        ...record,
        vpcServices: (record.vpcServices ?? []).map((s) =>
          s.name === service.name ? { ...s, id: created } : s,
        ),
      });
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
    const existing = found && markInterrupted(found, now);
    if (existing?.state === "deleting") {
      throw new Error(`${name} is being torn down; run teardown --suffix ${request.suffix} first`);
    }
    if (existing && existing.owner !== request.owner) {
      throw new Error(`${name} belongs to ${existing.owner}, not ${request.owner}`);
    }
    if (existing && existing.hostname !== hostname) {
      throw new Error(`${name} is recorded at ${existing.hostname}; tear it down first`);
    }
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());

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
    if (plan) checkManifestResourcesAreNew(ctx, existing, plan);

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
    // Locks are per deployment, so the claim is checked and recorded in one atomic registry
    // update: no resource is ever recorded for two deployments (claimsOf).
    ctx.store.update((all) => {
      const mine = claimsOf(intent);
      for (const other of all) {
        if (other.name === name) continue;
        const theirs = claimsOf(other);
        const clash = mine.find((r) => theirs.includes(r));
        if (clash) throw new Error(`${clash} is recorded for the deployment ${other.name}`);
      }
      return [...all.filter((d) => d.name !== name), intent];
    });
    let record = intent;

    // Access before the Worker: the hostname never serves traffic without the owner-only gate.
    // The same holds for the Tunnel hostname, whose Access comes before its DNS record.
    record = ensureAccess(ctx, record, workerHost(record), (r, id) => ({ ...r, accessAppId: id }));
    const recordedTunnelHost = record.tunnel?.hostname;
    if (recordedTunnelHost !== undefined) {
      record = ensureAccess(ctx, record, tunnelHost(record, recordedTunnelHost), (r, id) =>
        withTunnel(r, { accessAppId: id }),
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
 * Removes the Workers VPC services, the Tunnel's DNS record and the Tunnel, in that order, each
 * checked gone before the next. Each step finds its resource by the name the tool gave it and
 * deletes it only if claimNamed says the record owns it, so a rerun after an interrupted
 * teardown skips what is already gone and refuses whatever replaced it.
 */
function removeTunnelResources(ctx: Context, record: Deployment): void {
  const { name, tunnel: t } = record;
  const services = record.vpcServices ?? [];
  const tunnel = t
    ? claimNamed(ctx.cloud.tunnels({ name: t.name }), t.id, `Cloudflare Tunnel ${t.name}`)
    : undefined;
  const tunnelId = tunnel?.id ?? t?.id;

  if (services.length > 0) {
    const all = ctx.cloud.vpcServices();
    const deleted: string[] = [];
    for (const s of services) {
      // An unrecorded service is this deployment's only if it is on this deployment's Tunnel.
      const found = claimNamed(
        all.filter((v) => v.name === s.name),
        s.id,
        `Workers VPC service ${s.name}`,
        (v) => tunnelId !== undefined && v.tunnelId === tunnelId,
      );
      if (found) {
        ctx.cloud.deleteVpcService(found.id);
        deleted.push(found.id);
      }
    }
    if (ctx.cloud.vpcServices().some((v) => deleted.includes(v.id))) {
      throw new Error(`${name}: a Workers VPC service still exists`);
    }
  }

  const host = t?.hostname;
  if (host !== undefined) {
    const target = `${tunnelId}.cfargotunnel.com`;
    const found = claimNamed(
      ctx.cloud.dnsRecords({ name: host }),
      t?.dnsRecordId,
      `DNS record ${host}`,
      (r) => tunnelId !== undefined && r.type === "CNAME" && r.content === target,
    );
    if (found) {
      ctx.cloud.deleteDnsRecord(found.id);
      if (ctx.cloud.dnsRecords({ name: host }).some((r) => r.id === found.id)) {
        throw new Error(`${name}: DNS record ${host} still exists`);
      }
    }
  }

  if (t && tunnel) {
    ctx.cloud.deleteTunnel(tunnel.id);
    if (ctx.cloud.tunnels({ name: t.name }).some((x) => x.id === tunnel.id)) {
      throw new Error(`${name}: Cloudflare Tunnel ${t.name} still exists`);
    }
  }
}

/** Deletes the Access application on `host` that the record owns, and nothing else on it. */
function removeAccess(ctx: Context, host: ProtectedHost): void {
  for (const app of ctx.cloud.listAccessApps(host.hostname)) {
    if (app.domain !== host.hostname) continue;
    const ours = host.accessAppId ? app.id === host.accessAppId : app.name === host.name;
    if (ours) ctx.cloud.deleteAccessApp(app.id);
  }
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
    const record = put(ctx, { ...markInterrupted(found, ctx.now()), state: "deleting" });

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
    if (record.uploadInterruptedAt !== undefined) {
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
    // applications the record points to, or, if an interrupted deploy never recorded an ID,
    // the one carrying the name the tool gave it.
    const recordedTunnelHost = record.tunnel?.hostname;
    if (recordedTunnelHost !== undefined) {
      removeAccess(ctx, tunnelHost(record, recordedTunnelHost));
    }
    removeAccess(ctx, workerHost(record));
    remove(ctx, name);
    ctx.log(`removed ${name}: Worker, containers and buckets, then Access`);
  });
}

/** Lists expired deployments and, with `apply`, tears each one down. Returns the failures. */
export function sweep(ctx: Context, apply: boolean): string[] {
  const now = ctx.now();
  const due = expired(ctx.store.load(), now);
  if (due.length === 0) ctx.log("no expired deployments");
  for (const d of due) ctx.log(`expired: ${d.name} (owner ${d.owner}, ${d.state})`);
  if (!apply) {
    if (due.length > 0) ctx.log("re-run with --yes to remove them");
    return [];
  }
  const failures: string[] = [];
  for (const d of due) {
    try {
      // Another command may have removed or redeployed it since the list was read.
      teardown(ctx, d.name, { ifPresent: true, ifExpiredAt: now });
    } catch (error) {
      failures.push(`${d.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}
