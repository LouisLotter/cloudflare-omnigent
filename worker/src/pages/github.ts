// The GitHub setup page (WP3.36), `/platform/github`: the installation's GitHub App's setup URL.
// GitHub sends the owner's browser here after "Install" (and after a change to the installation's
// repositories, `setup_on_update`). Behind ingress (Access and the owner pin) like every platform
// page; GET and HEAD only, and it changes nothing.
//
//   GET /platform/github[?since=<ms>]
//     - GitHub linking on, on a server started with this version's settings: a 303 to Omnigent's
//       Integrations page, where "Connect GitHub" is;
//     - otherwise "Finishing GitHub setup…", which loads itself again every few seconds (a meta
//       refresh: the pages carry no inline script), with `since` the time of the first load;
//     - after `GITHUB_SETUP_WAIT_MS`, or when the server is held or in recovery mode, what is
//       wrong, in plain words, and a "Check again" link. A held or recovering server is named at
//       once, and the page keeps checking until the wait ends: it may still be the server from
//       before the change.
//
// What the page knows comes from OmnigentServer's `githubSetup` (contracts/src/github-setup.ts),
// never from the query: GitHub appends `installation_id` and `setup_action`, which anyone could
// forge (GitHub's own warning), and the page ignores them. `since` only bounds the wait.

import { GitHubSetupResult, type GitHubSetupResult as SetupState } from "@cfo/contracts";
import { OMNIGENT_SERVER_INTERFACE_VERSION, OMNIGENT_SERVER_OBJECT_NAME } from "../shared/rpc.ts";
import { GITHUB_SETUP_PAGE_PATH, layout } from "./html.ts";
import { escapeHtml, htmlResponse, securityHeaders } from "./http.ts";

export const GITHUB_SETUP_PATH = GITHUB_SETUP_PAGE_PATH;
/** Omnigent's Integrations settings, where "Connect GitHub" is. */
export const INTEGRATIONS_PATH = "/settings/integrations";
/** How often the waiting page loads itself again. */
export const GITHUB_SETUP_REFRESH_S = 5;
/**
 * How long the page waits before it says what is wrong: the platform's own switch to the new
 * version (about 5 minutes at most) and the server's restart (a few minutes), with a margin.
 */
export const GITHUB_SETUP_WAIT_MS = 15 * 60_000;

/** What the GitHub setup page calls: OmnigentServer's `githubSetup`. */
export interface GitHubSetupBackend {
  githubSetup(call: { readonly interfaceVersion: number }): Promise<SetupState>;
}

/** The web Worker's binding, typed down to the one method the page may call. */
export function bindingsGitHubSetupBackend(env: {
  readonly OMNIGENT: { getByName(name: string): unknown };
}): GitHubSetupBackend {
  return {
    async githubSetup(call) {
      const stub = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as GitHubSetupBackend;
      return GitHubSetupResult.parse(await stub.githubSetup(call));
    },
  };
}

/** What is wrong, once the page says so. */
export type GitHubSetupProblem =
  | "held"
  | "recovery"
  | "not_configured"
  | "not_answering"
  | "not_restarted"
  | "off"
  | "unknown"
  | "unreachable";

export type GitHubSetupView =
  | { readonly kind: "ready" }
  | {
      readonly kind: "waiting";
      /** What the server does now, for the page's one line. */
      readonly step: "switching" | "restarting" | "starting" | "reporting";
      /** A problem already plain while the page keeps checking. */
      readonly problem: "held" | "recovery" | null;
    }
  | { readonly kind: "stopped"; readonly problem: GitHubSetupProblem };

/** The page's decision. `state` is null when OmnigentServer could not be asked. Pure. */
export function githubSetupView(state: SetupState | null, waitedMs: number): GitHubSetupView {
  if (state?.configured && state.applied && state.linking === "on") {
    return { kind: "ready" };
  }
  const plain =
    state?.server === "held" ? "held" : state?.server === "recovery" ? "recovery" : null;
  if (waitedMs < GITHUB_SETUP_WAIT_MS) {
    const step =
      state === null || !state.configured
        ? "switching"
        : !state.applied
          ? "restarting"
          : state.server !== "answering"
            ? "starting"
            : "reporting";
    return { kind: "waiting", step, problem: plain };
  }
  if (plain !== null) return { kind: "stopped", problem: plain };
  if (state === null) return { kind: "stopped", problem: "unreachable" };
  if (!state.configured) return { kind: "stopped", problem: "not_configured" };
  if (state.server !== "answering") return { kind: "stopped", problem: "not_answering" };
  if (!state.applied) return { kind: "stopped", problem: "not_restarted" };
  if (state.linking === "off") return { kind: "stopped", problem: "off" };
  return { kind: "stopped", problem: "unknown" };
}

const STEPS: Readonly<Record<Extract<GitHubSetupView, { kind: "waiting" }>["step"], string>> = {
  switching: "Your installation is taking up the GitHub App's settings.",
  restarting: "Omnigent's server is restarting with the GitHub App's settings.",
  starting: "Omnigent's server is starting.",
  reporting: "Waiting for Omnigent to report GitHub linking on.",
};

const STEP_COMMAND = "node scripts/bootstrap/bootstrap.ts github-app";

/** What each problem says: what is wrong, and what to do. */
export const PROBLEMS: Readonly<Record<GitHubSetupProblem, string>> = {
  held: "Omnigent's server cannot start: one of this installation's settings is missing or malformed, so the server stopped and waits for the settings to change. If you just set up GitHub, the installer's GitHub step says which setting; run it again to replace the App.",
  recovery:
    "Omnigent's server is in recovery mode: its database could not be restored safely, so it does not serve Omnigent until someone looks at it (see the installation's recovery guide). GitHub setup goes on once the server is back.",
  not_configured: `This installation has no GitHub App yet. Create one with the installer's GitHub step: ${STEP_COMMAND}`,
  not_answering:
    "Omnigent's server is not answering yet. It may still be starting after a restart; check again in a few minutes.",
  not_restarted:
    "Omnigent's server has not restarted with the GitHub App's settings yet. It normally does within a few minutes of the installer's GitHub step; check again shortly.",
  off: `Omnigent's server restarted with the GitHub App's settings, but GitHub linking is still off, so a setting it needs is missing. Run the installer's GitHub step again to replace the App: ${STEP_COMMAND} --replace`,
  unknown:
    "Omnigent does not say whether GitHub linking is on. Check again in a few minutes; if it stays like this, the installation needs a look.",
  unreachable: "This page cannot reach Omnigent's server right now. Check again in a few minutes.",
};

/** The time of the first load, from `since`; `now` when absent, malformed or in the future. */
export function waitStart(url: URL, now: number): number {
  const raw = url.searchParams.get("since") ?? "";
  if (!/^[0-9]{1,15}$/.test(raw)) return now;
  const since = Number(raw);
  return since > now ? now : since;
}

function notice(tone: "warn" | "danger" | "info", kind: string, text: string): string {
  return `<div class="notice tone-${tone}" data-notice="${escapeHtml(kind)}"><span>${escapeHtml(text)}</span></div>`;
}

const TITLE = "Finishing GitHub setup";

/** GET: forward, wait, or say what is wrong. */
export async function githubSetupPage(
  backend: GitHubSetupBackend,
  url: URL,
  now: number,
  log: (fields: Readonly<Record<string, string>>) => void,
): Promise<Response> {
  let state: SetupState | null = null;
  try {
    state = await backend.githubSetup({ interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION });
  } catch (error) {
    // An object still on an older build, or a lost call: the page keeps checking.
    log({
      event: "github_setup_unavailable",
      error: error instanceof Error ? error.name : typeof error,
    });
  }
  const since = waitStart(url, now);
  const view = githubSetupView(state, now - since);
  if (view.kind === "ready") {
    log({ event: "github_setup", view: "ready" });
    return new Response(null, {
      status: 303,
      headers: { ...securityHeaders(), location: INTEGRATIONS_PATH },
    });
  }
  if (view.kind === "waiting") {
    const minutes = Math.max(1, Math.ceil((GITHUB_SETUP_WAIT_MS - (now - since)) / 60_000));
    const body = `<h1>Finishing GitHub setup…</h1>
<p data-step="${view.step}">${escapeHtml(STEPS[view.step])}</p>
${view.problem === null ? "" : notice("warn", view.problem, PROBLEMS[view.problem])}
<p>This page checks again every few seconds, and then opens Omnigent's Integrations page, where you click <strong>Connect GitHub</strong>. It usually takes a few minutes.</p>
<p class="muted">If it is not done in about ${minutes} minute${minutes === 1 ? "" : "s"}, this page says what is wrong.</p>`;
    return htmlResponse(
      layout(TITLE, body, [], {
        seconds: GITHUB_SETUP_REFRESH_S,
        url: `${GITHUB_SETUP_PATH}?since=${since}`,
      }),
    );
  }
  log({ event: "github_setup", view: "stopped", problem: view.problem });
  const body = `<h1>GitHub setup is not finished</h1>
${notice(view.problem === "not_answering" || view.problem === "not_restarted" || view.problem === "unreachable" || view.problem === "unknown" ? "warn" : "danger", view.problem, PROBLEMS[view.problem])}
<div class="actions"><a class="button primary" href="${GITHUB_SETUP_PATH}" data-check-again>Check again</a></div>`;
  return htmlResponse(layout("GitHub setup", body));
}
