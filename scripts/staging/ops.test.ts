import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccessApp,
  type DeployConfigView,
  type Deployment,
  declaredResources,
  parseRegistry,
  serializeRegistry,
} from "./guard.ts";
import { type Cloud, type Context, deploy, type Store, sweep, teardown } from "./ops.ts";

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
  /** The build epoch of every upload. */
  readonly epochs: number[] = [];
  /** The version of the image sources; a change gives new digests. */
  sources = 1;
  /** An Access update that reports success but changes nothing. */
  accessUpdateKeeps = false;
  /** An Access update that sets SameSite but leaves a policy open to everyone. */
  accessUpdateWidens = false;
  /** Listings that no longer show an application, as if it were deleted meanwhile. */
  hideAccessApps = false;
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

  private check(): void {
    for (const [name, hostname] of this.workers) {
      const protectedByOwner = [...this.apps.values()].some(
        (app) =>
          app.domain === hostname &&
          app.policies?.every(
            (p) =>
              p.decision === "allow" &&
              JSON.stringify(p.include) === JSON.stringify([{ email: { email: OWNER } }]),
          ),
      );
      if (!protectedByOwner) this.violations.push(`${name} reachable without Access`);
    }
  }

  /** Lands every lost upload whose time has come. Every call to Cloudflare passes through. */
  tick(): void {
    for (const late of [...this.lateUploads]) {
      if (late.landAt > real) continue;
      this.lateUploads.splice(this.lateUploads.indexOf(late), 1);
      this.workers.set(late.name, late.hostname);
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
    this.apps.set(id, { ...(body as unknown as AccessApp), id });
    this.calls.push(`access.create ${String(body.name)}`);
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
  deployWorker(name: string, hostname: string, configPath: string, buildEpoch: number): void {
    this.tick();
    this.calls.push(`worker.deploy ${name} ${configPath}`);
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
  /** Every bucket, container application and image is recorded for some deployment. */
  unrecorded(deployments: readonly Deployment[]): string[] {
    const containers = new Set(deployments.flatMap((d) => d.containers ?? []));
    const buckets = new Set(deployments.flatMap((d) => d.buckets ?? []));
    const repositories = new Set([
      ...containers,
      ...deployments.flatMap((d) => d.repositories ?? []),
    ]);
    return [
      ...[...this.buckets].filter((b) => !buckets.has(b)),
      ...[...this.containerApps_.values()].filter((c) => !containers.has(c)),
      ...[...this.images].filter((i) => !repositories.has(i.slice(0, i.lastIndexOf(":")))),
    ];
  }
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
let locks: FakeLocks;
let ctx: Context;
const SETTLE = 60_000;

function newContext(): Context {
  store = new FakeStore();
  cloud = new FakeCloud(store);
  locks = new FakeLocks();
  clock = T0;
  real = 0;
  return {
    config,
    cloud,
    store,
    readConfig: (path) => {
      const view = views[path];
      if (!view) throw new Error(`no config at ${path}`);
      return view;
    },
    lock: (name) => locks.lock(name),
    sleep: (ms) => {
      elapse(ms);
      cloud.calls.push(`sleep ${ms}`);
      cloud.tick();
    },
    settleMs: SETTLE,
    now: () => new Date(clock),
    log: () => {},
  };
}

beforeEach(() => {
  views = { [GOOD.path]: GOOD };
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
    expect(cloud.calls).toEqual([]);
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

  it("refuses an application on the hostname with another name, and teardown leaves it alone", () => {
    foreign({ name: "someone-else" });
    expect(() => deploy(ctx, request())).toThrow("did not record");
    expect(deployedWorker()).toBe(false);
    teardown(ctx, "cfo-stg-a");
    expect(cloud.apps.has("foreign")).toBe(true);
    expect(store.load()).toEqual([]);
  });

  it.each([
    ["a bypass policy", { policies: [{ decision: "bypass", include: [{ everyone: {} }] }] }],
    ["an everyone rule", { policies: [{ decision: "allow", include: [{ everyone: {} }] }] }],
    ["no policies", { policies: [] }],
  ])("refuses a same-named application with %s", (_, overrides) => {
    foreign(overrides);
    expect(() => deploy(ctx, request())).toThrow("not owner-only");
    expect(deployedWorker()).toBe(false);
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
              const path = op.resources ? withResources(op.suffix) : GOOD.path;
              deploy(ctx, request(op.suffix, op.days, path));
            } else if (op.kind === "teardown") {
              clock += op.wallJump; // the wall clock only
              cloud.deleteModes.set(`cfo-stg-${op.suffix}`, op.mode);
              cloud.lookupUnknown = op.unknown;
              cloud.lookupDelay = op.lookupDelay;
              cloud.bucketDeleteFails = op.bucketFails;
              cloud.containerDeleteKeeps = op.containerKeeps;
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
          for (const name of cloud.workers.keys()) expect(recorded.has(name)).toBe(true);
          for (const app of cloud.apps.values()) expect(recorded.has(app.name)).toBe(true);
          expect(cloud.unrecorded(store.load())).toEqual([]);
        }
        // With the faults gone, teardown finishes and leaves nothing behind. An interrupted
        // upload that lands during the settle wait costs one more attempt.
        for (const d of store.load()) {
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
        // Every lost upload has had its time; none may land after the cleanup.
        elapse(SETTLE);
        cloud.tick();
        expect(cloud.workers.size).toBe(0);
        expect(cloud.buckets.size + cloud.containerApps_.size + cloud.images.size).toBe(0);
        expect(cloud.violations).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});
