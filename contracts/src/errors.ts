import { z } from "zod";

/**
 * Error codes shared across RPC and HTTP boundaries. Error classes do not survive DO RPC.
 * Additive only: a receiver that meets a code it does not know treats it as `internal`.
 *
 * - `gone`: the computer was removed, or has a removal intent. The Cloudflare launcher raises
 *   `SandboxGoneError` for it, and for nothing else (never for a computer that still exists).
 * - `at_capacity`: the installation's limit of awake computers is reached; a wake is refused at
 *   once with a readable reason, with no queue (R-20).
 */
export const ErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "stale_generation",
  "unsupported_version",
  "unavailable",
  "internal",
  "gone",
  "at_capacity",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
