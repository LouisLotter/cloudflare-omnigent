import {
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  bucketLookup,
  type CommandResult,
  childEnv,
  childStdio,
  cliCloud,
  DIAGNOSTIC_LIMIT,
  diagnostic,
  dnsRecordsOf,
  fileStore,
  imagesOf,
  ingressOf,
  type RunOptions,
  readStagingManifest,
  readWranglerConfig,
  removeStaleSecretDirs,
  secretsBase,
  spawnRunner,
  tunnelsOf,
  vpcServicesOf,
  WRANGLER_QUIET_LOGS,
  withSecretsDescriptor,
  workerLookup,
  wranglerCli,
  writePrivateFile,
} from "./cloud.ts";
import { type Deployment, tunnelRoute, validateDeployConfig } from "./guard.ts";
import { acquireLock, heldLockFds } from "./lock.ts";

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "worker");
const scratch = mkdtempSync(join(tmpdir(), "cfo-stg-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const ok = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): CommandResult => ({ status: 1, stdout: "", stderr });
const NOT_FOUND = [
  "┌ APIError",
  "│ [10007] This Worker does not exist on your account.",
  "│ 404 Not Found · HTTP /accounts/x/workers/workers/cfo-stg-a",
  "└",
].join("\n");

describe("Worker lookup", () => {
  it("answers only when Cloudflare answered about that exact Worker", () => {
    expect(workerLookup(ok(JSON.stringify({ name: "cfo-stg-a" })), "cfo-stg-a")).toBe(true);
    expect(workerLookup(ok(JSON.stringify({ result: { name: "cfo-stg-a" } })), "cfo-stg-a")).toBe(
      true,
    );
    expect(workerLookup(failed(NOT_FOUND), "cfo-stg-a")).toBe(false);
  });

  it("treats every other outcome as unknown", () => {
    for (const result of [
      ok(JSON.stringify({ name: "cfo-stg-b" })),
      ok("null"),
      failed("│ [10000] Authentication error\n│ 403 Forbidden"),
      failed("│ 404 Not Found"),
      failed("fetch failed: ECONNRESET"),
      { status: null, stdout: "", stderr: "" },
    ]) {
      expect(() => workerLookup(result, "cfo-stg-a")).toThrow();
    }
    expect(() => workerLookup(ok("not json"), "cfo-stg-a")).toThrow();
  });
});

describe("R2 bucket lookup and image listings", () => {
  const NO_BUCKET =
    "│ [10006] The specified bucket does not exist.\n│ 404 Not Found · HTTP /r2/buckets/x";

  it("answers only when R2 answered about that exact bucket", () => {
    expect(bucketLookup(ok(JSON.stringify({ result: { name: "cfo-stg-a" } })), "cfo-stg-a")).toBe(
      true,
    );
    expect(bucketLookup(failed(NO_BUCKET), "cfo-stg-a")).toBe(false);
    for (const result of [
      ok(JSON.stringify({ result: { name: "cfo-stg-b" } })),
      failed("│ [10042] Please enable R2 through the Cloudflare Dashboard.\n│ 403 Forbidden"),
      failed("│ 404 Not Found"),
    ]) {
      expect(() => bucketLookup(result, "cfo-stg-a")).toThrow();
    }
  });

  it("picks the references of exactly one repository, in either listing shape", () => {
    const listing = [
      { name: "cfo-stg-a-host", tags: ["1", "2"] },
      { name: "cfo-stg-a-host-big", tags: ["1"] },
      "registry.cloudflare.com/acct/cfo-stg-a-host:3",
      "cfo-stg-ab:1",
    ];
    expect(imagesOf(listing, "cfo-stg-a-host")).toEqual([
      "cfo-stg-a-host:1",
      "cfo-stg-a-host:2",
      "registry.cloudflare.com/acct/cfo-stg-a-host:3",
    ]);
    expect(imagesOf([], "cfo-stg-a-host")).toEqual([]);
    expect(() => imagesOf({ images: [] }, "x")).toThrow();
    expect(() => imagesOf([{ name: "x" }], "x")).toThrow();
  });
});

describe("what of cf's and Wrangler's output may reach an error or a log", () => {
  const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "o@example.com" };

  it("bounds cf's error output and masks emails, tokens, identifiers and secrets", () => {
    const token = `eyJ${"A".repeat(30)}.${"b".repeat(10)}`;
    const secret = "Xq7Zp".repeat(9);
    const line = `│ [10000] denied for someone@example.org with ${token} ${secret} on account ${"f".repeat(32)} id 0191dce4-9ab4-7fce-b660-8e5dec5172da at cfo-stg-x1-transport-tunnel.example.com`;
    const shown = diagnostic(`┌ APIError\n${line}\n│ second line with ${secret}`);
    for (const hidden of ["someone@example.org", token, secret, "f".repeat(32), "0191dce4"]) {
      expect(shown).not.toContain(hidden);
    }
    expect(shown).toContain("[10000] denied for <email> with <token> <redacted>");
    expect(shown).toContain("cfo-stg-x1-transport-tunnel.example.com");
    expect(diagnostic(`│ ${"x ".repeat(500)}`)).toHaveLength(DIAGNOSTIC_LIMIT + 1);
    expect(diagnostic("")).toBe("no output");
  });

  it("never copies the output of a cf command that returns a secret into its error", () => {
    const leak = "synthetic-secret-in-output";
    const failing = cliCloud(config, WORKER, () => ({
      status: 1,
      stdout: `{"result":"${leak}"}`,
      stderr: `│ [1002] Tunnel not found ${leak}\n│ 404 Not Found`,
    }));
    for (const call of [() => failing.tunnelToken("t"), () => failing.createTunnel("x")]) {
      expect(call).toThrow(/^cf tunnels (token get|create --body) failed: \[1002\]$/);
      try {
        call();
      } catch (error) {
        expect(String(error)).not.toContain(leak);
      }
    }
    const silent = cliCloud(config, WORKER, () => failed("Segmentation fault"));
    expect(() => silent.tunnelToken("t")).toThrow(/^cf tunnels token get failed$/);
  });

  it("forces Wrangler's sanitised, console-only logging whatever the environment says", () => {
    const saved = { ...process.env };
    process.env.WRANGLER_LOG_SANITIZE = "false";
    process.env.WRANGLER_WRITE_LOGS = "true";
    process.env.WRANGLER_LOG = "debug";
    try {
      const printed = spawnRunner("a".repeat(32))(
        process.execPath,
        [
          "-e",
          "console.log([process.env.WRANGLER_LOG_SANITIZE, process.env.WRANGLER_WRITE_LOGS, process.env.WRANGLER_LOG].join())",
        ],
        { inherit: false, env: WRANGLER_QUIET_LOGS },
      );
      expect(printed.stdout.trim()).toBe("true,false,log");
    } finally {
      for (const key of ["WRANGLER_LOG_SANITIZE", "WRANGLER_WRITE_LOGS", "WRANGLER_LOG"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    // Every Wrangler child gets them, also a caller's explicit setting cannot undo them.
    let seen: Readonly<Record<string, string>> | undefined;
    cliCloud(config, WORKER, (_command, _args, options) => {
      seen = options.env;
      return ok("");
    }).deleteWorker("cfo-stg-a");
    expect(seen).toMatchObject(WRANGLER_QUIET_LOGS);
  });
});

describe("Tunnel, DNS and VPC answers", () => {
  it("lists only Tunnels that exist and run cloudflared", () => {
    expect(
      tunnelsOf([
        { id: "t1", name: "cfo-stg-a", deleted_at: null, tun_type: "cfd_tunnel", token: "x" },
        { id: "t2", name: "cfo-stg-a" },
        { id: "t3", name: "cfo-stg-a", deleted_at: "2026-10-20T00:00:00Z" },
        { id: "t4", name: "cfo-stg-a", tun_type: "warp_connector" },
      ]),
    ).toEqual([
      { id: "t1", name: "cfo-stg-a" },
      { id: "t2", name: "cfo-stg-a" },
    ]);
    for (const bad of [{}, [{ name: "x" }], [{ id: "t" }], [null], [[]]]) {
      expect(() => tunnelsOf(bad)).toThrow();
    }
  });

  it("reads a Tunnel's ingress, and none before it has a configuration", () => {
    const rules = [
      { hostname: "h.example.com", service: "http://localhost:8081", originRequest: {} },
      { hostname: "h.example.com", path: "/x", service: "http://localhost:1" },
      { service: "http_status:404" },
    ];
    expect(ingressOf({ config: { ingress: rules } })).toEqual([
      { hostname: "h.example.com", service: "http://localhost:8081" },
      { hostname: "h.example.com", path: "/x", service: "http://localhost:1" },
      { service: "http_status:404" },
    ]);
    for (const empty of [
      {},
      { config: null },
      { config: {} },
      { config: { ingress: null } },
      null,
    ]) {
      expect(ingressOf(empty)).toEqual([]);
    }
    expect(() => ingressOf({ config: { ingress: {} } })).toThrow();
    expect(() => ingressOf({ config: { ingress: [{ hostname: "h" }] } })).toThrow("service");
  });

  it("flattens DNS records and VPC services, refusing entries without IDs", () => {
    expect(
      dnsRecordsOf([
        {
          id: "d",
          name: "h.example.com",
          type: "CNAME",
          content: "t.cfargotunnel.com",
          proxied: true,
        },
        { id: "e", name: "h.example.com", type: "TXT" },
      ]),
    ).toEqual([
      {
        id: "d",
        name: "h.example.com",
        type: "CNAME",
        content: "t.cfargotunnel.com",
        proxied: true,
      },
      { id: "e", name: "h.example.com", type: "TXT", content: "", proxied: false },
    ]);
    expect(() => dnsRecordsOf([{ name: "h", type: "A" }])).toThrow("id");
    expect(
      vpcServicesOf([
        {
          service_id: "v",
          name: "cfo-stg-a-x1-vpc",
          type: "http",
          http_port: 8081,
          https_port: 443,
          host: { ipv4: "127.0.0.1", network: { tunnel_id: "t" } },
        },
        { service_id: "w", name: "other", type: "tcp", host: { hostname: "db" } },
      ]),
    ).toEqual([
      {
        id: "v",
        name: "cfo-stg-a-x1-vpc",
        type: "http",
        ipv4: "127.0.0.1",
        tunnelId: "t",
        httpPort: 8081,
        httpsPort: 443,
      },
      { id: "w", name: "other", type: "tcp" },
    ]);
    expect(() => vpcServicesOf([{ id: "v", name: "x" }])).toThrow("service_id");
    expect(() => vpcServicesOf({ services: [] })).toThrow();
  });
});

describe("secrets for an upload", () => {
  const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "o@example.com" };
  const secretDirs = () =>
    readdirSync(secretsBase()).filter((name) => name.startsWith("cfo-stg-secrets-"));

  it("reach Wrangler only as descriptor 3, a file without a name, and never argv", () => {
    const before = secretDirs();
    let seen:
      | {
          args: readonly string[];
          fds: readonly number[];
          links: number;
          mode: number;
          text: string;
        }
      | undefined;
    const cloud = cliCloud(config, WORKER, (_command, args, options) => {
      const fd = options.fds?.[0] ?? -1;
      const stat = fstatSync(fd);
      seen = {
        args,
        fds: options.fds ?? [],
        links: stat.nlink,
        mode: stat.mode & 0o777,
        // A fresh read through the descriptor's path, as Wrangler makes it.
        text: readFileSync(`/dev/fd/${fd}`, "utf8"),
      };
      expect(secretDirs()).toEqual(before);
      return ok("");
    });
    const secret = `synthetic-${Math.random().toString(36).slice(2)}`;
    cloud.deployWorker("cfo-stg-a", "cfo-stg-a.example.com", "/w/c.jsonc", 1, { X1_TOKEN: secret });
    expect(seen?.args.slice(2)).toEqual([
      "deploy",
      "--config",
      "/w/c.jsonc",
      "--name",
      "cfo-stg-a",
      "--domain",
      "cfo-stg-a.example.com",
      "--secrets-file",
      "/dev/fd/3",
    ]);
    expect(seen?.args.join(" ")).not.toContain(secret);
    expect(seen?.fds).toHaveLength(1);
    expect(seen?.links).toBe(0);
    expect(seen?.mode).toBe(0o600);
    expect(JSON.parse(seen?.text ?? "{}")).toEqual({ X1_TOKEN: secret });
    // The descriptor is closed afterwards.
    expect(() => fstatSync(seen?.fds[0] ?? -1)).toThrow();
    expect(secretDirs()).toEqual(before);
  });

  it("are readable by a real child at /dev/fd/3, as Wrangler reads them", () => {
    const read = withSecretsDescriptor({ X1_TOKEN: "synthetic" }, (fd) =>
      spawnRunner("a".repeat(32))(
        process.execPath,
        ["-e", "process.stdout.write(require('node:fs').readFileSync('/dev/fd/3', 'utf8'))"],
        { inherit: false, fds: [fd] },
      ),
    );
    expect(JSON.parse(read.stdout)).toEqual({ X1_TOKEN: "synthetic" });
  });

  it("puts the descriptor at 3, before the staging locks", () => {
    const release = acquireLock(join(scratch, "locks", "fds.lock"), 0, "test");
    try {
      expect(childStdio(true, [42])).toEqual([
        "ignore",
        "inherit",
        "inherit",
        42,
        ...heldLockFds(),
      ]);
    } finally {
      release();
    }
  });

  it("are gone when the upload fails, and are not sent for an empty set", () => {
    let held = -1;
    expect(() =>
      withSecretsDescriptor({ A: "1" }, (fd) => {
        held = fd;
        throw new Error("wrangler deploy exited with 1");
      }),
    ).toThrow("exited");
    expect(() => fstatSync(held)).toThrow();
    const calls: { args: readonly string[]; options: RunOptions }[] = [];
    const cloud = cliCloud(config, WORKER, (_command, args, options) => {
      calls.push({ args, options });
      return ok("");
    });
    cloud.deployWorker("cfo-stg-a", "h", "/c", 1, {});
    expect(calls[0]?.args).not.toContain("--secrets-file");
    expect(calls[0]?.options.fds).toBeUndefined();
  });

  it("removes only this user's secrets directories that a killed run left long ago", () => {
    const base = mkdtempSync(join(scratch, "runtime-"));
    for (const name of ["cfo-stg-secrets-old", "cfo-stg-secrets-new", "other-old"]) {
      mkdirSync(join(base, name));
      writeFileSync(join(base, name, "secrets.json"), "{}");
    }
    writeFileSync(join(base, "cfo-stg-secrets-file"), "{}");
    const now = Date.now();
    const old = new Date(now - 120_000);
    for (const name of ["cfo-stg-secrets-old", "other-old", "cfo-stg-secrets-file"]) {
      utimesSync(join(base, name), old, old);
    }
    expect(removeStaleSecretDirs(base, now)).toBe(1);
    expect(readdirSync(base).sort()).toEqual([
      "cfo-stg-secrets-file",
      "cfo-stg-secrets-new",
      "other-old",
    ]);
    expect(removeStaleSecretDirs(join(base, "missing"), now)).toBe(0);
  });
});

describe("CLI wiring", () => {
  const config = { accountId: "a".repeat(32), zone: "example.com", ownerEmail: "o@example.com" };
  const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  const cloud = cliCloud(config, WORKER, (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "accounts") return ok(JSON.stringify({ result: [{ id: "a".repeat(32) }] }));
    if (args[3] === "create") return ok(JSON.stringify({ result: { id: "app-1" } }));
    if (args[3] === "list") return ok(JSON.stringify({ result: [] }));
    return ok("{}");
  });

  it("deletes an Access application without waiting for a confirmation nobody can give", () => {
    cloud.deleteAccessApp("app-1");
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "delete",
      "app-1",
      "--force",
    ]);
    expect(calls.at(-1)?.options.inherit).toBe(false);
  });

  it("updates an Access application by ID with the full body", () => {
    cloud.updateAccessApp("app-1", { name: "cfo-stg-a", same_site_cookie_attribute: "lax" });
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "update",
      "app-1",
      "--body",
      '{"name":"cfo-stg-a","same_site_cookie_attribute":"lax"}',
    ]);
  });

  it("asks Access only about the exact hostname", () => {
    cloud.listAccessApps("cfo-stg-a.example.com");
    expect(calls.at(-1)?.args).toEqual([
      "zero-trust",
      "access",
      "applications",
      "list",
      "--domain",
      "cfo-stg-a.example.com",
      "--exact",
    ]);
  });

  it("runs Wrangler's CLI directly, with exactly the guarded arguments", () => {
    const cli = wranglerCli(WORKER);
    expect(cli).toMatch(/wrangler-dist\/cli\.js$/);
    expect(existsSync(cli)).toBe(true);
    cloud.deployWorker("cfo-stg-a", "cfo-stg-a.example.com", "/w/wrangler.jsonc", 1792400000);
    // The build epoch reaches Wrangler, and through it `docker build`, as SOURCE_DATE_EPOCH
    // (DC-36).
    expect(calls.at(-1)).toEqual({
      command: process.execPath,
      args: [
        "--no-warnings",
        cli,
        "deploy",
        "--config",
        "/w/wrangler.jsonc",
        "--name",
        "cfo-stg-a",
        "--domain",
        "cfo-stg-a.example.com",
      ],
      options: {
        inherit: true,
        cwd: WORKER,
        env: { SOURCE_DATE_EPOCH: "1792400000", ...WRANGLER_QUIET_LOGS },
      },
    });
  });

  it("deletes through a generated configuration that pins the staging account", () => {
    let seen: { cwd: string | undefined; config: unknown } | undefined;
    const deleting = cliCloud(config, WORKER, (command, args, options) => {
      const file = args[args.indexOf("--config") + 1] ?? "";
      seen = { cwd: options.cwd, config: JSON.parse(readFileSync(file, "utf8")) };
      expect(command).toBe(process.execPath);
      expect(args.slice(2)).toEqual(["delete", "--config", file, "--name", "cfo-stg-a", "--force"]);
      expect(dirname(file)).toBe(options.cwd);
      return ok("");
    });
    deleting.deleteWorker("cfo-stg-a");
    expect(seen?.config).toEqual({ name: "cfo-stg-a", account_id: "a".repeat(32) });
    // The generated directory is removed afterwards.
    expect(existsSync(seen?.cwd ?? "/")).toBe(false);
  });

  it("passes the held staging locks to every child process", () => {
    const release = acquireLock(join(scratch, "locks", "wiring.lock"), 0, "test");
    try {
      const stdio = childStdio(false) as unknown[];
      expect(stdio.slice(0, 3)).toEqual(["ignore", "pipe", "pipe"]);
      expect(stdio.slice(3)).toEqual(heldLockFds());
      expect(heldLockFds()).toHaveLength(1);
    } finally {
      release();
    }
    expect(childStdio(true)).toEqual(["ignore", "inherit", "inherit"]);
  });

  it("manages buckets, container applications and images with cf, never interactively", () => {
    const cfCalls: (readonly string[])[] = [];
    let objects = 2;
    const managing = cliCloud(config, WORKER, (command, args) => {
      expect(command).toBe("cf");
      cfCalls.push(args);
      if (args[1] === "objects" && args[2] === "list") {
        const page = objects > 0 ? [{ key: `k${objects}` }] : [];
        objects -= 1;
        return ok(JSON.stringify({ result: page }));
      }
      if (args[1] === "applications" && args[2] === "list") {
        return ok(
          JSON.stringify({
            result: [
              { id: "ca-1", name: "cfo-stg-a-host" },
              { id: "ca-2", name: "cfo-stg-a-host-big" },
            ],
          }),
        );
      }
      if (args[1] === "images" && args[2] === "list") {
        return ok(JSON.stringify({ result: [{ name: "cfo-stg-a-host", tags: ["7"] }] }));
      }
      return ok("{}");
    });
    managing.createBucket("cfo-stg-a-data");
    expect(cfCalls.at(-1)).toEqual([
      "r2",
      "buckets",
      "create",
      "--body",
      '{"name":"cfo-stg-a-data"}',
    ]);
    managing.emptyAndDeleteBucket("cfo-stg-a-data");
    expect(
      cfCalls.filter((c) => c[2] === "bulk-delete").map((c) => c[c.indexOf("--body") + 1]),
    ).toEqual(['["k2"]', '["k1"]']);
    expect(cfCalls.at(-1)).toEqual(["r2", "buckets", "delete", "cfo-stg-a-data", "--force"]);
    expect(managing.containerApps("cfo-stg-a-host")).toEqual(["ca-1"]);
    managing.deleteContainerApp("ca-1");
    expect(cfCalls.at(-1)).toEqual(["containers", "applications", "delete", "ca-1", "--force"]);
    expect(managing.containerImages("cfo-stg-a-host")).toEqual(["cfo-stg-a-host:7"]);
    managing.deleteContainerImage("cfo-stg-a-host:7");
    expect(cfCalls.at(-1)).toEqual([
      "containers",
      "images",
      "delete",
      "cfo-stg-a-host:7",
      "--force",
    ]);
    // Every delete passes --force: there is no terminal to answer a confirmation. That includes
    // bulk-delete, which a check for an argument equal to "delete" missed until a live teardown.
    const deletes = cfCalls.filter((c) => c.some((arg) => arg.includes("delete")));
    expect(deletes.length).toBeGreaterThanOrEqual(5);
    expect(deletes.every((c) => c.includes("--force"))).toBe(true);
  });

  it("manages Tunnels, DNS records and VPC services with cf, never interactively", () => {
    const cfCalls: (readonly string[])[] = [];
    const answers: Record<string, unknown> = {
      "tunnels list": [
        { id: "t1", name: "cfo-stg-a" },
        { id: "t2", name: "cfo-stg-ab" },
      ],
      "tunnels create": { id: "t9", token: "synthetic-token", credentials_file: {} },
      "tunnels config": { config: { ingress: [{ service: "http_status:404" }] } },
      "tunnels token": "synthetic-token",
      "records list": [
        { id: "d1", name: "cfo-stg-a-tunnel.example.com", type: "CNAME", content: "x" },
        { id: "d2", name: "cfo-stg-a-tunnel.example.com.other", type: "CNAME", content: "x" },
      ],
      "records create": { id: "d9" },
      "services list": [{ service_id: "v1", name: "cfo-stg-a-x1-vpc" }],
      "services create": { service_id: "v9" },
    };
    const managing = cliCloud(config, WORKER, (command, args) => {
      expect(command).toBe("cf");
      cfCalls.push(args);
      const answer = answers[`${args[0]} ${args[1]}`] ?? answers[`${args[1]} ${args[2]}`];
      return ok(JSON.stringify({ result: answer ?? {} }));
    });
    const last = () => cfCalls.at(-1);

    expect(managing.tunnels({ name: "cfo-stg-a" })).toEqual([{ id: "t1", name: "cfo-stg-a" }]);
    expect(last()).toEqual([
      "tunnels",
      "list",
      "--name",
      "cfo-stg-a",
      "--is-deleted",
      "false",
      "--tun-types",
      "cfd_tunnel",
      "--per-page",
      "100",
      "--page",
      "1",
    ]);
    expect(managing.tunnels({ prefix: "cfo-stg-" }).map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(last()?.slice(2, 4)).toEqual(["--include-prefix", "cfo-stg-"]);
    expect(managing.createTunnel("cfo-stg-a")).toBe("t9");
    expect(last()).toEqual([
      "tunnels",
      "create",
      "--body",
      '{"name":"cfo-stg-a","config_src":"cloudflare"}',
    ]);
    expect(managing.tunnelIngress("t9")).toEqual([{ service: "http_status:404" }]);
    expect(last()).toEqual(["tunnels", "config", "get", "t9"]);
    managing.putTunnelIngress("t9", [{ hostname: "h", service: "http://localhost:1" }]);
    expect(last()).toEqual([
      "tunnels",
      "config",
      "update",
      "t9",
      "--body",
      '{"config":{"ingress":[{"hostname":"h","service":"http://localhost:1"}]}}',
    ]);
    expect(managing.tunnelToken("t9")).toBe("synthetic-token");
    expect(last()).toEqual(["tunnels", "token", "get", "t9"]);
    managing.deleteTunnel("t9");
    expect(cfCalls.slice(-2)).toEqual([
      ["tunnels", "connections", "cleanup", "t9", "--force"],
      ["tunnels", "delete", "t9", "--force"],
    ]);

    expect(managing.dnsRecords({ name: "cfo-stg-a-tunnel.example.com" }).map((r) => r.id)).toEqual([
      "d1",
    ]);
    expect(last()).toEqual([
      "dns",
      "records",
      "list",
      "--zone",
      "example.com",
      "--name-exact",
      "cfo-stg-a-tunnel.example.com",
      "--per-page",
      "100",
      "--page",
      "1",
    ]);
    managing.dnsRecords({ prefix: "cfo-stg-" });
    expect(last()?.slice(5, 7)).toEqual(["--name-startswith", "cfo-stg-"]);
    expect(managing.createDnsRecord("h.example.com", "t9.cfargotunnel.com", "cfo-stg-a")).toBe(
      "d9",
    );
    expect(last()).toEqual([
      "dns",
      "records",
      "create",
      "--zone",
      "example.com",
      "--body",
      '{"type":"CNAME","name":"h.example.com","content":"t9.cfargotunnel.com","proxied":true,"ttl":1,"comment":"cfo-stg-a"}',
    ]);
    managing.deleteDnsRecord("d9");
    expect(last()).toEqual(["dns", "records", "delete", "d9", "--zone", "example.com", "--force"]);

    expect(managing.vpcServices().map((s) => s.id)).toEqual(["v1"]);
    expect(last()).toEqual(["workers-vpc", "services", "list", "--per-page", "100", "--page", "1"]);
    expect(managing.createVpcService("cfo-stg-a-x1-vpc", "t9", 8081)).toBe("v9");
    expect(last()).toEqual([
      "workers-vpc",
      "services",
      "create",
      "--body",
      '{"type":"http","name":"cfo-stg-a-x1-vpc","http_port":8081,"host":{"ipv4":"127.0.0.1","network":{"tunnel_id":"t9"}}}',
    ]);
    managing.deleteVpcService("v9");
    expect(last()).toEqual(["workers-vpc", "services", "delete", "v9", "--force"]);

    const deletes = cfCalls.filter((c) => c.some((arg) => /^(delete|cleanup)$/.test(arg)));
    expect(deletes).toHaveLength(4);
    expect(deletes.every((c) => c.includes("--force"))).toBe(true);
  });

  it("lets the Tunnel delete decide when the connections cleanup fails", () => {
    const cleanupFails = (deleteFails: boolean) =>
      cliCloud(config, WORKER, (_command, args) =>
        args[1] === "connections" || deleteFails
          ? failed(`│ [1000] ${args[1]} refused`)
          : ok(JSON.stringify({ result: {} })),
      );
    expect(() => cleanupFails(false).deleteTunnel("t")).not.toThrow();
    expect(() => cleanupFails(true).deleteTunnel("t")).toThrow(
      "cf tunnels failed: [1000] delete refused",
    );
    try {
      cleanupFails(true).deleteTunnel("t");
    } catch (error) {
      expect(String((error as Error).cause)).toContain("connections refused");
    }
  });

  it("reads every page of a listing, and refuses one that never ends", () => {
    const pages: string[] = [];
    const listing = (total: number) =>
      cliCloud(config, WORKER, (_command, args) => {
        const page = Number(args[args.indexOf("--page") + 1]);
        pages.push(String(page));
        const first = (page - 1) * 100;
        const count = Math.max(0, Math.min(100, total - first));
        const result = Array.from({ length: count }, (_, i) => ({
          service_id: `v${first + i}`,
          name: `s${first + i}`,
        }));
        return ok(JSON.stringify({ result }));
      });
    expect(listing(250).vpcServices()).toHaveLength(250);
    expect(pages).toEqual(["1", "2", "3"]);
    pages.length = 0;
    expect(listing(200).vpcServices()).toHaveLength(200);
    expect(pages).toEqual(["1", "2", "3"]);
    expect(() => listing(10_000).vpcServices()).toThrow("more than 50 pages");
    const odd = cliCloud(config, WORKER, () => ok(JSON.stringify({ result: {} })));
    expect(() => odd.vpcServices()).toThrow("unexpected listing");
  });

  it("refuses answers without IDs or tokens, and never repeats cf's output in an error", () => {
    const answering = (stdout: string) => cliCloud(config, WORKER, () => ok(stdout));
    expect(() => answering(JSON.stringify({ result: {} })).createTunnel("x")).toThrow(
      "Cloudflare Tunnel did not return an ID",
    );
    expect(() => answering(JSON.stringify({ result: {} })).createDnsRecord("h", "t", "c")).toThrow(
      "DNS did not return an ID",
    );
    expect(() =>
      answering(JSON.stringify({ result: { id: "x" } })).createVpcService("n", "t", 1),
    ).toThrow("Workers VPC did not return an ID");
    expect(() => answering(JSON.stringify({ result: null })).tunnelToken("t")).toThrow(
      "no Tunnel token",
    );
    // A JSON parse error would quote the text it failed on, here part of a token.
    const leaky = answering("token=synthetic-secret-value");
    for (const call of [() => leaky.tunnelToken("t"), () => leaky.createTunnel("x")]) {
      expect(call).toThrow("cf printed something other than JSON");
      try {
        call();
      } catch (error) {
        expect(String(error)).not.toContain("synthetic-secret-value");
      }
    }
  });

  it("returns the created application's ID and fails loudly on a CLI error", () => {
    expect(cloud.createAccessApp({ name: "cfo-stg-a" })).toBe("app-1");
    expect(cloud.accountIds()).toEqual(["a".repeat(32)]);
    const broken = cliCloud(config, WORKER, () => failed("│ [10000] Authentication error"));
    expect(() => broken.accountIds()).toThrow("Authentication error");
    expect(() => broken.deployWorker("cfo-stg-a", "h", "/c", 1)).toThrow("wrangler deploy exited");
  });

  it("pins the account and drops CLOUDFLARE_ENV for every child process", () => {
    process.env.CLOUDFLARE_ENV = "production";
    try {
      const env = childEnv("b".repeat(32));
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("b".repeat(32));
      expect(env.CLOUDFLARE_ENV).toBeUndefined();
    } finally {
      delete process.env.CLOUDFLARE_ENV;
    }
  });
});

describe("Wrangler's own reading of a configuration", () => {
  const write = (name: string, body: Record<string, unknown> | string): string => {
    const path = join(scratch, name);
    const base = { name: "x", main: "src/index.ts", compatibility_date: "2026-10-01" };
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify({ ...base, ...body }));
    return path;
  };
  const ACCOUNT = "a".repeat(32);
  const check = (path: string) =>
    validateDeployConfig(readWranglerConfig(path, WORKER), ACCOUNT, "cfo-stg-x");
  const closed = { workers_dev: false, preview_urls: false };

  it("accepts containers and buckets that carry the deployment's name, as Wrangler reads them", () => {
    const own = {
      ...closed,
      durable_objects: { bindings: [{ name: "HOST", class_name: "Host" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Host"] }],
      containers: [
        { name: "cfo-stg-x-host", class_name: "Host", image: "./Dockerfile", max_instances: 1 },
      ],
      r2_buckets: [{ binding: "DATA", bucket_name: "cfo-stg-x-data" }],
    };
    writeFileSync(join(scratch, "Dockerfile"), "FROM busybox:1.37\n"); // Wrangler checks it exists
    expect(() => check(write("own-resources.json", own))).not.toThrow();
    const foreign = { ...own, r2_buckets: [{ binding: "DATA", bucket_name: "production-data" }] };
    expect(() => check(write("foreign-bucket.json", foreign))).toThrow("bucket_name");
    const big = { ...own, containers: [{ ...own.containers[0], max_instances: 50 }] };
    expect(() => check(write("big-container.json", big))).toThrow("max_instances");
    const policy = {
      ...own,
      containers: [
        {
          name: "cfo-stg-x-computer",
          class_name: "Host",
          scheduling_policy: "durable_object",
          images: { computer: { dockerfile: "./Dockerfile" } },
        },
      ],
    };
    expect(() => check(write("policy.json", policy))).not.toThrow();
    const sshPolicy = {
      ...policy,
      containers: [{ ...policy.containers[0], ssh: { enabled: true } }],
    };
    expect(() => check(write("policy-ssh.json", sshPolicy))).toThrow('"ssh"');
  });

  it("accepts a Durable Object of another deployed deployment only with the registry", () => {
    const path = write("cross-script.json", {
      ...closed,
      durable_objects: {
        bindings: [{ name: "RUN", class_name: "RunDO", script_name: "cfo-stg-y" }],
      },
    });
    const y: Deployment = {
      name: "cfo-stg-y",
      hostname: "cfo-stg-y.example.com",
      owner: "lead",
      createdAt: "2026-10-20T12:00:00.000Z",
      expiresAt: "2026-10-22T12:00:00.000Z",
      state: "deployed",
    };
    const view = readWranglerConfig(path, WORKER);
    const registry = { owner: "lead", deployments: [y] };
    expect(() => validateDeployConfig(view, ACCOUNT, "cfo-stg-x", { registry })).not.toThrow();
    expect(() => check(path)).toThrow('"script_name"');
    expect(() =>
      validateDeployConfig(view, ACCOUNT, "cfo-stg-x", { registry: { ...registry, owner: "z" } }),
    ).toThrow("belongs to lead");
  });

  it("reads a rendered configuration's Tunnel route and VPC bindings as the tool wrote them", () => {
    const route = tunnelRoute("cfo-stg-x-tunnel.example.com", "example.com");
    const path = write("rendered.json", {
      ...closed,
      routes: [route],
      vpc_services: [{ binding: "X1_VPC", service_id: "0191dce4-9ab4-7fce-b660-8e5dec5172da" }],
    });
    const view = readWranglerConfig(path, WORKER);
    expect(view.effective.routes).toEqual([route]);
    const rendered = {
      routes: [route],
      vpcServiceIds: ["0191dce4-9ab4-7fce-b660-8e5dec5172da"],
    };
    expect(() => validateDeployConfig(view, ACCOUNT, "cfo-stg-x", { rendered })).not.toThrow();
    expect(() => check(path)).toThrow('"routes", "vpc_services"');
    expect(() =>
      validateDeployConfig(view, ACCOUNT, "cfo-stg-x", {
        rendered: { ...rendered, vpcServiceIds: ["x"] },
      }),
    ).toThrow("did not record");
  });

  it("reads the staging manifest next to a configuration, and writes private files", () => {
    const dir = mkdtempSync(join(scratch, "manifest-"));
    const configPath = join(dir, "wrangler.jsonc");
    expect(readStagingManifest(configPath)).toBeUndefined();
    writeFileSync(
      join(dir, "staging.jsonc"),
      '{\n  // X1\n  "tunnel": { "tokenSecret": "T", },\n}\n',
    );
    expect(readStagingManifest(configPath)).toEqual({
      path: join(dir, "staging.jsonc"),
      json: { tunnel: { tokenSecret: "T" } },
    });
    writeFileSync(join(dir, "staging.jsonc"), "{ nope");
    expect(() => readStagingManifest(configPath)).toThrow(
      `cannot parse ${join(dir, "staging.jsonc")}`,
    );
    const rendered = join(dir, ".stg-rendered.cfo-stg-x.jsonc");
    writePrivateFile(rendered, "{}");
    writePrivateFile(rendered, '{"a":1}'); // a leftover from a crashed run is replaced
    expect(readFileSync(rendered, "utf8")).toBe('{"a":1}');
    expect(statSync(rendered).mode & 0o777).toBe(0o600);
  });

  it("accepts the checked-in Worker configuration", () => {
    expect(() => check(join(WORKER, "wrangler.jsonc"))).not.toThrow();
  });

  it.each([
    ["workers.dev enabled", { ...closed, workers_dev: true }],
    ["preview URLs enabled", { ...closed, preview_urls: true }],
    ["alternate URLs left to their defaults", {}],
    ["a legacy route", { ...closed, route: "x.example.com/*" }],
    ["several routes", { ...closed, routes: ["a.example.com/*", "b.example.com/*"] }],
    [
      "an extra custom domain",
      { ...closed, routes: [{ pattern: "x.example.com", custom_domain: true }] },
    ],
    ["an environment", { ...closed, env: { staging: { workers_dev: true } } }],
    // Wrangler prefers a config's account_id to CLOUDFLARE_ACCOUNT_ID.
    ["another account", { ...closed, account_id: "b".repeat(32) }],
    [
      "an R2 bucket outside staging",
      { ...closed, r2_buckets: [{ binding: "DATA", bucket_name: "non-staging-data" }] },
    ],
    ["a service binding", { ...closed, services: [{ binding: "S", service: "prod" }] }],
    ["a KV namespace", { ...closed, kv_namespaces: [{ binding: "K", id: "0".repeat(32) }] }],
    [
      "a Durable Object in another Worker",
      {
        ...closed,
        durable_objects: { bindings: [{ name: "D", class_name: "D", script_name: "prod" }] },
      },
    ],
    [
      "a migration that takes another Worker's Durable Objects",
      {
        ...closed,
        migrations: [
          {
            tag: "v1",
            transferred_classes: [{ from: "P", from_script: "production-worker", to: "I" }],
          },
        ],
      },
    ],
    [
      "a log export destination",
      { ...closed, observability: { logs: { enabled: true, destinations: ["prod-sink"] } } },
    ],
  ])("refuses %s", (label, body) => {
    expect(() => check(write(`${label.replaceAll(" ", "-")}.json`, body))).toThrow(
      "refusing Wrangler config",
    );
  });

  it("reads JSONC the way Wrangler does, including comments and repeated keys", () => {
    const path = write(
      "repeated.jsonc",
      `{
        // the later key wins in Wrangler's parser
        "name": "x", "main": "src/index.ts", "compatibility_date": "2026-10-01",
        "workers_dev": false, "preview_urls": false, "workers_dev": true,
      }`,
    );
    expect(() => check(path)).toThrow('"workers_dev" must be false');
  });

  it("refuses missing files, other formats, and a selected environment", () => {
    expect(() => readWranglerConfig(join(scratch, "missing.jsonc"), WORKER)).toThrow("no Wrangler");
    expect(() => readWranglerConfig(write("wrangler.toml", "name = 'x'"), WORKER)).toThrow(
      "no Wrangler",
    );
    process.env.CLOUDFLARE_ENV = "staging";
    try {
      expect(() => readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER)).toThrow(
        "CLOUDFLARE_ENV",
      );
    } finally {
      delete process.env.CLOUDFLARE_ENV;
    }
  });
});

describe("registry file store", () => {
  it("writes atomically, readable by the owner only", () => {
    const file = join(scratch, "state", "resources.json");
    const store = fileStore(file, "test");
    expect(store.load()).toEqual([]);
    const d: Deployment = {
      name: "cfo-stg-a",
      hostname: "cfo-stg-a.example.com",
      owner: "wp0.4",
      createdAt: "2026-10-18T12:00:00.000Z",
      expiresAt: "2026-10-25T12:00:00.000Z",
      state: "pending",
    };
    store.update((all) => [...all, d]);
    expect(store.load()).toEqual([d]);
    // A failed change leaves the registry as it was and releases the registry lock.
    expect(() =>
      store.update(() => {
        throw new Error("change failed");
      }),
    ).toThrow("change failed");
    expect(store.load()).toEqual([d]);
    store.update((all) => all);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(3);
  });
});
