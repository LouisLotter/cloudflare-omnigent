// `bootstrap.ts update` (WP3.35): moves a finished installation to the release in this checkout.
// Written against the bootstrap's ports (machine.ts), so that tests drive it with a fake
// Cloudflare and interrupt it at any point. No I/O of its own.
//
// The one update path: `bootstrap.ts update` runs it, and so does step 7 of `run` (machine.ts)
// when `install` or `run` is repeated on a finished installation from a clean checkout of other
// code (WP3.34's step, which deployed both Workers again; it now comes here, with the check).
// In order, an update:
//   1. refuses unless the installation is finished: planned, initialized and released, with the
//      release checked (the journal), and the platform Worker showing it (`INITIALIZED` held, the
//      bootstrap password gone). Both Workers must exist and say they are this installation's
//      (their `CFO_INSTALLATION_ID`), as `run` checks before every deploy. The code must be a
//      clean checkout's commit (machine.ts, codeVersionFrom): code of unknown version is never
//      deployed over an installation;
//   2. reads the platform Worker's secret names (never a value) and makes what this release needs
//      that it lacks (`secretsToEnsure`: the cookie secret, WP3.34's launcher signing key, and
//      WP5.10's credential store keys and MCP state secret, each pair whole), with `run`'s own
//      generator; what only a person can give is refused, by name;
//   3. when the checkout's code is not what the journal records for both Workers (or an update to
//      it is unfinished, or a secret is missing), deploys the platform Worker from this checkout
//      with the plan's own configuration (the same names, the plan's buckets with its D33 tag or
//      without one, its variables) through the same adapter as `run`'s deploys: Wrangler builds
//      and pushes the images. The missing secrets go with the
//      deploy, added to what the Worker holds; Wrangler's deploy keeps every secret (it inherits
//      the previous version's, `keepSecrets`, and `--secrets-file` adds). The secret names are
//      read again after it: one the Worker held before and lost stops the update;
//   4. deploys the web Worker, behind its Access application read and checked just before (as
//      `run` does, with the same journal records), with ingress's variables rendered from the plan
//      and that application: the hostname, the owner pin, the team domain and AUD;
//   5. waits for the platform objects to switch to the new version and the server to restart on
//      it, then checks with the release's check (events.ts, verifyRelease): the server's object
//      runs the new version, a server started with the new configuration answers, without the
//      bootstrap password, and shows the owner initialized and durable. Every platform deploy of
//      an update carries its own `DEPLOY_ID_VAR`, which reaches the server: the configuration
//      changes, so the watchdog restarts the server once and its status lines are the proof.
//      Logs count only while the version serving is positively the update's own (its version
//      and deploy ID, from one read, `serving`); while Cloudflare does not say, nothing is
//      decided. A newer version (a secrets change, another deploy) means the update is deployed
//      again, with a restart of its own to check, never that another version is checked.
//
// Crash safety. The journal's `update` records each step's intent before its effect and its
// outcome after. A run that finds an unfinished update to the same code continues it: a platform
// deploy whose confirmation was not recorded is sent again (with a new deploy ID, so that its own
// restart proves it), a web deploy likewise; a confirmed deploy is never repeated, and a later run
// only checks (or, if a newer version serves since, deploys again). The secrets are recomputed
// from the names each time, so none is added twice. A run whose update to this code finished and
// checked, with nothing missing, deploys nothing.
//
// ADR 0007's restore point and read-only window (WP3.41, window.ts; owner decision D45): every
// update opens one, recorded in the journal before the first platform deploy with the versions
// that ran before. That deploy carries the window's secret, which keeps every request from the
// server once the platform's object runs it, and names the restore point the new server copies
// before Omnigent (and its migrations) starts. The check then also needs, from the update's own
// version, the window held and the restore point reported; then the update accepts the release:
// it records the decision, deletes the window's secret, and waits until the object runs without
// it. Until the decision, `bootstrap.ts update --rollback` (rollback.ts) can go back; after it,
// problems are fixed forward. An update to newer code while a window is open stays inside it, so
// its restore point stays the one from before the first.
//
// Never: a secret value in the journal or the log, a secret replaced or deleted (but the window's
// own), the bootstrap password, a request to the installation, a Worker deployed over one this
// plan did not create.

import {
  MAINTENANCE_WINDOW_SECRET,
  RESTORE_POINT_VAR,
  ROLLBACK_SECRET,
} from "../../worker/src/server/maintenance.ts";
import {
  type AccessApi,
  type AccessRecords,
  AccessRefusal,
  ensureOwnerAccess,
} from "./access-app.ts";
import { parseLogs, type Verification, verifyRelease } from "./events.ts";
// machine.ts's step 7 calls runUpdate, and this module uses machine.ts's refusal, generator and
// log reader: a cycle between the two modules, which neither uses at load time.
import {
  type BootstrapCloud,
  BootstrapRefusal,
  type BootstrapState,
  generatedSecrets,
  type Journal,
  type RunContext,
  type StateStore,
  slicedLogs,
  type WorkerIdentity,
} from "./machine.ts";
import {
  type AccessSettings,
  accessProblems,
  COOKIE_SECRET,
  containerEnvProblems,
  credentialStoreToAdd,
  DEPLOY_ID_VAR,
  type GeneratedSecrets,
  INITIALIZED_SECRET,
  INSTALLATION_ID_VAR,
  type Installation,
  installationProblems,
  KEY_SERVICE_KEY_ID_SECRET,
  KEY_SERVICE_KEY_SECRET,
  LAUNCHER_KEY_ID_SECRET,
  LAUNCHER_KEY_SECRET,
  launcherKeyToAdd,
  PASSWORD_SECRET,
  platformVars,
  renderPlatformConfig,
  renderWebConfig,
  requiredSecretNames,
} from "./settings.ts";
import {
  acceptWindow,
  closeWindow,
  newWindowId,
  type PreviousRelease,
  restorePointProblem,
  restorePointRecord,
  type WindowRecord,
  windowCheck,
} from "./window.ts";

/** The last update, as the journal keeps it. Names, times and IDs only, never a secret. */
export interface UpdateRecord {
  /** The code being deployed: the checkout's commit. */
  readonly code: string;
  readonly startedAt: string;
  /** The current platform deploy's own ID (DEPLOY_ID_VAR), recorded before it is sent. */
  readonly deployId?: string;
  readonly platformDeployStartedAt?: string;
  readonly platformDeployedAt?: string;
  /** The version serving all of the platform Worker's traffic right after its deploy. */
  readonly platformVersionId?: string;
  /** The secrets the update added to the platform Worker: their names. */
  readonly addedSecrets?: readonly string[];
  readonly webDeployStartedAt?: string;
  readonly webDeployedAt?: string;
  readonly webVersionId?: string;
  /** When the check after the switch passed. */
  readonly verifiedAt?: string;
}

export interface UpdateContext {
  readonly cloud: BootstrapCloud;
  readonly store: StateStore;
  /** The checked-in Wrangler configurations: worker/wrangler.jsonc and wrangler.web.jsonc. */
  readonly baseConfigs: RunContext["baseConfigs"];
  /**
   * The code this run deploys: the checkout's commit when nothing in the checkout differs from it
   * (machine.ts, codeVersionFrom); undefined otherwise, and nothing is deployed.
   */
  readonly codeVersion: string | undefined;
  /**
   * Access in the installer's own account: the hostname's owner-only application is read and
   * checked as `run` does it (and created only if it is gone). Without it (staging), the cloud's
   * `access` reads and checks it.
   */
  readonly accessApi?: AccessApi;
  /** The owner's address, given to this run: only to create a missing Access application. */
  readonly ownerEmail?: string;
  readonly random: (bytes: number) => Uint8Array;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface UpdateOptions {
  /** Whether to wait for, and check, the switch and the server's restart. */
  readonly verify: boolean;
  /** Between two Workers Logs queries. */
  readonly pollMs: number;
  /** When the objects switch after a deploy: about 300 s (S2, X1), with a margin. */
  readonly switchMs: number;
  /** How long to keep checking after the switch: the restart, and a new image's first start. */
  readonly verifyWaitMs: number;
  /** How long to wait for the object to run without the window once accepted (WP3.41). */
  readonly acceptWaitMs?: number;
}

export const DEFAULT_UPDATE_OPTIONS: UpdateOptions = {
  verify: true,
  pollMs: 30_000,
  switchMs: 330_000,
  verifyWaitMs: 15 * 60_000,
};

export type UpdateOutcome =
  /** The installation already runs this code, and holds everything it needs: nothing deployed. */
  | { readonly kind: "current" }
  /** Deployed, and the server checked on the new version. */
  | { readonly kind: "done" }
  /**
   * Deployed; the check has not passed yet (run update again: it checks, deploying nothing).
   * `window`: the update's read-only window is open (not accepted, rollback possible), or
   * accepted and closing (WP3.41).
   */
  | { readonly kind: "deployed"; readonly why: string; readonly window: "open" | "closing" };

/** A clean checkout's commit, as codeVersionFrom gives it and the journal keeps it. */
const CODE = /^[0-9a-f]{40}$/;

const iso = (ms: number) => new Date(ms).toISOString();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The installation's secrets this release needs that the platform Worker lacks, and that the
 * installer makes itself (`run`'s generator, machine.ts generatedSecrets): set only where the name
 * is missing, never replacing one, a pair only where both halves are. The update's "ensure the installation's
 * secrets" step: the cookie secret, which `run` makes at the first deploy, and the launcher's
 * signing key (WP3.34), which installations made before it lack. A secret a later release adds to
 * `run` belongs here too; until it is here, an installation that lacks it is refused by name
 * (`requiredAfterRelease`).
 */
export function secretsToEnsure(
  plan: Pick<Installation, "installationId">,
  present: ReadonlySet<string>,
  generated: GeneratedSecrets,
): Record<string, string> {
  const add: Record<string, string> = {};
  if (!present.has(COOKIE_SECRET)) add[COOKIE_SECRET] = generated.cookieSecret;
  // Only where the Worker holds neither half (runUpdate refuses half a pair).
  if (LAUNCHER_PAIR.every((name) => !present.has(name))) {
    Object.assign(add, launcherKeyToAdd(present, generated));
  }
  // The credential store's keys and the MCP state secret (WP5.10), so that MCP services work
  // without GitHub; an installation that ran `github-app` keeps the keys it made.
  Object.assign(add, credentialStoreToAdd(plan, present, generated));
  return add;
}

/** The launcher's signing pair (WP3.34): one credential, set whole or not at all. */
const LAUNCHER_PAIR = [LAUNCHER_KEY_SECRET, LAUNCHER_KEY_ID_SECRET] as const;
/** The key service's signing pair (WP5.10): the same rule. */
const KEY_SERVICE_PAIR = [KEY_SERVICE_KEY_SECRET, KEY_SERVICE_KEY_ID_SECRET] as const;

/** The secrets a finished installation holds: `run`'s required ones, the password long gone. */
export function requiredAfterRelease(plan: Installation): string[] {
  return requiredSecretNames(plan).filter((name) => name !== PASSWORD_SECRET);
}

/** How the update names a commit to the person. */
export function shortCode(code: string): string {
  return code.slice(0, 12);
}

export async function runUpdate(
  ctx: UpdateContext,
  options: UpdateOptions = DEFAULT_UPDATE_OPTIONS,
): Promise<UpdateOutcome> {
  let state = ctx.store.load();
  const plan = state.installation;
  const problems = installationProblems(plan);
  if (problems.length > 0) {
    throw new BootstrapRefusal(`the plan is not usable: ${problems.join("; ")}`);
  }
  // Every update takes a restore point beside the replica (WP3.41): refused before any effect
  // when there is no room for one, rather than opening a window it could not close.
  const noRoom = restorePointProblem(plan);
  if (noRoom !== undefined) {
    throw new BootstrapRefusal(
      `this installation cannot be updated: ${noRoom}; nothing was changed`,
    );
  }
  const record = (change: Partial<Journal>) => {
    state = { ...state, journal: { ...state.journal, ...change } };
    ctx.store.save(state);
  };
  const setJournal = (journal: Journal) => {
    state = { ...state, journal };
    ctx.store.save(state);
  };
  const current = (): UpdateRecord => {
    const update = state.journal.update;
    if (update === undefined) throw new Error("the journal holds no update");
    return update;
  };
  // The update's record, and with it any other journal field of the same step, in one write.
  const progress = (change: Partial<UpdateRecord>, also: Partial<Journal> = {}) =>
    record({ ...also, update: { ...current(), ...change } });
  const names = async (worker: string) => {
    const listed = await ctx.cloud.secretNames(worker);
    return listed === null ? null : new Set(listed);
  };
  const nothing = "; nothing was changed";

  // 1. A finished installation, this installation's Workers, and code of a known version.
  const journal = state.journal;
  if (journal.releasedAt === undefined) {
    throw new BootstrapRefusal(
      `this installation is not finished yet (the owner is not initialized and released): finish it with bootstrap.ts install, or run${nothing}`,
    );
  }
  if (journal.verifiedAt === undefined) {
    throw new BootstrapRefusal(
      `this installation's release has not been checked yet: finish it with bootstrap.ts run${nothing}`,
    );
  }
  const code = ctx.codeVersion;
  if (code === undefined || !CODE.test(code)) {
    throw new BootstrapRefusal(
      `this checkout has changes that are not committed (or git cannot say which commit it is), so it is not deployed over an installation: get the release with git pull, with no changes of your own, and run again${nothing}`,
    );
  }
  const present = await names(plan.platformWorker);
  if (present === null) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} no longer exists, so there is nothing to update${nothing}`,
    );
  }
  if (present.has(PASSWORD_SECRET) || !present.has(INITIALIZED_SECRET)) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} does not show the installation as initialized (${present.has(PASSWORD_SECRET) ? "it still holds the bootstrap password" : `it holds no ${INITIALIZED_SECRET}`}): check it with bootstrap.ts status${nothing}`,
    );
  }
  // Each Worker must say itself that it is this installation's: an update never deploys over a
  // Worker this plan did not create, and never creates one that is gone.
  const ours = async (worker: string): Promise<ServingIdentity> => {
    const identity = await ctx.cloud.workerInstallation(worker);
    if (!identity.exists) {
      throw new BootstrapRefusal(
        `${worker} no longer exists, so there is nothing to update${nothing}`,
      );
    }
    if (identity.installationId !== plan.installationId) {
      throw new BootstrapRefusal(
        `the Worker named ${worker} is not this installation's (its active version does not carry this installation's ID)${nothing}`,
      );
    }
    return identity;
  };
  // Wrangler's deploy sets exactly the configuration's variables and deletes the others (never a
  // secret): a variable this release no longer sets, or one set by hand, is named before it goes.
  const removes = (worker: string, held: Readonly<Record<string, string>>, config: unknown) => {
    const vars = ((config as { vars?: unknown }).vars ?? {}) as Record<string, unknown>;
    const gone = Object.keys(held)
      .filter((name) => !(name in vars))
      .sort();
    if (gone.length > 0) {
      ctx.log(
        `the deploy removes ${worker}'s variable${gone.length === 1 ? "" : "s"} ${gone.join(", ")}, which this release does not set`,
      );
    }
  };
  let platformIdentity = await ours(plan.platformWorker);
  const platformHeld = platformIdentity.vars ?? {};
  let webIdentity = await ours(plan.webWorker);

  // 2. What this release needs that the Worker lacks: made here, or refused by name. Half a
  // pair is never completed or replaced: the half held may be in use (Codex WP3.35 r1-1).
  for (const [pair, what] of [
    [LAUNCHER_PAIR, "the launcher's signing pair"],
    [KEY_SERVICE_PAIR, "the key service's signing pair"],
  ] as const) {
    const halves = pair.filter((name) => present.has(name));
    if (halves.length === 1) {
      const missing = pair.filter((name) => !present.has(name));
      throw new BootstrapRefusal(
        `${plan.platformWorker} holds ${halves.join("")} but not ${missing.join("")}, half of ${what}, and the update replaces no secret: delete the half it holds (Cloudflare dashboard, the Worker's Settings, Variables and Secrets) and run again, and the update adds a new pair${nothing}`,
      );
    }
  }
  const add = secretsToEnsure(plan, present, generatedSecrets(ctx));
  const adding = Object.keys(add).sort();
  const lacking = requiredAfterRelease(plan).filter((n) => !present.has(n) && !(n in add));
  if (lacking.length > 0) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} lacks ${lacking.join(", ")}, which the update cannot make: see the secret inventory (docs/secrets.md) and set ${lacking.length === 1 ? "it" : "them"} first${nothing}`,
    );
  }
  const standIns = Object.fromEntries([...present].map((name) => [name, "present"]));
  const envProblems = containerEnvProblems(
    {
      ...platformVars(plan),
      [DEPLOY_ID_VAR]: "stand-in",
      [RESTORE_POINT_VAR]: "rp-20000101T000000Z-00000000",
    },
    { ...standIns, ...add },
    plan,
  );
  if (envProblems.length > 0) {
    throw new BootstrapRefusal(`the server would not start: ${envProblems.join("; ")}${nothing}`);
  }

  // 3. The update's read-only window (WP3.41): nothing the journal does not explain, and an
  // acceptance once decided is finished first (from the decision on, the window only closes).
  if (state.journal.window?.rollback !== undefined) {
    throw new BootstrapRefusal(
      `the update is being rolled back: finish it with bootstrap.ts update --rollback${nothing}`,
    );
  }
  if (present.has(ROLLBACK_SECRET)) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} holds a rollback order (${ROLLBACK_SECRET}) that this state file does not explain: use the state file of the installer that ordered it, and finish with bootstrap.ts update --rollback${nothing}`,
    );
  }
  if (state.journal.window === undefined && present.has(MAINTENANCE_WINDOW_SECRET)) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} holds an update's read-only window (${MAINTENANCE_WINDOW_SECRET}) that this state file does not record: use the state file of the installer that opened it${nothing}`,
    );
  }
  let accepted = false;
  if (state.journal.window?.acceptStartedAt !== undefined) {
    // The window's update record is written with it, and stays while it is open.
    const updatedTo = (state.journal.update as UpdateRecord).code;
    const closed = await acceptWindow(ctx, () => state, setJournal, updatedTo, acceptWait(options));
    if (!closed.closed) return { kind: "deployed", why: closed.why, window: "closing" };
    // What runs now is the accepted release: the next window goes back to it (Codex WP3.41 r1).
    present.delete(MAINTENANCE_WINDOW_SECRET);
    platformIdentity = await ours(plan.platformWorker);
    webIdentity = await ours(plan.webWorker);
    accepted = true;
  }
  const opened = state.journal.window;
  if (
    opened !== undefined &&
    !present.has(MAINTENANCE_WINDOW_SECRET) &&
    platformIdentity.versionId !== opened.previous.platformVersionId
  ) {
    // The window's secret is gone, and the version from before the update no longer serves: the
    // update's deploy landed (its confirmation perhaps lost) and the window was ended outside the
    // installer. Omnigent may have taken changes since its restore point, so it can no longer go
    // back to it: the update starts afresh, with a restore point of now (Codex WP3.41 r1).
    setJournal(
      closeWindow(
        state.journal,
        restorePointRecord(
          plan,
          opened,
          "ended outside the installer",
          iso(ctx.now()),
          (state.journal.update as UpdateRecord).code,
        ),
      ),
    );
    ctx.log(
      `the update's read-only window was ended outside this installer (${plan.platformWorker} no longer holds ${MAINTENANCE_WINDOW_SECRET}), so Omnigent may have taken changes since its restore point and cannot go back to it: the update starts again, with a restore point of Omnigent's data as it is now`,
    );
  }

  // 4. Nothing to do, a new update, or the rest of an unfinished one to this code. Up to date
  // only when the last update is this code's and checked, or none was ever made (the install's
  // own release check covered its code): an unchecked update that a later, unfinished one
  // replaced in the journal is deployed and checked again (Codex WP3.35 r1-2). An unfinished
  // update continues only inside its window; one without (from before WP3.41) starts again.
  const window = state.journal.window;
  const last = state.journal.update;
  const resuming = window !== undefined && last?.code === code && last.verifiedAt === undefined;
  const checked = last === undefined || (last.code === code && last.verifiedAt !== undefined);
  const deployed = state.journal.platformCode === code && state.journal.webCode === code;
  if (checked && adding.length === 0 && deployed) {
    if (window === undefined) {
      // Just accepted: that update is done.
      if (accepted) return { kind: "done" };
      ctx.log(`https://${plan.hostname} already runs this checkout's version (${shortCode(code)})`);
      return { kind: "current" };
    }
    // Checked in its window, not accepted yet: accepted now.
    return accept(ctx, () => state, setJournal, code, options);
  }
  if (resuming) {
    ctx.log(`continuing the update of https://${plan.hostname} to ${shortCode(code)}`);
  } else if (window === undefined) {
    const previous = previousRelease(plan, platformIdentity, webIdentity, state.journal);
    const id = newWindowId(ctx.now(), ctx.random);
    record({
      update: { code, startedAt: iso(ctx.now()) },
      window: { id, openedAt: iso(ctx.now()), previous },
    });
    ctx.log(
      `updating https://${plan.hostname} to ${shortCode(code)}: ${plan.platformWorker}, then ${plan.webWorker}`,
    );
    ctx.log(
      `first the new server takes a restore point of Omnigent's data (${id}), and Omnigent is paused (it takes no requests) until the new version is checked: about 10 to 15 minutes`,
    );
  } else {
    record({ update: { code, startedAt: iso(ctx.now()) } });
    ctx.log(
      `updating https://${plan.hostname} to ${shortCode(code)} inside the read-only window opened at ${window.openedAt}: its restore point, from before the first update, stays the one to go back to`,
    );
  }

  // A confirmed deploy whose version no longer serves (a secrets change or another deploy since,
  // before the check) can never be checked: its own restart may be long over, and the version
  // serving may not restart the server at all. The update is deployed again, with a new deploy
  // ID and so a restart of its own to check (Codex WP3.35 r1-3, r2-1..3).
  if (
    resuming &&
    current().platformDeployedAt !== undefined &&
    serving(platformIdentity, current(), plan) === "other"
  ) {
    const { platformDeployedAt: _d, platformVersionId: _v, ...rest } = current();
    record({ update: rest });
    ctx.log(
      "a newer version of the platform Worker serves since this update's deploy (a secrets change or another deploy): deploying the update again, so that its own restart can be checked",
    );
  }

  // 5. The platform Worker, once per update; again only if its confirmation was not recorded,
  // if a secret it needs went missing since, or if its version no longer serves (above).
  if (current().platformDeployedAt === undefined || adding.length > 0) {
    const { platformDeployedAt: _d, platformVersionId: _v, ...rest } = current();
    const deployId = hex(ctx.random(8));
    record({
      update: {
        ...rest,
        deployId,
        platformDeployStartedAt: iso(ctx.now()),
        ...(adding.length > 0 ? { addedSecrets: adding } : {}),
      },
    });
    const rendered = renderPlatformConfig(ctx.baseConfigs.platform, plan);
    const open = currentWindow();
    // The window's ID twice: the restore point the new server takes, and the window's secret,
    // which keeps every request from the server while this version (or a later one) holds it.
    const config = {
      ...rendered,
      vars: {
        ...(rendered.vars as Record<string, string>),
        [DEPLOY_ID_VAR]: deployId,
        [RESTORE_POINT_VAR]: open.id,
      },
    };
    removes(plan.platformWorker, platformHeld, config);
    ctx.log(
      `deploying the platform Worker ${plan.platformWorker}${adding.length > 0 ? `, adding ${adding.join(", ")}` : ""}: Wrangler builds and pushes the images first, the slow part`,
    );
    await ctx.cloud.deployPlatform(plan, config, { ...add, [MAINTENANCE_WINDOW_SECRET]: open.id });
    const after = await names(plan.platformWorker);
    if (after === null) {
      throw new Error(`after the deploy, ${plan.platformWorker} does not exist; run update again`);
    }
    const lost = [...present].filter((name) => !after.has(name)).sort();
    if (lost.length > 0) {
      throw new BootstrapRefusal(
        `after the deploy, ${plan.platformWorker} no longer holds ${lost.join(", ")}, which it held before: the update cannot restore a secret's value. Check the installation by hand (docs/secrets.md); nothing more was changed`,
      );
    }
    const missing = [...adding, MAINTENANCE_WINDOW_SECRET].filter((name) => !after.has(name));
    if (missing.length > 0) {
      throw new Error(
        `after the deploy, ${plan.platformWorker} lacks ${missing.join(", ")}; run update again`,
      );
    }
    const versionId = await ctx.cloud.activeVersion(plan.platformWorker);
    progress(
      {
        platformDeployedAt: iso(ctx.now()),
        ...(versionId === undefined ? {} : { platformVersionId: versionId }),
      },
      { platformCode: code },
    );
    ctx.log(
      `deployed the platform Worker: it kept all ${present.size} of its secrets${adding.length > 0 ? ` and holds ${adding.join(", ")} now` : ""}`,
    );
  }

  // 6. The web Worker, behind the hostname's Access application, read and checked just before.
  if (current().webDeployedAt === undefined) {
    const found = await ownerAccess(
      ctx,
      plan,
      () => state.journal,
      (journal) => {
        state = { ...state, journal };
        ctx.store.save(state);
      },
    );
    const issues = accessProblems(plan, found);
    if (issues.length > 0) {
      throw new BootstrapRefusal(`Access is not ready: ${issues.join("; ")}`);
    }
    const access = { ...found, checkedAt: iso(ctx.now()) };
    record({ access });
    const webHeld = (await ours(plan.webWorker)).vars ?? {};
    const webConfig = renderWebConfig(ctx.baseConfigs.web, plan, found);
    progress({ webDeployStartedAt: iso(ctx.now()) });
    removes(plan.webWorker, webHeld, webConfig);
    ctx.log(`deploying the web Worker ${plan.webWorker} for https://${plan.hostname}`);
    await ctx.cloud.deployWeb(plan, webConfig);
    const versionId = await ctx.cloud.activeVersion(plan.webWorker);
    const at = iso(ctx.now());
    progress(
      { webDeployedAt: at, ...(versionId === undefined ? {} : { webVersionId: versionId }) },
      { webCode: code, updatedAt: at },
    );
    ctx.log("deployed the web Worker");
  }

  // 7. The switch, the server's restart on the new configuration, its owner and its restore
  // point; then the acceptance, which ends the window.
  if (!options.verify) {
    return { kind: "deployed", why: "the check after the update was skipped", window: "open" };
  }
  const checkedUpdate = await checkUpdate(
    ctx,
    () => state,
    progress,
    (update) => record({ update }),
    (change) => record({ window: { ...currentWindow(), ...change } }),
    options,
  );
  if (checkedUpdate.kind !== "done") return checkedUpdate;
  return accept(ctx, () => state, setJournal, code, options);

  function currentWindow(): WindowRecord {
    const open = state.journal.window;
    if (open === undefined) throw new Error("the journal holds no update window");
    return open;
  }
}

/** How long an acceptance waits for the object to run without the window, unless told. */
const ACCEPT_WAIT_MS = 10 * 60_000;

function acceptWait(options: UpdateOptions) {
  return { pollMs: options.pollMs, waitMs: options.acceptWaitMs ?? ACCEPT_WAIT_MS };
}

/** Accepts the release in its window, and says how it went. */
async function accept(
  ctx: UpdateContext,
  state: () => BootstrapState,
  setJournal: (journal: Journal) => void,
  code: string,
  options: UpdateOptions,
): Promise<UpdateOutcome> {
  const closed = await acceptWindow(ctx, state, setJournal, code, acceptWait(options));
  return closed.closed
    ? { kind: "done" }
    : { kind: "deployed", why: closed.why, window: "closing" };
}

/**
 * What runs before the update, to go back to: the versions serving all of each Worker's traffic,
 * read just now, and the code the journal records. Refused when Cloudflare does not name a
 * version for either (a gradual deployment): the update could not go back to it.
 */
function previousRelease(
  plan: Installation,
  platform: ServingIdentity,
  web: ServingIdentity,
  journal: Journal,
): PreviousRelease {
  for (const [worker, identity] of [
    [plan.platformWorker, platform],
    [plan.webWorker, web],
  ] as const) {
    if (identity.versionId === undefined) {
      throw new BootstrapRefusal(
        `Cloudflare does not name one version serving all of ${worker}'s traffic (a gradual deployment?), so the update could not go back to it; nothing was changed`,
      );
    }
  }
  return {
    platformVersionId: String(platform.versionId),
    webVersionId: String(web.versionId),
    ...(journal.platformCode === undefined ? {} : { platformCode: journal.platformCode }),
    ...(journal.webCode === undefined ? {} : { webCode: journal.webCode }),
  };
}

/**
 * The hostname's owner-only Access application, as `run` reads it before the web deploy: created
 * only when it is gone (the installer's account, with the owner's address), and checked
 * owner-only either way; the same journal records as `run`'s.
 */
async function ownerAccess(
  ctx: UpdateContext,
  plan: Installation,
  journal: () => Journal,
  setJournal: (journal: Journal) => void,
): Promise<AccessSettings> {
  if (ctx.accessApi === undefined) return ctx.cloud.access(plan);
  // The Access records are replaced whole, and left out when empty (as in `run`).
  const records = (r: AccessRecords) => {
    const { accessApp: _app, accessLoginMethod: _method, ...rest } = journal();
    setJournal({
      ...rest,
      ...(r.app === undefined ? {} : { accessApp: r.app }),
      ...(r.loginMethod === undefined ? {} : { accessLoginMethod: r.loginMethod }),
    });
  };
  try {
    return await ensureOwnerAccess({
      api: ctx.accessApi,
      plan,
      ownerEmail: ctx.ownerEmail,
      recorded: () => {
        const { accessApp, accessLoginMethod } = journal();
        return {
          ...(accessApp === undefined ? {} : { app: accessApp }),
          ...(accessLoginMethod === undefined ? {} : { loginMethod: accessLoginMethod }),
        };
      },
      record: records,
      now: ctx.now,
      sleep: ctx.sleep,
      nonce: () => hex(ctx.random(4)),
      log: ctx.log,
    });
  } catch (error) {
    if (error instanceof AccessRefusal) throw new BootstrapRefusal(error.message);
    throw error;
  }
}

/** What `workerInstallation` says of a Worker that exists. */
type ServingIdentity = Extract<WorkerIdentity, { readonly exists: true }>;

/**
 * Whether the version serving all of the platform Worker's traffic is this update's deploy: its
 * variables carry the update's deploy ID, and it is the version recorded right after the deploy
 * (or none was recorded). Its version and variables come from one read, so they belong together.
 * "unknown" when Cloudflare names no version, or lists its variables without the installation's
 * own: nothing is decided on that.
 */
export function serving(
  identity: WorkerIdentity,
  update: UpdateRecord,
  plan: Pick<Installation, "installationId">,
): "ours" | "other" | "unknown" {
  if (!identity.exists || identity.versionId === undefined || identity.vars === undefined) {
    return "unknown";
  }
  if (identity.vars[INSTALLATION_ID_VAR] !== plan.installationId) return "unknown";
  const recorded = update.platformVersionId;
  return identity.vars[DEPLOY_ID_VAR] === update.deployId &&
    (recorded === undefined || recorded === identity.versionId)
    ? "ours"
    : "other";
}

/**
 * After the deploys: the platform objects switch to the new version (about 300 s), the watchdog
 * finds the server started with another configuration and replaces it once, and the server
 * started with the new one logs its status without the bootstrap password. The release's own
 * check (verifyRelease), with the update's platform version and the start of its deploy.
 */
async function checkUpdate(
  ctx: UpdateContext,
  state: () => { readonly journal: Journal; readonly installation: Installation },
  progress: (change: Partial<UpdateRecord>) => void,
  replace: (update: UpdateRecord) => void,
  setWindow: (change: Partial<WindowRecord>) => void,
  options: UpdateOptions,
): Promise<UpdateOutcome> {
  const plan = state().installation;
  const update = (): UpdateRecord => state().journal.update as UpdateRecord;
  const since = Date.parse(String(update().platformDeployStartedAt));
  const switchAt = Date.parse(String(update().platformDeployedAt)) + options.switchMs;
  if (ctx.now() < switchAt) {
    ctx.log(
      "waiting for the platform objects to switch to the new version and the server to restart on it (about 5 to 10 minutes)",
    );
    await ctx.sleep(switchAt - ctx.now());
  }
  const logsSince = slicedLogs(ctx, plan.platformWorker);
  const seen = await pollServer<UpdateOutcome>(
    ctx,
    { pollMs: options.pollMs, deadline: ctx.now() + options.verifyWaitMs },
    async () => {
      // Logs count only while the version serving is positively this update's deploy: its own
      // version and deploy ID, read together (Codex WP3.35 r2-1, r2-2).
      const identity = await ctx.cloud.workerInstallation(plan.platformWorker);
      const which = serving(identity, update(), plan);
      if (which === "other") {
        const { platformDeployedAt: _d, platformVersionId: _v, ...rest } = update();
        replace(rest);
        return {
          decided: {
            kind: "deployed",
            why: "a newer version of the platform Worker serves since this update's deploy (a secrets change or another deploy); run update again, and it deploys the update again",
            window: "open",
          },
        };
      }
      if (which === "ours" && update().platformVersionId === undefined && identity.exists) {
        // Cloudflare did not say right after the deploy; the version serving now, carrying this
        // update's deploy ID, is its version.
        progress({ platformVersionId: String(identity.versionId) });
      }
      if (which === "unknown") {
        return { why: "Cloudflare does not say yet which version serves the platform Worker" };
      }
      const logs = parseLogs(await logsSince(since, ctx.now()), plan.platformWorker);
      // The update's window (WP3.41), which every update opens before its deploy: held by its
      // own version, and the restore point taken, recorded as soon as the server reports it (a
      // rollback names its time).
      const open = state().journal.window as WindowRecord;
      const held = windowCheck(logs, {
        installationId: plan.installationId,
        versionId: update().platformVersionId,
        since,
        id: open.id,
      });
      if (held.ok && open.restorePointTakenAt !== held.takenAt) {
        setWindow({ restorePointTakenAt: held.takenAt });
      }
      const result: Verification = verifyRelease(logs, {
        installationId: plan.installationId,
        releasedVersionId: update().platformVersionId,
        releasedAt: since,
      });
      if (!result.verified) return { why: result.why };
      if (!held.ok) return { why: held.why };
      progress({ verifiedAt: iso(ctx.now()) });
      ctx.log(
        `checked: the server restarted on the new version, answers, and shows the owner initialized and durable; its restore point ${open.id} was taken at ${held.takenAt}`,
      );
      return { decided: { kind: "done" } };
    },
  );
  return "decided" in seen ? seen.decided : { kind: "deployed", why: seen.why, window: "open" };
}

/**
 * The installer's wait for the server (WP3.35, WP3.36): `look` reads the platform Worker's
 * state and logs once per poll, and either decides or says why not yet. Each new reason is
 * logged once ("waiting: …"); the last one is returned when the deadline would pass before the
 * next poll. `update` checks its restart with it, and the GitHub step waits for GitHub linking.
 */
export async function pollServer<T>(
  ctx: Pick<UpdateContext, "now" | "sleep" | "log">,
  options: { readonly pollMs: number; readonly deadline: number },
  look: () => Promise<{ readonly decided: T } | { readonly why: string }>,
): Promise<{ readonly decided: T } | { readonly why: string }> {
  let said: string | undefined;
  for (;;) {
    const seen = await look();
    if ("decided" in seen) return seen;
    if (seen.why !== said) {
      said = seen.why;
      ctx.log(`waiting: ${seen.why}`);
    }
    if (ctx.now() + options.pollMs > options.deadline) return seen;
    await ctx.sleep(options.pollMs);
  }
}
