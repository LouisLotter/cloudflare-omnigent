import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AccessApp,
  ALLOWED_CONFIG_KEYS,
  accessAppBody,
  assertAccount,
  assertManaged,
  assertOwnerOnly,
  claimAccessApp,
  type DeployConfigView,
  type Deployment,
  expired,
  expiry,
  hostnameFor,
  markInterrupted,
  parseRegistry,
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
    expect(() => validateDeployConfig(closed, ACCOUNT)).not.toThrow();
    expect(() => validateDeployConfig(effective({ routes: [] }), ACCOUNT)).not.toThrow();
    expect(() => validateDeployConfig(effective({ account_id: ACCOUNT }), ACCOUNT)).not.toThrow();
    const everyKey = Object.fromEntries(ALLOWED_CONFIG_KEYS.map((key) => [key, null]));
    expect(() =>
      validateDeployConfig({ ...closed, raw: { ...everyKey, ...closed.raw } }, ACCOUNT),
    ).not.toThrow();
    expect(() =>
      validateDeployConfig(
        raw({ durable_objects: { bindings: [{ name: "CONTROL", class_name: "ControlDO" }] } }),
        ACCOUNT,
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
      expect(() => validateDeployConfig(view, ACCOUNT)).toThrow("refusing Wrangler config");
    }
  });

  it("refuses another account, which Wrangler would prefer to CLOUDFLARE_ACCOUNT_ID", () => {
    expect(() => validateDeployConfig(effective({ account_id: "b".repeat(32) }), ACCOUNT)).toThrow(
      "another account",
    );
    expect(() => validateDeployConfig(effective({ account_id: "" }), ACCOUNT)).toThrow(
      "another account",
    );
  });

  it("refuses resources the staging tool does not record or tear down", () => {
    for (const key of [
      "r2_buckets",
      "kv_namespaces",
      "d1_databases",
      "services",
      "queues",
      "containers",
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
      expect(() => validateDeployConfig(raw({ [key]: [] }), ACCOUNT)).toThrow(`"${key}"`);
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
      expect(() => validateDeployConfig(raw(extra), ACCOUNT), label).toThrow(message);
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
    expect(() => validateDeployConfig(own, ACCOUNT)).not.toThrow();
  });

  it("names every problem at once", () => {
    expect(() =>
      validateDeployConfig(effective({ workers_dev: true, preview_urls: true }), ACCOUNT),
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
});

describe("registry file", () => {
  it("round-trips deployments", () => {
    const list = [
      deployment,
      { ...deployment, name: "cfo-stg-b", accessAppId: "x", state: "deployed" as const },
    ];
    expect(parseRegistry(JSON.parse(serializeRegistry(list)))).toEqual(list);
  });

  it("refuses unknown formats and malformed or unmanaged entries", () => {
    for (const bad of [
      [],
      { version: 1, deployments: [] },
      { version: 2 },
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
