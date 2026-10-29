// The hostname's owner-only Access application, created by the bootstrap when the hostname has
// none (WP3.31, owner decision D35), with the installer's `cf` login. Pure apart from the
// AccessApi port, which cloud.ts implements with cf and the tests with a fake Cloudflare.
//
// What it does, in order:
//   1. reads the Zero Trust organization's team domain; an account without an organization is
//      told the one step that makes one (a plan choice, with a payment method even for the Free
//      plan, so a person's), and nothing else happens;
//   2. resolves a create an earlier run started and never saw answered: an application carrying
//      that create's name (the web Worker's name and a fresh nonce) is adopted; if none is
//      listed, it waits out the settle time from the create's start once, then creates anew;
//   3. checks the application it created, read by its recorded ID, and that no other covers the
//      hostname. One a person deleted is created again (the web Worker is not deployed yet);
//   4. with nothing recorded: one application someone else made on the hostname is used as it
//      is if it is owner-only, and otherwise refused with what differs and how to fix it. It is
//      never changed, deleted or recorded as the bootstrap's;
//   5. with none at all: creates the owner-only application (access.ts, ownerOnlyAppBody) with
//      the owner's address given to this run and matched against the plan's pin, records its
//      ID, reads it back and checks it as in 3. The login method is the account's own when it
//      has one (all of them when it has several); with none, it adds the one-time PIN login
//      method, which Access offers on every plan.
//
// Persist before effect: the journal records each create's intent (its name, the time it was
// sent) before the request, and its ID after the answer. A refusal (403) is an answer: the
// intent is cleared and the person gets the dashboard step in one sentence. Nothing here ever
// updates or deletes an application, or touches a policy, a service token or another
// application; removal (remove.ts) deletes only the application the journal records.

import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import {
  coversHostname,
  describeProblems,
  ownerOnlyAppBody,
  ownerOnlyProblems,
  pinCheck,
  ZERO_TRUST_DASHBOARD,
} from "./access.ts";
import type { AccessSettings, Installation } from "./settings.ts";

/** One of the account's Access login methods. */
export interface IdentityProvider {
  readonly id: string;
  readonly type: string;
}

/** What the bootstrap needs of Access. cloud.ts implements it with cf. */
export interface AccessApi {
  /** The Zero Trust organization's team domain, or undefined when the account has none. */
  teamDomain(): string | undefined;
  /** The Access applications Cloudflare lists for the hostname, as listed. */
  appsOn(hostname: string): unknown[];
  /** One application by its ID, or undefined when it does not exist. */
  app(id: string): unknown;
  /** Creates an application and returns its ID. A refusal (403) is AccessUnavailable. */
  create(body: Record<string, unknown>): string;
  /** The account's login methods. A refusal (403) is AccessUnavailable. */
  identityProviders(): IdentityProvider[];
  /** Adds the one-time PIN login method and returns its ID. 403: AccessUnavailable. */
  createOneTimePin(): string;
  /** Deletes an application (removal only). A refusal (403) is AccessUnavailable. */
  remove(id: string): "deleted" | "absent";
}

/** Cloudflare refused (HTTP 403): the installer's login may not do this with Access. */
export class AccessUnavailable extends Error {}

/** A deliberate stop: the person acts, then runs again. machine.ts makes it a refusal. */
export class AccessRefusal extends Error {}

/** The journal's record of the application the bootstrap created. No address. */
export interface RecordedAccessApp {
  /** Its name, which carries the create's nonce: `<web Worker>--<nonce>`. */
  readonly name: string;
  /** Written before the create, so that a run that stops before its answer is recognised. */
  readonly createStartedAt?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

/** The journal's record of the one-time PIN login method, when the bootstrap added it. */
export interface RecordedLoginMethod {
  readonly createStartedAt?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

export interface AccessRecords {
  readonly app?: RecordedAccessApp;
  readonly loginMethod?: RecordedLoginMethod;
}

export interface EnsureAccessContext {
  readonly api: AccessApi;
  readonly plan: Installation;
  /** The owner's address, given to this run; needed only to create the application. */
  readonly ownerEmail?: string | undefined;
  readonly recorded: () => AccessRecords;
  /** Replaces both records whole (undefined removes one), before the step that follows. */
  readonly record: (records: AccessRecords) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** A fresh create nonce: lower-case hex. */
  readonly nonce: () => string;
  readonly log: (message: string) => void;
}

/**
 * How long a create whose answer never came may still take effect: the staging tool's settle
 * time (Cloudflare's proxy gives up on a response after 100 seconds; three times that).
 */
export const ACCESS_SETTLE_MS = 300_000;

const iso = (ms: number) => new Date(ms).toISOString();

export function noOrganizationStep(): string {
  return `your Cloudflare account has no Zero Trust organization yet, which puts Access in front of Omnigent: open ${ZERO_TRUST_DASHBOARD}, choose a team name and the Free plan (Cloudflare asks for a payment method even for the Free plan), then run again`;
}

/** The dashboard step for a login that may not create Access applications, in one sentence. */
export function manualAccessStep(hostname: string): string {
  return `In ${ZERO_TRUST_DASHBOARD}, open Access, Applications, add a self-hosted application for ${hostname} with one Allow policy whose only rule is Emails with the owner's address, set its cookie's Same Site Attribute to Lax under Settings, and save it; then run again, and the bootstrap checks it.`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function field(app: unknown, key: string): string | undefined {
  const value = record(app)?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function quoted(apps: readonly unknown[]): string {
  return apps.map((a) => `"${field(a, "name") ?? "unnamed"}"`).join(", ");
}

/**
 * The hostname's owner-only Access application, created when missing, and checked: its team
 * domain and AUD, for ingress. Throws AccessRefusal for what a person must do.
 */
export async function ensureOwnerAccess(ctx: EnsureAccessContext): Promise<AccessSettings> {
  const { api, plan } = ctx;
  const host = plan.hostname;
  const pin = parseOwnerPin(plan.ownerPin);
  if (pin === undefined) throw new Error("the plan's owner pin is malformed");
  const teamDomain = api.teamDomain();
  if (teamDomain === undefined) throw new AccessRefusal(noOrganizationStep());
  const covering = () => api.appsOn(host).filter((app) => coversHostname(app, host));
  const setApp = (app: RecordedAccessApp | undefined) => {
    const { loginMethod } = ctx.recorded();
    ctx.record({
      ...(app === undefined ? {} : { app }),
      ...(loginMethod === undefined ? {} : { loginMethod }),
    });
  };
  const settings = (app: unknown): AccessSettings => ({
    teamDomain,
    aud: String(field(app, "aud")),
  });

  // An application this installation created: owner-only, and the only one on the hostname.
  const checkOurs = async (app: unknown, recorded: RecordedAccessApp & { id: string }) => {
    const problems = ownerOnlyProblems(app, await pinCheck(app, host, plan.ownerPin));
    if (problems.length > 0) {
      throw new AccessRefusal(
        describeProblems(
          `the Access application "${recorded.name}" on ${host}, which this installation created,`,
          problems,
          true,
        ),
      );
    }
    const others = covering().filter((a) => field(a, "id") !== recorded.id);
    if (others.length > 0) {
      throw new AccessRefusal(
        `besides this installation's Access application "${recorded.name}", ${others.length === 1 ? "another covers" : `${others.length} others cover`} ${host} (${quoted(others)}) and could decide instead of it: delete ${others.length === 1 ? "it" : "them"} in ${ZERO_TRUST_DASHBOARD}, Access, Applications, then run again`,
      );
    }
    return settings(app);
  };

  // 1. A create an earlier run started and never saw answered.
  let recorded = ctx.recorded().app;
  if (recorded !== undefined && recorded.id === undefined) {
    const intent = recorded;
    const made = () => covering().filter((a) => field(a, "name") === intent.name);
    let found = made();
    const started = Date.parse(intent.createStartedAt ?? "");
    const wait = Number.isFinite(started) ? started + ACCESS_SETTLE_MS - ctx.now() : 0;
    if (found.length === 0 && wait > 0) {
      ctx.log(
        `an interrupted run may still create the Access application "${intent.name}"; checking again in ${Math.ceil(wait / 1000)}s`,
      );
      await ctx.sleep(wait);
      found = made();
    }
    const [only] = found;
    if (found.length > 1) {
      throw new AccessRefusal(
        `${found.length} Access applications on ${host} are named "${intent.name}", which only one create of this installation used: delete all but one in ${ZERO_TRUST_DASHBOARD}, Access, Applications, then run again`,
      );
    }
    const id = field(only, "id");
    if (id !== undefined) {
      recorded = { name: intent.name, id, createdAt: iso(ctx.now()) };
      setApp(recorded);
      ctx.log(
        `the Access application "${intent.name}", created by an interrupted run, is recorded now`,
      );
    } else {
      recorded = undefined;
      setApp(undefined);
      ctx.log(`an interrupted run's Access application "${intent.name}" never appeared`);
    }
  }

  // 2. The application this installation created, read by its ID.
  if (recorded?.id !== undefined) {
    const app = api.app(recorded.id);
    if (app !== undefined) return checkOurs(app, { ...recorded, id: recorded.id });
    ctx.log(
      `the Access application "${recorded.name}" that this installation created is gone; creating it again`,
    );
    setApp(undefined);
  }

  // 3. Nothing of this installation's: someone else's application, used only as it is.
  const listed = covering();
  if (listed.length > 1) {
    throw new AccessRefusal(
      `${listed.length} Access applications cover ${host} (${quoted(listed)}), which the bootstrap did not create: keep exactly one, owner-only, or delete them all and run again, and the bootstrap creates it (${ZERO_TRUST_DASHBOARD}, Access, Applications)`,
    );
  }
  const [theirs] = listed;
  if (theirs !== undefined) {
    const problems = ownerOnlyProblems(theirs, await pinCheck(theirs, host, plan.ownerPin));
    if (problems.length > 0) {
      throw new AccessRefusal(
        describeProblems(
          `the Access application ${quoted([theirs])} on ${host}, which the bootstrap did not create,`,
          problems,
          true,
        ),
      );
    }
    ctx.log(
      `using the owner-only Access application ${quoted([theirs])} already on ${host}; the bootstrap did not create it and leaves it alone`,
    );
    return settings(theirs);
  }

  // 4. None: create it, with the owner's address, which the plan does not keep.
  const email = ctx.ownerEmail?.trim().toLowerCase();
  if (email === undefined || email === "") {
    throw new AccessRefusal(
      `${host} has no Access application yet; the bootstrap creates it with the owner's address, which the plan does not keep: run again with --owner-email <the owner's address>`,
    );
  }
  if (!(await pin.matches(email))) {
    throw new AccessRefusal(
      "the address given with --owner-email is not the owner this installation was planned for",
    );
  }
  const identityProviderId = await loginMethod(ctx);
  const name = `${plan.webWorker}--${ctx.nonce()}`;
  setApp({ name, createStartedAt: iso(ctx.now()) });
  let id: string;
  try {
    id = api.create(
      ownerOnlyAppBody({ name, hostname: host, ownerEmail: email, identityProviderId }),
    );
  } catch (error) {
    // A refusal is an answer: nothing was made. Anything else may still land.
    if (!(error instanceof AccessUnavailable)) throw error;
    setApp(undefined);
    throw new AccessRefusal(
      `your cf login may not create Access applications (Cloudflare answered 403 Forbidden). ${manualAccessStep(host)}`,
    );
  }
  const created = { name, id, createdAt: iso(ctx.now()) };
  setApp(created);
  ctx.log(
    `created the owner-only Access application "${name}" on ${host}: the owner's address only, SameSite=lax`,
  );
  // What Access holds now, not what was sent, decides.
  const app = api.app(id);
  if (app === undefined) {
    throw new Error(`the Access application "${name}" is not there after its create; run again`);
  }
  return checkOurs(app, created);
}

/**
 * The login method the new application offers: the account's one, or all of its several, or,
 * with none, the one-time PIN method the bootstrap adds (Access emails the owner a code).
 */
async function loginMethod(ctx: EnsureAccessContext): Promise<string | undefined> {
  let methods: IdentityProvider[];
  try {
    methods = ctx.api.identityProviders();
  } catch (error) {
    if (!(error instanceof AccessUnavailable)) throw error;
    ctx.log("could not read the account's login methods (403); the application offers all of them");
    return undefined;
  }
  const { app, loginMethod: earlier } = ctx.recorded();
  const write = (loginMethod: RecordedLoginMethod | undefined) =>
    ctx.record({
      ...(app === undefined ? {} : { app }),
      ...(loginMethod === undefined ? {} : { loginMethod }),
    });
  const [only] = methods;
  if (methods.length === 1 && only !== undefined) {
    // An add an earlier run started and never saw answered, which landed.
    if (earlier !== undefined && earlier.id === undefined && only.type === "onetimepin") {
      write({ id: only.id, createdAt: iso(ctx.now()) });
    }
    return only.id;
  }
  if (methods.length > 1) {
    ctx.log(`the application offers the account's ${methods.length} login methods`);
    return undefined;
  }
  write({ createStartedAt: iso(ctx.now()) });
  let id: string;
  try {
    id = ctx.api.createOneTimePin();
  } catch (error) {
    if (!(error instanceof AccessUnavailable)) throw error;
    write(undefined);
    throw new AccessRefusal(
      `your Zero Trust organization has no login method, and your cf login may not add one (403): open ${ZERO_TRUST_DASHBOARD}, Settings, Authentication, add One-time PIN, then run again`,
    );
  }
  write({ id, createdAt: iso(ctx.now()) });
  ctx.log("added the one-time PIN login method: Access emails the owner a code to sign in");
  return id;
}
