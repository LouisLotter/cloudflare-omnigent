import { z } from "zod";

/** Error codes shared across RPC and HTTP boundaries. Error classes do not survive DO RPC. */
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
