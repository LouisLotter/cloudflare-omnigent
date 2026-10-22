import { z } from "zod";

/** Crockford base32, lowercase, as produced by ULID-style generators. */
const base32 = "[0-9a-hjkmnp-tv-z]";

/**
 * A platform operation ID: every mutating RPC call and computer API message carries one, and a
 * repeated call returns the recorded outcome. The launcher API uses Omnigent's own form instead
 * (`LauncherOperationId`).
 */
export const OperationId = z.string().regex(new RegExp(`^op_${base32}{26}$`));
export type OperationId = z.infer<typeof OperationId>;

export const ComputerId = z.string().regex(new RegExp(`^cmp_${base32}{26}$`));
export type ComputerId = z.infer<typeof ComputerId>;

/** One installation: one person's deployment, also named in its deployment variables. */
export const InstallationId = z.string().regex(new RegExp(`^ins_${base32}{26}$`));
export type InstallationId = z.infer<typeof InstallationId>;

export const OutageId = z.string().regex(new RegExp(`^out_${base32}{26}$`));
export type OutageId = z.infer<typeof OutageId>;

/** One published checkpoint, workspace or credential. */
export const CheckpointId = z.string().regex(new RegExp(`^ckp_${base32}{26}$`));
export type CheckpointId = z.infer<typeof CheckpointId>;

/** One layer of a workspace checkpoint: a base or a delta. */
export const LayerId = z.string().regex(new RegExp(`^lyr_${base32}{26}$`));
export type LayerId = z.infer<typeof LayerId>;

/** A UTC instant in ISO 8601 with the `Z` suffix, as `Date.prototype.toISOString` writes it. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** Runtime generation of one computer; increases on every container start. */
export const Generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Generation = z.infer<typeof Generation>;

/**
 * A computer's Omnigent host ID. Omnigent mints it when the persistent host is created, as
 * `uuid.uuid4().hex`: 32 lowercase hexadecimal digits, no dashes (fork `cfo/integration`
 * `35ac1ebd2`, `persistent_hosts.create_host`). It never changes. 3.C confirmed this format;
 * the earlier contract said a dashed version 4 UUID, which Omnigent never sends.
 */
export const HostId = z.string().regex(/^[0-9a-f]{32}$/);
export type HostId = z.infer<typeof HostId>;

/**
 * An operation ID on the launcher API. Omnigent mints the ones it passes (`claim_start` and
 * `suspend`) as `uuid.uuid4().hex`, and the Cloudflare launcher mints the others the same way,
 * one per Omnigent call, reused for every retry of that call.
 */
export const LauncherOperationId = z.string().regex(/^[0-9a-f]{32}$/);
export type LauncherOperationId = z.infer<typeof LauncherOperationId>;

/** A host start attempt, granted by `claim_start`. Attempts count up from 1 per computer. */
export const StartAttempt = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export type StartAttempt = z.infer<typeof StartAttempt>;

/** Lowercase hexadecimal SHA-256. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/** One path segment: not empty, not `.` or `..`, no `/` or NUL. */
const segment = String.raw`(?!\.\.?(?:\/|$))[^/\u0000]+`;

/**
 * A path relative to a capture root (the computer user's home directory): POSIX separators, no
 * leading or trailing slash, no empty, `.` or `..` segment, no NUL, at most 4096 characters.
 * Deleted paths in a layer are checked with this too, so none can reach outside the declared
 * roots. A regular expression, so the exported JSON Schema checks it as well.
 */
export const RelativePath = z
  .string()
  .max(4096)
  .regex(new RegExp(`^${segment}(?:\\/${segment})*$`));
export type RelativePath = z.infer<typeof RelativePath>;

/** An absolute POSIX path inside a container, normalised the same way. */
export const AbsolutePath = z
  .string()
  .max(4096)
  .regex(new RegExp(`^(?:\\/${segment})+$`));
export type AbsolutePath = z.infer<typeof AbsolutePath>;

/**
 * A computer's instance size, chosen at each start (the design's "Size and number"). Always set
 * explicitly: Cloudflare's default, `lite`, is far too small.
 */
export const InstanceSize = z.enum([
  "lite",
  "basic",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
]);
export type InstanceSize = z.infer<typeof InstanceSize>;
export const DEFAULT_INSTANCE_SIZE: InstanceSize = "standard-2";
