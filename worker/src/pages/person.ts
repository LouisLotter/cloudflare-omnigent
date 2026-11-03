// The person behind a platform page request (WP8.4): the one seam every page decides it through.
//
// Ingress has admitted the request (WP2.1): a valid Access assertion for an admitted identity, the
// installation's hostname and an exact origin. This seam turns that identity into the person
// WorkspaceDO's page front authorizes against each computer's owner binding (`ownership.ts`):
// what a person may see and do there is decided in WorkspaceDO, never here.
//
// Before teams, ingress admits only the installation's owner (the owner pin, `ingress/owner.ts`),
// so the seam answers `installation_owner` for every admitted request. WP8.3 replaces it with a
// membership lookup: the Access identity's bound team member and role, or no person (refused)
// for an identity Omnigent does not bind to an active member. Pages never read the identity
// themselves.

import type { PagePerson } from "@cfo/contracts";
import type { Admitted } from "../ingress/index.ts";

/** Decides the person for an admitted request; null refuses the request. */
export type PersonSeam = (admitted: Admitted) => Promise<PagePerson | null>;

/** Today's seam: ingress admits only the installation's owner. */
export const installationOwnerSeam: PersonSeam = async () => ({ kind: "installation_owner" });

/**
 * Whether the person may use the installation owner's own pages (the owner's Omnigent password,
 * the GitHub App's setup). Only the installation's owner; WP8.3 decides them per member.
 */
export function isInstallationOwner(person: PagePerson): boolean {
  return person.kind === "installation_owner";
}
