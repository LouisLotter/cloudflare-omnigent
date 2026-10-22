// Campaign controls for the harness page (spikes/README.md, "Campaign controls (IR-017)"),
// as spike S7 built them. Pure functions, no Workers APIs, unit-tested directly.
//
//   - A GET or HEAD never changes state.
//   - A change is a POST whose Origin is exactly the deployment's own origin (Sec-Fetch-Site,
//     when present, must be same-origin) and which carries a request-intent token the Durable
//     Object stored (its hash only) and embedded in the page, compared in constant time.
//   - A run is bounded: it disarms itself, stops the container and forgets the R2 credentials
//     when its window ends (RUN_WINDOW_MS in plan.ts).

/** How long a request-intent token embedded in a page stays valid. */
export const INTENT_TTL_MS = 60 * 60_000;
/** Tokens kept at once, so a cross-site GET that mints a new one cannot evict the owner's tab. */
export const MAX_INTENTS = 16;
export const INTENT_HEADER = "x-drill-intent";

export type OriginVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** The Origin and Sec-Fetch-Site rule for every state-changing request. */
export function checkOrigin(request: Request): OriginVerdict {
  const own = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin === null) return { ok: false, reason: "missing-origin" };
  if (origin === "null") return { ok: false, reason: "null-origin" };
  if (origin !== own) return { ok: false, reason: "foreign-origin" };
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return { ok: false, reason: "sec-fetch-site" };
  return { ok: true };
}

/** Compares two strings without an early exit; unequal lengths still cost a full pass. */
export function constantTimeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface StoredIntent {
  /** SHA-256 of the token; the token itself is never stored. */
  readonly hash: string;
  readonly expiresAt: number;
}

/** Drops expired tokens and keeps room for one more within MAX_INTENTS. */
export function pruneIntents(intents: readonly StoredIntent[], now: number): StoredIntent[] {
  return intents.filter((i) => i.expiresAt > now).slice(-(MAX_INTENTS - 1));
}

/** True when the token matches an unexpired stored intent. Every entry is compared. */
export async function intentMatches(
  token: string | null,
  intents: readonly StoredIntent[],
  now: number,
): Promise<boolean> {
  const hash = await sha256Hex(token ?? "");
  let found = false;
  for (const intent of intents) {
    const equal = constantTimeEqual(hash, intent.hash);
    found = (equal && intent.expiresAt > now && token !== null && token !== "") || found;
  }
  return found;
}
