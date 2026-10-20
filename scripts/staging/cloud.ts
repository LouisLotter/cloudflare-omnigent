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
  type DnsRecordInfo,
  type IngressRule,
  MANIFEST_FILE,
  parseJsonc,
  parseRegistry,
  type StagingConfig,
  serializeRegistry,
  type TunnelInfo,
  VPC_HOST,
  type VpcServiceInfo,
} from "./guard.ts";
import { acquireLock, heldLockFds } from "./lock.ts";
import type { Cloud, NameFilter, Store } from "./ops.ts";

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** Show the command's output to the user instead of capturing it. */
  readonly inherit: boolean;
  readonly cwd?: string;
  /** Added to the child's environment. */
  readonly env?: Readonly<Record<string, string>>;
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
      env: { ...childEnv(accountId), ...options.env },
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

/**
 * The `result` of cf's JSON output, or the output itself. Some answers carry secrets (a new
 * Tunnel's token, for one), and a JSON parse error quotes the text it failed on, so that error
 * is replaced, never passed on.
 */
function resultOf(stdout: string): unknown {
  let parsed: { result?: unknown };
  try {
    parsed = JSON.parse(stdout) as { result?: unknown };
  } catch {
    throw new Error("cf printed something other than JSON");
  }
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

function entries(listing: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(listing)) throw new Error(`unexpected ${what} listing from cf`);
  return listing.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`unexpected ${what} entry from cf`);
    }
    return entry as Record<string, unknown>;
  });
}

function text(entry: Record<string, unknown>, key: string, what: string): string {
  const value = entry[key];
  if (typeof value !== "string" || value === "") throw new Error(`${what} without a ${key}`);
  return value;
}

/** The Cloudflare Tunnels in a `cf tunnels list` page that exist: not deleted, cloudflared. */
export function tunnelsOf(listing: unknown): TunnelInfo[] {
  return entries(listing, "Tunnel").flatMap((t) => {
    const tunnel = { id: text(t, "id", "a Tunnel"), name: text(t, "name", "a Tunnel") };
    const live = (t.deleted_at ?? null) === null && (t.tun_type ?? "cfd_tunnel") === "cfd_tunnel";
    return live ? [tunnel] : [];
  });
}

/** The ingress rules of `cf tunnels config get`; [] when the Tunnel has no configuration yet. */
export function ingressOf(answer: unknown): IngressRule[] {
  const config = (answer as { config?: unknown } | null)?.config;
  if (config === undefined || config === null) return [];
  const ingress = (config as { ingress?: unknown }).ingress;
  if (ingress === undefined || ingress === null) return [];
  return entries(ingress, "ingress rule").map((rule) => ({
    ...(typeof rule.hostname === "string" ? { hostname: rule.hostname } : {}),
    ...(typeof rule.path === "string" ? { path: rule.path } : {}),
    service: text(rule, "service", "an ingress rule"),
  }));
}

export function dnsRecordsOf(listing: unknown): DnsRecordInfo[] {
  return entries(listing, "DNS record").map((r) => ({
    id: text(r, "id", "a DNS record"),
    name: text(r, "name", "a DNS record"),
    type: text(r, "type", "a DNS record"),
    content: typeof r.content === "string" ? r.content : "",
    proxied: r.proxied === true,
  }));
}

/** Workers VPC services, flattened; an IPv4 host on a Tunnel is the only kind the tool makes. */
export function vpcServicesOf(listing: unknown): VpcServiceInfo[] {
  return entries(listing, "VPC service").map((s) => {
    const host = (s.host ?? {}) as { ipv4?: unknown; network?: { tunnel_id?: unknown } };
    return {
      id: text(s, "service_id", "a VPC service"),
      name: text(s, "name", "a VPC service"),
      ...(typeof s.type === "string" ? { type: s.type } : {}),
      ...(typeof host.ipv4 === "string" ? { ipv4: host.ipv4 } : {}),
      ...(typeof host.network?.tunnel_id === "string" ? { tunnelId: host.network.tunnel_id } : {}),
      ...(typeof s.http_port === "number" ? { httpPort: s.http_port } : {}),
      ...(typeof s.https_port === "number" ? { httpsPort: s.https_port } : {}),
    };
  });
}

/**
 * The directory for a short-lived secrets file: the user's runtime directory, which is private
 * and in memory on most Linux systems, or else the system's temporary directory.
 */
function secretsBase(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime !== undefined && runtime !== "" && existsSync(runtime) ? runtime : tmpdir();
}

/**
 * Runs `use` with the secrets in a JSON file, mode 0600, in a new directory only this user can
 * enter, and removes both afterwards, whatever happens. The values never reach argv or a log.
 */
export function withSecretsFile<T>(
  secrets: Readonly<Record<string, string>>,
  use: (file: string) => T,
): T {
  const dir = mkdtempSync(join(secretsBase(), "cfo-stg-secrets-"));
  try {
    const file = join(dir, "secrets.json");
    writeFileSync(file, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });
    return use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const wrangler = (args: string[], cwd: string, env: Record<string, string> = {}): void => {
    const cli = ["--no-warnings", wranglerCli(workerDir), ...args];
    const result = run(process.execPath, cli, { inherit: true, cwd, env });
    if (result.status !== 0) throw new Error(`wrangler ${args[0]} exited with ${result.status}`);
  };
  // cf returns one page of a listing. Ask for pages until a short one; a listing that never
  // ends is an error, not a reason to act on part of it.
  const PER_PAGE = 100;
  const listAll = (args: string[]): unknown[] => {
    const all: unknown[] = [];
    for (let page = 1; page <= 50; page++) {
      const listed = cf([...args, "--per-page", String(PER_PAGE), "--page", String(page)]);
      if (!Array.isArray(listed)) throw new Error(`unexpected listing from cf ${args[0]}`);
      all.push(...listed);
      if (listed.length < PER_PAGE) return all;
    }
    throw new Error(`cf ${args[0]} listed more than 50 pages`);
  };
  // cf's list filters are only a first cut: cf 1.0.0-beta.18 silently ignores a dotted flag such
  // as --name.exact, the name `cf schema` gives, so every answer is filtered again here.
  const named = <T extends { name: string }>(found: T[], filter: NameFilter): T[] =>
    found.filter((r) =>
      "name" in filter ? r.name === filter.name : r.name.startsWith(filter.prefix),
    );
  const nameArgs = (filter: NameFilter, exact: string, prefix: string): string[] =>
    "name" in filter ? [exact, filter.name] : [prefix, filter.prefix];
  const zone = ["--zone", config.zone];
  const created = (answer: unknown, key: string, what: string): string => {
    const id = (answer as Record<string, unknown> | null)?.[key];
    if (typeof id !== "string" || id === "") throw new Error(`${what} did not return an ID`);
    return id;
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
    updateAccessApp: (id, body) => {
      cf(["zero-trust", "access", "applications", "update", id, "--body", JSON.stringify(body)]);
    },
    // --force skips cf's interactive confirmation; the child has no terminal to answer it.
    deleteAccessApp: (id) => {
      cf(["zero-trust", "access", "applications", "delete", id, "--force"]);
    },
    workerExists: (name) =>
      workerLookup(run("cf", ["workers", "get", name], { inherit: false }), name),
    // validateDeployConfig has checked this configuration's account, routes and resources.
    // Wrangler runs `docker build` with its own environment, and BuildKit takes the image
    // timestamp from SOURCE_DATE_EPOCH. Secrets go up with the same version through
    // --secrets-file, so no second version is made; Wrangler prints their names only.
    deployWorker: (name, hostname, configPath, buildEpoch, secrets) => {
      const args = ["deploy", "--config", configPath, "--name", name, "--domain", hostname];
      const env = { SOURCE_DATE_EPOCH: String(buildEpoch) };
      if (secrets === undefined || Object.keys(secrets).length === 0) {
        wrangler(args, workerDir, env);
        return;
      }
      withSecretsFile(secrets, (file) =>
        wrangler([...args, "--secrets-file", file], workerDir, env),
      );
    },
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
    tunnels: (filter) =>
      named(
        tunnelsOf(
          listAll([
            "tunnels",
            "list",
            ...nameArgs(filter, "--name", "--include-prefix"),
            "--is-deleted",
            "false",
            "--tun-types",
            "cfd_tunnel",
          ]),
        ),
        filter,
      ),
    // The answer also holds the Tunnel's token and secret; only the ID is kept.
    createTunnel: (name) =>
      created(
        cf(["tunnels", "create", "--body", JSON.stringify({ name, config_src: "cloudflare" })]),
        "id",
        "Cloudflare Tunnel",
      ),
    tunnelIngress: (id) => ingressOf(cf(["tunnels", "config", "get", id])),
    putTunnelIngress: (id, ingress) => {
      cf(["tunnels", "config", "update", id, "--body", JSON.stringify({ config: { ingress } })]);
    },
    tunnelToken: (id) => {
      const token = cf(["tunnels", "token", "get", id]);
      if (typeof token !== "string" || token === "") {
        throw new Error("Cloudflare returned no Tunnel token");
      }
      return token;
    },
    // A Tunnel with connections cannot be deleted. Its connectors stopped with the containers,
    // but Cloudflare may still list their connections, so remove them first. The delete
    // decides: if the cleanup failed and the delete still works, nothing was in the way.
    deleteTunnel: (id) => {
      let cleanup: unknown;
      try {
        cf(["tunnels", "connections", "cleanup", id, "--force"]);
      } catch (error) {
        cleanup = error;
      }
      try {
        cf(["tunnels", "delete", id, "--force"]);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : error}`, { cause: cleanup });
      }
    },
    dnsRecords: (filter) =>
      named(
        dnsRecordsOf(
          listAll([
            "dns",
            "records",
            "list",
            ...zone,
            ...nameArgs(filter, "--name-exact", "--name-startswith"),
          ]),
        ),
        filter,
      ),
    createDnsRecord: (name, target, comment) =>
      created(
        cf([
          "dns",
          "records",
          "create",
          ...zone,
          "--body",
          JSON.stringify({ type: "CNAME", name, content: target, proxied: true, ttl: 1, comment }),
        ]),
        "id",
        "DNS",
      ),
    deleteDnsRecord: (id) => {
      cf(["dns", "records", "delete", id, ...zone, "--force"]);
    },
    vpcServices: () => vpcServicesOf(listAll(["workers-vpc", "services", "list"])),
    createVpcService: (name, tunnelId, port) =>
      created(
        cf([
          "workers-vpc",
          "services",
          "create",
          "--body",
          JSON.stringify({
            type: "http",
            name,
            http_port: port,
            host: { ipv4: VPC_HOST, network: { tunnel_id: tunnelId } },
          }),
        ]),
        "service_id",
        "Workers VPC",
      ),
    deleteVpcService: (id) => {
      cf(["workers-vpc", "services", "delete", id, "--force"]);
    },
  };
}

/** The staging manifest next to a Wrangler configuration, parsed, or undefined without one. */
export function readStagingManifest(
  configPath: string,
): { path: string; json: unknown } | undefined {
  const path = join(dirname(resolve(configPath)), MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return { path, json: parseJsonc(readFileSync(path, "utf8")) };
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

/** Writes a rendered configuration afresh, readable by the owner only. */
export function writePrivateFile(path: string, text: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, text, { mode: 0o600, flag: "wx" });
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
