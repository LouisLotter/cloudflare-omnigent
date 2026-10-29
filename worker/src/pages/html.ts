// The platform pages' layout and styles (WP3.5). Every untrusted value (names, reasons) goes
// through `escapeHtml`; nothing here builds markup from a value without it. No inline script:
// the Content Security Policy allows scripts from this origin only.

import { escapeHtml } from "./http.ts";
import type { Notice, Tone } from "./view.ts";

/** Omnigent's own interface for adding and deleting computers (core change 13's UI). */
export const OMNIGENT_COMPUTERS_PATH = "/settings/computers";
export const PAGES_ROOT = "/platform";
export const COMPUTERS_PATH = `${PAGES_ROOT}/computers`;
export const ASSETS_PATH = `${PAGES_ROOT}/assets`;
/** The owner's Omnigent password: choose it, or reset a forgotten one (WP3.34). */
export const PASSWORD_PAGE_PATH = `${PAGES_ROOT}/password`;
/** The GitHub App's setup URL: GitHub sends the owner here after installing it (WP3.36). */
export const GITHUB_SETUP_PAGE_PATH = `${PAGES_ROOT}/github`;

export function computerPath(id: string): string {
  return `${COMPUTERS_PATH}/${id}`;
}

export const PAGES_CSS = `
:root { color-scheme: light dark; --bg: #f7f7f5; --fg: #1b1b1a; --muted: #6a6a66; --card: #fff;
  --line: #deded9; --ok: #1f7a3f; --info: #2f5f9e; --warn: #9a6200; --danger: #b3261e;
  --accent: #1b1b1a; --accent-fg: #fff; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a2a29c;
  --card: #1f1f1e; --line: #33332f; --ok: #5cc184; --info: #7ea8e6; --warn: #e0a64a;
  --danger: #f08a80; --accent: #ececea; --accent-fg: #161615; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header.top { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  padding: 14px 16px; border-bottom: 1px solid var(--line); }
header.top strong { font-size: 16px; }
header.top a { color: var(--muted); }
main { max-width: 1040px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 28px 0 8px; }
h3 { font-size: 16px; margin: 0 0 6px; }
p { margin: 6px 0; }
a { color: var(--info); }
.muted { color: var(--muted); }
.cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
.card.open { border-color: var(--warn); }
.badge { display: inline-block; font-size: 12px; font-weight: 600; padding: 1px 8px;
  border-radius: 999px; border: 1px solid currentColor; }
.tone-ok { color: var(--ok); } .tone-info { color: var(--info); }
.tone-warn { color: var(--warn); } .tone-danger { color: var(--danger); }
.notice { border-left: 4px solid currentColor; background: var(--card); padding: 8px 12px;
  margin: 8px 0; border-radius: 4px; }
.notice span { color: var(--fg); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
button, .button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line);
  background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; display: inline-block; }
button.primary, .button.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
button.danger, .button.danger { color: var(--danger); border-color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
select { font: inherit; padding: 5px; border-radius: 6px; }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg);
  padding: 1px 5px; border-radius: 4px; border: 1px solid var(--line); }
ol.steps li { margin: 6px 0; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0; }
dl.facts dt { color: var(--muted); } dl.facts dd { margin: 0; }
.terminal-panel { background: var(--card); border: 1px solid var(--line); border-radius: 10px;
  padding: 12px; margin-top: 8px; }
#terminal { height: 420px; background: #000; border-radius: 6px; padding: 4px; overflow: hidden; }
#terminal[hidden] { display: none; }
form.password { display: grid; gap: 12px; max-width: 440px; margin-top: 16px; }
form.password label { display: grid; gap: 4px; font-weight: 600; }
form.password input { font: inherit; font-weight: 400; padding: 8px 10px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--card); color: var(--fg); }
form.password input[readonly] { color: var(--muted); background: var(--bg); }
.layout { display: grid; gap: 16px; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); }
@media (max-width: 820px) { .layout { grid-template-columns: 1fr; } }
`;

/** A page that loads `url` (a path on this origin) again after `seconds`, with no script. */
export interface Refresh {
  readonly seconds: number;
  readonly url: string;
}

export function layout(
  title: string,
  body: string,
  scripts: readonly string[] = [],
  refresh?: Refresh,
): string {
  const tags = scripts.map((src) => `<script src="${escapeHtml(src)}" defer></script>`).join("\n");
  if (refresh !== undefined && (!refresh.url.startsWith("/") || refresh.url.startsWith("//"))) {
    throw new Error("a page refreshes to a path on its own origin");
  }
  const reload =
    refresh === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${Math.max(1, Math.floor(refresh.seconds))};url=${escapeHtml(refresh.url)}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
${reload}<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${ASSETS_PATH}/pages.css">
${tags}
</head>
<body>
<header class="top">
  <strong>Cloud computers</strong>
  <a href="${COMPUTERS_PATH}">All computers</a>
  <a href="${PASSWORD_PAGE_PATH}">Omnigent password</a>
  <a href="/">Back to Omnigent</a>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function badge(tone: Tone, text: string): string {
  return `<span class="badge tone-${tone}">${escapeHtml(text)}</span>`;
}

export function notice(n: Notice): string {
  return `<div class="notice tone-${n.tone}" data-notice="${n.kind}"><span>${escapeHtml(n.text)}</span></div>`;
}

/** A hidden field. */
export function hidden(name: string, value: string): string {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
