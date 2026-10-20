import { z } from "zod";

/**
 * The claims of a Cloudflare Access application token (`Cf-Access-Jwt-Assertion`), as ingress
 * reads them once the signature is verified. This checks their shape only: ingress compares `iss`,
 * `aud` and the time claims with its configuration and its clock. Access adds other claims, which
 * are kept and ignored. Service tokens carry an empty `sub` and are refused here.
 */
export const AccessAssertionClaims = z.looseObject({
  /** The team domain, `https://<team>.cloudflareaccess.com`: HTTPS, a host name, no path. */
  iss: z.string().regex(/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+$/),
  aud: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  sub: z.string().min(1),
  email: z.email().optional(),
  type: z.literal("app"),
  exp: z.number().int().positive(),
  iat: z.number().int().positive().optional(),
  nbf: z.number().int().positive().optional(),
});
export type AccessAssertionClaims = z.infer<typeof AccessAssertionClaims>;
