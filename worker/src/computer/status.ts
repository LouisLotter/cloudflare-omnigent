// Pure: the setup page's "Computer status", composed in WorkspaceDO (WP3.23; the design review's
// revision 3), and what WorkspaceDO logs of it as `computer_status`.
//
// The supervisor reports only what it can know (versions, sign-in states, the switch, the
// hostname, disk, alert kinds, RC-53 counts by capture). WorkspaceDO adds what only it knows:
// - the published credential manifest, all four declared files (the computer's own files may
//   differ: a login lost before it was saved, or a sign-out not yet published);
// - the sign-out's phase, labelled for what it proves: `tombstoned` (the published checkpoint
//   holds tombstones) and `verified` (a read-back of the stored bundle holds four tombstones) are
//   neither a restore into a fresh computer nor revocation at the providers;
// - a bounded, durable history of *final* save outcomes, which it records itself when a save ends
//   (a capture can stage and the upload still fail, as on 27 Oct), with the RC-53 counts the
//   supervisor reported for that capture, matched by its operation ID.
// Names, versions, enum states and counts only: never a value, a path, or text from the computer.

import {
  type ComputerStatusView,
  type CredentialManifest,
  DeclaredCredentialPath,
  type Rc53Counts,
  type SaveFailureReason,
  type SaveOutcome,
  type SupervisorStatus,
} from "@cfo/contracts";
import { z } from "zod";

/** Final save outcomes kept in the record, newest first. */
export const MAX_SAVES = 10;
/** How often the runner reads and logs the status while the computer runs. */
export const STATUS_INTERVAL_MS = 5 * 60_000;
/** A supervisor status this fresh is reused for a page read. */
export const STATUS_FRESH_MS = 15_000;

const Millis = z.number().int().min(0).max(8.64e15);
const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const SaveRecord = z.strictObject({
  at: Millis,
  generation: Count,
  /** The capture's operation, to match the supervisor's RC-53 counts. */
  op: z.string().max(64),
  outcome: z.enum(["published", "unchanged", "discarded", "failed"]),
  reason: z.string().max(32).nullable(),
  kind: z.enum(["base", "delta"]).nullable(),
  rc53: z
    .strictObject({
      status: z.number().int().min(0).max(255),
      values: Count,
      files: Count,
      findings: Count,
      incomplete: Count,
    })
    .nullable(),
});
export type SaveRecord = z.infer<typeof SaveRecord>;

const REASONS: ReadonlySet<string> = new Set([
  "lease_expired",
  "disk_budget",
  "copy_failed",
  "stage_failed",
  "parent_mismatch",
  "policy_violation",
  "busy",
  "upload",
  "deadline",
]);

/** A save's failure reason as one of the contract's names: the controller's own wordings mapped. */
export function saveReason(reason: string | null): SaveFailureReason | null {
  if (reason === null) return null;
  if (REASONS.has(reason)) return reason as SaveFailureReason;
  if (reason === "parent changed") return "parent_changed";
  return "internal";
}

/** Records a final save outcome, newest first, bounded. */
export function recordSave(saves: readonly SaveRecord[], entry: SaveRecord): SaveRecord[] {
  return [entry, ...saves].slice(0, MAX_SAVES);
}

/** Adds the supervisor's RC-53 counts to the saves of those captures that have none yet. */
export function withRc53(
  saves: readonly SaveRecord[],
  captures: SupervisorStatus["captures"],
): SaveRecord[] {
  return saves.map((save) => {
    if (save.rc53 !== null) return save;
    const counts = captures.find((c) => c.jobOperationId === save.op)?.rc53;
    return counts === undefined ? save : { ...save, rc53: { ...counts } };
  });
}

export function saveView(save: SaveRecord): SaveOutcome {
  return {
    at: new Date(save.at).toISOString(),
    generation: save.generation,
    outcome: save.outcome,
    reason: saveReason(save.reason),
    kind: save.kind,
    rc53: save.rc53 as Rc53Counts | null,
  };
}

export interface StatusInput {
  readonly now: number;
  readonly supervisor: ComputerStatusView["supervisor"];
  readonly metrics: SupervisorStatus | null;
  readonly credential: CredentialManifest | null;
  readonly signOut: {
    readonly phase: ComputerStatusView["signOut"]["phase"];
    readonly running: boolean;
  };
  readonly saves: readonly SaveRecord[];
  readonly staging: boolean;
  /** The switch's persisted, desired state (staging only). */
  readonly rc53Desired: boolean;
}

export function composeStatus(input: StatusInput): ComputerStatusView {
  const m = input.metrics;
  const credential = input.credential;
  return {
    observedAt: new Date(input.now).toISOString(),
    supervisor: input.supervisor,
    metrics:
      m === null
        ? null
        : {
            supervisorVersion: m.supervisorVersion,
            versions: { ...m.versions },
            logins: { ...m.logins },
            signIn: { ...m.signIn },
            rc53: m.rc53,
            hostname: m.hostname,
            disk: m.disk === null ? null : { ...m.disk },
            alerts: m.alerts.map((a) => ({ kind: a.kind, count: a.count })),
            // The setup terminal's sessions on the computer (WP3.28), when counted.
            ...(m.terminals === undefined ? {} : { terminals: m.terminals }),
          },
    credentials: {
      checkpoint:
        credential === null
          ? null
          : {
              generation: credential.generation,
              order: credential.order,
              createdAt: credential.createdAt,
            },
      files: DeclaredCredentialPath.options.map((path) => ({
        path,
        state: credential === null ? ("none" as const) : credential.files[path].state,
      })),
    },
    signOut: { phase: input.signOut.phase, running: input.signOut.running },
    saves: input.saves.map(saveView),
    rc53: {
      staging: input.staging,
      desired: input.staging ? input.rc53Desired : null,
      applied: m === null ? null : m.rc53,
    },
  };
}

/**
 * What WorkspaceDO logs as `computer_status`: names, versions, outcomes, reasons and counts only.
 * `signature` is everything but the time and disk use, so a log follows each change.
 */
export function statusLog(view: ComputerStatusView): {
  readonly fields: Record<string, unknown>;
  readonly signature: string;
} {
  const m = view.metrics;
  const last = view.saves[0];
  const stable = {
    supervisor: view.supervisor,
    versions: m?.versions ?? null,
    logins: m?.logins ?? null,
    signIn: m?.signIn ?? null,
    hostname: m?.hostname ?? null,
    alerts: Object.fromEntries((m?.alerts ?? []).map((a) => [a.kind, a.count])),
    terminals: typeof m?.terminals === "number" ? m.terminals : null,
    credentials: Object.fromEntries(view.credentials.files.map((f) => [f.path, f.state])),
    credentialOrder: view.credentials.checkpoint?.order ?? null,
    signOut: view.signOut.phase,
    rc53: view.rc53,
    lastSave:
      last === undefined
        ? null
        : {
            outcome: last.outcome,
            reason: last.reason,
            kind: last.kind,
            rc53: last.rc53,
          },
    failedSaves: view.saves.filter((s) => s.outcome === "failed").length,
  };
  return {
    signature: JSON.stringify(stable),
    fields: {
      ...stable,
      diskFreeBytes: m?.disk?.freeBytes ?? null,
      diskTotalBytes: m?.disk?.totalBytes ?? null,
    },
  };
}
