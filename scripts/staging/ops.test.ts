import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AccessApp,
  type DeployConfigView,
  type Deployment,
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
  save(deployments: readonly Deployment[]): void {
    if (!this.frozen) this.text = serializeRegistry(deployments);
  }
}

type DeployFault =
  | "none"
  | "before-upload"
  | "after-upload"
  | "crash-after-access"
  | "crash-after-upload";
type DeleteMode = "ok" | "fails-after-delete" | "fails" | "silently-keeps";

/**
 * Cloudflare as the staging tool sees it. Records every call, and records a violation whenever
 * a Worker exists without an owner-only Access application on its hostname.
 */
class FakeCloud implements Cloud {
  readonly calls: string[] = [];
  readonly violations: string[] = [];
  readonly apps = new Map<string, AccessApp>();
  readonly workers = new Map<string, string>(); // name -> hostname
  deployFault: DeployFault = "none";
  readonly deleteModes = new Map<string, DeleteMode>();
  lookupUnknown = false;
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

  accountIds(): string[] {
    this.calls.push("accounts");
    return [ACCOUNT];
  }
  listAccessApps(hostname: string): AccessApp[] {
    this.calls.push("access.list");
    return [...this.apps.values()].filter((app) => app.domain === hostname);
  }
  createAccessApp(body: Record<string, unknown>): string {
    const id = `app-${this.nextId++}`;
    this.apps.set(id, { ...(body as unknown as AccessApp), id });
    this.calls.push(`access.create ${String(body.name)}`);
    if (this.deployFault === "crash-after-access") this.die();
    return id;
  }
  deleteAccessApp(id: string): void {
    this.calls.push(`access.delete ${this.apps.get(id)?.name}`);
    this.apps.delete(id);
    this.check();
  }
  workerExists(name: string): boolean {
    this.calls.push("worker.exists");
    if (this.lookupUnknown) throw new Error("could not tell whether the Worker exists");
    return this.workers.has(name);
  }
  deployWorker(name: string, hostname: string, configPath: string): void {
    this.calls.push(`worker.deploy ${name} ${configPath}`);
    if (this.deployFault === "before-upload") throw new Error("wrangler deploy exited with 1");
    this.workers.set(name, hostname);
    this.check();
    if (this.deployFault === "after-upload") throw new Error("wrangler deploy exited with 1");
    if (this.deployFault === "crash-after-upload") this.die();
  }
  deleteWorker(name: string): void {
    this.calls.push(`worker.delete ${name}`);
    const mode = this.deleteModes.get(name) ?? "ok";
    if (mode === "ok" || mode === "fails-after-delete") this.workers.delete(name);
    if (mode === "fails" || mode === "fails-after-delete") {
      throw new Error("wrangler delete exited with 1");
    }
  }
}

const GOOD: DeployConfigView = {
  path: "/w/wrangler.jsonc",
  redirected: false,
  raw: { name: "x", workers_dev: false, preview_urls: false },
  effective: { workers_dev: false, preview_urls: false },
};

let store: FakeStore;
let cloud: FakeCloud;
let clock: number;
let views: Record<string, DeployConfigView>;
let ctx: Context;

beforeEach(() => {
  store = new FakeStore();
  cloud = new FakeCloud(store);
  clock = T0;
  views = { [GOOD.path]: GOOD };
  ctx = {
    config,
    cloud,
    store,
    readConfig: (path) => {
      const view = views[path];
      if (!view) throw new Error(`no config at ${path}`);
      return view;
    },
    now: () => new Date(clock),
    log: () => {},
  };
});

/** A new process: the store is readable again and the injected faults are gone. */
function restart(): void {
  store.frozen = false;
  cloud.deployFault = "none";
  cloud.deleteModes.clear();
  cloud.lookupUnknown = false;
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
  };

  it.each(Object.entries(open))("refuses %s before any cloud call", (_, change) => {
    views["/w/open.jsonc"] = { ...GOOD, ...change, path: "/w/open.jsonc" };
    expect(() => deploy(ctx, request("a", 7, "/w/open.jsonc"))).toThrow("refusing Wrangler config");
    expect(cloud.calls).toEqual([]);
    expect(store.load()).toEqual([]);
  });

  it("deploys the approved configuration", () => {
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
      ),
    }),
    fc.record({
      kind: fc.constant("teardown" as const),
      suffix,
      mode: fc.constantFrom<DeleteMode>("ok", "fails-after-delete", "fails", "silently-keeps"),
      unknown: fc.boolean(),
    }),
    fc.record({
      kind: fc.constant("sweep" as const),
      hours: fc.integer({ min: 0, max: 40 * 24 }),
      mode: fc.constantFrom<DeleteMode>("ok", "fails-after-delete", "fails", "silently-keeps"),
    }),
  );

  it("holds across any sequence of deploys, failures, crashes, teardowns and sweeps", () => {
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 25 }), (operations) => {
        store = new FakeStore();
        cloud = new FakeCloud(store);
        ctx = { ...ctx, cloud, store };
        clock = T0;
        for (const op of operations) {
          try {
            if (op.kind === "deploy") {
              cloud.deployFault = op.fault;
              deploy(ctx, request(op.suffix, op.days));
            } else if (op.kind === "teardown") {
              cloud.deleteModes.set(`cfo-stg-${op.suffix}`, op.mode);
              cloud.lookupUnknown = op.unknown;
              teardown(ctx, `cfo-stg-${op.suffix}`);
            } else {
              clock += op.hours * HOUR;
              for (const name of ["cfo-stg-a", "cfo-stg-b"]) cloud.deleteModes.set(name, op.mode);
              sweep(ctx, true);
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
        }
        // With the faults gone, teardown always finishes and leaves nothing behind.
        for (const d of store.load()) teardown(ctx, d.name);
        expect(store.load()).toEqual([]);
        expect(cloud.workers.size + cloud.apps.size).toBe(0);
      }),
      { numRuns: 300 },
    );
  });
});
