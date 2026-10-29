// What the installer's account must have before `plan` writes a state file (WP3.31): the Workers
// Paid plan (the server's container), R2 (the database replica and Omnigent's files), the
// hostname's domain as an active zone of the account (the web Worker's custom domain), and a
// Zero Trust organization (Access). Read-only, with the installer's `cf` login. Pure apart from
// the PreflightApi port, which cloud.ts implements with cf.
//
// Each of them is a payment, a purchase or a plan choice, so nothing here creates anything: a
// missing one gets one sentence and one dashboard link. What cf cannot read is "could not
// check", and the plan goes on: the preflight never stops on uncertainty, only on something
// Cloudflare says is missing. An answer of an unexpected shape is uncertainty too (Codex WP3.31
// r1-4): "missing" needs a well-formed answer that lacks the thing.

import { noOrganizationStep } from "./access-app.ts";

export interface PreflightApi {
  /** The account's subscriptions, as `cf accounts subscriptions get` lists them. */
  subscriptions(): unknown[];
  /** Whether R2 is enabled: false when Cloudflare says to enable it first (error 10042). */
  r2Enabled(): boolean;
  /** The zones of exactly this name that the login reaches, in any account. */
  zones(name: string): unknown[];
  /** The Zero Trust organization's team domain, or undefined when the account has none. */
  teamDomain(): string | undefined;
}

export type PreflightState = "present" | "missing" | "unknown";

export interface PreflightItem {
  readonly item: string;
  readonly state: PreflightState;
  /** Missing: what to do, in one sentence with its link. Unknown: why. Present: what was found. */
  readonly text: string;
}

const DASHBOARD = "https://dash.cloudflare.com/?to=/:account";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function why(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A subscription's plan, by its rate plan's ID or its product's name; throws if it has neither. */
function planOf(subscription: unknown): { plan: string; state: string } {
  const s = record(subscription);
  const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const ratePlan = text(record(s?.rate_plan)?.id);
  const product = text(record(s?.product)?.name);
  if (ratePlan === undefined && product === undefined) {
    throw new Error("a subscription in Cloudflare's answer names no plan");
  }
  return {
    plan: `${typeof ratePlan === "string" ? ratePlan : ""} ${typeof product === "string" ? product : ""}`,
    state: typeof s?.state === "string" ? s.state : "",
  };
}

/** States in which a subscription no longer gives what it sold. */
const ENDED = /^(cancell?ed|expired|failed)$/i;

function workersPlan(api: PreflightApi): PreflightItem {
  const item = "the Workers Paid plan";
  let plans: { plan: string; state: string }[];
  try {
    plans = api.subscriptions().map(planOf);
  } catch (error) {
    return { item, state: "unknown", text: why(error) };
  }
  const paid = plans.filter(({ plan, state }) => {
    const workers = /workers/i.test(plan) && !/\bworkers_free\b/i.test(plan);
    return workers && !ENDED.test(state);
  });
  return paid.length > 0
    ? { item, state: "present", text: "subscribed" }
    : {
        item,
        state: "missing",
        text: `the Workers Paid plan, which the server's container needs: subscribe at ${DASHBOARD}/workers/plans`,
      };
}

function r2(api: PreflightApi): PreflightItem {
  const item = "R2";
  try {
    return api.r2Enabled()
      ? { item, state: "present", text: "enabled" }
      : {
          item,
          state: "missing",
          text: `R2 object storage, which keeps the database replica and Omnigent's files: enable it at ${DASHBOARD}/r2/overview`,
        };
  } catch (error) {
    return { item, state: "unknown", text: why(error) };
  }
}

/** The names a zone holding `hostname` could have: the hostname, then each parent of 2+ labels. */
export function zoneCandidates(hostname: string): string[] {
  const labels = hostname.toLowerCase().split(".");
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
}

function zone(api: PreflightApi, accountId: string, hostname: string): PreflightItem {
  const item = `the domain of ${hostname}`;
  let elsewhere: string | undefined;
  for (const name of zoneCandidates(hostname)) {
    let listed: unknown[];
    try {
      listed = api.zones(name);
    } catch (error) {
      return { item, state: "unknown", text: why(error) };
    }
    // Every zone in the answer must have a name, a status and an account: one without them is
    // uncertainty, never "missing" (Codex WP3.31 r2-3).
    const filled = (v: unknown) => typeof v === "string" && v !== "";
    const malformed = listed.some((z) => {
      const zone = record(z);
      return !filled(zone?.name) || !filled(zone?.status) || !filled(record(zone?.account)?.id);
    });
    if (malformed) {
      return { item, state: "unknown", text: `Cloudflare's answer for ${name} is incomplete` };
    }
    const found = listed.filter((z) => record(z)?.name === name);
    const here = found.find((z) => record(record(z)?.account)?.id === accountId);
    if (here === undefined) {
      if (found.length > 0) elsewhere ??= name;
      continue;
    }
    const status = record(here)?.status;
    if (status === "active") return { item, state: "present", text: `${name}, active` };
    return {
      item,
      state: "missing",
      text: `${name} is in your account but not active yet (${String(status)}): finish adding it, as ${DASHBOARD}/${name} shows (its nameservers), then run again`,
    };
  }
  return {
    item,
    state: "missing",
    text:
      elsewhere === undefined
        ? `a domain on Cloudflare for ${hostname}: add your domain, or register one, at ${DASHBOARD}/add-site`
        : `${elsewhere} is in another of your Cloudflare accounts: plan with that account (--account), or add the domain to this one at ${DASHBOARD}/add-site`,
  };
}

function zeroTrust(api: PreflightApi): PreflightItem {
  const item = "a Zero Trust organization";
  try {
    const team = api.teamDomain();
    return team === undefined
      ? { item, state: "missing", text: noOrganizationStep() }
      : { item, state: "present", text: team };
  } catch (error) {
    return { item, state: "unknown", text: why(error) };
  }
}

/** Every item, read-only, in the order a person would fix them. */
export function preflight(api: PreflightApi, accountId: string, hostname: string): PreflightItem[] {
  return [workersPlan(api), r2(api), zone(api, accountId, hostname), zeroTrust(api)];
}

/** What to tell the person, and whether the plan may go on. */
export function preflightReport(items: readonly PreflightItem[]): {
  readonly ready: boolean;
  readonly lines: string[];
} {
  const lines = items.map((i) =>
    i.state === "present"
      ? `${i.item}: ${i.text}`
      : i.state === "unknown"
        ? `could not check ${i.item} (${i.text}); going on`
        : `missing: ${i.text}`,
  );
  return { ready: items.every((i) => i.state !== "missing"), lines };
}
