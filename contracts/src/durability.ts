import { z } from "zod";

// The server image's response barrier holds a security change's response until Litestream has
// replicated it. On timeout it answers 424 with one of two bodies, in the error shape each route
// family's clients already parse (spike S4). No client retries a 424, and neither does the Worker.

export const DURABILITY_UNCONFIRMED_STATUS = 424;
export const DURABILITY_UNCONFIRMED_CODE = "durability_unconfirmed";
export const DURABILITY_UNCONFIRMED_MESSAGE =
  "The change was applied, but its durability is not yet confirmed. Check the current state before repeating it.";

/** The 424 body on Omnigent's API routes, whose clients read `error.message`. */
export const DurabilityUnconfirmed = z.strictObject({
  error: z.strictObject({
    code: z.literal(DURABILITY_UNCONFIRMED_CODE),
    message: z.string().min(1),
  }),
  applied: z.literal(true),
});
export type DurabilityUnconfirmed = z.infer<typeof DurabilityUnconfirmed>;

/** The 424 body on the accounts and OAuth routes, whose clients read a string `error`. */
export const DurabilityUnconfirmedAuth = z.strictObject({
  error: z.string().min(1),
  code: z.literal(DURABILITY_UNCONFIRMED_CODE),
  applied: z.literal(true),
});
export type DurabilityUnconfirmedAuth = z.infer<typeof DurabilityUnconfirmedAuth>;

/** Which of the two bodies a request path gets. */
export function durabilityBodyShape(path: string): "auth" | "api" {
  return path.startsWith("/auth/") || path.startsWith("/oauth/") ? "auth" : "api";
}
