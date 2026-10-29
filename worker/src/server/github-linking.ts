// Omnigent's GitHub linking as the platform reads it (WP3.36). Pure: OmnigentServer uses it for
// the status line the installer waits on and for the GitHub setup page's state.
//
// What counts is Omnigent's own answer: `GET /v1/info` lists `github` in `enabled_connections`
// exactly when the server wired GitHub linking (its App configuration and connection store), and
// that list is what makes Omnigent's interface show its Integrations settings and "Connect
// GitHub". The server image decides whether to turn linking on (images/server, `GitHubLinking`);
// the platform never repeats that decision, it only reports Omnigent's.

/** The App's client ID as the platform Worker holds it (the server receives it unprefixed). */
export const GITHUB_APP_CLIENT_ID_ENV = "SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID";

/** Whether this Worker version holds the installation's GitHub App (its client ID). Names only. */
export function githubAppConfigured(env: Readonly<Record<string, unknown>>): boolean {
  const value = env[GITHUB_APP_CLIENT_ID_ENV];
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Whether Omnigent's `/v1/info` answer lists GitHub linking: true or false, or null when the
 * answer does not say (no `enabled_connections` list: an Omnigent from before it, or no answer).
 */
export function githubLinkingOf(info: unknown): boolean | null {
  if (info === null || typeof info !== "object" || Array.isArray(info)) return null;
  const list = (info as Record<string, unknown>).enabled_connections;
  if (!Array.isArray(list)) return null;
  return list.includes("github");
}
