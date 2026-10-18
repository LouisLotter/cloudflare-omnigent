// Spike S5: the platform-login card. One page that shows the platform's own Omnigent login and,
// when it needs the owner, asks for the Omnigent password once. Pure: a function of the status.

import type { LoginStatus, ReauthReason } from "./platform-login.ts";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** What the owner reads for each cause. Revocation and a password change look the same to the platform. */
export const REASON_TEXT: Record<ReauthReason, string> = {
  no_credentials: "The platform has never signed in to Omnigent.",
  credentials_rejected: "Omnigent did not accept the setup password.",
  login_without_refresh:
    "Omnigent accepted the password but did not issue a long-lived sign-in. Try again in a minute.",
  grant_unusable: "Omnigent issued a sign-in that did not work.",
  grant_expired: "The platform's sign-in reached the end of its lifetime.",
  grant_rejected:
    "Omnigent no longer accepts the platform's sign-in. It was signed out, or the Omnigent password was changed or reset.",
};

export const CARD_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const EXPIRY_WARNING_SECONDS = 7 * 86_400;

function when(epochSeconds: number | null): string {
  return epochSeconds === null ? "never" : new Date(epochSeconds * 1000).toISOString();
}

export function renderLoginCard(
  status: LoginStatus,
  formToken: string,
  message?: "repaired" | "wrong_password" | "failed",
): string {
  const parts: string[] = [];
  const needs = status.state !== "ok";
  if (needs) {
    const why =
      status.reason !== null ? REASON_TEXT[status.reason] : "The platform is not signed in.";
    parts.push(
      `<p data-state="needs_reauthentication" data-reason="${escapeHtml(status.reason ?? "none")}"><strong>Omnigent sign-in needed.</strong> ${escapeHtml(why)}</p>`,
      "<p>Until then, schedules and computer status show the last good data, marked as stale. Nothing else stops.</p>",
    );
  } else {
    parts.push(
      `<p data-state="ok">The platform is signed in to Omnigent. Last confirmed ${escapeHtml(when(status.lastGoodAt))}.</p>`,
    );
    if (status.expiresInSeconds !== null && status.expiresInSeconds < EXPIRY_WARNING_SECONDS) {
      const days = Math.max(0, Math.floor(status.expiresInSeconds / 86_400));
      parts.push(
        `<p data-warning="expiry">The sign-in ends in ${days} day(s). Renew it now to avoid an interruption.</p>`,
      );
    }
  }
  if (message === "repaired") parts.push('<p data-message="repaired">Signed in again.</p>');
  if (message === "wrong_password") {
    parts.push('<p data-message="wrong_password">That password did not work.</p>');
  }
  if (message === "failed") {
    parts.push('<p data-message="failed">Omnigent did not complete the sign-in. Try again.</p>');
  }
  const showForm = needs || (status.expiresInSeconds ?? Infinity) < EXPIRY_WARNING_SECONDS;
  if (showForm) {
    parts.push(
      '<form method="post" action="/platform/login/repair" autocomplete="off">',
      `<input type="hidden" name="form_token" value="${escapeHtml(formToken)}">`,
      '<label>Your Omnigent password <input type="password" name="password" required maxlength="1024" autocomplete="current-password"></label>',
      '<button type="submit">Sign the platform in</button>',
      "</form>",
      "<p>The platform uses the password once and does not keep it.</p>",
    );
  }
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Platform sign-in</title></head><body>",
    "<h1>Platform sign-in to Omnigent</h1>",
    ...parts,
    "</body></html>",
  ].join("\n");
}
