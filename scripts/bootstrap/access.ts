// The hostname's Access application, as the bootstrap requires it (WP2.4; design, Ingress). Pure.
//
// The bootstrap never creates or changes Access: the installer creates the application before
// the first deploy (in staging, the guarded staging tool does). It only reads it and refuses to
// deploy the web Worker unless it is exactly one owner-only, self-hosted application on the
// hostname: every policy allows, every rule is one email address and that address is the pinned
// owner's (the pin is checked, so the plan never needs the address again); no bypass, no service
// token, no "everyone"; the cookie is SameSite=lax (D9) and the preflight bypass is off.

import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import type { AccessSettings } from "./settings.ts";

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

/**
 * The Access settings for `hostname` from the applications Cloudflare lists for it and the
 * team's auth domain, or an error that says what is wrong (never an address).
 */
export async function ownerOnlyAccess(
  apps: readonly unknown[],
  hostname: string,
  ownerPin: string,
  authDomain: unknown,
): Promise<AccessSettings> {
  const pin = parseOwnerPin(ownerPin);
  if (pin === undefined) throw new Error("the plan's owner pin is malformed");
  if (typeof authDomain !== "string" || authDomain === "") {
    throw new Error("could not read the Zero Trust team domain");
  }
  const mine = apps.map(record).filter((app) => app?.domain === hostname);
  if (mine.length !== 1) {
    throw new Error(
      `expected exactly one Access application on ${hostname}, found ${mine.length}; create it first, owner-only`,
    );
  }
  const app = mine[0] as Record<string, unknown>;
  const refuse = (why: string): never => {
    throw new Error(`the Access application on ${hostname} ${why}; not deploying`);
  };
  if (app.type !== "self_hosted") refuse("is not a self-hosted application");
  if (typeof app.aud !== "string" || app.aud === "") refuse("has no AUD tag");
  if (app.same_site_cookie_attribute !== "lax") refuse("does not set its cookie to SameSite=lax");
  if (app.options_preflight_bypass === true) refuse("bypasses Access for CORS preflight");
  const policies = app.policies;
  if (!Array.isArray(policies) || policies.length === 0) refuse("has no policy");
  for (const policy of policies as unknown[]) {
    const p = record(policy);
    if (p?.decision !== "allow")
      refuse("has a policy that is not an allow (a bypass or a service token)");
    const include = p?.include;
    if (!Array.isArray(include) || include.length === 0) refuse("has a policy with no rule");
    for (const rule of include as unknown[]) {
      const email = emailOf(rule);
      if (email === undefined) refuse("admits something other than one email address");
      if (!(await pin.matches(email as string))) refuse("admits someone other than the owner");
    }
  }
  return { teamDomain: authDomain as string, aud: app.aud as string };
}
