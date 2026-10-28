// "Set up this computer" (WP3.5; design, Signing in): the computer's own page, which Omnigent links
// to as "Set up / manage" (`manage_url`). It embeds a terminal into the computer and shows one card
// per service, Claude and Codex; below them, the computer's management and removal sections.
//
// The terminal: the page's script asks for a capability with a guarded POST, then opens a
// WebSocket to this page's `terminal` URL, offering the capability as a subprotocol. The web
// Worker checks the exact origin and hands the upgrade, with the admitted owner, to the
// computer's WorkspaceDO, which checks the capability and bridges the stream to ttyd. No HTML or
// script from the computer is ever served on this origin: only the terminal's byte stream crosses.

import {
  CAPABILITY_SUBPROTOCOL_PREFIX,
  type ComputerId,
  OperationId,
  type PageOwner,
  type SetupProvider,
  TERMINAL_SUBPROTOCOL,
  TERMINAL_UPGRADE_HEADER,
  TerminalCapability,
  type TerminalUpgrade,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { errorCodeOf } from "../shared/errors.ts";
import type { PagesBackend } from "./backend.ts";
import {
  errorText,
  flashNotice,
  manageSection,
  notFoundPage,
  removalSection,
} from "./computers.ts";
import { ASSETS_PATH, badge, computerPath, layout, notice } from "./html.ts";
import {
  escapeHtml,
  htmlResponse,
  jsonResponse,
  originRefusal,
  readChange,
  socketOriginOf,
} from "./http.ts";
import { signInIdleHtml } from "./owner-actions.ts";
import { type CardView, type ComputerView, computerView } from "./view.ts";

/** The terminal's way, for a computer whose software predates signing in from the page. */
const CARD_HOW: Readonly<Record<SetupProvider, string>> = {
  claude: `<p>This computer's software is older, so sign in with the terminal below: run <code>claude auth login --claudeai</code>, open the link it prints, sign in at Anthropic, and paste the code it gives you back into the terminal.</p>`,
  codex: `<p>This computer's software is older, so sign in with the terminal below: run <code>codex login --device-auth</code>, open the link it prints and enter the code it shows. Device-code sign-in must first be turned on in ChatGPT's security settings.</p>`,
};

/**
 * The card's sign-in (WP3.23): a button that starts the flow on this page, the terminal's way for
 * an older computer, or why it is not offered now. The page's script runs the flow.
 */
function signInPart(c: CardView, view: ComputerView): string {
  const removing = view.removal === "pending" || view.removal === "resolved";
  if (removing) return "";
  if (view.signIn === "no") return CARD_HOW[c.provider];
  const offered = view.running;
  const note = offered
    ? ""
    : "The computer is not running. Send it work in Omnigent (a new conversation on it wakes it), then sign in here.";
  const signedIn = c.state === "signed_in";
  return `<div class="sign-in" data-sign-in="${c.provider}">${signInIdleHtml(
    c.provider,
    offered,
    signedIn ? "" : note,
    signedIn,
  )}</div>`;
}

export const PASTE_HINT =
  "Paste into the terminal with Ctrl+Shift+V (Cmd+V on a Mac), Shift+Insert or a middle click.";

function card(c: CardView, view: ComputerView): string {
  return `<article class="card${c.open ? " open" : ""}" data-card="${c.provider}" data-state="${c.state}">
<h3>${escapeHtml(c.title)} ${badge(c.tone, c.label)}</h3>
<p data-detail>${escapeHtml(c.detail)}</p>
${signInPart(c, view)}
</article>`;
}

/** GET `/platform/computers/{id}`. */
export async function setupPage(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  url: URL,
  origin: string,
  nowMs: number,
): Promise<Response> {
  const state = await backend.state(id, owner);
  if (state === null || state.intentToken === undefined) return notFoundPage();
  const view = computerView(state.computer, nowMs);
  const removing = view.removal === "pending" || view.removal === "resolved";
  const terminal = state.computer.terminal;
  const terminalPanel = removing
    ? `<p class="muted">The terminal is not offered while a removal is pending.</p>`
    : `<div class="terminal-panel" id="terminal-panel"
  data-computer="${escapeHtml(id)}"
  data-intent="${escapeHtml(state.intentToken)}"
  data-window="${terminal?.open ? terminal.window : ""}"
  data-terminal-url="${escapeHtml(`${computerPath(id)}/terminal`)}">
<div class="actions">
  <button type="button" class="primary" id="terminal-open"${view.running ? "" : " disabled"}>Open the terminal</button>
  <button type="button" id="terminal-close" hidden>Close the terminal</button>
  <span id="terminal-status" class="muted" role="status">${
    view.running
      ? "The terminal opens for 30 minutes. While it is open the computer does not go to sleep."
      : "The computer is not running. Send it work in Omnigent (a new conversation on it wakes it), then reload this page. While the terminal is open, the computer does not go to sleep."
  }</span>
</div>
<p class="muted" data-paste-hint>${escapeHtml(PASTE_HINT)}</p>
<div id="terminal" hidden></div>
</div>`;
  const resume = JSON.stringify(state.computer.signIn?.attempts ?? []);
  const body = `<div id="computer-page" data-state-url="${escapeHtml(`${computerPath(id)}/state`)}" data-sign-in-url="${escapeHtml(`${computerPath(id)}/sign-in`)}" data-intent="${escapeHtml(state.intentToken)}" data-resume="${escapeHtml(resume)}">
<h1>${escapeHtml(view.name)}</h1>
<p><span id="status">${badge(view.statusTone, view.status)}</span> <span class="muted" data-saving>${escapeHtml(view.saving)}</span></p>
${flashNotice(url)}
<div id="notices">${view.notices.map(notice).join("\n")}</div>
<div class="layout">
<section>
<h2>Set up this computer</h2>
<p class="muted">Sign in once to each service. The logins stay on this computer and are saved with it. There is no Omnigent sign-in here: Omnigent connects the computer itself.</p>
${terminalPanel}
</section>
<section>
<h2>Sign-ins</h2>
<div class="cards" id="cards">${view.cards.map((c) => card(c, view)).join("\n")}</div>
</section>
</div>
<section id="computer-status" data-status-url="${escapeHtml(`${computerPath(id)}/status`)}" data-staging-url="${escapeHtml(`${computerPath(id)}/staging-check`)}">
<h2>Computer status</h2>
<div class="actions"><button type="button" id="status-refresh">Refresh</button></div>
<div id="status-body"><p class="muted">Reading the computer's status…</p></div>
</section>
${removing ? "" : manageSection(view, state.computer, state.intentToken)}
${removalSection(view)}
</div>`;
  return htmlResponse(
    layout(`Set up ${view.name}`, body, [
      `${ASSETS_PATH}/xterm.js`,
      `${ASSETS_PATH}/addon-fit.js`,
      `${ASSETS_PATH}/setup-client.js`,
    ]).replace(
      `<link rel="stylesheet" href="${ASSETS_PATH}/pages.css">`,
      `<link rel="stylesheet" href="${ASSETS_PATH}/pages.css">\n<link rel="stylesheet" href="${ASSETS_PATH}/xterm.css">`,
    ),
    200,
    { inlineStyles: true, socketOrigin: socketOriginOf(origin) },
  );
}

/** GET `/platform/computers/{id}/state`: what the page's script refreshes, every few seconds. */
export async function stateJson(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  nowMs: number,
): Promise<Response> {
  const state = await backend.state(id, owner);
  if (state === null) return jsonResponse({ error: { code: "not_found" } }, 404);
  const view = computerView(state.computer, nowMs);
  return jsonResponse({
    status: view.status,
    statusTone: view.statusTone,
    running: view.running,
    saving: view.saving,
    intent: state.intentToken ?? null,
    terminal: state.computer.terminal ?? null,
    cards: view.cards.map((c) => ({ ...c, html: card(c, view) })),
    notices: view.notices,
    // Server-rendered, escaped markup the page swaps in, so its sections follow the state.
    statusHtml: badge(view.statusTone, view.status),
    noticesHtml: view.notices.map(notice).join("\n"),
    removalHtml: removalSection(view),
  });
}

/** POST `/platform/computers/{id}/terminal`: open, reconnect or close the terminal window. */
export async function terminalChange(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  request: Request,
  origin: string,
  log: (fields: Readonly<Record<string, string>>) => void,
): Promise<Response> {
  const change = await readChange(request, origin, "json");
  if (!change.ok) {
    log({ event: "terminal_change_refused", reason: change.refusal });
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  const { op, intent, mode, window } = change.value;
  const operationId = OperationId.safeParse(op);
  if (!operationId.success || intent === undefined || !/^[0-9a-f]{64}$/.test(intent)) {
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  const base = {
    interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    operationId: operationId.data,
    owner,
    intent,
  };
  let call: Parameters<PagesBackend["act"]>[1];
  if (mode === "close") call = { action: "close_terminal", ...base };
  else if (mode === "open") call = { action: "open_terminal", ...base, window: null };
  else if (mode === "reconnect" && window !== undefined && /^[1-9][0-9]{0,8}$/.test(window)) {
    call = { action: "open_terminal", ...base, window: Number(window) };
  } else return jsonResponse({ error: { code: "bad_request" } }, 400);
  try {
    return jsonResponse(await backend.act(id, call));
  } catch (error) {
    const code = errorCodeOf(error);
    log({ event: "terminal_change_failed", code: code ?? "unknown" });
    const [status] = errorText(code);
    return jsonResponse({ error: { code: code ?? "unavailable" } }, status);
  }
}

/** The capability the browser offered as a subprotocol, and whether it offered `tty`. */
export function offeredCapability(request: Request): string | null {
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (!offered.includes(TERMINAL_SUBPROTOCOL)) return null;
  const caps = offered.filter((p) => p.startsWith(CAPABILITY_SUBPROTOCOL_PREFIX));
  if (caps.length !== 1 || offered.length !== 2) return null;
  const parsed = TerminalCapability.safeParse(caps[0]?.slice(CAPABILITY_SUBPROTOCOL_PREFIX.length));
  return parsed.success ? parsed.data : null;
}

/** GET with `Upgrade: websocket` on `/platform/computers/{id}/terminal`: the bridged stream. */
export async function terminalUpgrade(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  request: Request,
  origin: string,
  log: (fields: Readonly<Record<string, string>>) => void,
): Promise<Response> {
  const refuse = (reason: string) => {
    log({ event: "terminal_upgrade_refused", reason });
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  };
  if (request.method !== "GET") return refuse("method");
  const bad = originRefusal(request, origin);
  if (bad !== null) return refuse(bad);
  const capability = offeredCapability(request);
  if (capability === null) return refuse("no_capability");
  const upgrade: TerminalUpgrade = {
    interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    computerId: id,
    owner,
    capability,
  };
  // A fresh request: nothing of the browser's other headers reaches WorkspaceDO.
  const inner = new Request(`https://workspace.internal${computerPath(id)}/terminal`, {
    headers: {
      upgrade: "websocket",
      "sec-websocket-protocol": TERMINAL_SUBPROTOCOL,
      [TERMINAL_UPGRADE_HEADER]: JSON.stringify(upgrade),
    },
  });
  try {
    const response = await backend.upgrade(id, inner);
    if (response.status === 101) return response;
    await response.body?.cancel();
    return refuse(`status_${response.status}`);
  } catch (error) {
    return refuse(`error_${errorCodeOf(error) ?? "unknown"}`);
  }
}
