// ADR 0007's restore point and read-only window around `bootstrap.ts update` (WP3.41, owner
// decision D45). Every update opens one; it is cheap (a server-side copy of the replica's few
// objects, and the read-only time overlaps the restart each update already causes) and the
// installer cannot tell in advance whether a release's server migrates the database.
//
//   - Opening: before the update's first platform deploy, the journal records the window (`window`:
//     its ID, and the versions and code that ran before), persist before effect. The deploy then
//     carries the window as a secret (`SERVER_ENV_CFO_MAINTENANCE_WINDOW`, which the server
//     receives too) and the restore point's name (`SERVER_ENV_CFO_RESTORE_POINT`). From the moment
//     the platform's objects run that version, nothing reaches the server and the server starts no
//     computer (worker/src/server/maintenance.ts). Its watchdog replaces the previous server (a
//     final sync), and the new server copies the replica beside it before Litestream or Omnigent
//     starts (images/server/cfo_server/restore_point.py), then starts Omnigent without its
//     scheduler. A window whose secret is gone after the version from before stopped serving was
//     ended outside the installer: it is closed, and the update starts again with a new one.
//   - The check: the update's own check (events.ts, verifyRelease) and, from a line of the
//     update's version, the window held and the restore point the server reports (`windowCheck`).
//   - Accepting (`acceptWindow`): the journal records the decision first; then one secrets change
//     deletes the window's secret, and the update waits for the release check of the version that
//     makes: its object runs it, and its watchdog has restarted the server without the window. From
//     the decision on, rollback is refused: problems are fixed forward.
//   - The rollback (rollback.ts), inside the window only.
//
// The journal keeps the last `RESTORE_POINTS_KEPT` restore points (`restorePoints`), as the server
// keeps their copies; names, times and places only.

import { MAINTENANCE_WINDOW_SECRET } from "../../worker/src/server/maintenance.ts";
import { parseLogs, type Verification, verifyRelease } from "./events.ts";
import { type BootstrapCloud, type BootstrapState, type Journal, slicedLogs } from "./machine.ts";
import type { Installation } from "./settings.ts";

/** How many restore points the server keeps, and the journal records (the newest). */
export const RESTORE_POINTS_KEPT = 3;

/** What ran before the update: the versions serving all of each Worker's traffic, and its code. */
export interface PreviousRelease {
  readonly platformVersionId: string;
  readonly webVersionId: string;
  readonly platformCode?: string;
  readonly webCode?: string;
}

/** A rollback in progress: each step's outcome, as it lands. */
export interface RollbackRecord {
  readonly startedAt: string;
  /** When the server reported the restore point back as the replica (`rolled_back`). */
  readonly restoredAt?: string;
  readonly webRolledBackAt?: string;
  readonly platformRolledBackAt?: string;
  /** The version serving the platform Worker after its rollback (and any cleanup). */
  readonly platformVersionId?: string;
}

/** An update's open window. Names, times and IDs only. */
export interface WindowRecord {
  /** The window's ID, which is its restore point's name too. */
  readonly id: string;
  /** Recorded before the deploy that opens it. */
  readonly openedAt: string;
  /**
   * When a deploy carrying the window was first sent, recorded before it (Codex WP3.41 r2-1):
   * from then on the window may have opened, so a window whose secret is gone was ended outside
   * the installer, whatever version serves now. Absent: no deploy of the window was ever sent.
   */
  readonly deployStartedAt?: string;
  readonly previous: PreviousRelease;
  /** When the server took the restore point, as it reported it. */
  readonly restorePointTakenAt?: string;
  /** The decision to accept, recorded before the window's secret is deleted. */
  readonly acceptStartedAt?: string;
  readonly rollback?: RollbackRecord;
}

/** A restore point, as the journal keeps it after its window closed. */
export interface RestorePointRecord {
  readonly id: string;
  /** Where it lives: the replica's bucket, beside the replica. No credential. */
  readonly where: string;
  /** When the server took it (absent: it never reported one). */
  readonly takenAt?: string;
  /** The code that ran before (the database's release), and the code the update deployed. */
  readonly before?: string;
  readonly updatedTo?: string;
  /** `abandoned`: replaced by a new window before it held for sure (its deploy may not have landed). */
  readonly outcome: "accepted" | "rolled back" | "ended outside the installer" | "abandoned";
  readonly closedAt: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A new window's ID: `rp-`, the time in UTC, and 8 random hex digits (sorts by time). */
export function newWindowId(now: number, random: (bytes: number) => Uint8Array): string {
  const d = new Date(now);
  const time = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  const hex = [...random(4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `rp-${time}-${hex}`;
}

/**
 * Where the server keeps restore point `id` (images/server/cfo_server/restore_point.py,
 * `places`): beside the replica, in a folder of its own. For the default replica,
 * `s3://<bucket>/omnigent`, that is `s3://<bucket>/cfo-restore-points/<id>/`.
 */
export function restorePointWhere(plan: Pick<Installation, "replica">, id: string): string {
  const url = plan.replica.url;
  const scheme = url.startsWith("s3://") ? "s3://" : "file://";
  const rest = url.slice(scheme.length);
  const [host, ...path] = scheme === "s3://" ? rest.split("/") : ["", ...rest.split("/")];
  const segments = path.filter((s) => s !== "");
  const parent = segments.slice(0, -1).join("/");
  const folder = parent === "" ? "cfo-restore-points" : `${parent}/cfo-restore-points`;
  return scheme === "s3://" ? `s3://${host}/${folder}/${id}/` : `file:///${folder}/${id}/`;
}

/** The record a closing window leaves of its restore point. */
export function restorePointRecord(
  plan: Pick<Installation, "replica">,
  window: WindowRecord,
  outcome: RestorePointRecord["outcome"],
  closedAt: string,
  updatedTo: string | undefined,
): RestorePointRecord {
  return {
    id: window.id,
    where: restorePointWhere(plan, window.id),
    ...(window.restorePointTakenAt === undefined ? {} : { takenAt: window.restorePointTakenAt }),
    ...(window.previous.platformCode === undefined ? {} : { before: window.previous.platformCode }),
    ...(updatedTo === undefined ? {} : { updatedTo }),
    outcome,
    closedAt,
  };
}

/**
 * Why the installation's replica leaves no room for restore points beside it, or undefined: the
 * server keeps them in the replica's parent folder, so the replica needs a path of its own (the
 * default, `s3://<bucket>/omnigent`, has one), as the server image checks too.
 */
export function restorePointProblem(plan: Pick<Installation, "replica">): string | undefined {
  const url = plan.replica.url;
  const rest = url.replace(/^(s3|file):\/\//, "");
  const segments = (url.startsWith("s3://") ? rest.split("/").slice(1) : rest.split("/")).filter(
    (s) => s !== "",
  );
  if (segments.length === 0 || segments.at(-1) === "cfo-restore-points") {
    return `its replica (${url}) is at the root of its bucket, where the restore point an update takes has no room beside it; the update needs a replica with a path, such as s3://<bucket>/omnigent`;
  }
  return undefined;
}

/** The journal with the window closed: its restore point recorded, the newest few kept. */
export function closeWindow(
  journal: Journal,
  record: RestorePointRecord,
  also: Partial<Journal> = {},
): Journal {
  const { window: _w, ...rest } = journal;
  const kept = [...(journal.restorePoints ?? []).filter((r) => r.id !== record.id), record].slice(
    -RESTORE_POINTS_KEPT,
  );
  return { ...rest, ...also, restorePoints: kept };
}

/** Why another step may not change the installation now, or undefined (WP3.41). */
export function windowRefusal(journal: Journal): string | undefined {
  const window = journal.window;
  if (window === undefined) return undefined;
  return window.rollback !== undefined
    ? "an update is being rolled back: finish it first with bootstrap.ts update --rollback"
    : "an update is waiting to be checked, and Omnigent is paused until it is: finish it first with bootstrap.ts update (or go back with bootstrap.ts update --rollback)";
}

export type WindowCheck =
  | { readonly ok: true; readonly takenAt: string }
  | { readonly ok: false; readonly why: string };

/**
 * Whether the update's version holds the window and its server reports the restore point: the
 * newest status line of this installation from that version, logged since the deploy began, by a
 * server started with its configuration, names both.
 */
export function windowCheck(
  logs: ReturnType<typeof parseLogs>,
  rules: {
    readonly installationId: string;
    readonly versionId: string | undefined;
    readonly since: number;
    readonly id: string;
  },
): WindowCheck {
  const lines = logs.statuses.filter(
    (e) =>
      e.status.installationId === rules.installationId &&
      e.versionId === rules.versionId &&
      e.loggedAt >= rules.since &&
      e.configApplied === true,
  );
  const latest = lines.reduce<(typeof lines)[number] | undefined>(
    (a, b) => (a === undefined || b.loggedAt > a.loggedAt ? b : a),
    undefined,
  );
  if (latest === undefined) {
    return { ok: false, why: "the restarted server has not reported its restore point yet" };
  }
  if (latest.maintenance !== rules.id) {
    return {
      ok: false,
      why: "the platform does not say it holds the update's read-only window (an older build, or the window ended)",
    };
  }
  if (latest.restorePoint?.id !== rules.id) {
    return { ok: false, why: "the restarted server has not reported its restore point yet" };
  }
  return { ok: true, takenAt: latest.restorePoint.takenAt };
}

/** What `acceptWindow` and the rollback need of the update's context. */
export interface WindowContext {
  readonly cloud: BootstrapCloud;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

export interface WaitOptions {
  readonly pollMs: number;
  /** How long to wait for the platform's object to run the version the change made. */
  readonly waitMs: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Accepts the update in the window: records the decision (persist before effect), deletes the
 * window's secret (one secrets change, a new version without it) and sees it gone, and closes the
 * window in the journal: from the decision on, there is no going back. Then it waits for the
 * restart without the window: the release check (events.ts, verifyRelease) of the version the
 * deletion made, whose object passes requests to the server again and whose watchdog has
 * restarted the server without the window (its scheduler on again) with a durable owner. That
 * wait never holds the journal (Codex WP3.41 r2-3): a check that is not seen in time is reported,
 * and the window stays closed. Throws when the secret could not be seen deleted (a later run
 * finishes it).
 */
export async function acceptWindow(
  ctx: WindowContext,
  state: () => BootstrapState,
  setJournal: (journal: Journal) => void,
  code: string,
  options: WaitOptions,
): Promise<{ readonly confirmed: true } | { readonly confirmed: false; readonly why: string }> {
  const plan = state().installation;
  const opened = state().journal.window as WindowRecord;
  if (opened.acceptStartedAt === undefined) {
    setJournal({ ...state().journal, window: { ...opened, acceptStartedAt: iso(ctx.now()) } });
  }
  const window = state().journal.window as WindowRecord;
  ctx.log(
    "accepting the update: Omnigent will be available again, and from now on a problem is fixed by a newer update rather than by going back",
  );
  const since = Date.parse(String(window.acceptStartedAt));
  const names = await ctx.cloud.secretNames(plan.platformWorker);
  if (names === null) throw new Error(`${plan.platformWorker} no longer exists`);
  if (names.includes(MAINTENANCE_WINDOW_SECRET)) {
    await ctx.cloud.updateSecrets(plan.platformWorker, { [MAINTENANCE_WINDOW_SECRET]: null });
    const after = await ctx.cloud.secretNames(plan.platformWorker);
    if (after === null || after.includes(MAINTENANCE_WINDOW_SECRET)) {
      throw new Error(
        `${plan.platformWorker} still holds the update's read-only window; run update again`,
      );
    }
  }
  setJournal(
    closeWindow(
      state().journal,
      restorePointRecord(plan, window, "accepted", iso(ctx.now()), code),
    ),
  );
  ctx.log(
    `accepted: the read-only window is closed. The restore point ${window.id} is kept (${restorePointWhere(plan, window.id)})`,
  );
  const logsSince = slicedLogs(ctx, plan.platformWorker);
  let said: string | undefined;
  const deadline = ctx.now() + options.waitMs;
  for (;;) {
    const versionId = await ctx.cloud.activeVersion(plan.platformWorker);
    const checked: Verification =
      versionId === undefined
        ? {
            verified: false,
            why: "Cloudflare does not say yet which version serves the platform Worker",
          }
        : verifyRelease(parseLogs(await logsSince(since, ctx.now()), plan.platformWorker), {
            installationId: plan.installationId,
            releasedVersionId: versionId,
            releasedAt: since,
          });
    if (checked.verified) {
      ctx.log(
        "checked: the server restarted without the window and answers; Omnigent is available again",
      );
      return { confirmed: true };
    }
    if (checked.why !== said) {
      said = checked.why;
      ctx.log(`waiting: ${checked.why}`);
    }
    if (ctx.now() + options.pollMs > deadline) return { confirmed: false, why: checked.why };
    await ctx.sleep(options.pollMs);
  }
}
