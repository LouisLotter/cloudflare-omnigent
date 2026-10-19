// Campaign controls for the S7 staging page (spikes/README.md, "Campaign controls (IR-017)").
// Pure functions, no Workers APIs, so the rules are unit-tested directly.
//
//   - A GET or HEAD never changes state. A GET to a control URL shows a confirmation page.
//   - A change is a POST whose Origin is exactly the deployment's own origin (Sec-Fetch-Site,
//     when present, must be same-origin) and which carries a request-intent token the Worker
//     stored and embedded in the page, compared in constant time.
//   - Campaign routes (container start, server replacement, the computer run, logins and
//     records) are off unless a campaign is armed by such a POST, and disarm after a bounded time.

/** How long one arming lasts. The S7 run takes about 15 minutes. */
export const CAMPAIGN_WINDOW_MS = 30 * 60_000;
/** How long a request-intent token embedded in a page stays valid. */
export const INTENT_TTL_MS = 2 * 60 * 60_000;
/** Tokens kept at once, so a cross-site GET that mints a new one cannot evict the owner's tab. */
export const MAX_INTENTS = 16;
export const INTENT_HEADER = "x-s7-intent";

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

export function newIntentToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
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

/** Routes that change the experiment; they run only while a campaign is armed. */
export const CAMPAIGN_ROUTES: readonly string[] = [
  "/__s7/api/start",
  "/__s7/api/login",
  "/__s7/api/inspect",
  "/__s7/api/replace",
  "/__s7/api/computer-run",
  "/__s7/api/record",
];

/** Every POST route: the campaign routes, arming, and the polling reads. */
export const POST_ROUTES: readonly string[] = [
  ...CAMPAIGN_ROUTES,
  "/__s7/api/arm",
  "/__s7/api/disarm",
  "/__s7/api/job",
  "/__s7/api/computer-result",
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * What a GET to a control URL returns: an explanation and a button. Nothing happens until the
 * owner presses it, and the button sends a same-origin POST with the embedded token.
 */
export function confirmationPage(path: string, token: string): string {
  const action = escapeHtml(path);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Confirm S7 action</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root { color-scheme: light dark; font-family: system-ui, sans-serif; } body { margin: 16px; }</style>
</head><body>
<h1>Confirm an S7 action</h1>
<p>This link asks for <code>POST ${action}</code>. Nothing has happened yet.</p>
<p>Campaign actions run only while a campaign is armed from <a href="/__s7/">the S7 page</a>.</p>
<button id="go">Confirm</button>
<pre id="out"></pre>
<script>
document.getElementById("go").onclick = async () => {
  const res = await fetch(${JSON.stringify(path)}, { method: "POST", headers: { "content-type": "application/json", "${INTENT_HEADER}": ${JSON.stringify(token)} }, body: "{}", credentials: "same-origin" });
  document.getElementById("out").textContent = res.status + " " + await res.text();
};
</script></body></html>`;
}
