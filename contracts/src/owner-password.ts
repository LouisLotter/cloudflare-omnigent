import { z } from "zod";
import { IntentToken, PageOwner } from "./pages.ts";

// The owner's Omnigent password, chosen on the site (WP3.34). Two contracts:
//
// 1. **OmnigentServer's `ownerPassword` RPC**, called by the web Worker's password page
//    (`/platform/password`) after ingress admitted the pinned owner:
//    - `state` reads whether the owner still has to choose a password (the installer chose none:
//      the platform Worker holds `CFO_OWNER_PASSWORD_ON_PAGE`, and no password has been chosen on
//      the page yet), the owner's Omnigent username, and the page's request-intent token for the
//      caller's Access session;
//    - `set` changes it. OmnigentServer checks the intent token in constant time and the attempts
//      limit before any effect, then makes the platform call below. The password is passed on
//      and never stored, logged or returned.
//
// 2. **The platform call to the server image**: `POST /_cfo/owner-password` on the server
//    container's port 8000, which only OmnigentServer reaches (`getTcpPort`); OmnigentServer
//    refuses to forward any path under `/_cfo/` from a browser or a computer, and strips every
//    `x-cfo-` header from what it forwards. The body is compact JSON `{"password": "…", "nonce":
//    "<32 lowercase hex digits>"}`, the nonce fresh for every call, so that no two calls carry the
//    same signature even within a second. It is signed: an HMAC-SHA256 over five lines joined by "\n", with no trailing newline,
//      cfo-platform-call/v1
//      <method>
//      <path>
//      <timestamp: Unix seconds in decimal, exactly as sent>
//      <lowercase hex SHA-256 of the exact body bytes>
//    under a key derived from the installation's Omnigent cookie secret, which only the platform
//    Worker and the server hold: HMAC-SHA256(key = the secret's UTF-8 bytes, message =
//    "cfo-platform-call-key/v1"). Whoever holds that secret can already mint the owner's Omnigent
//    sessions, so the derived key gives nobody a new power; the label keeps the two uses apart.
//    The server checks, before any effect: the two headers, the signature in constant time, the
//    timestamp within PLATFORM_CALL_MAX_SKEW_S of its clock, and a signature not seen before
//    (401 `unauthorized`); then the body (400 `bad_request`). A change it applies is held by the
//    response barrier until it is replicated (200 with `x-cfo-durability: confirmed`), or answered
//    424 `durability_unconfirmed` (ADR 0003).

/** Omnigent's minimum password length (`accounts_auth._MIN_PASSWORD_LENGTH`), in characters. */
export const MIN_OWNER_PASSWORD_LENGTH = 8;
/**
 * The page's maximum, in characters: well under Omnigent's 1024, and small enough that the form's
 * two fields stay inside the pages' 4 KiB body bound however the browser encodes them.
 */
export const MAX_OWNER_PASSWORD_LENGTH = 128;

/** A password's length as Omnigent counts it (Python's `len`: Unicode code points). */
export function ownerPasswordLength(password: string): number {
  return [...password].length;
}

/** Why a password is not acceptable, or null. Never names the password. */
export function ownerPasswordProblem(password: string): "too_short" | "too_long" | null {
  const length = ownerPasswordLength(password);
  if (length < MIN_OWNER_PASSWORD_LENGTH) return "too_short";
  if (length > MAX_OWNER_PASSWORD_LENGTH) return "too_long";
  return null;
}

/** A password the page may set: 8 to 128 characters (the code-point rule is a refinement). */
export const OwnerPassword = z
  .string()
  .min(1)
  .max(MAX_OWNER_PASSWORD_LENGTH * 2)
  .refine((password) => ownerPasswordProblem(password) === null, {
    message: `must be ${MIN_OWNER_PASSWORD_LENGTH} to ${MAX_OWNER_PASSWORD_LENGTH} characters`,
  });

/** The owner's Omnigent username, as the installation configures it. */
export const OwnerUsername = z.string().min(1).max(128);

const call = {
  interfaceVersion: z.number().int().min(1),
  owner: PageOwner,
};

/** What the password page asks OmnigentServer. */
export const OwnerPasswordCall = z.discriminatedUnion("action", [
  /** The page's state for this Access session. Changes nothing but a missing intent secret. */
  z.looseObject({ action: z.literal("state"), ...call }),
  /** Sets the owner's password, after the intent token and the attempts limit. */
  z.looseObject({
    action: z.literal("set"),
    ...call,
    intent: IntentToken,
    password: OwnerPassword,
  }),
]);
export type OwnerPasswordCall = z.infer<typeof OwnerPasswordCall>;

/** Why a `set` was refused before anything reached the server. */
export const OwnerPasswordRefusal = z.enum([
  /** The request-intent token does not match this session's: a stale or foreign page. */
  "intent",
  /** Too many attempts reached the server lately; `retryAfterSeconds` says when to try again. */
  "rate_limited",
  /** The installation names no owner, or holds no cookie secret: nothing can be set. */
  "not_configured",
]);
export type OwnerPasswordRefusal = z.infer<typeof OwnerPasswordRefusal>;

const retryAfter = z.number().int().min(1).max(3600);

/** The answer to a `set`, by its outcome. */
export const SetOwnerPasswordResult = z.discriminatedUnion("outcome", [
  /** Set, and durable: the server's barrier confirmed it. Every older session is signed out. */
  z.looseObject({ action: z.literal("set"), outcome: z.literal("done") }),
  /** Applied, but its durability is not confirmed (424, or no confirmation): set it again. */
  z.looseObject({ action: z.literal("set"), outcome: z.literal("unconfirmed") }),
  /** The server is stopped, starting, restoring or lost the answer: try again. */
  z.looseObject({
    action: z.literal("set"),
    outcome: z.literal("unavailable"),
    retryAfterSeconds: retryAfter,
  }),
  z.looseObject({
    action: z.literal("set"),
    outcome: z.literal("refused"),
    reason: OwnerPasswordRefusal,
    retryAfterSeconds: retryAfter.optional(),
  }),
  /** The server refused or failed it for another reason (logged by status). */
  z.looseObject({ action: z.literal("set"), outcome: z.literal("failed") }),
]);
export type SetOwnerPasswordResult = z.infer<typeof SetOwnerPasswordResult>;

/** OmnigentServer's answer. */
export const OwnerPasswordResult = z.discriminatedUnion("action", [
  z.looseObject({
    action: z.literal("state"),
    /** `unchosen`: the installer chose no password and none has been set on the page yet. */
    state: z.enum(["unchosen", "chosen"]),
    /** The owner's Omnigent username, or null when the installation names none. */
    username: OwnerUsername.nullable(),
    intentToken: IntentToken,
  }),
  SetOwnerPasswordResult,
]);
export type OwnerPasswordResult = z.infer<typeof OwnerPasswordResult>;

// ---------------------------------------------------------------------------------------------
// The platform call.

/** Every platform call's path starts with this; OmnigentServer never forwards one. */
export const PLATFORM_CALL_PATH_PREFIX = "/_cfo/";
export const OWNER_PASSWORD_CALL_PATH = "/_cfo/owner-password";
export const PLATFORM_CALL_PROTOCOL = "cfo-platform-call/v1";
export const PLATFORM_CALL_KEY_LABEL = "cfo-platform-call-key/v1";
export const PLATFORM_CALL_TIMESTAMP_HEADER = "x-cfo-call-timestamp";
export const PLATFORM_CALL_SIGNATURE_HEADER = "x-cfo-call-signature";
/** Bounds a replay together with the server's memory of the signatures it has seen. */
export const PLATFORM_CALL_MAX_SKEW_S = 60;
export const MAX_PLATFORM_CALL_BODY_BYTES = 4096;

/** A platform call's nonce: 16 random bytes, lowercase hex. */
export const PlatformCallNonce = z.string().regex(/^[0-9a-f]{32}$/);

/** The platform call's body. */
export const OwnerPasswordCallBody = z.strictObject({
  password: OwnerPassword,
  nonce: PlatformCallNonce,
});
export type OwnerPasswordCallBody = z.infer<typeof OwnerPasswordCallBody>;

/**
 * Whether a path, as Starlette would match it after uvicorn's percent-decoding, is a platform
 * call's. A path that does not decode is treated as one (refused): uvicorn would not serve it
 * either way. Repeated slashes are collapsed first, so `//_cfo/…` counts too.
 */
export function isPlatformCallPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  const path = decoded.replace(/\/{2,}/g, "/");
  return (
    path === PLATFORM_CALL_PATH_PREFIX.slice(0, -1) || path.startsWith(PLATFORM_CALL_PATH_PREFIX)
  );
}

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array, message: Uint8Array): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, message as Uint8Array<ArrayBuffer>);
}

/** The platform call's key, derived from the installation's Omnigent cookie secret. */
export async function platformCallKey(cookieSecret: string): Promise<Uint8Array> {
  return new Uint8Array(
    await hmac(encoder.encode(cookieSecret), encoder.encode(PLATFORM_CALL_KEY_LABEL)),
  );
}

/** The canonical string a platform call's signature covers. */
export function platformCallStringToSign(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly bodySha256: string;
}): string {
  return [PLATFORM_CALL_PROTOCOL, input.method, input.path, input.timestamp, input.bodySha256].join(
    "\n",
  );
}

/** The two headers of one platform call. */
export async function signPlatformCall(input: {
  readonly cookieSecret: string;
  readonly method: string;
  readonly path: string;
  /** Unix seconds. */
  readonly timestamp: number;
  readonly body: Uint8Array;
}): Promise<Record<string, string>> {
  const timestamp = String(Math.floor(input.timestamp));
  const bodySha256 = hex(
    await crypto.subtle.digest("SHA-256", input.body as Uint8Array<ArrayBuffer>),
  );
  const message = platformCallStringToSign({
    method: input.method,
    path: input.path,
    timestamp,
    bodySha256,
  });
  const signature = hex(
    await hmac(await platformCallKey(input.cookieSecret), encoder.encode(message)),
  );
  return {
    [PLATFORM_CALL_TIMESTAMP_HEADER]: timestamp,
    [PLATFORM_CALL_SIGNATURE_HEADER]: signature,
  };
}
