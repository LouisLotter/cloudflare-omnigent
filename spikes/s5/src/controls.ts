// Spike S5: campaign controls (IR-017, spikes/README.md "Campaign controls").
//
// Being admitted by Access is not permission to change anything. Every spike route that changes
// state is a control:
//   - GET or HEAD only renders a confirmation page whose button POSTs back; it writes nothing.
//   - A POST is accepted only with an Origin exactly equal to the deployment's own (missing,
//     `null` and foreign origins refused; `Sec-Fetch-Site`, when present, must be `same-origin`)
//     and a request-intent token: a random value the Worker stores and embeds in the confirmation
//     page, compared in constant time. A page on another site cannot read it.
//   - Fault-injection and scenario controls also need an armed campaign, which disarms itself
//     after a bounded time.
// Pure: runs in Node and workerd alike.

import { base64UrlEncode } from "./access.ts";
import { escapeHtml } from "./repair-card.ts";

export type ControlRefusal = "bad_origin" | "bad_intent" | "not_armed" | "controls_disabled";

export interface ControlSpec {
  readonly title: string;
  /** Fault-injection and scenario controls run only inside an armed campaign. */
  readonly needsArm: boolean;
  /** Extra form fields the confirmation page offers, with their defaults. */
  readonly fields?: Readonly<Record<string, string>>;
}

export const CONTROLS: Readonly<Record<string, ControlSpec>> = {
  "/__s5/arm": {
    title: "Arm a test campaign (fault and scenario controls work until it disarms itself)",
    needsArm: false,
    fields: { seconds: String(20 * 60) },
  },
  "/__s5/disarm": { title: "Disarm the test campaign", needsArm: false },
  "/__s5/run": {
    title:
      "Run S5: the Access self-test, requests through the proxy, and the platform-login scenarios",
    needsArm: true,
  },
  "/__s5/fault/revoke-grant": { title: "Fault: revoke the platform's grant", needsArm: true },
  "/__s5/fault/drop-access": { title: "Fault: forget the cached access token", needsArm: true },
  "/platform/bootstrap": {
    title: "Sign the platform in with the bootstrap secret",
    needsArm: false,
  },
  "/platform/schedules": { title: "Read the schedules with the platform's grant", needsArm: false },
};

export const ARM_DEFAULT_SECONDS = 20 * 60;
export const ARM_MAX_SECONDS = 60 * 60;

export interface CampaignState {
  /** The current request-intent token. */
  readonly intent?: string;
  /** Epoch milliseconds; armed while now is before it. */
  readonly armedUntil?: number;
}

export function newIntent(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** The token in force: the stored one, else the deployment's seed. Undefined disables controls. */
export function currentIntent(state: CampaignState | undefined, seed: string | undefined) {
  const intent = state?.intent ?? seed;
  return intent !== undefined && intent.length >= 32 ? intent : undefined;
}

export function isArmed(state: CampaignState | undefined, nowMs: number): boolean {
  return state?.armedUntil !== undefined && nowMs < state.armedUntil;
}

export function armUntil(nowMs: number, seconds: string | null | undefined): number {
  const asked = Number(seconds ?? ARM_DEFAULT_SECONDS);
  const bounded = Number.isFinite(asked)
    ? Math.min(Math.max(Math.floor(asked), 1), ARM_MAX_SECONDS)
    : ARM_DEFAULT_SECONDS;
  return nowMs + bounded * 1000;
}

/** The checks before any effect, in order: origin, intent, arming. */
export function checkControl(input: {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly expectedOrigin: string;
  readonly presented: string | null;
  readonly expected: string | undefined;
  readonly needsArm: boolean;
  readonly armed: boolean;
}): ControlRefusal | undefined {
  if (input.origin === null || input.origin !== input.expectedOrigin) return "bad_origin";
  if (input.secFetchSite !== null && input.secFetchSite !== "same-origin") return "bad_origin";
  if (input.expected === undefined) return "controls_disabled";
  if (input.presented === null || !constantTimeEqual(input.presented, input.expected)) {
    return "bad_intent";
  }
  if (input.needsArm && !input.armed) return "not_armed";
  return undefined;
}

export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

/** The confirmation page a GET shows: what the control does, and one button that POSTs it. */
export function renderConfirmation(
  path: string,
  intent: string,
  armedUntil: number | undefined,
  nowMs: number,
  message?: string,
): string {
  const spec = CONTROLS[path];
  const title = spec?.title ?? path;
  const fields = Object.entries(spec?.fields ?? {})
    .map(
      ([name, value]) =>
        `<label>${escapeHtml(name)} <input name="${escapeHtml(name)}" value="${escapeHtml(value)}"></label>`,
    )
    .join("\n");
  const armed =
    armedUntil !== undefined && nowMs < armedUntil
      ? `<p data-armed="true">Campaign armed until ${escapeHtml(new Date(armedUntil).toISOString())}.</p>`
      : '<p data-armed="false">No campaign is armed.</p>';
  const others = Object.keys(CONTROLS)
    .filter((p) => p !== path)
    .map((p) => `<li><a href="${escapeHtml(p)}">${escapeHtml(CONTROLS[p]?.title ?? p)}</a></li>`)
    .join("\n");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>S5 control</title></head><body>",
    `<h1>${escapeHtml(title)}</h1>`,
    message ? `<p data-message="${escapeHtml(message)}">${escapeHtml(message)}</p>` : "",
    armed,
    `<form method="post" action="${escapeHtml(path)}">`,
    `<input type="hidden" name="intent" value="${escapeHtml(intent)}">`,
    fields,
    '<button type="submit">Confirm</button>',
    "</form>",
    `<ul>${others}</ul>`,
    "</body></html>",
  ].join("\n");
}
