import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccessApp,
  type DeployConfigView,
  type Deployment,
  type DnsRecordInfo,
  declaredResources,
  type IngressRule,
  parseRegistry,
  serializeRegistry,
  type TunnelInfo,
  type VpcServiceInfo,
  type WorkerDomain,
} from "./guard.ts";
import {
  type Cloud,
  type Context,
  deploy,
  type NameFilter,
  type Store,
  sweep,
  teardown,
} from "./ops.ts";

const ACCOUNT = "a".repeat(32);
const OWNER = "owner@example.com";
const config = { accountId: ACCOUNT, zone: "example.com", ownerEmail: OWNER };
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-10-18T12:00:00Z");

/** Simulates the process dying: nothing after this point runs, saves included. */
class ProcessLost extends Error {}

/** The registry file, kept serialized so every load sees exactly what a new process would. */
class FakeStore implements Store {
  text = serializeRegistry([]);
  frozen = false;
  load(): Deployment[] {
    return parseRegistry(JSON.parse(this.text));
  }
  update(change: (current: Deployment[]) => Deployment[]): void {
    if (!this.frozen) this.text = serializeRegistry(change(this.load()));
  }
}

/** Per-deployment locks. A second holder is refused, as with flock --nonblock. */
class FakeLocks {
  readonly held = new Set<string>();
  lock(name: string): () => void {
    if (this.held.has(name)) throw new Error(`busy: ${name} is held by another command`);
    this.held.add(name);
    return () => this.held.delete(name);
  }
}

type DeployFault =
  | "none"
  | "before-upload"
  | "after-upload"
  | "crash-after-access"
  | "crash-after-upload"
  | "lost-response"
  | "phantom-success";
type DeleteMode = "ok" | "fails-after-delete" | "fails" | "silently-keeps";

/**
 * Cloudflare as the staging tool sees it. Records every call, and records a violation whenever
 * a Worker exists without an owner-only Access application on its hostname. Time is the test
 * clock. `real` is elapsed time, which decides when a lost upload lands; `clock` is the wall
 * clock the tool reads, which can jump. An upload whose client died lands at its own time,
 * within SETTLE of real time, whatever happens
 * meanwhile, including later successful uploads.
 */
class FakeCloud implements Cloud {
  readonly calls: string[] = [];
  readonly violations: string[] = [];
  readonly apps = new Map<string, AccessApp>();
  readonly workers = new Map<string, string>(); // name -> hostname
  deployFault: DeployFault = "none";
  /** How long after its client died a lost upload lands; at most SETTLE. */
  lateDelay = SETTLE - 1_000;
  /** Runs inside an upload, before it takes effect: another command acting meanwhile. */
  duringUpload: (() => void) | undefined;
  /** Uploads whose client died, each with the time it takes effect. */
  readonly lateUploads: { name: string; hostname: string; landAt: number }[] = [];
  readonly deleteModes = new Map<string, DeleteMode>();
  lookupUnknown = false;
  /** How long a Worker lookup takes to answer. It reports the state from when it started. */
  lookupDelay = 0;
  /** R2 buckets, container applications (id -> name) and registry images (`repo:tag`). */
  readonly buckets = new Set<string>();
  readonly containerApps_ = new Map<string, string>();
  readonly images = new Set<string>();
  bucketDeleteFails = false;
  /** Deletes that report success but leave the bucket or the image in place. */
  bucketDeleteKeeps = false;
  imageDeleteKeeps = false;
  containerDeleteKeeps = false;
  /** Image digests the registry answers for, also after their image was deleted (DC-36). */
  readonly answered = new Set<string>();
  /** Each repository's current image digest, and the repositories whose image changed. */
  readonly current = new Map<string, string>();
  readonly rollouts: string[] = [];
  /** The build epoch of every upload, and what each upload was given. */
  readonly epochs: number[] = [];
  readonly uploads: {
    name: string;
    configPath: string;
    secrets: Readonly<Record<string, string>> | undefined;
  }[] = [];
  /** The version of the image sources; a change gives new digests. */
  sources = 1;
  /** An Access update that reports success but changes nothing. */
  accessUpdateKeeps = false;
  /** An Access update that sets SameSite but leaves a policy open to everyone. */
  accessUpdateWidens = false;
  /** Listings that no longer show an application, as if it were deleted meanwhile. */
  hideAccessApps = false;
  /** Tunnels, DNS records and VPC services by ID. A Tunnel's token is its secret. */
  readonly tunnels_ = new Map<string, { name: string; ingress: IngressRule[]; token: string }>();
  readonly dns = new Map<string, DnsRecordInfo>();
  readonly vpc = new Map<string, VpcServiceInfo>();
  /** Custom domains of Workers the tool did not deploy. */
  readonly otherDomains: WorkerDomain[] = [];
  /** The secrets each Worker holds, as uploads set them. */
  readonly secrets = new Map<string, Record<string, string>>();
  /** The process dies right after the call that starts with this takes effect. */
  crashAfter: string | undefined;
  /** The next create whose call starts with `prefix` takes effect only `delay` later. */
  lateCreate: { prefix: string; delay: number; die: boolean } | undefined;
  readonly lateEffects: { landAt: number; apply: () => void }[] = [];
  /** Deletes that report success but leave the resource in place. */
  tunnelDeleteKeeps = false;
  dnsDeleteKeeps = false;
  vpcDeleteKeeps = false;
  private nextAppId = 1;
  private nextTag = 1;
  private nextId = 1;
  private readonly store: FakeStore;

  constructor(store: FakeStore) {
    this.store = store;
  }

  private die(): never {
    this.store.frozen = true;
    throw new ProcessLost("process lost");
  }

  /** Records a call, and dies after it if the test says so. */
  private did(call: string): void {
    this.calls.push(call);
    this.check();
    if (this.crashAfter !== undefined && call.startsWith(this.crashAfter)) this.die();
  }

  /**
   * A create's effect. With `lateCreate` set for this call, the effect lands `delay` later and
   * the caller never hears back: its process dies, or its request fails.
   */
  private effect(call: string, apply: () => void): void {
    const late = this.lateCreate;
    if (late === undefined || !call.startsWith(late.prefix)) {
      apply();
      this.did(call);
      return;
    }
    this.lateCreate = undefined;
    this.calls.push(call);
    this.lateEffects.push({ landAt: real + late.delay, apply });
    if (late.die) this.die();
    throw new Error(`${call}: no answer`);
  }

  private protectedByOwner(hostname: string): boolean {
    return [...this.apps.values()].some(
      (app) =>
        app.domain === hostname &&
        app.policies?.every(
          (p) =>
            p.decision === "allow" &&
            JSON.stringify(p.include) === JSON.stringify([{ email: { email: OWNER } }]),
        ),
    );
  }

  private check(): void {
    for (const [name, hostname] of this.workers) {
      if (!this.protectedByOwner(hostname))
        this.violations.push(`${name} reachable without Access`);
    }
    // A DNS record makes the Tunnel hostname reachable, through the Worker route or not.
    for (const record of this.dns.values()) {
      if (!this.protectedByOwner(record.name)) {
        this.violations.push(`${record.name} reachable without Access`);
      }
    }
  }

  /** Lands every lost upload whose time has come. Every call to Cloudflare passes through. */
  tick(): void {
    for (const late of [...this.lateUploads]) {
      if (late.landAt > real) continue;
      this.lateUploads.splice(this.lateUploads.indexOf(late), 1);
      this.workers.set(late.name, late.hostname);
    }
    for (const late of [...this.lateEffects]) {
      if (late.landAt > real) continue;
      this.lateEffects.splice(this.lateEffects.indexOf(late), 1);
      late.apply();
    }
    this.check();
  }

  accountIds(): string[] {
    this.tick();
    this.calls.push("accounts");
    return [ACCOUNT];
  }
  listAccessApps(hostname: string): AccessApp[] {
    this.tick();
    this.calls.push("access.list");
    if (this.hideAccessApps) return [];
    return [...this.apps.values()].filter((app) => app.domain === hostname);
  }
  createAccessApp(body: Record<string, unknown>): string {
    this.tick();
    const id = `app-${this.nextId++}`;
    this.effect(`access.create ${String(body.name)}`, () =>
      this.apps.set(id, { ...(body as unknown as AccessApp), id }),
    );
    if (this.deployFault === "crash-after-access") this.die();
    return id;
  }
  updateAccessApp(id: string, body: Record<string, unknown>): void {
    this.tick();
    this.calls.push(`access.update ${String(body.name)}`);
    if (!this.accessUpdateKeeps) this.apps.set(id, { ...(body as unknown as AccessApp), id });
    if (this.accessUpdateWidens) {
      const app = this.apps.get(id);
      if (app) {
        this.apps.set(id, {
          ...app,
          policies: [{ decision: "allow", include: [{ everyone: {} }] }],
        });
      }
    }
    this.check();
  }
  deleteAccessApp(id: string): void {
    this.tick();
    this.calls.push(`access.delete ${this.apps.get(id)?.name}`);
    this.apps.delete(id);
    this.check();
  }
  workerExists(name: string): boolean {
    this.tick();
    this.calls.push("worker.exists");
    if (this.lookupUnknown) throw new Error("could not tell whether the Worker exists");
    const answer = this.workers.has(name);
    elapse(this.lookupDelay);
    this.tick();
    return answer;
  }
  /** Custom domains: each Worker on the hostname it was deployed to, and any the test adds. */
  workerDomains(): WorkerDomain[] {
    this.tick();
    this.calls.push("worker.domains");
    return [
      ...[...this.workers].map(([service, hostname]) => ({ hostname, service })),
      ...this.otherDomains,
    ];
  }
  deployWorker(
    name: string,
    hostname: string,
    configPath: string,
    buildEpoch: number,
    secrets?: Readonly<Record<string, string>>,
  ): void {
    this.tick();
    this.calls.push(`worker.deploy ${name} ${configPath}`);
    this.uploads.push({ name, configPath, secrets });
    this.epochs.push(buildEpoch);
    this.duringUpload?.();
    if (this.deployFault === "before-upload") throw new Error("wrangler deploy exited with 1");
    // Wrangler binds the declared buckets, creating any that is missing, and creates the
    // container applications and images, before the upload's outcome is known.
    const declared = declaredResources(views[configPath]?.raw ?? {}, name);
    for (const bucket of declared.buckets) {
      if (!this.buckets.has(bucket)) {
        this.violations.push(`Wrangler had to provision ${bucket}`);
        this.buckets.add(bucket);
      }
    }
    for (const container of declared.containers) {
      if (![...this.containerApps_.values()].includes(container)) {
        this.containerApps_.set(`ca-${this.nextAppId++}`, container);
      }
    }
    for (const repository of declared.repositories) {
      // The same sources built with the same epoch give the same digest. Wrangler skips pushing
      // a digest the registry answers for, which it still does after the image was deleted;
      // creating the application then fails (DC-36).
      const digest = `${repository}@${this.sources}@${buildEpoch}`;
      const held = [...this.images].some((i) => i.startsWith(`${repository}:`));
      if (!this.answered.has(digest)) {
        this.images.add(`${repository}:wrangler-${this.nextTag++}`);
        this.answered.add(digest);
      } else if (!held) {
        throw new Error("wrangler deploy exited with 1: IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE");
      }
      if (this.current.has(repository) && this.current.get(repository) !== digest) {
        this.rollouts.push(repository);
      }
      this.current.set(repository, digest);
    }
    if (this.deployFault === "phantom-success") return;
    if (this.deployFault === "lost-response") {
      this.lateUploads.push({ name, hostname, landAt: real + this.lateDelay });
      throw new Error("wrangler deploy exited with 1");
    }
    this.workers.set(name, hostname);
    // Like Wrangler's --secrets-file: added to the secrets the Worker had.
    this.secrets.set(name, { ...this.secrets.get(name), ...secrets });
    this.check();
    if (this.deployFault === "after-upload") throw new Error("wrangler deploy exited with 1");
    if (this.deployFault === "crash-after-upload") this.die();
  }
  deleteWorker(name: string): void {
    this.tick();
    this.calls.push(`worker.delete ${name}`);
    const mode = this.deleteModes.get(name) ?? "ok";
    if (mode === "ok" || mode === "fails-after-delete") this.workers.delete(name);
    if (mode === "fails" || mode === "fails-after-delete") {
      throw new Error("wrangler delete exited with 1");
    }
  }
  bucketExists(name: string): boolean {
    this.tick();
    this.calls.push("bucket.exists");
    return this.buckets.has(name);
  }
  createBucket(name: string): void {
    this.tick();
    this.calls.push(`bucket.create ${name}`);
    this.buckets.add(name);
  }
  emptyAndDeleteBucket(name: string): void {
    this.tick();
    this.calls.push(`bucket.delete ${name}`);
    if (this.bucketDeleteFails) throw new Error("cf r2 failed: bucket not empty");
    if (!this.bucketDeleteKeeps) this.buckets.delete(name);
  }
  containerApps(name: string): string[] {
    this.tick();
    this.calls.push("container.list");
    return [...this.containerApps_].filter(([, n]) => n === name).map(([id]) => id);
  }
  deleteContainerApp(id: string): void {
    this.tick();
    this.calls.push(`container.delete ${this.containerApps_.get(id)}`);
    if (!this.containerDeleteKeeps) this.containerApps_.delete(id);
  }
  containerImages(repository: string): string[] {
    this.tick();
    this.calls.push("image.list");
    return [...this.images].filter((i) => i.startsWith(`${repository}:`));
  }
  deleteContainerImage(reference: string): void {
    this.tick();
    this.calls.push(`image.delete ${reference}`);
    if (!this.imageDeleteKeeps) this.images.delete(reference);
  }
  tunnels(filter: NameFilter): TunnelInfo[] {
    this.tick();
    this.calls.push("tunnel.list");
    return [...this.tunnels_]
      .map(([id, t]) => ({ id, name: t.name }))
      .filter((t) => matches(t.name, filter));
  }
  createTunnel(name: string): string {
    this.tick();
    const id = `tunnel-${this.nextId++}`;
    this.effect(`tunnel.create ${name}`, () =>
      this.tunnels_.set(id, { name, ingress: [], token: `${TOKEN}-${id}` }),
    );
    return id;
  }
  tunnelIngress(id: string): IngressRule[] {
    this.tick();
    this.calls.push("tunnel.config");
    return [...(this.tunnels_.get(id)?.ingress ?? [])];
  }
  putTunnelIngress(id: string, ingress: readonly IngressRule[]): void {
    this.tick();
    const tunnel = this.tunnels_.get(id);
    if (tunnel) tunnel.ingress = [...ingress];
    this.did(`tunnel.put ${tunnel?.name}`);
  }
  tunnelToken(id: string): string {
    this.tick();
    this.calls.push("tunnel.token");
    const token = this.tunnels_.get(id)?.token;
    if (!token) throw new Error("Tunnel not found");
    return token;
  }
  deleteTunnel(id: string): void {
    this.tick();
    const name = this.tunnels_.get(id)?.name;
    if (!this.tunnelDeleteKeeps) this.tunnels_.delete(id);
    this.did(`tunnel.delete ${name}`);
  }
  dnsRecords(filter: NameFilter): DnsRecordInfo[] {
    this.tick();
    this.calls.push("dns.list");
    return [...this.dns.values()].filter((r) => matches(r.name, filter));
  }
  createDnsRecord(name: string, target: string, _comment: string): string {
    this.tick();
    const id = `dns-${this.nextId++}`;
    this.effect(`dns.create ${name}`, () =>
      this.dns.set(id, { id, name, type: "CNAME", content: target, proxied: true }),
    );
    return id;
  }
  deleteDnsRecord(id: string): void {
    this.tick();
    const name = this.dns.get(id)?.name;
    if (!this.dnsDeleteKeeps) this.dns.delete(id);
    this.did(`dns.delete ${name}`);
  }
  vpcServices(): VpcServiceInfo[] {
    this.tick();
    this.calls.push("vpc.list");
    return [...this.vpc.values()];
  }
  createVpcService(name: string, tunnelId: string, port: number): string {
    this.tick();
    const id = `vpc-${this.nextId++}`;
    this.effect(`vpc.create ${name}`, () =>
      this.vpc.set(id, { id, name, type: "http", ipv4: "127.0.0.1", tunnelId, httpPort: port }),
    );
    return id;
  }
  deleteVpcService(id: string): void {
    this.tick();
    const name = this.vpc.get(id)?.name;
    if (!this.vpcDeleteKeeps) this.vpc.delete(id);
    this.did(`vpc.delete ${name}`);
  }
  /** Every bucket, container application, image, Tunnel, DNS and VPC service is recorded. */
  unrecorded(deployments: readonly Deployment[]): string[] {
    const containers = new Set(deployments.flatMap((d) => d.containers ?? []));
    const buckets = new Set(deployments.flatMap((d) => d.buckets ?? []));
    const repositories = new Set([
      ...containers,
      ...deployments.flatMap((d) => d.repositories ?? []),
    ]);
    const tunnels = new Set(deployments.flatMap((d) => (d.tunnel ? [d.tunnel.name] : [])));
    const hosts = new Set(deployments.flatMap((d) => d.tunnel?.hostname ?? []));
    const services = new Set(deployments.flatMap((d) => (d.vpcServices ?? []).map((s) => s.name)));
    return [
      ...[...this.buckets].filter((b) => !buckets.has(b)),
      ...[...this.containerApps_.values()].filter((c) => !containers.has(c)),
      ...[...this.images].filter((i) => !repositories.has(i.slice(0, i.lastIndexOf(":")))),
      ...[...this.tunnels_.values()].map((t) => t.name).filter((n) => !tunnels.has(n)),
      ...[...this.dns.values()].map((r) => r.name).filter((n) => !hosts.has(n)),
      ...[...this.vpc.values()].map((s) => s.name).filter((n) => !services.has(n)),
    ];
  }
  /** How many Tunnels, DNS records and VPC services exist. */
  tunnelResources(): number {
    return this.tunnels_.size + this.dns.size + this.vpc.size;
  }
}

/** A synthetic secret: the tests check that no command, log line or record ever holds it. */
const TOKEN = "synthetic-tunnel-token";

function matches(name: string, filter: NameFilter): boolean {
  return "name" in filter ? name === filter.name : name.startsWith(filter.prefix);
}

const GOOD: DeployConfigView = {
  path: "/w/wrangler.jsonc",
  redirected: false,
  raw: { name: "x", workers_dev: false, preview_urls: false },
  effective: { workers_dev: false, preview_urls: false },
};

/** Registers a configuration with a container and a bucket named for `cfo-stg-<suffix>`. */
function withResources(suffix: string, bucket = `cfo-stg-${suffix}-data`): string {
  const path = `/w/res-${suffix}-${bucket}.jsonc`;
  views[path] = {
    ...GOOD,
    path,
    raw: {
      ...GOOD.raw,
      durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
      containers: [
        {
          name: `cfo-stg-${suffix}-host`,
          class_name: "Host",
          image: "./Dockerfile",
          max_instances: 1,
        },
      ],
      r2_buckets: [{ binding: "DATA", bucket_name: bucket }],
    },
  };
  return path;
}

let store: FakeStore;
let cloud: FakeCloud;
let clock: number;
/** Elapsed time, unaffected by wall-clock jumps. */
let real: number;

/** Time passes: both clocks advance. */
function elapse(ms: number): void {
  clock += ms;
  real += ms;
}
let views: Record<string, DeployConfigView>;
/** Staging manifests by the configuration they sit next to. */
let manifests: Record<string, unknown>;
/** Files the tool wrote and has not removed, and everything it ever wrote. */
let files: Map<string, string>;
let written: { path: string; text: string }[];
let logs: string[];
let locks: FakeLocks;
let ctx: Context;
const SETTLE = 60_000;

/** Reads a rendered configuration back as Wrangler would, for the fields the tool checks. */
function viewOf(path: string, text: string): DeployConfigView {
  const raw = JSON.parse(text) as Record<string, unknown>;
  const effective = Object.fromEntries(
    ["account_id", "workers_dev", "preview_urls", "route", "routes"]
      .filter((key) => raw[key] !== undefined)
      .map((key) => [key, raw[key]]),
  );
  return { path, redirected: false, raw, effective };
}

function newContext(): Context {
  store = new FakeStore();
  cloud = new FakeCloud(store);
  locks = new FakeLocks();
  clock = T0;
  real = 0;
  files = new Map();
  written = [];
  logs = [];
  return {
    config,
    cloud,
    store,
    readConfig: (path) => {
      const view = views[path];
      if (!view) throw new Error(`no config at ${path}`);
      return view;
    },
    readManifest: (path) =>
      manifests[path] === undefined
        ? undefined
        : { path: `${path}/../staging.jsonc`, json: manifests[path] },
    writeFile: (path, text) => {
      files.set(path, text);
      written.push({ path, text });
      views[path] = viewOf(path, text);
    },
    removeFile: (path) => {
      files.delete(path);
      delete views[path];
    },
    lock: (name) => locks.lock(name),
    sleep: (ms) => {
      elapse(ms);
      cloud.calls.push(`sleep ${ms}`);
      cloud.tick();
    },
    settleMs: SETTLE,
    now: () => new Date(clock),
    log: (message) => logs.push(message),
  };
}

beforeEach(() => {
  views = { [GOOD.path]: GOOD };
  manifests = {};
  ctx = newContext();
});

/** A new process: the store is readable again and the injected faults are gone. */
function restart(): void {
  store.frozen = false;
  cloud.deployFault = "none";
  cloud.duringUpload = undefined;
  cloud.deleteModes.clear();
  cloud.lookupUnknown = false;
  cloud.lookupDelay = 0;
  cloud.bucketDeleteFails = false;
  cloud.bucketDeleteKeeps = false;
  cloud.imageDeleteKeeps = false;
  cloud.containerDeleteKeeps = false;
  cloud.crashAfter = undefined;
  cloud.lateCreate = undefined;
  cloud.tunnelDeleteKeeps = false;
  cloud.dnsDeleteKeeps = false;
  cloud.vpcDeleteKeeps = false;
}

/** X1's transport manifest: a Tunnel with a public hostname, and one VPC service. */
const TUNNEL_MANIFEST = {
  tunnel: { origin: "http://localhost:8081", publicHostname: true, tokenSecret: "X1_TUNNEL_TOKEN" },
  vpcServices: [{ binding: "X1_VPC", port: 8081 }],
};

/** Registers a configuration whose Durable Object binding lives in the deployment `script`. */
function withBinding(suffix: string, script: string): string {
  const path = `/w/bound-${suffix}.jsonc`;
  views[path] = {
    ...GOOD,
    path,
    raw: {
      ...GOOD.raw,
      durable_objects: { bindings: [{ name: "RUN", class_name: "RunDO", script_name: script }] },
    },
  };
  return path;
}

/** Registers a configuration with a staging manifest next to it. */
function withManifest(suffix: string, manifest: unknown = TUNNEL_MANIFEST, resources = false) {
  const base = resources ? views[withResources(suffix)] : GOOD;
  const path = `/w/m${resources ? "r" : ""}-${suffix}.jsonc`;
  views[path] = { ...(base ?? GOOD), path };
  manifests[path] = manifest;
  return path;
}

const request = (suffix = "a", days = 7, configPath = GOOD.path) => ({
  suffix,
  owner: "wp0.4",
  configPath,
  days,
});
const record = (name = "cfo-stg-a") => store.load().find((d) => d.name === name);
const order = (...prefixes: string[]) =>
  prefixes.map((p) => cloud.calls.findIndex((call) => call.startsWith(p)));

describe("deploy and teardown", () => {
  it("creates Access before the Worker and removes the Worker before Access", () => {
    const deployed = deploy(ctx, request());
    expect(deployed).toMatchObject({ state: "deployed", accessAppId: "app-1" });
    expect(deployed.expiresAt).toBe(new Date(T0 + 7 * DAY).toISOString());
    const [create, upload] = order("access.create", "worker.deploy");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(upload ?? -1);

    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    expect(cloud.calls).toEqual([
      "accounts",
      "worker.exists",
      "worker.delete cfo-stg-a",
      "worker.exists",
      "access.list",
      "access.delete cfo-stg-a",
    ]);
    expect(store.load()).toEqual([]);
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it("records the deployment before the first cloud mutation", () => {
    cloud.deployFault = "crash-after-access";
    expect(() => deploy(ctx, request())).toThrow(ProcessLost);
    expect(record()).toMatchObject({ state: "pending", hostname: "cfo-stg-a.example.com" });
  });

  it("reuses the recorded Access application on redeploy and extends the pair's expiry", () => {
    deploy(ctx, request("a", 1));
    clock += HOUR;
    deploy(ctx, request("a", 7));
    expect(cloud.apps.size).toBe(1);
    expect(record()).toMatchObject({
      state: "deployed",
      accessAppId: "app-1",
      expiresAt: new Date(clock + 7 * DAY).toISOString(),
    });
  });
});

describe("IR-001: Access stays until the Worker is confirmed absent", () => {
  it("keeps a pending record when the upload took effect but Wrangler failed; sweep then removes the Worker first", () => {
    cloud.deployFault = "after-upload";
    expect(() => deploy(ctx, request("a", 1))).toThrow("wrangler deploy exited with 1");
    expect(record()).toMatchObject({ state: "pending", accessAppId: "app-1" });
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);

    restart();
    clock += 2 * DAY;
    cloud.calls.length = 0;
    expect(sweep(ctx, true)).toEqual([]);
    const [workerDelete, accessDelete] = order("worker.delete", "access.delete");
    expect(workerDelete).toBeGreaterThanOrEqual(0);
    expect(workerDelete).toBeLessThan(accessDelete ?? -1);
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(store.load()).toEqual([]);
    expect(cloud.violations).toEqual([]);
  });

  it("recovers when the process dies after uploading the Worker, before recording it", () => {
    cloud.deployFault = "crash-after-upload";
    expect(() => deploy(ctx, request())).toThrow(ProcessLost);
    restart();
    expect(record()).toMatchObject({ state: "pending", accessAppId: "app-1" });
    teardown(ctx, "cfo-stg-a");
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it("recovers when the process dies after creating Access, before recording its ID", () => {
    cloud.deployFault = "crash-after-access";
    expect(() => deploy(ctx, request())).toThrow(ProcessLost);
    restart();
    expect(record()?.accessAppId).toBeUndefined();

    // A redeploy claims the application it created instead of making a second one.
    deploy(ctx, request());
    expect(cloud.apps.size).toBe(1);
    expect(record()).toMatchObject({ state: "deployed", accessAppId: "app-1" });

    // Teardown finds an unrecorded application by the deployment's name.
    cloud.deployFault = "crash-after-access";
    expect(() => deploy(ctx, request("b"))).toThrow(ProcessLost);
    restart();
    teardown(ctx, "cfo-stg-b");
    expect([...cloud.apps.values()].map((app) => app.name)).toEqual(["cfo-stg-a"]);
  });

  it("gives the Worker and its Access application one expiry across retries", () => {
    cloud.deployFault = "after-upload";
    expect(() => deploy(ctx, request("a", 1))).toThrow();
    restart();
    clock += HOUR;
    deploy(ctx, request("a", 7));

    clock = T0 + 2 * DAY; // past the first attempt's expiry
    expect(sweep(ctx, true)).toEqual([]);
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(cloud.apps.size).toBe(1);

    clock = T0 + 8 * DAY;
    expect(sweep(ctx, true)).toEqual([]);
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it("removes both together when a retry shortens the lifetime", () => {
    cloud.deployFault = "after-upload";
    expect(() => deploy(ctx, request("a", 7))).toThrow();
    restart();
    deploy(ctx, request("a", 1));
    clock = T0 + 2 * DAY;
    expect(sweep(ctx, true)).toEqual([]);
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
  });

  it.each<DeleteMode>(["fails", "silently-keeps"])(
    "keeps Access and the record when the Worker delete %s",
    (mode) => {
      deploy(ctx, request());
      cloud.deleteModes.set("cfo-stg-a", mode);
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow("the Worker still exists");
      expect(cloud.apps.size).toBe(1);
      expect(record()?.state).toBe("deleting");
      expect(cloud.calls.some((call) => call.startsWith("access.delete"))).toBe(false);

      // Deploy refuses until teardown has finished; a later teardown finishes the job.
      expect(() => deploy(ctx, request())).toThrow("being torn down");
      restart();
      teardown(ctx, "cfo-stg-a");
      expect(cloud.workers.size + cloud.apps.size).toBe(0);
      expect(cloud.violations).toEqual([]);
    },
  );

  it("keeps Access when Cloudflare cannot say whether the Worker exists", () => {
    deploy(ctx, request());
    cloud.lookupUnknown = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("could not tell");
    expect(cloud.workers.size).toBe(1);
    expect(cloud.apps.size).toBe(1);
    expect(record()?.state).toBe("deleting");
  });

  it("finishes when the Worker delete failed but took effect", () => {
    deploy(ctx, request());
    cloud.deleteModes.set("cfo-stg-a", "fails-after-delete");
    teardown(ctx, "cfo-stg-a");
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(store.load()).toEqual([]);
  });

  it("keeps going past a failed teardown in a sweep and reports it", () => {
    deploy(ctx, request("a", 1));
    deploy(ctx, request("b", 1));
    cloud.deleteModes.set("cfo-stg-a", "fails");
    clock += 2 * DAY;
    const failures = sweep(ctx, true);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("cfo-stg-a");
    expect(cloud.workers.has("cfo-stg-b")).toBe(false);
    expect([...cloud.apps.values()].map((app) => app.name)).toEqual(["cfo-stg-a"]);
    expect(cloud.violations).toEqual([]);
  });

  it("changes nothing in a sweep without --yes", () => {
    deploy(ctx, request("a", 1));
    clock += 2 * DAY;
    cloud.calls.length = 0;
    expect(sweep(ctx, false)).toEqual([]);
    // Only the account check and the listings of the orphan report.
    expect(cloud.calls).toEqual(["accounts", "tunnel.list", "vpc.list", "dns.list"]);
    expect(record()?.state).toBe("deployed");
  });
});

describe("IR-001: overlapping commands and interrupted uploads", () => {
  it("refuses a teardown from another command while an upload is in flight", () => {
    // The reviewer's interleaving: Access created, upload paused, teardown runs, upload lands.
    cloud.duringUpload = () => {
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow("busy");
      clock += 2 * DAY;
      expect(sweep(ctx, true)).toEqual([expect.stringContaining("busy")]);
      clock -= 2 * DAY;
    };
    deploy(ctx, request("a", 1));
    expect(cloud.apps.size).toBe(1);
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(record()).toMatchObject({ state: "deployed" });
    expect(record()?.uploadStartedAt).toBeUndefined();
    expect(cloud.violations).toEqual([]);
  });

  it("refuses a deploy while another command holds the deployment", () => {
    const release = ctx.lock("cfo-stg-a");
    expect(() => deploy(ctx, request())).toThrow("busy");
    expect(cloud.calls).toEqual([]);
    release();
    expect(deploy(ctx, request()).state).toBe("deployed");
  });

  it("keeps Access when an interrupted upload lands during the settle wait", () => {
    cloud.deployFault = "lost-response";
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    expect(record()?.uploadStartedAt).toBe(new Date(T0).toISOString());
    expect(cloud.workers.size).toBe(0);

    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);

    teardown(ctx, "cfo-stg-a");
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(store.load()).toEqual([]);
  });

  it("waits the settle time before removing Access after an interrupted upload", () => {
    cloud.deployFault = "before-upload";
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    expect(cloud.calls).toEqual([
      "accounts",
      "worker.exists",
      `sleep ${SETTLE}`,
      "worker.exists",
      "access.list",
      "access.delete cfo-stg-a",
    ]);
  });

  it("keeps Access when an earlier lost upload lands after a successful retry", () => {
    // The G0 review's sequence: A loses its client, B succeeds, teardown, then A lands.
    cloud.deployFault = "lost-response";
    cloud.lateDelay = 3_000;
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    deploy(ctx, request());
    expect(record()?.uploadInterruptedAt).toBe(new Date(T0).toISOString());

    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);
    teardown(ctx, "cfo-stg-a");
    elapse(SETTLE);
    cloud.tick();
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  // IR-001: a version 2 record from the tool of d1988ea, written after upload A lost its client
  // and retry B succeeded. Its settleUntil has elapsed by the wall clock, yet A may still land.
  it("waits for a legacy record's interrupted upload before removing Access", () => {
    cloud.deployFault = "lost-response";
    cloud.lateDelay = SETTLE - 1_000;
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    deploy(ctx, request());
    const current = record();
    if (!current) throw new Error("missing record");
    const { uploadInterruptedAt: _, ...legacy } = current;
    store.text = JSON.stringify({
      version: 2,
      deployments: [{ ...legacy, settleUntil: new Date(T0 - 60 * 60_000).toISOString() }],
    });

    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);
    expect(JSON.parse(store.text).version).toBe(3);
    teardown(ctx, "cfo-stg-a");
    elapse(SETTLE);
    cloud.tick();
    expect(cloud.workers.size + cloud.apps.size).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it("keeps the first interruption across later attempts, failed or successful", () => {
    cloud.deployFault = "lost-response";
    expect(() => deploy(ctx, request())).toThrow();
    elapse(10_000);
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    elapse(5_000);
    deploy(ctx, request());
    expect(record()).toMatchObject({
      state: "deployed",
      uploadInterruptedAt: new Date(T0 + 10_000).toISOString(),
    });
    expect(record()?.uploadStartedAt).toBeUndefined();
  });

  // G0 review, run 2, finding 1: the wall clock jumps forward between the commands.
  it("waits the full settle time even after the wall clock jumps forward", () => {
    cloud.deployFault = "lost-response";
    cloud.lateDelay = SETTLE - 1_000;
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    deploy(ctx, request());
    clock += 10 * 60_000; // the wall clock only
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);
  });

  it("waits again when a teardown resumes from deleting after a clock jump", () => {
    cloud.deployFault = "lost-response";
    cloud.lateDelay = SETTLE - 1_000;
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    cloud.lookupUnknown = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("could not tell");
    restart();
    expect(record()?.state).toBe("deleting");
    clock += 10 * 60_000; // the wall clock only
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);
  });

  // G0 review, run 2, finding 2: an absence lookup whose answer arrives after the lost upload
  // landed must not count as the final check.
  it("does not let a slow lookup that began before the wait count as the final check", () => {
    cloud.deployFault = "lost-response";
    cloud.lateDelay = SETTLE - 1_000;
    expect(() => deploy(ctx, request())).toThrow();
    restart();
    deploy(ctx, request());
    // The lost upload lands at 59 s. Each lookup takes 40 s: the first ends at 40 s, then the
    // delete; the second samples "absent" at 40 s and answers at 80 s, after the landing.
    cloud.lookupDelay = 40_000;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("appeared after an interrupted upload");
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(cloud.apps.size).toBe(1);
    expect(cloud.violations).toEqual([]);
  });

  it("refuses to record a deploy that Wrangler reports but Cloudflare does not show", () => {
    cloud.deployFault = "phantom-success";
    expect(() => deploy(ctx, request())).toThrow("has no such Worker");
    expect(record()).toMatchObject({ state: "pending" });
    expect(record()?.uploadStartedAt).toBeDefined();
  });

  it("does not wait after a clean deploy", () => {
    deploy(ctx, request());
    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    expect(cloud.calls.some((call) => call.startsWith("sleep"))).toBe(false);
  });

  it("skips a deployment that another command redeployed after the sweep listed it", () => {
    deploy(ctx, request("a", 1));
    clock += 2 * DAY;
    // The redeploy finishes between the sweep's listing and its teardown taking the lock.
    ctx = {
      ...ctx,
      lock: (name) => {
        store.update((all) =>
          all.map((d) => ({ ...d, expiresAt: new Date(clock + DAY).toISOString() })),
        );
        return locks.lock(name);
      },
    };
    expect(sweep(ctx, true)).toEqual([]);
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(record()?.state).toBe("deployed");
  });
});

describe("containers and buckets", () => {
  const leftovers = () =>
    cloud.buckets.size +
    cloud.containerApps_.size +
    cloud.images.size +
    cloud.apps.size +
    cloud.workers.size;

  it("creates buckets before the upload, and removes containers, images and buckets before Access", () => {
    deploy(ctx, request("a", 7, withResources("a")));
    expect(record()).toMatchObject({ containers: ["cfo-stg-a-host"], buckets: ["cfo-stg-a-data"] });
    const [create, upload] = order("bucket.create", "worker.deploy");
    expect(create).toBeGreaterThanOrEqual(0);
    expect(create).toBeLessThan(upload ?? -1);

    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    const steps = order(
      "worker.delete",
      "container.delete",
      "image.delete",
      "bucket.delete",
      "access.delete",
    );
    expect(steps.every((step) => step >= 0)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(leftovers()).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it("refuses a bucket that exists but this deployment did not create, before anything else", () => {
    cloud.buckets.add("cfo-stg-a-data");
    expect(() => deploy(ctx, request("a", 7, withResources("a")))).toThrow("did not create");
    expect(cloud.calls.filter((c) => /create|deploy/.test(c))).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("refuses a container application that exists but this deployment did not create", () => {
    cloud.containerApps_.set("other", "cfo-stg-a-host");
    expect(() => deploy(ctx, request("a", 7, withResources("a")))).toThrow("did not create");
    expect(store.load()).toEqual([]);
  });

  it("never records one resource for two deployments whose names nest", () => {
    // cfo-stg-a may own cfo-stg-a-x, and so may the deployment cfo-stg-a-x.
    cloud.deployFault = "crash-after-access"; // recorded, not yet created
    expect(() => deploy(ctx, request("a", 7, withResources("a", "cfo-stg-a-x")))).toThrow();
    restart();
    expect(cloud.buckets.has("cfo-stg-a-x")).toBe(false);
    expect(() => deploy(ctx, request("a-x", 7, withResources("a-x", "cfo-stg-a-x")))).toThrow(
      "recorded for the deployment cfo-stg-a",
    );
    expect(record("cfo-stg-a-x")).toBeUndefined();
  });

  it("keeps Access and the record while a bucket cannot be deleted", () => {
    deploy(ctx, request("a", 7, withResources("a")));
    cloud.bucketDeleteFails = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("not empty");
    expect(cloud.apps.size).toBe(1);
    expect(record()?.state).toBe("deleting");
    restart();
    teardown(ctx, "cfo-stg-a");
    expect(leftovers()).toBe(0);
  });

  it("keeps Access while a container application survives its delete", () => {
    deploy(ctx, request("a", 7, withResources("a")));
    cloud.containerDeleteKeeps = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("still exists");
    expect(cloud.apps.size).toBe(1);
    restart();
    teardown(ctx, "cfo-stg-a");
    expect(leftovers()).toBe(0);
  });

  it.each([
    ["an image survives its delete", "imageDeleteKeeps", "still in the registry"],
    ["a bucket survives a delete that reported success", "bucketDeleteKeeps", "still exists"],
  ] as const)("keeps Access while %s", (_, fault, message) => {
    deploy(ctx, request("a", 7, withResources("a")));
    cloud[fault] = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow(message);
    expect(cloud.apps.size).toBe(1);
    expect(record()?.state).toBe("deleting");
    restart();
    teardown(ctx, "cfo-stg-a");
    expect(leftovers()).toBe(0);
  });

  it("removes every image a durable_object-policy container pushed, in its own repository", () => {
    const path = "/w/policy-a.jsonc";
    views[path] = {
      ...GOOD,
      path,
      raw: {
        ...GOOD.raw,
        durable_objects: { bindings: [{ name: "COMPUTER", class_name: "S1Computer" }] },
        containers: [
          {
            name: "cfo-stg-a-computer",
            class_name: "S1Computer",
            scheduling_policy: "durable_object",
            images: { computer: { dockerfile: "./computer/Dockerfile" } },
          },
        ],
      },
    };
    deploy(ctx, request("a", 7, path));
    cloud.sources += 1; // changed sources: the next deploy pushes a new tag
    deploy(ctx, request("a", 7, path));
    expect(record()?.repositories).toEqual(["cfo-stg-a-s1computer-computer"]);
    expect(
      [...cloud.images].filter((i) => i.startsWith("cfo-stg-a-s1computer-computer:")),
    ).toHaveLength(2);
    teardown(ctx, "cfo-stg-a");
    expect(leftovers()).toBe(0);
  });

  it("refuses a repository that already has images this deployment did not push", () => {
    cloud.images.add("cfo-stg-a-host:other");
    expect(() => deploy(ctx, request("a", 7, withResources("a")))).toThrow("did not push");
    expect(store.load()).toEqual([]);
  });

  it("remembers the containers and buckets of earlier deploys", () => {
    deploy(ctx, request("a", 7, withResources("a")));
    deploy(ctx, request("a")); // the plain configuration declares neither
    expect(record()).toMatchObject({ containers: ["cfo-stg-a-host"], buckets: ["cfo-stg-a-data"] });
    teardown(ctx, "cfo-stg-a");
    expect(leftovers()).toBe(0);
  });
});

describe("staging manifest: a Tunnel, its public hostname and Workers VPC services", () => {
  const HOST = "cfo-stg-a-tunnel.example.com";
  const RENDERED = "/w/.stg-rendered.cfo-stg-a.jsonc";
  const everything = () =>
    cloud.tunnelResources() +
    cloud.apps.size +
    cloud.workers.size +
    cloud.buckets.size +
    cloud.containerApps_.size +
    cloud.images.size;
  const creates = () => cloud.calls.filter((c) => /\.(create|put|update)\b/.test(c));
  const uploaded = () => cloud.calls.some((c) => c.startsWith("worker.deploy"));

  it("creates Access for both hostnames, then buckets, the Tunnel, DNS and VPC, then the Worker", () => {
    deploy(ctx, request("a", 7, withManifest("a", TUNNEL_MANIFEST, true)));
    const steps = order(
      "access.create cfo-stg-a",
      "access.create cfo-stg-a-tunnel",
      "bucket.create",
      "tunnel.create",
      "tunnel.put",
      "dns.create",
      "vpc.create",
      "worker.deploy",
    );
    expect(steps.every((step) => step >= 0)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(record()).toMatchObject({
      state: "deployed",
      accessAppId: "app-1",
      tunnel: {
        name: "cfo-stg-a",
        id: "tunnel-3",
        hostname: HOST,
        accessAppId: "app-2",
        dnsRecordId: "dns-4",
      },
      vpcServices: [{ name: "cfo-stg-a-x1-vpc", binding: "X1_VPC", port: 8081, id: "vpc-5" }],
    });
    expect(cloud.apps.get("app-2")).toMatchObject({
      name: "cfo-stg-a-tunnel",
      domain: HOST,
      same_site_cookie_attribute: "lax",
    });
    expect(cloud.tunnels_.get("tunnel-3")?.ingress).toEqual([
      { hostname: HOST, service: "http://localhost:8081" },
      { service: "http_status:404" },
    ]);
    expect(cloud.dns.get("dns-4")).toMatchObject({
      name: HOST,
      type: "CNAME",
      content: "tunnel-3.cfargotunnel.com",
      proxied: true,
    });
    expect(cloud.vpc.get("vpc-5")).toMatchObject({
      tunnelId: "tunnel-3",
      ipv4: "127.0.0.1",
      httpPort: 8081,
    });
    expect(cloud.secrets.get("cfo-stg-a")).toEqual({ X1_TUNNEL_TOKEN: `${TOKEN}-tunnel-3` });
    expect(cloud.violations).toEqual([]);
  });

  it("deploys a rendered copy next to the configuration, with the route and VPC bindings, and removes it", () => {
    const path = withManifest("a", TUNNEL_MANIFEST, true);
    deploy(ctx, request("a", 7, path));
    expect(cloud.uploads.at(-1)?.configPath).toBe(RENDERED);
    expect(written.map((w) => w.path)).toEqual([RENDERED]);
    const raw = JSON.parse(written[0]?.text ?? "{}");
    expect(raw).toEqual({
      ...views[path]?.raw,
      routes: [{ pattern: `${HOST}/*`, zone_name: "example.com" }],
      vpc_services: [{ binding: "X1_VPC", service_id: "vpc-5" }],
    });
    expect(files.size).toBe(0);
    // The checked configuration itself is never written.
    expect(views[path]?.raw).not.toHaveProperty("routes");
  });

  it("removes the rendered copy when the upload fails", () => {
    cloud.deployFault = "before-upload";
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow("wrangler deploy");
    expect(written).toHaveLength(1);
    expect(files.size).toBe(0);
  });

  it("refuses to upload a rendered copy that Wrangler reads differently", () => {
    const path = withManifest("a");
    const write = ctx.writeFile;
    ctx = {
      ...ctx,
      writeFile: (file, text) => {
        write(file, text);
        const view = views[file];
        if (view) {
          views[file] = {
            ...view,
            effective: { ...view.effective, routes: ["elsewhere.example.com/*"] },
          };
        }
      },
    };
    expect(() => deploy(ctx, request("a", 7, path))).toThrow('"routes" differs');
    expect(uploaded()).toBe(false);
    expect(files.size).toBe(0);
  });

  it("redeploys without creating anything, rewriting the ingress or changing the token", () => {
    const path = withManifest("a", TUNNEL_MANIFEST, true);
    deploy(ctx, request("a", 7, path));
    const first = record();
    cloud.calls.length = 0;
    elapse(HOUR);
    deploy(ctx, request("a", 7, path));
    expect(creates()).toEqual([]);
    expect(cloud.calls.filter((c) => c.startsWith("tunnel.put"))).toEqual([]);
    expect(record()).toEqual({ ...first, expiresAt: new Date(clock + 7 * DAY).toISOString() });
    expect(cloud.uploads.map((u) => u.secrets)).toEqual([
      { X1_TUNNEL_TOKEN: `${TOKEN}-tunnel-3` },
      { X1_TUNNEL_TOKEN: `${TOKEN}-tunnel-3` },
    ]);
    expect(cloud.rollouts).toEqual([]);
  });

  it("puts the Tunnel token only into the upload: never a command, log line, record or file", () => {
    deploy(ctx, request("a", 7, withManifest("a")));
    teardown(ctx, "cfo-stg-a");
    expect(cloud.uploads[0]?.secrets).toEqual({ X1_TUNNEL_TOKEN: `${TOKEN}-tunnel-3` });
    for (const text of [...cloud.calls, ...logs, store.text, ...written.map((w) => w.text)]) {
      expect(text).not.toContain(TOKEN);
    }
  });

  it("resets the ingress when it was changed", () => {
    const path = withManifest("a");
    deploy(ctx, request("a", 7, path));
    const tunnel = cloud.tunnels_.get("tunnel-3");
    if (!tunnel) throw new Error("missing Tunnel");
    tunnel.ingress = [{ service: "http://localhost:22" }];
    deploy(ctx, request("a", 7, path));
    expect(tunnel.ingress).toEqual([
      { hostname: HOST, service: "http://localhost:8081" },
      { service: "http_status:404" },
    ]);
  });

  it("refuses to upload when the Tunnel does not hold the ingress written", () => {
    const path = withManifest("a");
    cloud.putTunnelIngress = function (this: FakeCloud) {
      this.calls.push("tunnel.put (ignored)");
    };
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("does not hold the ingress");
    expect(uploaded()).toBe(false);
  });

  it("makes a private Tunnel with VPC services and no public hostname", () => {
    const manifest = {
      tunnel: { tokenSecret: "X1_TUNNEL_TOKEN" },
      vpcServices: [{ binding: "X1_VPC", port: 8081 }],
    };
    deploy(ctx, request("a", 7, withManifest("a", manifest)));
    expect(cloud.apps.size).toBe(1);
    expect(cloud.dns.size).toBe(0);
    expect(cloud.tunnels_.get("tunnel-2")?.ingress).toEqual([{ service: "http_status:404" }]);
    const raw = JSON.parse(written[0]?.text ?? "{}");
    expect(raw).not.toHaveProperty("routes");
    expect(raw.vpc_services).toEqual([{ binding: "X1_VPC", service_id: "vpc-3" }]);
    expect(record()?.tunnel).toEqual({ name: "cfo-stg-a", id: "tunnel-2" });
    teardown(ctx, "cfo-stg-a");
    expect(everything()).toBe(0);
  });

  it("deploys a Tunnel without VPC services, and renders nothing without a route", () => {
    deploy(ctx, request("a", 7, withManifest("a", { tunnel: { tokenSecret: "T" } })));
    expect(written).toEqual([]);
    expect(cloud.uploads[0]).toMatchObject({
      configPath: "/w/m-a.jsonc",
      secrets: { T: `${TOKEN}-tunnel-2` },
    });
    expect(record()).not.toHaveProperty("vpcServices");
  });

  it("without a manifest, makes no Tunnel calls and uploads the checked file without secrets", () => {
    deploy(ctx, request());
    // Only the checks that the Worker hostname is free (review r1, finding 1) list DNS.
    expect(cloud.calls.filter((c) => /^(tunnel|dns|vpc)\./.test(c))).toEqual([
      "dns.list",
      "dns.list",
    ]);
    expect(cloud.uploads).toEqual([
      { name: "cfo-stg-a", configPath: GOOD.path, secrets: undefined },
    ]);
    expect(written).toEqual([]);
    expect(record()).not.toHaveProperty("tunnel");
  });

  it("refuses a manifest the tool does not understand before any cloud call", () => {
    const path = withManifest("a", { tunnel: { tokenSecret: "T" }, serviceToken: {} });
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("refusing staging manifest");
    expect(cloud.calls).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("removes the VPC services, DNS record and Tunnel after the Worker, and Access last", () => {
    deploy(ctx, request("a", 7, withManifest("a", TUNNEL_MANIFEST, true)));
    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    const steps = order(
      "worker.delete",
      "container.delete",
      "image.delete",
      "vpc.delete",
      "dns.delete",
      "tunnel.delete",
      "bucket.delete",
      "access.delete cfo-stg-a-tunnel",
      "access.delete cfo-stg-a",
    );
    expect(steps.every((step) => step >= 0)).toBe(true);
    expect([...steps].sort((x, y) => x - y)).toEqual(steps);
    expect(everything()).toBe(0);
    expect(store.load()).toEqual([]);
    expect(cloud.violations).toEqual([]);
  });

  it.each([
    "access.create cfo-stg-a-tunnel",
    "tunnel.create",
    "tunnel.put",
    "dns.create",
    "vpc.create",
  ])(
    "recovers when the process dies right after %s: a rerun finishes without duplicates",
    (point) => {
      const path = withManifest("a", TUNNEL_MANIFEST, true);
      cloud.crashAfter = point;
      expect(() => deploy(ctx, request("a", 7, path))).toThrow(ProcessLost);
      restart();
      expect(cloud.unrecorded(store.load())).toEqual([]);
      expect(cloud.violations).toEqual([]);
      deploy(ctx, request("a", 7, path));
      expect([cloud.apps.size, cloud.tunnels_.size, cloud.dns.size, cloud.vpc.size]).toEqual([
        2, 1, 1, 1,
      ]);
      expect(record()?.state).toBe("deployed");
      teardown(ctx, "cfo-stg-a");
      expect(everything()).toBe(0);
      expect(cloud.violations).toEqual([]);
    },
  );

  it.each([
    "access.create cfo-stg-a-tunnel",
    "tunnel.create",
    "tunnel.put",
    "dns.create",
    "vpc.create",
  ])("tears down everything after the process died right after %s", (point) => {
    cloud.crashAfter = point;
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
    restart();
    teardown(ctx, "cfo-stg-a");
    expect(everything()).toBe(0);
    expect(store.load()).toEqual([]);
    expect(cloud.violations).toEqual([]);
  });

  it("resumes a teardown that died after removing the DNS record", () => {
    deploy(ctx, request("a", 7, withManifest("a")));
    cloud.crashAfter = "dns.delete";
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow(ProcessLost);
    restart();
    expect(cloud.apps.size).toBe(2);
    teardown(ctx, "cfo-stg-a");
    expect(everything()).toBe(0);
    expect(cloud.violations).toEqual([]);
  });

  it.each([
    ["the Tunnel", "tunnelDeleteKeeps", "Cloudflare Tunnel cfo-stg-a still exists"],
    ["the DNS record", "dnsDeleteKeeps", `DNS record ${HOST} still exists`],
    ["a VPC service", "vpcDeleteKeeps", "Workers VPC service cfo-stg-a-x1-vpc still exists"],
  ] as const)("keeps Access and the record while %s survives its delete", (_, fault, message) => {
    deploy(ctx, request("a", 7, withManifest("a")));
    cloud[fault] = true;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow(message);
    expect(cloud.apps.size).toBe(2);
    expect(record()?.state).toBe("deleting");
    expect(cloud.violations).toEqual([]);
    restart();
    teardown(ctx, "cfo-stg-a");
    expect(everything()).toBe(0);
  });

  it("remembers the Tunnel of an earlier deploy and keeps its hostname behind Access", () => {
    deploy(ctx, request("a", 7, withManifest("a")));
    deploy(ctx, request("a")); // no manifest
    expect(record()?.tunnel?.hostname).toBe(HOST);
    expect(cloud.uploads.at(-1)).toMatchObject({ configPath: GOOD.path, secrets: undefined });
    teardown(ctx, "cfo-stg-a");
    expect(everything()).toBe(0);
  });

  describe("refuses what it did not create", () => {
    it("a Tunnel under the deployment's name, before recording anything", () => {
      cloud.tunnels_.set("theirs", { name: "cfo-stg-a", ingress: [], token: "x" });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(
        "Cloudflare Tunnel cfo-stg-a exists but this deployment did not create it",
      );
      expect(store.load()).toEqual([]);
      expect(creates()).toEqual([]);
    });

    it("a DNS record on the Tunnel hostname", () => {
      cloud.dns.set("theirs", {
        id: "theirs",
        name: HOST,
        type: "A",
        content: "192.0.2.1",
        proxied: true,
      });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(
        "DNS records this deployment did not create",
      );
      expect(store.load()).toEqual([]);
    });

    it("a VPC service under the name the tool would give", () => {
      cloud.vpc.set("theirs", { id: "theirs", name: "cfo-stg-a-x1-vpc" });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(
        "Workers VPC service cfo-stg-a-x1-vpc exists but this deployment did not create it",
      );
      expect(store.load()).toEqual([]);
    });

    it("an Access application on the Tunnel hostname with another name", () => {
      cloud.apps.set("theirs", {
        id: "theirs",
        name: "someone-else",
        domain: HOST,
        type: "self_hosted",
        policies: [{ decision: "allow", include: [{ email: { email: OWNER } }] }],
      });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(
        "this deployment did not create",
      );
      expect(
        cloud.calls.some((c) => c.startsWith("tunnel.create") || c.startsWith("dns.create")),
      ).toBe(false);
    });

    it("a Tunnel hostname whose Access application was widened, before its DNS record", () => {
      const path = withManifest("a");
      cloud.crashAfter = "access.create cfo-stg-a-tunnel";
      expect(() => deploy(ctx, request("a", 7, path))).toThrow(ProcessLost);
      restart();
      const app = cloud.apps.get("app-2");
      if (!app) throw new Error("missing app");
      cloud.apps.set("app-2", {
        ...app,
        policies: [{ decision: "allow", include: [{ everyone: {} }] }],
      });
      expect(() => deploy(ctx, request("a", 7, path))).toThrow("not owner-only");
      expect(cloud.dns.size).toBe(0);
      expect(uploaded()).toBe(false);
    });

    it("a Tunnel that replaced the recorded one, in deploy and in teardown", () => {
      deploy(ctx, request("a", 7, withManifest("a")));
      cloud.tunnels_.delete("tunnel-3");
      cloud.tunnels_.set("theirs", { name: "cfo-stg-a", ingress: [], token: "x" });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow("did not record it");
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow("did not record it");
      expect(cloud.tunnels_.has("theirs")).toBe(true);
      expect(cloud.apps.size).toBe(2);
      expect(record()?.state).toBe("deleting");
    });

    it("a recorded Tunnel that is gone", () => {
      deploy(ctx, request("a", 7, withManifest("a")));
      cloud.tunnels_.clear();
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow("recorded but gone");
      teardown(ctx, "cfo-stg-a");
      expect(everything()).toBe(0);
    });

    // Review r1, finding 3: the recorded ID alone does not license a delete.
    it.each([
      ["pointing elsewhere", { content: "elsewhere.example.net" }],
      ["of another type", { type: "A", content: "192.0.2.1" }],
      ["no longer proxied", { proxied: false }],
    ])("a DNS record now %s, which deploy and teardown both leave alone", (_, change) => {
      deploy(ctx, request("a", 7, withManifest("a")));
      const dns = cloud.dns.get("dns-4");
      if (!dns) throw new Error("missing record");
      cloud.dns.set("dns-4", { ...dns, ...change });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow("no longer points");
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow(
        `DNS record ${HOST} has changed since this deployment created it`,
      );
      expect(cloud.dns.get("dns-4")).toEqual({ ...dns, ...change });
      expect(record()).toMatchObject({ state: "deleting", tunnel: { dnsRecordId: "dns-4" } });
      expect(cloud.apps.size).toBe(2);
      expect(cloud.violations).toEqual([]);
      // Once the owner restores or removes it, teardown finishes.
      cloud.dns.delete("dns-4");
      teardown(ctx, "cfo-stg-a");
      expect(everything()).toBe(0);
    });

    it.each([
      ["another Tunnel", { tunnelId: "tunnel-other" }],
      ["another host", { ipv4: "10.0.0.1" }],
      ["another port", { httpPort: 22 }],
    ])("a VPC service moved to %s, which teardown leaves alone", (_, change) => {
      deploy(ctx, request("a", 7, withManifest("a")));
      const service = cloud.vpc.get("vpc-5");
      if (!service) throw new Error("missing service");
      cloud.vpc.set("vpc-5", { ...service, ...change });
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow(
        "Workers VPC service cfo-stg-a-x1-vpc has changed since this deployment created it",
      );
      expect(cloud.vpc.get("vpc-5")).toEqual({ ...service, ...change });
      expect(record()?.vpcServices?.[0]?.id).toBe("vpc-5");
      expect(cloud.tunnels_.size + cloud.dns.size + cloud.apps.size).toBe(4);
    });

    it("an unrecorded DNS record that replaced ours, which teardown refuses to delete", () => {
      deploy(ctx, request("a", 7, withManifest("a")));
      cloud.dns.delete("dns-4");
      cloud.dns.set("theirs", {
        id: "theirs",
        name: HOST,
        type: "CNAME",
        content: "x",
        proxied: true,
      });
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow("DNS record");
      expect(cloud.dns.has("theirs")).toBe(true);
      expect(cloud.apps.size).toBe(2);
    });

    it("a VPC service that changed, and a manifest that changes a recorded port", () => {
      deploy(ctx, request("a", 7, withManifest("a")));
      const service = cloud.vpc.get("vpc-5");
      if (!service) throw new Error("missing service");
      cloud.vpc.set("vpc-5", { ...service, httpPort: 22 });
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow("no longer points");
      cloud.vpc.set("vpc-5", service);
      const moved = { ...TUNNEL_MANIFEST, vpcServices: [{ binding: "X1_VPC", port: 9000 }] };
      expect(() => deploy(ctx, request("a", 7, withManifest("a", moved)))).toThrow(
        "recorded with port 8081",
      );
    });

    it("an unrecorded VPC service on another Tunnel, in teardown", () => {
      cloud.crashAfter = "tunnel.put";
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
      restart();
      cloud.vpc.set("theirs", { id: "theirs", name: "cfo-stg-a-x1-vpc", tunnelId: "other" });
      expect(() => teardown(ctx, "cfo-stg-a")).toThrow("Workers VPC service cfo-stg-a-x1-vpc");
      expect(cloud.vpc.has("theirs")).toBe(true);
    });
  });

  it("sweeps an expired deployment's Tunnel resources with the rest", () => {
    deploy(ctx, request("a", 1, withManifest("a", TUNNEL_MANIFEST, true)));
    clock += 2 * DAY;
    expect(sweep(ctx, true)).toEqual([]);
    expect(everything()).toBe(0);
    expect(store.load()).toEqual([]);
  });

  it("reports orphaned staging Tunnels, VPC services and DNS records, and removes none", () => {
    deploy(ctx, request("a", 7, withManifest("a")));
    // An interrupted deploy of b recorded its Tunnel's name but not yet its ID.
    cloud.crashAfter = "tunnel.create";
    expect(() => deploy(ctx, request("b", 7, withManifest("b")))).toThrow(ProcessLost);
    restart();
    cloud.tunnels_.set("lost", { name: "cfo-stg-old", ingress: [], token: "x" });
    cloud.vpc.set("lost", { id: "lost", name: "cfo-stg-old-vpc" });
    cloud.vpc.set("prod", { id: "prod", name: "production-api" });
    cloud.dns.set("lost", {
      id: "lost",
      name: "cfo-stg-old-tunnel.example.com",
      type: "CNAME",
      content: "x",
      proxied: true,
    });
    // The Worker's custom domain, as Cloudflare may list it.
    cloud.dns.set("custom", {
      id: "custom",
      name: "cfo-stg-a.example.com",
      type: "AAAA",
      content: "100::",
      proxied: true,
    });
    const before = everything();
    for (const apply of [false, true]) {
      logs.length = 0;
      expect(sweep(ctx, apply)).toEqual([]);
      expect(logs.filter((l) => l.startsWith("orphan:"))).toEqual([
        "orphan: Cloudflare Tunnel cfo-stg-old has the staging prefix, but no record owns it; left in place",
        "orphan: Workers VPC service cfo-stg-old-vpc has the staging prefix, but no record owns it; left in place",
        "orphan: CNAME record cfo-stg-old-tunnel.example.com has the staging prefix, but no record owns it; left in place",
      ]);
    }
    expect(everything()).toBe(before);
    // A record that replaced ours under a recorded ID is not ours either.
    cloud.dns.delete("dns-4");
    cloud.dns.set("swap", { id: "swap", name: HOST, type: "CNAME", content: "x", proxied: true });
    logs.length = 0;
    sweep(ctx, false);
    expect(logs).toContain(
      `orphan: CNAME record ${HOST} has the staging prefix, but no record owns it; left in place`,
    );
  });

  it("reports a failed orphan check as a failure", () => {
    cloud.tunnels = () => {
      throw new Error("cf tunnels failed: [10000] Authentication error");
    };
    expect(sweep(ctx, false)).toEqual([
      "orphan check: cf tunnels failed: [10000] Authentication error",
    ]);
  });

  it("never records the Tunnel hostname for two deployments", () => {
    deploy(ctx, request("a-tunnel"));
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(
      `the hostname ${HOST} is recorded for the deployment cfo-stg-a-tunnel`,
    );
    teardown(ctx, "cfo-stg-a-tunnel");
    deploy(ctx, request("a", 7, withManifest("a")));
    expect(() => deploy(ctx, request("a-tunnel"))).toThrow(
      `the hostname ${HOST} is recorded for the deployment cfo-stg-a`,
    );
  });

  it("never records one VPC service for two deployments whose names nest", () => {
    // cfo-stg-a's X_VPC and cfo-stg-a-x's VPC are both cfo-stg-a-x-vpc. Recorded, not created:
    const nested = { tunnel: { tokenSecret: "T" }, vpcServices: [{ binding: "X_VPC", port: 1 }] };
    cloud.crashAfter = "tunnel.create";
    expect(() => deploy(ctx, request("a", 7, withManifest("a", nested)))).toThrow(ProcessLost);
    restart();
    expect(cloud.vpc.size).toBe(0);
    const inner = { tunnel: { tokenSecret: "T" }, vpcServices: [{ binding: "VPC", port: 1 }] };
    expect(() => deploy(ctx, request("a-x", 7, withManifest("a-x", inner)))).toThrow(
      "Workers VPC service cfo-stg-a-x-vpc is recorded for the deployment cfo-stg-a",
    );
    expect(record("cfo-stg-a-x")).toBeUndefined();
  });
});

describe("review r1, finding 6: creates whose effect shows up late", () => {
  const POINTS = [
    "access.create cfo-stg-a ",
    "access.create cfo-stg-a-tunnel",
    "tunnel.create",
    "dns.create",
    "vpc.create",
  ];
  const everything = () => cloud.tunnelResources() + cloud.apps.size + cloud.workers.size;
  // The Worker's application is created first, so its prefix catches it before the Tunnel's.
  const slept = () => cloud.calls.filter((c) => c.startsWith("sleep")).length;

  it.each(POINTS.flatMap((point) => [[point, true] as const, [point, false] as const]))(
    "a rerun waits for %s that lands late (process died: %s), adopts it and creates no other",
    (point, die) => {
      const path = withManifest("a");
      cloud.lateCreate = { prefix: point.trim(), delay: SETTLE / 2, die };
      expect(() => deploy(ctx, request("a", 7, path))).toThrow(die ? ProcessLost : "no answer");
      restart();
      expect(cloud.lateEffects).toHaveLength(1);
      cloud.calls.length = 0;
      deploy(ctx, request("a", 7, path));
      expect(slept()).toBe(1);
      expect([cloud.apps.size, cloud.tunnels_.size, cloud.dns.size, cloud.vpc.size]).toEqual([
        2, 1, 1, 1,
      ]);
      expect(record()?.state).toBe("deployed");
      expect(JSON.stringify(record())).not.toContain("StartedAt");
      teardown(ctx, "cfo-stg-a");
      elapse(SETTLE);
      cloud.tick();
      expect(everything()).toBe(0);
      expect(cloud.violations).toEqual([]);
    },
  );

  it.each(POINTS.map((point) => [point]))(
    "a teardown waits for %s that lands late, then removes it with the rest",
    (point) => {
      cloud.lateCreate = { prefix: point.trim(), delay: SETTLE - 1_000, die: true };
      expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
      restart();
      teardown(ctx, "cfo-stg-a");
      expect(store.load()).toEqual([]);
      // Nothing the interrupted run started can land after the record is gone.
      elapse(SETTLE);
      cloud.tick();
      expect(everything()).toBe(0);
      expect(cloud.violations).toEqual([]);
    },
  );

  it("waits once for a create that never lands, then creates afresh", () => {
    const path = withManifest("a");
    cloud.createTunnel = function (this: FakeCloud) {
      this.calls.push("tunnel.create (refused)");
      throw new Error("cf tunnels failed: [1000]");
    };
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("[1000]");
    expect(record()?.tunnel?.createStartedAt).toBeDefined();
    delete (cloud as Partial<FakeCloud>).createTunnel;
    cloud.calls.length = 0;
    deploy(ctx, request("a", 7, path));
    expect(slept()).toBe(1);
    expect(cloud.tunnels_.size).toBe(1);
    expect(record()?.tunnel?.createStartedAt).toBeUndefined();
  });

  it("a teardown that waited for an interrupted upload does not wait again", () => {
    cloud.lateCreate = { prefix: "vpc.create", delay: SETTLE - 1_000, die: true };
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
    restart();
    // The record also shows an interrupted upload, as if one had been started.
    const current = record();
    if (!current) throw new Error("missing record");
    store.update((all) =>
      all.map((d) => ({ ...d, uploadStartedAt: new Date(clock).toISOString() })),
    );
    cloud.calls.length = 0;
    teardown(ctx, "cfo-stg-a");
    expect(slept()).toBe(1);
    expect(everything()).toBe(0);
  });

  it("refuses to adopt a late resource that is not what it started to create", () => {
    cloud.lateCreate = { prefix: "dns.create", delay: 1_000, die: true };
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
    restart();
    elapse(2_000);
    cloud.tick();
    const [id, dns] = [...cloud.dns][0] ?? [];
    if (!id || !dns) throw new Error("missing record");
    cloud.dns.set(id, { ...dns, content: "elsewhere.example.net" });
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow(
      "is not what this deployment started to create",
    );
    expect(record()?.state).toBe("deleting");
    expect(cloud.apps.size).toBe(2);
    expect(cloud.dns.has(id)).toBe(true);
  });

  it("keeps the record while a create intent cannot be resolved", () => {
    cloud.lateCreate = { prefix: "tunnel.create", delay: SETTLE / 2, die: true };
    expect(() => deploy(ctx, request("a", 7, withManifest("a")))).toThrow(ProcessLost);
    restart();
    cloud.tunnels = () => {
      throw new Error("cf tunnels failed: [10000]");
    };
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("[10000]");
    expect(record()?.tunnel?.createStartedAt).toBeDefined();
    expect(cloud.apps.size).toBe(2);
    delete (cloud as Partial<FakeCloud>).tunnels;
    teardown(ctx, "cfo-stg-a");
    elapse(SETTLE);
    cloud.tick();
    expect(everything()).toBe(0);
  });
});

describe("IR-002: only closed Wrangler configurations deploy", () => {
  const open: Record<string, Partial<DeployConfigView>> = {
    "workers.dev enabled": { effective: { workers_dev: true, preview_urls: false } },
    "workers.dev left to its default": { effective: { preview_urls: false } },
    "preview URLs enabled": { effective: { workers_dev: false, preview_urls: true } },
    "preview URLs left to their default": { effective: { workers_dev: false } },
    "a legacy route": {
      effective: { workers_dev: false, preview_urls: false, route: "x.example.com/*" },
    },
    "several routes": {
      effective: {
        workers_dev: false,
        preview_urls: false,
        routes: ["a.example.com/*", "b.example.com/*"],
      },
    },
    "an extra custom domain": {
      effective: {
        workers_dev: false,
        preview_urls: false,
        routes: [{ pattern: "other.example.com", custom_domain: true }],
      },
    },
    environments: { raw: { env: { x: { workers_dev: true } } } },
    "a selected environment": {
      effective: { workers_dev: false, preview_urls: false, targetEnvironment: "x" },
    },
    "a redirected config": { redirected: true },
    "another account": {
      effective: { ...GOOD.effective, account_id: "b".repeat(32) },
    },
    "an R2 bucket": {
      raw: { ...GOOD.raw, r2_buckets: [{ binding: "DATA", bucket_name: "non-staging-data" }] },
    },
    "a service binding": { raw: { ...GOOD.raw, services: [{ binding: "S", service: "prod" }] } },
    "a KV namespace": { raw: { ...GOOD.raw, kv_namespaces: [{ binding: "K", id: "x" }] } },
    "a container": {
      raw: { ...GOOD.raw, containers: [{ class_name: "C", image: "./Dockerfile" }] },
    },
    "a Durable Object in another Worker": {
      raw: {
        ...GOOD.raw,
        durable_objects: { bindings: [{ name: "D", class_name: "D", script_name: "prod" }] },
      },
    },
  };

  it.each(Object.entries(open))("refuses %s before any cloud call", (_, change) => {
    views["/w/open.jsonc"] = { ...GOOD, ...change, path: "/w/open.jsonc" };
    expect(() => deploy(ctx, request("a", 7, "/w/open.jsonc"))).toThrow("refusing Wrangler config");
    expect(cloud.calls).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("deploys the approved configuration, also with the staging account named", () => {
    views["/w/own.jsonc"] = {
      ...GOOD,
      path: "/w/own.jsonc",
      effective: { ...GOOD.effective, account_id: ACCOUNT },
    };
    expect(deploy(ctx, request("b", 7, "/w/own.jsonc")).state).toBe("deployed");
    expect(deploy(ctx, request()).state).toBe("deployed");
    expect(cloud.calls).toContain(`worker.deploy cfo-stg-a ${GOOD.path}`);
  });
});

describe("review r1, finding 1: Wrangler's --domain overrides, so the name and hostname must be ours", () => {
  const HOSTNAME = "cfo-stg-a.example.com";
  const uploaded = () => cloud.calls.some((c) => c.startsWith("worker.deploy"));

  it.each([
    [
      "a Worker of that name",
      () => cloud.workers.set("cfo-stg-a", "elsewhere.example.com"),
      "a Worker named cfo-stg-a exists but this deployment did not create it",
    ],
    [
      "a DNS record on the hostname",
      () =>
        cloud.dns.set("theirs", {
          id: "theirs",
          name: HOSTNAME,
          type: "A",
          content: "192.0.2.1",
          proxied: true,
        }),
      "has DNS records that Wrangler would replace",
    ],
    [
      "another Worker's custom domain on the hostname",
      () => cloud.otherDomains.push({ hostname: HOSTNAME, service: "production" }),
      `${HOSTNAME} is a custom domain of the Worker production`,
    ],
  ])("refuses a first deploy over %s, before recording anything", (_, arrange, message) => {
    arrange();
    expect(() => deploy(ctx, request())).toThrow(message);
    expect(store.load()).toEqual([]);
    expect(uploaded()).toBe(false);
    expect(cloud.calls.filter((c) => /\.(create|update|delete)/.test(c))).toEqual([]);
  });

  it("refuses a redeploy once the hostname is no longer this Worker's custom domain", () => {
    deploy(ctx, request());
    cloud.workers.set("cfo-stg-a", "elsewhere.example.com");
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request())).toThrow(`${HOSTNAME} is no longer a custom domain`);
    expect(uploaded()).toBe(false);
    cloud.workers.set("cfo-stg-a", HOSTNAME);
    cloud.otherDomains.push({ hostname: HOSTNAME, service: "production" });
    expect(() => deploy(ctx, request())).toThrow("custom domain of the Worker production");
  });

  it("checks again just before the upload", () => {
    const path = withResources("a");
    cloud.createBucket = function (this: FakeCloud, bucket: string) {
      this.buckets.add(bucket);
      this.dns.set("late", { id: "late", name: HOSTNAME, type: "A", content: "x", proxied: true });
    };
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("Wrangler would replace");
    expect(uploaded()).toBe(false);
    expect(record()?.uploadStartedAt).toBeUndefined();
  });

  // Review r2, finding 1a: Codex's reproduction.
  it("never deletes a Worker that appeared under the name before this deployment uploaded", () => {
    const path = withResources("a");
    cloud.createBucket = function (this: FakeCloud, bucket: string) {
      this.buckets.add(bucket);
      this.workers.set("cfo-stg-a", "elsewhere.example.com"); // someone else's, meanwhile
    };
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("did not create it");
    delete (cloud as Partial<FakeCloud>).createBucket;
    expect(record()).not.toHaveProperty("workerSince");
    cloud.calls.length = 0;
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("this deployment never uploaded one");
    expect(cloud.workers.get("cfo-stg-a")).toBe("elsewhere.example.com");
    expect(cloud.calls.filter((c) => /\.(delete|create|update)/.test(c))).toEqual([]);
    expect(record()?.state).toBe("pending");
    // Once that Worker is gone, the teardown removes what this deployment did create.
    cloud.workers.delete("cfo-stg-a");
    teardown(ctx, "cfo-stg-a");
    expect(cloud.apps.size + cloud.buckets.size).toBe(0);
  });

  it("owns the name from its first upload on, also after an interrupted one", () => {
    cloud.deployFault = "after-upload";
    expect(() => deploy(ctx, request())).toThrow("wrangler deploy");
    restart();
    expect(record()?.workerSince).toBe(new Date(T0).toISOString());
    // The Worker exists now, and its domain too: both are this deployment's.
    expect(deploy(ctx, request()).state).toBe("deployed");
    // A record from an earlier tool, deployed but without workerSince, owns its Worker too.
    store.update((all) => all.map(({ workerSince: _, ...d }) => d));
    elapse(HOUR);
    expect(deploy(ctx, request()).workerSince).toBe(new Date(clock).toISOString());
  });
});

describe("cross-script Durable Object bindings", () => {
  /** A UI Worker whose RunDO binding lives in the deployment `script`. */
  const boundTo = (script: string): string => {
    const path = `/w/ui-${script}.jsonc`;
    views[path] = {
      ...GOOD,
      path,
      raw: {
        ...GOOD.raw,
        durable_objects: {
          bindings: [{ name: "RUN", class_name: "RunDO", script_name: script }],
        },
      },
    };
    return path;
  };
  const deployedWorker = (name: string) =>
    cloud.calls.some((call) => call.startsWith(`worker.deploy ${name}`));

  it("deploys a Worker bound to another deployed deployment of the same owner", () => {
    deploy(ctx, request("x1-transport"));
    expect(deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport"))).state).toBe(
      "deployed",
    );
    expect(cloud.violations).toEqual([]);
  });

  it.each([
    ["a non-staging Worker", "production", "is not a staging deployment"],
    ["an unknown deployment", "cfo-stg-x1-missing", "has no record"],
  ])("refuses a binding to %s before any cloud call", (_, script, message) => {
    expect(() => deploy(ctx, request("x1-ui", 7, boundTo(script)))).toThrow(message);
    expect(cloud.calls).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("refuses a binding to another owner's deployment", () => {
    deploy(ctx, { ...request("x1-transport"), owner: "wp9.9" });
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")))).toThrow(
      "belongs to wp9.9",
    );
    expect(cloud.calls).toEqual([]);
  });

  it("refuses a binding to a deployment that is not deployed", () => {
    cloud.deployFault = "before-upload";
    expect(() => deploy(ctx, request("x1-transport"))).toThrow();
    restart();
    expect(record("cfo-stg-x1-transport")?.state).toBe("pending");
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")))).toThrow(
      "is pending, not deployed",
    );
    expect(deployedWorker("cfo-stg-x1-ui")).toBe(false);
  });

  it("checks the registry again under the lock, just before anything is created", () => {
    deploy(ctx, request("x1-transport"));
    cloud.calls.length = 0;
    // The bound deployment starts its teardown between the first check and the lock.
    ctx = {
      ...ctx,
      lock: (name) => {
        store.update((all) =>
          all.map((d) =>
            d.name === "cfo-stg-x1-transport" ? { ...d, state: "deleting" as const } : d,
          ),
        );
        return locks.lock(name);
      },
    };
    expect(() => deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")))).toThrow(
      "is deleting",
    );
    expect(cloud.calls).toEqual([]);
    expect(record("cfo-stg-x1-ui")).toBeUndefined();
  });

  // Review r1, finding 7.
  it("holds the bound deployment's lock through the upload", () => {
    deploy(ctx, request("x1-transport"));
    const taken: string[] = [];
    const lock = ctx.lock;
    ctx = {
      ...ctx,
      lock: (name) => {
        taken.push(name);
        return lock(name);
      },
    };
    cloud.duringUpload = () => {
      cloud.duringUpload = undefined;
      // Neither a teardown nor a redeploy of the bound deployment can run meanwhile.
      expect(() => teardown(ctx, "cfo-stg-x1-transport")).toThrow("busy");
      expect(() => deploy(ctx, request("x1-transport"))).toThrow("busy");
    };
    deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")));
    // Taken in sorted order, the bound deployment's with the deploying one's.
    expect(taken.slice(0, 2)).toEqual(["cfo-stg-x1-transport", "cfo-stg-x1-ui"]);
    expect(locks.held.size).toBe(0);
  });

  it("refuses a deploy while the bound deployment's lock is held, before any cloud call", () => {
    deploy(ctx, request("x1-transport"));
    const release = ctx.lock("cfo-stg-x1-transport");
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")))).toThrow("busy");
    expect(cloud.calls).toEqual([]);
    expect(locks.held.has("cfo-stg-x1-ui")).toBe(false);
    release();
  });

  it("records the dependency, and refuses to tear down a deployment another one binds", () => {
    deploy(ctx, request("x1-transport"));
    deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")));
    expect(record("cfo-stg-x1-ui")?.dependsOn).toEqual(["cfo-stg-x1-transport"]);
    cloud.calls.length = 0;
    expect(() => teardown(ctx, "cfo-stg-x1-transport")).toThrow(
      "cfo-stg-x1-transport is bound by cfo-stg-x1-ui",
    );
    expect(cloud.calls).toEqual([]);
    expect(record("cfo-stg-x1-transport")?.state).toBe("deployed");
    teardown(ctx, "cfo-stg-x1-ui");
    teardown(ctx, "cfo-stg-x1-transport");
    expect(store.load()).toEqual([]);
  });

  it("drops a dependency only after an upload without the binding succeeded", () => {
    deploy(ctx, request("x1-transport"));
    deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")));
    cloud.deployFault = "before-upload";
    expect(() => deploy(ctx, request("x1-ui"))).toThrow("wrangler deploy");
    restart();
    expect(record("cfo-stg-x1-ui")?.dependsOn).toEqual(["cfo-stg-x1-transport"]);
    deploy(ctx, request("x1-ui"));
    expect(record("cfo-stg-x1-ui")).not.toHaveProperty("dependsOn");
    teardown(ctx, "cfo-stg-x1-transport");
  });

  it("sweeps a bound deployment after the one that binds it", () => {
    deploy(ctx, request("x1-transport", 1));
    deploy(ctx, request("x1-ui", 1, boundTo("cfo-stg-x1-transport")));
    // The registry lists the bound deployment first.
    expect(store.load().map((d) => d.name)).toEqual(["cfo-stg-x1-transport", "cfo-stg-x1-ui"]);
    clock += 2 * DAY;
    expect(sweep(ctx, true)).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("reports a bound deployment that cannot go yet in a sweep", () => {
    deploy(ctx, request("x1-transport", 1));
    deploy(ctx, request("x1-ui", 7, boundTo("cfo-stg-x1-transport")));
    clock += 2 * DAY;
    expect(sweep(ctx, true)).toEqual([expect.stringContaining("is bound by cfo-stg-x1-ui")]);
    expect(record("cfo-stg-x1-transport")?.state).toBe("deployed");
  });
});

describe("Access applications the tool cannot vouch for", () => {
  const foreign = (overrides: Partial<AccessApp>): void => {
    cloud.apps.set("foreign", {
      id: "foreign",
      name: "cfo-stg-a",
      domain: "cfo-stg-a.example.com",
      type: "self_hosted",
      policies: [{ decision: "allow", include: [{ email: { email: OWNER } }] }],
      ...overrides,
    });
  };
  const deployedWorker = () => cloud.calls.some((call) => call.startsWith("worker.deploy"));

  it("refuses an application on the hostname with another name, before recording anything", () => {
    foreign({ name: "someone-else" });
    expect(() => deploy(ctx, request())).toThrow("this deployment did not create");
    expect(deployedWorker()).toBe(false);
    expect(store.load()).toEqual([]);
    expect(() => teardown(ctx, "cfo-stg-a")).toThrow("no recorded deployment");
    expect(cloud.apps.has("foreign")).toBe(true);
  });

  // Review r1, finding 2: a name alone proves nothing. Owner-only or not, an application the
  // tool did not record is never adopted, rewritten or deleted.
  it.each([
    ["an owner-only policy", {}],
    ["a bypass policy", { policies: [{ decision: "bypass", include: [{ everyone: {} }] }] }],
    ["an everyone rule", { policies: [{ decision: "allow", include: [{ everyone: {} }] }] }],
    ["no policies", { policies: [] }],
  ])("refuses a same-named application with %s and leaves it alone", (_, overrides) => {
    foreign({ same_site_cookie_attribute: "none", ...overrides });
    const before = cloud.apps.get("foreign");
    expect(() => deploy(ctx, request())).toThrow("this deployment did not create");
    expect(deployedWorker()).toBe(false);
    expect(cloud.calls.filter((c) => /^access\.(create|update|delete)/.test(c))).toEqual([]);
    expect(cloud.apps.get("foreign")).toEqual(before);
    expect(store.load()).toEqual([]);
  });

  it("refuses an application that appears under a recorded hostname without an intent", () => {
    deploy(ctx, request());
    teardown(ctx, "cfo-stg-a");
    // Recorded, then gone, then someone else's appears: a redeploy records nothing of it.
    deploy(ctx, request("b"));
    const app = cloud.apps.get("app-2");
    if (!app) throw new Error("missing app");
    cloud.apps.delete("app-2");
    cloud.apps.set("theirs", { ...app, id: "theirs" });
    expect(() => deploy(ctx, request("b"))).toThrow("did not record");
    expect(() => teardown(ctx, "cfo-stg-b")).not.toThrow();
    expect(cloud.apps.has("theirs")).toBe(true);
  });

  it("refuses to redeploy behind a recorded application whose policy was widened", () => {
    deploy(ctx, request());
    const app = cloud.apps.get("app-1");
    if (!app) throw new Error("missing app");
    cloud.apps.set("app-1", {
      ...app,
      policies: [{ decision: "allow", include: [{ everyone: {} }] }],
    });
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request())).toThrow("not owner-only");
    expect(deployedWorker()).toBe(false);
  });

  it("refuses another owner's deployment", () => {
    deploy(ctx, request());
    expect(() => deploy(ctx, { ...request(), owner: "wp9.9" })).toThrow("belongs to wp0.4");
  });

  it("refuses to deploy a recorded name to a different zone", () => {
    deploy(ctx, request());
    const moved: Context = { ...ctx, config: { ...config, zone: "example.org" } };
    expect(() => deploy(moved, request())).toThrow("tear it down first");
  });
});

describe("plan change 18: SameSite on Access (D9), and a push after teardown (DC-36)", () => {
  const deployedWorker = () => cloud.calls.some((call) => call.startsWith("worker.deploy"));

  it("creates the Access application with SameSite=lax", () => {
    deploy(ctx, request());
    expect(cloud.apps.get("app-1")?.same_site_cookie_attribute).toBe("lax");
  });

  it("rewrites an application from an older tool before the Worker upload", () => {
    deploy(ctx, request());
    const app = cloud.apps.get("app-1");
    if (!app) throw new Error("missing app");
    const { same_site_cookie_attribute: _, ...older } = app;
    cloud.apps.set("app-1", older);
    cloud.calls.length = 0;
    deploy(ctx, request());
    expect(cloud.apps.get("app-1")?.same_site_cookie_attribute).toBe("lax");
    const update = cloud.calls.indexOf("access.update cfo-stg-a");
    expect(update).toBeGreaterThan(-1);
    expect(update).toBeLessThan(cloud.calls.findIndex((c) => c.startsWith("worker.deploy")));
    expect(cloud.violations).toEqual([]);
  });

  it("refuses to upload when Access does not hold SameSite=lax after writing it", () => {
    deploy(ctx, request());
    const app = cloud.apps.get("app-1");
    if (!app) throw new Error("missing app");
    cloud.apps.set("app-1", { ...app, same_site_cookie_attribute: "none" });
    cloud.accessUpdateKeeps = true;
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request())).toThrow("does not set SameSite=lax");
    expect(deployedWorker()).toBe(false);
  });

  it("refuses to upload when the read-back shows SameSite=lax but a widened policy", () => {
    deploy(ctx, request());
    const app = cloud.apps.get("app-1");
    if (!app) throw new Error("missing app");
    const { same_site_cookie_attribute: _, ...older } = app;
    cloud.apps.set("app-1", older);
    cloud.accessUpdateWidens = true;
    cloud.calls.length = 0;
    expect(() => deploy(ctx, request())).toThrow("not owner-only");
    expect(deployedWorker()).toBe(false);
  });

  it("refuses to upload when the written application cannot be read back", () => {
    cloud.hideAccessApps = true;
    expect(() => deploy(ctx, request())).toThrow("no Access application after writing one");
    expect(deployedWorker()).toBe(false);
  });

  it("builds with the record's creation time as the image timestamp", () => {
    deploy(ctx, request("a", 7, withResources("a")));
    const createdAt = store.load()[0]?.createdAt ?? "";
    expect(cloud.epochs).toEqual([Math.floor(Date.parse(createdAt) / 1000)]);
  });

  it("rebuilds identical images on a redeploy, so no container rollout starts", () => {
    const path = withResources("a");
    deploy(ctx, request("a", 7, path));
    elapse(HOUR);
    deploy(ctx, request("a", 7, path));
    expect(cloud.epochs[0]).toBe(cloud.epochs[1]);
    expect(cloud.images.size).toBe(1);
    expect(cloud.rollouts).toEqual([]);
    expect(cloud.violations).toEqual([]);
  });

  it("pushes the images again when a deployment is redeployed after a teardown", () => {
    const path = withResources("a");
    deploy(ctx, request("a", 7, path));
    teardown(ctx, "cfo-stg-a");
    expect(cloud.images.size).toBe(0);
    // The registry still answers for the deleted image's digest, as on Cloudflare.
    expect(cloud.answered.size).toBe(1);
    elapse(HOUR);
    deploy(ctx, request("a", 7, path));
    expect(cloud.workers.has("cfo-stg-a")).toBe(true);
    expect(cloud.images.size).toBe(1);
    expect(cloud.epochs[1]).toBeGreaterThan(cloud.epochs[0] ?? Number.POSITIVE_INFINITY);
    expect(cloud.violations).toEqual([]);
  });

  it("relies on the new record being created in a later second than the old one", () => {
    const path = withResources("a");
    deploy(ctx, request("a", 7, path));
    teardown(ctx, "cfo-stg-a");
    // No time passes: the new record has the old creation second, so the digest is the old one.
    expect(() => deploy(ctx, request("a", 7, path))).toThrow("IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE");
  });
});

describe("model check: no Worker is ever reachable without its Access application", () => {
  const suffix = fc.constantFrom("a", "b");
  const operation = fc.oneof(
    fc.record({
      kind: fc.constant("deploy" as const),
      suffix,
      days: fc.integer({ min: 1, max: 30 }),
      fault: fc.constantFrom<DeployFault>(
        "none",
        "before-upload",
        "after-upload",
        "crash-after-access",
        "crash-after-upload",
        "lost-response",
        "phantom-success",
      ),
      lateDelay: fc.integer({ min: 0, max: SETTLE }),
      resources: fc.boolean(),
      manifest: fc.boolean(),
      // The process dies right after one of the manifest's creations.
      crash: fc.constantFrom(
        "none",
        "tunnel-app",
        "tunnel.create",
        "tunnel.put",
        "dns.create",
        "vpc.create",
      ),
      // One create takes effect late, and its caller dies or hears nothing.
      late: fc.constantFrom("none", "access.create", "tunnel.create", "dns.create", "vpc.create"),
      lateCreateDelay: fc.integer({ min: 0, max: SETTLE - 1 }),
      lateDies: fc.boolean(),
      // b's Worker binds a's Durable Objects.
      binds: fc.boolean(),
      overlap: fc.constantFrom("none", "teardown", "sweep"),
    }),
    fc.record({
      kind: fc.constant("teardown" as const),
      suffix,
      mode: fc.constantFrom<DeleteMode>("ok", "fails-after-delete", "fails", "silently-keeps"),
      unknown: fc.boolean(),
      lookupDelay: fc.integer({ min: 0, max: 2 * SETTLE }),
      wallJump: fc.integer({ min: 0, max: 30 * 60_000 }),
      bucketFails: fc.boolean(),
      containerKeeps: fc.boolean(),
      tunnelKeeps: fc.boolean(),
      crash: fc.constantFrom("none", "vpc.delete", "dns.delete", "tunnel.delete"),
    }),
    fc.record({
      kind: fc.constant("sweep" as const),
      hours: fc.integer({ min: 0, max: 40 * 24 }),
      mode: fc.constantFrom<DeleteMode>("ok", "fails-after-delete", "fails", "silently-keeps"),
      lookupDelay: fc.integer({ min: 0, max: 2 * SETTLE }),
    }),
    // Time passes between commands; a lost upload may land meanwhile.
    fc.record({ kind: fc.constant("wait" as const), ms: fc.integer({ min: 0, max: 2 * SETTLE }) }),
  );

  it("holds across any sequence of deploys, failures, crashes, teardowns and sweeps", () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 25 }), (operations) => {
        ctx = newContext();
        for (const op of operations) {
          try {
            if (op.kind === "deploy") {
              cloud.deployFault = op.fault;
              cloud.lateDelay = op.lateDelay;
              // Another command runs while the upload is in flight.
              cloud.duringUpload = () => {
                cloud.duringUpload = undefined;
                try {
                  if (op.overlap === "teardown") teardown(ctx, `cfo-stg-${op.suffix}`);
                  if (op.overlap === "sweep") sweep(ctx, true);
                } catch {
                  // Refused or failed; the invariants decide whether that was safe.
                }
              };
              const crash =
                op.crash === "tunnel-app" ? `access.create cfo-stg-${op.suffix}-tunnel` : op.crash;
              cloud.crashAfter = op.crash === "none" ? undefined : crash;
              cloud.lateCreate =
                op.late === "none"
                  ? undefined
                  : { prefix: op.late, delay: op.lateCreateDelay, die: op.lateDies };
              const path =
                op.binds && op.suffix === "b"
                  ? withBinding("b", "cfo-stg-a")
                  : op.manifest
                    ? withManifest(op.suffix, TUNNEL_MANIFEST, op.resources)
                    : op.resources
                      ? withResources(op.suffix)
                      : GOOD.path;
              deploy(ctx, request(op.suffix, op.days, path));
            } else if (op.kind === "teardown") {
              clock += op.wallJump; // the wall clock only
              cloud.deleteModes.set(`cfo-stg-${op.suffix}`, op.mode);
              cloud.lookupUnknown = op.unknown;
              cloud.lookupDelay = op.lookupDelay;
              cloud.bucketDeleteFails = op.bucketFails;
              cloud.containerDeleteKeeps = op.containerKeeps;
              cloud.tunnelDeleteKeeps = op.tunnelKeeps;
              cloud.crashAfter = op.crash === "none" ? undefined : op.crash;
              teardown(ctx, `cfo-stg-${op.suffix}`);
            } else if (op.kind === "sweep") {
              elapse(op.hours * HOUR);
              for (const name of ["cfo-stg-a", "cfo-stg-b"]) cloud.deleteModes.set(name, op.mode);
              cloud.lookupDelay = op.lookupDelay;
              sweep(ctx, true);
            } else {
              elapse(op.ms);
              cloud.tick();
            }
          } catch {
            // Refusals and injected failures are expected; the invariants below are not.
          }
          restart();
          expect(cloud.violations).toEqual([]);
          // Nothing exists in the cloud without a record to clean it up.
          const recorded = new Set(store.load().map((d) => d.name));
          const appNames = new Set(
            store
              .load()
              .flatMap((d) => [d.name, ...(d.tunnel?.hostname ? [`${d.name}-tunnel`] : [])]),
          );
          for (const name of cloud.workers.keys()) expect(recorded.has(name)).toBe(true);
          for (const app of cloud.apps.values()) expect(appNames.has(app.name)).toBe(true);
          expect(cloud.unrecorded(store.load())).toEqual([]);
          // Nothing a record depends on is gone from the registry.
          for (const d of store.load()) {
            for (const target of d.dependsOn ?? []) expect(recorded.has(target)).toBe(true);
          }
        }
        // With the faults gone, teardown finishes and leaves nothing behind. An interrupted
        // upload that lands during the settle wait costs one more attempt.
        // A deployment that another one binds goes after it.
        const order = store
          .load()
          .sort((x, y) => Number(x.dependsOn === undefined) - Number(y.dependsOn === undefined));
        for (const d of order) {
          for (let attempt = 1; record(d.name); attempt++) {
            try {
              teardown(ctx, d.name);
            } catch (error) {
              if (attempt >= 2) throw error;
            }
          }
        }
        expect(cloud.violations).toEqual([]);
        expect(store.load()).toEqual([]);
        expect(cloud.workers.size + cloud.apps.size).toBe(0);
        // Every lost upload and late create has had its time; none may land after the cleanup.
        elapse(SETTLE);
        cloud.tick();
        expect(cloud.workers.size + cloud.apps.size).toBe(0);
        expect(cloud.lateEffects).toEqual([]);
        expect(cloud.buckets.size + cloud.containerApps_.size + cloud.images.size).toBe(0);
        expect(cloud.tunnelResources()).toBe(0);
        expect(cloud.violations).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
