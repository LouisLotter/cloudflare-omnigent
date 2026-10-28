// Removing an installation's R2 token (WP3.25): the one the bootstrap made with the installer's
// `cf` login (r2-token.ts). Two callers:
//   - `bootstrap.ts remove-r2-token`, a step of removing an installation from the installer's own
//     account, from the installation's state file. It refuses while a Worker with the platform
//     Worker's name exists, whose server would lose its database replica and its files, unless
//     told to go ahead (--yes);
//   - the staging tool's `teardown` and `sweep`: a staging installation's token is named for its
//     platform deployment (`cfo-stg-<suffix>-r2--<installation ID>`), so the tool finds it by
//     that name, whatever state file the bootstrap used, and also when an earlier teardown
//     stopped after removing the deployment's record. It deletes only tokens whose every
//     resource is in the staging account, and only for a deployment the registry no longer
//     holds, checked again under the bootstrap's lock for that platform Worker, so that it never
//     runs beside a bootstrap run that may be making the token.
// A create that a stopped run left unanswered may still land; removal waits for it first.

import { existsSync } from "node:fs";
import { InstallationId } from "../../contracts/src/index.ts";
import { acquireLock } from "../staging/lock.ts";
import type { StateStore } from "./machine.ts";
import {
  type ApiToken,
  createInFlight,
  R2_BUCKET_SCOPE,
  r2TokenName,
  removeR2Token,
  TOKEN_SETTLE_MS,
  type TokenApi,
} from "./r2-token.ts";
import { fileStateStore, resourceLockPaths, statePathFor } from "./state.ts";

export interface RemoveTokenOptions {
  readonly store: StateStore;
  readonly api: TokenApi;
  /**
   * Whether a Worker with the platform Worker's name exists, whichever installation it says it
   * is: an unknown identity (no version serving all traffic) counts as existing.
   */
  readonly workerExists: () => boolean;
  /** Remove it even so (the installer said --yes). */
  readonly force: boolean;
  readonly sleep: (ms: number) => void;
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
      `a Worker named ${plan.platformWorker} still exists, and this installation's server reads and writes its database replica and files with this token; remove the installation's Workers first, or pass --yes to cut it off now`,
    );
  }
  if (createInFlight(recorded)) {
    options.log(
      `an earlier run's request for the R2 token may still take effect; waiting ${TOKEN_SETTLE_MS / 60_000} minutes before deleting`,
    );
    options.sleep(TOKEN_SETTLE_MS);
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

const STAGING_TOKEN = /^(cfo-stg-[a-z0-9-]+)-r2--(ins_[0-9a-z]{26})$/;

/**
 * The staging deployment a token is named for, when it is a staging installation's R2 token in
 * this account: named `<deployment>-r2--<installation ID>`, with every resource in the account.
 */
export function stagingTokenDeployment(token: ApiToken, accountId: string): string | undefined {
  const match = STAGING_TOKEN.exec(token.name);
  if (match === null || !InstallationId.safeParse(match[2]).success) return undefined;
  const resources = token.policies.flatMap((p) => Object.keys(p.resources));
  const inAccount = `${R2_BUCKET_SCOPE}.${accountId}_`;
  if (resources.length === 0 || !resources.every((r) => r.startsWith(inAccount))) {
    return undefined;
  }
  return match[1];
}

export interface StagingTokenOptions {
  /** The staging account. */
  readonly accountId: string;
  readonly api: TokenApi;
  /** Takes the bootstrap's lock for a platform Worker, at once; throws when it is busy. */
  readonly lock: (platformWorker: string) => () => void;
  /** Delete the tokens (teardown, sweep --yes), or only report them (sweep). */
  readonly apply: boolean;
  readonly log: (message: string) => void;
  /** The bootstrap's state file for a platform Worker; its default location if not given. */
  readonly statePath?: (platformWorker: string) => string;
}

export interface StagingTokenResult {
  /** The tokens found, by name. */
  readonly found: readonly string[];
  readonly deleted: number;
  /** What could not be done, one line each. */
  readonly problems: readonly string[];
}

/**
 * The R2 tokens of staging installations whose platform deployment is `gone` (the registry no
 * longer holds it): reported, or deleted with `apply`. The bootstrap's own record of a deleted
 * token, in its default state file, is forgotten too.
 */
export function removeStagingTokens(
  gone: (deployment: string) => boolean,
  options: StagingTokenOptions,
): StagingTokenResult {
  const byDeployment = new Map<string, ApiToken[]>();
  for (const token of options.api.list()) {
    const deployment = stagingTokenDeployment(token, options.accountId);
    if (deployment === undefined || !gone(deployment)) continue;
    byDeployment.set(deployment, [...(byDeployment.get(deployment) ?? []), token]);
  }
  const found: string[] = [];
  const problems: string[] = [];
  let deleted = 0;
  for (const [deployment, tokens] of byDeployment) {
    found.push(...tokens.map((t) => t.name));
    if (!options.apply) {
      for (const t of tokens) {
        options.log(
          `${deployment}: the R2 token ${t.name} outlived its staging installation; sweep --yes deletes it`,
        );
      }
      continue;
    }
    let release: () => void;
    try {
      release = options.lock(deployment);
    } catch {
      problems.push(
        `${deployment}: a bootstrap run holds this installation; its R2 token was kept`,
      );
      continue;
    }
    try {
      // A bootstrap run may have deployed it between the listing and the lock.
      if (!gone(deployment)) continue;
      for (const t of tokens) {
        if (options.api.remove(t.id) === "deleted") deleted++;
        options.log(`${deployment}: deleted the R2 token ${t.name}`);
      }
      forgetToken(options.statePath?.(deployment) ?? statePathFor(deployment), deployment);
    } catch (error) {
      problems.push(`${deployment}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release();
    }
  }
  return { found, deleted, problems };
}

/** Removes the token's record from a staging installation's state file, if it is that one's. */
function forgetToken(path: string, deployment: string): void {
  if (!existsSync(path)) return;
  const store = fileStateStore(path);
  const state = store.load();
  const plan = state.installation;
  if (plan.target.kind !== "staging" || plan.platformWorker !== deployment) return;
  if (state.journal.r2Token === undefined) return;
  const { r2Token: _gone, ...journal } = state.journal;
  store.save({ ...state, journal });
}
