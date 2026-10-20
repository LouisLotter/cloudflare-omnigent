import { z } from "zod";

/** Crockford base32, lowercase, as produced by ULID-style generators. */
const base32 = "[0-9a-hjkmnp-tv-z]";

export const OperationId = z.string().regex(new RegExp(`^op_${base32}{26}$`));
export type OperationId = z.infer<typeof OperationId>;

export const ComputerId = z.string().regex(new RegExp(`^cmp_${base32}{26}$`));
export type ComputerId = z.infer<typeof ComputerId>;

/** One installation: one person's deployment, also named in its deployment variables. */
export const InstallationId = z.string().regex(new RegExp(`^ins_${base32}{26}$`));
export type InstallationId = z.infer<typeof InstallationId>;

export const OutageId = z.string().regex(new RegExp(`^out_${base32}{26}$`));
export type OutageId = z.infer<typeof OutageId>;

/** A UTC instant in ISO 8601 with the `Z` suffix, as `Date.prototype.toISOString` writes it. */
export const Timestamp = z.iso.datetime();
export type Timestamp = z.infer<typeof Timestamp>;

/** Runtime generation of one computer; increases on every container start. */
export const Generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Generation = z.infer<typeof Generation>;

/**
 * A computer's Omnigent host ID, a version 4 UUID that never changes. Since the architecture
 * revision Omnigent mints it (AR-02), and M3's contract package (3.C) confirms its format.
 */
export const HostId = z.uuidv4();
export type HostId = z.infer<typeof HostId>;
