// Guarded staging tool. Every staging deployment is named cfo-stg-<suffix>, protected by an
// owner-only Access application before any traffic can reach it, recorded with an owner and
// an expiry, and torn down only if this tool created it. The rules are in guard.ts and the
// orchestration, with its invariants, in ops.ts.
//
//   node scripts/staging/stg.ts init --account <id> --zone <zone> --owner-email <email> [--idp <id>]
//   node scripts/staging/stg.ts check
//   node scripts/staging/stg.ts deploy --suffix <s> --owner <wp> [--config worker/wrangler.jsonc] [--days 7]
//                                      [--secrets-stdin]
//   node scripts/staging/stg.ts secrets --suffix <s> --owner <wp> [--not-after <ms>]
//   node scripts/staging/stg.ts deploy-version --suffix <s> --owner <wp> --version <version ID>
//                                                                    (changes as JSON on stdin)
//   node scripts/staging/stg.ts secret-names --suffix <s>
//   node scripts/staging/stg.ts list
//   node scripts/staging/stg.ts teardown --suffix <s>
//   node scripts/staging/stg.ts sweep [--yes]
//
// deploy --secrets-stdin uploads the secrets in a JSON object on stdin, {"NAME": "value", …},
// with the version, as the manifest's are. secrets changes a deployed Worker's secrets in one
// new deployed version (one bulk request): {"NAME": "value"} sets one, {"NAME": null} deletes one.
// deploy-version deploys an earlier version of a deployed Worker to all of its traffic, its secrets
// as they were (WP3.41: `bootstrap.ts update --rollback` of a staging installation).
// Values come only from stdin and never reach argv, the output or a file that stays; names are
// logged. With --not-after (Unix milliseconds), the change is sent only if that time has not
// passed once every check is done; otherwise nothing is sent and the tool exits with 3.
// secret-names prints the Worker's secret names as JSON, or null when it has none.
//
// sweep lists expired deployments (removed with --yes) and reports every staging bucket, Access
// application, service token, Tunnel, VPC service and DNS record that no record owns. Of those
// it removes, with --yes, only the ones that carry the nonce of a create the tool gave up on:
// its own, landed late.
//
// A deployment that teardown or sweep --yes removes may have been a staging installation's
// platform Worker (scripts/bootstrap, `plan --staging`). The R2 user API tokens that the
// bootstrap made for that installation go with it (scripts/bootstrap/remove.ts): the ones its
// state file records and, where the login may list tokens, any named for the deployment
// (`<deployment>-r2--<installation ID>--<time>`, every resource in the staging account).
// Teardown deletes them once the deployment's record is gone, and resumes that for a
// deployment an interrupted teardown already removed. Sweep reports such tokens of every
// deployment the registry no longer holds, and deletes them with --yes. cf's OAuth login may not
// delete API tokens (403): a token left so is named, with the one link and click that delete it
// (it also expires a day after its staging deployments would). A token left, kept because a
// bootstrap run holds its installation, or whose delete failed makes the command exit 1.
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
//     "vpcServices": [{ "binding": "X1_VPC", "port": 8081 }], // HTTP to 127.0.0.1:<port>
//     // F7-staging, only with the owner's approval: an Access service token, named
//     // <deployment>-svc--<nonce>, for 24 hours, admitted by one more policy on the named
//     // hostnames of this deployment.
//     "serviceToken": {
//       "hostnames": ["worker", "tunnel"],
//       "clientIdSecret": "X1_ACCESS_CLIENT_ID",       // Worker secrets for its credentials,
//       "clientSecretSecret": "X1_ACCESS_CLIENT_SECRET" // sent when created or rotated
//     }
//   }
//
// The tool deploys a rendered copy of the configuration with the route and VPC bindings added,
// .stg-rendered.<deployment>.jsonc next to it, and removes it afterwards.
//
// Before a deployment's first upload, its Worker name and hostname must be free, since
// Wrangler's --domain takes them over. A deploy that binds another deployment's Durable Objects
// holds that deployment's lock too, and a deployment that another one binds is not torn down.
// Every create is recorded as an intent with a random nonce first, and the resource carries the
// nonce in its name (a DNS record in its comment), so only what that create made is ever
// adopted. A command that finds an intent unresolved after an interrupted run waits the settle
// time (five minutes) once; a create still not seen then is kept in the registry as a late
// create, which sweep looks for. R2 buckets carry no nonce: their names are adopted, and a late
// one is only reported. No cf or Wrangler command lists a zone's Worker routes, so whether the
// Tunnel hostname's route went with its Worker at teardown is checked by hand.
//
// State lives outside the repository, so that every worktree on this laptop shares one
// registry and one set of locks: $CFO_STAGING_DIR, or ~/.config/cloudflare-omnigent/staging.
// It holds config.json (account ID, zone, owner email), resources.json and locks/. None of it
// is ever committed.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cfTokenApi } from "../bootstrap/cloud.ts";
import { installationStateFiles, removeStagingTokens } from "../bootstrap/remove.ts";
import { statePathFor, workerLockPath } from "../bootstrap/state.ts";
import {
  cliCloud,
  fileStore,
  readStagingManifest,
  readWranglerConfig,
  removeStaleSecretDirs,
  spawnRunner,
  writePrivateFile,
} from "./cloud.ts";
import { assertAccount, resourceName, type StagingConfig } from "./guard.ts";
import { acquireLock, sleepSync } from "./lock.ts";
import {
  type Context,
  deploy,
  deployVersion,
  listSecretNames,
  sweep,
  teardown,
  updateSecrets,
  WindowPassed,
} from "./ops.ts";

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
    nonce: () => randomBytes(4).toString("hex"),
    log: (message) => console.log(message),
  };
}

/**
 * The R2 tokens of staging installations whose platform deployment, among those `named`, the
 * registry no longer holds: deleted, or with `apply` false only reported. Returns how many it
 * found. A problem is reported and makes the command exit 1, after the teardown's own result.
 */
function installationTokens(
  ctx: Context,
  named: (d: string) => boolean,
  apply: boolean,
  stateFiles: () => readonly string[],
): number {
  const holder = `pid ${process.pid}, stg.ts R2 token cleanup`;
  const gone = (deployment: string) =>
    named(deployment) && !ctx.store.load().some((d) => d.name === deployment);
  try {
    const result = removeStagingTokens(gone, {
      accountId: ctx.config.accountId,
      api: cfTokenApi(spawnRunner(ctx.config.accountId)),
      // The bootstrap's lock, then the staging tool's for the deployment: a deploy holds the
      // second even when the bootstrap that started it is gone (Codex WP3.25 r2-1).
      lock: (worker) => {
        const bootstrap = acquireLock(workerLockPath(ctx.config.accountId, worker), 0, holder);
        try {
          const staging = ctx.lock(worker);
          return () => {
            staging();
            bootstrap();
          };
        } catch (error) {
          bootstrap();
          throw error;
        }
      },
      apply,
      log: (message) => console.log(message),
      stateFiles,
      now: () => Date.now(),
    });
    for (const problem of result.problems) console.error(`stg: ${problem}`);
    // Tokens left for the person (named above, with the click) mean the cleanup is not done.
    if (result.problems.length > 0 || result.left.length > 0) process.exitCode = 1;
    return result.found.length;
  } catch (error) {
    console.error(
      `stg: staging installations' R2 tokens were not checked: ${error instanceof Error ? error.message : String(error)}; run sweep to try again`,
    );
    process.exitCode = 1;
    return 0;
  }
}

/**
 * A JSON object of secrets from stdin: string values, and with `deletions` also nulls. An error
 * names no value.
 */
function secretsFromStdin(deletions: boolean): Record<string, string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    throw new Error("stdin is not a JSON object of secrets");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("stdin is not a JSON object of secrets");
  }
  for (const [name, value] of Object.entries(parsed)) {
    const ok = typeof value === "string" ? value !== "" : deletions && value === null;
    if (!ok)
      throw new Error(`the secret ${name} needs ${deletions ? "a value or null" : "a value"}`);
  }
  return parsed as Record<string, string | null>;
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
      "secrets-stdin": { type: "boolean", default: false },
      "not-after": { type: "string" },
      version: { type: "string" },
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
        ...(values["secrets-stdin"]
          ? { secrets: secretsFromStdin(false) as Record<string, string> }
          : {}),
      });
      return;
    }
    case "secrets": {
      if (!values.suffix || !values.owner) throw new Error("secrets needs --suffix and --owner");
      const notAfter = values["not-after"] === undefined ? undefined : Number(values["not-after"]);
      if (notAfter !== undefined && !Number.isSafeInteger(notAfter)) {
        throw new Error("--not-after must be a time in Unix milliseconds");
      }
      updateSecrets(context(loadConfig(), command), {
        suffix: values.suffix,
        owner: values.owner,
        changes: secretsFromStdin(true),
        ...(notAfter === undefined ? {} : { notAfter }),
      });
      return;
    }
    case "deploy-version": {
      if (!values.suffix || !values.owner || !values.version) {
        throw new Error("deploy-version needs --suffix, --owner and --version");
      }
      deployVersion(context(loadConfig(), command), {
        suffix: values.suffix,
        owner: values.owner,
        versionId: values.version,
      });
      return;
    }
    case "secret-names": {
      if (!values.suffix) throw new Error("secret-names needs --suffix");
      console.log(JSON.stringify(listSecretNames(context(loadConfig(), command), values.suffix)));
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
      const ctx = context(loadConfig(), command);
      const name = resourceName(values.suffix);
      // A deployment whose record an interrupted teardown already removed: only its token is left.
      const recorded = ctx.store.load().some((d) => d.name === name);
      if (recorded) teardown(ctx, name);
      const found = installationTokens(
        ctx,
        (d) => d === name,
        true,
        () => [statePathFor(name)],
      );
      if (!recorded && found === 0) throw new Error(`no recorded deployment named ${name}`);
      return;
    }
    case "sweep": {
      const ctx = context(loadConfig(), command);
      const failures = sweep(ctx, values.yes);
      installationTokens(
        ctx,
        () => true,
        values.yes,
        () => installationStateFiles(),
      );
      if (failures.length > 0) throw new Error(`teardown failed for:\n  ${failures.join("\n  ")}`);
      return;
    }
    default:
      throw new Error(
        "usage: stg.ts init|check|deploy|secrets|secret-names|list|teardown|sweep (see the header comment)",
      );
  }
}

try {
  main();
} catch (error) {
  console.error(`stg: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof WindowPassed) process.exit(3);
  if (error instanceof Error && error.cause !== undefined) {
    console.error(`  cause: ${error.cause instanceof Error ? error.cause.message : error.cause}`);
  }
  process.exit(1);
}
