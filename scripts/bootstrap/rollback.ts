// `bootstrap.ts update --rollback` (WP3.41, ADR 0007): back to the release, and to Omnigent's data,
// from before an update, inside the update's read-only window only. Written against the
// bootstrap's ports, as update.ts, so that tests drive it with a fake Cloudflare and interrupt it
// at any point. No I/O of its own.
//
// In order; each step's outcome is recorded in the window's journal record (`rollback`) once it
// lands, and a run that finds a rollback under way continues it:
//   1. refuses unless an update's window is open: with none, there is nothing to go back to; once
//      the update was accepted, Omnigent has taken changes, so problems are fixed forward. The
//      platform Worker must still hold the window: otherwise it was ended outside the installer,
//      and changes may have landed since the restore point. A window whose first deploy never
//      landed has nothing to undo: it is closed, and nothing is deployed.
//   2. orders the rollback: one secrets change sets `SERVER_ENV_CFO_ROLLBACK_TO` to the restore
//      point (the window's ID). The platform's object replaces the update's server with one
//      started with the order (even one in recovery mode), which restores the restore point to a
//      scratch file and checks it against its manifest before anything changes, puts it back as
//      the live replica, and exits 79. The watchdog holds it and logs `rolled_back`.
//   3. waits for that line, naming the window's restore point: the replica is the restore point.
//   4. deploys the web Worker's version from before the update, then the platform Worker's: each
//      as it was, with its code, configuration, images and secrets (`deployVersion`). The previous
//      platform version holds neither the window nor the order, so its object starts its own
//      server, which restores the replica as the previous release left it. A window or an order
//      left in its secrets (Cloudflare keeps each version's own) is deleted.
//   5. checks, as the release check does, that the previous version's object runs and its server
//      answers with a durable owner; then closes the window: the journal records each Worker's
//      code as before the update, and the restore point as rolled back.
//
// Never: a secret value in the journal or the log, a version this installation did not run before
// the update, a rollback after the update was accepted.

import { MAINTENANCE_WINDOW_SECRET, ROLLBACK_SECRET } from "../../worker/src/server/maintenance.ts";
import { parseLogs, verifyRelease } from "./events.ts";
import { BootstrapRefusal, type Journal, slicedLogs } from "./machine.ts";
import { installationProblems } from "./settings.ts";
import { pollServer, type UpdateContext, type UpdateOptions } from "./update.ts";
import {
  closeWindow,
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
  | { readonly kind: "waiting"; readonly why: string };

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
  if (open.rollback === undefined) {
    if (!names.has(MAINTENANCE_WINDOW_SECRET)) {
      const active = await ctx.cloud.activeVersion(plan.platformWorker);
      if (open.heldSince === undefined && active === previous.platformVersionId) {
        // The update's first deploy never landed: the previous release runs, untouched.
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
      throw new BootstrapRefusal(
        `the update's read-only window was ended outside this installer (${plan.platformWorker} no longer holds ${MAINTENANCE_WINDOW_SECRET}): Omnigent may have taken changes since the restore point, and going back would lose them. A problem is fixed with a newer update instead${nothing}`,
      );
    }
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
    ctx.log(
      `deploying the platform Worker ${plan.platformWorker} as it was before the update: its server restores the data from the restore point`,
    );
    await ctx.cloud.deployVersion(plan.platformWorker, previous.platformVersionId);
    const after = await ctx.cloud.secretNames(plan.platformWorker);
    if (after === null) {
      throw new Error(`after its rollback, ${plan.platformWorker} does not exist`);
    }
    const left = [MAINTENANCE_WINDOW_SECRET, ROLLBACK_SECRET].filter((n) => after.includes(n));
    if (left.length > 0) {
      await ctx.cloud.updateSecrets(
        plan.platformWorker,
        Object.fromEntries(left.map((name) => [name, null])),
      );
    }
    const versionId = await ctx.cloud.activeVersion(plan.platformWorker);
    progress({
      platformRolledBackAt: iso(ctx.now()),
      ...(versionId === undefined ? {} : { platformVersionId: versionId }),
    });
  }

  // 5. The previous release's server answers with a durable owner.
  const from = Date.parse(String(rollback().platformRolledBackAt));
  const released = rollback().platformVersionId ?? previous.platformVersionId;
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

/** When the restore point's data is from, in words. */
function dataTime(window: WindowRecord): string {
  return window.restorePointTakenAt === undefined
    ? "before the update"
    : `at ${window.restorePointTakenAt}`;
}
