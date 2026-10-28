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
// journal keeps it, and the name, so that removal deletes it.
//
// One token per installation, never two. It is named `<platform Worker>-r2--<installation ID>`,
// and the name finds a token whose create landed after its run stopped, before the journal
// could record it. When the value is needed again (the Worker lacks the key pair: an earlier
// deploy failed), the installation's token is rolled, which keeps its ID and returns a new
// value, if it is still valid; otherwise it is deleted and a new one made. A token is rolled
// or deleted only while the Worker holds no key pair from it (machine.ts).
//
// A create or a roll whose run stopped before Cloudflare's answer may still take effect later,
// as the staging tool assumes of every request (scripts/staging/stg.ts, its settle time). Each
// is journalled before it is sent and cleared once answered; a run that finds one unresolved
// waits TOKEN_SETTLE_MS first (the lock it holds proves the earlier run's process has ended),
// so that a late create is listed, and a late roll cannot follow this run's own roll and
// invalidate the value it deploys. A 403 is an answer: nothing is left in flight.
//
// Expiry. An installation's token does not expire: it is the running server's only way to its
// database replica and its files, so an expiry would stop replication and the server's start
// without warning, and nothing rotates it yet. It is scoped to two buckets' objects and is
// deleted when the installation is removed. A staging installation's token expires a day after
// the staging deployments do, in case their teardown never runs.

import { createHash } from "node:crypto";
import { bucketsOf, type Installation } from "./settings.ts";

/** The permission group: read, write and list objects in the buckets the token names. */
export const R2_WRITE_GROUP = "Workers R2 Storage Bucket Item Write";
/** The scope of bucket-level permission groups and resources. */
export const R2_BUCKET_SCOPE = "com.cloudflare.edge.r2.bucket";

const DAY_MS = 24 * 60 * 60_000;

/** A user API token as Cloudflare lists it: never with its value. */
export interface ApiToken {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly expiresOn?: string;
  readonly notBefore?: string;
  /** Whether it is limited to client IP addresses (the server's address is not fixed). */
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
  /** Every user API token of the installer's login, expired ones included. */
  list(): ApiToken[];
  /** Creates a token, and returns its ID and its value, which Cloudflare shows only now. */
  create(request: TokenRequest): { readonly id: string; readonly value: string };
  /** A new value for the token, which keeps its ID: the old value stops working at once. */
  roll(id: string): string;
  remove(id: string): "deleted" | "absent";
}

/** Cloudflare refused (HTTP 403): the installer's login cannot make user API tokens. */
export class TokensUnavailable extends Error {}

/**
 * How long a token request whose client is gone may still take effect: the staging tool's
 * settle time (Cloudflare's proxy gives up on a response after 100 seconds; three times that).
 */
export const TOKEN_SETTLE_MS = 300_000;

/** The journal's record of the installation's token: no value, and nothing derived from one. */
export interface RecordedToken {
  readonly name: string;
  /** Written before the create, so that a run that stops before its answer is recognised. */
  readonly createStartedAt?: string;
  /** The token's ID: the S3 access key ID. */
  readonly id?: string;
  readonly createdAt?: string;
  readonly expiresOn?: string;
  /** Written before a roll, removed once it is answered. */
  readonly rollStartedAt?: string;
}

/** Whether a create was sent and never answered: it may still make a token. */
export function createInFlight(recorded: RecordedToken | undefined): boolean {
  return recorded?.createStartedAt !== undefined && recorded.id === undefined;
}

/** Whether a create or a roll was sent and never answered. */
export function requestInFlight(recorded: RecordedToken | undefined): boolean {
  return createInFlight(recorded) || recorded?.rollStartedAt !== undefined;
}

/** The S3 key pair of an R2 token: its ID, and the SHA-256 of its value in lower-case hex. */
export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function s3Credentials(id: string, value: string): S3Credentials {
  return { accessKeyId: id, secretAccessKey: createHash("sha256").update(value).digest("hex") };
}

/** The installation's token's name: `<platform Worker>-r2--<installation ID>`. */
export function r2TokenName(plan: Installation): string {
  return `${plan.platformWorker}-r2--${plan.installationId}`;
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

export function r2TokenRequest(plan: Installation, group: string, now: number): TokenRequest {
  const expiresOn = r2TokenExpiry(plan, now);
  return {
    name: r2TokenName(plan),
    policies: [
      { effect: "allow", permission_groups: [{ id: group }], resources: r2TokenResources(plan) },
    ],
    ...(expiresOn === undefined ? {} : { expiresOn }),
  };
}

/** Why an existing token of the installation cannot be kept; empty when it can. */
export function r2TokenProblems(
  token: ApiToken,
  plan: Installation,
  group: string,
  now: number,
): string[] {
  const problems: string[] = [];
  if (token.status !== "active") problems.push(`it is ${token.status ?? "of unknown status"}`);
  if (token.notBefore !== undefined && !(Date.parse(token.notBefore) <= now)) {
    problems.push("it is not valid yet");
  }
  if (plan.target.kind === "staging") {
    // It must last as long as the staging deployments may.
    const until = token.expiresOn === undefined ? Number.NaN : Date.parse(token.expiresOn);
    if (!(until >= now + plan.target.days * DAY_MS)) problems.push("it expires too soon");
  } else if (token.expiresOn !== undefined) {
    problems.push("it expires");
  }
  if (token.ipLimited) problems.push("it is limited to client addresses");
  const wanted = r2TokenResources(plan);
  const [policy, ...more] = token.policies;
  const exact =
    policy !== undefined &&
    more.length === 0 &&
    policy.effect === "allow" &&
    policy.permissionGroups.length === 1 &&
    policy.permissionGroups[0] === group &&
    Object.keys(policy.resources).length === Object.keys(wanted).length &&
    Object.entries(policy.resources).every(([resource, value]) => wanted[resource] === value);
  if (!exact) problems.push("its permissions are not exactly the installation's buckets");
  return problems;
}

export interface EnsureContext {
  readonly api: TokenApi;
  readonly plan: Installation;
  /** What the journal records now. */
  readonly recorded: () => RecordedToken | undefined;
  /** Records the token in the journal (persisted before the step that follows). */
  readonly record: (token: RecordedToken) => void;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (message: string) => void;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Sends a request; a refusal (403) is an answer, so `answered` runs before it is rethrown. */
function send<T>(request: () => T, answered: () => void): T {
  try {
    return request();
  } catch (error) {
    if (error instanceof TokensUnavailable) answered();
    throw error;
  }
}

/**
 * The installation's token and its S3 key pair, for a platform Worker that holds no key pair
 * from it: the existing token rolled if it is still valid, otherwise a new one. Every other
 * token of the installation (a duplicate, an invalid one) is deleted first.
 */
export async function ensureR2Token(ctx: EnsureContext): Promise<S3Credentials> {
  const { api, plan } = ctx;
  const name = r2TokenName(plan);
  if (requestInFlight(ctx.recorded())) {
    ctx.log(
      `an earlier run's request for the R2 token may still take effect; waiting ${TOKEN_SETTLE_MS / 60_000} minutes before looking`,
    );
    await ctx.sleep(TOKEN_SETTLE_MS);
  }
  const group = api.permissionGroup(R2_WRITE_GROUP);
  const recordedId = ctx.recorded()?.id;
  const now = ctx.now();
  const mine = api.list().filter((t) => t.name === name || t.id === recordedId);
  const valid = (t: ApiToken) => r2TokenProblems(t, plan, group, now).length === 0;
  const keep = mine.find((t) => t.id === recordedId && valid(t)) ?? mine.find(valid);
  for (const token of mine) {
    if (token === keep) continue;
    const why = r2TokenProblems(token, plan, group, now);
    ctx.log(
      `deleting an R2 token of this installation: ${why.length > 0 ? why.join(", ") : "a second one"}`,
    );
    api.remove(token.id);
  }
  if (keep !== undefined) {
    const createdAt = keep.id === recordedId ? ctx.recorded()?.createdAt : undefined;
    const kept: RecordedToken = {
      name,
      id: keep.id,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(keep.expiresOn === undefined ? {} : { expiresOn: keep.expiresOn }),
    };
    ctx.record({ ...kept, rollStartedAt: iso(ctx.now()) });
    const value = send(
      () => api.roll(keep.id),
      () => ctx.record(kept),
    );
    ctx.record(kept);
    ctx.log(`reusing the R2 token ${name} with a new value (its old one was never kept)`);
    return s3Credentials(keep.id, value);
  }
  const request = r2TokenRequest(plan, group, now);
  ctx.record({ name, createStartedAt: iso(now) });
  const created = send(
    () => api.create(request),
    () => ctx.record({ name }),
  );
  ctx.record({
    name,
    id: created.id,
    createdAt: iso(ctx.now()),
    ...(request.expiresOn === undefined ? {} : { expiresOn: request.expiresOn }),
  });
  ctx.log(
    `created the R2 token ${name}: objects in ${bucketsOf(plan).join(" and ")} only, ${
      request.expiresOn === undefined ? "no expiry" : `until ${request.expiresOn}`
    }`,
  );
  return s3Credentials(created.id, created.value);
}

/**
 * Deletes the installation's token: the recorded one and any other under its name. Returns how
 * many it deleted; a token already gone counts as deleted by someone else.
 */
export function removeR2Token(
  api: TokenApi,
  plan: Installation,
  recorded: RecordedToken | undefined,
): number {
  const name = r2TokenName(plan);
  const ids = new Set(
    api
      .list()
      .filter((t) => t.name === name)
      .map((t) => t.id),
  );
  if (recorded?.id !== undefined) ids.add(recorded.id);
  let deleted = 0;
  for (const id of ids) if (api.remove(id) === "deleted") deleted++;
  return deleted;
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
