// `bootstrap.ts update --rollback` (WP3.41, ADR 0007): back to the release, and to Omnigent's data,
// from before an update, inside the update's read-only window only. Written against the
// bootstrap's ports, as update.ts, so that tests drive it with a fake Cloudflare and interrupt it
// at any point. No I/O of its own.
//
// In order; each step's outcome is recorded in the window's journal record (`rollback`) once it
// lands, and a run that finds a rollback under way continues it:
//   1. refuses unless an update's window is open: with none, there is nothing to go back to; once
//      the update was accepted, Omnigent has taken changes, so problems are fixed forward. Until
//      the server has put the restore point back, the platform Worker must still hold the window,
//      on every run: otherwise it was ended outside the installer, changes may have landed since
//      the restore point. A rollback whose order was not sent yet is called off (the window
//      recorded as ended); one whose order was sent keeps it, and the server its hold (it refuses
//      an order outside a window), for a person to decide, as the replica may be partly put back.
//      A window no deploy was ever sent for has nothing to undo: it is closed, nothing deployed.
//   2. orders the rollback: one secrets change sets `SERVER_ENV_CFO_ROLLBACK_TO` to the restore
//      point (the window's ID). The platform's object replaces the update's server with one
//      started with the order (even one in recovery mode), which restores the restore point to a
//      scratch file and checks it against its manifest before anything changes, puts it back as
//      the live replica, and exits 79. The watchdog holds it and logs `rolled_back` at every check.
//   3. waits for that line, naming the window's restore point: the replica is the restore point.
//   4. deploys the web Worker's version from before the update, then the platform Worker's (not
//      again once it serves): each as it was, with its code, configuration, images and secrets
//      (`deployVersion`; Cloudflare keeps each version's own). The previous platform version holds
//      neither the window nor the order, so its object starts its own server, which restores the
//      replica as the previous release left it. Until then the update's version, and the window
//      with it, serves.
//   5. while the platform Worker's version from before serves, deletes its versions newer than
//      it, the update's (WP3.41b): while they are its latest, Cloudflare refuses every secrets
//      change, and the next deploy would keep their secrets, the window and the order among them.
//      Should Cloudflare keep one, the window and the order are deleted from it instead, as a
//      version that is not deployed. Nothing is deployed: its server keeps running. Another
//      version serving stops the rollback for a person.
//   6. checks, as the release check does, that the previous version's object runs and its server
//      answers with a durable owner, from its lines since the restore point was put back; then
//      closes the window: the journal records each Worker's code as before the update, and the
//      restore point as rolled back.
//
// Never: a secret value in the journal or the log, a version this installation did not run before
// the update, a rollback after the update was accepted.

import { MAINTENANCE_WINDOW_SECRET, ROLLBACK_SECRET } from "../../worker/src/server/maintenance.ts";
import { parseLogs, verifyRelease } from "./events.ts";
import { BootstrapRefusal, type Journal, slicedLogs, VersionNotDeleted } from "./machine.ts";
import { installationProblems } from "./settings.ts";
import { pollServer, type UpdateContext, type UpdateOptions } from "./update.ts";
import {
  closeWindow,
  latestServing,
  type RollbackRecord,
  restorePointRecord,
  type WindowRecord,
} from "./window.ts";

export type RollbackOutcome =
  /** Back on the previous release, its server checked, the window closed. */
  | { readonly kind: "done" }
  /** The update never deployed anything: the window is closed, nothing was changed. */
  | { readonly kind: "nothing" }
  /** Under way: run it again to continue (it repeats nothing that landed). */
  | RollbackWaiting;

type RollbackWaiting = { readonly kind: "waiting"; readonly why: string };

const iso = (ms: number) => new Date(ms).toISOString();

export async function runRollback(
  ctx: UpdateContext,
  options: UpdateOptions,
): Promise<RollbackOutcome> {
  let state = ctx.store.load();
  const plan = state.installation;
  const problems = installationProblems(plan);
  if (problems.length > 0) {
    throw new BootstrapRefusal(`the plan is not usable: ${problems.join("; ")}`);
  }
  const nothing = "; nothing was changed";
  const setJournal = (journal: Journal) => {
    state = { ...state, journal };
    ctx.store.save(state);
  };
  // Both are recorded before they are read here (step 1), and stay until the rollback ends.
  const window = (): WindowRecord => state.journal.window as WindowRecord;
  const rollback = (): RollbackRecord => window().rollback as RollbackRecord;
  const progress = (change: Partial<RollbackRecord>) =>
    setJournal({
      ...state.journal,
      window: { ...window(), rollback: { ...rollback(), ...change } },
    });

  // 1. Only inside an open window.
  const open = state.journal.window;
  if (open === undefined) {
    const last = state.journal.restorePoints?.at(-1);
    throw new BootstrapRefusal(
      last === undefined
        ? `no update is waiting to be checked, so there is nothing to go back to${nothing}`
        : last.outcome === "accepted"
          ? `the last update was accepted at ${last.closedAt}: Omnigent has taken changes since, and going back would lose them. A problem is fixed with a newer update instead${nothing}`
          : `there is nothing to go back to: the last update's window was ${last.outcome} at ${last.closedAt}${nothing}`,
    );
  }
  if (open.acceptStartedAt !== undefined) {
    throw new BootstrapRefusal(
      `the update was accepted at ${open.acceptStartedAt}: Omnigent takes changes again, and going back would lose them. A problem is fixed with a newer update instead; run bootstrap.ts update to finish accepting it${nothing}`,
    );
  }
  const listed = await ctx.cloud.secretNames(plan.platformWorker);
  if (listed === null) {
    throw new BootstrapRefusal(
      `${plan.platformWorker} no longer exists, so there is nothing to roll back${nothing}`,
    );
  }
  const names = new Set(listed);
  const previous = open.previous;
  // Until the server has put the restore point back, the window must hold, on every run: once it
  // ended outside the installer, Omnigent may have taken changes since the restore point, and
  // putting it back would lose them (Codex WP3.41 r1-2). The secrets listed are the latest
  // version's: an earlier version deployed since, outside the installer, may serve without the
  // window, so the window holds only while the latest version serves (WP3.41b). Unknown, nothing
  // is decided.
  const held =
    open.rollback?.restoredAt !== undefined || !names.has(MAINTENANCE_WINDOW_SECRET)
      ? undefined
      : await latestServing(ctx.cloud, plan.platformWorker);
  if (held === "unknown") {
    return {
      kind: "waiting",
      why: `Cloudflare does not say yet which version serves all of ${plan.platformWorker}'s traffic, so whether the update's window holds is not known${nothing}`,
    };
  }
  if (open.rollback?.restoredAt === undefined && held !== "serves") {
    if (open.deployStartedAt === undefined) {
      // No deploy carrying the window was ever sent: the previous release runs, untouched.
      const { update: _u, ...journal } = state.journal;
      setJournal(
        closeWindow(
          journal,
          restorePointRecord(plan, open, "rolled back", iso(ctx.now()), undefined),
        ),
      );
      ctx.log(
        `nothing to roll back: the update never deployed the platform Worker, so https://${plan.hostname} still runs the version from before it, with its data`,
      );
      return { kind: "nothing" };
    }
    if (names.has(ROLLBACK_SECRET)) {
      // The order was sent: the server may have begun putting the restore point back, so the
      // replica may be partly replaced (Codex WP3.41 r2-2). The order stays, and with it the
      // server's hold (it refuses an order outside its window, exit 78): nothing more changes
      // until a person decides. The journal keeps the rollback.
      throw new BootstrapRefusal(
        `the update's read-only window was ended outside this installer (${plan.platformWorker} no longer holds ${MAINTENANCE_WINDOW_SECRET}) while its rollback was under way. Omnigent's data may be partly put back, so the server stays stopped and nothing more is changed: get help before going on (docs/operations/recovery.md, "Rollback and destructive restore")`,
      );
    }
    if (open.rollback !== undefined) {
      // A rollback begun, its order never sent: called off, the window recorded as ended.
      setJournal(
        closeWindow(
          state.journal,
          restorePointRecord(
            plan,
            open,
            "ended outside the installer",
            iso(ctx.now()),
            state.journal.update?.code,
          ),
        ),
      );
    }
    const active = await ctx.cloud.activeVersion(plan.platformWorker);
    throw new BootstrapRefusal(
      active === previous.platformVersionId && open.rollback === undefined
        ? `the update's read-only window is not held, and the version from before the update serves: the update's deploy did not land, or that version was deployed again outside this installer. Going back to the restore point is not possible from here: run bootstrap.ts update to try the update again, with a new restore point${nothing}`
        : `the update's read-only window was ended outside this installer (${plan.platformWorker} no longer holds ${MAINTENANCE_WINDOW_SECRET}): Omnigent may have taken changes since the restore point, and going back would lose them. A problem is fixed with a newer update instead: run bootstrap.ts update${open.rollback === undefined ? nothing : "; the rollback was called off"}`,
    );
  }
  if (open.rollback === undefined) {
    setJournal({ ...state.journal, window: { ...open, rollback: { startedAt: iso(ctx.now()) } } });
    ctx.log(
      `rolling back https://${plan.hostname} to the version from before the update, with Omnigent's data as it was ${dataTime(open)} (restore point ${open.id})`,
    );
  } else {
    ctx.log(`continuing the rollback of https://${plan.hostname} (restore point ${open.id})`);
  }
  const since = Date.parse(rollback().startedAt);
  const logsSince = slicedLogs(ctx, plan.platformWorker);
  const deadline = () => ctx.now() + options.switchMs + options.verifyWaitMs;

  // 2 and 3. The order, and the server's word that the restore point is the replica again.
  if (rollback().restoredAt === undefined) {
    if (!names.has(ROLLBACK_SECRET)) {
      await ctx.cloud.updateSecrets(plan.platformWorker, { [ROLLBACK_SECRET]: open.id });
    }
    ctx.log(
      "ordered: the server restarts, checks the restore point, and puts it back as Omnigent's data (about 5 to 10 minutes)",
    );
    const seen = await pollServer<true>(
      ctx,
      { pollMs: options.pollMs, deadline: deadline() },
      async () => {
        const logs = parseLogs(await logsSince(since, ctx.now()), plan.platformWorker);
        if (
          logs.rollbacks.some(
            (r) => r.held === true && r.restorePoint === open.id && r.loggedAt >= since,
          )
        ) {
          return { decided: true };
        }
        const refused = logs.configErrors.some((e) => e.held === true && e.loggedAt >= since);
        return {
          why: refused
            ? "the server refused the rollback's settings (it exited 78): see bootstrap.ts status --logs"
            : "the server has not put the restore point back yet (the platform switches to the order within about 5 minutes, then the server restarts with it)",
        };
      },
    );
    if (!("decided" in seen)) return { kind: "waiting", why: seen.why };
    progress({ restoredAt: iso(ctx.now()) });
    ctx.log("the restore point is Omnigent's data again");
  }

  // 4. The versions from before the update: the web Worker's first, which works with either
  // platform version (cross-Worker calls are additive), then the platform Worker's.
  if (rollback().webRolledBackAt === undefined) {
    ctx.log(`deploying the web Worker ${plan.webWorker} as it was before the update`);
    await ctx.cloud.deployVersion(plan.webWorker, previous.webVersionId);
    progress({ webRolledBackAt: iso(ctx.now()) });
  }
  if (rollback().platformRolledBackAt === undefined) {
    // Not again when it serves already: a run stopped after this deploy, before its record.
    if ((await ctx.cloud.activeVersion(plan.platformWorker)) !== previous.platformVersionId) {
      ctx.log(
        `deploying the platform Worker ${plan.platformWorker} as it was before the update: its server restores the data from the restore point`,
      );
      await ctx.cloud.deployVersion(plan.platformWorker, previous.platformVersionId);
    }
    progress({ platformRolledBackAt: iso(ctx.now()) });
  }

  // 5. The update's versions, which serve no more (WP3.41b).
  const settled = await settleVersions(ctx, plan.platformWorker, previous.platformVersionId);
  if (settled !== undefined) return settled;
  if (rollback().platformVersionId === undefined) {
    progress({ platformVersionId: previous.platformVersionId });
  }

  // 6. The previous release's server answers with a durable owner: its lines since the server put
  // the restore point back, which only a version deployed after that can have logged, however
  // long ago (it logs its status for a while once its owner is durable, then no more).
  const from = Date.parse(String(rollback().restoredAt));
  const released = previous.platformVersionId;
  ctx.log(
    "waiting for the platform objects to switch back and the server to restart on the previous version (about 5 to 10 minutes)",
  );
  const checked = await pollServer<true>(
    ctx,
    { pollMs: options.pollMs, deadline: deadline() },
    async () => {
      const result = verifyRelease(
        parseLogs(await logsSince(from, ctx.now()), plan.platformWorker),
        { installationId: plan.installationId, releasedVersionId: released, releasedAt: from },
      );
      return result.verified ? { decided: true } : { why: result.why };
    },
  );
  if (!("decided" in checked)) return { kind: "waiting", why: checked.why };

  const closing = window();
  const { update: _u, platformCode: _p, webCode: _w, ...rest } = state.journal;
  setJournal(
    closeWindow(
      rest,
      restorePointRecord(plan, closing, "rolled back", iso(ctx.now()), state.journal.update?.code),
      {
        ...(previous.platformCode === undefined ? {} : { platformCode: previous.platformCode }),
        ...(previous.webCode === undefined ? {} : { webCode: previous.webCode }),
      },
    ),
  );
  ctx.log(
    `rolled back: https://${plan.hostname} runs the version from before the update, with Omnigent's data as it was ${dataTime(closing)}, and is available again`,
  );
  return { kind: "done" };
}

/**
 * Step 5 (WP3.41b). Deploying an earlier version leaves the update's versions newer than it, and
 * the newest holds the window and the rollback order. While the Worker's latest version is not the
 * deployed one, Cloudflare refuses every change of its secrets (10215, "to prevent accidental
 * deployment"): `services`, `github-app` and every later secrets step would fail. And Wrangler's
 * next deploy keeps the latest version's secrets, the window and the order with them. So, while
 * the version from before the update serves, the versions newer than it are deleted, newest
 * first, and it is the latest again. Should Cloudflare keep one, the window and the order are
 * deleted from the latest version as a new version that is not deployed (Wrangler's
 * `versions secret`), the one secrets change it allows then, and a warning says what stays
 * refused. Nothing here deploys: the server of the version from before keeps running. Another
 * version serving, or that version holding the window or the order (none from before an update
 * does), stops the rollback for a person. Undefined once done; resumable: every run lists the
 * versions again.
 */
async function settleVersions(
  ctx: UpdateContext,
  worker: string,
  previous: string,
): Promise<RollbackWaiting | undefined> {
  const serving = await ctx.cloud.activeVersion(worker);
  if (serving === undefined) {
    return {
      kind: "waiting",
      why: `Cloudflare does not say yet which version of ${worker} serves all of its traffic`,
    };
  }
  if (serving !== previous) {
    // Deployed outside the installer since this rollback deployed the version from before: its
    // server may have changed Omnigent's data since the restore point was put back (Codex
    // WP3.41b r1-1).
    throw new BootstrapRefusal(
      `version ${serving} of ${worker} serves, not ${previous}, the version from before the update that this rollback deployed: another version was deployed outside this installer since, and its server may have changed Omnigent's data. Nothing more was changed: get help before going on (docs/operations/recovery.md, "Rollback and destructive restore")`,
    );
  }
  const listed = await ctx.cloud.versions(worker);
  const at = listed.findIndex((v) => v.id === serving);
  let kept: string | undefined =
    at === -1 ? `Cloudflare does not list the version that serves, ${serving}` : undefined;
  if (at > 0) {
    ctx.log(
      `deleting the update's ${at === 1 ? "version" : `${at} versions`} of ${worker}, which serve no traffic, so that the version from before is its latest again`,
    );
    try {
      for (const version of listed.slice(0, at)) await ctx.cloud.deleteVersion(worker, version.id);
      const newest = (await ctx.cloud.versions(worker))[0];
      if (newest?.id !== serving) kept = `Cloudflare still lists version ${newest?.id} first`;
    } catch (error) {
      if (!(error instanceof VersionNotDeleted)) throw error;
      kept = error.message;
    }
  }
  const names = await ctx.cloud.secretNames(worker);
  if (names === null) throw new Error(`after its rollback, ${worker} does not exist`);
  const left = [MAINTENANCE_WINDOW_SECRET, ROLLBACK_SECRET].filter((n) => names.includes(n));
  if (kept === undefined) {
    if (left.length === 0) return undefined;
    throw new BootstrapRefusal(
      `${previous}, the version of ${worker} from before the update, holds ${left.join(", ")}, which no version from before an update holds. Nothing more was changed: get help before going on (docs/operations/recovery.md, "Rollback and destructive restore")`,
    );
  }
  if (left.length > 0) {
    await ctx.cloud.deleteLatestSecrets(worker, left);
    const after = await ctx.cloud.secretNames(worker);
    const still = left.filter((n) => after === null || after.includes(n));
    if (still.length > 0) {
      throw new Error(
        `${worker}'s latest version still holds ${still.join(", ")} after deleting ${still.length === 1 ? "it" : "them"}; run bootstrap.ts update --rollback again`,
      );
    }
  }
  ctx.log(
    `warning: ${worker}'s latest version is not the one deployed (${kept}). It holds no window or rollback order, so no later deploy takes them up, but Cloudflare refuses changes of its secrets (bootstrap.ts services, github-app) until the next update deploys a version (docs/operations/recovery.md, "Latest version not deployed")`,
  );
  return undefined;
}

/** When the restore point's data is from, in words. */
function dataTime(window: WindowRecord): string {
  return window.restorePointTakenAt === undefined
    ? "before the update"
    : `at ${window.restorePointTakenAt}`;
}
