// The installer's bootstrap script (WP2.4). It runs on the installer's laptop, with the
// installer's Wrangler login (deploys, secret names) and `cf` login (Workers Logs, the Access
// application and the deployed version, read-only; the R2 buckets and the R2 token; and the
// release, one bulk secrets change), and makes an installation's owner exist before anyone can
// reach it. One run at a time per account and Worker name: a second one stops at once ("busy").
//
//   node scripts/bootstrap/bootstrap.ts plan --hostname <host> [--account <id>] \
//       --owner-email <address> --owner-username <name> \
//       --replica-url s3://<bucket>/<path> [--replica-endpoint <url>] \
//       [--artifacts-url s3://<bucket>[/<prefix>]] [--artifacts-endpoint <url>] \
//       [--platform-worker cloudflare-omnigent] [--web-worker cloudflare-omnigent-web] [--state <file>]
//   node scripts/bootstrap/bootstrap.ts run [--platform-worker <name> | --state <file>]
//       [--secrets-stdin] [--wait-minutes 30] [--no-verify]
//   node scripts/bootstrap/bootstrap.ts status [--platform-worker <name> | --state <file>] [--logs]
//   node scripts/bootstrap/bootstrap.ts buckets [--platform-worker <name> | --state <file>]
//   node scripts/bootstrap/bootstrap.ts remove-r2-token [--platform-worker <name> | --state <file>] [--yes]
//
// For the guarded staging tool instead of an account (cfo-stg-<base>-platform and -web, the
// account, zone and owner address from the staging tool's config; a file replica, which lives
// on the container's own disk, is allowed only here, for tests):
//   node scripts/bootstrap/bootstrap.ts plan --staging <base> --staging-owner <wp> \
//       --owner-username <name> --replica-url file:///replica [--days 1]
//
// `plan` records the installation in a state file (state.ts) and changes nothing at Cloudflare.
// It generates the installation ID and the owner pin; the owner's address is not kept. Without
// --account it asks cf for the one account the installer's login reaches (several: it names
// the way to choose). An S3 replica's endpoint defaults to the account's R2 endpoint. With an
// S3 replica, Omnigent's artifacts (uploaded files, session resources) get a bucket of their
// own, `<platform Worker>-artifacts` unless --artifacts-url names another, at the replica's
// endpoint unless --artifacts-endpoint names another: the container's disk is lost at every
// restart (G2-DUR-001). Create the hostname's owner-only Access application before `run`
// (cookie SameSite=lax, the owner's address as the only rule, no bypass, no service token):
// `run` checks it and never changes it.
//
// `run` does the rest (machine.ts) and can be repeated at any point, also after a crash: it
// continues where the last run stopped. Before the first deploy it creates the plan's R2
// buckets that are missing (a staging installation's come from the staging tool, and are only
// checked), and the installation's R2 token: a user API token with object read and write on
// exactly those buckets, made with the installer's `cf` login (r2-token.ts). Its key pair goes
// to the platform Worker for both uses, under their own names (the replica's for Litestream,
// the artifacts' for Omnigent); its value is never shown or kept, and its ID is recorded so
// that `remove-r2-token` can delete it. A token made by an earlier run whose pair never reached
// the Worker is retired the same way. A login that may not make API tokens (403) gets the
// dashboard step in one sentence and, in a terminal, a prompt for that token's two values.
// The owner's password is read only when it must be uploaded: from a JSON object on stdin with
// --secrets-stdin ({"ownerPassword": …}, optionally with an R2 token's values made by hand,
// "replicaAccessKeyId" and "replicaSecretAccessKey", and "artifactsAccessKeyId" and
// "artifactsSecretAccessKey" for a second token; given values are used instead of making a
// token), or else from a prompt. Exit status: 0 done; 2 still waiting for the owner to be
// initialized and durable (run again); 3 released, but the check after the version switch has
// not passed yet (run again); 1 an error or a refusal.
//
// `buckets` creates (or, for staging, checks) the plan's buckets without deploying; `run` does
// the same itself. `remove-r2-token` deletes the installation's R2 tokens, a step of removing
// the installation: it refuses while a Worker with the platform Worker's name exists unless
// --yes. cf's OAuth login may make API tokens but not delete them (403): then it names each
// token to delete, with the one link and click, and exits 1; run again once they are deleted,
// it reads each by its ID and finds them gone. The staging tool's teardown and sweep do the
// same for a staging installation's tokens, whose state file therefore stays at its default
// path (--state is refused for one).
//
// Afterwards the owner signs in to Omnigent at https://<host> with that username and password
// (behind Access), and should change the password there.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeOwnerPin } from "../../worker/src/ingress/owner.ts";
import { readWranglerConfig, spawnRunner } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import {
  accountCloud,
  bucketExists,
  cfTokenApi,
  ensureBuckets,
  queryWorkerLogs,
  soleAccount,
  workerInstallation,
} from "./cloud.ts";
import { decide, parseLogs } from "./events.ts";
import {
  BootstrapRefusal,
  type BootstrapState,
  DEFAULT_RUN_OPTIONS,
  runBootstrap,
} from "./machine.ts";
import type { S3Credentials } from "./r2-token.ts";
import { removeInstallationToken, withInstallationLocks } from "./remove.ts";
import {
  bucketsOf,
  defaultArtifactsUrl,
  type Installation,
  installationProblems,
  newInstallationId,
  passwordProblem,
  r2Endpoint,
  type SuppliedSecrets,
  type Target,
  usernameProblem,
} from "./settings.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, resourceLockPaths, stagingStateProblem, statePathFor } from "./state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(ROOT, "worker");

function stagingConfig(): { accountId: string; zone: string; ownerEmail: string } {
  const dir =
    process.env.CFO_STAGING_DIR ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"),
      "cloudflare-omnigent",
      "staging",
    );
  try {
    return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch {
    throw new Error("could not read the staging tool's config; run stg.ts init");
  }
}

async function plan(values: Record<string, string | boolean | undefined>): Promise<void> {
  const text = (key: string) => {
    const value = values[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const required = (key: string) => {
    const value = text(key);
    if (value === undefined) throw new Error(`plan needs --${key}`);
    return value;
  };
  const username = required("owner-username");
  const problem = usernameProblem(username);
  if (problem) throw new Error(problem);
  let target: Target;
  let accountId: string;
  let hostname: string;
  let email: string;
  let platformWorker: string;
  let webWorker: string;
  const base = text("staging");
  if (base !== undefined) {
    const config = stagingConfig();
    const platformSuffix = `${base}-platform`;
    const webSuffix = `${base}-web`;
    target = {
      kind: "staging",
      owner: required("staging-owner"),
      platformSuffix,
      webSuffix,
      days: Number(text("days") ?? "1"),
    };
    accountId = config.accountId;
    platformWorker = `cfo-stg-${platformSuffix}`;
    webWorker = `cfo-stg-${webSuffix}`;
    hostname = `${webWorker}.${config.zone}`;
    email = config.ownerEmail;
  } else {
    target = { kind: "account" };
    // The one account the installer's cf login reaches, unless named (read-only).
    accountId = text("account") ?? soleAccount(spawnRunner(""));
    hostname = required("hostname");
    email = required("owner-email");
    platformWorker = text("platform-worker") ?? "cloudflare-omnigent";
    webWorker = text("web-worker") ?? "cloudflare-omnigent-web";
  }
  const replicaUrl = required("replica-url");
  // An S3 replica in R2: the account's endpoint, unless another is named.
  const endpoint =
    text("replica-endpoint") ?? (replicaUrl.startsWith("s3:") ? r2Endpoint(accountId) : undefined);
  // A file replica (staging tests) keeps the artifacts on the container's disk unless named.
  const artifactsUrl =
    text("artifacts-url") ??
    (replicaUrl.startsWith("s3:") ? defaultArtifactsUrl(platformWorker) : undefined);
  const artifactsEndpoint = text("artifacts-endpoint");
  const installation: Installation = {
    installationId: newInstallationId((n) => new Uint8Array(randomBytes(n))),
    accountId,
    platformWorker,
    webWorker,
    hostname,
    ownerPin: await makeOwnerPin(email, new Uint8Array(randomBytes(32))),
    ownerUsername: username,
    replica: { url: replicaUrl, ...(endpoint === undefined ? {} : { endpoint }) },
    ...(artifactsUrl === undefined
      ? {}
      : {
          artifacts: {
            url: artifactsUrl,
            ...(artifactsEndpoint === undefined ? {} : { endpoint: artifactsEndpoint }),
          },
        }),
    target,
    plannedAt: new Date().toISOString(),
  };
  const problems = installationProblems(installation);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const path = text("state") ?? statePathFor(platformWorker);
  const misplaced = stagingStateProblem(installation, path);
  if (misplaced !== undefined) throw new Error(misplaced);
  if (existsSync(path)) {
    throw new Error(
      `${path} exists: this installation is planned already; run it, or remove the file by hand`,
    );
  }
  const state: BootstrapState = { stateVersion: 1, installation, journal: {} };
  fileStateStore(path).save(state);
  console.log(
    `planned ${installation.installationId}: ${platformWorker} and ${webWorker} for https://${hostname}; state in ${path}`,
  );
  const buckets = bucketsOf(installation);
  console.log(
    `${buckets.length > 0 ? `R2 buckets: ${buckets.join(", ")}; \`run\` creates them and their token. ` : ""}Next: bootstrap.ts run.`,
  );
}

/** The plan's R2 buckets: created when missing in the installer's account, checked in staging. */
function buckets(path: string): number {
  const installation = fileStateStore(path).load().installation;
  const problems = installationProblems(installation);
  if (problems.length > 0) throw new Error(`the plan is not usable: ${problems.join("; ")}`);
  const names = bucketsOf(installation);
  const run = spawnRunner(installation.accountId);
  if (installation.target.kind === "staging") {
    // The staging tool creates and tears down its buckets with the deployments that declare them.
    const missing = names.filter((name) => !bucketExists(run, name));
    if (missing.length > 0) {
      throw new Error(
        `missing R2 buckets: ${missing.join(", ")}; a staging installation's buckets come from the staging tool (a deployment that declares them)`,
      );
    }
    console.log(`bootstrap: the R2 buckets exist: ${names.join(", ") || "none needed"}`);
    return 0;
  }
  const created = ensureBuckets(run, names);
  for (const name of names) {
    console.log(`bootstrap: R2 bucket ${name}: ${created.includes(name) ? "created" : "exists"}`);
  }
  return 0;
}

/** Reads a line without echoing it, from the terminal. */
function prompt(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("the owner's password is needed: use --secrets-stdin");
  process.stdout.write(question);
  return new Promise((resolvePrompt, reject) => {
    let line = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolvePrompt(line);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("cancelled"));
        if (ch === "\u007f") line = line.slice(0, -1);
        else line += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function suppliedSecrets(fromStdin: boolean): Promise<SuppliedSecrets> {
  if (fromStdin) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Error("--secrets-stdin: stdin is not a JSON object");
    }
    const o = (parsed ?? {}) as Record<string, unknown>;
    const pick = (key: string) => (typeof o[key] === "string" ? (o[key] as string) : undefined);
    const ownerPassword = pick("ownerPassword");
    const replicaAccessKeyId = pick("replicaAccessKeyId");
    const replicaSecretAccessKey = pick("replicaSecretAccessKey");
    const artifactsAccessKeyId = pick("artifactsAccessKeyId");
    const artifactsSecretAccessKey = pick("artifactsSecretAccessKey");
    return {
      ...(ownerPassword === undefined ? {} : { ownerPassword }),
      ...(replicaAccessKeyId === undefined ? {} : { replicaAccessKeyId }),
      ...(replicaSecretAccessKey === undefined ? {} : { replicaSecretAccessKey }),
      ...(artifactsAccessKeyId === undefined ? {} : { artifactsAccessKeyId }),
      ...(artifactsSecretAccessKey === undefined ? {} : { artifactsSecretAccessKey }),
    };
  }
  const ownerPassword = await prompt("The owner's Omnigent password (not shown): ");
  const problem = passwordProblem(ownerPassword);
  if (problem) throw new Error(problem);
  if ((await prompt("Again: ")) !== ownerPassword) throw new Error("the passwords differ");
  // The R2 credentials come from the token `run` makes, or from askR2.
  return { ownerPassword };
}

/** A hand-made R2 token's two values, from the terminal, after the run showed the step. */
async function askR2(step: string): Promise<S3Credentials> {
  if (!process.stdin.isTTY) throw new Error(`${step} Then run again in a terminal.`);
  const accessKeyId = (await prompt("Its Access Key ID (not shown): ")).trim();
  const secretAccessKey = (await prompt("Its Secret Access Key (not shown): ")).trim();
  if (accessKeyId === "" || secretAccessKey === "") throw new Error("both values are needed");
  return { accessKeyId, secretAccessKey };
}

async function run(values: Record<string, string | boolean | undefined>, path: string) {
  const store = fileStateStore(path);
  // Serialise every run against the same Workers, whatever its state file: the locks are keyed
  // by account and Worker name. Held until the run ends; a crashed run's lock goes with it.
  const holder = `pid ${process.pid}, bootstrap run, ${path}`;
  const releases: (() => void)[] = [];
  try {
    for (const lock of resourceLockPaths(store.load().installation)) {
      releases.push(acquireLock(lock, 0, holder));
    }
    const installation = store.load().installation;
    const misplaced = stagingStateProblem(installation, path);
    if (misplaced !== undefined) throw new BootstrapRefusal(misplaced);
    const runner = spawnRunner(installation.accountId);
    // The first deploy needs the plan's buckets, which the R2 token covers (G2-DUR-001): created
    // here when missing; a staging installation's come from the staging tool.
    if (store.load().journal.platformDeployedAt === undefined) {
      const names = bucketsOf(installation);
      if (installation.target.kind === "account") {
        for (const name of ensureBuckets(runner, names)) {
          console.log(`bootstrap: created the R2 bucket ${name}`);
        }
      } else {
        const missing = names.filter((name) => !bucketExists(runner, name));
        if (missing.length > 0) {
          throw new BootstrapRefusal(
            `missing R2 buckets: ${missing.join(", ")}; a staging installation's buckets come from the staging tool (a deployment that declares them)`,
          );
        }
      }
    }
    // The secrets are read once, before anything else, only if this run will upload them.
    const fromStdin = values["secrets-stdin"] === true;
    const supplied = fromStdin ? await suppliedSecrets(true) : undefined;
    let prompted: SuppliedSecrets | undefined;
    if (
      !fromStdin &&
      process.stdin.isTTY &&
      store.load().journal.platformDeployedAt === undefined
    ) {
      prompted = await suppliedSecrets(false);
    }
    const base = {
      platform: readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER).raw,
      web: readWranglerConfig(join(WORKER, "wrangler.web.jsonc"), WORKER).raw,
    };
    const cloud =
      installation.target.kind === "staging"
        ? stagingCloud(installation, { root: ROOT, base })
        : accountCloud(installation, { workerDir: WORKER });
    const waitMinutes = Number(values["wait-minutes"] ?? "30");
    if (!(waitMinutes >= 0)) throw new Error("--wait-minutes must be a number of minutes");
    const outcome = await runBootstrap(
      {
        cloud,
        store,
        baseConfigs: base,
        secrets: () => {
          const given = supplied ?? prompted;
          if (given === undefined) {
            throw new Error(
              "the owner's password is needed: run in a terminal, or use --secrets-stdin",
            );
          }
          return given;
        },
        r2Tokens: cfTokenApi(runner),
        // Only a terminal can answer; stdin carries the JSON with --secrets-stdin.
        ...(!fromStdin && process.stdin.isTTY ? { askR2 } : {}),
        random: (n) => new Uint8Array(randomBytes(n)),
        now: () => Date.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        log: (message) => console.log(`bootstrap: ${message}`),
      },
      {
        ...DEFAULT_RUN_OPTIONS,
        waitMs: waitMinutes * 60_000,
        verify: values["no-verify"] !== true,
      },
    );
    switch (outcome.kind) {
      case "done":
        console.log(
          `bootstrap: done. The owner signs in at https://${installation.hostname} as ${installation.ownerUsername}.`,
        );
        return 0;
      case "released":
        console.log(`bootstrap: released; not checked yet: ${outcome.why}. Run again to check.`);
        return 3;
      case "waiting":
        console.log(
          `bootstrap: still waiting: ${outcome.why}. The password stays; run again to continue.`,
        );
        return 2;
    }
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/** Deletes the installation's R2 token: a step of removing the installation. */
function removeToken(path: string, yes: boolean): number {
  const store = fileStateStore(path);
  return withInstallationLocks(
    store,
    `pid ${process.pid}, bootstrap remove-r2-token, ${path}`,
    () => {
      const plan = store.load().installation;
      const runner = spawnRunner(plan.accountId);
      const removal = removeInstallationToken({
        store,
        api: cfTokenApi(runner),
        // Any Worker of that name: one whose identity is unknown (no version serving all of
        // its traffic) may well be this installation's (Codex WP3.25 r1-2).
        workerExists: () => workerInstallation(runner, plan.platformWorker).exists,
        force: yes,
        now: () => Date.now(),
        log: (message) => console.log(`bootstrap: ${message}`),
      });
      // Not finished while a token is left for the person to delete (named above).
      return removal.left.length > 0 ? 1 : 0;
    },
  );
}

async function status(path: string, withLogs: boolean): Promise<void> {
  const { installation, journal } = fileStateStore(path).load();
  const { ownerPin: _pin, ...shown } = installation;
  console.log(JSON.stringify({ installation: shown, journal }, null, 2));
  if (!withLogs) return;
  // The watchdog's statuses of the last 15 minutes, read-only: no secret is in them.
  const now = Date.now();
  const events = queryWorkerLogs(
    spawnRunner(installation.accountId),
    installation.platformWorker,
    now - 15 * 60_000,
    now,
  );
  const logs = parseLogs(events, installation.platformWorker);
  for (const e of [...logs.statuses].sort((a, b) => a.loggedAt - b.loggedAt)) {
    console.log(
      `${new Date(e.loggedAt).toISOString()} ${e.status.installationId === installation.installationId ? "this installation" : "another installation"}: initialized=${e.status.initialized} reason=${e.reason ?? "?"} password=${e.secretPresent ?? "?"} version=${e.versionId ?? "?"}`,
    );
  }
  if (journal.releasedAt !== undefined) {
    console.log(
      `released at ${journal.releasedAt}${journal.verifiedAt ? `, checked at ${journal.verifiedAt}` : ", not checked yet"}: the lines above are from before the switch`,
    );
    return;
  }
  const decision = decide(logs.statuses, { installationId: installation.installationId, now });
  console.log(
    decision.accepted
      ? "the bootstrap would release now"
      : `the bootstrap would wait: ${decision.why}${logs.malformed > 0 ? ` (${logs.malformed} lines ignored)` : ""}`,
  );
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      hostname: { type: "string" },
      account: { type: "string" },
      "owner-email": { type: "string" },
      "owner-username": { type: "string" },
      "replica-url": { type: "string" },
      "replica-endpoint": { type: "string" },
      "artifacts-url": { type: "string" },
      "artifacts-endpoint": { type: "string" },
      "platform-worker": { type: "string" },
      "web-worker": { type: "string" },
      state: { type: "string" },
      staging: { type: "string" },
      "staging-owner": { type: "string" },
      days: { type: "string" },
      "secrets-stdin": { type: "boolean" },
      "wait-minutes": { type: "string" },
      "no-verify": { type: "boolean" },
      logs: { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const statePath = () =>
    values.state ??
    statePathFor(
      values["platform-worker"] ??
        (values.staging ? `cfo-stg-${values.staging}-platform` : "cloudflare-omnigent"),
    );
  switch (command) {
    case "plan":
      await plan(values);
      return 0;
    case "buckets":
      return buckets(statePath());
    case "run":
      return run(values, statePath());
    case "status":
      await status(statePath(), values.logs === true);
      return 0;
    case "remove-r2-token":
      return removeToken(statePath(), values.yes === true);
    default:
      throw new Error(
        "usage: bootstrap.ts plan|run|status|buckets|remove-r2-token (see the header comment)",
      );
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const refusal = error instanceof BootstrapRefusal ? "refused: " : "";
  console.error(`bootstrap: ${refusal}${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
