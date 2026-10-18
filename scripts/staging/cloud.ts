// The real ports for ops.ts: the `cf` CLI for the Cloudflare API, Wrangler for Worker uploads,
// Wrangler's own config reader, and the registry file under .staging/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import {
  type AccessApp,
  type DeployConfigView,
  parseRegistry,
  type StagingConfig,
  serializeRegistry,
} from "./guard.ts";
import type { Cloud, Store } from "./ops.ts";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (command: string, args: readonly string[], inherit: boolean) => CommandResult;

/**
 * The environment for every child process. It pins the account, and drops CLOUDFLARE_ENV so
 * that Wrangler deploys the top-level configuration that validateDeployConfig checked.
 */
export function childEnv(accountId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  delete env.CLOUDFLARE_ENV;
  return env;
}

function spawnRunner(accountId: string): Runner {
  return (command, args, inherit) => {
    const child = spawnSync(command, args, {
      encoding: "utf8",
      env: childEnv(accountId),
      stdio: inherit ? "inherit" : "pipe",
      maxBuffer: 64 * 1024 * 1024,
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

export function cliCloud(config: StagingConfig, workerDir: string, runner?: Runner): Cloud {
  const run = runner ?? spawnRunner(config.accountId);
  const cf = (args: string[]): unknown => {
    const result = run("cf", args, false);
    if (result.status !== 0) throw new Error(`cf ${args[0]} failed: ${firstLine(result.stderr)}`);
    return resultOf(result.stdout);
  };
  const wrangler = (args: string[]): void => {
    const result = run("pnpm", ["--dir", workerDir, "exec", "wrangler", ...args], true);
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
    deleteAccessApp: (id) => {
      cf(["zero-trust", "access", "applications", "delete", id]);
    },
    workerExists: (name) => workerLookup(run("cf", ["workers", "get", name], false), name),
    deployWorker: (name, hostname, configPath) =>
      wrangler(["deploy", "--config", configPath, "--name", name, "--domain", hostname]),
    deleteWorker: (name) => wrangler(["delete", "--name", name, "--force"]),
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

/** The registry file. Writes go to a temporary file first, so a crash never leaves half of one. */
export function fileStore(file: string): Store {
  return {
    load: () =>
      existsSync(file) ? parseRegistry(JSON.parse(readFileSync(file, "utf8")) as unknown) : [],
    save: (deployments) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, serializeRegistry(deployments), { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
