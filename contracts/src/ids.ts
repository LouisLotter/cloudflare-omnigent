import { z } from "zod";

/** Crockford base32, lowercase, as produced by ULID-style generators. */
const base32 = "[0-9a-hjkmnp-tv-z]";

export const OperationId = z.string().regex(new RegExp(`^op_${base32}{26}$`));
export type OperationId = z.infer<typeof OperationId>;

export const ComputerId = z.string().regex(new RegExp(`^cmp_${base32}{26}$`));
export type ComputerId = z.infer<typeof ComputerId>;

/** Runtime generation of one computer; increases on every container start. */
export const Generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export type Generation = z.infer<typeof Generation>;

/** A computer's host ID: a random (version 4) UUID allocated once by WorkspaceDO; it never changes. */
export const HostId = z.uuidv4();
export type HostId = z.infer<typeof HostId>;
