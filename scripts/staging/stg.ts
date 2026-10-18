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
// Account ID, zone and owner email live in .staging/config.json, which is never committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliCloud, fileStore, readWranglerConfig } from "./cloud.ts";
import { assertAccount, resourceName, type StagingConfig } from "./guard.ts";
import { type Context, deploy, sweep, teardown } from "./ops.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(ROOT, "worker");
const STATE = join(ROOT, ".staging");
const CONFIG_FILE = join(STATE, "config.json");
const REGISTRY_FILE = join(STATE, "resources.json");

function loadConfig(): StagingConfig {
  if (!existsSync(CONFIG_FILE)) throw new Error("no staging config; run `stg.ts init` first");
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as StagingConfig;
}

function context(config: StagingConfig): Context {
  return {
    config,
    cloud: cliCloud(config, WORKER),
    store: fileStore(REGISTRY_FILE),
    readConfig: (path) => readWranglerConfig(path, WORKER),
    now: () => new Date(),
    log: (message) => console.log(message),
  };
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
      assertAccount(config.accountId, context(config).cloud.accountIds());
      console.log("staging config written to .staging/config.json");
      return;
    }
    case "check": {
      const ctx = context(loadConfig());
      assertAccount(ctx.config.accountId, ctx.cloud.accountIds());
      console.log(
        `staging account accessible; zone ${ctx.config.zone}; ${ctx.store.load().length} deployments`,
      );
      return;
    }
    case "deploy": {
      if (!values.suffix || !values.owner) throw new Error("deploy needs --suffix and --owner");
      deploy(context(loadConfig()), {
        suffix: values.suffix,
        owner: values.owner,
        configPath: resolve(values.config),
        days: Number(values.days),
      });
      return;
    }
    case "list": {
      for (const d of fileStore(REGISTRY_FILE).load()) {
        console.log(
          `${d.name.padEnd(32)} ${d.state.padEnd(8)} owner=${d.owner} expires=${d.expiresAt}`,
        );
      }
      return;
    }
    case "teardown": {
      if (!values.suffix) throw new Error("teardown needs --suffix");
      teardown(context(loadConfig()), resourceName(values.suffix));
      return;
    }
    case "sweep": {
      const failures = sweep(context(loadConfig()), values.yes);
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
