// Removing an installation's R2 token (WP3.25): the one the bootstrap made with the installer's
// `cf` login (r2-token.ts), recorded in the installation's state file. Two callers:
//   - `bootstrap.ts remove-r2-token`, a step of removing an installation from the installer's own
//     account. It refuses while the installation's platform Worker exists, whose server would
//     lose its database replica and its files, unless told to go ahead (--yes);
//   - the staging tool, after `teardown` or `sweep --yes` removed a staging deployment: the
//     token of a staging installation whose platform Worker was that deployment goes with it.
// Either way it holds the bootstrap's locks for the installation, so that it never runs beside
// a bootstrap run that might be making the token, and the record leaves the journal only once
// Cloudflare has no token of the installation left.

import { existsSync } from "node:fs";
import type { Runner } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import type { StateStore } from "./machine.ts";
import { r2TokenName, removeR2Token, type TokenApi } from "./r2-token.ts";
import { fileStateStore, resourceLockPaths, statePathFor } from "./state.ts";

export interface RemoveTokenOptions {
  readonly store: StateStore;
  readonly api: TokenApi;
  /** Whether this installation's platform Worker still exists. */
  readonly workerExists: () => boolean;
  /** Remove it even so (the installer said --yes, or a teardown just removed the Worker). */
  readonly force: boolean;
  readonly log: (message: string) => void;
}

/** Deletes the installation's recorded R2 token. Returns how many tokens it deleted. */
export function removeInstallationToken(options: RemoveTokenOptions): number {
  const state = options.store.load();
  const plan = state.installation;
  const recorded = state.journal.r2Token;
  if (recorded === undefined) {
    options.log("no R2 token recorded for this installation: nothing to delete");
    return 0;
  }
  if (!options.force && options.workerExists()) {
    throw new Error(
      `${plan.platformWorker} still exists, and its server reads and writes its database replica and files with this token; remove the installation's Workers first, or pass --yes to cut it off now`,
    );
  }
  const deleted = removeR2Token(options.api, plan, recorded);
  const { r2Token: _gone, ...journal } = options.store.load().journal;
  options.store.save({ ...state, journal });
  options.log(
    deleted > 0
      ? `deleted the R2 token ${r2TokenName(plan)}`
      : `the R2 token ${r2TokenName(plan)} was already gone`,
  );
  return deleted;
}

/**
 * Holds the bootstrap's locks for the installation while `use` runs, which must be synchronous;
 * busy is an error.
 */
export function withInstallationLocks<T>(store: StateStore, holder: string, use: () => T): T {
  const releases: (() => void)[] = [];
  try {
    for (const lock of resourceLockPaths(store.load().installation)) {
      releases.push(acquireLock(lock, 0, holder));
    }
    return use();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export interface DeploymentTokenOptions {
  /** The staging account: a plan for another account is left alone. */
  readonly accountId: string;
  readonly api: (runner: Runner) => TokenApi;
  readonly runner: (accountId: string) => Runner;
  readonly log: (message: string) => void;
  /** The state file's path; by default the bootstrap's own for that platform Worker. */
  readonly path?: string;
}

/**
 * After the staging tool removed a deployment: deletes the R2 token of the staging installation
 * whose platform Worker it was, if the bootstrap made one. Returns how many it deleted.
 */
export function removeDeploymentToken(deployment: string, options: DeploymentTokenOptions): number {
  const path = options.path ?? statePathFor(deployment);
  if (!existsSync(path)) return 0;
  const store = fileStateStore(path);
  const plan = store.load().installation;
  if (
    plan.target.kind !== "staging" ||
    plan.platformWorker !== deployment ||
    plan.accountId !== options.accountId
  ) {
    return 0;
  }
  return withInstallationLocks(store, `pid ${process.pid}, staging teardown of ${deployment}`, () =>
    removeInstallationToken({
      store,
      api: options.api(options.runner(plan.accountId)),
      workerExists: () => false,
      force: true,
      log: (message) => options.log(`${deployment}: ${message}`),
    }),
  );
}
