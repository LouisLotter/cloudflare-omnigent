import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccessApp,
  ALLOWED_CONFIG_KEYS,
  accessAppBody,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  assertSameSite,
  claimAccessApp,
  type DeployConfigView,
  type Deployment,
  declaredResources,
  expired,
  expiry,
  hostnameFor,
  markInterrupted,
  ownedBy,
  parseRegistry,
  policyRepository,
  resourceName,
  serializeRegistry,
  validateDeployConfig,
} from "./guard.ts";

const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "owner@example.com" };

describe("staging guard", () => {
  it("names resources with the prefix and rejects bad suffixes", () => {
    expect(resourceName("m0-hello")).toBe("cfo-stg-m0-hello");
    for (const bad of ["", "-x", "x-", "X", "a_b", "a--b", "a.b", "a/b", "x".repeat(60)]) {
      expect(() => resourceName(bad)).toThrow();
    }
  });

  it("refuses to touch anything without the prefix", () => {
    for (const name of ["inyanda", "agents", "cfo-stg-", "cfo-prod-x", "Cfo-stg-x"]) {
      expect(() => assertManaged(name)).toThrow();
    }
    expect(() => assertManaged("cfo-stg-x")).not.toThrow();
  });

  it("never produces an unmanaged name from any suffix", () => {
    fc.assert(
      fc.property(fc.string(), (suffix) => {
        try {
          const name = resourceName(suffix);
          expect(name.startsWith("cfo-stg-")).toBe(true);
          expect(() => assertManaged(name)).not.toThrow();
        } catch {
          // rejected suffixes are fine
        }
      }),
    );
  });

  it("builds hostnames only for managed names", () => {
    expect(hostnameFor("cfo-stg-x", "example.com")).toBe("cfo-stg-x.example.com");
    expect(() => hostnameFor("agents", "example.com")).toThrow();
    expect(() => hostnameFor("cfo-stg-x", "not a zone")).toThrow();
  });

  it("requires the configured account to be accessible", () => {
    expect(() => assertAccount("a".repeat(32), ["a".repeat(32)])).not.toThrow();
    expect(() => assertAccount("a".repeat(32), ["b".repeat(32)])).toThrow();
    expect(() => assertAccount("not-an-id", ["not-an-id"])).toThrow();
  });

  it("bounds lifetimes and finds expired resources", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    expect(expiry(now, 7)).toBe("2026-10-25T12:00:00.000Z");
    expect(() => expiry(now, 0)).toThrow();
    expect(() => expiry(now, 31)).toThrow();
    const make = (name: string, expiresAt: string): Deployment => ({
      name,
      hostname: `${name}.example.com`,
      owner: "wp0.4",
      createdAt: now.toISOString(),
      expiresAt,
      state: "deployed",
    });
    const list = [
      make("cfo-stg-old", "2026-10-18T11:59:59Z"),
      make("cfo-stg-new", "2026-10-19T00:00:00Z"),
    ];
    expect(expired(list, now).map((r) => r.name)).toEqual(["cfo-stg-old"]);
  });

  it("builds an owner-only Access application for the exact hostname", () => {
    const body = accessAppBody("cfo-stg-a", "cfo-stg-a.example.com", config);
    expect(body).toMatchObject({
      type: "self_hosted",
      name: "cfo-stg-a",
      domain: "cfo-stg-a.example.com",
      same_site_cookie_attribute: "lax",
      policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }],
    });
    expect(() => accessAppBody("cfo-stg-a", "cfo-stg-b.example.com", config)).toThrow();
    expect(() => accessAppBody("agents", "agents.example.com", config)).toThrow();
  });
});

const deployment: Deployment = {
  name: "cfo-stg-a",
  hostname: "cfo-stg-a.example.com",
  owner: "wp0.4",
  createdAt: "2026-10-18T12:00:00.000Z",
  expiresAt: "2026-10-25T12:00:00.000Z",
  state: "pending",
};

const app = (overrides: Partial<AccessApp> = {}): AccessApp => ({
  id: "app-1",
  name: "cfo-stg-a",
  domain: "cfo-stg-a.example.com",
  type: "self_hosted",
  policies: [{ decision: "allow", include: [{ email: { email: "owner@example.com" } }] }],
  ...overrides,
});

describe("Wrangler configuration check", () => {
  const ACCOUNT = config.accountId;
  const NAME = "cfo-stg-a";
  const closed: DeployConfigView = {
    path: "/w/wrangler.jsonc",
    redirected: false,
    raw: { workers_dev: false, preview_urls: false },
    effective: { workers_dev: false, preview_urls: false },
  };
  const effective = (extra: Record<string, unknown>) => ({
    ...closed,
    effective: { ...closed.effective, ...extra },
  });
  const raw = (extra: Record<string, unknown>) => ({ ...closed, raw: { ...closed.raw, ...extra } });

  it("accepts a configuration with alternate URLs off, no routes, and only managed keys", () => {
    expect(() => validateDeployConfig(closed, ACCOUNT, NAME)).not.toThrow();
    expect(() => validateDeployConfig(effective({ routes: [] }), ACCOUNT, NAME)).not.toThrow();
    expect(() =>
      validateDeployConfig(effective({ account_id: ACCOUNT }), ACCOUNT, NAME),
    ).not.toThrow();
    const everyKey = Object.fromEntries(
      ALLOWED_CONFIG_KEYS.map((key) => [
        key,
        key === "containers" || key === "r2_buckets" ? [] : null,
      ]),
    );
    expect(() =>
      validateDeployConfig({ ...closed, raw: { ...everyKey, ...closed.raw } }, ACCOUNT, NAME),
    ).not.toThrow();
    expect(() =>
      validateDeployConfig(
        raw({ durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] } }),
        ACCOUNT,
        NAME,
      ),
    ).not.toThrow();
  });

  it("refuses anything that could open a route the Access application does not cover", () => {
    for (const view of [
      effective({ workers_dev: true }),
      effective({ workers_dev: undefined }),
      effective({ workers_dev: "false" }),
      effective({ preview_urls: true }),
      effective({ preview_urls: undefined }),
      effective({ route: "x.example.com/*" }),
      effective({ routes: ["x.example.com/*"] }),
      effective({ routes: [{ pattern: "x.example.com", custom_domain: true }] }),
      effective({ routes: "x.example.com/*" }),
      effective({ targetEnvironment: "staging" }),
      { ...closed, raw: { env: {} } },
      { ...closed, redirected: true },
    ]) {
      expect(() => validateDeployConfig(view, ACCOUNT, NAME)).toThrow("refusing Wrangler config");
    }
  });

  it("refuses another account, which Wrangler would prefer to CLOUDFLARE_ACCOUNT_ID", () => {
    expect(() =>
      validateDeployConfig(effective({ account_id: "b".repeat(32) }), ACCOUNT, NAME),
    ).toThrow("another account");
    expect(() => validateDeployConfig(effective({ account_id: "" }), ACCOUNT, NAME)).toThrow(
      "another account",
    );
  });

  it("refuses resources the staging tool does not record or tear down", () => {
    for (const key of [
      "kv_namespaces",
      "d1_databases",
      "services",
      "queues",
      "workflows",
      "vectorize",
      "hyperdrive",
      "analytics_engine_datasets",
      "dispatch_namespaces",
      "tail_consumers",
      "unsafe",
      "assets",
      "triggers",
    ]) {
      expect(() => validateDeployConfig(raw({ [key]: [] }), ACCOUNT, NAME)).toThrow(`"${key}"`);
    }
  });

  it("refuses nested structures that reach another Worker or the account", () => {
    const refused: [string, Record<string, unknown>, string][] = [
      [
        "a Durable Object of another Worker",
        { durable_objects: { bindings: [{ name: "D", class_name: "D", script_name: "prod" }] } },
        '"script_name"',
      ],
      [
        "a Durable Object of another environment",
        { durable_objects: { bindings: [{ name: "D", class_name: "D", environment: "prod" }] } },
        '"environment"',
      ],
      [
        "a transfer migration",
        {
          migrations: [
            {
              tag: "v1",
              transferred_classes: [{ from: "P", from_script: "production-worker", to: "I" }],
            },
          ],
        },
        '"transferred_classes"',
      ],
      [
        "a log export destination",
        { observability: { logs: { enabled: true, destinations: ["prod-sink"] } } },
        "observability.logs",
      ],
      [
        "a trace export destination",
        { observability: { traces: { enabled: true, destinations: ["prod-sink"] } } },
        "observability.traces",
      ],
      ["an unknown observability key", { observability: { export: {} } }, '"export"'],
    ];
    for (const [label, extra, message] of refused) {
      expect(() => validateDeployConfig(raw(extra), ACCOUNT, NAME), label).toThrow(message);
    }
  });

  it("accepts the nested structures a staging Worker of its own needs", () => {
    const own = raw({
      durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ControlDO"] },
        { tag: "v2", renamed_classes: [{ from: "ControlDO", to: "Control" }] },
        { tag: "v3", deleted_classes: ["Old"], new_classes: ["New"] },
      ],
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        logs: { enabled: true, invocation_logs: true, persist: true },
        traces: { enabled: false },
      },
    });
    expect(() => validateDeployConfig(own, ACCOUNT, NAME)).not.toThrow();
  });

  it("accepts containers and buckets that carry the deployment's name, within budget", () => {
    const own = raw({
      durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
      containers: [
        { name: "cfo-stg-a", class_name: "Host", image: "./Dockerfile", max_instances: 1 },
        {
          name: "cfo-stg-a-big",
          class_name: "Host",
          image: "docker.io/library/busybox:1.37",
          max_instances: 3,
          instance_type: "standard-2",
        },
      ],
      r2_buckets: [
        { binding: "DATA", bucket_name: "cfo-stg-a" },
        { binding: "LOGS", bucket_name: "cfo-stg-a-logs" },
      ],
    });
    expect(() => validateDeployConfig(own, ACCOUNT, NAME)).not.toThrow();
    expect(declaredResources(own.raw, NAME)).toEqual({
      containers: ["cfo-stg-a", "cfo-stg-a-big"],
      buckets: ["cfo-stg-a", "cfo-stg-a-logs"],
      repositories: ["cfo-stg-a", "cfo-stg-a-big"],
    });
  });

  describe("durable_object scheduling policy", () => {
    const pinned = (account: string, repo: string) =>
      `registry.cloudflare.com/${account}/${repo}@sha256:${"0".repeat(64)}`;
    const policy = (extra: Record<string, unknown>) =>
      raw({
        containers: [
          {
            name: "cfo-stg-a-computer",
            class_name: "S1Computer",
            scheduling_policy: "durable_object",
            images: { computer: { dockerfile: "./computer/Dockerfile" } },
            ...extra,
          },
        ],
      });

    it("accepts built and pinned images, and names the repositories as Wrangler does", () => {
      const view = policy({
        images: {
          computer: { dockerfile: "./computer/Dockerfile", build_vars: { V: "1" } },
          "Slim Image!": { image: pinned(ACCOUNT, "cfo-stg-a-prebuilt") },
        },
        observability: { logs: { enabled: true } },
      });
      expect(() => validateDeployConfig(view, ACCOUNT, NAME)).not.toThrow();
      expect(declaredResources(view.raw, NAME)).toEqual({
        containers: ["cfo-stg-a-computer"],
        buckets: [],
        repositories: ["cfo-stg-a-s1computer-computer", "cfo-stg-a-prebuilt"],
      });
    });

    it("matches the repository a real Wrangler 4.149.0 dry run reported", () => {
      // From spike S1's dry run: worker cfo-stg-s1-dop, class S1Computer, image "computer".
      expect(policyRepository("cfo-stg-s1-dop", "S1Computer", "computer")).toBe(
        "cfo-stg-s1-dop-s1computer-computer",
      );
      expect(policyRepository("cfo-stg-a", "Host", "-My Img!-")).toBe("cfo-stg-a-host--my-img");
    });

    it("refuses what the staging tool cannot keep inside the deployment", () => {
      const refused: [string, DeployConfigView, string][] = [
        [
          "max_instances, which Wrangler rejects too",
          policy({ max_instances: 1 }),
          '"max_instances"',
        ],
        ["ssh", policy({ ssh: { enabled: true } }), '"ssh"'],
        ["authorized_keys", policy({ authorized_keys: [] }), '"authorized_keys"'],
        ["unsafe", policy({ unsafe: {} }), '"unsafe"'],
        ["no images", policy({ images: undefined }), '"images" map'],
        ["no image at all", policy({ images: {} }), "1 to 100"],
        [
          "an image with both sources",
          policy({ images: { c: { dockerfile: "./D", image: pinned(ACCOUNT, "cfo-stg-a-x") } } }),
          "exactly one",
        ],
        [
          "another account's image",
          policy({ images: { c: { image: pinned("b".repeat(32), "cfo-stg-a-x") } } }),
          "staging account",
        ],
        [
          "another deployment's image",
          policy({ images: { c: { image: pinned(ACCOUNT, "cfo-stg-b-x") } } }),
          "staging account",
        ],
        [
          "an image by tag, not digest",
          policy({ images: { c: { image: `registry.cloudflare.com/${ACCOUNT}/cfo-stg-a-x:1` } } }),
          "by digest",
        ],
        [
          "a public image",
          policy({ images: { c: { image: "docker.io/library/busybox:1.37" } } }),
          "by digest",
        ],
        [
          "instance targeting",
          policy({ observability: { logs: { enabled: true, target_instance_count: 2 } } }),
          '"target_instance_count"',
        ],
        ["an unknown policy", policy({ scheduling_policy: "regional" }), '"scheduling_policy"'],
        ["another deployment's name", policy({ name: "cfo-stg-b-computer" }), "lowercase"],
      ];
      for (const [label, view, message] of refused) {
        expect(() => validateDeployConfig(view, ACCOUNT, NAME), label).toThrow(message);
      }
    });
  });

  it("refuses containers and buckets outside the deployment or the budget", () => {
    const container = (extra: Record<string, unknown>) =>
      raw({ containers: [{ name: "cfo-stg-a", class_name: "H", max_instances: 1, ...extra }] });
    const bucket = (extra: Record<string, unknown>) =>
      raw({ r2_buckets: [{ binding: "D", bucket_name: "cfo-stg-a", ...extra }] });
    const refused: [string, DeployConfigView, string][] = [
      ["an unnamed container", container({ name: undefined }), "lowercase"],
      ["another deployment's container", container({ name: "cfo-stg-b" }), "lowercase"],
      ["a prefix lookalike", container({ name: "cfo-stg-ab" }), "lowercase"],
      ["an unprefixed container", container({ name: "production-host" }), "lowercase"],
      ["an uppercase container", container({ name: "cfo-stg-a-Host" }), "lowercase"],
      ["no instance limit", container({ max_instances: undefined }), "max_instances"],
      ["too many instances", container({ max_instances: 4 }), "max_instances"],
      ["a fractional limit", container({ max_instances: 1.5 }), "max_instances"],
      ["a large instance type", container({ instance_type: "standard-4" }), "instance_type"],
      ["a custom instance type", container({ instance_type: { vcpu: 8 } }), "instance_type"],
      ["an unknown container key", container({ observability: { logs: true } }), '"observability"'],
      ["another deployment's bucket", bucket({ bucket_name: "cfo-stg-b" }), "bucket_name"],
      ["a production bucket", bucket({ bucket_name: "non-staging-data" }), "bucket_name"],
      ["a bucket in a jurisdiction", bucket({ jurisdiction: "eu" }), '"jurisdiction"'],
      ["a preview bucket", bucket({ preview_bucket_name: "x" }), '"preview_bucket_name"'],
      ["containers not a list", raw({ containers: { name: "cfo-stg-a" } }), "must be a list"],
    ];
    for (const [label, view, message] of refused) {
      expect(() => validateDeployConfig(view, ACCOUNT, NAME), label).toThrow(message);
    }
  });

  it("only names that equal the deployment or extend it with a hyphen belong to it", () => {
    expect(ownedBy("cfo-stg-a", "cfo-stg-a")).toBe(true);
    expect(ownedBy("cfo-stg-a-x", "cfo-stg-a")).toBe(true);
    expect(ownedBy("cfo-stg-ab", "cfo-stg-a")).toBe(false);
    expect(ownedBy("cfo-stg-", "cfo-stg-a")).toBe(false);
    expect(() => validateDeployConfig(closed, ACCOUNT, "agents")).toThrow("refusing to touch");
  });

  it("names every problem at once", () => {
    expect(() =>
      validateDeployConfig(effective({ workers_dev: true, preview_urls: true }), ACCOUNT, NAME),
    ).toThrow('"workers_dev" must be false; "preview_urls" must be false');
  });
});

describe("interrupted uploads", () => {
  const now = new Date("2026-10-18T12:00:00.000Z");

  it("leaves a record without an unfinished upload alone", () => {
    expect(markInterrupted(deployment, now)).toBe(deployment);
  });

  it("marks an unfinished upload as interrupted", () => {
    const marked = markInterrupted({ ...deployment, uploadStartedAt: "x" }, now);
    expect(marked.uploadStartedAt).toBeUndefined();
    expect(marked.uploadInterruptedAt).toBe(now.toISOString());
  });

  it("keeps the first interruption", () => {
    const first = "2026-10-18T11:00:00.000Z";
    const marked = markInterrupted(
      { ...deployment, uploadStartedAt: "x", uploadInterruptedAt: first },
      now,
    );
    expect(marked.uploadInterruptedAt).toBe(first);
  });
});

describe("Access application checks", () => {
  it("creates a new application when the hostname has none", () => {
    expect(claimAccessApp([], deployment)).toBeUndefined();
    expect(claimAccessApp([app({ domain: "other.example.com" })], deployment)).toBeUndefined();
  });

  it("claims the recorded application, or an unrecorded one with the deployment's name", () => {
    expect(claimAccessApp([app()], { ...deployment, accessAppId: "app-1" })?.id).toBe("app-1");
    expect(claimAccessApp([app()], deployment)?.id).toBe("app-1");
  });

  it("refuses applications it did not record", () => {
    expect(() => claimAccessApp([app({ name: "someone-else" })], deployment)).toThrow();
    expect(() => claimAccessApp([app()], { ...deployment, accessAppId: "app-2" })).toThrow();
    expect(() =>
      claimAccessApp([app(), app({ id: "app-2" })], { ...deployment, accessAppId: "app-1" }),
    ).toThrow();
  });

  it("accepts only owner-only applications on the exact hostname", () => {
    const host = "cfo-stg-a.example.com";
    const { policies: _, ...withoutPolicies } = app();
    expect(() => assertOwnerOnly(app(), host, "owner@example.com")).not.toThrow();
    for (const bad of [
      app({ type: "bookmark" }),
      app({ domain: "cfo-stg-a.example.com/path" }),
      app({ policies: [] }),
      withoutPolicies,
      app({ policies: [{ decision: "bypass", include: [{ everyone: {} }] }] }),
      app({
        policies: [
          { decision: "non_identity", include: [{ email: { email: "owner@example.com" } }] },
        ],
      }),
      app({ policies: [{ decision: "allow", include: [] }] }),
      app({ policies: [{ decision: "allow", include: [{ everyone: {} }] }] }),
      app({
        policies: [{ decision: "allow", include: [{ email_domain: { domain: "example.com" } }] }],
      }),
      app({
        policies: [{ decision: "allow", include: [{ email: { email: "other@example.com" } }] }],
      }),
      app({
        policies: [
          { decision: "allow", include: [{ email: { email: "owner@example.com" } }] },
          { decision: "allow", include: [{ everyone: {} }] },
        ],
      }),
    ]) {
      expect(() => assertOwnerOnly(bad, host, "owner@example.com")).toThrow("not owner-only");
    }
  });

  it("accepts only SameSite=lax for the Access cookie (D9)", () => {
    const host = "cfo-stg-a.example.com";
    expect(() => assertSameSite(app({ same_site_cookie_attribute: "lax" }), host)).not.toThrow();
    const { same_site_cookie_attribute: _, ...unset } = app({ same_site_cookie_attribute: "lax" });
    expect(() => assertSameSite(unset, host)).toThrow("does not set SameSite=lax");
    for (const value of ["", "none", "strict", "Lax"]) {
      expect(() => assertSameSite(app({ same_site_cookie_attribute: value }), host)).toThrow(
        "does not set SameSite=lax",
      );
    }
  });
});

describe("registry file", () => {
  it("round-trips deployments", () => {
    const list = [
      deployment,
      { ...deployment, name: "cfo-stg-b", accessAppId: "x", state: "deployed" as const },
    ];
    expect(parseRegistry(JSON.parse(serializeRegistry(list)))).toEqual(list);
  });

  it("writes version 3, which tools before IR-001's fix refuse", () => {
    expect(JSON.parse(serializeRegistry([deployment])).version).toBe(3);
  });

  // IR-001: version 2 files from the tool of d1988ea carry a wall-clock settleUntil.
  it.each([
    ["an elapsed", "2026-10-18T11:00:00.000Z"],
    ["a future", "2099-01-01T00:00:00.000Z"],
  ])("turns %s legacy settleUntil into an interrupted upload", (_, settleUntil) => {
    const [migrated] = parseRegistry({
      version: 2,
      deployments: [{ ...deployment, state: "deployed", settleUntil }],
    });
    expect(migrated).not.toHaveProperty("settleUntil");
    expect(migrated?.uploadInterruptedAt).toBe(settleUntil);
  });

  it("keeps an earlier interruption when a legacy entry has both", () => {
    const [migrated] = parseRegistry({
      version: 2,
      deployments: [
        { ...deployment, uploadInterruptedAt: "2026-10-18T10:00:00.000Z", settleUntil: "x" },
      ],
    });
    expect(migrated?.uploadInterruptedAt).toBe("2026-10-18T10:00:00.000Z");
  });

  it("refuses unknown formats and malformed or unmanaged entries", () => {
    for (const bad of [
      [],
      { version: 1, deployments: [] },
      { version: 4, deployments: [] },
      { version: 2 },
      { version: 3, deployments: [{ ...deployment, settleUntil: "2026-10-18T11:00:00.000Z" }] },
      { version: 2, deployments: [{ ...deployment, settleUntil: 7 }] },
      { version: 3, deployments: [{ ...deployment, futureField: true }] },
      { version: 2, deployments: [{ ...deployment, futureField: true }] },
      { version: 2, deployments: [{ ...deployment, state: "gone" }] },
      { version: 2, deployments: [{ ...deployment, owner: "" }] },
      { version: 2, deployments: [{ ...deployment, accessAppId: 7 }] },
      { version: 2, deployments: [{ ...deployment, name: "agents" }] },
      { version: 2, deployments: [null] },
    ]) {
      expect(() => parseRegistry(bad)).toThrow();
    }
  });
});
