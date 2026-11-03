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

import type { LauncherOwner } from "@cfo/contracts";
import { AccountId, HostId, TeamMemberId } from "@cfo/contracts";
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
 * Whether a checkpoint pointer published under `stamp` (the binding when it was published; null
 * when the computer had none) may be restored into a computer bound to `binding` now. The
 * binding only ever gains detail, so an older stamp is either the same owner or an ancestor of
 * the binding: no binding (the installation's owner) or one without a member. Anything else is a
 * checkpoint that never belonged to this computer's owner: its restore is refused.
 */
export function stampMatches(
  stamp: OwnerBinding | null,
  binding: OwnerBinding | null,
  installationOwner: string | null,
): boolean {
  if (stamp === null) {
    return (
      binding === null ||
      binding.how === "adopted" ||
      (installationOwner !== null && binding.userId === installationOwner)
    );
  }
  if (binding === null) return false;
  return matchOwner(stamp, binding) !== "other";
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
 *   owner or admin), who may see it in the fleet, stop it, remove it while Omnigent no longer
 *   calls it, and finish a pending removal; never start it, sign in on it, read its status or
 *   sign-ins, or drive its terminal;
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
  /** The setup page's own reads: the computer's status and a sign-in attempt. */
  | "view"
  | "terminal"
  | "sign_in"
  | "set_size"
  | "restart"
  | "stop_without_saving"
  | "sign_out"
  | "record_revocation"
  | "resolve_removal"
  | "remove"
  | "staging";

/**
 * Whether `access` allows `action`. An administrator may stop and remove; a sign-out and the
 * removal's end only while a removal is pending (signing a departing person's logins out of a
 * computer being removed protects that person). Everything else is the owner's alone.
 */
export function pageAllows(
  access: PageAccess,
  action: PageAction,
  removalPending: boolean,
): boolean {
  if (access === "owner") return true;
  if (access === "none") return false;
  switch (action) {
    case "fleet":
    case "restart":
    case "remove":
      return true;
    case "sign_out":
    case "resolve_removal":
      return removalPending;
    default:
      return false;
  }
}

/** The person's key in a request-intent token: who the token was issued to. */
export function personKey(person: PagePersonFields): string {
  return person.kind === "installation_owner" ? "installation" : `member:${person.memberId}`;
}
