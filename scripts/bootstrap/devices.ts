// `bootstrap.ts devices` (WP3.43, owner decisions D47 and D48): the owner's personal machines
// reach the installation through the Cloudflare One Client (formerly WARP), signed in as the
// owner, and run Omnigent's host there. Pure apart from the DevicesApi port, which cloud.ts
// implements with the installer's `cf` login and the tests with a fake Cloudflare.
//
// Four settings, each read first and changed only when it differs. The organization's (2) is
// changed before the application's (1): Cloudflare refuses an application's switch until the
// organization has a client session ([12130]).
//   1. the installation's Access application lets a device signed in to the client in as the
//      owner ("Authenticate with Cloudflare One Client", `allow_authenticate_via_warp`). Only
//      this application: never the organization's default for every application, never another
//      application. Only the application the bootstrap created is changed; one someone else made
//      is used when it already allows it, and otherwise the person gets the one dashboard step;
//   2. the Zero Trust organization's client session (`warp_auth_session_duration`, 30 days by
//      default, at most 90) and `warp_auth_non_browser_401`, so that a host or a command-line
//      tool whose client session has lapsed gets a 401 rather than a login page. A duration the
//      organization already has is kept unless one is asked for;
//   3. device enrollment: the account's one Access application of type `warp`, whose policy
//      says who may connect a device. Created owner-only when there is none; the one this step
//      created is put back to owner-only if it changed; one someone else made is used only when
//      it is owner-only, and otherwise refused with what differs;
//   4. the default device profile's split tunnel in include mode: only the installation's
//      hostname and the team's sign-in domain go through the client, which Cloudflare's client
//      sessions need ("Cloudflare Zero Trust domains"); every other route of the device stays
//      as it was. A profile already in include mode keeps its other entries. A profile in
//      exclude mode is switched, and its exclude list is kept in the journal first.
//
// Cloudflare's updates of an organization and of an application replace the whole object
// (PUT): each is read in full, only this step's fields are changed, and the rest is written
// back as read: for an application, minus the fields Cloudflare only reports (IDs, times); for
// the organization, only the fields its update takes. What Cloudflare holds
// afterwards, read back, decides; an organization field the write changed besides this step's is
// reported. The device profile's update is a PATCH of the split tunnel alone.
//
// Persist before effect: the journal records each change's start before it is sent and its end
// after it is read back, and the enrollment application's create intent (its name carries a
// nonce) before the create, so that an interrupted run adopts the application it made rather
// than making a second one. A refusal (403) is an answer: the person gets the dashboard step.

import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import {
  coversHostname,
  describeProblems,
  OWNER_POLICY_NAME,
  ownerOnlyProblems,
  pinCheck,
  ZERO_TRUST_DASHBOARD,
} from "./access.ts";
import {
  ACCESS_SETTLE_MS,
  AccessRefusal,
  AccessUnavailable,
  type IdentityProvider,
  noOrganizationStep,
  type RecordedAccessApp,
} from "./access-app.ts";
import type { Installation } from "./settings.ts";

/** What the devices step needs of Cloudflare. cloud.ts implements it with cf. */
export interface DevicesApi {
  /** The Zero Trust organization's team domain, or undefined when the account has none. */
  teamDomain(): string | undefined;
  /** The organization, in full, as Cloudflare reports it. */
  organization(): Record<string, unknown>;
  /** Replaces the organization (PUT). 403: AccessUnavailable. */
  updateOrganization(body: Record<string, unknown>): void;
  /** Every Access application in the account. */
  apps(): unknown[];
  /** One application by its ID, or undefined when it does not exist. */
  app(id: string): unknown;
  /** Creates an application and returns its ID. 403: AccessUnavailable. */
  createApp(body: Record<string, unknown>): string;
  /** Replaces an application (PUT). 403: AccessUnavailable. */
  updateApp(id: string, body: Record<string, unknown>): void;
  /** The account's login methods. 403: AccessUnavailable. */
  identityProviders(): IdentityProvider[];
  /** The default device settings profile, in full. */
  defaultProfile(): Record<string, unknown>;
  /** Changes the default profile's given fields only (PATCH). 403: AccessUnavailable. */
  updateDefaultProfile(patch: Record<string, unknown>): void;
  /** How many device settings profiles other than the default the account has. */
  customProfiles(): number;
}

/** The enrollment application, when this step created it: its name (with a nonce) and ID. */
export interface RecordedEnrollment {
  readonly name: string;
  readonly createStartedAt?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

/** The split tunnel as it was before this step switched it to include mode. */
export interface PreviousSplitTunnel {
  readonly mode: "exclude";
  readonly entries: readonly unknown[];
  readonly savedAt: string;
}

/** The journal's record of the devices step. Names, IDs and times; never an address. */
export interface DevicesRecord {
  readonly enrollment?: RecordedEnrollment;
  readonly previousSplitTunnel?: PreviousSplitTunnel;
  /** Each change's start, written before it is sent, and its end, once read back. */
  readonly appStartedAt?: string;
  readonly appChangedAt?: string;
  readonly organizationStartedAt?: string;
  readonly organizationChangedAt?: string;
  readonly enrollmentStartedAt?: string;
  readonly enrollmentChangedAt?: string;
  readonly splitTunnelStartedAt?: string;
  readonly splitTunnelChangedAt?: string;
  /** The client session this step last set or found, e.g. `720h`. */
  readonly sessionDuration?: string;
  /** When a run last found all four settings in place. */
  readonly checkedAt?: string;
}

export interface DevicesContext {
  readonly api: DevicesApi;
  readonly plan: Installation;
  /** The Access application the bootstrap created for the hostname, from the journal. */
  readonly accessApp?: RecordedAccessApp | undefined;
  /** The owner's address, given to this run; needed only to write the enrollment policy. */
  readonly ownerEmail?: string | undefined;
  /**
   * The client session asked for, as given (`30d`, `12h`, `15m`, `2h45m`; at most 90 days);
   * undefined keeps one already set.
   */
  readonly session?: string | undefined;
  readonly recorded: () => DevicesRecord;
  /** Replaces the record whole, before the step that follows. */
  readonly record: (record: DevicesRecord) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** A fresh create nonce: lower-case hex. */
  readonly nonce: () => string;
  readonly log: (message: string) => void;
}

export interface DevicesOutcome {
  readonly teamDomain: string;
  /** The team name the client is registered with: the team domain's first label. */
  readonly team: string;
  readonly sessionDuration: string;
  /** What this run changed, in words; empty when everything was in place. */
  readonly changed: readonly string[];
}

export const DEFAULT_SESSION = "30d";
/** Cloudflare's longest client session: 90 days, in minutes. */
export const MAX_SESSION_MINUTES = 90 * 24 * 60;
export const ENROLLMENT_TYPE = "warp";

/** The organization's fields Cloudflare reports but an update does not take. */
const ORGANIZATION_REPORTED = ["created_at", "updated_at"] as const;
/**
 * The organization's fields its update takes (`cf schema zero-trust organization update`, cf
 * 1.0.0-beta.18). The read also reports others (`trusted_accounts`, `has_migrated_private_apps`,
 * `cache_device_posture`), which are not sent; the read back still checks that none moved.
 */
const ORGANIZATION_WRITABLE = [
  "allow_authenticate_via_warp",
  "auth_domain",
  "auto_redirect_to_identity",
  "custom_pages",
  "deny_unmatched_requests",
  "deny_unmatched_requests_exempted_zone_names",
  "disable_end_user_app_creation",
  "is_ui_read_only",
  "login_design",
  "mfa_config",
  "mfa_piv_key_requirements",
  "mfa_required_for_all_apps",
  "name",
  "service_token_inactivity",
  "session_duration",
  "strict_service_token_auth",
  "ui_read_only_toggle_reason",
  "user_seat_expiration_inactive_time",
  "warp_auth_non_browser_401",
  "warp_auth_session_duration",
] as const;
/** An application's fields Cloudflare reports but an update does not take. */
const APP_REPORTED = ["id", "aud", "uid", "created_at", "updated_at"] as const;
/** An inline policy's fields Cloudflare reports but an update does not take. */
const POLICY_REPORTED = ["uid", "created_at", "updated_at", "reusable", "app_count"] as const;

const iso = (ms: number) => new Date(ms).toISOString();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, key: string): string | undefined {
  const v = record(value)?.[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Whether a service-token inactivity setting has all three of its fields. */
function complete(setting: unknown): boolean {
  const value = record(setting);
  return (
    value !== undefined &&
    ["enabled", "inactivity_threshold_days", "action"].every(
      (key) => value[key] !== null && value[key] !== undefined,
    )
  );
}

/** A copy of `value` with only `keys`, those it has. */
function only(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) if (key in value) copy[key] = structuredClone(value[key]);
  return copy;
}

function without(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = structuredClone(value);
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * A duration in whole minutes, from Cloudflare's form (`720h`, `2h45m`, `30m`, and Go's
 * `720h0m0s`) or a number of days (`30d`); undefined when it is neither, or not whole minutes.
 */
export function durationMinutes(value: string): number | undefined {
  const days = /^([0-9]{1,3})d$/.exec(value.trim());
  if (days !== null) return Number(days[1]) * 24 * 60;
  const parts = /^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$/.exec(value.trim());
  if (parts === null || parts.slice(1).every((p) => p === undefined)) return undefined;
  const seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  return seconds % 60 === 0 ? seconds / 60 : undefined;
}

/** Minutes as Cloudflare writes a session duration: `720h`, `2h45m`, `15m`. */
export function cloudflareDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours > 0 ? `${hours}h` : ""}${rest > 0 || hours === 0 ? `${rest}m` : ""}`;
}

/** The client session asked for, as Cloudflare writes it; at least a minute, at most 90 days. */
export function sessionDuration(value: string): string {
  const minutes = durationMinutes(value);
  if (minutes === undefined || minutes < 1 || minutes > MAX_SESSION_MINUTES) {
    throw new Error(
      `the client session is a duration such as 30d, 12h or 15m, at most 90 days: not "${value}"`,
    );
  }
  return cloudflareDuration(minutes);
}

/**
 * An application as an update takes it: everything Cloudflare reported, minus what it only
 * reports. An inline policy is written back whole, by its ID; a reusable one as its link.
 */
export function writableApp(app: Record<string, unknown>): Record<string, unknown> {
  const body = without(app, APP_REPORTED);
  if (Array.isArray(body.policies)) {
    body.policies = body.policies.map((policy: unknown) => {
      const p = record(policy);
      if (p === undefined) return policy;
      if (p.reusable === true && typeof p.id === "string") {
        return { id: p.id, ...(p.precedence === undefined ? {} : { precedence: p.precedence }) };
      }
      return without(p, POLICY_REPORTED);
    });
  }
  return body;
}

/** The one owner-only Allow policy, inline. */
function ownerPolicy(email: string): Record<string, unknown> {
  return { name: OWNER_POLICY_NAME, decision: "allow", include: [{ email: { email } }] };
}

/** A split tunnel route's host, if it is a domain route. */
function routeHost(route: unknown): string | undefined {
  return text(route, "host")?.toLowerCase();
}

/** The dashboard step for the installation's application, in one sentence. */
function appStep(host: string): string {
  return `In ${ZERO_TRUST_DASHBOARD}, open Access controls, Applications, edit the application for ${host}, and under Authentication turn on Authenticate with Cloudflare One Client; then run again`;
}

function organizationStep(duration: string): string {
  return `In ${ZERO_TRUST_DASHBOARD}, open Access controls, Access settings, Cloudflare One Client authentication: set the session duration to ${duration} and turn on Return 401 response for non-browser traffic (leave Apply to all Access applications off); then run again`;
}

function splitTunnelStep(host: string, teamDomain: string): string {
  return `In ${ZERO_TRUST_DASHBOARD}, open Team & Resources, Devices, Device profiles, the Default profile, Split Tunnels: choose Include IPs and domains and add the domains ${host} and ${teamDomain}; then run again`;
}

function enrollmentStep(): string {
  return `In ${ZERO_TRUST_DASHBOARD}, open Team & Resources, Devices, Device profiles, Management, Device enrollment permissions: make its only policy Allow with the rule Emails, the owner's address; then run again`;
}

/** Runs `change`, turning Cloudflare's refusal (403) into the dashboard step. */
function refusedAs<T>(step: string, change: () => T): T {
  try {
    return change();
  } catch (error) {
    if (error instanceof AccessUnavailable) {
      throw new AccessRefusal(
        `your cf login may not change this (Cloudflare answered 403 Forbidden). ${step}`,
      );
    }
    throw error;
  }
}

/**
 * The four settings that let the owner's personal machines in through the Cloudflare One
 * Client, each checked and set when it differs. Throws AccessRefusal for what a person must do.
 */
export async function ensureDevices(ctx: DevicesContext): Promise<DevicesOutcome> {
  const { api, plan } = ctx;
  const host = plan.hostname;
  if (plan.target.kind !== "account") {
    throw new AccessRefusal(
      "devices is for an installation in your own account: a staging installation shares the account's Zero Trust settings with the owner's",
    );
  }
  if (parseOwnerPin(plan.ownerPin) === undefined) {
    throw new Error("the plan's owner pin is malformed");
  }
  const asked = ctx.session === undefined ? undefined : sessionDuration(ctx.session);
  const teamDomain = api.teamDomain();
  if (teamDomain === undefined) throw new AccessRefusal(noOrganizationStep());
  const changed: string[] = [];
  const update = (patch: Partial<DevicesRecord>) => ctx.record({ ...ctx.recorded(), ...patch });

  // An address given to this run, matched against the plan's pin: only needed for a policy.
  const ownerAddress = async (why: string): Promise<string> => {
    const email = ctx.ownerEmail?.trim().toLowerCase();
    if (email === undefined || email === "") {
      throw new AccessRefusal(
        `${why}, which needs the owner's address; the plan does not keep it: run again with --owner-email <the owner's address>`,
      );
    }
    const pin = parseOwnerPin(plan.ownerPin);
    if (pin === undefined || !(await pin.matches(email))) {
      throw new AccessRefusal(
        "the address given with --owner-email is not the owner this installation was planned for",
      );
    }
    return email;
  };

  // 1. The installation's application.
  const all = api.apps();
  const recordedId = ctx.accessApp?.id;
  let app: Record<string, unknown> | undefined;
  if (recordedId !== undefined) {
    app = record(api.app(recordedId));
    if (app === undefined) {
      throw new AccessRefusal(
        `the Access application this installation created for ${host} is gone: run bootstrap.ts run, which creates it again, then run devices again`,
      );
    }
  } else {
    const covering = all.filter((a) => coversHostname(a, host));
    if (covering.length !== 1) {
      throw new AccessRefusal(
        `expected exactly one Access application on ${host}, found ${covering.length}: run bootstrap.ts run first`,
      );
    }
    app = record(covering[0]) ?? {};
  }
  const appProblems = ownerOnlyProblems(app, await pinCheck(app, host, plan.ownerPin));
  if (appProblems.length > 0) {
    throw new AccessRefusal(
      describeProblems(`the Access application on ${host}`, appProblems, false),
    );
  }
  if (app.enable_binding_cookie === true) {
    throw new AccessRefusal(
      `the Access application on ${host} uses a binding cookie, which Cloudflare One Client authentication does not work with: in ${ZERO_TRUST_DASHBOARD}, edit it, and under Settings, Cookie settings, turn off Binding Cookie; then run again`,
    );
  }
  // Refused before anything changes, the organization included.
  if (app.allow_authenticate_via_warp !== true && recordedId === undefined) {
    throw new AccessRefusal(
      `the Access application on ${host} was not created by the bootstrap, which never changes one it did not create. ${appStep(host)}`,
    );
  }

  // 2. The organization's client session and its 401 for non-browser clients. Before the
  // application's switch: Cloudflare refuses that switch until the organization has a client
  // session ([12130]).
  const organization = api.organization();
  const current = text(organization, "warp_auth_session_duration");
  const read = current === undefined ? undefined : durationMinutes(current);
  // A session this step would not set (none, or over 90 days) is not kept either (Codex r2).
  const currentMinutes =
    read !== undefined && read >= 1 && read <= MAX_SESSION_MINUTES ? read : undefined;
  if (current !== undefined && currentMinutes === undefined && asked === undefined) {
    throw new Error(
      `the organization's Cloudflare One Client session is "${current}", which this step does not keep (it reads 1 minute to 90 days): give one with --client-session (for example 30d)`,
    );
  }
  const duration =
    asked ??
    (currentMinutes === undefined
      ? sessionDuration(DEFAULT_SESSION)
      : cloudflareDuration(currentMinutes));
  if (asked === undefined && current !== undefined) {
    ctx.log(`keeping the organization's Cloudflare One Client session of ${duration}`);
  }
  const minutes = durationMinutes(duration);
  if (organization.allow_authenticate_via_warp === true) {
    ctx.log(
      "the Zero Trust organization lets every Access application use the Cloudflare One Client session (Apply to all Access applications); this step does not change that",
    );
  }
  if (read !== minutes || organization.warp_auth_non_browser_401 !== true) {
    const body: Record<string, unknown> = {
      ...only(organization, ORGANIZATION_WRITABLE),
      warp_auth_session_duration: duration,
      warp_auth_non_browser_401: true,
    };
    // Never set, it reads back with nulls, which the update refuses ([12062] "service_token_inactivity
    // must include enabled, inactivity_threshold_days, and action"). Left out, it stays as it is.
    if (!complete(body.service_token_inactivity)) delete body.service_token_inactivity;
    update({ organizationStartedAt: iso(ctx.now()) });
    refusedAs(organizationStep(duration), () => api.updateOrganization(body));
    const after = api.organization();
    if (
      durationMinutes(text(after, "warp_auth_session_duration") ?? "") !== minutes ||
      after.warp_auth_non_browser_401 !== true
    ) {
      throw new Error(
        "Cloudflare did not keep the organization's Cloudflare One Client session settings; run again",
      );
    }
    const ours = new Set<string>([
      ...ORGANIZATION_REPORTED,
      "warp_auth_session_duration",
      "warp_auth_non_browser_401",
    ]);
    const moved = Object.keys(organization)
      .filter((key) => !ours.has(key))
      .filter((key) => JSON.stringify(after[key]) !== JSON.stringify(organization[key]));
    update({ organizationChangedAt: iso(ctx.now()), sessionDuration: duration });
    if (moved.length > 0) {
      throw new Error(
        `the organization's update also changed ${moved.join(", ")}, which this step does not set: check them in ${ZERO_TRUST_DASHBOARD}, Access controls, Access settings`,
      );
    }
    changed.push(
      `Cloudflare One Client sessions last ${duration}, and a lapsed one answers command-line tools with 401`,
    );
  } else {
    update({ sessionDuration: duration });
  }

  // 1, continued: the application's switch.
  const aud = text(app, "aud");
  if (app.allow_authenticate_via_warp !== true && recordedId !== undefined) {
    update({ appStartedAt: iso(ctx.now()) });
    refusedAs(appStep(host), () =>
      api.updateApp(recordedId, { ...writableApp(app), allow_authenticate_via_warp: true }),
    );
    const after = record(api.app(recordedId));
    if (after?.allow_authenticate_via_warp !== true) {
      throw new Error(
        `Cloudflare did not keep Authenticate with Cloudflare One Client on the application for ${host}; run again`,
      );
    }
    if (text(after, "aud") !== aud) {
      throw new Error(
        `the application for ${host} has another AUD tag after its update, which ingress does not accept: run bootstrap.ts update to deploy it`,
      );
    }
    const problems = ownerOnlyProblems(after, await pinCheck(after, host, plan.ownerPin));
    if (problems.length > 0) {
      throw new AccessRefusal(
        describeProblems(`after its update, the Access application on ${host}`, problems, true),
      );
    }
    update({ appChangedAt: iso(ctx.now()) });
    changed.push(`the Access application for ${host} now lets the owner's enrolled devices in`);
  }

  // 3. Device enrollment: only the owner may connect a device.
  await ensureEnrollment(ctx, app, changed, ownerAddress, update);

  // 4. The default profile's split tunnel: the hostname and the sign-in domain, in include mode.
  ensureSplitTunnel(ctx, teamDomain, changed, update);

  // Login methods other than the one-time PIN sign in on another site, which the split tunnel
  // would have to include too (Cloudflare: "The IdP used to authenticate").
  try {
    const others = [...new Set(api.identityProviders().map((p) => p.type))].filter(
      (type) => type !== "onetimepin",
    );
    if (others.length > 0) {
      ctx.log(
        `the account also signs in with ${others.join(", ")}: if the owner enrolls with ${others.length === 1 ? "it" : "one of them"}, add ${others.length === 1 ? "its" : "that"} sign-in domain to the default profile's split tunnel too (${ZERO_TRUST_DASHBOARD}, Team & Resources, Devices, Device profiles)`,
      );
    }
  } catch (error) {
    if (!(error instanceof AccessUnavailable)) throw error;
  }
  const custom = api.customProfiles();
  if (custom > 0) {
    ctx.log(
      `the account has ${custom} device profile${custom === 1 ? "" : "s"} besides the default: a device ${custom === 1 ? "it matches" : "one of them matches"} does not get this split tunnel`,
    );
  }
  update({ checkedAt: iso(ctx.now()) });
  return {
    teamDomain,
    team: teamDomain.split(".")[0] ?? teamDomain,
    sessionDuration: duration,
    changed,
  };
}

/** Whether an enrollment application lets only the owner enroll; its problems otherwise. */
async function enrollmentProblems(app: unknown, plan: Installation) {
  // Only its rules matter: an enrollment application has no domain, cookie or AUD to check.
  const check = await pinCheck(app, plan.hostname, plan.ownerPin);
  return ownerOnlyProblems(app, check).filter((p) => p.aspect === "rules");
}

async function ensureEnrollment(
  ctx: DevicesContext,
  installationApp: Record<string, unknown>,
  changed: string[],
  ownerAddress: (why: string) => Promise<string>,
  update: (patch: Partial<DevicesRecord>) => void,
): Promise<void> {
  const { api, plan } = ctx;
  const enrollmentApps = () =>
    api.apps().filter((a) => text(a, "type") === ENROLLMENT_TYPE) as Record<string, unknown>[];
  const setEnrollment = (enrollment: RecordedEnrollment | undefined) => {
    const { enrollment: _old, ...rest } = ctx.recorded();
    ctx.record({ ...rest, ...(enrollment === undefined ? {} : { enrollment }) });
  };

  // A create an earlier run started and never saw answered.
  let recorded = ctx.recorded().enrollment;
  if (recorded !== undefined && recorded.id === undefined) {
    const intent = recorded;
    const made = () => enrollmentApps().filter((a) => text(a, "name") === intent.name);
    let found = made();
    const started = Date.parse(intent.createStartedAt ?? "");
    const wait = Number.isFinite(started) ? started + ACCESS_SETTLE_MS - ctx.now() : 0;
    if (found.length === 0 && wait > 0) {
      ctx.log(
        `an interrupted run may still create the device enrollment application "${intent.name}"; checking again in ${Math.ceil(wait / 1000)}s`,
      );
      await ctx.sleep(wait);
      found = made();
    }
    const id = text(found[0], "id");
    if (id !== undefined) {
      recorded = { name: intent.name, id, createdAt: iso(ctx.now()) };
      setEnrollment(recorded);
      ctx.log(
        `the device enrollment application "${intent.name}", created by an interrupted run, is recorded now`,
      );
    } else {
      recorded = undefined;
      setEnrollment(undefined);
    }
  }

  const ownerOnlyBody = (email: string) => ({ policies: [ownerPolicy(email)] });

  // The one this step created, read by its ID.
  if (recorded?.id !== undefined) {
    const app = record(api.app(recorded.id));
    if (app !== undefined) {
      const others = enrollmentApps().filter((a) => text(a, "id") !== recorded?.id);
      if (others.length > 0) {
        throw new AccessRefusal(
          `besides this installation's device enrollment application, the account has ${others.length} more, which Cloudflare allows only one of: delete the others in ${ZERO_TRUST_DASHBOARD}, then run again`,
        );
      }
      if ((await enrollmentProblems(app, plan)).length === 0) return;
      const email = await ownerAddress(
        "the device enrollment application this installation created no longer admits only the owner; this step puts it back",
      );
      const id = recorded.id;
      update({ enrollmentStartedAt: iso(ctx.now()) });
      refusedAs(enrollmentStep(), () =>
        api.updateApp(id, { ...writableApp(app), ...ownerOnlyBody(email) }),
      );
      await checkEnrollment(api.app(id), plan);
      update({ enrollmentChangedAt: iso(ctx.now()) });
      changed.push("device enrollment admits only the owner again");
      return;
    }
    ctx.log(
      "the device enrollment application this installation created is gone; creating it again",
    );
    setEnrollment(undefined);
  }

  // Nothing of this installation's: someone else's, used only as it is.
  const existing = enrollmentApps();
  if (existing.length > 1) {
    throw new AccessRefusal(
      `the account has ${existing.length} device enrollment applications, which Cloudflare allows only one of: keep one, owner-only, in ${ZERO_TRUST_DASHBOARD}, then run again`,
    );
  }
  const [theirs] = existing;
  if (theirs !== undefined) {
    const problems = await enrollmentProblems(theirs, plan);
    if (problems.length > 0) {
      throw new AccessRefusal(
        `device enrollment ${problems.map((p) => p.why).join("; ")}, and the bootstrap did not create it, so it does not change it. ${enrollmentStep()}`,
      );
    }
    ctx.log(
      "device enrollment already admits only the owner; the bootstrap did not create it and leaves it alone",
    );
    return;
  }

  // None: create it, owner-only, with the installation's login method.
  const email = await ownerAddress(
    "the account has no device enrollment permissions yet; this step creates them",
  );
  const name = `${plan.webWorker}-devices--${ctx.nonce()}`;
  const idps = Array.isArray(installationApp.allowed_idps)
    ? (installationApp.allowed_idps as unknown[]).filter((i): i is string => typeof i === "string")
    : [];
  const body: Record<string, unknown> = {
    type: ENROLLMENT_TYPE,
    name,
    ...(idps.length > 0 ? { allowed_idps: idps } : {}),
    ...(idps.length === 1 ? { auto_redirect_to_identity: true } : {}),
    ...ownerOnlyBody(email),
  };
  setEnrollment({ name, createStartedAt: iso(ctx.now()) });
  let id: string;
  try {
    id = api.createApp(body);
  } catch (error) {
    // A refusal is an answer: nothing was made. Anything else may still land.
    if (error instanceof AccessUnavailable) setEnrollment(undefined);
    return refusedAs(enrollmentStep(), () => {
      throw error;
    });
  }
  setEnrollment({ name, id, createdAt: iso(ctx.now()) });
  await checkEnrollment(api.app(id), plan);
  changed.push("only the owner may connect a device to the Zero Trust organization");
}

async function checkEnrollment(app: unknown, plan: Installation): Promise<void> {
  if (record(app) === undefined) {
    throw new Error("the device enrollment application is not there after its write; run again");
  }
  if (text(app, "type") !== ENROLLMENT_TYPE) {
    throw new Error("the device enrollment application Cloudflare holds is not of type warp");
  }
  const problems = await enrollmentProblems(app, plan);
  if (problems.length > 0) {
    throw new AccessRefusal(
      `after its write, device enrollment ${problems.map((p) => p.why).join("; ")}. ${enrollmentStep()}`,
    );
  }
}

function ensureSplitTunnel(
  ctx: DevicesContext,
  teamDomain: string,
  changed: string[],
  update: (patch: Partial<DevicesRecord>) => void,
): void {
  const { api, plan } = ctx;
  const host = plan.hostname.toLowerCase();
  const wanted = [
    { host, description: "Omnigent (cloudflare-omnigent)" },
    {
      host: teamDomain.toLowerCase(),
      description: "Cloudflare Access sign-in (cloudflare-omnigent)",
    },
  ];
  const profile = api.defaultProfile();
  const mode = record(profile.service_mode_v2)?.mode;
  if (mode !== undefined && mode !== "warp") {
    throw new AccessRefusal(
      `the default device profile runs the client in ${String(mode)} mode, in which the split tunnel cannot route a domain: in ${ZERO_TRUST_DASHBOARD}, Team & Resources, Devices, Device profiles, the Default profile, set the Service mode to Traffic and DNS; then run again`,
    );
  }
  const include = Array.isArray(profile.include) ? (profile.include as unknown[]) : [];
  const exclude = Array.isArray(profile.exclude) ? (profile.exclude as unknown[]) : [];
  const included = new Set(include.map(routeHost));
  const missing = wanted.filter((w) => !included.has(w.host));
  // In place only in include mode: the routes there, and no exclude list beside them.
  if (include.length > 0 && exclude.length === 0 && missing.length === 0) return;
  if (exclude.length > 0 && ctx.recorded().previousSplitTunnel === undefined) {
    // Switching modes resets the list: keep the exclude list first, as Cloudflare advises.
    update({ previousSplitTunnel: { mode: "exclude", entries: exclude, savedAt: iso(ctx.now()) } });
  }
  update({ splitTunnelStartedAt: iso(ctx.now()) });
  refusedAs(splitTunnelStep(host, teamDomain), () =>
    api.updateDefaultProfile({ include: [...include, ...missing] }),
  );
  const after = api.defaultProfile();
  const afterInclude = Array.isArray(after.include) ? (after.include as unknown[]) : [];
  const afterExclude = Array.isArray(after.exclude) ? (after.exclude as unknown[]) : [];
  const nowIncluded = new Set(afterInclude.map(routeHost));
  if (afterExclude.length > 0 || !wanted.every((w) => nowIncluded.has(w.host))) {
    throw new Error(
      `the default device profile is not in include mode with ${host} and ${teamDomain} after its update; run again`,
    );
  }
  update({ splitTunnelChangedAt: iso(ctx.now()) });
  changed.push(
    include.length === 0
      ? `the default device profile sends only ${host} and ${teamDomain} through the Cloudflare One Client (it sent everything but its exclusions before; that list is kept in the state file)`
      : `the default device profile also sends ${missing.map((m) => m.host).join(" and ")} through the Cloudflare One Client`,
  );
}

/** The lines `status` shows for the devices step. */
export function devicesStatus(recordValue: DevicesRecord | undefined): string[] {
  if (recordValue === undefined) return ["Personal devices: not set up (bootstrap.ts devices)."];
  const lines = [
    recordValue.checkedAt === undefined
      ? "Personal devices: set up begun, not finished; run bootstrap.ts devices again."
      : `Personal devices: checked at ${recordValue.checkedAt}${recordValue.sessionDuration === undefined ? "" : `, Cloudflare One Client sessions last ${recordValue.sessionDuration}`}.`,
  ];
  if (recordValue.enrollment?.id !== undefined) {
    lines.push(
      `  device enrollment: "${recordValue.enrollment.name}", created by this installation`,
    );
  }
  if (recordValue.previousSplitTunnel !== undefined) {
    lines.push(
      `  the default profile's earlier exclude list (${recordValue.previousSplitTunnel.entries.length} routes) is kept in the state file`,
    );
  }
  return lines;
}

/** What the person does next, once the settings are in place. */
export function devicesNextSteps(plan: Installation, outcome: DevicesOutcome): string[] {
  return [
    `Ready: the owner's devices can reach https://${plan.hostname} through the Cloudflare One Client.`,
    "On each of your machines, once:",
    "  1. install the Cloudflare One Client (on Arch: the AUR package cloudflare-warp-bin; elsewhere https://pkg.cloudflareclient.com/), and start its service: sudo systemctl enable --now warp-svc;",
    `  2. from a checkout of this repository, run: scripts/host/omnigent-host.sh setup --server https://${plan.hostname}`,
    `     It registers the client with your team (${outcome.team}), where you sign in with your email, then signs Omnigent's command line in (your Omnigent username and password), and starts the machine's host.`,
    "Guide: docs/operations/personal-hosts.md.",
  ];
}
