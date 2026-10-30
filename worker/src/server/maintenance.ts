// The read-only window of an update (WP3.41, ADR 0007). Pure: no Workers runtime import (the
// bootstrap, a Node script, imports it).
//
// `bootstrap.ts update` deploys a release with the secret `CFO_MAINTENANCE_WINDOW` holding the
// window's ID (also its restore point's), and the release's server environment naming the same
// restore point (`SERVER_ENV_CFO_RESTORE_POINT`). While a version of the platform Worker holds the
// secret, OmnigentServer passes nothing to the server: every request through it (the browser's,
// through the web Worker, and every computer's runners and sessions, through the computers'
// route) gets 503, and so does the password page's change. Its watchdog still checks the server
// directly, so the release can be checked; its status line says the window is open and names the
// restore point the server reports. The update accepts the release by deleting the secret: the
// version that makes has no window. Deleting it is the only way the window ends.
//
// The rollback (`bootstrap.ts update --rollback`, inside the window only) sets
// `SERVER_ENV_CFO_ROLLBACK_TO` to the same ID: the server started with it puts the restore point
// back as the live replica and exits 79, and the watchdog holds it, logging `rolled_back` with
// the restore point it was ordered to (OmnigentServer). The previous release's version, deployed
// next, starts its own server, which restores that replica.
//
// Neither name is a credential; both are secrets so that every later deploy keeps them (Wrangler
// keeps secrets and replaces variables) until the update itself removes them.

/** The window's secret on the platform Worker. Not `SERVER_ENV_`: it never reaches the server. */
export const MAINTENANCE_WINDOW_SECRET = "CFO_MAINTENANCE_WINDOW";
/** The restore point the update's server takes, in the server's environment. */
export const RESTORE_POINT_VAR = "SERVER_ENV_CFO_RESTORE_POINT";
/** The rollback's order, in the server's environment (a secret). */
export const ROLLBACK_SECRET = "SERVER_ENV_CFO_ROLLBACK_TO";

/** A restore point's (and window's) ID: `rp-`, the window's start in UTC, 8 random hex digits. */
export const RESTORE_POINT_ID = /^rp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;

/** The server image's exit after a rollback put the restore point back (cfo_server). */
export const EXIT_ROLLED_BACK = 79;

/**
 * The window this version holds: its ID; `"malformed"` for any other value, which holds the
 * window all the same (fail closed); null when there is none.
 */
export function maintenanceWindowOf(env: Readonly<Record<string, unknown>>): string | null {
  const value = env[MAINTENANCE_WINDOW_SECRET];
  if (typeof value !== "string" || value.trim() === "") return null;
  const id = value.trim();
  return RESTORE_POINT_ID.test(id) ? id : "malformed";
}

/** The restore point a rollback is ordered to, or null for none (or a malformed one). */
export function rollbackOrderOf(env: Readonly<Record<string, unknown>>): string | null {
  const value = env[ROLLBACK_SECRET];
  return typeof value === "string" && RESTORE_POINT_ID.test(value.trim()) ? value.trim() : null;
}

/** What the server image reports of its restore point on `GET :8001/status`. */
export interface ReportedRestorePoint {
  readonly id: string;
  readonly takenAt: string;
}

/** The entrypoint's `restorePoint`, checked; null when it reports none or something else. */
export function restorePointOf(status: unknown): ReportedRestorePoint | null {
  const point = (status as { restorePoint?: unknown } | null)?.restorePoint as {
    id?: unknown;
    takenAt?: unknown;
  } | null;
  if (point === null || typeof point !== "object") return null;
  const { id, takenAt } = point;
  if (typeof id !== "string" || !RESTORE_POINT_ID.test(id)) return null;
  if (typeof takenAt !== "string" || takenAt.length > 40 || Number.isNaN(Date.parse(takenAt))) {
    return null;
  }
  return { id, takenAt };
}

/** The answer to every request while the window is open. */
export const MAINTENANCE_MESSAGE =
  "Omnigent is being updated and accepts no changes until the update is checked. Try again in a few minutes.";
