// The two deployments (AR-17) and the module rules the forwarding path relies on, checked from
// the configurations and the source, so a change that breaks them fails here rather than on
// staging.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../../scripts/staging/guard.ts";

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(WORKER, "src");

interface Binding {
  name: string;
  class_name: string;
  script_name?: string;
}
interface Config {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  workers_dev?: boolean;
  preview_urls?: boolean;
  routes?: unknown;
  route?: unknown;
  containers?: unknown;
  migrations?: { tag: string; new_sqlite_classes?: string[] }[];
  durable_objects?: { bindings: Binding[] };
  observability?: { enabled?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } };
}

const config = (file: string) =>
  parseJsonc(readFileSync(join(WORKER, file), "utf8")) as unknown as Config;
const platform = config("wrangler.jsonc");
const web = config("wrangler.web.jsonc");
const test = config("wrangler.test.jsonc");

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}
const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => relative(SRC, file);

/** The modules `entry` loads at run time: its value imports and re-exports, transitively. */
function runtimeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const pattern = /^(?:import|export)\s+(?!type\b)[^;]*?from\s+"([^"]+)";/gms;
  for (const [, spec] of read(entry).matchAll(pattern)) {
    if (spec === undefined) continue;
    if (!spec.startsWith(".")) {
      seen.add(spec);
      continue;
    }
    const target = resolve(dirname(entry), spec);
    if (existsSync(target)) runtimeImports(target, seen);
  }
  return seen;
}

describe("the platform Worker (wrangler.jsonc)", () => {
  it("has no public route of its own", () => {
    expect(platform.workers_dev).toBe(false);
    expect(platform.preview_urls).toBe(false);
    expect(platform.routes).toBeUndefined();
    expect(platform.route).toBeUndefined();
    expect(platform.main).toBe("src/index.ts");
  });

  it("pokes OmnigentServer every minute, the always-on backstop", () => {
    const triggers = (platform as unknown as { triggers?: { crons?: string[] } }).triggers;
    expect(triggers).toEqual({ crons: ["* * * * *"] });
    expect(read(join(SRC, "index.ts"))).toMatch(/async scheduled\(/);
    expect((web as unknown as { triggers?: unknown }).triggers).toBeUndefined();
  });

  it("runs each computer's container under WorkspaceDO, with the image key the port names (WP3.18)", async () => {
    const { COMPUTER_IMAGE_KEY } = await import("../../src/computer/container-port.ts");
    const containers = (platform.containers ?? []) as Record<string, unknown>[];
    const computer = containers.find((c) => c.class_name === "WorkspaceDO");
    // One container per computer (the `durable_object` policy), sized at each start, so the
    // configuration names no instance type or count; the image is built from the repository.
    expect(computer).toEqual({
      class_name: "WorkspaceDO",
      scheduling_policy: "durable_object",
      images: {
        [COMPUTER_IMAGE_KEY]: { dockerfile: "../images/computer/Dockerfile", build_context: ".." },
      },
      // Set on the entry (a `durable_object` container does not inherit the Worker's): a
      // computer's container output stays out of Workers Logs (WP3.19).
      observability: { logs: { enabled: false } },
    });
    const buckets = (platform as unknown as { r2_buckets?: { binding: string }[] }).r2_buckets;
    expect(buckets?.map((b) => b.binding)).toEqual(["CHECKPOINTS"]);
    expect((test as unknown as { r2_buckets?: { binding: string }[] }).r2_buckets).toEqual([
      { binding: "CHECKPOINTS", bucket_name: "cfo-test-checkpoints" },
    ]);
  });

  it("runs the server's container under OmnigentServer on the durable_object policy, with the image key its port names (WP3.19)", async () => {
    const { SERVER_IMAGE_KEY } = await import("../../src/server/container-port.ts");
    const containers = (platform.containers ?? []) as Record<string, unknown>[];
    // One named object runs one container; its size is a start option (SERVER_INSTANCE), so
    // the configuration names no instance type or count. Its output is logged, as it was when
    // it inherited the Worker's setting under the default policy.
    expect(containers.find((c) => c.class_name === "OmnigentServer")).toEqual({
      class_name: "OmnigentServer",
      scheduling_policy: "durable_object",
      images: {
        [SERVER_IMAGE_KEY]: { dockerfile: "../images/server/Dockerfile", build_context: ".." },
      },
      observability: { logs: { enabled: true } },
    });
  });

  it("hosts OmnigentServer as a SQLite Durable Object class", () => {
    expect(platform.durable_objects?.bindings).toContainEqual({
      name: "OMNIGENT",
      class_name: "OmnigentServer",
    });
    const classes = platform.migrations?.flatMap((m) => m.new_sqlite_classes ?? []);
    expect(classes).toContain("OmnigentServer");
  });
});

describe("the web Worker (wrangler.web.jsonc)", () => {
  it("reaches OmnigentServer through a cross-script binding to the platform Worker", () => {
    expect(web.durable_objects?.bindings).toContainEqual({
      name: "OMNIGENT",
      class_name: "OmnigentServer",
      script_name: platform.name,
    });
    expect(web.name).not.toBe(platform.name);
  });

  it("holds no Durable Object class, no container and no migration", () => {
    expect(web.migrations).toBeUndefined();
    expect(web.containers).toBeUndefined();
    for (const binding of web.durable_objects?.bindings ?? []) {
      expect(binding.script_name).toBe(platform.name);
    }
    const loaded = [...runtimeImports(join(SRC, "web.ts"))].map((m) =>
      m.startsWith("/") ? rel(m) : m,
    );
    expect(loaded).toEqual(expect.arrayContaining(["server/forward.ts", "ingress/index.ts"]));
    expect(loaded).not.toContain("cloudflare:workers");
    expect(loaded.filter((m) => /DO\.ts$|OmnigentServer\.ts$/.test(m))).toEqual([]);
  });

  it("is closed to every other URL and matches the platform Worker's runtime", () => {
    expect(web.main).toBe("src/web.ts");
    expect(web.workers_dev).toBe(false);
    expect(web.preview_urls).toBe(false);
    expect(web.routes).toBeUndefined();
    expect(web.compatibility_date).toBe(platform.compatibility_date);
    expect(web.compatibility_flags).toEqual(platform.compatibility_flags);
  });

  it("declares in WebEnv exactly the bindings it configures", () => {
    const envSource = read(join(SRC, "env.ts"));
    const webEnv = envSource.slice(envSource.indexOf("export interface WebEnv"));
    for (const binding of web.durable_objects?.bindings ?? []) {
      expect(webEnv).toContain(
        `readonly ${binding.name}: DurableObjectNamespace<${binding.class_name}>`,
      );
    }
  });
});

describe("Workers Logs: no request header is recorded (WP2.6)", () => {
  // Invocation logs record every request header, custom credential headers in clear; the
  // structured console logs (the watchdog's, the bootstrap status) stay on.
  it.each([
    ["the platform Worker", platform],
    ["the web Worker", web],
  ])("%s keeps console logs and has invocation logs off", (_name, cfg) => {
    expect(cfg.observability).toMatchObject({
      enabled: true,
      logs: { enabled: true, invocation_logs: false },
    });
  });
});

describe("the Workers-runtime test configuration (wrangler.test.jsonc)", () => {
  // Every platform binding is its production class (WP3.18): the routes, the backup gateway and
  // ControlDO reach the real WorkspaceDO, with only its container and clock simulated. One extra
  // binding: WP3.1's controller under fakes, for its own Workers-runtime tests.
  const STAND_INS = {
    replaced: {} as Record<string, string>,
    bindings: [{ name: "WORKSPACE_CONTROLLER", class_name: "WorkspaceUnderFakes" }],
    classes: ["WorkspaceUnderFakes"],
  };

  it("binds and migrates the platform Worker's classes the same way, plus declared stand-ins", () => {
    expect(test.durable_objects?.bindings).toEqual([
      ...(platform.durable_objects?.bindings ?? []).map((b) => ({
        ...b,
        class_name: STAND_INS.replaced[b.name] ?? b.class_name,
      })),
      ...STAND_INS.bindings,
    ]);
    const platformMigrations = platform.migrations ?? [];
    expect(test.migrations?.slice(0, platformMigrations.length)).toEqual(platformMigrations);
    expect(
      test.migrations?.slice(platformMigrations.length).flatMap((m) => m.new_sqlite_classes ?? []),
    ).toEqual(STAND_INS.classes);
    expect(test.compatibility_date).toBe(platform.compatibility_date);
  });
});

describe("module rules of the forwarding path", () => {
  it("never uses the containers library (R-24: never containerFetch)", () => {
    const pkg = JSON.parse(read(join(WORKER, "package.json"))) as Record<string, object>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).not.toContain("@cloudflare/containers");
    for (const file of sources()) expect(read(file)).not.toMatch(/@cloudflare\/containers/);
  });

  it("touches ctx.container only in the container ports", () => {
    const touching = sources()
      .filter((file) => /\bctx\.container\b/.test(read(file).replace(/^\s*\/\/.*$/gm, "")))
      .map(rel)
      .sort();
    expect(touching).toEqual(["computer/container-port.ts", "server/container-port.ts"]);
  });

  it("never accepts a forwarded socket in JavaScript", () => {
    for (const file of [
      "server/OmnigentServer.ts",
      "server/forward.ts",
      "server/proxy.ts",
      "web.ts",
      "internal/omnigent-route.ts",
      "internal/entrypoints.ts",
      "internal/upgrade-answer.ts",
    ]) {
      expect(read(join(SRC, file))).not.toMatch(/\.accept\(/);
    }
  });

  it("registers platform.internal for the server container only", () => {
    // The name comes from the contracts; no source spells it.
    const literal = sources().filter((file) => read(file).includes('"platform.internal"'));
    expect(literal.map(rel)).toEqual([]);
    const users = sources()
      .filter((file) => /\bPLATFORM_INTERNAL_HOST\b/.test(read(file)))
      .map(rel)
      .sort();
    // OmnigentServer registers it; the computer's network module names it only to refuse it.
    expect(users).toEqual([
      "computer/network.ts",
      "server/OmnigentServer.ts",
      "server/platform-internal.ts",
    ]);
    const registrations = sources().flatMap((file) =>
      [...read(file).matchAll(/interceptOutboundHttp\(\s*([A-Z_a-z."]+)/g)].map(
        (m) => `${rel(file)}:${m[1]}`,
      ),
    );
    // The two container ports pass registrations through; the computer's checks each host.
    expect(registrations.filter((r) => !/^(server|computer)\/container-port\.ts:/.test(r))).toEqual(
      ["server/OmnigentServer.ts:PLATFORM_INTERNAL_HOST"],
    );
  });

  it("uses the Sandbox SDK only in its adapter module (egress/backups.ts)", () => {
    const users = sources()
      .filter((file) => /@cloudflare\/sandbox/.test(read(file).replace(/^\s*\/\/.*$/gm, "")))
      .map(rel);
    expect(users).toEqual(["egress/backups.ts"]);
    const pkg = JSON.parse(read(join(WORKER, "package.json"))) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@cloudflare/sandbox"]).toBe("1.0.0");
  });
});
