// Pure: who a cloud computer belongs to (WP8.4, owner decision D50), and the decisions that
// depend on it. No Workers runtime import.
//
// A computer belongs to exactly one person, from provisioning on. WorkspaceDO records that person
// once, as the computer's owner binding, and checks it on every launcher call and every page
// call. The binding never moves to another person. It can only gain detail: a computer recorded
// before Omnigent named owners is adopted for the installation's owner, and a binding made
// without a team (an Omnigent build without the team model) learns its member and team once the
// same account on the same host has them.
//
// Who the installation's owner is: the account the installer pre-provisioned
// (`SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME`). Before teams, Access admitted only that
// person, so every computer recorded without an owner is theirs.

import {
  AccountId,
  type ComputerPageState,
  HostId,
  type LauncherOwner,
  RESTORED_STATES,
  TeamMemberId,
  TIMING,
} from "@cfo/contracts";
import { z } from "zod";

const Millis = z.number().int().min(0).max(8.64e15);

/** The owner binding WorkspaceDO keeps in its record. Immutable but for the two refinements. */
export const OwnerBinding = z.strictObject({
  userId: AccountId,
  memberId: TeamMemberId.nullable(),
  teamId: TeamMemberId.nullable(),
  hostId: HostId,
  /**
   * `provision`: a version 2 `provision` recorded the computer for this owner. `adopted`: the
   * computer was recorded without an owner, and its first version 2 call adopted it for the
   * installation's owner.
   */
  how: z.enum(["provision", "adopted"]),
  boundAt: Millis,
});
export type OwnerBinding = z.infer<typeof OwnerBinding>;

/** The fields that identify an owner, on a binding or on a launcher call. */
export interface OwnerFields {
  readonly userId: string;
  readonly memberId: string | null;
  readonly teamId: string | null;
  readonly hostId: string;
}

/**
 * How a named owner relates to a bound one:
 * - `same`: the same account on the same host, with the same member and team where both name
 *   them (a caller without a team names neither, and the account and host decide);
 * - `refines`: the same account and host, and the binding has no member yet while the call names
 *   one: the binding learns it;
 * - `other`: anyone else, or another host.
 */
export type OwnerMatch = "same" | "refines" | "other";

export function matchOwner(bound: OwnerFields, named: OwnerFields): OwnerMatch {
  if (bound.userId !== named.userId || bound.hostId !== named.hostId) return "other";
  if (bound.memberId === null) return named.memberId === null ? "same" : "refines";
  if (named.memberId === null) return "same";
  return bound.memberId === named.memberId && bound.teamId === named.teamId ? "same" : "other";
}

/**
 * Whether a computer's `provision` name contradicts a host ID. Omnigent names a computer
 * `managed-<host ID>`, and named the earliest ones `managed-<its first 8 hex digits>`; a name of
 * either form must name this host. Any other name says nothing about the host.
 */
export function nameContradictsHost(name: string | null, hostId: string): boolean {
  if (name === null) return false;
  const whole = /^managed-([0-9a-f]{32})$/.exec(name);
  if (whole !== null) return whole[1] !== hostId;
  const short = /^managed-([0-9a-f]{8})$/.exec(name);
  if (short !== null) return short[1] !== hostId.slice(0, 8);
  return false;
}

/** What WorkspaceDO knows when it checks a launcher call's owner. */
export interface LauncherOwnerInput {
  /** The record's binding; null for a computer recorded without an owner. */
  readonly binding: OwnerBinding | null;
  /** The host ID bound at the first `start_host`; null before it. */
  readonly hostId: string | null;
  /** The record's `provision` name. */
  readonly name: string | null;
  /** The call's owner; undefined for a version 1 call, which names none. */
  readonly owner: LauncherOwner | undefined;
  /** The installation owner's account ID; null when it is not configured. */
  readonly installationOwner: string | null;
  readonly now: number;
}

/**
 * The decision on one launcher call's owner, before anything else about the call:
 * - `ok` with `bind`: accepted; `bind` is a new binding to persist before the call has any effect
 *   (an adoption or a refinement), or null when the binding stays as it is;
 * - `forbidden`: the computer belongs to someone else, or another host; nothing happens, and the
 *   refusal says nothing about the computer's state.
 *
 * A version 1 call names no owner: it comes from a server without owners, which only an
 * installation before teams runs (or one rolled back to it). It acts for the installation's
 * owner: accepted on a computer without a binding or bound to that owner, refused on anyone
 * else's.
 */
export type LauncherOwnerDecision =
  | { readonly ok: true; readonly bind: OwnerBinding | null }
  | { readonly ok: false; readonly reason: OwnerRefusal };

/** Why a call's owner was refused; for the log, never for the caller. */
export type OwnerRefusal =
  | "unattributed"
  | "other_owner"
  | "other_host"
  | "not_installation_owner"
  | "no_installation_owner";

export function checkLauncherOwner(input: LauncherOwnerInput): LauncherOwnerDecision {
  const { binding, owner, installationOwner } = input;
  if (owner === undefined) {
    if (binding === null) return { ok: true, bind: null };
    if (installationOwner !== null && binding.userId === installationOwner) {
      return { ok: true, bind: null };
    }
    return { ok: false, reason: "unattributed" };
  }
  if (
    (input.hostId !== null && input.hostId !== owner.hostId) ||
    nameContradictsHost(input.name, owner.hostId)
  ) {
    return { ok: false, reason: "other_host" };
  }
  if (binding === null) {
    if (installationOwner === null) return { ok: false, reason: "no_installation_owner" };
    if (owner.userId !== installationOwner) return { ok: false, reason: "not_installation_owner" };
    return { ok: true, bind: bindingFor(owner, "adopted", input.now) };
  }
  switch (matchOwner(binding, owner)) {
    case "same":
      return { ok: true, bind: null };
    case "refines":
      return {
        ok: true,
        bind: { ...binding, memberId: owner.memberId, teamId: owner.teamId },
      };
    case "other":
      return {
        ok: false,
        reason: binding.hostId === owner.hostId ? "other_owner" : "other_host",
      };
  }
}

/** A new binding for `owner`. */
export function bindingFor(
  owner: LauncherOwner,
  how: OwnerBinding["how"],
  now: number,
): OwnerBinding {
  return {
    userId: owner.userId,
    memberId: owner.memberId,
    teamId: owner.teamId,
    hostId: owner.hostId,
    how,
    boundAt: now,
  };
}

/**
 * Whether the checkpoint `checkpointId`, the current pointer, may be restored into a computer
 * bound to `binding`, given the pointer's owner stamp:
 * - a stamp for this checkpoint names the binding when it was published. The binding only ever
 *   gains detail, so the same owner, or an ancestor of the binding without a member, matches;
 *   anyone else (or a stamp on a computer with no binding) is a checkpoint that never belonged to
 *   this computer's owner, and its restore is refused;
 * - a pointer no stamp names was published by a Worker without owners: before WP8.4, or the
 *   previous release during a rollback. It is this computer's own (its manifest names the
 *   computer, its objects are under the computer's own prefix, and only this computer's
 *   WorkspaceDO sets its pointers), and a computer's owner never changes, so it restores.
 */
export function stampMatches(
  stamp: { readonly checkpointId: string; readonly owner: OwnerBinding } | null,
  checkpointId: string,
  binding: OwnerBinding | null,
): boolean {
  if (stamp === null || stamp.checkpointId !== checkpointId) return true;
  if (binding === null) return false;
  return matchOwner(stamp.owner, binding) !== "other";
}

/**
 * The owner key logged and written as checkpoint metadata: the member ID where there is one,
 * else a marker. Never the account ID, which is personal data.
 */
export function ownerTag(binding: OwnerBinding | null): string {
  if (binding === null) return "installation";
  return binding.memberId === null ? "account" : `member:${binding.memberId}`;
}

// ---------------------------------------------------------------------------------------------
// The pages (WP8.4): who may do what with a computer, from the person the web Worker's seam
// decided (`pages/person.ts`) and the computer's binding.

/** A page request's person, as `PagePerson` carries it. */
export type PagePersonFields =
  | { readonly kind: "installation_owner" }
  | {
      readonly kind: "member";
      readonly memberId: string;
      readonly userId: string;
      readonly role: "owner" | "admin" | "member";
    };

/**
 * What a person may do with a computer:
 * - `owner`: everything the pages offer: it is theirs;
 * - `admin`: someone else's, seen by a human administrator (the installation's owner, or a team
 *   owner or admin), who helps its owner (support access, owner decision D62): sees it in the
 *   fleet, opens its setup page and status, drives its terminal, changes its size, stops it,
 *   removes it while Omnigent no longer calls it, and finishes a pending removal. An
 *   administrator acts on the computer, never as its owner: never signs in on it, reads a
 *   sign-in attempt, signs it out outside a removal, records a revocation or changes a staging
 *   switch, and the binding never moves;
 * - `none`: nothing; the computer is answered as if it did not exist.
 */
export type PageAccess = "owner" | "admin" | "none";

/** Whether `person` owns a computer bound to `binding`. */
export function ownsComputer(
  person: PagePersonFields,
  binding: OwnerBinding | null,
  installationOwner: string | null,
): boolean {
  if (person.kind === "installation_owner") {
    return binding === null || (installationOwner !== null && binding.userId === installationOwner);
  }
  if (binding !== null && binding.memberId !== null) {
    return binding.memberId === person.memberId && binding.userId === person.userId;
  }
  // No binding, or one made before the team: the installation owner's, whoever names that account.
  return (
    installationOwner !== null &&
    person.userId === installationOwner &&
    (binding === null || binding.userId === installationOwner)
  );
}

export function pageAccess(
  person: PagePersonFields,
  binding: OwnerBinding | null,
  installationOwner: string | null,
): PageAccess {
  if (ownsComputer(person, binding, installationOwner)) return "owner";
  if (person.kind === "installation_owner" || person.role !== "member") return "admin";
  return "none";
}

/** The page actions, as the page front classifies its calls. */
export type PageAction =
  /** The page state for the list and the confirmation pages. */
  | "fleet"
  /** The setup page and its status read (a sign-in attempt's read is `sign_in`). */
  | "view"
  | "terminal"
  | "sign_in"
  | "set_size"
  | "restart"
  | "stop_without_saving"
  | "sign_out"
  | "record_revocation"
  | "resolve_removal"
  /** An administrator's end of a removal whose sign-out cannot settle (WP8.9). */
  | "delete_without_sign_out"
  | "remove"
  | "staging";

/**
 * Whether `access` allows `action`. An administrator may open the setup page and its terminal,
 * change the size, stop and remove (D62); a sign-out and the removal's end only while a removal
 * is pending (signing a departing person's logins out of a computer being removed protects that
 * person). Signing in, a sign-in attempt, the revocation record and the staging switches are the
 * owner's alone: a person's logins stay their own. Deleting without a sign-out is the
 * administrator's alone: an owner who cannot sign out records that they revoked the sessions
 * themselves.
 */
export function pageAllows(
  access: PageAccess,
  action: PageAction,
  removalPending: boolean,
): boolean {
  if (action === "delete_without_sign_out") return access === "admin" && removalPending;
  if (access === "owner") return true;
  if (access === "none") return false;
  switch (action) {
    case "fleet":
    case "view":
    case "terminal":
    case "set_size":
    case "restart":
    case "remove":
      return true;
    case "sign_out":
    case "resolve_removal":
    // A removed member's computer whose save keeps failing (`removalStopWithoutSavingDue`).
    case "stop_without_saving":
      return removalPending;
    default:
      return false;
  }
}

/** The person's key in a request-intent token: who the token was issued to. */
export function personKey(person: PagePersonFields): string {
  return person.kind === "installation_owner" ? "installation" : `member:${person.memberId}`;
}

// ---------------------------------------------------------------------------------------------
// When the pages offer a removal's steps (WP8.9). One rule each, used by the confirmation page,
// the cards and WorkspaceDO's check of the POST, so what a page offers is what the POST does.

/** The facts of a computer's page state the removal offers depend on. */
export interface RemovalFacts {
  /** Omnigent has not called the computer for the no-contact window, and no removal is recorded. */
  readonly noContact: boolean;
  readonly removal: "none" | "pending" | "resolved";
  readonly lifecycle: string;
  /** The sign-out rule lets the removal resolve. */
  readonly settled: boolean;
  readonly signOut: "none" | "requested" | "tombstoned" | "verified";
  /** A sign-out job runs now. */
  readonly signOutRunning: boolean;
  /** A sign-out run ended without a verified sign-out: it was tried and did not finish. */
  readonly signOutFailed: boolean;
  /** A login may have changed after the last save, and nobody recorded revoking it. */
  readonly revocationRequired: boolean;
  /** Omnigent's removal of a removed member: its account is gone. */
  readonly memberRemoved: boolean;
  /** That removal's stops refused because their save failed. */
  readonly refusedStops: number;
}

export function removalFactsOf(state: ComputerPageState): RemovalFacts {
  const { removal } = state;
  return {
    noContact: state.noContact === true,
    removal: removal.state,
    lifecycle: state.lifecycle,
    settled: removal.settled === true,
    signOut: removal.signOut,
    // An older controller says only its persisted phase: a requested one may still run.
    signOutRunning: removal.signOutRunning ?? removal.signOut === "requested",
    signOutFailed: removal.signOutFailed === true,
    revocationRequired: removal.loginPossiblyLost && !removal.revocationRecorded,
    memberRemoved: removal.memberRemoved === true,
    refusedStops: removal.refusedStops ?? 0,
  };
}

/**
 * Whether recording a removal from the page is offered, to the computer's owner and to an
 * administrator alike: only for a lost host, awake while Omnigent has not called it for an hour
 * (`noContact`, FH-29, FH-31), with no removal recorded. An asleep computer is never offered: its
 * owner deletes it in Omnigent, whose `terminate` records the removal, and a removed member's
 * computers get Omnigent's own removal.
 */
export function removeOffered(facts: RemovalFacts): boolean {
  return facts.noContact && facts.removal === "none" && facts.lifecycle !== "removed";
}

/**
 * Whether a pending removal may end without a settled sign-out: the computer is stopped again, no
 * sign-out runs, and the sign-out cannot settle, because one was tried and did not finish, or a
 * login may have changed after the last save, so no sign-out from a saved login reaches it. A
 * run that did not finish leaves `signOutFailed`, or, from an older WorkspaceDO, its phase at
 * `requested` or `tombstoned`. Its saved logins are deleted; the provider sessions are not
 * revoked.
 */
export function unsignedDeletionDue(facts: RemovalFacts): boolean {
  if (facts.removal !== "pending" || facts.lifecycle !== "removal_pending") return false;
  if (facts.settled || facts.signOutRunning) return false;
  return (
    facts.revocationRequired ||
    facts.signOutFailed ||
    facts.signOut === "requested" ||
    facts.signOut === "tombstoned"
  );
}

/**
 * Whether an owner or admin may stop a removed member's computer without saving: Omnigent removed
 * the member, the computer still runs, and its removal's stops were refused because their save
 * failed as often as sleeps are refused before "stop without saving" (FH-35). The computer's
 * files changed since the last save are lost, and its logins too if they cannot be saved; its
 * owner keeps FH-35's own rule for their computer.
 */
export function removalStopWithoutSavingDue(facts: RemovalFacts): boolean {
  return (
    facts.removal === "pending" &&
    facts.memberRemoved &&
    RESTORED_STATES.includes(facts.lifecycle as (typeof RESTORED_STATES)[number]) &&
    facts.refusedStops >= TIMING.refusedSleepsBeforeStopWithoutSaving
  );
}
