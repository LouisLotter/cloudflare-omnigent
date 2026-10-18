// Guarded staging tool. Every staging resource is named cfo-stg-<suffix>, protected by an
// owner-only Access application before any traffic can reach it, recorded with an owner and
// an expiry, and torn down only if this tool created it.
//
//   node scripts/staging/stg.ts init --account <id> --zone <zone> --owner-email <email> [--idp <id>]
//   node scripts/staging/stg.ts check
//   node scripts/staging/stg.ts deploy --suffix <s> --owner <wp> [--config worker/wrangler.jsonc] [--days 7]
//   node scripts/staging/stg.ts list
//   node scripts/staging/stg.ts teardown --suffix <s>
//   node scripts/staging/stg.ts sweep [--yes]
//
// Account ID, zone and owner email live in .staging/config.json, which is never committed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  accessAppBody,
  assertAccount,
  assertManaged,
  expired,
  expiry,
  hostnameFor,
  resourceName,
  type StagingConfig,
  type StagingResource,
  teardownOrder,
} from "./guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE = join(ROOT, ".staging");
const CONFIG_FILE = join(STATE, "config.json");
const REGISTRY_FILE = join(STATE, "resources.json");

function loadConfig(): StagingConfig {
  if (!existsSync(CONFIG_FILE)) throw new Error("no staging config; run `stg.ts init` first");
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StagingConfig;
}

function loadRegistry(): StagingResource[] {
  return existsSync(REGISTRY_FILE)
    ? (JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as StagingResource[])
    : [];
}

function saveRegistry(resources: StagingResource[]): void {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  writeFileSync(REGISTRY_FILE, `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 });
}

function cf(config: StagingConfig, args: string[]): string {
  return execFileSync("cf", args, {
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
  });
}

function wrangler(config: StagingConfig, args: string[]): void {
  execFileSync("pnpm", ["--dir", join(ROOT, "worker"), "exec", "wrangler", ...args], {
    stdio: "inherit",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
  });
}

function resultOf(raw: string): unknown {
  const parsed = JSON.parse(raw) as { result?: unknown };
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
}

function checkAccount(config: StagingConfig): void {
  const accounts = resultOf(cf(config, ["accounts", "list"])) as { id: string }[];
  assertAccount(
    config.accountId,
    accounts.map((a) => a.id),
  );
}

function findAccessApp(config: StagingConfig, hostname: string): string | undefined {
  const apps = resultOf(cf(config, ["zero-trust", "access", "applications", "list"])) as {
    id: string;
    domain: string;
  }[];
  return apps.find((app) => app.domain === hostname)?.id;
}

function deploy(args: { suffix: string; owner: string; config: string; days: number }): void {
  const config = loadConfig();
  checkAccount(config);
  const name = resourceName(args.suffix);
  const hostname = hostnameFor(name, config.zone);
  const registry = loadRegistry();
  const now = new Date();
  const expiresAt = expiry(now, args.days);

  // Access first: the hostname must never serve traffic without the owner-only gate.
  let appId = findAccessApp(config, hostname);
  if (!appId) {
    const body = JSON.stringify(accessAppBody(name, hostname, config));
    const created = resultOf(
      cf(config, ["zero-trust", "access", "applications", "create", "--body", body]),
    ) as { id: string };
    appId = created.id;
    registry.push({
      kind: "access-app",
      name,
      id: appId,
      hostname,
      owner: args.owner,
      createdAt: now.toISOString(),
      expiresAt,
    });
    saveRegistry(registry);
    console.log(`created Access application for ${hostname}`);
  } else if (!registry.some((r) => r.kind === "access-app" && r.id === appId)) {
    throw new Error(`${hostname} already has an Access application this tool did not create`);
  }

  wrangler(config, [
    "deploy",
    "--config",
    resolve(args.config),
    "--name",
    name,
    "--domain",
    hostname,
  ]);
  if (!registry.some((r) => r.kind === "worker" && r.name === name)) {
    registry.push({
      kind: "worker",
      name,
      hostname,
      owner: args.owner,
      createdAt: now.toISOString(),
      expiresAt,
    });
    saveRegistry(registry);
  }
  console.log(`deployed ${name} at https://${hostname} (expires ${expiresAt})`);
}

function teardown(resources: StagingResource[]): void {
  const config = loadConfig();
  checkAccount(config);
  let registry = loadRegistry();
  for (const resource of teardownOrder(resources)) {
    assertManaged(resource.name);
    if (resource.kind === "worker") {
      wrangler(config, ["delete", "--name", resource.name, "--force"]);
    } else if (resource.id) {
      cf(config, ["zero-trust", "access", "applications", "delete", resource.id]);
    }
    registry = registry.filter((r) => !(r.kind === resource.kind && r.name === resource.name));
    saveRegistry(registry);
    console.log(`removed ${resource.kind} ${resource.name}`);
  }
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      account: { type: "string" },
      zone: { type: "string" },
      "owner-email": { type: "string" },
      idp: { type: "string" },
      suffix: { type: "string" },
      owner: { type: "string" },
      config: { type: "string", default: join(ROOT, "worker", "wrangler.jsonc") },
      days: { type: "string", default: "7" },
      yes: { type: "boolean", default: false },
    },
  });

  switch (command) {
    case "init": {
      if (!values.account || !values.zone || !values["owner-email"]) {
        throw new Error("init needs --account, --zone and --owner-email");
      }
      const config: StagingConfig = {
        accountId: values.account,
        zone: values.zone,
        ownerEmail: values["owner-email"],
        ...(values.idp ? { identityProviderId: values.idp } : {}),
      };
      mkdirSync(STATE, { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      checkAccount(config);
      console.log("staging config written to .staging/config.json");
      return;
    }
    case "check": {
      const config = loadConfig();
      checkAccount(config);
      console.log(
        `staging account accessible; zone ${config.zone}; ${loadRegistry().length} resources`,
      );
      return;
    }
    case "deploy": {
      if (!values.suffix || !values.owner) throw new Error("deploy needs --suffix and --owner");
      deploy({
        suffix: values.suffix,
        owner: values.owner,
        config: values.config,
        days: Number(values.days),
      });
      return;
    }
    case "list": {
      for (const r of loadRegistry()) {
        console.log(
          `${r.kind.padEnd(10)} ${r.name.padEnd(32)} owner=${r.owner} expires=${r.expiresAt}`,
        );
      }
      return;
    }
    case "teardown": {
      if (!values.suffix) throw new Error("teardown needs --suffix");
      const name = resourceName(values.suffix);
      const matches = loadRegistry().filter((r) => r.name === name);
      if (matches.length === 0) throw new Error(`no recorded resources named ${name}`);
      teardown(matches);
      return;
    }
    case "sweep": {
      const due = expired(loadRegistry(), new Date());
      for (const r of due) console.log(`expired: ${r.kind} ${r.name} (owner ${r.owner})`);
      if (due.length && values.yes) teardown(due);
      else if (due.length) console.log("re-run with --yes to remove them");
      return;
    }
    default:
      throw new Error(
        "usage: stg.ts init|check|deploy|list|teardown|sweep (see the header comment)",
      );
  }
}

try {
  main();
} catch (error) {
  console.error(`stg: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
