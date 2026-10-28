// Removing an installation's R2 tokens (WP3.25): the ones the bootstrap made with the installer's
// `cf` login (r2-token.ts), recorded in the installation's state file. Two callers:
//   - `bootstrap.ts remove-r2-token`, a step of removing an installation from the installer's own
//     account. It refuses while a Worker with the platform Worker's name exists, whose server
//     would lose its database replica and its files, unless told to go ahead (--yes);
//   - the staging tool's `teardown` and `sweep`, for staging installations whose platform
//     deployment the registry no longer holds: the tokens their state files record and, where
//     Cloudflare lets the login list tokens, every token named for such a deployment
//     (`cfo-stg-<suffix>-r2--<installation ID>--<time>`, every resource in the staging account).
//     Under every lock that guards the deployment (the bootstrap's for that platform Worker,
//     then the staging tool's, which a staging tool outliving a killed bootstrap still holds),
//     it checks the registry again and reads the records afresh (Codex WP3.25 r2-1, r2-2).
// cf's OAuth login may not delete API tokens (403). A token Cloudflare does not let it delete is
// never left silently: it stays in the state file's tokens to delete, and the output names it
// exactly, with the one link and the one click that delete it (manualDeletion).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { InstallationId } from "../../contracts/src/index.ts";
import { acquireLock } from "../staging/lock.ts";
import type { BootstrapState, StateStore } from "./machine.ts";
import {
  type ApiToken,
  deleteTokens,
  isR2TokenName,
  type LeftToken,
  leftOf,
  manualDeletion,
  R2_BUCKET_SCOPE,
  type TokenApi,
  TokensUnavailable,
} from "./r2-token.ts";
import { fileStateStore, installationsDir, resourceLockPaths } from "./state.ts";

/** The tokens a state file records: the current one and those left to delete. */
function recordedTokens(state: BootstrapState): LeftToken[] {
  const current = state.journal.r2Token;
  return [...(state.journal.r2TokensToDelete ?? []), ...(current ? [leftOf(current)] : [])];
}

/** The state with no current token, and `left` as the tokens still to delete. */
function withTokensLeft(state: BootstrapState, left: readonly LeftToken[]): BootstrapState {
  const { r2Token: _current, r2TokensToDelete: _left, ...journal } = state.journal;
  return {
    ...state,
    journal: { ...journal, ...(left.length > 0 ? { r2TokensToDelete: left } : {}) },
  };
}

export interface RemoveTokenOptions {
  readonly store: StateStore;
  readonly api: TokenApi;
  /**
   * Whether a Worker with the platform Worker's name exists, whichever installation it says it
   * is: an unknown identity (no version serving all traffic) counts as existing.
   */
  readonly workerExists: () => boolean;
  /** Remove the current token even so (the installer said --yes). */
  readonly force: boolean;
  readonly log: (message: string) => void;
}

export interface Removal {
  readonly deleted: number;
  /** Tokens the person still has to delete, named in the output. */
  readonly left: readonly LeftToken[];
}

/** Deletes the installation's R2 tokens: the current one and any left to delete. */
export function removeInstallationToken(options: RemoveTokenOptions): Removal {
  const state = options.store.load();
  const plan = state.installation;
  const tokens = recordedTokens(state);
  if (tokens.length === 0) {
    options.log("no R2 token recorded for this installation: nothing to delete");
    return { deleted: 0, left: [] };
  }
  // A Worker that may still use a token: the current one is refused, and no token is sought by
  // its name, which might be the one in use.
  const workerThere = !options.force && options.workerExists();
  if (workerThere && state.journal.r2Token !== undefined) {
    throw new Error(
      `a Worker named ${plan.platformWorker} still exists, and this installation's server reads and writes its database replica and files with the R2 token ${state.journal.r2Token.name}; remove the installation's Workers first, or pass --yes to cut it off now`,
    );
  }
  // Otherwise also any token of the installation's name that a lost answer left unrecorded,
  // where the login may list tokens.
  const result = deleteTokens(
    options.api,
    tokens,
    workerThere ? {} : { also: (t) => isR2TokenName(plan, t.name) },
  );
  options.store.save(withTokensLeft(options.store.load(), result.left));
  for (const t of result.deleted) options.log(`deleted the R2 token ${t.name}`);
  if (result.left.length > 0) options.log(manualDeletion(result.left));
  return { deleted: result.deleted.length, left: result.left };
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

const STAGING_TOKEN = /^(cfo-stg-[a-z0-9-]+)-r2--(ins_[0-9a-z]{26})--\d{8}T\d{6}Z$/;

/**
 * The staging deployment a listed token is named for, when it is a staging installation's R2
 * token in this account: named `<deployment>-r2--<installation ID>--<time>`, with every
 * resource in the account.
 */
export function stagingTokenDeployment(token: ApiToken, accountId: string): string | undefined {
  const deployment = stagingDeploymentOf(token.name);
  if (deployment === undefined) return undefined;
  const resources = token.policies.flatMap((p) => Object.keys(p.resources));
  const inAccount = `${R2_BUCKET_SCOPE}.${accountId}_`;
  if (resources.length === 0 || !resources.every((r) => r.startsWith(inAccount))) {
    return undefined;
  }
  return deployment;
}

function stagingDeploymentOf(name: string): string | undefined {
  const match = STAGING_TOKEN.exec(name);
  return match !== null && InstallationId.safeParse(match[2]).success ? match[1] : undefined;
}

/** The bootstrap's state files in its installations directory. */
export function installationStateFiles(dir: string = installationsDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
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
  /** The bootstrap state files to look in. */
  readonly stateFiles: () => readonly string[];
}

export interface StagingTokenResult {
  /** The tokens found, by name. */
  readonly found: readonly string[];
  readonly deleted: number;
  /** Tokens Cloudflare did not let the login delete: the person deletes them (or they expire). */
  readonly left: readonly LeftToken[];
  /** What could not be done, one line each. */
  readonly problems: readonly string[];
}

/** A staging installation's state file of this account, by its platform deployment. */
function stagingStates(
  options: StagingTokenOptions,
  problems: string[],
): Map<string, { path: string; state: BootstrapState }> {
  const states = new Map<string, { path: string; state: BootstrapState }>();
  for (const path of options.stateFiles()) {
    if (!existsSync(path)) continue;
    let state: BootstrapState;
    try {
      state = fileStateStore(path).load();
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const plan = state.installation;
    if (plan.target.kind === "staging" && plan.accountId === options.accountId) {
      states.set(plan.platformWorker, { path, state });
    }
  }
  return states;
}

/** The listing, or undefined where Cloudflare refuses it (an OAuth login). */
function tryList(api: TokenApi): ApiToken[] | undefined {
  try {
    return api.list();
  } catch (error) {
    if (error instanceof TokensUnavailable) return undefined;
    throw error;
  }
}

/**
 * The R2 tokens of staging installations whose platform deployment is `gone` (the registry no
 * longer holds it): reported, or deleted with `apply`. A token Cloudflare does not let the
 * login delete stays recorded in its state file, and is named with the click that deletes it.
 */
export function removeStagingTokens(
  gone: (deployment: string) => boolean,
  options: StagingTokenOptions,
): StagingTokenResult {
  const problems: string[] = [];
  const candidates = new Map<string, LeftToken[]>();
  const add = (deployment: string, tokens: readonly LeftToken[]) => {
    if (tokens.length === 0 || !gone(deployment)) return;
    candidates.set(deployment, [...(candidates.get(deployment) ?? []), ...tokens]);
  };
  for (const [deployment, { state }] of stagingStates(options, problems)) {
    add(deployment, recordedTokens(state));
  }
  for (const t of tryList(options.api) ?? []) {
    const deployment = stagingTokenDeployment(t, options.accountId);
    if (deployment !== undefined && !candidates.get(deployment)?.some((c) => c.id === t.id)) {
      add(deployment, [{ name: t.name, id: t.id }]);
    }
  }
  const found: string[] = [];
  const left: LeftToken[] = [];
  let deleted = 0;
  for (const [deployment, tokens] of candidates) {
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
      // A run may have deployed it, or made or retired a token, between the reading and the
      // locks: look again under them.
      if (!gone(deployment)) continue;
      const fresh = stagingStates(options, problems).get(deployment);
      const result = deleteTokens(options.api, fresh ? recordedTokens(fresh.state) : [], {
        also: (t) => stagingTokenDeployment(t, options.accountId) === deployment,
      });
      if (fresh !== undefined) {
        const store = fileStateStore(fresh.path);
        store.save(withTokensLeft(store.load(), result.left));
      }
      deleted += result.deleted.length;
      for (const t of result.deleted) options.log(`${deployment}: deleted the R2 token ${t.name}`);
      if (result.left.length > 0) {
        left.push(...result.left);
        options.log(`${deployment}: ${manualDeletion(result.left)}`);
      }
    } catch (error) {
      problems.push(`${deployment}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      release();
    }
  }
  return { found, deleted, left, problems };
}
