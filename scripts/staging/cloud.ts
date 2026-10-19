// The real ports for ops.ts: the `cf` CLI for the Cloudflare API, Wrangler for Worker uploads,
// Wrangler's own config reader, and the registry file in the staging state directory.

import { type StdioOptions, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type AccessApp,
  type DeployConfigView,
  parseRegistry,
  type StagingConfig,
  serializeRegistry,
} from "./guard.ts";
import { acquireLock, heldLockFds } from "./lock.ts";
import type { Cloud, Store } from "./ops.ts";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Show the command's output to the user instead of capturing it. */
  readonly inherit: boolean;
  readonly cwd?: string;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => CommandResult;

/**
 * The environment for every child process. It pins the account, and drops CLOUDFLARE_ENV so
 * that Wrangler deploys the top-level configuration that validateDeployConfig checked.
 */
export function childEnv(accountId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  delete env.CLOUDFLARE_ENV;
  return env;
}

/**
 * stdio for a child process. Descriptors 3 and up are the staging locks this process holds,
 * so a child that outlives a crashed staging command keeps its deployment locked.
 */
export function childStdio(inherit: boolean): StdioOptions {
  const mode = inherit ? "inherit" : "pipe";
  return ["ignore", mode, mode, ...heldLockFds()];
}

function spawnRunner(accountId: string): Runner {
  return (command, args, options) => {
    const child = spawnSync(command, args, {
      encoding: "utf8",
      env: childEnv(accountId),
      stdio: childStdio(options.inherit),
      maxBuffer: 64 * 1024 * 1024,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    if (child.error) throw child.error;
    return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
  };
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^[│┌└\s]+/, "").trim())
      .find((line) => line !== "" && line !== "APIError") ?? "no output"
  );
}

function resultOf(stdout: string): unknown {
  const parsed = JSON.parse(stdout) as { result?: unknown };
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
}

/**
 * Reads `cf workers get <name>`. Only a successful lookup of that exact name or Cloudflare's
 * "does not exist" answer count; anything else is unknown and throws.
 */
export function workerLookup(result: CommandResult, name: string): boolean {
  if (result.status === 0) {
    const worker = resultOf(result.stdout) as { name?: unknown } | null;
    if (worker?.name === name) return true;
    throw new Error(`unexpected answer when looking up Worker ${name}`);
  }
  if (result.stderr.includes("[10007]") && result.stderr.includes("404 Not Found")) return false;
  throw new Error(`could not tell whether Worker ${name} exists: ${firstLine(result.stderr)}`);
}

/**
 * Reads `cf r2 buckets get <name>`, like workerLookup: only a successful lookup of that bucket or
 * R2's "no such bucket" answer ([10006], 404) count; anything else is unknown and throws.
 */
export function bucketLookup(result: CommandResult, name: string): boolean {
  if (result.status === 0) {
    const bucket = resultOf(result.stdout) as { name?: unknown } | null;
    if (bucket?.name === name) return true;
    throw new Error(`unexpected answer when looking up R2 bucket ${name}`);
  }
  if (result.stderr.includes("[10006]") && result.stderr.includes("404 Not Found")) return false;
  throw new Error(`could not tell whether R2 bucket ${name} exists: ${firstLine(result.stderr)}`);
}

/**
 * The `repository:tag` references in `cf containers images list` that belong to exactly this
 * repository. Entries are either such references or objects with a name and tags.
 */
export function imagesOf(listing: unknown, repository: string): string[] {
  if (!Array.isArray(listing)) throw new Error("unexpected image listing from the registry");
  const references: string[] = [];
  for (const entry of listing) {
    if (typeof entry === "string") {
      references.push(entry);
      continue;
    }
    const image = entry as { name?: unknown; repository?: unknown; tags?: unknown } | null;
    const repo = image?.name ?? image?.repository;
    if (typeof repo !== "string" || !Array.isArray(image?.tags)) {
      throw new Error("unexpected image entry from the registry");
    }
    for (const tag of image.tags) references.push(`${repo}:${String(tag)}`);
  }
  // A reference may carry the registry host and account: registry.cloudflare.com/<id>/<repo>:<tag>.
  return references.filter((reference) => {
    const path = reference.slice(0, reference.lastIndexOf(":"));
    return path === repository || path.endsWith(`/${repository}`);
  });
}

/**
 * Wrangler's CLI entry point. Wrangler's own launcher re-spawns this file with only stdio and
 * an IPC channel, which would drop the lock descriptors, so the staging tool runs it directly.
 */
export function wranglerCli(workerDir: string): string {
  const wranglerPackage = createRequire(join(workerDir, "package.json")).resolve(
    "wrangler/package.json",
  );
  return join(dirname(wranglerPackage), "wrangler-dist", "cli.js");
}

export function cliCloud(config: StagingConfig, workerDir: string, runner?: Runner): Cloud {
  const run = runner ?? spawnRunner(config.accountId);
  const cf = (args: string[]): unknown => {
    const result = run("cf", args, { inherit: false });
    if (result.status !== 0) throw new Error(`cf ${args[0]} failed: ${firstLine(result.stderr)}`);
    return resultOf(result.stdout);
  };
  const wrangler = (args: string[], cwd: string): void => {
    const cli = ["--no-warnings", wranglerCli(workerDir), ...args];
    const result = run(process.execPath, cli, { inherit: true, cwd });
    if (result.status !== 0) throw new Error(`wrangler ${args[0]} exited with ${result.status}`);
  };
  return {
    accountIds: () => (cf(["accounts", "list"]) as { id: string }[]).map((a) => a.id),
    listAccessApps: (hostname) =>
      cf([
        "zero-trust",
        "access",
        "applications",
        "list",
        "--domain",
        hostname,
        "--exact",
      ]) as AccessApp[],
    createAccessApp: (body) => {
      const created = cf([
        "zero-trust",
        "access",
        "applications",
        "create",
        "--body",
        JSON.stringify(body),
      ]) as { id?: unknown };
      if (typeof created?.id !== "string") throw new Error("Access did not return an app ID");
      return created.id;
    },
    // --force skips cf's interactive confirmation; the child has no terminal to answer it.
    deleteAccessApp: (id) => {
      cf(["zero-trust", "access", "applications", "delete", id, "--force"]);
    },
    workerExists: (name) =>
      workerLookup(run("cf", ["workers", "get", name], { inherit: false }), name),
    // validateDeployConfig has checked this configuration's account, routes and resources.
    deployWorker: (name, hostname, configPath) =>
      wrangler(["deploy", "--config", configPath, "--name", name, "--domain", hostname], workerDir),
    // Wrangler prefers a configuration's account_id to CLOUDFLARE_ACCOUNT_ID, and without
    // --config it reads whatever configuration its working directory holds. A generated
    // configuration in an empty directory pins the staging account.
    deleteWorker: (name) => {
      const dir = mkdtempSync(join(tmpdir(), "cfo-stg-delete-"));
      try {
        const file = join(dir, "wrangler.json");
        writeFileSync(file, JSON.stringify({ name, account_id: config.accountId }), {
          mode: 0o600,
        });
        wrangler(["delete", "--config", file, "--name", name, "--force"], dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    bucketExists: (name) =>
      bucketLookup(run("cf", ["r2", "buckets", "get", name], { inherit: false }), name),
    createBucket: (name) => {
      cf(["r2", "buckets", "create", "--body", JSON.stringify({ name })]);
    },
    // R2 deletes only an empty bucket. List a page, delete it, repeat until nothing is left.
    emptyAndDeleteBucket: (name) => {
      for (let page = 0; page < 10_000; page++) {
        const listed = cf(["r2", "objects", "list", "--bucket-name", name, "--per-page", "1000"]);
        const keys = (Array.isArray(listed) ? listed : [])
          .map((o) => (o as { key?: unknown }).key)
          .filter((k): k is string => typeof k === "string");
        if (keys.length === 0) break;
        cf([
          "r2",
          "objects",
          "bulk-delete",
          "--bucket-name",
          name,
          "--body",
          JSON.stringify(keys),
          "--force",
        ]);
      }
      cf(["r2", "buckets", "delete", name, "--force"]);
    },
    containerApps: (name) => {
      const apps = cf(["containers", "applications", "list", "--name", name]);
      if (!Array.isArray(apps)) throw new Error("unexpected container application listing");
      return apps
        .filter((a) => (a as { name?: unknown }).name === name)
        .map((a) => String((a as { id?: unknown }).id));
    },
    deleteContainerApp: (id) => {
      cf(["containers", "applications", "delete", id, "--force"]);
    },
    containerImages: (repository) => imagesOf(cf(["containers", "images", "list"]), repository),
    deleteContainerImage: (reference) => {
      cf(["containers", "images", "delete", reference, "--force"]);
    },
  };
}

interface WranglerApi {
  experimental_readRawConfig(args: { config: string }): {
    rawConfig: Record<string, unknown>;
    configPath?: string;
    redirected: boolean;
  };
  unstable_readConfig(
    args: { config: string },
    options: { hideWarnings: boolean },
  ): DeployConfigView["effective"];
}

/** Reads a Wrangler configuration with the installed Wrangler, exactly as `deploy` will. */
export function readWranglerConfig(path: string, workerDir: string): DeployConfigView {
  if (process.env.CLOUDFLARE_ENV !== undefined) {
    throw new Error("CLOUDFLARE_ENV is set; the staging tool deploys top-level configs only");
  }
  const absolute = resolve(path);
  if (!/\.jsonc?$/.test(absolute) || !existsSync(absolute)) {
    throw new Error(`no Wrangler JSON config at ${absolute}`);
  }
  const wrangler = createRequire(join(workerDir, "package.json"))("wrangler") as WranglerApi;
  const raw = wrangler.experimental_readRawConfig({ config: absolute });
  if (raw.configPath !== absolute) throw new Error(`Wrangler did not read ${absolute}`);
  return {
    path: absolute,
    redirected: raw.redirected,
    raw: raw.rawConfig,
    effective: wrangler.unstable_readConfig({ config: absolute }, { hideWarnings: true }),
  };
}

/**
 * The registry file. Each update holds the registry lock for its read-modify-write, and writes
 * to a temporary file first, so neither a concurrent command nor a crash loses or tears it.
 */
export function fileStore(file: string, holder: string): Store {
  const load = () =>
    existsSync(file) ? parseRegistry(JSON.parse(readFileSync(file, "utf8")) as unknown) : [];
  return {
    load,
    update: (change) => {
      const release = acquireLock(`${file}.lock`, 30, holder);
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, serializeRegistry(change(load())), { mode: 0o600 });
        renameSync(temporary, file);
      } finally {
        release();
      }
    },
  };
}
