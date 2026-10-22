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
//     after the Worker and before Access. A container the configuration leaves unnamed, as the
//     checked-in production configuration does, is named for the deployment in the rendered copy
//     (withStagingNames), as the Worker is by --name.
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
//   - Every create of an Access application, Tunnel, DNS record, VPC service or bucket is
//     preceded by a create intent in the record (guard.ts), with a fresh nonce that the resource
//     carries, and followed by its ID. Only a resource with the intent's nonce is ever adopted
//     (a bucket, which has no place for one, by its name). A create whose client died may still
//     take effect, like an upload, so a command that finds an intent unresolved waits `settleMs`
//     once (settleCreates). A create still not seen then leaves the record but stays in the
//     registry as a late create, and sweep deletes what it made if it lands. Nothing else found
//     under the tool's names is adopted or deleted: a deploy refuses it, and a teardown leaves it.
//   - F7-staging: a manifest may also ask for a service token. It is created before Access,
//     and each hostname the manifest names gets exactly one more policy, admitting that token
//     (assertOwnerOnly). Its credentials reach the Worker only when it is created or rotated;
//     teardown narrows Access back to the owner, reads each application back by ID, deletes the
//     token, then Access.

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
  boundDeployments,
  type DeployConfigView,
  type Deployment,
  type DnsRecordInfo,
  declaredResources,
  dependencyCycle,
  dnsComment,
  expired,
  expiry,
  hostnameFor,
  type IngressRule,
  isServiceTokenPolicy,
  type LateCreate,
  type LateCreateKind,
  type Manifest,
  madeBy,
  markInterrupted,
  namedFor,
  nonceName,
  type ProtectedHost,
  parseManifest,
  renderedConfigPath,
  resourceName,
  SERVICE_TOKEN_DURATION,
  type ServiceTokenCredentials,
  type ServiceTokenInfo,
  type ServiceTokenManifest,
  type ServiceTokenRecord,
  STAGING_PREFIX,
  type StagingConfig,
  sameIngress,
  secretNameProblems,
  type TokenHostname,
  type TunnelInfo,
  type TunnelRecord,
  tunnelHostnameFor,
  tunnelIngress,
  tunnelRoute,
  VPC_HOST,
  VPC_NONCE_SEPARATOR,
  type VpcServiceInfo,
  type VpcServiceRecord,
  validateDeployConfig,
  vpcServiceName,
  type WorkerDomain,
  type WorkerRoute,
  withStagingNames,
} from "./guard.ts";

/** Lists by exact name, or, for the sweep, by name prefix. */
export type NameFilter = { readonly name: string } | { readonly prefix: string };

export interface Cloud {
  accountIds(): string[];
  /** The Access applications on exactly this hostname. */
  listAccessApps(hostname: string): AccessApp[];
  /** The Access applications whose names start with `prefix`, for the sweep. */
  accessAppsNamed(prefix: string): AccessApp[];
  /** Returns the new application's ID. */
  createAccessApp(body: Record<string, unknown>): string;
  /** Replaces the application's settings with `body`. */
  updateAccessApp(id: string, body: Record<string, unknown>): void;
  deleteAccessApp(id: string): void;
  /*
   * Recorded resources by ID, whatever their name is now: undefined only when Cloudflare says
   * the resource does not exist (or, for a Tunnel, is deleted); throws when the answer is
   * unknown.
   */
  accessApp(id: string): AccessApp | undefined;
  tunnel(id: string): TunnelInfo | undefined;
  dnsRecord(id: string): DnsRecordInfo | undefined;
  vpcService(id: string): VpcServiceInfo | undefined;
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  workerExists(name: string): boolean;
  /** Every Workers custom domain in the account, with the Worker it serves. */
  workerDomains(): WorkerDomain[];
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
  /** The names of the Worker's secrets; never their values. */
  secretNames(name: string): string[];
  /**
   * One change of the Worker's secrets, as a new deployed version (`PATCH …/secrets-bulk`): a
   * value sets a secret, null deletes it. Fails, and creates nothing, for a missing Worker. The
   * values never reach argv or the output.
   */
  updateSecrets(name: string, changes: Readonly<Record<string, string | null>>): void;
  /** True or false only when Cloudflare answered; throws when the answer is unknown. */
  bucketExists(name: string): boolean;
  /** The names of every R2 bucket whose name starts with `prefix`. */
  bucketNames(prefix: string): string[];
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
  /** Access service tokens under this name. */
  serviceTokens(filter: NameFilter): ServiceTokenInfo[];
  /** The service token with this ID, like the lookups above. */
  serviceToken(id: string): ServiceTokenInfo | undefined;
  /** Creates a service token lasting `duration`. Its secret is in the answer, and only there. */
  createServiceToken(name: string, duration: string): ServiceTokenCredentials;
  /** Issues a new client secret; the old one stops working at once. */
  rotateServiceToken(id: string): ServiceTokenCredentials;
  deleteServiceToken(id: string): void;
}

export interface Store {
  load(): Deployment[];
  /** Replaces the registry with `change(current)`, atomically with respect to other commands. */
  update(change: (current: Deployment[]) => Deployment[]): void;
  /** The creates the tool gave up on (guard.ts, LateCreate). */
  lateCreates(): LateCreate[];
  /** Replaces them with `change(current)`, atomically with respect to other commands. */
  updateLateCreates(change: (current: LateCreate[]) => LateCreate[]): void;
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
  /** A fresh nonce for a create: 8 or more lower-case hex digits (guard.ts, NONCE). */
  readonly nonce: () => string;
}

export interface DeployRequest {
  readonly suffix: string;
  readonly owner: string;
  readonly configPath: string;
  readonly days: number;
  /**
   * Secrets to upload with this version (`deploy --secrets-stdin`), besides the manifest's.
   * Secrets set earlier stay set; their names are logged, never their values.
   */
  readonly secrets?: Readonly<Record<string, string>>;
}

export interface SecretsRequest {
  readonly suffix: string;
  readonly owner: string;
  /** A value sets a secret, null deletes it. */
  readonly changes: Readonly<Record<string, string | null>>;
  /**
   * The change is sent only if the tool's clock has not passed this time (milliseconds) once
   * every check is done; otherwise nothing is sent and WindowPassed is thrown. For a change
   * that is valid only for a while, such as WP2.4's release after a fresh status.
   */
  readonly notAfter?: number;
}

/** A change refused because its window (SecretsRequest.notAfter) had passed. Nothing was sent. */
export class WindowPassed extends Error {}

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
    ...(d.serviceToken ? [`Access service token ${d.serviceToken.name}`] : []),
  ];
}

function locked<T>(ctx: Context, name: string, run: () => T): T {
  return lockedAll(ctx, [name], run);
}

/**
 * Runs `run` holding the locks of all `names`, taken in sorted order so that two commands never
 * wait on each other, and released in reverse.
 */
function lockedAll<T>(ctx: Context, names: readonly string[], run: () => T): T {
  const releases: (() => void)[] = [];
  try {
    for (const name of [...new Set(names)].sort()) releases.push(ctx.lock(name));
    return run();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** A record's `dependsOn` field: present only when it names a deployment. */
function dependsOn(names: readonly string[]): { dependsOn?: readonly string[] } {
  return names.length > 0 ? { dependsOn: [...names].sort() } : {};
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
  readonly serviceToken?: ServiceTokenManifest & { readonly name: string };
}

function planFor(name: string, zone: string, manifest: Manifest): ManifestPlan {
  const t = manifest.tunnel;
  return {
    ...(manifest.serviceToken
      ? { serviceToken: { ...manifest.serviceToken, name: `${name}-svc` } }
      : {}),
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

/** What the tool needs of any resource it creates: its ID, its name and, for DNS, its comment. */
interface Resource {
  readonly id: string;
  readonly name: string;
  readonly comment?: string | undefined;
}

/**
 * One resource the tool creates for a deployment, as its record describes it: what Cloudflare
 * lists under the names the tool gives this resource, which properties the tool gives it, and
 * how the record holds its ID, its nonce and its create intent.
 *
 * Every create carries a nonce, fresh for each attempt and recorded with the intent before the
 * request (review r2, finding 2): in the resource's name (guard.ts, nonceName) or, for a DNS
 * record, in its comment. Recovery adopts only a resource that carries the intent's own nonce
 * (marked). A bucket has no place for one and is adopted by its name (guard.ts, create intents).
 */
interface Owned<T extends Resource> {
  readonly kind: LateCreateKind;
  readonly label: string;
  /** The name the tool gives the resource, before its nonce; for a DNS record, its hostname. */
  readonly base: string;
  readonly id: string | undefined;
  /** A create intent is recorded: a create was started and its outcome never seen. */
  readonly pending: boolean;
  /** The nonce of the create intent, kept with the ID once the create is seen. */
  readonly nonce: string | undefined;
  /** What Cloudflare lists under any name the tool gives this resource, whoever made it. */
  candidates(): T[];
  /** The resource with this ID, whatever its name is now; undefined when it is gone. */
  get(id: string): T | undefined;
  /** Whether a resource has exactly the name, nonce and properties the tool gives it. */
  fits(resource: T): boolean;
  /** The record with a create intent, with its nonce, for this resource, and no ID for it. */
  starting(record: Deployment, at: string, nonce: string): Deployment;
  /** The record with this resource's ID, or none (then without its nonce), and no intent. */
  settled(record: Deployment, id: string | undefined): Deployment;
}

/** The create a record's intent describes, as a late create would keep it. */
function createOf(record: Deployment, owned: Owned<Resource>): Omit<LateCreate, "givenUpAt"> {
  const { kind, base: name, nonce } = owned;
  return { kind, deployment: record.name, name, ...(nonce === undefined ? {} : { nonce }) };
}

/**
 * Whether `resource` carries the mark of the record's create for `owned`: its nonce or, for a
 * bucket, its name.
 */
function marked(record: Deployment, owned: Owned<Resource>, resource: Resource): boolean {
  if (owned.kind === "bucket") return resource.name === owned.base;
  return madeBy(createOf(record, owned), resource);
}

/** Whether the record holds `resource`: under its ID, or under its create intent. */
function holds(record: Deployment, owned: Owned<Resource>, resource: Resource): boolean {
  return owned.id === resource.id || (owned.pending && marked(record, owned, resource));
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

/** An owner-only Access application on `host`, named `<hostname label>--<nonce>`. */
function accessOwned(
  ctx: Context,
  host: ProtectedHost,
  nonce: string | undefined,
  pending: boolean,
  fields: {
    starting: Owned<AccessApp>["starting"];
    settled: Owned<AccessApp>["settled"];
  },
): Owned<AccessApp> {
  return {
    kind: "access",
    label: `An Access application on ${host.hostname}`,
    base: host.name,
    id: host.accessAppId,
    pending,
    nonce,
    // Any application on the hostname is a candidate: Access is per hostname, not per name.
    candidates: () =>
      ctx.cloud.listAccessApps(host.hostname).filter((a) => a.domain === host.hostname),
    get: (id) => ctx.cloud.accessApp(id),
    fits: (app) => accessAppFits(app, { ...host, name: nonceName(host.name, nonce) }),
    ...fields,
  };
}

function workerAccess(ctx: Context, record: Deployment): Owned<AccessApp> {
  return accessOwned(
    ctx,
    workerHost(record),
    record.accessNonce,
    record.accessCreateStartedAt !== undefined,
    {
      starting: (r, at, nonce) => {
        const { accessAppId: _, ...rest } = r;
        return { ...rest, accessCreateStartedAt: at, accessNonce: nonce };
      },
      settled: (r, id) => {
        const { accessAppId: _, accessCreateStartedAt: __, accessNonce, ...rest } = r;
        if (id === undefined) return rest;
        return { ...rest, accessAppId: id, ...(accessNonce ? { accessNonce } : {}) };
      },
    },
  );
}

function tunnelAccess(ctx: Context, record: Deployment, hostname: string): Owned<AccessApp> {
  return accessOwned(
    ctx,
    tunnelHost(record, hostname),
    record.tunnel?.accessNonce,
    record.tunnel?.accessCreateStartedAt !== undefined,
    {
      starting: (r, at, nonce) =>
        withTunnel(r, { accessCreateStartedAt: at, accessNonce: nonce }, ["accessAppId"]),
      settled: (r, id) =>
        id === undefined
          ? withTunnel(r, {}, ["accessAppId", "accessCreateStartedAt", "accessNonce"])
          : withTunnel(r, { accessAppId: id }, ["accessCreateStartedAt"]),
    },
  );
}

/** The deployment's Tunnel, named `<deployment>--<nonce>`. */
function tunnelOwned(ctx: Context, record: Deployment): Owned<TunnelInfo> {
  const base = record.tunnel?.name ?? record.name;
  const nonce = record.tunnel?.nonce;
  return {
    kind: "tunnel",
    label: `Cloudflare Tunnel ${base}`,
    base,
    id: record.tunnel?.id,
    pending: record.tunnel?.createStartedAt !== undefined,
    nonce,
    candidates: () => ctx.cloud.tunnels({ prefix: base }).filter((t) => namedFor(t.name, base)),
    get: (id) => ctx.cloud.tunnel(id),
    fits: (tunnel) => tunnel.name === nonceName(base, nonce),
    starting: (r, at, n) => withTunnel(r, { createStartedAt: at, nonce: n }, ["id"]),
    settled: (r, id) =>
      id === undefined
        ? withTunnel(r, {}, ["id", "createStartedAt", "nonce"])
        : withTunnel(r, { id }, ["createStartedAt"]),
  };
}

/** The proxied CNAME from the Tunnel hostname to the Tunnel, with its nonce in the comment. */
function dnsOwned(ctx: Context, record: Deployment, hostname: string): Owned<DnsRecordInfo> {
  const tunnelId = record.tunnel?.id;
  const nonce = record.tunnel?.dnsNonce;
  return {
    kind: "dns",
    label: `DNS record ${hostname}`,
    base: hostname,
    id: record.tunnel?.dnsRecordId,
    pending: record.tunnel?.dnsCreateStartedAt !== undefined,
    nonce,
    candidates: () => ctx.cloud.dnsRecords({ name: hostname }),
    get: (id) => ctx.cloud.dnsRecord(id),
    fits: (r) =>
      tunnelId !== undefined &&
      r.name === hostname &&
      r.type === "CNAME" &&
      r.content === `${tunnelId}.cfargotunnel.com` &&
      r.proxied &&
      (nonce === undefined || r.comment === dnsComment(record.name, nonce)),
    starting: (r, at, n) => withTunnel(r, { dnsCreateStartedAt: at, dnsNonce: n }, ["dnsRecordId"]),
    settled: (r, id) =>
      id === undefined
        ? withTunnel(r, {}, ["dnsRecordId", "dnsCreateStartedAt", "dnsNonce"])
        : withTunnel(r, { dnsRecordId: id }, ["dnsCreateStartedAt"]),
  };
}

/** An HTTP VPC service to VPC_HOST:<port> through the Tunnel, named `<base>--<nonce>`. */
function vpcOwned(
  ctx: Context,
  record: Deployment,
  service: VpcServiceRecord,
): Owned<VpcServiceInfo> {
  const tunnelId = record.tunnel?.id;
  const base = service.name;
  const update = (r: Deployment, change: (s: VpcServiceRecord) => VpcServiceRecord) => ({
    ...r,
    vpcServices: (r.vpcServices ?? []).map((s) => (s.name === base ? change(s) : s)),
  });
  return {
    kind: "vpc",
    label: `Workers VPC service ${base}`,
    base,
    id: service.id,
    pending: service.createStartedAt !== undefined,
    nonce: service.nonce,
    candidates: () =>
      ctx.cloud.vpcServices().filter((v) => namedFor(v.name, base, VPC_NONCE_SEPARATOR)),
    get: (id) => ctx.cloud.vpcService(id),
    fits: (v) =>
      tunnelId !== undefined &&
      v.name === nonceName(base, service.nonce, VPC_NONCE_SEPARATOR) &&
      v.type === "http" &&
      v.ipv4 === VPC_HOST &&
      v.tunnelId === tunnelId &&
      v.httpPort === service.port,
    starting: (r, at, nonce) =>
      update(r, ({ id: _, ...s }) => ({ ...s, createStartedAt: at, nonce })),
    settled: (r, id) =>
      update(r, ({ id: _, createStartedAt: __, nonce, ...s }) =>
        id === undefined ? s : { ...s, id, ...(nonce ? { nonce } : {}) },
      ),
  };
}

/**
 * The deployment's Access service token (F7-staging), named `<deployment>-svc--<nonce>`. Its
 * record forgets `deliveredTo` whenever it changes: a token with a new or unknown secret is held
 * by no Worker secret the tool knows of.
 */
function tokenOwned(ctx: Context, record: Deployment): Owned<ServiceTokenInfo> {
  const base = record.serviceToken?.name ?? `${record.name}-svc`;
  const nonce = record.serviceToken?.nonce;
  const update = (r: Deployment, change: Partial<ServiceTokenRecord>): Deployment => {
    const {
      id: _,
      createStartedAt: __,
      deliveredTo: ___,
      nonce: ____,
      ...rest
    } = r.serviceToken ?? {
      name: base,
    };
    return { ...r, serviceToken: { ...rest, ...change } };
  };
  return {
    kind: "token",
    label: `Access service token ${base}`,
    base,
    id: record.serviceToken?.id,
    pending: record.serviceToken?.createStartedAt !== undefined,
    nonce,
    candidates: () =>
      ctx.cloud.serviceTokens({ prefix: base }).filter((t) => namedFor(t.name, base)),
    get: (id) => ctx.cloud.serviceToken(id),
    fits: (token) => token.name === nonceName(base, nonce),
    starting: (r, at, n) => update(r, { createStartedAt: at, nonce: n }),
    settled: (r, id) => {
      const kept = r.serviceToken?.nonce;
      return update(r, id === undefined ? {} : { id, ...(kept ? { nonce: kept } : {}) });
    },
  };
}

/**
 * The create intent for an R2 bucket the record names (guard.ts, pendingBuckets). The record
 * keeps the bucket's name in `buckets` either way, so teardown deletes it if it exists.
 */
function bucketOwned(ctx: Context, name: string): Owned<Resource> {
  const bucket = (id: string) => (ctx.cloud.bucketExists(id) ? { id, name: id } : undefined);
  const without = (r: Deployment) => (r.pendingBuckets ?? []).filter((b) => b !== name);
  return {
    kind: "bucket",
    label: `R2 bucket ${name}`,
    base: name,
    id: undefined,
    pending: true,
    nonce: undefined,
    candidates: () => {
      const found = bucket(name);
      return found ? [found] : [];
    },
    get: bucket,
    fits: () => true,
    starting: (r) => ({ ...r, pendingBuckets: [...without(r), name] }),
    settled: (r) => {
      const { pendingBuckets: _, ...rest } = r;
      const left = without(r);
      return left.length > 0 ? { ...rest, pendingBuckets: left } : rest;
    },
  };
}

/**
 * The resource the record holds, looked up by its ID, whatever its name is now; undefined when
 * the record holds none or Cloudflare says it is gone. One that has changed, in name or
 * properties, is refused: someone changed it, and it stays, with the record and Access, for the
 * owner to reconcile.
 */
function recorded<T extends Resource>(record: Deployment, owned: Owned<T>): T | undefined {
  if (owned.id === undefined) return undefined;
  const found = owned.get(owned.id);
  if (found && !owned.fits(found)) {
    throw new Error(
      `${record.name}: ${owned.label} has changed since this deployment created it, so it was left in place with Access and the record; inspect it in the dashboard`,
    );
  }
  return found;
}

/**
 * Refuses to create a resource while anything the deployment does not hold already carries one
 * of the names the tool gives it: never adopted, never deleted, left for the owner to reconcile.
 * Sweep tells whether it is a create of this tool that landed late.
 */
function refuseOthers<T extends Resource>(owned: Owned<T>): void {
  const others = owned.candidates();
  if (others.length > 0) {
    throw new Error(
      `${owned.label}: ${others.length === 1 ? "one exists" : `${others.length} exist`} that this deployment did not create; run sweep to see whether a create of this tool landed late, or inspect ${others.length === 1 ? "it" : "them"} in the dashboard`,
    );
  }
}

/** Every resource the record says the tool created or started to create. */
function ownedOf(ctx: Context, record: Deployment): Owned<Resource>[] {
  const t = record.tunnel;
  return [
    workerAccess(ctx, record),
    ...(t?.hostname !== undefined ? [tunnelAccess(ctx, record, t.hostname)] : []),
    ...(t ? [tunnelOwned(ctx, record)] : []),
    ...(t?.hostname !== undefined ? [dnsOwned(ctx, record, t.hostname)] : []),
    ...(record.vpcServices ?? []).map((s) => vpcOwned(ctx, record, s)),
    ...(record.pendingBuckets ?? []).map((b) => bucketOwned(ctx, b)),
    ...(record.serviceToken ? [tokenOwned(ctx, record)] : []),
  ];
}

/**
 * Resolves every create intent in the record. Only a resource that carries the intent's own
 * nonce is adopted, and only with exactly the name and properties the tool gives it; one that
 * carries the nonce but differs is refused. Anything else under the tool's names is someone
 * else's: reported, never adopted or deleted. An intent from before nonces adopts nothing. If
 * none is listed, the create may still take effect: the command waits the settle time once,
 * unless it already has since taking the lock (`waited`), and lists again. A create still not
 * visible then may land later still (review r2, finding 5): its intent leaves the record, and
 * the registry keeps it as a late create, which sweep watches for (guard.ts, LateCreate).
 * Returns the record with no intent left.
 */
function settleCreates(ctx: Context, start: Deployment, waited = false): Deployment {
  let record = start;
  let slept = waited;
  for (;;) {
    const unseen: string[] = [];
    for (const owned of ownedOf(ctx, record).filter((o) => o.pending)) {
      const candidates = owned.candidates();
      const found = candidates.filter((r) => marked(record, owned, r));
      const others = candidates.length - found.length;
      if (others > 0) {
        ctx.log(
          `${owned.label}: ${others} that this deployment did not create left in place; inspect ${others === 1 ? "it" : "them"} in the dashboard`,
        );
      }
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
      // A full settle time has passed since the run that started them ended. The registry keeps
      // each as a late create before its intent leaves the record.
      for (const owned of ownedOf(ctx, record).filter((o) => unseen.includes(o.label))) {
        const late: LateCreate = { ...createOf(record, owned), givenUpAt: ctx.now().toISOString() };
        ctx.store.updateLateCreates((all) => [...all, late]);
        record = put(ctx, owned.settled(record, undefined));
        ctx.log(`${owned.label} did not appear; sweep reports it if it lands later`);
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

/**
 * Records a create intent with a fresh nonce, creates the resource with that nonce, then records
 * its ID in place of the intent.
 */
function createOwned<T extends Resource>(
  ctx: Context,
  start: Deployment,
  owned: Owned<T>,
  create: (nonce: string) => string,
): { record: Deployment; id: string } {
  const nonce = ctx.nonce();
  const intent = put(ctx, owned.starting(start, ctx.now().toISOString(), nonce));
  const id = create(nonce);
  return { record: put(ctx, owned.settled(intent, id)), id };
}

/**
 * Without a terminal, Wrangler 4.149.0 publishes `--domain` with Cloudflare's
 * override_existing_origin and override_existing_dns_record set, so an upload would take over a
 * hostname that a DNS record or another Worker's custom domain uses, and a Worker name that
 * someone else uses. Before the deployment's first upload (`ownsWorker` false), the Worker name
 * and the hostname must be free. Afterwards the hostname must be a custom domain of this Worker
 * only, and, once a deploy succeeded (`lastDeployed`), it must still be one.
 *
 * Checked before anything is recorded and again just before the upload. Between the last check
 * and Wrangler's request, a record someone creates on the hostname would still be replaced:
 * Cloudflare offers no conditional publish, and the window is the upload itself (UC-32). That
 * window is accepted (review r2, finding 1b): the hostname is a cfo-stg- name in the staging
 * zone, which only this tool creates.
 */
function checkWorkerAndDomain(
  ctx: Context,
  name: string,
  hostname: string,
  ownsWorker: boolean,
  lastDeployed: boolean,
): void {
  const attached = ctx.cloud.workerDomains().filter((d) => d.hostname === hostname);
  const other = attached.find((d) => d.service !== name);
  if (other) {
    throw new Error(`${hostname} is a custom domain of the Worker ${other.service}; not deploying`);
  }
  if (!ownsWorker && (attached.length > 0 || ctx.cloud.workerExists(name))) {
    throw new Error(`a Worker named ${name} exists but this deployment did not create it`);
  }
  if (attached.length > 0) return;
  if (lastDeployed) {
    throw new Error(
      `${hostname} is no longer a custom domain of ${name}, as its last deploy left it; inspect it in the dashboard`,
    );
  }
  if (ctx.cloud.dnsRecords({ name: hostname }).length > 0) {
    throw new Error(`${hostname} has DNS records that Wrangler would replace; not deploying`);
  }
}

/**
 * An Access application, Tunnel, DNS record or VPC service that `intent` does not hold yet must
 * have no candidate: nothing may carry a name the tool would give it (refuseOthers), for the
 * same reason as a container or bucket. Checked before recording, after settleCreates has
 * resolved the record's create intents. A recorded VPC service keeps its port.
 */
function checkNewResources(
  ctx: Context,
  existing: Deployment | undefined,
  intent: Deployment,
  plan: ManifestPlan | undefined,
): void {
  for (const owned of ownedOf(ctx, intent)) {
    if (owned.id === undefined && !owned.pending) refuseOthers(owned);
  }
  for (const wanted of plan?.vpcServices ?? []) {
    const recorded = existing?.vpcServices?.find((s) => s.name === wanted.name);
    if (recorded && recorded.port !== wanted.port) {
      throw new Error(
        `Workers VPC service ${wanted.name} is recorded with port ${recorded.port}; tear the deployment down to change it`,
      );
    }
  }
}

/**
 * Adds the manifest's resources to the record before any is created. Like containers, they
 * accumulate: a resource a later manifest leaves out stays recorded until teardown.
 */
function withManifestIntent(start: Deployment, plan: ManifestPlan | undefined): Deployment {
  let record = start;
  if (plan?.serviceToken) {
    record = { ...record, serviceToken: { ...record.serviceToken, name: plan.serviceToken.name } };
  }
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
 * Creates or claims the deployment's service token. Returns its credentials when this run must
 * send them to the Worker: after creating it, or after rotating it because no run has shown
 * that its current secret arrived. The record forgets `deliveredTo` before a rotation, so a run
 * that dies after it rotates again.
 */
function ensureServiceToken(
  ctx: Context,
  start: Deployment,
  wanted: NonNullable<ManifestPlan["serviceToken"]>,
): { record: Deployment; credentials?: ServiceTokenCredentials } {
  let record = start;
  const owned = tokenOwned(ctx, record);
  const found = recorded(record, owned);
  if (!found && owned.id !== undefined) {
    // Its ID is in the Access policies and its secret in the Worker. Start over.
    throw new Error(
      `${owned.label} is recorded but gone; tear the deployment down and deploy again`,
    );
  }
  if (!found) {
    refuseOthers(owned);
    let credentials: ServiceTokenCredentials | undefined;
    ({ record } = createOwned(ctx, record, owned, (nonce) => {
      credentials = ctx.cloud.createServiceToken(
        nonceName(wanted.name, nonce),
        SERVICE_TOKEN_DURATION,
      );
      return credentials.id;
    }));
    ctx.log(`created ${owned.label}, valid for ${SERVICE_TOKEN_DURATION}`);
    return { record, ...(credentials ? { credentials } : {}) };
  }
  const names = [wanted.clientIdSecret, wanted.clientSecretSecret];
  if (record.serviceToken?.deliveredTo?.join() === names.join()) return { record };
  record = put(ctx, owned.settled(record, found.id));
  const credentials = ctx.cloud.rotateServiceToken(found.id);
  ctx.log(`rotated ${owned.label}: no run has shown that its current secret reached the Worker`);
  return { record, credentials };
}

/**
 * Creates, or claims and checks, the owner-only Access application for one hostname, then reads
 * it back: what Access holds now, not what was sent, decides. `tokenId` is set when the
 * manifest admits the deployment's service token on this hostname (F7-staging): the application
 * then holds exactly one more policy, for that token. An existing application may hold that
 * policy for the deployment's recorded token; it is rewritten when the manifest no longer names
 * the hostname.
 */
function ensureAccess(
  ctx: Context,
  start: Deployment,
  host: ProtectedHost,
  ownedIn: (record: Deployment) => Owned<AccessApp>,
  tokenId?: string,
): Deployment {
  let record = start;
  const { hostname } = host;
  const owned = ownedIn(record);
  const app = recorded(record, owned);
  const recordedToken = record.serviceToken?.id;
  const admits = (a: AccessApp, token: string | undefined) =>
    token !== undefined && (a.policies ?? []).some((p) => isServiceTokenPolicy(p, token));
  let id: string;
  if (app) {
    assertOwnerOnly(app, hostname, ctx.config.ownerEmail, recordedToken);
    id = app.id;
    const body = accessAppBody(app.name, hostname, ctx.config, tokenId);
    if (app.same_site_cookie_attribute !== ACCESS_SAME_SITE) {
      ctx.cloud.updateAccessApp(id, body);
      ctx.log(`set SameSite=${ACCESS_SAME_SITE} on the Access application for ${hostname}`);
    } else if (admits(app, recordedToken) !== (tokenId !== undefined)) {
      // tokenId, when set, is the recorded token: ensureServiceToken recorded it first.
      ctx.cloud.updateAccessApp(id, body);
      ctx.log(
        `${tokenId ? "admitted" : "removed"} the service token on the Access application for ${hostname}`,
      );
    }
  } else {
    refuseOthers(owned);
    ({ record, id } = createOwned(ctx, record, owned, (nonce) =>
      ctx.cloud.createAccessApp(
        accessAppBody(nonceName(host.name, nonce), hostname, ctx.config, tokenId),
      ),
    ));
    ctx.log(`created Access application for ${hostname}`);
  }
  const confirmed = recorded(record, ownedIn(record));
  if (!confirmed) throw new Error(`${hostname} has no Access application after writing one`);
  assertOwnerOnly(confirmed, hostname, ctx.config.ownerEmail, tokenId);
  assertSameSite(confirmed, hostname);
  if (tokenId !== undefined && !admits(confirmed, tokenId)) {
    throw new Error(`the Access application for ${hostname} does not admit the service token`);
  }
  // A second application on the hostname could decide instead of this one.
  if (owned.candidates().some((a) => a.id !== id)) {
    throw new Error(
      `${hostname} has another Access application besides this deployment's; inspect it in the Zero Trust dashboard`,
    );
  }
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
  const found = recorded(record, owned);
  if (!found && owned.id !== undefined) {
    // Its token is in the running containers and its DNS record points to it. Start over.
    throw new Error(
      `${owned.label} is recorded but gone; tear the deployment down and deploy again`,
    );
  }
  let id = found?.id;
  if (id === undefined) {
    refuseOthers(owned);
    ({ record, id } = createOwned(ctx, record, owned, (nonce) =>
      ctx.cloud.createTunnel(nonceName(wanted.name, nonce)),
    ));
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
  if (!recorded(record, owned)) {
    refuseOthers(owned);
    const target = `${tunnelId}.cfargotunnel.com`;
    ({ record } = createOwned(ctx, record, owned, (nonce) =>
      ctx.cloud.createDnsRecord(hostname, target, dnsComment(record.name, nonce)),
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
    const entry = record.vpcServices?.find((s) => s.name === service.name) ?? service;
    const owned = vpcOwned(ctx, record, entry);
    if (!recorded(record, owned)) {
      refuseOthers(owned);
      ({ record } = createOwned(ctx, record, owned, (nonce) =>
        ctx.cloud.createVpcService(
          nonceName(service.name, nonce, VPC_NONCE_SEPARATOR),
          tunnelId,
          service.port,
        ),
      ));
      ctx.log(`created ${owned.label}`);
    }
  }
  return record;
}

export function deploy(ctx: Context, request: DeployRequest): Deployment {
  const name = resourceName(request.suffix);
  const hostname = hostnameFor(name, ctx.config.zone);
  const secretProblems = secretNameProblems(Object.keys(request.secrets ?? {}));
  if (secretProblems.length > 0) throw new Error(secretProblems.join("; "));
  // Local checks first: nothing below runs for a configuration that could reach outside
  // staging. A cross-script Durable Object binding is checked against the registry here, and
  // again under the lock just before anything is created.
  const view = ctx.readConfig(request.configPath);
  const check = (deployments: readonly Deployment[]) =>
    validateDeployConfig(view, ctx.config.accountId, name, {
      registry: { owner: request.owner, deployments },
    });
  check(ctx.store.load());
  // Containers as the upload names them: an unnamed one gets the deployment's name.
  const staged = withStagingNames(view.raw, name);
  const declared = declaredResources(staged, name);
  const manifest = ctx.readManifest(request.configPath);
  const plan =
    manifest && planFor(name, ctx.config.zone, parseManifest(manifest.json, manifest.path));
  // The deployments whose Durable Objects this Worker binds stay locked, with this one, until
  // the upload is done: none can be torn down, redeployed or recreated under another owner
  // between the check under the locks and the upload. Their teardown also refuses while this
  // record depends on them.
  const bound = boundDeployments(view.raw, name);
  return lockedAll(ctx, [name, ...bound], () => {
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
    // Whether this deployment has started an upload before: then the Worker name is its own.
    const ownsWorker =
      existing !== undefined &&
      (existing.workerSince !== undefined ||
        existing.state === "deployed" ||
        existing.uploadInterruptedAt !== undefined);
    const lastDeployed = existing?.state === "deployed";

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
        ...(ownsWorker ? { workerSince: existing?.workerSince ?? now.toISOString() } : {}),
        ...dependsOn(union(existing?.dependsOn, bound)),
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
      // No two deployments may depend on each other, even through dependencies kept from an
      // interrupted upload: neither could then be torn down.
      const cycle = dependencyCycle(all, name, intent.dependsOn ?? []);
      if (cycle) {
        throw new Error(
          `binding these Durable Objects would make a dependency cycle (${cycle.join(" → ")}); remove a binding first`,
        );
      }
    };
    refuseClaimed(ctx.store.load());
    checkWorkerAndDomain(ctx, name, hostname, ownsWorker, lastDeployed);
    checkNewResources(ctx, existing, intent, plan);
    ctx.store.update((all) => {
      refuseClaimed(all);
      return [...all.filter((d) => d.name !== name), intent];
    });
    let record = intent;

    // F7-staging: the service token before the Access policies that name it. On its own it
    // opens nothing.
    let tokenCredentials: ServiceTokenCredentials | undefined;
    if (plan?.serviceToken) {
      ({ record, credentials: tokenCredentials } = ensureServiceToken(
        ctx,
        record,
        plan.serviceToken,
      ));
    }
    const tokenFor = (which: TokenHostname) =>
      plan?.serviceToken?.hostnames.includes(which) ? record.serviceToken?.id : undefined;

    // Access before the Worker: the hostname never serves traffic without the owner-only gate.
    // The same holds for the Tunnel hostname, whose Access comes before its DNS record.
    record = ensureAccess(
      ctx,
      record,
      workerHost(record),
      (r) => workerAccess(ctx, r),
      tokenFor("worker"),
    );
    const recordedTunnelHost = record.tunnel?.hostname;
    if (recordedTunnelHost !== undefined) {
      record = ensureAccess(
        ctx,
        record,
        tunnelHost(record, recordedTunnelHost),
        (r) => tunnelAccess(ctx, r, recordedTunnelHost),
        tokenFor("tunnel"),
      );
    }

    // Buckets before the Worker binds them, so Wrangler never provisions one itself. A bucket
    // that exists here is one this record already owned (checked above), or one an
    // interrupted run of this deploy created after recording it.
    for (const bucket of declared.buckets) {
      if (!ctx.cloud.bucketExists(bucket)) {
        // R2 has no field for the nonce, so this create leaves it unused.
        ({ record } = createOwned(ctx, record, bucketOwned(ctx, bucket), () => {
          ctx.cloud.createBucket(bucket);
          return bucket;
        }));
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
        // Wrangler refuses a route that another Worker holds. Neither it nor cf can list a
        // zone's Worker routes, so the tool records no route ID and cannot check after a
        // teardown that the route went with the Worker (review r1, finding 8, and r2, finding 8):
        // that is checked by hand at the preflight.
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
      routes.length + vpcBindings.length > 0 || staged !== view.raw
        ? renderedConfigPath(request.configPath, name)
        : undefined;
    try {
      if (rendered !== undefined) {
        const raw = {
          ...staged,
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
      // working with the one it started with. The service token's credentials go only when
      // this run created or rotated it; otherwise the Worker keeps the ones it has.
      const secrets: Record<string, string> = {};
      if (plan?.tunnel && tunnelId !== undefined) {
        secrets[plan.tunnel.tokenSecret] = ctx.cloud.tunnelToken(tunnelId);
      }
      if (plan?.serviceToken && tokenCredentials) {
        secrets[plan.serviceToken.clientIdSecret] = tokenCredentials.clientId;
        secrets[plan.serviceToken.clientSecretSecret] = tokenCredentials.clientSecret;
      }
      // The caller's own secrets, which may never stand in for the ones the tool delivers.
      const reserved = [
        ...(plan?.tunnel ? [plan.tunnel.tokenSecret] : []),
        ...(plan?.serviceToken
          ? [plan.serviceToken.clientIdSecret, plan.serviceToken.clientSecretSecret]
          : []),
      ];
      for (const [key, value] of Object.entries(request.secrets ?? {})) {
        if (reserved.includes(key)) throw new Error(`the secret ${key} is the staging tool's own`);
        secrets[key] = value;
      }

      // If the upload throws, the record keeps uploadStartedAt: the Worker may exist, or may
      // still appear, and the next command marks the upload interrupted.
      checkWorkerAndDomain(ctx, name, hostname, ownsWorker, lastDeployed);
      const startedAt = ctx.now().toISOString();
      record = put(ctx, {
        ...record,
        uploadStartedAt: startedAt,
        workerSince: record.workerSince ?? startedAt,
      });
      ctx.cloud.deployWorker(
        name,
        hostname,
        rendered ?? request.configPath,
        buildEpoch,
        Object.keys(secrets).length > 0 ? secrets : undefined,
      );
    } finally {
      if (rendered !== undefined) ctx.removeFile(rendered);
    }
    if (!ctx.cloud.workerExists(name)) {
      throw new Error(
        `${name}: Wrangler reported success, but the staging account has no such Worker`,
      );
    }
    // Only now does the Worker bind exactly `bound`.
    const { uploadStartedAt: _, dependsOn: __, ...settled } = record;
    // Wrangler's success and the Worker's presence show that the credentials arrived, as they
    // show that the code did.
    const delivered =
      plan?.serviceToken && tokenCredentials && settled.serviceToken
        ? {
            serviceToken: {
              ...settled.serviceToken,
              deliveredTo: [plan.serviceToken.clientIdSecret, plan.serviceToken.clientSecretSecret],
            },
          }
        : {};
    record = put(ctx, { ...settled, ...delivered, ...dependsOn(bound), state: "deployed" });
    ctx.log(`deployed ${name} at https://${hostname} (expires ${expiresAt})`);
    return record;
  });
}

/**
 * Changes secrets of a deployed staging Worker: one new deployed version, from one bulk
 * request. Only for a deployment the registry shows deployed, by the owner that deployed it,
 * whose Worker Cloudflare confirms; never one of the secrets the tool delivers itself (the
 * service token's). Names are logged, never values.
 */
export function updateSecrets(ctx: Context, request: SecretsRequest): void {
  const name = resourceName(request.suffix);
  const names = Object.keys(request.changes).sort();
  if (names.length === 0) throw new Error("no secret to change");
  const problems = secretNameProblems(names);
  if (problems.length > 0) throw new Error(problems.join("; "));
  locked(ctx, name, () => {
    const record = ctx.store.load().find((d) => d.name === name);
    if (record === undefined) throw new Error(`${name} is not a recorded staging deployment`);
    if (record.owner !== request.owner) {
      throw new Error(`${name} belongs to ${record.owner}, not ${request.owner}`);
    }
    if (record.state !== "deployed" || record.uploadStartedAt !== undefined) {
      throw new Error(`${name} is not deployed; deploy it first`);
    }
    const reserved = record.serviceToken?.deliveredTo ?? [];
    const clash = names.filter((n) => reserved.includes(n));
    if (clash.length > 0)
      throw new Error(`the secrets ${clash.join(", ")} are the staging tool's own`);
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    if (!ctx.cloud.workerExists(name)) {
      throw new Error(`${name} is recorded, but the staging account has no such Worker`);
    }
    // Last, after every check: a change valid only for a while is not sent once it has expired.
    if (request.notAfter !== undefined && ctx.now().getTime() > request.notAfter) {
      throw new WindowPassed(`the change's window has passed; nothing was sent to ${name}`);
    }
    ctx.cloud.updateSecrets(name, request.changes);
    const set = names.filter((n) => request.changes[n] !== null);
    const deleted = names.filter((n) => request.changes[n] === null);
    ctx.log(
      `changed the secrets of ${name}:${set.length > 0 ? ` set ${set.join(", ")}` : ""}${
        deleted.length > 0 ? ` deleted ${deleted.join(", ")}` : ""
      }`,
    );
  });
}

/**
 * The names of a staging Worker's secrets, or null when the registry records no such deployment
 * or Cloudflare has no such Worker. Read-only.
 */
export function listSecretNames(ctx: Context, suffix: string): string[] | null {
  const name = resourceName(suffix);
  if (!ctx.store.load().some((d) => d.name === name)) return null;
  assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
  if (!ctx.cloud.workerExists(name)) return null;
  return ctx.cloud.secretNames(name);
}

/**
 * Deletes the resource the record holds, found by its ID whatever its name is now, and checks by
 * ID that it is gone. One that is gone already is skipped. One that has changed, in name or
 * properties, is refused (recorded): deleting it could cut off what someone made it serve, so
 * it stays, and so do the record entry and Access, for the owner to reconcile. Nothing found by
 * name alone is ever deleted.
 */
function removeOwned<T extends Resource>(
  record: Deployment,
  owned: Owned<T>,
  remove: (id: string) => void,
): void {
  const found = recorded(record, owned);
  if (!found) return;
  remove(found.id);
  if (owned.get(found.id)) throw new Error(`${record.name}: ${owned.label} still exists`);
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
function removeAccess(ctx: Context, record: Deployment, owned: Owned<AccessApp>): void {
  const app = recorded(record, owned);
  if (app) ctx.cloud.deleteAccessApp(app.id);
}

/**
 * Removes the deployment's service token (F7-staging). First each Access application the record
 * holds is looked up by its ID, narrowed back to the owner if it admits the token, and read back
 * by ID. The token is deleted only once every one of them shows owner-only policies, so no policy
 * ever names a deleted token. An application the record holds that cannot be read back keeps
 * the token and the record (review r2, finding 7).
 */
function removeServiceToken(
  ctx: Context,
  record: Deployment,
  apps: readonly { host: ProtectedHost; owned: Owned<AccessApp> }[],
): void {
  if (!record.serviceToken) return;
  const owned = tokenOwned(ctx, record);
  const token = recorded(record, owned);
  if (!token) return;
  for (const { host, owned: app } of apps) {
    if (app.id === undefined) continue;
    const before = recorded(record, app);
    if (before && (before.policies ?? []).some((p) => isServiceTokenPolicy(p, token.id))) {
      ctx.cloud.updateAccessApp(before.id, accessAppBody(before.name, host.hostname, ctx.config));
    }
    const after = recorded(record, app);
    if (!after) {
      throw new Error(
        `${record.name}: ${app.label} cannot be read back, so ${owned.label} was kept, with the record; inspect Access in the dashboard`,
      );
    }
    assertOwnerOnly(after, host.hostname, ctx.config.ownerEmail);
  }
  ctx.cloud.deleteServiceToken(token.id);
  if (owned.get(token.id)) throw new Error(`${record.name}: ${owned.label} still exists`);
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
    const dependents = ctx.store
      .load()
      .filter((d) => d.name !== name && d.dependsOn?.includes(name))
      .map((d) => d.name);
    if (dependents.length > 0) {
      throw new Error(
        `${name} is bound by ${dependents.join(", ")}, whose Worker uses its Durable Objects; tear that down first`,
      );
    }
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    // A Worker under this name is this deployment's only if it ever started an upload; one
    // that appeared otherwise is someone else's and stays, with the record and Access.
    const uploaded =
      found.workerSince !== undefined ||
      found.uploadStartedAt !== undefined ||
      found.uploadInterruptedAt !== undefined ||
      found.state === "deployed";
    if (!uploaded && ctx.cloud.workerExists(name)) {
      throw new Error(
        `a Worker named ${name} exists, but this deployment never uploaded one; it was left in place, and so were Access and the record`,
      );
    }
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

    // The Worker and the Tunnel hostname's DNS record are confirmed absent. Remove the service
    // token, then the Access applications the record holds.
    const recordedTunnelHost = record.tunnel?.hostname;
    const apps = [
      ...(recordedTunnelHost !== undefined
        ? [
            {
              host: tunnelHost(record, recordedTunnelHost),
              owned: tunnelAccess(ctx, record, recordedTunnelHost),
            },
          ]
        : []),
      { host: workerHost(record), owned: workerAccess(ctx, record) },
    ];
    removeServiceToken(ctx, record, apps);
    for (const { owned } of apps) removeAccess(ctx, record, owned);
    remove(ctx, name);
    ctx.log(`removed ${name}: Worker, containers and buckets, then Access`);
  });
}

/**
 * A resource with the staging prefix that no record holds. `late` is the given-up create
 * (guard.ts, LateCreate) whose nonce it carries or, for a bucket, whose name it has. `remove`,
 * set only for one that carries a nonce, deletes it by ID and checks that it is gone.
 */
interface Unowned {
  readonly label: string;
  readonly late: LateCreate | undefined;
  readonly remove?: () => void;
}

/**
 * Every resource with the staging prefix that no record holds, of each kind the tool creates,
 * in the order sweep deletes late ones: VPC services, DNS records, Tunnels, buckets, service
 * tokens, then Access applications. A deployment's own hostname is a Workers custom domain, not an orphan.
 */
function unowned(ctx: Context): Unowned[] {
  const deployments = ctx.store.load();
  const lateCreates = ctx.store.lateCreates();
  const heldBy = (resource: Resource, ownedIn: (d: Deployment) => Owned<Resource>[]) =>
    deployments.some((d) => ownedIn(d).some((owned) => holds(d, owned, resource)));
  const found: Unowned[] = [];
  const add = <T extends Resource>(
    kind: LateCreateKind,
    label: string,
    resource: T,
    get: (id: string) => T | undefined,
    remove: (id: string) => void,
  ) => {
    const late = lateCreates.find(
      (l) =>
        l.kind === kind && (kind === "bucket" ? l.name === resource.name : madeBy(l, resource)),
    );
    if (late?.nonce === undefined) {
      found.push({ label, late });
      return;
    }
    // Checked again by ID under the deployment's lock: delete exactly what carries the nonce.
    const removeLate = () => {
      const current = get(resource.id);
      if (current && madeBy(late, current)) remove(resource.id);
      if (get(resource.id)) throw new Error(`${label} still exists`);
    };
    found.push({ label, late, remove: removeLate });
  };

  for (const v of ctx.cloud.vpcServices()) {
    if (!v.name.startsWith(STAGING_PREFIX)) continue;
    if (heldBy(v, (d) => (d.vpcServices ?? []).map((s) => vpcOwned(ctx, d, s)))) continue;
    add(
      "vpc",
      `Workers VPC service ${v.name}`,
      v,
      (id) => ctx.cloud.vpcService(id),
      (id) => ctx.cloud.deleteVpcService(id),
    );
  }
  for (const r of ctx.cloud.dnsRecords({ prefix: STAGING_PREFIX })) {
    if (deployments.some((d) => d.hostname === r.name)) continue;
    const dnsIn = (d: Deployment) =>
      d.tunnel?.hostname !== undefined ? [dnsOwned(ctx, d, d.tunnel.hostname)] : [];
    if (heldBy(r, dnsIn)) continue;
    add(
      "dns",
      `${r.type} record ${r.name}`,
      r,
      (id) => ctx.cloud.dnsRecord(id),
      (id) => ctx.cloud.deleteDnsRecord(id),
    );
  }
  for (const t of ctx.cloud.tunnels({ prefix: STAGING_PREFIX })) {
    if (heldBy(t, (d) => (d.tunnel ? [tunnelOwned(ctx, d)] : []))) continue;
    add(
      "tunnel",
      `Cloudflare Tunnel ${t.name}`,
      t,
      (id) => ctx.cloud.tunnel(id),
      (id) => ctx.cloud.deleteTunnel(id),
    );
  }
  for (const name of ctx.cloud.bucketNames(STAGING_PREFIX)) {
    if (deployments.some((d) => d.buckets?.includes(name))) continue;
    // A bucket carries no nonce, so it is never deleted here: nothing proves whose it is.
    found.push({
      label: `R2 bucket ${name}`,
      late: lateCreates.find((l) => l.kind === "bucket" && l.name === name),
    });
  }
  for (const t of ctx.cloud.serviceTokens({ prefix: STAGING_PREFIX })) {
    if (heldBy(t, (d) => (d.serviceToken ? [tokenOwned(ctx, d)] : []))) continue;
    add(
      "token",
      `Access service token ${t.name}`,
      t,
      (id) => ctx.cloud.serviceToken(id),
      (id) => ctx.cloud.deleteServiceToken(id),
    );
  }
  for (const app of ctx.cloud.accessAppsNamed(STAGING_PREFIX)) {
    const accessIn = (d: Deployment) => [
      workerAccess(ctx, d),
      ...(d.tunnel?.hostname ? [tunnelAccess(ctx, d, d.tunnel.hostname)] : []),
    ];
    if (heldBy(app, accessIn)) continue;
    add(
      "access",
      `Access application ${app.name} on ${app.domain}`,
      app,
      (id) => ctx.cloud.accessApp(id),
      (id) => {
        // It may still be all that keeps the owner-only gate on its hostname.
        const served =
          ctx.cloud.dnsRecords({ name: app.domain }).length > 0 ||
          ctx.cloud.workerDomains().some((w) => w.hostname === app.domain);
        if (served) throw new Error(`${app.domain} still has a DNS record or a Worker`);
        ctx.cloud.deleteAccessApp(id);
      },
    );
  }
  return found;
}

/**
 * Lists expired deployments and, with `apply`, tears each one down. Then reports every staging
 * resource no record holds, and, with `apply`, deletes those that carry the nonce of a create the
 * registry lists as given up: this tool's, landed late. Nothing else unowned is ever deleted.
 * Returns the failures.
 */
export function sweep(ctx: Context, apply: boolean): string[] {
  const now = ctx.now();
  const due = expired(ctx.store.load(), now);
  if (due.length === 0) ctx.log("no expired deployments");
  for (const d of due) ctx.log(`expired: ${d.name} (owner ${d.owner}, ${d.state})`);
  const failures: string[] = [];
  const failed = (what: string, error: unknown) =>
    failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
  if (!apply) {
    if (due.length > 0) ctx.log("re-run with --yes to remove them");
  } else {
    // A deployment that another one binds goes after it, so both can go in one sweep.
    const left = [...due];
    while (left.length > 0) {
      const d = left.find((x) => !left.some((o) => o.dependsOn?.includes(x.name))) ?? left[0];
      if (!d) break;
      left.splice(left.indexOf(d), 1);
      try {
        // Another command may have removed or redeployed it since the list was read.
        teardown(ctx, d.name, { ifPresent: true, ifExpiredAt: now });
      } catch (error) {
        failed(d.name, error);
      }
    }
  }
  try {
    assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
    for (const { label, late, remove } of unowned(ctx)) {
      if (late === undefined) {
        ctx.log(`orphan: ${label} has the staging prefix, but no record owns it; left in place`);
      } else if (remove === undefined) {
        ctx.log(
          `late?: ${label} has the name of a create of ${late.deployment} given up at ${late.givenUpAt}, but carries no nonce to prove it; left in place for you to check`,
        );
      } else if (!apply) {
        ctx.log(
          `late: ${label} is a create of ${late.deployment} that landed after it was given up at ${late.givenUpAt}; re-run with --yes to delete it`,
        );
      } else {
        try {
          locked(ctx, late.deployment, remove);
          ctx.store.updateLateCreates((all) =>
            all.filter((l) => !(l.kind === late.kind && l.nonce === late.nonce)),
          );
          ctx.log(`late: deleted ${label}, a create of ${late.deployment} that landed late`);
        } catch (error) {
          failed(label, error);
        }
      }
    }
  } catch (error) {
    failed("orphan check", error);
  }
  return failures;
}
