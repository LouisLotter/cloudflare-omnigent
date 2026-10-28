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
//     holds. Under every lock that guards the deployment (the bootstrap's for that platform
//     Worker, then the staging tool's, which a staging tool outliving a killed bootstrap still
//     holds), it checks the registry again and lists the tokens afresh, so that it never runs
//     beside a run that may be making or deploying the token (Codex WP3.25 r2-1, r2-2). The
//     bootstrap's record of the token is forgotten only when it is settled and its token gone:
//     an unanswered request stays recorded for the next run to wait for.
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
  requestInFlight,
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
  /**
   * Takes every lock that guards a platform deployment, at once (the bootstrap's, then the
   * staging tool's), and returns their release; throws when one is busy.
   */
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
  const tokensOf = (listed: readonly ApiToken[]) => {
    const byDeployment = new Map<string, ApiToken[]>();
    for (const token of listed) {
      const deployment = stagingTokenDeployment(token, options.accountId);
      if (deployment === undefined) continue;
      byDeployment.set(deployment, [...(byDeployment.get(deployment) ?? []), token]);
    }
    return byDeployment;
  };
  const found: string[] = [];
  const problems: string[] = [];
  let deleted = 0;
  for (const [deployment, tokens] of tokensOf(options.api.list())) {
    if (!gone(deployment)) continue;
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
      // A run may have deployed it, or made or replaced its token, between the listing and
      // the locks: look again under them.
      if (!gone(deployment)) continue;
      const listed = options.api.list();
      const current = tokensOf(listed).get(deployment) ?? [];
      const removed = new Set<string>();
      for (const t of current) {
        if (options.api.remove(t.id) === "deleted") deleted++;
        removed.add(t.id);
        options.log(`${deployment}: deleted the R2 token ${t.name}`);
      }
      const remaining = new Set(listed.map((t) => t.id).filter((id) => !removed.has(id)));
      forgetToken(
        options.statePath?.(deployment) ?? statePathFor(deployment),
        deployment,
        options.accountId,
        remaining,
      );
    } catch (error) {
      problems.push(`${deployment}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release();
    }
  }
  return { found, deleted, problems };
}

/**
 * Removes the token's record from a staging installation's state file: only that staging
 * installation's, in this account, when no request of its is unanswered and its token is no
 * longer listed (`remaining`: the IDs Cloudflare still lists).
 */
function forgetToken(
  path: string,
  deployment: string,
  accountId: string,
  remaining: ReadonlySet<string>,
): void {
  if (!existsSync(path)) return;
  const store = fileStateStore(path);
  const state = store.load();
  const plan = state.installation;
  if (
    plan.target.kind !== "staging" ||
    plan.platformWorker !== deployment ||
    plan.accountId !== accountId
  ) {
    return;
  }
  const recorded = state.journal.r2Token;
  if (recorded === undefined || requestInFlight(recorded)) return;
  if (recorded.id !== undefined && remaining.has(recorded.id)) return;
  const { r2Token: _gone, ...journal } = state.journal;
  store.save({ ...state, journal });
}
