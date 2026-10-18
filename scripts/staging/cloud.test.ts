import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type CommandResult,
  childEnv,
  childStdio,
  cliCloud,
  fileStore,
  type RunOptions,
  readWranglerConfig,
  workerLookup,
  wranglerCli,
} from "./cloud.ts";
import { type Deployment, validateDeployConfig } from "./guard.ts";
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
    cloud.deployWorker("cfo-stg-a", "cfo-stg-a.example.com", "/w/wrangler.jsonc");
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
      options: { inherit: true, cwd: WORKER },
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

  it("returns the created application's ID and fails loudly on a CLI error", () => {
    expect(cloud.createAccessApp({ name: "cfo-stg-a" })).toBe("app-1");
    expect(cloud.accountIds()).toEqual(["a".repeat(32)]);
    const broken = cliCloud(config, WORKER, () => failed("│ [10000] Authentication error"));
    expect(() => broken.accountIds()).toThrow("Authentication error");
    expect(() => broken.deployWorker("cfo-stg-a", "h", "/c")).toThrow("wrangler deploy exited");
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
  const check = (path: string) => validateDeployConfig(readWranglerConfig(path, WORKER), ACCOUNT);
  const closed = { workers_dev: false, preview_urls: false };

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
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(2);
  });
});
