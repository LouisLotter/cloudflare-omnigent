// The installation's R2 credentials, made by the installer's own `cf` login (WP3.25), so that
// nobody copies an R2 token out of the dashboard: one user API token with "Workers R2 Storage
// Bucket Item Write" (read, write and list objects: the dashboard's "Object Read & Write") on
// exactly the installation's buckets, the replica's and the artifacts', and nothing else. R2's
// S3 key pair is the token's ID and the SHA-256 of its value (R2's docs, "Get S3 API credentials
// from an API token"). Pure apart from the TokenApi port, which cloud.ts implements with cf.
//
// The value exists only in this process's memory, from Cloudflare's answer to the deploy that
// sets the key pair as the platform Worker's secrets: never printed, logged, written to disk, or
// put in argv or an environment. The token's ID is the access key ID, which is not secret: the
// journal keeps it, and the name, so that removal can delete it.
//
// What a login may do. `cf`'s OAuth login (1.0.0-beta.18) may create user API tokens and read
// one by its ID, but Cloudflare refuses it (403) to list, roll or delete them: those need the
// "API Tokens Read" or "Write" permission, and cf's OAuth client offers no such scope at sign-in.
// So nothing here depends on listing, rolling or deleting; reading a token by its ID tells
// whether a person has deleted it. A token is made only when the platform Worker lacks
// its key pair; while the Worker holds it, that pair is the installation's credential and no
// token is touched. A token whose value was lost before the Worker got its pair (a deploy that
// failed, a create whose answer never came) is useless and goes on the journal's list of tokens
// to delete; each token has a name of its own (`<platform Worker>-r2--<installation ID>--<UTC
// time of its create>`, with `-2`, `-3` … when a recorded token already has that name), so that
// a person can tell them apart. The bootstrap deletes what
// Cloudflare lets it delete (a login with "API Tokens Write" may), and names the rest exactly,
// with the one link and the one click that delete each (manualDeletion).
//
// Expiry. An installation's token does not expire: it is the running server's only way to its
// database replica and its files, so an expiry would stop replication and the server's start
// without warning, and nothing can replace it on a schedule. It is scoped to two buckets'
// objects, its secret exists only in the Worker's secrets and the server's environment, and
// removal deletes it or tells the person to. A staging installation's token expires a day after
// the staging deployments do, so that one nobody deletes ends on its own.

import { createHash } from "node:crypto";
import { bucketsOf, type Installation } from "./settings.ts";

/** The permission group: read, write and list objects in the buckets the token names. */
export const R2_WRITE_GROUP = "Workers R2 Storage Bucket Item Write";
/** The scope of bucket-level permission groups and resources. */
export const R2_BUCKET_SCOPE = "com.cloudflare.edge.r2.bucket";
/** Where a person deletes their user API tokens. */
export const API_TOKENS_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

const DAY_MS = 24 * 60 * 60_000;

/** A user API token as Cloudflare lists it: never with its value. */
export interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly expiresOn?: string;
  readonly notBefore?: string;
  /** Whether it is limited to client IP addresses. */
  readonly ipLimited: boolean;
  readonly policies: readonly {
    readonly effect?: string;
    readonly permissionGroups: readonly string[];
    readonly resources: Readonly<Record<string, unknown>>;
  }[];
}

/** What a token create sends: `cf user tokens create`'s flags. */
export interface TokenRequest {
  readonly name: string;
  readonly policies: readonly {
    readonly effect: "allow";
    readonly permission_groups: readonly { readonly id: string }[];
    readonly resources: Readonly<Record<string, "*">>;
  }[];
  readonly expiresOn?: string;
}

/** What the bootstrap needs of Cloudflare's user API tokens. cloud.ts implements it with cf. */
export interface TokenApi {
  /** The ID of the one bucket-scoped permission group with this name. */
  permissionGroup(name: string): string;
  /** Creates a token, and returns its ID and its value, which Cloudflare shows only now. */
  create(request: TokenRequest): { readonly id: string; readonly value: string };
  /** Every user API token of the login, expired ones included. An OAuth login gets 403. */
  list(): ApiToken[];
  /** One token by its ID, never its value; undefined when it does not exist (404). */
  get(id: string): ApiToken | undefined;
  /** Deletes a token. An OAuth login gets 403. */
  remove(id: string): "deleted" | "absent";
}

/** Cloudflare refused (HTTP 403): the installer's login may not do this with API tokens. */
export class TokensUnavailable extends Error {}

/** The journal's record of the installation's current token: no value, nothing derived. */
export interface RecordedToken {
  readonly name: string;
  /** Written before the create, so that a run that stops before its answer is recognised. */
  readonly createStartedAt?: string;
  /** The token's ID: the S3 access key ID. */
  readonly id?: string;
  readonly createdAt?: string;
  readonly expiresOn?: string;
}

/** A token of the installation that the bootstrap made and no longer uses: to be deleted. */
export interface LeftToken {
  readonly name: string;
  /** Unknown when the create's answer never came. */
  readonly id?: string;
  /** For a create never answered: when it was sent. */
  readonly createStartedAt?: string;
  readonly expiresOn?: string;
}

/**
 * How long a create whose answer never came may still take effect: the staging tool's settle
 * time (Cloudflare's proxy gives up on a response after 100 seconds; three times that).
 */
export const TOKEN_SETTLE_MS = 300_000;

/** The S3 key pair of an R2 token: its ID, and the SHA-256 of its value in lower-case hex. */
export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function s3Credentials(id: string, value: string): S3Credentials {
  return { accessKeyId: id, secretAccessKey: createHash("sha256").update(value).digest("hex") };
}

/** What every token of the installation's name starts with. */
export function r2TokenPrefix(plan: Installation): string {
  return `${plan.platformWorker}-r2--${plan.installationId}`;
}

/**
 * A token's name: the installation's, and the UTC time of its create to the second; `-2`, `-3`
 * … when a recorded token already has that name (a retry within the second, a clock set back),
 * so that an instruction to delete one never names another (Codex WP3.25 r3-3).
 */
export function r2TokenName(
  plan: Installation,
  at: number,
  taken: ReadonlySet<string> = new Set(),
): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const base = `${r2TokenPrefix(plan)}--${stamp}`;
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

/** Whether a name is one the bootstrap gives a token of this installation. */
export function isR2TokenName(plan: Installation, name: string): boolean {
  const prefix = `${r2TokenPrefix(plan)}--`;
  return name.startsWith(prefix) && /^\d{8}T\d{6}Z(-\d+)?$/.test(name.slice(prefix.length));
}

/**
 * The token's resources: exactly the plan's buckets, each `<account>_default_<bucket>`. The
 * bootstrap creates buckets in the account's default jurisdiction, and finds only those.
 */
export function r2TokenResources(plan: Installation): Record<string, "*"> {
  return Object.fromEntries(
    bucketsOf(plan).map((bucket) => [
      `${R2_BUCKET_SCOPE}.${plan.accountId}_default_${bucket}`,
      "*" as const,
    ]),
  );
}

/** When a new token expires: never for an installation; for staging, a day after it ends. */
export function r2TokenExpiry(plan: Installation, now: number): string | undefined {
  if (plan.target.kind !== "staging") return undefined;
  return new Date(now + (plan.target.days + 1) * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function r2TokenRequest(
  plan: Installation,
  group: string,
  now: number,
  taken: ReadonlySet<string> = new Set(),
): TokenRequest {
  const expiresOn = r2TokenExpiry(plan, now);
  return {
    name: r2TokenName(plan, now, taken),
    policies: [
      { effect: "allow", permission_groups: [{ id: group }], resources: r2TokenResources(plan) },
    ],
    ...(expiresOn === undefined ? {} : { expiresOn }),
  };
}

/** A recorded token as one to delete. */
export function leftOf(token: RecordedToken): LeftToken {
  return {
    name: token.name,
    ...(token.id === undefined ? {} : { id: token.id }),
    ...(token.id === undefined && token.createStartedAt !== undefined
      ? { createStartedAt: token.createStartedAt }
      : {}),
    ...(token.expiresOn === undefined ? {} : { expiresOn: token.expiresOn }),
  };
}

/** The listing, or undefined where Cloudflare refuses it (an OAuth login). */
function tryList(api: TokenApi): ApiToken[] | undefined {
  try {
    return api.list();
  } catch (error) {
    if (error instanceof TokensUnavailable) return undefined;
    throw error;
  }
}

export interface Deletion {
  /** The tokens Cloudflare no longer has. */
  readonly deleted: readonly LeftToken[];
  /** Tokens that exist, or may still: their delete was refused (403), or not yet settled. */
  readonly left: readonly LeftToken[];
  /**
   * Creates never answered that nothing can check: the login may not list tokens. They are
   * named "if it exists"; whether to keep them recorded is the caller's choice.
   */
  readonly unconfirmed: readonly LeftToken[];
}

/** Whether the token still exists, read by its ID; undefined where the login may not read it. */
function stillThere(api: TokenApi, id: string): boolean | undefined {
  try {
    return api.get(id) !== undefined;
  } catch (error) {
    if (error instanceof TokensUnavailable) return undefined;
    throw error;
  }
}

/**
 * Deletes the tokens it may. A delete refused (403) is followed by a read of the token: one a
 * person already deleted reads as gone (Codex WP3.25 r3, question). A token whose ID is unknown
 * (its create's answer never came) is looked for by its name where the login may list tokens;
 * it is dropped only once the listing shows nothing after the settle time (Codex WP3.25 r3-2),
 * and where the login may not list, it is unconfirmed. With `also`, every listed token it
 * accepts is deleted too (removal: any token of the installation's name).
 */
export function deleteTokens(
  api: TokenApi,
  tokens: readonly LeftToken[],
  options: { readonly also?: (token: ApiToken) => boolean; readonly now: number },
): Deletion {
  const unknownIds = tokens.some((t) => t.id === undefined);
  const listed = unknownIds || options.also !== undefined ? tryList(api) : undefined;
  const wanted: LeftToken[] = [];
  const left: LeftToken[] = [];
  const unconfirmed: LeftToken[] = [];
  for (const token of tokens) {
    if (token.id !== undefined) {
      wanted.push(token);
      continue;
    }
    if (listed === undefined) {
      unconfirmed.push(token);
      continue;
    }
    const found = listed.filter((l) => l.name === token.name);
    for (const t of found) wanted.push({ name: token.name, id: t.id });
    const sent = Date.parse(token.createStartedAt ?? "");
    // Not listed: never made, or still to land; kept until the settle time has passed.
    if (found.length === 0 && !(options.now - sent >= TOKEN_SETTLE_MS)) left.push(token);
  }
  const known = new Set(wanted.map((t) => t.id));
  for (const t of listed ?? []) {
    if (options.also?.(t) && !known.has(t.id)) {
      wanted.push({
        name: t.name,
        id: t.id,
        ...(t.expiresOn === undefined ? {} : { expiresOn: t.expiresOn }),
      });
      known.add(t.id);
    }
  }
  const deleted: LeftToken[] = [];
  for (const token of wanted) {
    const id = String(token.id);
    try {
      api.remove(id);
      deleted.push(token);
    } catch (error) {
      if (!(error instanceof TokensUnavailable)) throw error;
      if (stillThere(api, id) === false) deleted.push(token);
      else left.push(token);
    }
  }
  return { deleted, left, unconfirmed };
}

/**
 * What the person does about tokens the bootstrap could not delete: the one link and the one
 * click, and each token's exact name.
 */
export function manualDeletion(left: readonly LeftToken[]): string {
  const names = left.map((t) => {
    const ends = t.expiresOn === undefined ? "" : ` (or leave it: it expires on ${t.expiresOn})`;
    const maybe = t.id === undefined ? " if it exists (its create was never answered)" : "";
    return `${t.name}${maybe}${ends}`;
  });
  const which =
    names.length === 1
      ? `the token named exactly ${names[0]}`
      : `each of the tokens named exactly ${names.join("; ")}`;
  const next = names.length === 1 ? "it" : "each";
  return `Cloudflare does not let this cf login delete API tokens, so delete ${which} by hand: open ${API_TOKENS_PAGE}, open the three-dot menu next to ${next}, and choose Delete.`;
}

export interface EnsureContext {
  readonly api: TokenApi;
  readonly plan: Installation;
  /** The journal's current token and its tokens to delete. */
  readonly recorded: () => {
    readonly current: RecordedToken | undefined;
    readonly left: readonly LeftToken[];
  };
  /** Records both, before the step that follows (persist-before-effect). */
  readonly record: (current: RecordedToken | undefined, left: readonly LeftToken[]) => void;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Moves the current token, if any, to the tokens to delete (its value is gone: the Worker never
 * got its pair, or got another), and deletes what Cloudflare lets it delete. Returns the tokens
 * still to delete.
 */
export function retireR2Token(ctx: EnsureContext): readonly LeftToken[] {
  const { current, left } = ctx.recorded();
  const retiring = [...left, ...(current === undefined ? [] : [leftOf(current)])];
  if (retiring.length === 0) return [];
  ctx.record(undefined, retiring);
  const result = deleteTokens(ctx.api, retiring, { now: ctx.now() });
  for (const t of result.deleted) ctx.log(`deleted the unused R2 token ${t.name}`);
  // Unconfirmed creates stay recorded: removal names them once more.
  const still = [...result.left, ...result.unconfirmed];
  ctx.record(undefined, still);
  return still;
}

/**
 * A new token of the installation and its S3 key pair, for a platform Worker that holds no key
 * pair: never a roll, which an OAuth login may not do. A token made earlier is retired first.
 * Returns the pair and the tokens still to delete, which the caller names to the person.
 */
export function makeR2Token(ctx: EnsureContext): {
  readonly pair: S3Credentials;
  readonly left: readonly LeftToken[];
} {
  const left = retireR2Token(ctx);
  const group = ctx.api.permissionGroup(R2_WRITE_GROUP);
  const now = ctx.now();
  const request = r2TokenRequest(ctx.plan, group, now, new Set(left.map((t) => t.name)));
  ctx.record(
    {
      name: request.name,
      createStartedAt: iso(now),
      ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
    },
    left,
  );
  let created: { readonly id: string; readonly value: string };
  try {
    created = ctx.api.create(request);
  } catch (error) {
    // A refusal is an answer: nothing was made. Anything else may still land.
    if (error instanceof TokensUnavailable) ctx.record(undefined, left);
    throw error;
  }
  ctx.record(
    {
      name: request.name,
      id: created.id,
      createdAt: iso(ctx.now()),
      ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
    },
    left,
  );
  ctx.log(
    `created the R2 token ${request.name}: objects in ${bucketsOf(ctx.plan).join(" and ")} only, ${
      request.expiresOn === undefined ? "no expiry" : `until ${request.expiresOn}`
    }`,
  );
  return { pair: s3Credentials(created.id, created.value), left };
}

/**
 * The dashboard step, in one sentence, for when the installer's login cannot make the token:
 * what to click, and which buckets the token covers.
 */
export function manualR2Step(plan: Installation): string {
  const buckets = bucketsOf(plan);
  const which =
    buckets.length === 1 ? `the bucket ${buckets[0]}` : `the buckets ${buckets.join(" and ")}`;
  return `In the Cloudflare dashboard, open R2 object storage, select Manage next to API Tokens, choose Create User API token, set Permissions to Object Read & Write, apply it to ${which} only, select Create User API token, and copy its Access Key ID and Secret Access Key.`;
}
