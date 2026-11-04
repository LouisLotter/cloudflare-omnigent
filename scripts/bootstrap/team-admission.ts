// Teams behind Access (WP8.3, D50): what the installer sets up so that Omnigent's team page can
// change who Access admits without an installer run. Pure apart from the ports: AccessGroupsApi
// (cloud.ts implements it with cf, the tests with a fake Cloudflare) and r2-token.ts's TokenApi.
//
//   - **The member group.** One Access group per installation, `<web Worker>--members--<nonce>`,
//     created with the owner's address only, its create's intent journaled first so that an
//     interrupted run adopts it rather than making a second. The installer owns the group (its
//     existence, its name, its ID in the journal); after the create it never rewrites the
//     group's addresses: those belong to the team page (the platform Worker's reconciler,
//     `worker/src/server/access-admission.ts`).
//   - **The installation's application** allows that group (`memberPolicy`) in place of the
//     owner's address. The owner-only check accepts exactly this rule for the recorded group
//     (access.ts, `memberGroupId`), and nothing wider.
//   - **The reconciler's token.** One account API token with "Access: Organizations, Identity
//     Providers, and Groups Write", made by the installer's own login as the replica's token is
//     (r2-token.ts): its value goes straight into the platform Worker's secret
//     `CFO_ACCESS_GROUP_TOKEN` and nowhere else. Cloudflare cannot narrow this permission to one
//     group; it also covers the account's other Access groups, its organization settings and
//     its login methods. The reconciler limits itself (it can only read and write the recorded
//     group's URL), and the token lives only in the platform Worker: never in the server
//     container, the web Worker or a computer. docs/secrets.md records the scope and why.
//
// Enabling all of it (`bootstrap.ts update --team-admission members`) waits for an Omnigent pin
// with the team model (WP8.11): until then the update refuses and changes nothing.

import { parseOwnerPin } from "../../worker/src/ingress/owner.ts";
import { ACCESS_SETTLE_MS, AccessUnavailable } from "./access-app.ts";
import type { TokenApi, TokenRequest } from "./r2-token.ts";
import type { Installation } from "./settings.ts";

/**
 * Whether the pinned Omnigent can be moved behind Access (WP8.11): the team model, and the
 * binding-state report and lenient bind mode the move checks with. The pin (`cfo/teams`
 * `922b69c62`) carries both; a pin without them sets this false, and the move refuses.
 */
export const TEAM_ADMISSION_SUPPORTED: boolean = true;
/** The permission group the reconciler's token holds (Cloudflare's account permissions). */
export const ACCESS_GROUPS_WRITE_GROUP =
  "Access: Organizations, Identity Providers, and Groups Write";
/** The scope of account-level permission groups and resources. */
export const ACCOUNT_SCOPE = "com.cloudflare.api.account";
/** The name of the application's policy that allows the member group. */
export const MEMBER_POLICY_NAME = "Allow team members";

/** What the installer needs of Access groups. cloud.ts implements it with cf. */
export interface AccessGroupsApi {
  /** Every Access group in the account, as listed. */
  groups(): unknown[];
  /** One group by its ID, or undefined when it does not exist. */
  group(id: string): unknown;
  /** Creates a group and returns its ID. A refusal (403) is AccessUnavailable. */
  createGroup(body: Record<string, unknown>): string;
}

/** The journal's record of the member group. No address. */
export interface RecordedMemberGroup {
  readonly name: string;
  readonly createStartedAt?: string;
  readonly id?: string;
  readonly createdAt?: string;
}

export interface MemberGroupContext {
  readonly api: AccessGroupsApi;
  readonly plan: Installation;
  /** The owner's address, given to this run; checked against the plan's pin. */
  readonly ownerEmail: string;
  readonly recorded: () => RecordedMemberGroup | undefined;
  readonly record: (group: RecordedMemberGroup | undefined) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nonce: () => string;
  readonly log: (message: string) => void;
}

/** Refused, with the one thing a person can do. */
export class TeamAdmissionRefusal extends Error {}

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

/** The refusal while the pinned Omnigent has no team model. */
export function teamAdmissionRefusal(): string {
  return "team admission waits for an Omnigent pin that reports the team's binding state and binds leniently (WP8.11's fork part, omnigent.server.team_status): until the installation's pin carries it, Access keeps admitting the owner only, and this update changes nothing";
}

/** The member group's name for this installation and create. */
export function memberGroupName(plan: Installation, nonce: string): string {
  return `${plan.webWorker}--members--${nonce}`;
}

/** The body that creates the member group: the owner's address, nothing else. */
export function memberGroupBody(name: string, ownerEmail: string): Record<string, unknown> {
  return { name, include: [{ email: { email: ownerEmail } }] };
}

/** The application policy that allows the member group, in place of the owner's address. */
export function memberPolicy(groupId: string): Record<string, unknown> {
  return { name: MEMBER_POLICY_NAME, decision: "allow", include: [{ group: { id: groupId } }] };
}

/**
 * Whether a group holds only single-address rules and, just after its create, the owner's among
 * them. Later the team page keeps its addresses: the founding owner may have left or been
 * suspended, and the reconciler checks the team's current owners instead.
 */
async function memberGroupProblems(
  group: unknown,
  ownerPin: string,
  requireOwner: boolean,
): Promise<string[]> {
  const pin = parseOwnerPin(ownerPin);
  if (pin === undefined) throw new Error("the plan's owner pin is malformed");
  const include = record(group)?.include;
  const rules = Array.isArray(include) ? include : [];
  const problems: string[] = [];
  let owner = false;
  for (const rule of rules) {
    const email = record(record(rule)?.email)?.email;
    if (Object.keys(record(rule) ?? {}).length !== 1 || typeof email !== "string") {
      problems.push("admits something other than single email addresses");
    } else if (await pin.matches(email)) {
      owner = true;
    }
  }
  if (requireOwner && !owner) problems.push("does not admit the owner");
  return [...new Set(problems)];
}

/**
 * The installation's member group: the recorded one, checked; or an interrupted create's,
 * adopted; or a new one with the owner's address. Returns its ID.
 */
export async function ensureMemberGroup(ctx: MemberGroupContext): Promise<string> {
  const { api, plan } = ctx;
  const pin = parseOwnerPin(plan.ownerPin);
  const email = ctx.ownerEmail.trim().toLowerCase();
  if (pin === undefined || !(await pin.matches(email))) {
    throw new TeamAdmissionRefusal(
      "the address given with --owner-email is not the owner this installation was planned for",
    );
  }
  const check = async (group: unknown, name: string, created = false): Promise<void> => {
    const problems = await memberGroupProblems(group, plan.ownerPin, created);
    if (problems.length > 0) {
      throw new TeamAdmissionRefusal(
        `the Access group "${name}", this installation's member group, ${problems.join(" and ")}: the bootstrap never rewrites its addresses, which the team page keeps; fix it in https://one.dash.cloudflare.com/, Access, Groups, then run again`,
      );
    }
  };

  let recorded = ctx.recorded();
  if (recorded !== undefined && recorded.id === undefined) {
    const intent = recorded;
    const named = () => api.groups().filter((g) => text(g, "name") === intent.name);
    let found = named();
    const started = Date.parse(intent.createStartedAt ?? "");
    const wait = Number.isFinite(started) ? started + ACCESS_SETTLE_MS - ctx.now() : 0;
    if (found.length === 0 && wait > 0) {
      ctx.log(`an interrupted run may still create the member group; checking again shortly`);
      await ctx.sleep(wait);
      found = named();
    }
    if (found.length > 1) {
      throw new TeamAdmissionRefusal(
        `${found.length} Access groups are named "${intent.name}", which only one create of this installation used: delete all but one, then run again`,
      );
    }
    const id = text(found[0], "id");
    recorded = id === undefined ? undefined : { name: intent.name, id, createdAt: iso(ctx.now()) };
    ctx.record(recorded);
  }
  if (recorded?.id !== undefined) {
    const group = api.group(recorded.id);
    if (group !== undefined) {
      await check(group, recorded.name);
      return recorded.id;
    }
    ctx.log(`the member group "${recorded.name}" is gone; creating it again`);
    ctx.record(undefined);
  }
  const name = memberGroupName(plan, ctx.nonce());
  ctx.record({ name, createStartedAt: iso(ctx.now()) });
  let id: string;
  try {
    id = api.createGroup(memberGroupBody(name, email));
  } catch (error) {
    if (!(error instanceof AccessUnavailable)) throw error;
    ctx.record(undefined);
    throw new TeamAdmissionRefusal(
      "your cf login may not create Access groups (Cloudflare answered 403 Forbidden): sign in again with a login that may, then run again",
    );
  }
  ctx.record({ name, id, createdAt: iso(ctx.now()) });
  const created = api.group(id);
  if (created === undefined)
    throw new Error(`the Access group "${name}" is not there after its create`);
  await check(created, name, true);
  ctx.log(`created the member group "${name}" with the owner's address`);
  return id;
}

/** The reconciler token's name: the installation's, and the UTC second of its create. */
export function admissionTokenName(plan: Installation, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${plan.platformWorker}-access--${plan.installationId}--${stamp}`;
}

/** The reconciler's token: groups-write on the installation's account, nothing else. */
export function admissionTokenRequest(
  plan: Installation,
  permissionGroupId: string,
  now: number,
): TokenRequest {
  return {
    name: admissionTokenName(plan, now),
    policies: [
      {
        effect: "allow",
        permission_groups: [{ id: permissionGroupId }],
        resources: { [`${ACCOUNT_SCOPE}.${plan.accountId}`]: "*" },
      },
    ],
  };
}

/**
 * A new reconciler token: its ID (journaled by the caller before the deploy) and its value, which
 * exists only in this process until the deploy sets it as the platform Worker's secret.
 */
export function makeAdmissionToken(
  api: TokenApi,
  plan: Installation,
  now: number,
): { readonly name: string; readonly id: string; readonly value: string } {
  const group = api.permissionGroup(ACCESS_GROUPS_WRITE_GROUP, ACCOUNT_SCOPE);
  const request = admissionTokenRequest(plan, group, now);
  const created = api.create(request);
  return { name: request.name, id: created.id, value: created.value };
}

/**
 * The settings `update --team-admission members` deploys (WP8.11, team-move.ts): the web Worker
 * admits whoever Access admits, the platform Worker signs identity envelopes and reconciles the
 * member group, and the server pushes its admission list. The server's identity mode (`bind`,
 * then `required`) is a secret, changed on its own without a deploy.
 */
export function teamAdmissionVars(
  plan: Pick<Installation, "accountId">,
  groupId: string,
): {
  readonly web: Readonly<Record<string, string>>;
  readonly platform: Readonly<Record<string, string>>;
} {
  return {
    web: { TEAM_ADMISSION: "members" },
    platform: {
      CFO_IDENTITY_ENVELOPE: "on",
      CFO_ACCESS_ACCOUNT_ID: plan.accountId,
      CFO_ACCESS_GROUP_ID: groupId,
      SERVER_ENV_CFO_ACCESS_ADMISSION: "true",
    },
  };
}
