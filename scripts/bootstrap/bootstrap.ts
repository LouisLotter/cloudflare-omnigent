// The installer's bootstrap script (WP2.4). It runs on the installer's laptop, with the
// installer's Wrangler login (deploys and secrets) and `cf` login (read-only: Workers Logs and
// the Access application), and makes an installation's owner exist before anyone can reach it.
//
//   node scripts/bootstrap/bootstrap.ts plan --hostname <host> --account <id> \
//       --owner-email <address> --owner-username <name> \
//       --replica-url s3://<bucket>/<path> --replica-endpoint https://<account>.r2.cloudflarestorage.com \
//       [--platform-worker cloudflare-omnigent] [--web-worker cloudflare-omnigent-web] [--state <file>]
//   node scripts/bootstrap/bootstrap.ts run [--platform-worker <name> | --state <file>]
//       [--secrets-stdin] [--wait-minutes 30] [--no-verify]
//   node scripts/bootstrap/bootstrap.ts status [--platform-worker <name> | --state <file>] [--logs]
//
// For the guarded staging tool instead of an account (cfo-stg-<base>-platform and -web, the
// account, zone and owner address from the staging tool's config; a file replica, which lives
// on the container's own disk, is allowed only here, for tests):
//   node scripts/bootstrap/bootstrap.ts plan --staging <base> --staging-owner <wp> \
//       --owner-username <name> --replica-url file:///replica [--days 1]
//
// `plan` records the installation in a state file (state.ts) and touches nothing at Cloudflare.
// It generates the installation ID and the owner pin; the owner's address is not kept. Create
// the hostname's owner-only Access application before `run` (cookie SameSite=lax, the owner's
// address as the only rule, no bypass, no service token): `run` checks it and never changes it.
//
// `run` does the rest (machine.ts) and can be repeated at any point, also after a crash: it
// continues where the last run stopped. It reads the owner's password (and the replica's
// credentials) only when they must be uploaded: from a JSON object on stdin with
// --secrets-stdin ({"ownerPassword": …, "replicaAccessKeyId": …, "replicaSecretAccessKey": …}),
// or else from a prompt. Exit status: 0 done; 2 still waiting for the owner to be initialized
// and durable (run again); 3 released, but the check after the version switch has not passed
// yet (run again); 1 an error or a refusal.
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
import { accountCloud, queryWorkerLogs } from "./cloud.ts";
import { decide, parseLogs } from "./events.ts";
import {
  BootstrapRefusal,
  type BootstrapState,
  DEFAULT_RUN_OPTIONS,
  runBootstrap,
} from "./machine.ts";
import {
  type Installation,
  installationProblems,
  newInstallationId,
  passwordProblem,
  type SuppliedSecrets,
  type Target,
  usernameProblem,
} from "./settings.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, statePathFor } from "./state.ts";

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
    accountId = required("account");
    hostname = required("hostname");
    email = required("owner-email");
    platformWorker = text("platform-worker") ?? "cloudflare-omnigent";
    webWorker = text("web-worker") ?? "cloudflare-omnigent-web";
  }
  const endpoint = text("replica-endpoint");
  const installation: Installation = {
    installationId: newInstallationId((n) => new Uint8Array(randomBytes(n))),
    accountId,
    platformWorker,
    webWorker,
    hostname,
    ownerPin: await makeOwnerPin(email, new Uint8Array(randomBytes(32))),
    ownerUsername: username,
    replica: { url: required("replica-url"), ...(endpoint === undefined ? {} : { endpoint }) },
    target,
    plannedAt: new Date().toISOString(),
  };
  const problems = installationProblems(installation);
  if (problems.length > 0) throw new Error(problems.join("; "));
  const path = text("state") ?? statePathFor(platformWorker);
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

async function suppliedSecrets(
  fromStdin: boolean,
  needsReplica: boolean,
): Promise<SuppliedSecrets> {
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
    return {
      ...(ownerPassword === undefined ? {} : { ownerPassword }),
      ...(replicaAccessKeyId === undefined ? {} : { replicaAccessKeyId }),
      ...(replicaSecretAccessKey === undefined ? {} : { replicaSecretAccessKey }),
    };
  }
  const ownerPassword = await prompt("The owner's Omnigent password (not shown): ");
  const problem = passwordProblem(ownerPassword);
  if (problem) throw new Error(problem);
  if ((await prompt("Again: ")) !== ownerPassword) throw new Error("the passwords differ");
  if (!needsReplica) return { ownerPassword };
  const replicaAccessKeyId = await prompt("The replica's R2 access key ID (not shown): ");
  const replicaSecretAccessKey = await prompt("The replica's R2 secret access key (not shown): ");
  return { ownerPassword, replicaAccessKeyId, replicaSecretAccessKey };
}

async function run(values: Record<string, string | boolean | undefined>, path: string) {
  const store = fileStateStore(path);
  const release = acquireLock(`${path}.lock`, 0, `pid ${process.pid}, bootstrap run`);
  try {
    const installation = store.load().installation;
    // The secrets are read once, before anything else, only if this run will upload them.
    const fromStdin = values["secrets-stdin"] === true;
    const supplied = fromStdin ? await suppliedSecrets(true, false) : undefined;
    let prompted: SuppliedSecrets | undefined;
    const needsReplica = installation.replica.url.startsWith("s3:");
    if (
      !fromStdin &&
      process.stdin.isTTY &&
      store.load().journal.platformDeployedAt === undefined
    ) {
      prompted = await suppliedSecrets(false, needsReplica);
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
    release();
  }
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
    case "run":
      return run(values, statePath());
    case "status":
      await status(statePath(), values.logs === true);
      return 0;
    default:
      throw new Error("usage: bootstrap.ts plan|run|status (see the header comment)");
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const refusal = error instanceof BootstrapRefusal ? "refused: " : "";
  console.error(`bootstrap: ${refusal}${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
