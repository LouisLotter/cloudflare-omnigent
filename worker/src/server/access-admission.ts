// Who Cloudflare Access admits, kept in step with the team (WP8.3, D50). Pure apart from the
// AccessGroupPort, which access-group-api.ts implements with Cloudflare's API.
//
// Omnigent commits each membership change with a higher admission revision, then its admission
// adapter (the server image's `cfo_server/admission.py`) sends the whole list here
// (`AccessAdmissionCall`): active members' verified addresses and pending invitations. This writes it
// into the one Access group the installer created for the installation's members, and nothing
// else: never another group, an application, a policy or an organization setting. In order:
//   1. a revision at or below the last applied is answered `stale` and changes nothing;
//   2. the list must name the installation's owner (the owner pin), so a bad list can never lock
//      the owner out (`owner_missing`);
//   3. the group is read; one that is gone is `group_missing`;
//   4. every include rule must be one email address: a group someone widened (a domain, everyone,
//      another group) is refused as it is (`foreign_rules`), never rewritten into shape;
//   5. only `include` is replaced; `exclude`, `require` and the name are written back as read
//      (Cloudflare's update replaces the whole group);
//   6. the group is read back: only what Access holds decides; a list it did not keep throws, so
//      the adapter retries;
//   7. the revision is recorded as applied.
// Omnigent's own membership check never depends on this: a person Access still admits but
// Omnigent has suspended reaches nothing. Logged by group, revision and count, never an address.

import type { AccessAdmissionCall, AccessAdmissionResult } from "@cfo/contracts";
import type { OwnerPin } from "../ingress/owner.ts";

/** An Access group's rules, as Cloudflare reports them. */
export interface AccessGroup {
  readonly name: string;
  readonly include: readonly unknown[];
  readonly exclude?: readonly unknown[] | undefined;
  readonly require?: readonly unknown[] | undefined;
}

/** The one group this installation's reconciler may read and write. */
export interface AccessGroupPort {
  /** The group's ID, for logs. */
  readonly groupId: string;
  /** The group, or undefined when it does not exist. */
  read(): Promise<AccessGroup | undefined>;
  /** Replaces the group (Cloudflare's PUT). */
  write(group: AccessGroup): Promise<void>;
}

export interface AdmissionDeps {
  /** Undefined when the platform Worker holds no group, account or token: `not_configured`. */
  readonly port: AccessGroupPort | undefined;
  /** The owner pin; undefined: `not_configured`. */
  readonly owner: OwnerPin | undefined;
  /** The last applied revision, or null. */
  appliedRevision(): number | null;
  /** Records the applied revision (after Access confirmed it). */
  recordApplied(revision: number): void;
  log(fields: Readonly<Record<string, string | number>>): void;
}

/** Thrown when Access did not keep the list: the caller answers 503 and the adapter retries. */
export class AdmissionUnconfirmed extends Error {}

/** The email of a rule that names exactly one address, `{ email: { email } }`; else undefined. */
export function emailRuleOf(rule: unknown): string | undefined {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return undefined;
  const keys = Object.keys(rule);
  if (keys.length !== 1 || keys[0] !== "email") return undefined;
  const inner = (rule as { email?: unknown }).email;
  if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return undefined;
  const value = (inner as { email?: unknown }).email;
  return Object.keys(inner).length === 1 && typeof value === "string" ? value : undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map((e) => e.toLowerCase()));
  const right = new Set(b.map((e) => e.toLowerCase()));
  return left.size === right.size && [...left].every((e) => right.has(e));
}

/** The include addresses of a group made only of email rules, or undefined. */
function emailsOf(group: AccessGroup): string[] | undefined {
  const emails = group.include.map(emailRuleOf);
  return emails.every((e) => e !== undefined) ? (emails as string[]) : undefined;
}

export async function applyAdmission(
  call: AccessAdmissionCall,
  deps: AdmissionDeps,
): Promise<AccessAdmissionResult> {
  const { port, owner } = deps;
  const done = (result: AccessAdmissionResult): AccessAdmissionResult => {
    deps.log({
      event: "access_admission",
      outcome: result.outcome,
      ...(result.outcome === "refused" ? { reason: result.reason } : {}),
      ...(port === undefined ? {} : { group: port.groupId }),
      revision: call.revision,
      count: call.emails.length,
    });
    return result;
  };
  if (port === undefined || owner === undefined) {
    return done({ outcome: "refused", reason: "not_configured" });
  }
  const applied = deps.appliedRevision();
  if (applied !== null && call.revision <= applied) {
    return done({ outcome: "stale", appliedRevision: applied });
  }
  let ownerListed = false;
  for (const email of call.emails) if (await owner.matches(email)) ownerListed = true;
  if (!ownerListed) return done({ outcome: "refused", reason: "owner_missing" });
  const group = await port.read();
  if (group === undefined) return done({ outcome: "refused", reason: "group_missing" });
  const current = emailsOf(group);
  if (current === undefined) return done({ outcome: "refused", reason: "foreign_rules" });
  if (!sameSet(current, call.emails)) {
    await port.write({
      name: group.name,
      include: call.emails.map((email) => ({ email: { email } })),
      exclude: group.exclude ?? [],
      require: group.require ?? [],
    });
    const after = await port.read();
    const kept = after === undefined ? undefined : emailsOf(after);
    if (kept === undefined || !sameSet(kept, call.emails)) {
      deps.log({ event: "access_admission", outcome: "unconfirmed", group: port.groupId });
      throw new AdmissionUnconfirmed("Access did not keep the member list");
    }
  }
  deps.recordApplied(call.revision);
  return done({ outcome: "applied", revision: call.revision });
}
