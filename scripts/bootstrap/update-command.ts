// `bootstrap.ts update` (WP3.35): wires the update (update.ts) to the installation's state file,
// the same locks as `run`, the bootstrap's own Cloudflare adapters (the installer's account,
// cloud.ts, or the guarded staging tool, staging.ts) and this checkout's code version.
//
//   node scripts/bootstrap/bootstrap.ts update [--platform-worker <name> | --state <file>]
//       [--owner-email <address>] [--no-verify]
//
// Exit status: 0 updated and checked, or already up to date; 3 deployed, but the check after
// the switch has not passed yet (run update again: it checks, and deploys nothing again);
// 1 an error or a refusal.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readWranglerConfig, spawnRunner } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import type { AccessApi } from "./access-app.ts";
import { accountCloud, cfAccessApi } from "./cloud.ts";
import { type BootstrapCloud, BootstrapRefusal, codeVersionFrom } from "./machine.ts";
import type { Installation } from "./settings.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, resourceLockPaths, stagingStateProblem } from "./state.ts";
import {
  DEFAULT_UPDATE_OPTIONS,
  runUpdate,
  shortCode,
  type UpdateContext,
  type UpdateOptions,
} from "./update.ts";

export interface UpdateCommandOptions {
  /** The checkout's root: its worker/ holds the Wrangler configurations. */
  readonly root: string;
  /** The owner's address: only needed if the hostname's Access application is gone. */
  readonly ownerEmail?: string;
  readonly verify: boolean;
}

/** What the command reaches outside itself; tests replace it. */
export interface UpdatePorts {
  readonly cloud: (plan: Installation, base: UpdateContext["baseConfigs"]) => BootstrapCloud;
  readonly accessApi: (plan: Installation) => AccessApi | undefined;
  readonly codeVersion: () => string | undefined;
  readonly random: (bytes: number) => Uint8Array;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
  readonly options?: Partial<UpdateOptions>;
}

/**
 * The code a checkout deploys (machine.ts, codeVersionFrom, as `run` reads it): its commit when
 * nothing in it differs from that commit; else undefined, and nothing is deployed.
 */
export function codeVersion(root: string): string | undefined {
  return codeVersionFrom((args) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 }),
  );
}

/** The real ports: Wrangler and cf with the installer's logins, or the staging tool. */
export function realPorts(root: string): UpdatePorts {
  return {
    cloud: (plan, base) =>
      plan.target.kind === "staging"
        ? stagingCloud(plan, { root, base })
        : accountCloud(plan, { workerDir: join(root, "worker") }),
    // In the installer's account, as `run`: the Access application read and checked by its ID.
    accessApi: (plan) =>
      plan.target.kind === "account" ? cfAccessApi(spawnRunner(plan.accountId)) : undefined,
    codeVersion: () => codeVersion(root),
    random: (n) => new Uint8Array(randomBytes(n)),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(`bootstrap: ${message}`),
  };
}

/** Updates the installation in the state file at `path`. Returns the exit status, or throws. */
export async function updateCommand(
  path: string,
  options: UpdateCommandOptions,
  ports: UpdatePorts = realPorts(options.root),
): Promise<number> {
  const store = fileStateStore(path);
  const installation = store.load().installation;
  const misplaced = stagingStateProblem(installation, path);
  if (misplaced !== undefined) throw new BootstrapRefusal(misplaced);
  const releases: (() => void)[] = [];
  try {
    // Never alongside a run, a removal or another update on the same Workers: `run`'s locks.
    for (const lock of resourceLockPaths(installation)) {
      releases.push(acquireLock(lock, 0, `pid ${process.pid}, bootstrap update, ${path}`));
    }
    const worker = join(options.root, "worker");
    const base = {
      platform: readWranglerConfig(join(worker, "wrangler.jsonc"), worker).raw,
      web: readWranglerConfig(join(worker, "wrangler.web.jsonc"), worker).raw,
    };
    const accessApi = ports.accessApi(installation);
    const outcome = await runUpdate(
      {
        cloud: ports.cloud(installation, base),
        store,
        baseConfigs: base,
        codeVersion: ports.codeVersion(),
        ...(accessApi === undefined ? {} : { accessApi }),
        ...(options.ownerEmail === undefined ? {} : { ownerEmail: options.ownerEmail }),
        random: ports.random,
        now: ports.now,
        sleep: ports.sleep,
        log: ports.log,
      },
      { ...DEFAULT_UPDATE_OPTIONS, verify: options.verify, ...ports.options },
    );
    const open = `Open https://${installation.hostname}`;
    if (outcome.kind === "deployed") {
      ports.log(
        `updated, but not checked yet: ${outcome.why}. Run bootstrap.ts update again to check; it deploys nothing again. ${open}`,
      );
      return 3;
    }
    if (outcome.kind === "current") {
      ports.log(`up to date: nothing to deploy. ${open}`);
      return 0;
    }
    const code = store.load().journal.update?.code;
    ports.log(`updated${code === undefined ? "" : ` to ${shortCode(code)}`}. ${open}`);
    return 0;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
