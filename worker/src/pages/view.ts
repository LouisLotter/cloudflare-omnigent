// What the platform pages show for a computer (WP3.5): pure, from WorkspaceDO's page state, the
// server's outage records and the replication health. The pages render these decisions; the
// tests check them for every state.

import type {
  ComputerPageState,
  OutageRecord,
  ReplicationHealth,
  SetupCard,
  SetupProvider,
} from "@cfo/contracts";

/** The workspace size budget: the page warns above it (design, Size and number). */
export const SIZE_WARNING_BYTES = 1.5e9;
/** Sleeps refused in a row before "Stop without saving the latest changes" (FH-35). */
export const REFUSED_SLEEPS_FOR_STOP_WITHOUT_SAVING = 3;
/** How far back the page lists the server's outages. */
export const OUTAGE_WINDOW_MS = 7 * 24 * 3_600_000;

export type Tone = "ok" | "info" | "warn" | "danger";

export interface Notice {
  readonly tone: Tone;
  /** A stable name, for tests and the page's markup. */
  readonly kind:
    | "not_connected"
    | "restored"
    | "unexpected_stop"
    | "not_saved"
    | "size"
    | "sleeps_refused"
    | "start_failed"
    | "removal_pending"
    | "outage"
    | "replication";
  readonly text: string;
}

/** The two sign-in cards (design, Signing in). */
export interface CardView {
  readonly provider: SetupProvider;
  readonly title: string;
  readonly state: SetupCard["state"];
  readonly tone: Tone;
  readonly label: string;
  readonly detail: string;
  /** The card is open: the person has something to do on it. */
  readonly open: boolean;
}

export type RemovalStep =
  /** Run the sign-out first; Omnigent's deletion is not linked yet. */
  | "sign_out"
  /** The sign-out runs. */
  | "signing_out"
  /** Signed out, or nothing to sign out of: link to Omnigent's deletion. */
  | "delete"
  /** Asleep: its logins are saved; delete in Omnigent, and the platform signs it out after. */
  | "delete_then_sign_out"
  /** A removal is pending: the page's checklist. */
  | "pending"
  | "resolved";

export interface PendingRemoval {
  /** The sign-out still to run (needs the computer started once). */
  readonly signOut: boolean;
  /** The person must revoke at the providers and record it (P5). */
  readonly recordRevocation: boolean;
  /** Everything needed is done: the removal can be resolved. */
  readonly resolvable: boolean;
}

export interface ComputerView {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly statusTone: Tone;
  readonly running: boolean;
  readonly needsSetup: boolean;
  readonly cards: readonly CardView[];
  readonly saving: string;
  readonly notices: readonly Notice[];
  readonly size: string;
  /** "Not connected to Omnigent" (FH-30, FH-31): a restart is offered with its warning. */
  readonly notConnected: boolean;
  readonly offerRestart: boolean;
  /** Omnigent no longer calls it: removal from this page is offered (FH-29). */
  readonly offerRemove: boolean;
  readonly offerStopWithoutSaving: boolean;
  readonly removal: RemovalStep;
  readonly pending: PendingRemoval | null;
}

const PROVIDER_TITLE: Record<SetupProvider, string> = { claude: "Claude", codex: "Codex" };

/** "14:05 UTC" for today, otherwise "22 Oct 14:05 UTC". Times are UTC: the page has no locale. */
export function formatTime(iso: string, nowMs: number): string {
  const d = new Date(iso);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const now = new Date(nowMs);
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
  if (sameDay) return `${hm} UTC`;
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  return `${d.getUTCDate()} ${month} ${hm} UTC`;
}

/** "N minutes", rounded down, at least 1. */
export function minutesSince(iso: string, nowMs: number): number {
  return Math.max(1, Math.floor((nowMs - Date.parse(iso)) / 60_000));
}

export function cardView(card: SetupCard): CardView {
  const title = PROVIDER_TITLE[card.provider];
  switch (card.state) {
    case "signed_in":
      return {
        provider: card.provider,
        title,
        state: card.state,
        tone: "ok",
        label: "Signed in",
        detail: "The login is saved with this computer.",
        open: false,
      };
    case "saving":
      return {
        provider: card.provider,
        title,
        state: card.state,
        tone: "info",
        label: "Saving the login",
        detail:
          "The login changed and is being saved. Keep the computer awake until this says signed in.",
        open: false,
      };
    case "unknown":
      return {
        provider: card.provider,
        title,
        state: card.state,
        tone: "info",
        label: "Not known now",
        detail: "The computer cannot be asked now. This is not the same as signed out.",
        open: false,
      };
    case "needs_sign_in": {
      const detail =
        card.reason === "expired"
          ? "The login expired. Sign in again on this card only."
          : card.reason === "refused"
            ? "The CLI reports this login signed out or refused. Sign in again."
            : "Not signed in yet.";
      return {
        provider: card.provider,
        title,
        state: card.state,
        tone: card.reason === "not_signed_in" || card.reason === undefined ? "warn" : "danger",
        label:
          card.reason === "not_signed_in" || card.reason === undefined
            ? "Needs sign-in"
            : "Sign in again",
        detail,
        open: true,
      };
    }
  }
}

function statusOf(state: ComputerPageState, notConnected: boolean): [string, Tone] {
  if (state.removal.state === "resolved" || state.lifecycle === "removed")
    return ["Removed", "info"];
  if (state.removal.state === "pending") return ["Removal pending", "warn"];
  if (state.status === "stopping") return ["Stopping", "info"];
  if (notConnected) return ["Not connected to Omnigent", "danger"];
  switch (state.lifecycle) {
    case "provisioned":
      return ["Not started yet", "info"];
    case "waking":
    case "restoring":
      return ["Starting", "info"];
    case "started_no_host":
    case "start_claimed":
      return ["Starting Omnigent's host", "info"];
    case "host_running":
      return ["Awake", "ok"];
    case "host_refused":
      return ["Not connected to Omnigent", "danger"];
    case "asleep":
      return ["Asleep", "info"];
    case "stopped":
      return ["Stopped unexpectedly", "warn"];
    case "failed":
      return ["Failed to start", "danger"];
    default:
      return ["Unknown", "warn"];
  }
}

const RUNNING = new Set(["started_no_host", "start_claimed", "host_running", "host_refused"]);

/** The removal flow's next step (design, Signing in, "Removal"; Lifecycle step 9). */
export function removalStep(state: ComputerPageState): RemovalStep {
  if (state.removal.state === "resolved" || state.lifecycle === "removed") return "resolved";
  if (state.removal.state === "pending") return "pending";
  if (state.removal.signOut === "tombstoned" || state.removal.signOut === "verified") {
    return "delete";
  }
  if (state.removal.signOut === "requested") return "signing_out";
  const anyLogin = state.setupCards.some(
    (card) => !(card.state === "needs_sign_in" && card.reason === "not_signed_in"),
  );
  if (!anyLogin) return "delete";
  if (RUNNING.has(state.lifecycle) && state.status !== "stopping") return "sign_out";
  return "delete_then_sign_out";
}

/** What a pending removal still needs (P4, P5): unknown state is never "signed out". */
export function pendingRemoval(state: ComputerPageState): PendingRemoval | null {
  if (state.removal.state !== "pending") return null;
  const signedOut = state.removal.signOut === "verified" || state.removal.signOut === "tombstoned";
  const anyLogin = state.setupCards.some(
    (card) => !(card.state === "needs_sign_in" && card.reason === "not_signed_in"),
  );
  const recordRevocation = state.removal.loginPossiblyLost && !state.removal.revocationRecorded;
  return {
    signOut: !signedOut && anyLogin,
    recordRevocation,
    resolvable: (signedOut || !anyLogin) && !recordRevocation,
  };
}

export function computerView(state: ComputerPageState, nowMs: number): ComputerView {
  const running = RUNNING.has(state.lifecycle) && state.status !== "stopping";
  const removing = state.removal.state !== "none";
  const noContact = state.noContact === true && !removing;
  const notConnected = !removing && (noContact || state.lifecycle === "host_refused");
  const [status, statusTone] = statusOf(state, notConnected);
  const cards = state.setupCards.map(cardView);
  const needsSetup = !removing && state.setupCards.some((c) => c.state === "needs_sign_in");
  const notices: Notice[] = [];
  if (notConnected) {
    notices.push({
      tone: "danger",
      kind: "not_connected",
      text: noContact
        ? `Omnigent has not called this computer since ${state.lastContactAt ? formatTime(state.lastContactAt, nowMs) : "it was added"}. If Omnigent still lists it, a restart arms its host anew; if Omnigent no longer knows it (for example after its database was restored), remove it here.`
        : "Omnigent refused this computer's host. A restart arms its host anew.",
    });
  }
  if (state.restoredTo !== null) {
    notices.push({
      tone: "warn",
      kind: "restored",
      text: `Restored to ${formatTime(state.restoredTo, nowMs)}; later file changes were lost.`,
    });
  }
  if (state.unexpectedStopAt !== null && !running) {
    notices.push({
      tone: "warn",
      kind: "unexpected_stop",
      text: `Stopped unexpectedly at ${formatTime(state.unexpectedStopAt, nowMs)}. The next start restores the latest save; a login changed after it may ask you to sign in again.`,
    });
  }
  if (state.admission.admitting === false && state.admission.reason === "not_saved") {
    const since = state.verifiedAt ?? state.lastSavedAt;
    notices.push({
      tone: "danger",
      kind: "not_saved",
      text: `${since ? `Not saved for ${minutesSince(since, nowMs)} minutes` : "Not saved"}: new work is refused until a save succeeds. Work already running continues.`,
    });
  }
  const sizeWarning =
    state.sizeWarning === true ||
    (state.workspaceBytes !== null && state.workspaceBytes > SIZE_WARNING_BYTES);
  if (sizeWarning) {
    notices.push({
      tone: "warn",
      kind: "size",
      text: "The saved folders are above 1.5 GB. Saves and wakes get slower, and a save may not fit on the disk; remove what you do not need.",
    });
  }
  const offerStopWithoutSaving =
    !removing &&
    running &&
    (state.stopWithoutSavingOffered === true ||
      state.refusedSleeps >= REFUSED_SLEEPS_FOR_STOP_WITHOUT_SAVING);
  if (offerStopWithoutSaving) {
    notices.push({
      tone: "warn",
      kind: "sleeps_refused",
      text: `The computer could not save before sleeping ${state.refusedSleeps} times in a row, so it stays awake.`,
    });
  } else if (!removing && state.refusedSleeps > 0 && running) {
    notices.push({
      tone: "info",
      kind: "sleeps_refused",
      text: `The last ${state.refusedSleeps === 1 ? "sleep was" : `${state.refusedSleeps} sleeps were`} refused because a save could not finish; it stays awake and tries again.`,
    });
  }
  if (state.lifecycle === "failed" && !removing) {
    notices.push({
      tone: "danger",
      kind: "start_failed",
      text: "The last start failed. Omnigent shows it as failed and offers to start it again.",
    });
  }
  if (state.removal.state === "pending") {
    notices.push({
      tone: "warn",
      kind: "removal_pending",
      text: "A removal is pending. Its saved logins are kept until the removal is resolved.",
    });
  }
  let saving: string;
  if (state.saving) saving = "Saving…";
  else if (state.lastSavedAt !== null)
    saving = `Last saved ${formatTime(state.lastSavedAt, nowMs)}`;
  else saving = "Not saved yet";
  const size =
    state.nextSize !== null && state.nextSize !== state.size
      ? `${state.size} (${state.nextSize} from the next start)`
      : state.size;
  return {
    id: state.computerId,
    name: state.hostName ?? `Computer ${state.computerId.slice(4, 12)}`,
    status,
    statusTone,
    running,
    needsSetup,
    cards,
    saving,
    notices,
    size,
    notConnected,
    offerRestart: notConnected && running,
    offerRemove: noContact,
    offerStopWithoutSaving,
    removal: removalStep(state),
    pending: pendingRemoval(state),
  };
}

/**
 * Outage notices for the page (FH-06, RC-34): the interval, why, and what may not have run.
 * `config_changed` (G2-SEC-001) is a pending contract value: the watchdog's one controlled restart
 * that applies a secret or setting release. It is matched as text, so the page reads records
 * written before and after it lands in `OutageRecord`.
 */
export function outageNotices(records: readonly OutageRecord[], nowMs: number): Notice[] {
  return records.map((record) => {
    const from = formatTime(record.startedAt, nowMs);
    const to = record.endedAt === null ? null : formatTime(record.endedAt, nowMs);
    const cause = record.cause as string;
    let text: string;
    if (cause === "config_changed") {
      text =
        to === null
          ? `Omnigent is restarting to apply a configuration change (since ${from}); scheduled runs due meanwhile may not run.`
          : `Omnigent restarted to apply a configuration change. It was unavailable from ${from} to ${to}; scheduled runs due then may not have run.`;
    } else if (cause === "recovery_mode") {
      text =
        to === null
          ? `Omnigent has been in recovery mode since ${from}: its database could not be restored safely, and it needs you. A configuration change released meanwhile is applied once recovery ends.`
          : `Omnigent was in recovery mode from ${from} to ${to}; scheduled runs due then may not have run.`;
    } else {
      text =
        to === null
          ? `Omnigent has been unavailable since ${from}; scheduled runs due meanwhile may not run.`
          : `Omnigent was unavailable from ${from} to ${to}; scheduled runs due then may not have run.`;
    }
    if (record.exitCode === 75) {
      text += " Its server stopped without confirming that every change reached the replica.";
    }
    return { tone: "warn", kind: "outage", text };
  });
}

/** The replication warning (FH-15). Null when replication is healthy. */
export function replicationNotice(health: ReplicationHealth | null, nowMs: number): Notice | null {
  if (health === null) {
    return {
      tone: "warn",
      kind: "replication",
      text: "The database's replication could not be checked. Changes may not be safe yet; check before repeating one.",
    };
  }
  switch (health.state) {
    case "replicating":
      return null;
    case "lagging":
      return {
        tone: "danger",
        kind: "replication",
        text: `The database's replica is behind${health.lastSyncAt ? ` (last copied ${formatTime(health.lastSyncAt, nowMs)})` : ""}. Security changes answer "applied, durability not yet confirmed"; check before repeating one.`,
      };
    case "failing":
      return {
        tone: "danger",
        kind: "replication",
        text: 'The database cannot be copied to its replica now. Security changes answer "applied, durability not yet confirmed"; check before repeating one.',
      };
    case "unknown":
      return {
        tone: "warn",
        kind: "replication",
        text: "The database's replication cannot be checked now, for example while the server starts.",
      };
  }
}
