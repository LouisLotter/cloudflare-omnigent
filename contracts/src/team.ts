import { z } from "zod";

// Teams behind Cloudflare Access (WP8.3, D50). Three contracts:
//
// 1. **The forwarded person** (`x-cfo-person`): what the web Worker tells OmnigentServer about the
//    Access identity ingress validated, on the forwarding path only. The web Worker sets it after
//    stripping every `x-cfo-` header a client sent; the computer route strips it too; so only the
//    web Worker can be its source. OmnigentServer turns it into Omnigent's signed identity
//    envelope (`x-omnigent-external-identity`, the fork's `omnigent.server.external_identity`)
//    when `CFO_IDENTITY_ENVELOPE` is `on`, and strips it either way.
//
// 2. **The admission call** (`POST platform.internal/access/v1/admission`): the server image's
//    adapter tells the platform Worker who Access should admit, after Omnigent commits a
//    membership change. Signed with the launcher's key under its own protocol line
//    (ADMISSION_SIGNING_PROTOCOL), so a launcher signature can never be replayed here.
//
// 3. **The page-person call** (OmnigentServer's `pagePerson` RPC, then `POST
//    /_cfo/page-person` on the server container): which team member, if any, an Access identity
//    is bound to, for the platform pages. Signed like the owner's password call
//    (`owner-password.ts`).

/** The internal header carrying `ForwardedPerson` from the web Worker to OmnigentServer. */
export const FORWARDED_PERSON_HEADER = "x-cfo-person";
/** Omnigent's signed identity envelope; the platform strips any a client sends. */
export const EXTERNAL_IDENTITY_HEADER = "x-omnigent-external-identity";
/** How long an envelope OmnigentServer signs lasts, at most: one forwarded request. */
export const ENVELOPE_LIFETIME_S = 60;

const Email = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)
  .refine((email) => email === email.toLowerCase(), { message: "must be lowercase" });

/** The Access identity ingress admitted, as the forwarding path passes it on. */
export const ForwardedPerson = z.strictObject({
  /** `https://<team>.cloudflareaccess.com`. */
  issuer: z.string().min(1).max(512),
  /** Access's user ID (`sub`). */
  subject: z.string().min(1).max(255),
  /** The installation's Access application AUD tag. */
  audience: z.string().min(1).max(255),
  /** The verified address, lowercase, when the assertion carries one. */
  email: Email.optional(),
  /** Whether the address matched the installation's owner pin. */
  installationOwner: z.boolean(),
  /** The assertion's expiry, in Unix seconds. */
  expiresAt: z.number().int().positive(),
});
export type ForwardedPerson = z.infer<typeof ForwardedPerson>;

/** The admission call's protocol line, first in its string to sign. */
export const ADMISSION_SIGNING_PROTOCOL = "cfo-access-admission/v1";
/** `POST <this>` on `platform.internal`, from the server container only. */
export const ADMISSION_PATH = "/access/v1/admission";
/** At most this many addresses in one admission list (the fork's `MAX_ADMITTED`). */
export const MAX_ADMITTED_EMAILS = 1000;

/** Who Access should admit: the team's active members and pending invitations. */
export const AccessAdmissionCall = z.strictObject({
  /**
   * Omnigent's admission revision. A lower one than the last applied is ignored; an equal one
   * is compared with the group again, so drift is repaired.
   */
  revision: z.number().int().min(0),
  /** Sorted lowercase addresses, at most MAX_ADMITTED_EMAILS. */
  emails: z.array(Email).max(MAX_ADMITTED_EMAILS),
  /**
   * The team's current active owners' verified addresses, each also in `emails`. A list with
   * none, or naming one `emails` lacks, is refused (`owner_missing`), so no list locks every
   * owner out.
   */
  owners: z.array(Email).max(MAX_ADMITTED_EMAILS),
});
export type AccessAdmissionCall = z.infer<typeof AccessAdmissionCall>;

/**
 * The platform's answer. `applied`: Access holds exactly this list now (read back), also for a
 * repeated revision. `stale`: a newer revision was applied already; nothing changed. `refused`: the list or the group is not
 * one the platform may write (named by `reason`); nothing changed.
 */
export const AccessAdmissionResult = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("applied"), revision: z.number().int().min(0) }),
  z.strictObject({ outcome: z.literal("stale"), appliedRevision: z.number().int().min(0) }),
  z.strictObject({
    outcome: z.literal("refused"),
    reason: z.enum(["not_configured", "owner_missing", "foreign_rules", "group_missing"]),
  }),
]);
export type AccessAdmissionResult = z.infer<typeof AccessAdmissionResult>;

/** The string the admission call's HMAC covers: four lines, no trailing newline. */
export function admissionStringToSign(input: {
  readonly keyId: string;
  readonly timestamp: string;
  readonly bodySha256: string;
}): string {
  return [ADMISSION_SIGNING_PROTOCOL, input.keyId, input.timestamp, input.bodySha256].join("\n");
}

/** The page-person platform call's path on the server container. */
export const PAGE_PERSON_CALL_PATH = "/_cfo/page-person";

/** Which team member an Access identity is bound to: what the pages' person seam asks. */
export const PagePersonCall = z.strictObject({
  interfaceVersion: z.number().int().min(1),
  issuer: z.string().min(1).max(512),
  subject: z.string().min(1).max(255),
  audience: z.string().min(1).max(255),
});
export type PagePersonCall = z.infer<typeof PagePersonCall>;

/**
 * `member`: the bound member and their role and state. `none`: the identity is bound to nobody.
 * `unsupported`: the server's Omnigent has no team model (an older build); the seam then refuses
 * everyone but the pinned owner. `unavailable`: the server did not answer; refused, retry later.
 */
export const PagePersonResult = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("member"),
    memberId: z.string().regex(/^[0-9a-f]{32}$/),
    userId: z.string().min(1).max(128),
    role: z.enum(["owner", "admin", "member"]),
    state: z.enum(["invited", "active", "suspended", "removed"]),
  }),
  z.strictObject({ action: z.literal("none") }),
  z.strictObject({ action: z.literal("unsupported") }),
  z.strictObject({ action: z.literal("unavailable") }),
]);
export type PagePersonResult = z.infer<typeof PagePersonResult>;
