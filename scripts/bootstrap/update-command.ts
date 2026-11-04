// `bootstrap.ts update` (WP3.35): wires the update (update.ts) to the installation's state file,
// the same locks as `run`, the bootstrap's own Cloudflare adapters (the installer's account,
// cloud.ts, or the guarded staging tool, staging.ts) and this checkout's code version.
//
//   node scripts/bootstrap/bootstrap.ts update [--platform-worker <name> | --state <file>]
//       [--owner-email <address>] [--no-verify] [--rollback] [--team-admission owner|members]
//       [--host-id <this computer's Omnigent host ID> | --host-id none]
//
// `--team-admission members` (WP8.11, team-move.ts) moves the team of one behind Access in the
// same run: the update with its restore point, then, once it is accepted, the owner's single
// sign-in, the checks in bind mode (this computer's host among them: its ID from Omnigent's own
// configuration unless given), required mode, members admission and the member group's policy.
//
// Exit status: 0 updated, checked and accepted, or already up to date (with --rollback: rolled
// back and checked, or nothing to roll back); 3 not finished yet: deployed, but the check after
// the switch has not passed yet (Omnigent stays paused meanwhile), or accepted with the server's
// restart without the window not seen yet, or a rollback under way (run the same command again: it repeats nothing that
// landed); 1 an error or a refusal, the new server's refusal of a setting among them.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readWranglerConfig, spawnRunner } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import type { AccessApi } from "./access-app.ts";
import { accountCloud, cfAccessApi, cfAccessGroupsApi, cfTokenApi } from "./cloud.ts";
import { type BootstrapCloud, BootstrapRefusal, codeVersionFrom } from "./machine.ts";
import type { TokenApi } from "./r2-token.ts";
import { runRollback } from "./rollback.ts";
import type { Installation } from "./settings.ts";
import { stagingCloud } from "./staging.ts";
import { fileStateStore, resourceLockPaths, stagingStateProblem } from "./state.ts";
import {
  type AccessGroupsApi,
  TEAM_ADMISSION_SUPPORTED,
  teamAdmissionRefusal,
} from "./team-admission.ts";
import { hostConfigPath, localHostId, normalHostId } from "./team-move.ts";
import {
  DEFAULT_UPDATE_OPTIONS,
  runUpdate,
  shortCode,
  type UpdateContext,
  type UpdateOptions,
  type UpdateOutcome,
} from "./update.ts";

export interface UpdateCommandOptions {
  /** The checkout's root: its worker/ holds the Wrangler configurations. */
  readonly root: string;
  /** The owner's address: only needed if the hostname's Access application is gone. */
  readonly ownerEmail?: string;
  readonly verify: boolean;
  /** Go back to the release and the data from before the update, inside its window (WP3.41). */
  readonly rollback?: boolean;
  /** `members` lets the team page decide who Access admits (WP8.3); `owner`, today's default. */
  readonly teamAdmission?: string;
  /** This computer's Omnigent host ID for the move's check, or `none` (WP8.11). */
  readonly hostId?: string;
}

/** What the command reaches outside itself; tests replace it. */
export interface UpdatePorts {
  readonly cloud: (plan: Installation, base: UpdateContext["baseConfigs"]) => BootstrapCloud;
  readonly accessApi: (plan: Installation) => AccessApi | undefined;
  /** Access groups and API tokens for the team's move; undefined on staging (WP8.11). */
  readonly teamApis: (
    plan: Installation,
  ) => { readonly groups: AccessGroupsApi; readonly tokens: TokenApi } | undefined;
  /** This computer's Omnigent host ID, from Omnigent's configuration (team-move.ts). */
  readonly localHostId: () => string | undefined;
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
    teamApis: (plan) =>
      plan.target.kind === "account"
        ? {
            groups: cfAccessGroupsApi(spawnRunner(plan.accountId)),
            tokens: cfTokenApi(spawnRunner(plan.accountId)),
          }
        : undefined,
    localHostId: () => localHostId(),
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
  if (options.teamAdmission !== undefined && options.teamAdmission !== "owner") {
    if (options.teamAdmission !== "members") {
      throw new BootstrapRefusal("--team-admission takes owner or members");
    }
    if (!TEAM_ADMISSION_SUPPORTED) throw new BootstrapRefusal(teamAdmissionRefusal());
  }
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
    const teamApis = ports.teamApis(installation);
    let hostId: string | undefined;
    if (options.hostId !== undefined) {
      hostId = options.hostId === "none" ? "none" : normalHostId(options.hostId);
      if (hostId === undefined) {
        throw new BootstrapRefusal(
          "--host-id takes an Omnigent host ID (32 hexadecimal digits, as omnigent host status shows it) or none",
        );
      }
    } else {
      hostId = ports.localHostId();
    }
    const context: UpdateContext = {
      cloud: ports.cloud(installation, base),
      store,
      baseConfigs: base,
      codeVersion: ports.codeVersion(),
      ...(accessApi === undefined ? {} : { accessApi }),
      ...(options.ownerEmail === undefined ? {} : { ownerEmail: options.ownerEmail }),
      ...(teamApis === undefined
        ? {}
        : {
            team: {
              requested: options.teamAdmission === "members",
              supported: TEAM_ADMISSION_SUPPORTED,
              ...teamApis,
              hostId,
              hostConfig: hostConfigPath(),
            },
          }),
      random: ports.random,
      now: ports.now,
      sleep: ports.sleep,
      log: ports.log,
    };
    const updateOptions = { ...DEFAULT_UPDATE_OPTIONS, verify: options.verify, ...ports.options };
    const open = `Open https://${installation.hostname}`;
    if (options.rollback === true) {
      const rolled = await runRollback(context, updateOptions);
      if (rolled.kind === "waiting") {
        ports.log(
          `rolling back, not finished yet: ${rolled.why}. Omnigent stays paused until it is. Run bootstrap.ts update --rollback again to continue; it repeats nothing that is done.`,
        );
        return 3;
      }
      ports.log(`${rolled.kind === "done" ? "rolled back" : "nothing to roll back"}. ${open}`);
      return 0;
    }
    const outcome = await runUpdate(context, updateOptions);
    if (outcome.kind === "team") return teamOutcome(outcome, installation, ports.log);
    if (outcome.kind === "deployed") {
      if (outcome.window === "closing") {
        ports.log(
          `accepted, and the read-only window is closed; the server's restart without it was not seen yet: ${outcome.why}. Omnigent is available again once it has restarted (a few minutes); bootstrap.ts status --logs shows it. ${open}`,
        );
        return 3;
      }
      if (outcome.held === true) {
        ports.log(
          `updated, but the new server refused one of its settings and stays stopped: ${outcome.why}. Omnigent stays paused, so nothing can be lost meanwhile. Or go back to the version from before the update, with Omnigent's data as it was then: bootstrap.ts update --rollback. ${open}`,
        );
        return 1;
      }
      if (outcome.integrationsOff === true) {
        // WP3.44: the server is checked every minute while the window holds, so a run sees an
        // integration come on; github-app and services refuse inside the window.
        ports.log(
          `updated, but not checked yet: ${outcome.why}. Omnigent stays paused, so nothing can be lost meanwhile, and its server is checked every minute: run bootstrap.ts update again to check, and it accepts the update once that is on (it deploys nothing again). If it stays off, go back to the version from before the update, with Omnigent's data as it was then: bootstrap.ts update --rollback; bootstrap.ts github-app and services work again after that. ${open}`,
        );
        return 3;
      }
      const again =
        store.load().journal.update?.platformDeployedAt === undefined
          ? "Run bootstrap.ts update again."
          : "Run bootstrap.ts update again to check; it deploys nothing again.";
      ports.log(
        `updated, but not checked yet: ${outcome.why}. Omnigent stays paused until the update is checked, so nothing can be lost meanwhile. ${again} Or go back to the version from before the update, with Omnigent's data as it was then: bootstrap.ts update --rollback. ${open}`,
      );
      return 3;
    }
    if (outcome.kind === "current") {
      ports.log(`up to date: nothing to deploy. ${open}`);
      return 0;
    }
    const code = store.load().journal.update?.code;
    ports.log(
      `updated${code === undefined ? "" : ` to ${shortCode(code)}`}, checked and accepted: Omnigent is available again. ${open}`,
    );
    return 0;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/**
 * What the run says once the update is accepted and the team's move went on (WP8.11): what it
 * waits for, why it stopped at bind, or that it is finished, with the steps left for a person.
 */
export function teamOutcome(
  outcome: Extract<UpdateOutcome, { kind: "team" }>,
  plan: Installation,
  log: (message: string) => void,
): number {
  const open = `https://${plan.hostname}`;
  if (outcome.state === "waiting") {
    log(
      `updated and accepted; the team's move behind Access waits: ${outcome.why}. Omnigent works meanwhile (bind mode). Run bootstrap.ts update --team-admission members again to go on; it repeats nothing that is done.`,
    );
    return 3;
  }
  if (outcome.state === "stopped") {
    log(
      `updated and accepted; the team's move behind Access stopped in bind mode: ${outcome.why}. Omnigent works as it is. Once that is fixed, run bootstrap.ts update --team-admission members again.`,
    );
    return 3;
  }
  const computers = outcome.computers ?? 0;
  log(
    `updated, checked and accepted, and ${outcome.why}: Omnigent requires Access's sign-in now, and the team page decides who Access admits. ${open}`,
  );
  log("left to do, once:");
  log(
    computers > 0
      ? `  1. restart each cloud computer from its page (${open}/platform/computers, the computer, Restart), so that it runs this release's computer image (${computers} connected now)`
      : `  1. if the installation has a cloud computer, restart it from its page (${open}/platform/computers, the computer, Restart), so that it runs this release's computer image`,
  );
  log(
    "  2. on this computer, set up its Omnigent host again for this release (the host runbook's install step), then check it reconnects: omnigent host status",
  );
  return 0;
}
