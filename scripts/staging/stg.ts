// Guarded staging tool. Every staging deployment is named cfo-stg-<suffix>, protected by an
// owner-only Access application before any traffic can reach it, recorded with an owner and
// an expiry, and torn down only if this tool created it. The rules are in guard.ts and the
// orchestration, with its invariants, in ops.ts.
//
//   node scripts/staging/stg.ts init --account <id> --zone <zone> --owner-email <email> [--idp <id>]
//   node scripts/staging/stg.ts check
//   node scripts/staging/stg.ts deploy --suffix <s> --owner <wp> [--config worker/wrangler.jsonc] [--days 7]
//   node scripts/staging/stg.ts list
//   node scripts/staging/stg.ts teardown --suffix <s>
//   node scripts/staging/stg.ts sweep [--yes]
//
// sweep lists expired deployments (removed with --yes) and reports staging Tunnels, VPC
// services and DNS records that no record owns, which it never removes.
//
// A Durable Object binding may name another deployment in script_name if the registry shows it
// deployed and owned by the same --owner. Anything a Wrangler configuration cannot declare goes
// in an optional staging manifest, staging.jsonc, next to it. It applies to every configuration
// in that directory, and without it deploy runs as before:
//
//   {
//     "tunnel": {                           // a remotely managed Tunnel named after the deployment
//       "publicHostname": true,             // <deployment>-tunnel.<zone>, with its own owner-only
//                                           // Access, a DNS record and a route to the Worker
//       "origin": "http://localhost:8081",  // that hostname's ingress service
//       "tokenSecret": "X1_TUNNEL_TOKEN"    // the Worker secret that receives the connector token
//     },
//     "vpcServices": [{ "binding": "X1_VPC", "port": 8081 }]  // HTTP to 127.0.0.1:<port>
//   }
//
// The tool deploys a rendered copy of the configuration with the route and VPC bindings added,
// .stg-rendered.<deployment>.jsonc next to it, and removes it afterwards.
//
// State lives outside the repository, so that every worktree on this laptop shares one
// registry and one set of locks: $CFO_STAGING_DIR, or ~/.config/cloudflare-omnigent/staging.
// It holds config.json (account ID, zone, owner email), resources.json and locks/. None of it
// is ever committed.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  cliCloud,
  fileStore,
  readStagingManifest,
  readWranglerConfig,
  removeStaleSecretDirs,
  writePrivateFile,
} from "./cloud.ts";
import { assertAccount, resourceName, type StagingConfig } from "./guard.ts";
import { acquireLock, sleepSync } from "./lock.ts";
import { type Context, deploy, sweep, teardown } from "./ops.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(ROOT, "worker");
const STATE = resolve(
  process.env.CFO_STAGING_DIR ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "cloudflare-omnigent",
      "staging",
    ),
);
const CONFIG_FILE = join(STATE, "config.json");
const REGISTRY_FILE = join(STATE, "resources.json");
/**
 * How long an upload whose Wrangler process has ended may still take effect at Cloudflare.
 * Cloudflare documents no bound. Its proxy gives up on a response after 100 seconds; three
 * times that is the assumption here. It costs a wait only when tearing down after an
 * interrupted upload.
 */
const SETTLE_MS = 300_000;

function loadConfig(): StagingConfig {
  if (!existsSync(CONFIG_FILE)) throw new Error(`no staging config at ${CONFIG_FILE}; run init`);
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StagingConfig;
}

function context(config: StagingConfig, command: string): Context {
  const holder = `pid ${process.pid}, stg.ts ${command}, started ${new Date().toISOString()}`;
  return {
    config,
    cloud: cliCloud(config, WORKER),
    store: fileStore(REGISTRY_FILE, holder),
    readConfig: (path) => readWranglerConfig(path, WORKER),
    readManifest: readStagingManifest,
    writeFile: writePrivateFile,
    removeFile: (path) => rmSync(path, { force: true }),
    lock: (name) => acquireLock(join(STATE, "locks", `${name}.lock`), 0, holder),
    sleep: sleepSync,
    settleMs: SETTLE_MS,
    now: () => new Date(),
    log: (message) => console.log(message),
  };
}

function main(): void {
  // A run killed in the instant between writing its secrets file and unlinking it leaves
  // the file behind; remove any such leftovers first.
  removeStaleSecretDirs();
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
      config: { type: "string", default: join(WORKER, "wrangler.jsonc") },
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
      assertAccount(config.accountId, context(config, command).cloud.accountIds());
      console.log(`staging config written to ${CONFIG_FILE}`);
      return;
    }
    case "check": {
      const ctx = context(loadConfig(), command);
      assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
      console.log(
        `staging account accessible; zone ${ctx.config.zone}; ${ctx.store.load().length} deployments`,
      );
      return;
    }
    case "deploy": {
      if (!values.suffix || !values.owner) throw new Error("deploy needs --suffix and --owner");
      deploy(context(loadConfig(), command), {
        suffix: values.suffix,
        owner: values.owner,
        configPath: resolve(values.config),
        days: Number(values.days),
      });
      return;
    }
    case "list": {
      for (const d of fileStore(REGISTRY_FILE, command).load()) {
        const unsettled = d.uploadStartedAt ? ` upload-interrupted=${d.uploadStartedAt}` : "";
        const tunnel = d.tunnel ? ` tunnel${d.tunnel.hostname ? "+hostname" : ""}` : "";
        const vpc = d.vpcServices?.length ? ` vpc=${d.vpcServices.length}` : "";
        console.log(
          `${d.name.padEnd(32)} ${d.state.padEnd(8)} owner=${d.owner} expires=${d.expiresAt}${unsettled}${tunnel}${vpc}`,
        );
      }
      return;
    }
    case "teardown": {
      if (!values.suffix) throw new Error("teardown needs --suffix");
      teardown(context(loadConfig(), command), resourceName(values.suffix));
      return;
    }
    case "sweep": {
      const failures = sweep(context(loadConfig(), command), values.yes);
      if (failures.length > 0) throw new Error(`teardown failed for:\n  ${failures.join("\n  ")}`);
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
  if (error instanceof Error && error.cause !== undefined) {
    console.error(`  cause: ${error.cause instanceof Error ? error.cause.message : error.cause}`);
  }
  process.exit(1);
}
