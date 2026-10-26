// The bootstrap's steps (WP2.4), written against small ports so that tests can drive them with
// a fake Cloudflare and interrupt them at any point. No I/O of its own.
//
// In order, each run:
//   1. deploys the platform Worker with the installation's variables, adding only the secrets it
//      does not hold yet: the cookie secret, `INITIALIZED=false`, the owner's password and the
//      replica's credentials (one Worker version, `--secrets-file`);
//   2. reads the hostname's Access application and checks that it is owner-only (no bypass, no
//      service token, the owner's pin as its one identity) and sets SameSite=lax;
//   3. deploys the web Worker with ingress's variables, behind that Access application;
//   4. waits for the watchdog's bootstrap status in Workers Logs showing this installation's
//      owner initialized and durable (events.ts). The cron starts the server within a minute:
//      no browser and no request to the installation is needed, and none is made;
//   5. releases: one change of the platform Worker's secrets that sets `INITIALIZED=true` and
//      deletes the password, a deliberate platform release (R-27), sent only while the
//      accepted status is still fresh;
//   6. checks, after the objects switch to the released version (about 300 s), that the
//      OmnigentServer object runs it and no longer reports the password, and that the release
//      is applied: the watchdog replaced the server (one controlled restart), and the server
//      started with the released configuration reports a durable owner (G2-SEC-001). Until
//      then the outcome is "released", not yet applied, and a later run checks again.
//
// Crash safety. The journal in the state file is written before each effect and after it.
// A run re-reads the platform Worker's secret names first, so a step whose effect landed
// before a crash is recognised, and a step whose effect did not land is repeated. Deploys and
// the release are idempotent: secrets are only ever added when missing, and the release is sent
// only while the password still exists. The release always follows an acceptance made in the
// same run, never one remembered from an earlier run; the newest status ever seen is kept, so a
// later query that misses it cannot bring back an older one. Once a release is recorded, or the
// Worker shows one, the password is never uploaded again. Neither Worker is deployed over one
// this plan did not create. Runs against the same Workers are serialised by the caller
// (bootstrap.ts takes a lock per account and Worker name, whatever the state file).
//
// Never: a request to the installation (`POST /auth/setup` included), an Access bypass or
// service token, a secret value in the journal or the log.

import type { BootstrapStatus } from "../../contracts/src/index.ts";
import {
  decide,
  FRESH_MS,
  newest,
  parseLogs,
  type StatusEvent,
  staleness,
  verifyRelease,
} from "./events.ts";
import {
  type AccessSettings,
  accessProblems,
  containerEnvProblems,
  INITIALIZED_SECRET,
  type Installation,
  installationProblems,
  needsReplicaCredentials,
  PASSWORD_SECRET,
  platformVars,
  RELEASE_CHANGES,
  REPLICA_KEY_ID_SECRET,
  REPLICA_SECRET_KEY_SECRET,
  renderPlatformConfig,
  renderWebConfig,
  requiredSecretNames,
  type SuppliedSecrets,
  secretsToAdd,
} from "./settings.ts";

/** What the bootstrap needs of Cloudflare. Implemented by cloud.ts and staging.ts. */
export interface BootstrapCloud {
  /** The Worker's secret names, or null when Cloudflare says the Worker does not exist. */
  secretNames(worker: string): Promise<string[] | null>;
  /**
   * The hostname's owner-only Access application, read and checked (`ownerOnly`), as the web
   * Worker needs it. The staging adapter may first create it through the guarded staging tool.
   */
  access(plan: Installation): Promise<AccessSettings>;
  /** Deploys the platform Worker, uploading `secrets` with the version. */
  deployPlatform(
    plan: Installation,
    config: Readonly<Record<string, unknown>>,
    secrets: Readonly<Record<string, string>>,
  ): Promise<void>;
  deployWeb(plan: Installation, config: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * Which installation a Worker belongs to: its active version's `CFO_INSTALLATION_ID`
   * variable, which every Worker the bootstrap deploys carries. Read-only.
   */
  workerInstallation(worker: string): Promise<WorkerIdentity>;
  /**
   * One change of the Worker's secrets, a new deployed version: a value sets one, null deletes
   * one. Fails, and creates nothing, when the Worker does not exist. Sent only if `notAfter`
   * (milliseconds) has not passed once every check before it is done; otherwise nothing is
   * sent and the answer is "expired".
   */
  updateSecrets(
    worker: string,
    changes: Readonly<Record<string, string | null>>,
    notAfter?: number,
  ): Promise<"sent" | "expired">;
  /** The version serving all of the Worker's traffic now, or undefined if not one. Read-only. */
  activeVersion(worker: string): Promise<string | undefined>;
  /** Workers Logs events of the Worker between two times, in milliseconds. */
  logs(worker: string, fromMs: number, toMs: number): Promise<unknown[]>;
}

/** Whether a Worker exists, and the installation its active version names, if any. */
export type WorkerIdentity =
  | { readonly exists: false }
  | { readonly exists: true; readonly installationId: string | undefined };

/** A status as the journal keeps it: the newest seen, so no later query can roll it back. */
export interface SeenStatus {
  readonly loggedAt: number;
  readonly versionId?: string;
  readonly status: BootstrapStatus;
  readonly reason?: string;
}

/** Progress, kept in the state file. Times are the laptop's, ISO 8601. No secret. */
export interface Journal {
  readonly platformDeployStartedAt?: string;
  readonly platformDeployedAt?: string;
  readonly access?: AccessSettings & { readonly checkedAt: string };
  readonly webDeployStartedAt?: string;
  readonly webDeployedAt?: string;
  /** The newest status of this installation seen so far (the watermark). */
  readonly newestStatus?: SeenStatus;
  /** The last status accepted, and the version that logged it. */
  readonly accepted?: {
    readonly at: string;
    readonly status: BootstrapStatus;
    readonly versionId?: string;
  };
  readonly releaseStartedAt?: string;
  readonly releasedAt?: string;
  /** The version the release deployed, as Cloudflare listed it right after. */
  readonly releasedVersionId?: string;
  readonly verifiedAt?: string;
}

export interface BootstrapState {
  readonly stateVersion: 1;
  readonly installation: Installation;
  readonly journal: Journal;
}

export interface StateStore {
  load(): BootstrapState;
  /** Replaces the state file atomically. */
  save(state: BootstrapState): void;
}

export interface RunContext {
  readonly cloud: BootstrapCloud;
  readonly store: StateStore;
  /** The checked-in Wrangler configurations: worker/wrangler.jsonc and wrangler.web.jsonc. */
  readonly baseConfigs: {
    readonly platform: Readonly<Record<string, unknown>>;
    readonly web: Readonly<Record<string, unknown>>;
  };
  /** The installer's secrets; called only when one of them must be uploaded. */
  readonly secrets: () => SuppliedSecrets;
  readonly random: (bytes: number) => Uint8Array;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface RunOptions {
  /** How long to wait for the owner to be initialized and durable before giving up for now. */
  readonly waitMs: number;
  /** Between two Workers Logs queries. */
  readonly pollMs: number;
  /** Whether to wait for, and check, the version switch after the release. */
  readonly verify: boolean;
  /** When the objects switch after a release: about 300 s (S2, X1), with a margin. */
  readonly switchMs: number;
  /** How long to keep checking after the switch. */
  readonly verifyWaitMs: number;
}

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};

/** How far back a Workers Logs query looks for the newest status. */
const LOOKBACK_MS = 15 * 60_000;
/**
 * After a release, Workers Logs are read in slices this long: one query answers at most 2,000
 * events, newest first, so over a long interval later activity would hide the release's
 * evidence (Codex G2-SEC-001 r2-3).
 */
export const LOG_SLICE_MS = 5 * 60_000;
/** A slice that ended this long ago is complete: it is read once per run. */
const SETTLED_MS = 10 * 60_000;

/** Reads a Worker's logs between two times, slice by slice, reading settled slices once. */
function slicedLogs(
  ctx: RunContext,
  worker: string,
): (fromMs: number, toMs: number) => Promise<unknown[]> {
  const settled = new Map<number, unknown[]>();
  return async (fromMs, toMs) => {
    const events: unknown[] = [];
    for (let start = fromMs; start < toMs; start += LOG_SLICE_MS) {
      const end = Math.min(toMs, start + LOG_SLICE_MS);
      const whole = end === start + LOG_SLICE_MS;
      let slice = whole ? settled.get(start) : undefined;
      if (slice === undefined) {
        slice = await ctx.cloud.logs(worker, start, end);
        if (whole && end <= ctx.now() - SETTLED_MS) settled.set(start, slice);
      }
      events.push(...slice);
    }
    return events;
  };
}

export type Outcome =
  /** Released and checked after the version switch. */
  | { readonly kind: "done" }
  /** Released; the check after the switch has not passed yet (run again to check). */
  | { readonly kind: "released"; readonly why: string }
  /** The owner is not initialized and durable yet; the password stays. Run again to continue. */
  | { readonly kind: "waiting"; readonly why: string };

const iso = (ms: number) => new Date(ms).toISOString();

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function seenOf(event: StatusEvent): SeenStatus {
  return {
    loggedAt: event.loggedAt,
    status: event.status,
    ...(event.versionId === undefined ? {} : { versionId: event.versionId }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  };
}

function eventOf(seen: SeenStatus | undefined): StatusEvent | undefined {
  return seen === undefined
    ? undefined
    : {
        loggedAt: seen.loggedAt,
        versionId: seen.versionId,
        status: seen.status,
        reason: seen.reason,
        secretPresent: undefined,
        configApplied: undefined,
      };
}

/** A deliberate stop: the installer must look before anything else happens. */
export class BootstrapRefusal extends Error {}

export async function runBootstrap(
  ctx: RunContext,
  options: RunOptions = DEFAULT_RUN_OPTIONS,
): Promise<Outcome> {
  let state = ctx.store.load();
  const plan = state.installation;
  const problems = installationProblems(plan);
  if (problems.length > 0)
    throw new BootstrapRefusal(`the plan is not usable: ${problems.join("; ")}`);
  const record = (change: Partial<Journal>) => {
    state = { ...state, journal: { ...state.journal, ...change } };
    ctx.store.save(state);
  };
  const names = async (worker = plan.platformWorker) => {
    const listed = await ctx.cloud.secretNames(worker);
    return listed === null ? null : new Set(listed);
  };

  let secrets = await names();
  // A release recorded, or shown by the Worker, is final: nothing below may undo it.
  if (state.journal.releaseStartedAt !== undefined && state.journal.releasedAt === undefined) {
    if (secrets !== null && !secrets.has(PASSWORD_SECRET) && secrets.has(INITIALIZED_SECRET)) {
      ctx.log("the release had taken effect before the last run stopped");
      record({ releasedAt: iso(ctx.now()) });
    }
  }
  if (state.journal.releasedAt !== undefined) {
    return verifyAfterRelease(ctx, () => state, options, record);
  }
  if (secrets?.has(INITIALIZED_SECRET) && !secrets.has(PASSWORD_SECRET)) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} holds ${INITIALIZED_SECRET} but no bootstrap password, and this state file records no release. It looks released already; the bootstrap will not upload the password again. Check the installation by hand.`,
    );
  }

  // Neither Worker is deployed over one that this plan did not create.
  if (secrets === null && state.journal.platformDeployedAt !== undefined) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} was deployed by this plan but no longer exists; plan a new installation`,
    );
  }
  // A Worker that exists is this installation's only if it says so itself: every Worker the
  // bootstrap deploys carries the installation's ID. The journal alone is no proof: a step
  // recorded as started may never have run, and the name taken meanwhile (Codex WP2.4 r2-1).
  const ours = async (worker: string) => {
    const identity = await ctx.cloud.workerInstallation(worker);
    if (identity.exists && identity.installationId !== plan.installationId) {
      throw new BootstrapRefusal(
        `a Worker named ${worker} exists and is not this installation's; choose another name`,
      );
    }
  };
  await ours(plan.platformWorker);
  if (state.journal.webDeployedAt === undefined) await ours(plan.webWorker);

  // 1. The platform Worker.
  if (secrets === null || state.journal.platformDeployedAt === undefined) {
    const present = secrets ?? new Set<string>();
    const needsInstaller =
      !present.has(PASSWORD_SECRET) ||
      (needsReplicaCredentials(plan) &&
        (!present.has(REPLICA_KEY_ID_SECRET) || !present.has(REPLICA_SECRET_KEY_SECRET)));
    const add = secretsToAdd(plan, present, needsInstaller ? ctx.secrets() : {}, {
      cookieSecret: hex(ctx.random(32)),
    });
    const config = renderPlatformConfig(ctx.baseConfigs.platform, plan);
    // Present secrets keep their values; a placeholder stands in for the check.
    const standIns = Object.fromEntries([...present].map((name) => [name, "present"]));
    const envProblems = containerEnvProblems(platformVars(plan), { ...standIns, ...add }, plan);
    if (envProblems.length > 0) {
      throw new BootstrapRefusal(`the server would not start: ${envProblems.join("; ")}`);
    }
    record({ platformDeployStartedAt: state.journal.platformDeployStartedAt ?? iso(ctx.now()) });
    ctx.log(
      `deploying the platform Worker ${plan.platformWorker}${
        Object.keys(add).length > 0 ? ` with ${Object.keys(add).sort().join(", ")}` : ""
      }`,
    );
    await ctx.cloud.deployPlatform(plan, config, add);
    secrets = await names();
    const missing = requiredSecretNames(plan).filter((name) => !secrets?.has(name));
    if (secrets === null || missing.length > 0) {
      throw new Error(
        `after the deploy, ${plan.platformWorker} ${secrets === null ? "does not exist" : `lacks ${missing.join(", ")}`}; run again`,
      );
    }
    record({ platformDeployedAt: iso(ctx.now()) });
  }

  // 2. Access, read and checked just before; 3. the web Worker behind it. The staging adapter
  // may deploy the web Worker to create its Access application; that deploy carries the
  // installation's ID too, so the check before the web deploy recognises it.
  if (state.journal.webDeployedAt === undefined) {
    const found = await ctx.cloud.access(plan);
    const accessIssues = accessProblems(plan, found);
    if (accessIssues.length > 0) {
      throw new BootstrapRefusal(`Access is not ready: ${accessIssues.join("; ")}`);
    }
    const access = { ...found, checkedAt: iso(ctx.now()) };
    record({ access });
    await ours(plan.webWorker);
    record({ webDeployStartedAt: state.journal.webDeployStartedAt ?? iso(ctx.now()) });
    const config = renderWebConfig(ctx.baseConfigs.web, plan, access);
    ctx.log(`deploying the web Worker ${plan.webWorker} for https://${plan.hostname}`);
    await ctx.cloud.deployWeb(plan, config);
    record({ webDeployedAt: iso(ctx.now()) });
  }

  // 4. The watchdog's status in Workers Logs; 5. the release, sent only while that status is
  // fresh, judged after the last read before it (Codex WP2.4 r1-5, r2-2). An acceptance that
  // grew stale sends the bootstrap back to waiting, within the same deadline (r2-3).
  const deadline = ctx.now() + options.waitMs;
  for (;;) {
    const accepted = await waitForOwner(ctx, () => state, record, options, deadline);
    if (!accepted.ok) return { kind: "waiting", why: accepted.why };
    record({
      accepted: {
        at: iso(ctx.now()),
        status: accepted.event.status,
        ...(accepted.event.versionId === undefined ? {} : { versionId: accepted.event.versionId }),
      },
    });
    secrets = await names();
    if (secrets === null) throw new Error(`${plan.platformWorker} no longer exists`);
    if (!secrets.has(PASSWORD_SECRET)) {
      throw new BootstrapRefusal(
        `${plan.platformWorker} no longer holds the bootstrap password, but no release is recorded; check the installation by hand`,
      );
    }
    let stale = staleness(accepted.event, ctx.now());
    if (stale === undefined) {
      record({ releaseStartedAt: state.journal.releaseStartedAt ?? iso(ctx.now()) });
      ctx.log(
        `releasing: ${INITIALIZED_SECRET}=true and the bootstrap password deleted, in one platform release`,
      );
      const notAfter = Date.parse(accepted.event.status.checkedAt) + FRESH_MS;
      const sent = await ctx.cloud.updateSecrets(plan.platformWorker, RELEASE_CHANGES, notAfter);
      if (sent === "sent") break;
      stale = "the accepted status grew too old before the release was sent";
    }
    ctx.log(`waiting again: ${stale}`);
    if (ctx.now() + options.pollMs > deadline) return { kind: "waiting", why: stale };
  }
  secrets = await names();
  if (secrets === null || secrets.has(PASSWORD_SECRET) || !secrets.has(INITIALIZED_SECRET)) {
    throw new Error("the release has not taken effect yet; run again");
  }
  const releasedVersionId = await ctx.cloud.activeVersion(plan.platformWorker);
  record({
    releasedAt: iso(ctx.now()),
    ...(releasedVersionId === undefined ? {} : { releasedVersionId }),
  });
  ctx.log("released: the bootstrap password is gone and the installation is marked initialized");
  return verifyAfterRelease(ctx, () => state, options, record);
}

type Accepted = { ok: true; event: StatusEvent } | { ok: false; why: string };

async function waitForOwner(
  ctx: RunContext,
  current: () => BootstrapState,
  record: (change: Partial<Journal>) => void,
  options: RunOptions,
  deadline: number,
): Promise<Accepted> {
  const plan = current().installation;
  let said: string | undefined;
  for (;;) {
    const from = ctx.now() - LOOKBACK_MS;
    const events = await ctx.cloud.logs(plan.platformWorker, from, ctx.now());
    // Freshness is judged when the answer is in, not when the query was sent.
    const now = ctx.now();
    const logs = parseLogs(events, plan.platformWorker);
    const seen = eventOf(current().journal.newestStatus);
    const decision = decide(logs.statuses, { installationId: plan.installationId, now, seen });
    // Keep the newest status of this installation, so a later answer cannot roll it back.
    const mine = logs.statuses.filter((e) => e.status.installationId === plan.installationId);
    const newer = newest([...mine, ...(seen === undefined ? [] : [seen])]);
    if (newer !== undefined && newer !== seen) record({ newestStatus: seenOf(newer) });
    if (decision.accepted) {
      ctx.log(`the owner is initialized and durable (checked ${decision.event.status.checkedAt})`);
      return { ok: true, event: decision.event };
    }
    const ignored =
      logs.malformed > 0 ? ` (${logs.malformed} bootstrap lines ignored: not the watchdog's)` : "";
    if (`${decision.why}${ignored}` !== said) {
      said = `${decision.why}${ignored}`;
      ctx.log(`waiting: ${said}`);
    }
    if (ctx.now() + options.pollMs > deadline) return { ok: false, why: decision.why };
    await ctx.sleep(options.pollMs);
  }
}

async function verifyAfterRelease(
  ctx: RunContext,
  current: () => BootstrapState,
  options: RunOptions,
  record: (change: Partial<Journal>) => void,
): Promise<Outcome> {
  if (current().journal.verifiedAt !== undefined) return { kind: "done" };
  if (!options.verify) return { kind: "released", why: "the check after the release was skipped" };
  if (current().journal.releasedVersionId === undefined) {
    // A release whose run stopped before it could ask: the version serving now has no
    // password either, since secrets carry over to every later version.
    const version = await ctx.cloud.activeVersion(current().installation.platformWorker);
    if (version !== undefined) record({ releasedVersionId: version });
  }
  const { journal, installation: plan } = current();
  // The release took effect between its journalled start and its confirmation. A run that found
  // it already in effect records the confirmation only when it resumes, maybe long after: the
  // start bounds it instead, so the server's lines since then still count (Codex G2-SEC-001
  // r1-3). The released version's ID is what ties a line to the release.
  const confirmedAt = Date.parse(String(journal.releasedAt));
  const startedAt = Date.parse(String(journal.releaseStartedAt));
  const releasedAt = Number.isFinite(startedAt) ? Math.min(startedAt, confirmedAt) : confirmedAt;
  const switchAt = releasedAt + options.switchMs;
  if (ctx.now() < switchAt) {
    ctx.log("waiting for the platform objects to switch to the released version (about 5 minutes)");
    await ctx.sleep(switchAt - ctx.now());
  }
  const deadline = ctx.now() + options.verifyWaitMs;
  const logsSince = slicedLogs(ctx, plan.platformWorker);
  for (;;) {
    const events = await logsSince(releasedAt - LOOKBACK_MS, ctx.now());
    const logs = parseLogs(events, plan.platformWorker);
    const result = verifyRelease(logs, {
      installationId: plan.installationId,
      releasedVersionId: journal.releasedVersionId,
      releasedAt,
    });
    if (result.verified) {
      record({ verifiedAt: iso(ctx.now()) });
      ctx.log(
        "checked: the server's object runs the released version, and the server restarted with it, without the password",
      );
      return { kind: "done" };
    }
    if (ctx.now() + options.pollMs > deadline) return { kind: "released", why: result.why };
    await ctx.sleep(options.pollMs);
  }
}
