// The installer's GitHub App step (WP5.9, WP3.36; owner decisions D22 and D37):
// `bootstrap.ts github-app`. It registers the installation's own GitHub App through GitHub's
// manifest flow, so the owner's only part on GitHub is the "Create GitHub App" button and then
// "Install", gives the platform Worker everything Omnigent's GitHub linking needs, in one secrets
// change, and sends the owner on only once the server reports GitHub linking on:
//   1. checks the plan's platform Worker exists, is this installation's, runs a release with the
//      key service and the GitHub setup page (else: run `bootstrap.ts update` first), and has no
//      App yet (unless --replace);
//   2. serves a one-time page on 127.0.0.1 that posts the App's manifest to GitHub, and opens it
//      in the browser (`xdg-open`, `open`, or `start`; the address is printed too);
//   3. GitHub shows the App to create; the owner clicks "Create GitHub App"; GitHub sends the
//      browser back to this page's callback with a one-time code and the state it was given. The
//      browser goes on at once to this page's progress page, which loads itself again every few
//      seconds and says what the installer is doing;
//   4. exchanges the code with GitHub (`POST /app-manifests/{code}/conversions`) for the App's
//      ID, slug, client ID and client secret;
//   5. sets them as the platform Worker's secrets (`SERVER_ENV_OMNIGENT_GITHUB_APP_*`), with the
//      callback on the installation's hostname, and the key service's keys if the Worker has none
//      yet: the server's signing pair and the Worker-only record keys, generated here. One change
//      of the Worker's secrets (the bootstrap's transport, `updateSecrets`): a new version;
//   6. waits until a server started with that version's configuration reports GitHub linking on
//      (WP3.36): the watchdog's status line from that version, in Workers Logs, the reader `update`
//      uses (`slicedLogs`, `parseLogs`, `pollServer`). The platform yields the server's object to
//      the new version within about a minute (the cron, OmnigentServer.ensureStarted), and its
//      watchdog restarts the server with the new settings once;
//   7. only then sends the browser on to GitHub's page that installs the App on the owner's
//      account. GitHub's "Install" returns the browser to the App's setup URL, the installation's
//      GitHub setup page (`/platform/github`, behind Access), which opens Omnigent's
//      Integrations page, where "Connect GitHub" is.
// If GitHub linking does not come on, the progress page and the installer say so plainly and
// never "done": the server restarted with the App's settings but GitHub linking is off, the
// server refused a setting and is stopped (exit 78), or the wait ran out (then the install link
// still leads to the setup page, which keeps waiting and says what is wrong).
//
// The local page waits an hour for GitHub (`DEFAULT_GITHUB_APP_TIMEOUT_MS`). When that runs out,
// nothing has been changed, and the page keeps answering for a while (`EXPIRED_PAGE_MS`) with a
// page that says the link expired and what to do, so a late click on GitHub never lands on a
// dead address while the installer is still there to explain it.
//
// What it never does: print, log, write to a file or put in an argument any secret (the client
// secret, the signing key, the record keys), or keep the App's private key or webhook secret,
// which GitHub's answer also carries: Omnigent's linking uses neither, and the private key would
// let whoever holds it act as the App on every repository it is installed on. Existing key-service
// keys are never replaced: records sealed under them would no longer open. It never talks to the
// installation itself (Access is in front of it): what it knows of the server comes from Workers
// Logs.
//
// The App asks for the least Omnigent's linking needs (the fork's docs/GITHUB_APP_SETUP.md):
// repository contents read and write (clone, push), metadata read (GitHub's mandatory minimum),
// pull requests read and write (gh pr create, the side panel's PR view). No account or
// organization permission, no webhook, installable only on the account that creates it.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KEY_SERVICE_SECRETS, recordKeysSecret } from "../../worker/src/internal/key-service.ts";
import { githubAppTag } from "../../worker/src/server/github-linking.ts";
import { checkGitHubLinking, parseLogs } from "./events.ts";
import { type BootstrapCloud, slicedLogs } from "./machine.ts";
import {
  bucketTagOf,
  type Installation,
  offersPlatformFeature,
  offersWebFeature,
  SERVER_ENV,
} from "./settings.ts";
import { pollServer } from "./update.ts";
import { latestNotServing } from "./window.ts";

/** The App's settings as the platform Worker holds them; the server receives them unprefixed. */
export const GITHUB_APP_SECRETS = {
  appId: `${SERVER_ENV}OMNIGENT_GITHUB_APP_ID`,
  clientId: `${SERVER_ENV}OMNIGENT_GITHUB_APP_CLIENT_ID`,
  clientSecret: `${SERVER_ENV}OMNIGENT_GITHUB_APP_CLIENT_SECRET`,
  redirectUri: `${SERVER_ENV}OMNIGENT_GITHUB_APP_REDIRECT_URI`,
  slug: `${SERVER_ENV}OMNIGENT_GITHUB_APP_SLUG`,
} as const;

/** Omnigent's GitHub callback, on the installation's hostname. */
export const GITHUB_CALLBACK_PATH = "/v1/connections/github/callback";
/**
 * The App's setup URL: where GitHub sends the owner after installing the App, or changing its
 * repositories. The installation's GitHub setup page (WP3.36, the web Worker's
 * `/platform/github`), which opens Omnigent's Integrations page once GitHub linking is on.
 */
export const GITHUB_SETUP_PATH = "/platform/github";
/** Omnigent's Integrations settings, where "Connect GitHub" is. */
export const INTEGRATIONS_PATH = "/settings/integrations";
/** The least Omnigent's GitHub linking needs (the fork's docs/GITHUB_APP_SETUP.md, step 4). */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
};
/** GitHub's limit on an App's name. */
const MAX_APP_NAME = 34;
/** How long the owner has to click "Create" on GitHub (WP3.36: an hour, it was 15 minutes). */
export const DEFAULT_GITHUB_APP_TIMEOUT_MS = 60 * 60_000;
/** How long the local page says "expired" after that, before the installer stops. */
export const EXPIRED_PAGE_MS = 10 * 60_000;
/**
 * How long to wait for the server to report GitHub linking on: the object's switch to the new
 * version (about a minute with the cron's yield, at most about 5 minutes without), the
 * watchdog's restart and the server's start, with a margin.
 */
export const DEFAULT_LINKING_WAIT_MS = 20 * 60_000;
/** Between two Workers Logs queries while waiting. */
export const DEFAULT_LINKING_POLL_MS = 20_000;
/** How long the installer stays for the browser to fetch the progress page's last answer. */
export const FINAL_PAGE_MS = 60_000;
/** How often the local progress page loads itself again. */
const PROGRESS_REFRESH_S = 3;
/** The platform features the step relies on (settings.ts, PLATFORM_FEATURES). */
const NEEDED_FEATURES = ["key-service", "github-setup"] as const;

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CLIENT_SECRET = /^[!-~]{1,256}$/;

/** A refusal the installer can act on: the message says what to do. Never carries a secret. */
export class GitHubAppRefusal extends Error {}

/** What the step needs of Cloudflare: the bootstrap's own adapter (cloud.ts, staging.ts). */
export type GitHubAppCloud = Pick<
  BootstrapCloud,
  "secretNames" | "workerInstallation" | "updateSecrets" | "logs" | "versions"
>;

export interface GitHubAppPorts {
  readonly cloud: GitHubAppCloud;
  /** Opens a URL in the person's browser. The URL never holds a secret. */
  openBrowser(url: string): void;
  /** Reaches GitHub's API, and only that: the manifest conversion. */
  githubApi(url: string, init: RequestInit): Promise<Response>;
  random(bytes: number): Uint8Array;
  /** The clock and the pause of the wait for the server (tests drive a fake Cloudflare's). */
  now(): number;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
}

export interface GitHubAppOptions {
  /** Create the App under this organization instead of the person's own account. */
  readonly org?: string;
  /** Create a new App although the Worker holds one; the old one stays on GitHub. */
  readonly replace?: boolean;
  /** How long the owner has to click "Create" on GitHub. */
  readonly timeoutMs?: number;
  /** How long the expired page answers after that. */
  readonly expiredPageMs?: number;
  /** How long to wait for the server to report GitHub linking on. */
  readonly linkingWaitMs?: number;
  readonly linkingPollMs?: number;
  /** How long to stay for the browser's last answer. */
  readonly finalPageMs?: number;
  /** The local page's port: 0 (the default) lets the system choose. */
  readonly port?: number;
}

/**
 * How the step ended once the App was stored. `on`: GitHub linking is on, and the browser went
 * on to install the App. Otherwise the App is stored, but linking is not on: `off` (the server
 * restarted with it and Omnigent does not list GitHub), `held` (the server refused a setting and
 * is stopped), or `waiting` (the wait ran out; `why` says what was seen last).
 */
export type GitHubAppOutcome =
  | { readonly kind: "on"; readonly slug: string; readonly installUrl: string }
  | { readonly kind: "off" | "held"; readonly slug: string; readonly installUrl: string }
  | {
      readonly kind: "waiting";
      readonly slug: string;
      readonly installUrl: string;
      readonly why: string;
    };

/** What GitHub's conversion answer gives the installation, once checked. Secrets included. */
export interface CreatedApp {
  readonly id: number;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly permissions: Readonly<Record<string, string>>;
}

export interface Manifest {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly redirect_url: string;
  readonly callback_urls: readonly string[];
  readonly setup_url: string;
  readonly setup_on_update: boolean;
  readonly request_oauth_on_install: boolean;
  readonly public: boolean;
  readonly hook_attributes: { readonly url: string; readonly active: boolean };
  readonly default_permissions: Readonly<Record<string, string>>;
  readonly default_events: readonly string[];
}

/**
 * The App's name: short, the installation's, and with a suffix of its own, since GitHub App
 * names are unique across GitHub and an earlier attempt may have left an App behind.
 */
export function appName(installationId: string, suffix: string): string {
  return `Omnigent ${bucketTagOf(installationId)} ${suffix}`.slice(0, MAX_APP_NAME);
}

/** The manifest GitHub registers: callback and setup on the installation's hostname. */
export function githubAppManifest(
  plan: Installation,
  redirectUrl: string,
  suffix: string,
): Manifest {
  const origin = `https://${plan.hostname}`;
  return {
    name: appName(plan.installationId, suffix),
    url: origin,
    description: `Omnigent's GitHub linking for ${plan.hostname} (cloudflare-omnigent).`,
    redirect_url: redirectUrl,
    callback_urls: [`${origin}${GITHUB_CALLBACK_PATH}`],
    setup_url: `${origin}${GITHUB_SETUP_PATH}`,
    // Back to the setup page after a change of the App's repositories too: it opens Omnigent's
    // Integrations page at once while GitHub linking is on.
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    hook_attributes: { url: `${origin}/`, active: false },
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}

/** Where the manifest is posted: the person's account, or an organization's. */
export function manifestAction(state: string, org?: string): string {
  if (org !== undefined && !ORG.test(org)) {
    throw new GitHubAppRefusal(`--github-org must be a GitHub organization's name`);
  }
  const base =
    org === undefined
      ? `${GITHUB}/settings/apps/new`
      : `${GITHUB}/organizations/${org}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** The App's settings on GitHub: under the person's account, or the organization's. */
export function appSettingsUrl(slug: string, org?: string): string {
  return org === undefined
    ? `${GITHUB}/settings/apps/${slug}`
    : `${GITHUB}/organizations/${org}/settings/apps/${slug}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The one-time page: a form that posts the manifest to GitHub, sent at once. */
export function manifestPage(action: string, manifest: Manifest): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create the GitHub App</title>
<meta name="referrer" content="no-referrer"></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto">
<h1>Create Omnigent's GitHub App</h1>
<p>Taking you to GitHub. There, click <strong>Create GitHub App</strong>.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.forms[0].submit();</script>
</body></html>
`;
}

/** A plain page: a title, paragraphs, an optional link, and an optional reload of itself. */
export function page(
  title: string,
  text: string | readonly string[],
  options: { readonly link?: { href: string; label: string }; readonly refreshS?: number } = {},
): string {
  const paragraphs = (typeof text === "string" ? [text] : text)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("\n");
  const link =
    options.link === undefined
      ? ""
      : `\n<p><a href="${escapeHtml(options.link.href)}">${escapeHtml(options.link.label)}</a></p>`;
  const refresh =
    options.refreshS === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${options.refreshS}">\n`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
${refresh}<meta name="referrer" content="no-referrer"></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto">
<h1>${escapeHtml(title)}</h1>
${paragraphs}${link}
</body></html>
`;
}

/** GitHub's conversion answer, checked; a malformed one is refused without repeating it. */
export function parseConversion(body: unknown): CreatedApp {
  const o = (body ?? {}) as Record<string, unknown>;
  const { id, slug, client_id: clientId, client_secret: clientSecret } = o;
  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    typeof slug !== "string" ||
    !SLUG.test(slug) ||
    typeof clientId !== "string" ||
    !CLIENT_ID.test(clientId) ||
    typeof clientSecret !== "string" ||
    !CLIENT_SECRET.test(clientSecret)
  ) {
    throw new GitHubAppRefusal("GitHub's answer was not a GitHub App's credentials");
  }
  const raw = o.permissions;
  const permissions: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [name, level] of Object.entries(raw)) {
      if (typeof level === "string") permissions[name] = level;
    }
  }
  return { id, slug, clientId, clientSecret, permissions };
}

/** Permissions GitHub granted beyond what the manifest asked for: names only. */
export function extraPermissions(granted: Readonly<Record<string, string>>): string[] {
  const rank = (level: string | undefined) => (level === "write" ? 2 : level === "read" ? 1 : 0);
  return Object.entries(granted)
    .filter(([name, level]) => rank(level) > rank(APP_PERMISSIONS[name]))
    .map(([name, level]) => `${name}: ${level}`)
    .sort();
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The secrets change: the App's settings, always, and the key service's keys only where the
 * Worker holds none. A half-present signing pair is refused: the Worker is in a state a person
 * must look at, and replacing either half would break the records or the server's signatures.
 */
export function githubAppChanges(
  plan: Installation,
  app: CreatedApp,
  present: ReadonlySet<string>,
  random: (bytes: number) => Uint8Array,
): Record<string, string> {
  const changes: Record<string, string> = {
    [GITHUB_APP_SECRETS.appId]: String(app.id),
    [GITHUB_APP_SECRETS.clientId]: app.clientId,
    [GITHUB_APP_SECRETS.clientSecret]: app.clientSecret,
    [GITHUB_APP_SECRETS.redirectUri]: `https://${plan.hostname}${GITHUB_CALLBACK_PATH}`,
    [GITHUB_APP_SECRETS.slug]: app.slug,
  };
  const hasId = present.has(KEY_SERVICE_SECRETS.currentId);
  const hasKey = present.has(KEY_SERVICE_SECRETS.current);
  if (hasId !== hasKey) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} holds only half of the key service's signing pair (${KEY_SERVICE_SECRETS.currentId}, ${KEY_SERVICE_SECRETS.current}); nothing was changed`,
    );
  }
  if (!hasId) {
    changes[KEY_SERVICE_SECRETS.currentId] = `ks-${hex(random(4))}`;
    changes[KEY_SERVICE_SECRETS.current] = hex(random(32));
  }
  if (!present.has(KEY_SERVICE_SECRETS.recordKeys)) {
    changes[KEY_SERVICE_SECRETS.recordKeys] = recordKeysSecret(
      `${plan.installationId}.records`,
      random(32),
    );
  }
  return changes;
}

/** The checks before anything is shown to the person; returns the Worker's secret names. */
async function preflight(
  plan: Installation,
  cloud: GitHubAppCloud,
  replace: boolean,
): Promise<Set<string>> {
  const names = await cloud.secretNames(plan.platformWorker);
  if (names === null) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} does not exist yet: run bootstrap.ts run first`,
    );
  }
  const identity = await cloud.workerInstallation(plan.platformWorker);
  if (!identity.exists || identity.installationId !== plan.installationId) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} is not serving installation ${plan.installationId}; nothing was changed`,
    );
  }
  const refused = await latestNotServing(cloud, plan.platformWorker, identity.versionId);
  if (refused !== undefined) throw new GitHubAppRefusal(refused);
  // The release running there must have the key service the App's settings need (WP5.9) and
  // the GitHub setup page with the server's GitHub linking report (WP3.36): an installation made
  // before them takes the release with `update` first (WP3.35).
  const missing = NEEDED_FEATURES.filter((f) => !offersPlatformFeature(identity.vars, f));
  if (missing.length > 0) {
    const what = missing.includes("key-service")
      ? "GitHub linking (it has no key service)"
      : "the GitHub setup page";
    throw new GitHubAppRefusal(
      `${plan.platformWorker} runs a release from before ${what}: update the installation first with bootstrap.ts update, then run this step again; nothing was changed`,
    );
  }
  // GitHub's Install returns to the web Worker's GitHub setup page: the web Worker must serve
  // it (an update interrupted between its two deploys leaves it without; Codex WP3.36 r1-3).
  const web = await cloud.workerInstallation(plan.webWorker);
  if (!web.exists || web.installationId !== plan.installationId) {
    throw new GitHubAppRefusal(
      `${plan.webWorker} is not serving installation ${plan.installationId}; nothing was changed`,
    );
  }
  if (!offersWebFeature(web.vars, "github-setup")) {
    throw new GitHubAppRefusal(
      `${plan.webWorker} runs a release from before the GitHub setup page: update the installation first with bootstrap.ts update, then run this step again; nothing was changed`,
    );
  }
  const present = new Set(names);
  if (!replace && present.has(GITHUB_APP_SECRETS.clientId)) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} already has a GitHub App. To make a new one, run again with --replace (then delete the old App on GitHub)`,
    );
  }
  // Checked here too, so no App is created on GitHub that could not be stored.
  if (present.has(KEY_SERVICE_SECRETS.currentId) !== present.has(KEY_SERVICE_SECRETS.current)) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} holds only half of the key service's signing pair (${KEY_SERVICE_SECRETS.currentId}, ${KEY_SERVICE_SECRETS.current}); nothing was changed`,
    );
  }
  return present;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the local page shows, by where the step is. */
type Phase =
  /** The manifest page is out; waiting for GitHub's callback. */
  | { readonly kind: "github" }
  /** The callback came: the code is being exchanged and the App stored. */
  | { readonly kind: "storing" }
  /** The App is stored: waiting for the server to report GitHub linking on. */
  | { readonly kind: "restarting"; readonly why: string }
  /** The step's last answer: on to GitHub's install page, or a page that says what happened. */
  | { readonly kind: "final"; readonly location?: string; readonly html: string }
  /** No answer from GitHub in time: nothing was changed. */
  | { readonly kind: "expired"; readonly html: string };

/** The terminal's and the progress page's words for an outcome other than "on". */
export function notOnMessage(
  plan: Installation,
  outcome: Exclude<GitHubAppOutcome, { kind: "on" }>,
  org?: string,
): { readonly title: string; readonly text: readonly string[] } {
  const stored = `GitHub App ${outcome.slug} is stored in ${plan.platformWorker}'s secrets`;
  const remove = `${appSettingsUrl(outcome.slug, org)}/advanced`;
  const setup = `https://${plan.hostname}${GITHUB_SETUP_PATH}`;
  switch (outcome.kind) {
    case "off":
      return {
        title: "GitHub linking is off",
        text: [
          `${stored}, and Omnigent's server restarted with it, but Omnigent does not turn GitHub linking on: a setting it needs is missing.`,
          `The server's config.warning line in the platform Worker's Workers Logs names what is missing. Run this step again with --replace to store a new App, then delete this one at ${remove}.`,
        ],
      };
    case "held":
      return {
        title: "Omnigent's server does not start with the App's settings",
        text: [
          `${stored}, but Omnigent's server refused one of the new settings (exit code 78) and stays stopped until the settings change, so Omnigent is down. The server's config.error line in the platform Worker's Workers Logs names the setting.`,
          `Run this step again with --replace to store a new App, then delete this one at ${remove}. If it happens again, see docs/operations/troubleshooting.md, "GitHub setup".`,
        ],
      };
    case "waiting":
      return {
        title: "GitHub linking is not on yet",
        text: [
          `${stored}, but the server has not reported GitHub linking on yet (last seen: ${outcome.why}).`,
          `You can install the App on GitHub now (${outcome.installUrl}): GitHub then brings you to your installation's GitHub setup page (${setup}), which waits until GitHub linking is on and opens "Connect GitHub", or says what is wrong.`,
        ],
      };
  }
}

/**
 * The installer's last words and exit status for an outcome: only links that work at that moment,
 * in the order the owner uses them. 0: GitHub linking is on; 3: not yet (the setup page keeps
 * waiting); 1: it is off, or the server is held.
 */
export function finalMessage(
  plan: Installation,
  outcome: GitHubAppOutcome,
  org?: string,
): { readonly lines: readonly string[]; readonly exitCode: number } {
  if (outcome.kind === "on") {
    const site = `https://${plan.hostname}`;
    return {
      lines: [
        `GitHub linking is on at ${site}.`,
        `next, in your browser (it went on by itself): install the App on GitHub, ${outcome.installUrl}; GitHub then brings you back to Omnigent's Integrations page, ${site}${INTEGRATIONS_PATH}: click "Connect GitHub" there.`,
      ],
      exitCode: 0,
    };
  }
  const words = notOnMessage(plan, outcome, org);
  return {
    lines: [`${words.title}.`, ...words.text],
    exitCode: outcome.kind === "waiting" ? 3 : 1,
  };
}

/**
 * Creates the installation's GitHub App, stores it in the platform Worker's secrets and waits
 * for the server to report GitHub linking on. Resolves with the outcome once the App is stored;
 * refuses (GitHubAppRefusal) before any change when a check fails, or when GitHub's answer does
 * not come in time.
 */
export async function createGitHubApp(
  plan: Installation,
  ports: GitHubAppPorts,
  options: GitHubAppOptions = {},
): Promise<GitHubAppOutcome> {
  const present = await preflight(plan, ports.cloud, options.replace === true);
  const state = hex(ports.random(32));
  const pagePath = `/${hex(ports.random(16))}`;
  const statusPath = `${pagePath}/status`;
  const suffix = hex(ports.random(2));
  const action = manifestAction(state, options.org);
  const expiredPageMs = options.expiredPageMs ?? EXPIRED_PAGE_MS;

  let deliver: (code: string) => void = () => undefined;
  const arrived = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  let phase: Phase = { kind: "github" };
  let served = false;
  let port = 0;
  // Resolved once the browser has fetched the step's last answer.
  let finalFetched: () => void = () => undefined;
  const fetched = new Promise<void>((resolve) => {
    finalFetched = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const reply = (status: number, html: string, headers: Record<string, string> = {}) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        ...headers,
      });
      response.end(html);
    };
    // Only this page's own address: a page elsewhere cannot reach it through DNS rebinding.
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return reply(403, page("Not here", "This page is for the installer only."));
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const get = request.method === "GET";
    if (phase.kind === "expired") return reply(410, phase.html);
    if (get && url.pathname === pagePath && !served) {
      served = true;
      const manifest = githubAppManifest(plan, `http://127.0.0.1:${port}/callback`, suffix);
      return reply(200, manifestPage(action, manifest));
    }
    if (get && url.pathname === "/callback") {
      if (phase.kind !== "github") return reply(303, "", { location: statusPath });
      const code = url.searchParams.get("code") ?? "";
      const given = url.searchParams.get("state") ?? "";
      if (!sameText(given, state) || !CODE.test(code)) {
        return reply(400, page("Not this installation's App", "Start again from the installer."));
      }
      phase = { kind: "storing" };
      deliver(code);
      // On at once to the progress page: the browser never waits on an open request.
      return reply(303, "", { location: statusPath });
    }
    if (get && url.pathname === statusPath && phase.kind !== "github") {
      if (phase.kind === "final") {
        finalFetched();
        return phase.location === undefined
          ? reply(200, phase.html)
          : reply(302, phase.html, { location: phase.location });
      }
      return reply(
        200,
        phase.kind === "storing"
          ? page("Setting up GitHub", "GitHub created the App. Storing it in your installation…", {
              refreshS: PROGRESS_REFRESH_S,
            })
          : page(
              "Setting up GitHub",
              [
                "GitHub created the App, and it is stored in your installation. Omnigent's server is restarting with GitHub linking on; this takes a few minutes.",
                "This page moves on by itself to GitHub, where you install the App.",
                `Now: ${phase.why}.`,
              ],
              { refreshS: PROGRESS_REFRESH_S },
            ),
      );
    }
    return reply(404, page("Not found", "Start again from the installer."));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const start = `http://127.0.0.1:${port}${pagePath}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // What to wait for before the local page closes: the browser's last fetch, or a pause.
  let linger: Promise<unknown> = Promise.resolve();
  try {
    ports.log(
      `opening GitHub in your browser to create this installation's GitHub App; click "Create GitHub App" there. If no browser opens, visit ${start}`,
    );
    ports.openBrowser(start);
    const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_APP_TIMEOUT_MS;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // GitHub's answer came first: never expire a step under way.
        if (phase.kind !== "github") return;
        const until = new Date(Date.now() + expiredPageMs);
        phase = {
          kind: "expired",
          html: page("This link has expired", [
            `The installer waited ${minutes(timeoutMs)} for GitHub and then stopped, so nothing was stored in your installation.`,
            `If you clicked "Create GitHub App" on GitHub just now, GitHub made that App anyway: delete it at ${GITHUB}${options.org === undefined ? "" : `/organizations/${options.org}`}/settings/apps (its name begins with "${appName(plan.installationId, suffix)}").`,
            "To start again, run the installer's GitHub step again: node scripts/bootstrap/bootstrap.ts github-app",
          ]),
        };
        linger = delay(expiredPageMs);
        ports.log(
          `no answer from GitHub within ${minutes(timeoutMs)}, so this step stopped and nothing was changed. The browser's link says so until ${until.toISOString().slice(11, 16)} UTC; press Ctrl-C to stop now`,
        );
        reject(
          new GitHubAppRefusal(
            `no answer from GitHub within ${minutes(timeoutMs)}; nothing was changed. Run the step again`,
          ),
        );
      }, timeoutMs);
    });
    const code = await Promise.race([arrived, expired]);
    clearTimeout(timer);
    timer = undefined;
    const finish = (final: { location?: string; html: string }) => {
      phase = { kind: "final", ...final };
      linger = Promise.race([fetched, delay(options.finalPageMs ?? FINAL_PAGE_MS)]);
    };
    let app: CreatedApp;
    // When the change began: what the wait counts from (a line from before is never evidence).
    let changedAt = 0;
    try {
      const answer = await ports.githubApi(
        `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "cloudflare-omnigent-installer",
          },
          redirect: "error",
        },
      );
      if (answer.status !== 201) {
        throw new GitHubAppRefusal(
          `GitHub refused to hand over the new App (status ${answer.status}); nothing was changed. Run the step again`,
        );
      }
      let body: unknown;
      try {
        body = await answer.json();
      } catch {
        throw new GitHubAppRefusal("GitHub's answer was not a GitHub App's credentials");
      }
      app = parseConversion(body);
      const extra = extraPermissions(app.permissions);
      if (extra.length > 0) {
        ports.log(`warning: GitHub granted more than asked for: ${extra.join(", ")}`);
      }
      const changes = githubAppChanges(plan, app, present, ports.random);
      changedAt = ports.now();
      try {
        await ports.cloud.updateSecrets(plan.platformWorker, changes);
      } catch (error) {
        // The App exists on GitHub but is not stored: say where to delete it, then fail.
        ports.log(
          `GitHub App ${app.slug} was created but could not be stored in ${plan.platformWorker}; delete it at ${appSettingsUrl(app.slug, options.org)}/advanced and run the step again`,
        );
        throw error;
      }
      ports.log(
        `GitHub App ${app.slug} created and stored in ${plan.platformWorker}'s secrets (${Object.keys(changes).length} settings). Waiting for the server to restart with GitHub linking on (a few minutes); the browser waits too`,
      );
    } catch (error) {
      finish({
        html: page(
          "The App was not stored",
          error instanceof GitHubAppRefusal ? error.message : "See the installer's output.",
        ),
      });
      throw error;
    }
    const installUrl = `${GITHUB}/apps/${app.slug}/installations/new`;
    phase = { kind: "restarting", why: "the installation is taking up the App's settings" };
    const linking = await waitForLinking(
      plan,
      ports,
      options,
      await githubAppTag(app.clientId),
      changedAt,
      (why) => {
        phase = { kind: "restarting", why };
      },
    );
    const outcome: GitHubAppOutcome =
      "decided" in linking
        ? { kind: linking.decided, slug: app.slug, installUrl }
        : { kind: "waiting", slug: app.slug, installUrl, why: linking.why };
    if (outcome.kind === "on") {
      finish({
        location: installUrl,
        html: page("GitHub linking is on", "Next: install the App on GitHub."),
      });
    } else {
      const words = notOnMessage(plan, outcome, options.org);
      finish({
        html: page(
          words.title,
          words.text,
          outcome.kind === "waiting"
            ? { link: { href: installUrl, label: "Install the App on GitHub" } }
            : {},
        ),
      });
    }
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await linger;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The wait for GitHub linking (WP3.36), with `update`'s reader (`slicedLogs`, `parseLogs`,
 * `pollServer`): the watchdog's lines since the change that name this App's tag decide
 * (`checkGitHubLinking`). A failed read of Cloudflare is no evidence: asked again.
 */
async function waitForLinking(
  plan: Installation,
  ports: GitHubAppPorts,
  options: GitHubAppOptions,
  appTag: string | null,
  since: number,
  progress: (why: string) => void,
): Promise<{ readonly decided: "on" | "off" | "held" } | { readonly why: string }> {
  const logsSince = slicedLogs({ cloud: ports.cloud, now: () => ports.now() }, plan.platformWorker);
  return pollServer<"on" | "off" | "held">(
    ports,
    {
      pollMs: options.linkingPollMs ?? DEFAULT_LINKING_POLL_MS,
      deadline: ports.now() + (options.linkingWaitMs ?? DEFAULT_LINKING_WAIT_MS),
    },
    async () => {
      let events: unknown[];
      try {
        events = await logsSince(since, ports.now());
      } catch {
        const why = "Cloudflare did not answer the query for the platform Worker's logs";
        progress(why);
        return { why };
      }
      const check = checkGitHubLinking(parseLogs(events, plan.platformWorker), {
        installationId: plan.installationId,
        // parseConversion checked the client ID: never empty, so never null.
        appTag: appTag ?? "",
        since,
      });
      if (check.state === "waiting") {
        progress(check.why);
        return { why: check.why };
      }
      return { decided: check.state };
    },
  );
}

/**
 * A real pause, for the local page's own lifetime (never the fake clock of the wait). Its timer
 * does not keep the process alive by itself (Codex WP3.36 r1-4): the page's server does while it
 * listens.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** A duration in words, for the person. */
export function minutes(ms: number): string {
  if (ms < 60_000) {
    const n = Math.max(1, Math.round(ms / 1000));
    return `${n} second${n === 1 ? "" : "s"}`;
  }
  const n = Math.round(ms / 60_000);
  return n === 60 ? "an hour" : `${n} minute${n === 1 ? "" : "s"}`;
}

/** The person's browser, by platform: `open` (macOS), `start` (Windows), else `xdg-open`. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}
