// The installer's GitHub App step (WP5.9; owner decisions D22 and D37): `bootstrap.ts github-app`.
// It registers the installation's own GitHub App through GitHub's manifest flow, so the owner's
// only part on GitHub is the "Create GitHub App" button, and gives the platform Worker everything
// Omnigent's GitHub linking needs, in one secrets change:
//   1. checks the plan's platform Worker exists, is this installation's, and has no App yet
//      (unless --replace);
//   2. serves a one-time page on 127.0.0.1 that posts the App's manifest to GitHub, and opens it
//      in the browser (`xdg-open`, `open`, or `start`; the address is printed too);
//   3. GitHub shows the App to create; the owner clicks "Create GitHub App"; GitHub sends the
//      browser back to this page's callback with a one-time code and the state it was given;
//   4. exchanges the code with GitHub (`POST /app-manifests/{code}/conversions`) for the App's
//      ID, slug, client ID and client secret;
//   5. sets them as the platform Worker's secrets (`SERVER_ENV_OMNIGENT_GITHUB_APP_*`), with the
//      callback on the installation's hostname, and the key service's keys if the Worker has none
//      yet: the server's signing pair and the Worker-only record keys, generated here. One change
//      of the Worker's secrets (the bootstrap's transport, `updateSecrets`), so the server
//      restarts once, with GitHub linking on;
//   6. sends the browser on to GitHub's page that installs the App on the owner's account.
//
// What it never does: print, log, write to a file or put in an argument any secret (the client
// secret, the signing key, the record keys), or keep the App's private key or webhook secret,
// which GitHub's answer also carries: Omnigent's linking uses neither, and the private key would
// let whoever holds it act as the App on every repository it is installed on. Existing key-service
// keys are never replaced: records sealed under them would no longer open.
//
// The App asks for the least Omnigent's linking needs (the fork's docs/GITHUB_APP_SETUP.md):
// repository contents read and write (clone, push), metadata read (GitHub's mandatory minimum),
// pull requests read and write (gh pr create, the side panel's PR view). No account or
// organization permission, no webhook, installable only on the account that creates it.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { KEY_SERVICE_SECRETS, recordKeysSecret } from "../../worker/src/internal/key-service.ts";
import type { BootstrapCloud } from "./machine.ts";
import { bucketTagOf, type Installation, SERVER_ENV } from "./settings.ts";

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
/** Where GitHub sends the owner after installing the App: Omnigent's integrations settings. */
export const GITHUB_SETUP_PATH = "/settings/integrations";
/** The least Omnigent's GitHub linking needs (the fork's docs/GITHUB_APP_SETUP.md, step 4). */
export const APP_PERMISSIONS: Readonly<Record<string, "read" | "write">> = {
  contents: "write",
  metadata: "read",
  pull_requests: "write",
};
/** GitHub's limit on an App's name. */
const MAX_APP_NAME = 34;
/** How long the owner has to click "Create" (GitHub's code itself lasts an hour). */
export const DEFAULT_GITHUB_APP_TIMEOUT_MS = 15 * 60_000;

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
  "secretNames" | "workerInstallation" | "updateSecrets"
>;

export interface GitHubAppPorts {
  readonly cloud: GitHubAppCloud;
  /** Opens a URL in the person's browser. The URL never holds a secret. */
  openBrowser(url: string): void;
  /** Reaches GitHub's API (the manifest conversion). */
  fetch(url: string, init: RequestInit): Promise<Response>;
  random(bytes: number): Uint8Array;
  log(message: string): void;
}

export interface GitHubAppOptions {
  /** Create the App under this organization instead of the person's own account. */
  readonly org?: string;
  /** Create a new App although the Worker holds one; the old one stays on GitHub. */
  readonly replace?: boolean;
  readonly timeoutMs?: number;
  /** The local page's port: 0 (the default) lets the system choose. */
  readonly port?: number;
}

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

/** The App's name: short, and the installation's, so two installations never collide. */
export function appName(installationId: string): string {
  return `Omnigent ${bucketTagOf(installationId)}`.slice(0, MAX_APP_NAME);
}

/** The manifest GitHub registers: callback and setup on the installation's hostname. */
export function githubAppManifest(plan: Installation, redirectUrl: string): Manifest {
  const origin = `https://${plan.hostname}`;
  return {
    name: appName(plan.installationId),
    url: origin,
    description: `Omnigent's GitHub linking for ${plan.hostname} (cloudflare-omnigent).`,
    redirect_url: redirectUrl,
    callback_urls: [`${origin}${GITHUB_CALLBACK_PATH}`],
    setup_url: `${origin}${GITHUB_SETUP_PATH}`,
    setup_on_update: false,
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

function page(title: string, text: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto">
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>
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
  const present = new Set(names);
  if (!replace && present.has(GITHUB_APP_SECRETS.clientId)) {
    throw new GitHubAppRefusal(
      `${plan.platformWorker} already has a GitHub App. To make a new one, run again with --replace (then delete the old App on GitHub)`,
    );
  }
  return present;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Callback {
  readonly code: string;
  /** Answers the browser once the App is stored: on to GitHub's install page, or an error. */
  readonly finish: (outcome: { installUrl: string } | { error: string }) => void;
}

/**
 * Creates the installation's GitHub App and stores it in the platform Worker's secrets. Resolves
 * with the App's slug and its install page; refuses (GitHubAppRefusal) before any change when a
 * check fails.
 */
export async function createGitHubApp(
  plan: Installation,
  ports: GitHubAppPorts,
  options: GitHubAppOptions = {},
): Promise<{ readonly slug: string; readonly installUrl: string }> {
  const present = await preflight(plan, ports.cloud, options.replace === true);
  const state = hex(ports.random(32));
  const pagePath = `/${hex(ports.random(16))}`;
  const action = manifestAction(state, options.org);

  let deliver: (callback: Callback) => void = () => undefined;
  const arrived = new Promise<Callback>((resolve) => {
    deliver = resolve;
  });
  let served = false;
  let done = false;
  let port = 0;
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
    if (request.method === "GET" && url.pathname === pagePath && !served) {
      served = true;
      const manifest = githubAppManifest(plan, `http://127.0.0.1:${port}/callback`);
      return reply(200, manifestPage(action, manifest));
    }
    if (request.method === "GET" && url.pathname === "/callback" && !done) {
      const code = url.searchParams.get("code") ?? "";
      const given = url.searchParams.get("state") ?? "";
      if (!sameText(given, state) || !CODE.test(code)) {
        return reply(400, page("Not this installation's App", "Start again from the installer."));
      }
      done = true;
      deliver({
        code,
        finish: (outcome) =>
          "installUrl" in outcome
            ? reply(302, page("Done", "Next: install the App on GitHub."), {
                location: outcome.installUrl,
              })
            : reply(500, page("The App was not stored", outcome.error)),
      });
      return;
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
  try {
    ports.log(
      `opening GitHub in your browser to create this installation's GitHub App; click "Create GitHub App" there. If no browser opens, visit ${start}`,
    );
    ports.openBrowser(start);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new GitHubAppRefusal(
              "no answer from GitHub in time; nothing was changed. Run the step again",
            ),
          ),
        options.timeoutMs ?? DEFAULT_GITHUB_APP_TIMEOUT_MS,
      );
    });
    const callback = await Promise.race([arrived, timeout]);
    try {
      const answer = await ports.fetch(
        `${GITHUB_API}/app-manifests/${encodeURIComponent(callback.code)}/conversions`,
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
      const app = parseConversion(body);
      const extra = extraPermissions(app.permissions);
      if (extra.length > 0) {
        ports.log(`warning: GitHub granted more than asked for: ${extra.join(", ")}`);
      }
      const changes = githubAppChanges(plan, app, present, ports.random);
      await ports.cloud.updateSecrets(plan.platformWorker, changes);
      const installUrl = `${GITHUB}/apps/${app.slug}/installations/new`;
      callback.finish({ installUrl });
      ports.log(
        `GitHub App ${app.slug} created and stored in ${plan.platformWorker}'s secrets (${Object.keys(changes).length} settings). The server restarts once to take it up, in a minute or two.`,
      );
      ports.log(
        `next, in your browser: install the App on your account (${installUrl}); then, in Omnigent's Settings, Integrations: Connect GitHub`,
      );
      return { slug: app.slug, installUrl };
    } catch (error) {
      callback.finish({
        error: error instanceof GitHubAppRefusal ? error.message : "See the installer's output.",
      });
      throw error;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The person's browser, by platform: `open` (macOS), `start` (Windows), else `xdg-open`. */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", '""', url]];
  return ["xdg-open", [url]];
}
