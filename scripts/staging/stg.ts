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
// State lives outside the repository, so that every worktree on this laptop shares one
// registry and one set of locks: $CFO_STAGING_DIR, or ~/.config/cloudflare-omnigent/staging.
// It holds config.json (account ID, zone, owner email), resources.json and locks/. None of it
// is ever committed.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cliCloud, fileStore, readWranglerConfig } from "./cloud.ts";
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
/** A request whose client died may still complete at Cloudflare within this time. */
const SETTLE_MS = 60_000;

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
    lock: (name) => acquireLock(join(STATE, "locks", `${name}.lock`), 0, holder),
    sleep: sleepSync,
    settleMs: SETTLE_MS,
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
        console.log(
          `${d.name.padEnd(32)} ${d.state.padEnd(8)} owner=${d.owner} expires=${d.expiresAt}${unsettled}`,
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
