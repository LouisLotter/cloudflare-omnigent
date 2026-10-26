// "Cloud computers" (WP3.5): every computer with its status, setup state, saves and notices; the
// server's outage notices and the replication warning; links to adding and deleting computers in
// Omnigent's own interface; the removal flow, which runs the sign-out rules before it links to
// Omnigent's deletion; and the page actions, each behind a confirmation page and a guarded POST.

import {
  type ComputerId,
  ComputerId as ComputerIdSchema,
  InstanceSize,
  OperationId,
  type PageFrontCall,
  type PageOwner,
  type PagesCall,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { errorCodeOf } from "../shared/errors.ts";
import type { PagesBackend, StateResult } from "./backend.ts";
import {
  badge,
  COMPUTERS_PATH,
  computerPath,
  hidden,
  layout,
  notice,
  OMNIGENT_COMPUTERS_PATH,
} from "./html.ts";
import { escapeHtml, htmlResponse, newOperationId, readChange, seeOther } from "./http.ts";
import {
  type ComputerView,
  computerView,
  OUTAGE_WINDOW_MS,
  outageNotices,
  replicationNotice,
} from "./view.ts";

/** One page action: its URL slug, its call, and what its confirmation page says. */
export interface ActionSpec {
  readonly slug: string;
  readonly title: string;
  readonly button: string;
  readonly danger: boolean;
  /** Whether the computer's state offers it now. */
  readonly offered: (view: ComputerView, state: StateResult["computer"]) => boolean;
  readonly explain: (view: ComputerView, state: StateResult["computer"]) => string;
  readonly call: (
    base: { readonly operationId: string; readonly owner: PageOwner; readonly intent: string },
    form: Record<string, string>,
  ) => PagesCall | PageFrontCall | null;
}

const v = WORKSPACE_INTERFACE_VERSION;

export const ACTIONS: readonly ActionSpec[] = [
  {
    slug: "set-size",
    title: "Change the size",
    button: "Change the size",
    danger: false,
    offered: (view) => view.removal !== "pending" && view.removal !== "resolved",
    explain: (_view, state) =>
      `<p>The size applies at the next start; a running computer keeps its size until then. Now: <code>${escapeHtml(state.size)}</code>.</p>`,
    call: (base, form) => {
      const size = InstanceSize.safeParse(form.size);
      return size.success
        ? { action: "set_size", interfaceVersion: v, ...base, size: size.data }
        : null;
    },
  },
  {
    slug: "restart",
    title: "Restart this computer",
    button: "Restart, ending work in progress",
    danger: true,
    offered: (view) => view.running && view.removal !== "pending",
    explain: () =>
      "<p><strong>A restart ends work in progress.</strong> Turns that are running stop and are not replayed. The computer saves its files and logins first, then stops; Omnigent's next request starts it again and arms its host anew.</p>",
    call: (base) => ({ action: "restart", interfaceVersion: v, ...base }),
  },
  {
    slug: "stop-without-saving",
    title: "Stop without saving the latest changes",
    button: "Stop without saving",
    danger: true,
    offered: (view) => view.offerStopWithoutSaving,
    explain: (_view, state) =>
      `<p>The computer could not save its files before sleeping ${state.refusedSleeps} times in a row, so it stays awake. This stops it <strong>without saving its files</strong>: changes made ${state.lastSavedAt ? `after the last save, at ${escapeHtml(state.lastSavedAt)},` : "since it was added"} are lost. Its logins are still saved first. It ends work in progress.</p>`,
    call: (base) => ({ action: "stop_without_saving", interfaceVersion: v, ...base }),
  },
  {
    slug: "sign-out",
    title: "Sign out of Claude and Codex",
    button: "Sign out",
    danger: true,
    offered: (view) =>
      view.removal === "sign_out" || (view.pending?.signOut ?? false) || view.running,
    explain: () =>
      "<p>Runs <code>claude auth logout</code> and <code>codex logout</code> on this computer, then saves the signed-out state. If a removal is pending, the computer is started once for this.</p><p><strong>Revocation at the providers is not proven.</strong> It rests on the CLIs' own logout, and the CLIs do not report a failed revocation: both exit successfully when it fails. Check and revoke the sessions at claude.ai and in ChatGPT's settings.</p>",
    call: (base) => ({ action: "sign_out", interfaceVersion: v, ...base }),
  },
  {
    slug: "record-revocation",
    title: "Record that you revoked the sessions",
    button: "I revoked both sessions",
    danger: false,
    offered: (view) => view.pending?.recordRevocation ?? false,
    explain: () =>
      "<p>Use this when a sign-out on the computer cannot reach a login: a login that may have changed after the last save, or a sign-out that cannot run. Sign this computer's sessions out at the providers first: at claude.ai, in your account's settings, and in ChatGPT's security settings. Then record it here. The record is kept even if the computer's data is deleted, and it lets the removal finish.</p>",
    call: (base) => ({ action: "record_revocation", interfaceVersion: v, ...base }),
  },
  {
    slug: "resolve-removal",
    title: "Finish the removal",
    button: "Delete its saved files and logins",
    danger: true,
    offered: (view) => view.pending?.resolvable ?? false,
    explain: () =>
      "<p>Deletes this computer's saved files and saved logins from the platform. This cannot be undone.</p>",
    call: (base) => ({ action: "resolve_removal", interfaceVersion: v, ...base }),
  },
  {
    slug: "remove",
    title: "Remove this computer",
    button: "Remove it",
    danger: true,
    offered: (view) => view.offerRemove,
    explain: () =>
      "<p>Omnigent has not called this computer for over an hour, for example because Omnigent's database was restored to a time before it was added. Removing it stops it after saving its files and logins, refuses any later start, and keeps its saved logins until you finish the removal here. If Omnigent still lists this computer, delete it there too.</p>",
    call: (base) => ({ action: "remove", interfaceVersion: v, ...base }),
  },
];

export function actionBySlug(slug: string): ActionSpec | undefined {
  return ACTIONS.find((a) => a.slug === slug);
}

const AT_CAPACITY =
  "All computers are busy: the limit of awake computers is reached. Try again later.";

/** Messages for a POST's outcome, shown after the redirect. Only these values are rendered. */
const OUTCOME_TEXT: Readonly<Record<string, string>> = {
  accepted: "Done.",
  busy: "Something else is in progress, such as a stop or a sign-out. Try again shortly.",
  not_running: "The computer is not running now.",
  not_offered: "That is not offered now.",
  unresolved: "The removal still needs a step: see below.",
  at_capacity: AT_CAPACITY,
};

export function actionPath(id: string, slug: string): string {
  return `${computerPath(id)}/do/${slug}`;
}

function flash(url: URL): string {
  const done = actionBySlug(url.searchParams.get("done") ?? "");
  const outcome = url.searchParams.get("outcome") ?? "";
  const text = OUTCOME_TEXT[outcome];
  if (done === undefined || text === undefined) return "";
  const tone = outcome === "accepted" ? "ok" : "warn";
  return notice({ tone, kind: "removal_pending", text: `${done.title}: ${text}` }).replace(
    'data-notice="removal_pending"',
    'data-notice="flash" role="status"',
  );
}

function computerCard(view: ComputerView): string {
  const setup = view.needsSetup ? ` ${badge("warn", "Needs setup")}` : "";
  const cards = view.cards
    .map(
      (c) =>
        `<li data-card="${c.provider}">${escapeHtml(c.title)}: <span class="tone-${c.tone}">${escapeHtml(c.label)}</span></li>`,
    )
    .join("");
  const links: string[] = [
    `<a class="button primary" href="${computerPath(view.id)}">Set up / manage</a>`,
  ];
  if (view.offerRestart) {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "restart")}">Restart (ends work in progress)</a>`,
    );
  }
  if (view.offerRemove) {
    links.push(`<a class="button danger" href="${actionPath(view.id, "remove")}">Remove</a>`);
  }
  return `<article class="card" data-computer="${escapeHtml(view.id)}">
<h3>${escapeHtml(view.name)}</h3>
<p>${badge(view.statusTone, view.status)}${setup}</p>
<ul>${cards}</ul>
<p class="muted" data-saving>${escapeHtml(view.saving)}</p>
${view.notices.map(notice).join("\n")}
<div class="actions">${links.join("")}</div>
</article>`;
}

function pendingLine(view: ComputerView): string {
  const p = view.pending;
  if (p === null) return "";
  let what: string;
  if (p.resolvable) what = "Ready to finish.";
  else if (p.revocationRequired) {
    what = "Still needs your record that you revoked its sessions at the providers.";
  } else if (p.signingOut) what = "Signing out now.";
  else if (p.verifying) what = "Signed out; the sign-out is being verified.";
  else
    what = "Still needs a sign-out on the computer, or your record that you revoked its sessions.";
  return `<li data-removal="${escapeHtml(view.id)}"><a href="${computerPath(view.id)}">${escapeHtml(view.name)}</a>: ${escapeHtml(what)} Its saved logins are kept until then.</li>`;
}

/** GET `/platform/computers`. */
export async function computersPage(
  backend: PagesBackend,
  owner: PageOwner,
  url: URL,
  nowMs: number,
): Promise<Response> {
  const [computers, outages, replication] = await Promise.all([
    backend.computers(),
    backend.outages(
      new Date(nowMs - OUTAGE_WINDOW_MS).toISOString(),
      new Date(nowMs).toISOString(),
    ),
    backend.replication(),
  ]);
  const states = await Promise.all(
    computers.map(async ({ computerId, name }) => {
      try {
        return { computerId, name, state: await backend.state(computerId, owner) };
      } catch {
        return { computerId, name, state: undefined };
      }
    }),
  );
  const views: ComputerView[] = [];
  const unreadable: string[] = [];
  for (const entry of states) {
    if (entry.state === undefined) unreadable.push(entry.name);
    else if (entry.state !== null && entry.state.computer.lifecycle !== "removed") {
      views.push(computerView(entry.state.computer, nowMs));
    }
  }
  const notices = [
    ...(replicationNotice(replication, nowMs) === null
      ? []
      : [replicationNotice(replication, nowMs)]),
    ...outageNotices(outages ?? [], nowMs),
  ].filter((n) => n !== null);
  if (outages === null) {
    notices.push({
      tone: "warn",
      kind: "outage",
      text: "Omnigent's outage records could not be read now.",
    });
  }
  const active = views.filter((view) => view.removal !== "pending");
  const pending = views.filter((view) => view.removal === "pending");
  const body = `
<h1>Cloud computers</h1>
<p class="muted">Add and delete computers in Omnigent's own interface: <a href="${OMNIGENT_COMPUTERS_PATH}" data-link="omnigent-add">Settings → Computers → Add computer</a>. A new computer is listed here as needing setup; open it to sign in to Claude and Codex.</p>
${flash(url)}
${notices.map(notice).join("\n")}
<h2>Computers</h2>
${active.length === 0 ? `<p class="muted" data-empty>No computers yet. <a href="${OMNIGENT_COMPUTERS_PATH}">Add one in Omnigent</a>.</p>` : `<div class="cards">${active.map(computerCard).join("\n")}</div>`}
${unreadable.length > 0 ? `<p class="tone-warn">Could not be read now: ${unreadable.map(escapeHtml).join(", ")}.</p>` : ""}
${pending.length > 0 ? `<h2>Removals in progress</h2><ul data-removals>${pending.map(pendingLine).join("")}</ul>` : ""}
<h2>Deleting a computer</h2>
<p>Open the computer and follow its removal steps first: they sign it out of Claude and Codex, then link to <a href="${OMNIGENT_COMPUTERS_PATH}" data-link="omnigent-delete">Omnigent's deletion</a>. A computer deleted in Omnigent first is listed under "Removals in progress" until its sign-out is done, and its saved logins are kept until then.</p>`;
  return htmlResponse(layout("Cloud computers", body));
}

/** The removal section of a computer's page (design, Signing in, "Removal"). */
export function removalSection(view: ComputerView): string {
  const signOutNote =
    "Revocation at the providers rests on the CLIs' own logout and is not independently verified; the CLIs do not report a failed revocation. Check at claude.ai and in ChatGPT's settings.";
  const deleteLink = `<a href="${OMNIGENT_COMPUTERS_PATH}" data-link="omnigent-delete">delete it in Omnigent (Settings → Computers)</a>`;
  let steps: string;
  switch (view.removal) {
    case "sign_out":
      steps = `<ol class="steps" data-removal-step="sign_out">
<li><a class="button danger" href="${actionPath(view.id, "sign-out")}">Sign out of Claude and Codex</a> on this computer. ${escapeHtml(signOutNote)}</li>
<li>Once both cards here show signed out, the link to Omnigent's deletion appears here.</li>
</ol>`;
      break;
    case "signing_out":
      steps = `<p data-removal-step="signing_out">Signing out… This page updates when it is done.</p>`;
      break;
    case "delete":
      steps = `<ol class="steps" data-removal-step="delete">
<li>Signed out, or never signed in. ${escapeHtml(signOutNote)}</li>
<li>Now ${deleteLink}. The platform deletes the computer's saved files once the removal is resolved here.</li>
</ol>`;
      break;
    case "delete_then_sign_out":
      steps = `<ol class="steps" data-removal-step="delete_then_sign_out">
<li>This computer is not running, and its logins are saved. ${deleteLink}.</li>
<li>Then come back here: the platform starts it once to sign out of Claude and Codex before its files are deleted. ${escapeHtml(signOutNote)}</li>
</ol>`;
      break;
    case "pending": {
      const p = view.pending;
      const items: string[] = [];
      if (p?.signOut) {
        items.push(
          `<li><a class="button danger" href="${actionPath(view.id, "sign-out")}">Sign out of Claude and Codex</a>: starts the computer once for the CLIs' logouts.</li>`,
        );
      }
      if (p?.signingOut) items.push("<li>Signing out… This page updates when it is done.</li>");
      if (p?.verifying) {
        items.push(
          "<li>Signed out. The sign-out is being verified by restoring into a fresh computer; this page updates when it is done.</li>",
        );
      }
      if (p?.recordRevocation) {
        items.push(
          `<li>${p.revocationRequired ? "A login may have changed after the last save, so a sign-out cannot reach it. Revoke" : "If the sign-out cannot run, revoke"} this computer's sessions at claude.ai and in ChatGPT's settings, then <a class="button" href="${actionPath(view.id, "record-revocation")}">record that you did</a>.</li>`,
        );
      }
      if (p?.resolvable) {
        items.push(
          `<li><a class="button danger" href="${actionPath(view.id, "resolve-removal")}">Finish the removal</a>: deletes its saved files and logins.</li>`,
        );
      }
      steps = `<p data-removal-step="pending">The removal is pending; its saved logins are kept until it is resolved. ${escapeHtml(signOutNote)}</p><ol class="steps">${items.join("")}</ol>`;
      break;
    }
    case "resolved":
      steps = `<p data-removal-step="resolved">Removed.</p>`;
      break;
  }
  return `<section id="removal"><h2>Remove this computer</h2>${steps}</section>`;
}

/**
 * The management sections of a computer's page: size, restart, stop without saving. Not shown
 * while a removal is pending or resolved.
 */
export function manageSection(
  view: ComputerView,
  state: StateResult["computer"],
  intent: string,
): string {
  const sizes = InstanceSize.options
    .map(
      (size) =>
        `<option value="${size}"${size === (state.nextSize ?? state.size) ? " selected" : ""}>${size}</option>`,
    )
    .join("");
  const size = `<form method="post" action="${actionPath(view.id, "set-size")}" class="actions" data-form="set-size">
${hidden("intent", intent)}${hidden("op", newOperationId())}
<label>Size <select name="size">${sizes}</select></label>
<button type="submit">Apply at the next start</button>
</form>`;
  const controls: string[] = [];
  if (view.running) {
    controls.push(
      `<a class="button danger" href="${actionPath(view.id, "restart")}">Restart (ends work in progress)</a>`,
    );
  }
  if (view.offerStopWithoutSaving) {
    controls.push(
      `<a class="button danger" href="${actionPath(view.id, "stop-without-saving")}" data-action="stop-without-saving">Stop without saving the latest changes</a>`,
    );
  }
  if (view.offerRemove) {
    controls.push(
      `<a class="button danger" href="${actionPath(view.id, "remove")}">Remove this computer</a>`,
    );
  }
  return `<section><h2>This computer</h2>
<dl class="facts">
<dt>Status</dt><dd>${badge(view.statusTone, view.status)}</dd>
<dt>Saves</dt><dd data-saving>${escapeHtml(view.saving)}</dd>
<dt>Size</dt><dd>${escapeHtml(view.size)}</dd>
</dl>
${size}
${controls.length > 0 ? `<div class="actions">${controls.join("")}</div>` : ""}
</section>`;
}

/** Parses the computer ID in a path segment. */
export function parseComputerId(segment: string | undefined): ComputerId | null {
  const parsed = ComputerIdSchema.safeParse(segment);
  return parsed.success ? parsed.data : null;
}

/** GET on a control URL: the confirmation page, never the action (P1). */
export async function confirmPage(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  spec: ActionSpec,
  nowMs: number,
): Promise<Response> {
  const state = await backend.state(id, owner);
  if (state === null) return notFoundPage();
  const view = computerView(state.computer, nowMs);
  const back = `<a class="button" href="${computerPath(id)}">Cancel</a>`;
  if (!spec.offered(view, state.computer) || state.intentToken === undefined) {
    return htmlResponse(
      layout(
        spec.title,
        `<h1>${escapeHtml(spec.title)}</h1><p data-confirm="not-offered">This is not offered for ${escapeHtml(view.name)} now.</p><div class="actions">${back}</div>`,
      ),
    );
  }
  const extra =
    spec.slug === "set-size"
      ? `<label>Size <select name="size">${InstanceSize.options.map((s) => `<option value="${s}"${s === (state.computer.nextSize ?? state.computer.size) ? " selected" : ""}>${s}</option>`).join("")}</select></label>`
      : "";
  const body = `<h1>${escapeHtml(spec.title)}</h1>
<p class="muted">${escapeHtml(view.name)}</p>
${spec.explain(view, state.computer)}
<p class="muted">Opening this page changed nothing. Nothing happens until you press the button.</p>
<form method="post" action="${actionPath(id, spec.slug)}" class="actions" data-confirm="${spec.slug}">
${hidden("intent", state.intentToken)}${hidden("op", newOperationId())}
${extra}
<button type="submit" class="${spec.danger ? "danger" : "primary"}">${escapeHtml(spec.button)}</button>
${back}
</form>`;
  return htmlResponse(layout(spec.title, body));
}

export function notFoundPage(): Response {
  return htmlResponse(
    layout(
      "Not found",
      `<h1>Not found</h1><p>There is no such page or computer. <a href="${COMPUTERS_PATH}">All computers</a></p>`,
    ),
    404,
  );
}

export function refusedPage(status: number, text: string): Response {
  return htmlResponse(
    layout(
      "Refused",
      `<h1>Not done</h1><p data-refused>${escapeHtml(text)}</p><p><a href="${COMPUTERS_PATH}">All computers</a></p>`,
    ),
    status,
  );
}

/** The text for a page change WorkspaceDO refused with an error code. */
export function errorText(code: string | undefined): [number, string] {
  switch (code) {
    case "forbidden":
      return [
        403,
        "This page is out of date, or the request did not come from it. Reload the page, then try again.",
      ];
    case "not_found":
      return [404, "There is no such computer."];
    case "unsupported_version":
      return [503, "The platform is being updated. Try again in a few minutes."];
    case "at_capacity":
      return [409, AT_CAPACITY];
    default:
      return [503, "The computer could not be reached now. Try again shortly."];
  }
}

/** POST on a control URL: the guarded action, then a redirect to the computer's page. */
export async function performAction(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  spec: ActionSpec,
  request: Request,
  origin: string,
  log: (fields: Readonly<Record<string, string>>) => void,
): Promise<Response> {
  const change = await readChange(request, origin, "form");
  if (!change.ok) {
    log({ event: "page_change_refused", reason: change.refusal, action: spec.slug });
    return refusedPage(
      403,
      "This change did not come from this installation's own page, so nothing was done.",
    );
  }
  const form = change.value;
  const op = OperationId.safeParse(form.op);
  const intent = form.intent ?? "";
  if (!op.success || !/^[0-9a-f]{64}$/.test(intent)) {
    log({ event: "page_change_refused", reason: "malformed", action: spec.slug });
    return refusedPage(403, "This page is out of date. Reload the page, then try again.");
  }
  const call = spec.call({ operationId: op.data, owner, intent }, form);
  if (call === null) return refusedPage(400, "That value is not allowed.");
  let result: Awaited<ReturnType<PagesBackend["act"]>>;
  try {
    result = await backend.act(id, call);
  } catch (error) {
    const code = errorCodeOf(error);
    log({ event: "page_change_failed", code: code ?? "unknown", action: spec.slug });
    const [status, text] = errorText(code);
    return refusedPage(status, text);
  }
  const outcome =
    "outcome" in result && result.outcome === "refused" && "reason" in result
      ? String(result.reason)
      : "accepted";
  const query = new URLSearchParams({ done: spec.slug, outcome });
  return seeOther(`${computerPath(id)}?${query.toString()}`);
}

export { flash as flashNotice };
