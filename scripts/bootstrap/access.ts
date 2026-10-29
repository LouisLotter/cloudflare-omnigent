// The owner-only Access application: one builder and one check, shared by the guarded staging
// tool (scripts/staging/guard.ts) and the bootstrap (WP2.4, WP3.31). Pure.
//
// An owner-only application is one self-hosted application on exactly the hostname whose every
// policy allows, and whose every rule is one email address, the owner's; no bypass, no service
// token (the staging tool's one exception aside, F7-staging), no "everyone"; its cookie is
// SameSite=lax (D9), its CORS preflight bypass is off, and it has an AUD tag for ingress to
// check. The check names every way an application differs, and how to fix each in the Zero Trust
// dashboard, never an address. The bootstrap matches addresses against the plan's owner pin (so
// the plan never needs the address again), the staging tool against its configured address.
//
// The bootstrap creates such an application when the hostname has none (access-app.ts, owner
// decision D35); it never changes or deletes one it did not create.

import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import type { AccessSettings } from "./settings.ts";

/** The SameSite attribute of the application's CF_Authorization cookie (owner decision D9). */
export const ACCESS_SAME_SITE = "lax";
/** How long an Access sign-in lasts before the owner signs in again. */
export const ACCESS_SESSION_DURATION = "24h";
export const OWNER_POLICY_NAME = "Allow owner";
export const SERVICE_TOKEN_POLICY_NAME = "Allow the staging service token";
/** Where the person changes Access: the Zero Trust dashboard. */
export const ZERO_TRUST_DASHBOARD = "https://one.dash.cloudflare.com/";

export interface OwnerOnlySpec {
  /** The application's name, which the creator chooses (with its create's nonce). */
  readonly name: string;
  readonly hostname: string;
  readonly ownerEmail: string;
  /** The one login method the application offers, skipping the chooser; all of them if unset. */
  readonly identityProviderId?: string | undefined;
  /** F7-staging only: one more policy, admitting exactly this service token. */
  readonly serviceTokenId?: string | undefined;
}

/** The body of an owner-only Access application (`cf zero-trust access applications create`). */
export function ownerOnlyAppBody(spec: OwnerOnlySpec): Record<string, unknown> {
  return {
    type: "self_hosted",
    name: spec.name,
    domain: spec.hostname,
    session_duration: ACCESS_SESSION_DURATION,
    app_launcher_visible: false,
    same_site_cookie_attribute: ACCESS_SAME_SITE,
    ...(spec.identityProviderId
      ? { allowed_idps: [spec.identityProviderId], auto_redirect_to_identity: true }
      : {}),
    policies: [
      {
        name: OWNER_POLICY_NAME,
        decision: "allow",
        include: [{ email: { email: spec.ownerEmail } }],
      },
      ...(spec.serviceTokenId !== undefined
        ? [
            {
              name: SERVICE_TOKEN_POLICY_NAME,
              decision: "non_identity",
              include: [{ service_token: { token_id: spec.serviceTokenId } }],
            },
          ]
        : []),
    ],
  };
}

/** Which part of an application a problem is in; callers may ignore some (the staging tool). */
export type OwnerOnlyAspect = "application" | "aud" | "cookie" | "preflight" | "rules";

/** One way an application differs from owner-only: what, and how to fix it. Never an address. */
export interface AccessProblem {
  readonly aspect: OwnerOnlyAspect;
  readonly why: string;
  readonly fix: string;
}

export interface OwnerOnlyCheck {
  readonly hostname: string;
  /** Whether an address is the owner's: the plan's pin, or the staging tool's address. */
  readonly isOwner: (email: string) => boolean;
  /** F7-staging: the service token the application may also admit, in one policy of its own. */
  readonly serviceTokenId?: string | undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The single rule an owner-only policy may hold: `{ email: { email: <address> } }`. */
function emailOf(rule: unknown): string | undefined {
  const r = record(rule);
  if (r === undefined || Object.keys(r).length !== 1) return undefined;
  const email = record(r.email);
  if (email === undefined || Object.keys(email).length !== 1) return undefined;
  return typeof email.email === "string" ? email.email : undefined;
}

/** Whether a policy admits exactly one service token, without an identity (F7-staging). */
export function isServiceTokenPolicy(policy: unknown, serviceTokenId: string): boolean {
  const p = record(policy);
  return (
    p?.decision === "non_identity" &&
    JSON.stringify(p.include) === JSON.stringify([{ service_token: { token_id: serviceTokenId } }])
  );
}

/** Every address an application's policies name, for a caller that checks them asynchronously. */
export function addressesIn(app: unknown): string[] {
  const policies = record(app)?.policies;
  return (Array.isArray(policies) ? policies : []).flatMap((policy: unknown) => {
    const include = record(policy)?.include;
    return (Array.isArray(include) ? include : []).flatMap((rule: unknown) => {
      const email = emailOf(rule);
      return email === undefined ? [] : [email];
    });
  });
}

/** A policy's name, for a fix that names it; never an address. */
function policyName(policy: Record<string, unknown> | undefined): string {
  return typeof policy?.name === "string" && policy.name !== ""
    ? `the policy "${policy.name}"`
    : "that policy";
}

/** Every way `app` differs from an owner-only application on the hostname. Empty: it is one. */
export function ownerOnlyProblems(app: unknown, check: OwnerOnlyCheck): AccessProblem[] {
  const a = record(app) ?? {};
  const problems: AccessProblem[] = [];
  const add = (aspect: OwnerOnlyAspect, why: string, fix: string) => {
    if (!problems.some((p) => p.why === why)) problems.push({ aspect, why, fix });
  };
  if (a.type !== "self_hosted") {
    add(
      "application",
      "is not a self-hosted application",
      "delete it; a self-hosted application takes its place",
    );
  }
  if (a.domain !== check.hostname) {
    add(
      "application",
      `does not cover exactly ${check.hostname}`,
      `set its domain to ${check.hostname}, with no path`,
    );
  }
  if (typeof a.aud !== "string" || a.aud === "") {
    add("aud", "has no AUD tag", "delete it; a new application gets one");
  }
  if (a.same_site_cookie_attribute !== ACCESS_SAME_SITE) {
    add(
      "cookie",
      `does not set its cookie to SameSite=${ACCESS_SAME_SITE}`,
      "under Settings, Cookie settings, set Same Site Attribute to Lax",
    );
  }
  if (a.options_preflight_bypass === true) {
    add(
      "preflight",
      "bypasses Access for CORS preflight",
      "under Settings, CORS settings, turn off Bypass options requests to origin",
    );
  }
  const policies = Array.isArray(a.policies) ? (a.policies as unknown[]) : [];
  if (policies.length === 0) {
    add(
      "rules",
      "has no policy",
      "add an Allow policy whose only rule is Emails with the owner's address",
    );
  }
  let owners = 0;
  let tokens = 0;
  for (const policy of policies) {
    const p = record(policy);
    if (check.serviceTokenId !== undefined && isServiceTokenPolicy(p, check.serviceTokenId)) {
      tokens++;
      continue;
    }
    const remove = `remove ${policyName(p)}`;
    if (p?.decision !== "allow") {
      add("rules", "has a policy that is not an allow (a bypass or a service token)", remove);
      continue;
    }
    const include = p.include;
    if (!Array.isArray(include) || include.length === 0) {
      add("rules", "has a policy with no rule", remove);
      continue;
    }
    let ownerOnly = true;
    for (const rule of include as unknown[]) {
      const email = emailOf(rule);
      if (email === undefined) {
        ownerOnly = false;
        add(
          "rules",
          "admits something other than one email address",
          `make the only rule of ${policyName(p)} Emails with the owner's address`,
        );
      } else if (!check.isOwner(email)) {
        ownerOnly = false;
        add(
          "rules",
          "admits someone other than the owner",
          `remove every address but the owner's from ${policyName(p)}`,
        );
      }
    }
    if (ownerOnly) owners++;
  }
  if (tokens > 1) {
    add("rules", "admits its service token more than once", "keep one service token policy");
  }
  if (policies.length > 0 && owners === 0 && problems.every((p) => p.aspect !== "rules")) {
    add(
      "rules",
      "has no policy that allows the owner",
      "add an Allow policy whose only rule is Emails with the owner's address",
    );
  }
  return problems;
}

/** Whether `app` covers `hostname`: on its domain, or one of its destinations, with any path. */
export function coversHostname(app: unknown, hostname: string): boolean {
  const a = record(app);
  if (a === undefined) return false;
  const names: unknown[] = [
    a.domain,
    ...(Array.isArray(a.self_hosted_domains) ? a.self_hosted_domains : []),
    ...(Array.isArray(a.destinations) ? a.destinations.map((d: unknown) => record(d)?.uri) : []),
  ];
  return names.some(
    (name) => typeof name === "string" && (name === hostname || name.startsWith(`${hostname}/`)),
  );
}

/** A refusal's text: what differs, and how to fix it, in the Zero Trust dashboard. */
export function describeProblems(
  what: string,
  problems: readonly AccessProblem[],
  orDelete: boolean,
): string {
  const fixes = problems.map((p) => p.fix).join("; ");
  const instead = orDelete
    ? ", or delete it and run again: the bootstrap then creates an owner-only one itself"
    : "";
  return `${what} ${problems.map((p) => p.why).join("; ")}. To fix it, open ${ZERO_TRUST_DASHBOARD}, Access, Applications, edit it, and ${fixes}${instead}. The bootstrap never changes or widens an application it did not create`;
}

/** The plan's owner pin as a check: every address the application names, matched first. */
export async function pinCheck(
  app: unknown,
  hostname: string,
  ownerPin: string,
): Promise<OwnerOnlyCheck> {
  const pin = parseOwnerPin(ownerPin);
  if (pin === undefined) throw new Error("the plan's owner pin is malformed");
  const owners = new Set<string>();
  for (const email of addressesIn(app)) if (await pin.matches(email)) owners.add(email);
  return { hostname, isOwner: (email) => owners.has(email) };
}

/**
 * The Access settings for `hostname` from the applications Cloudflare lists for it and the
 * team's auth domain, or an error that says what is wrong and how to fix it (never an address).
 * The read path: the staging adapter and, before WP3.31, every installation.
 */
export async function ownerOnlyAccess(
  apps: readonly unknown[],
  hostname: string,
  ownerPin: string,
  authDomain: unknown,
): Promise<AccessSettings> {
  if (parseOwnerPin(ownerPin) === undefined) throw new Error("the plan's owner pin is malformed");
  if (typeof authDomain !== "string" || authDomain === "") {
    throw new Error("could not read the Zero Trust team domain");
  }
  const mine = apps.filter((app) => coversHostname(app, hostname));
  if (mine.length !== 1) {
    throw new Error(
      `expected exactly one Access application on ${hostname}, found ${mine.length}; create it first, owner-only`,
    );
  }
  const app = mine[0];
  const problems = ownerOnlyProblems(app, await pinCheck(app, hostname, ownerPin));
  if (problems.length > 0) {
    throw new Error(
      `${describeProblems(`the Access application on ${hostname}`, problems, false)}; not deploying`,
    );
  }
  return { teamDomain: authDomain, aud: (app as { aud: string }).aud };
}
