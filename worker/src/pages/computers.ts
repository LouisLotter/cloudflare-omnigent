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
import { type PageAction, pageAllows } from "../computer/ownership.ts";
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
  type Notice,
  OUTAGE_WINDOW_MS,
  outageNoticeGroups,
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
  /** What the notice after an accepted POST says, when "Done." is not enough. */
  readonly acceptedText?: string;
  readonly call: (
    base: { readonly operationId: string; readonly owner: PageOwner; readonly intent: string },
    form: Record<string, string>,
  ) => PagesCall | PageFrontCall | null;
  /**
   * Whether an administrator may take it on someone else's computer (WP8.4; WorkspaceDO decides,
   * this only keeps the pages from offering what it refuses): stop and remove, and a sign-out
   * only while a removal is pending.
   */
  readonly admin: (view: ComputerView) => boolean;
  /**
   * Its wording for an administrator acting on someone else's computer, when it differs: a
   * restart there is a stop, since the computer starts again only when its owner next uses it.
   */
  readonly asAdmin?: {
    readonly title: string;
    readonly button: string;
    readonly explain: string;
  };
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
    admin: () => false,
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
    admin: () => true,
    asAdmin: {
      title: "Stop this computer",
      button: "Stop, ending work in progress",
      explain:
        "<p><strong>Stopping ends work in progress.</strong> Turns that are running stop and are not replayed. The computer saves its files and logins first, then stops. It starts again when its owner next uses it.</p>",
    },
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
    admin: () => false,
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
    admin: (view) => view.removal === "pending",
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
    admin: () => false,
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
    admin: (view) => view.removal === "pending",
  },
  {
    slug: "delete-without-sign-out",
    title: "Delete without signing out",
    button: "Delete it without signing out",
    danger: true,
    offered: (view, state) =>
      pageAllows(state.access ?? "owner", "delete_without_sign_out", view.removal === "pending") &&
      (view.pending?.deleteWithoutSignOut ?? false),
    explain: (view) =>
      `<p>${view.pending?.revocationRequired ? "A login on this computer may have changed after its last save, so a sign-out from its saved logins cannot reach it." : "The sign-out on this computer was tried and did not finish."} This deletes its saved files and saved logins from the platform now, <strong>without signing them out</strong>. It cannot be undone.</p><p><strong>The provider sessions are not revoked.</strong> They stay valid at Anthropic and OpenAI until they are revoked there: the computer's owner, or the administrator of their Claude or ChatGPT account, must revoke them at claude.ai and in ChatGPT's security settings.</p>`,
    acceptedText:
      "Deleted. Its provider sessions were not revoked: the computer's owner or their provider's administrator must revoke them at claude.ai and in ChatGPT's settings.",
    call: (base) => ({ action: "delete_without_sign_out", interfaceVersion: v, ...base }),
    admin: (view) => view.removal === "pending",
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
    admin: () => true,
  },
];

export function actionBySlug(slug: string): ActionSpec | undefined {
  return ACTIONS.find((a) => a.slug === slug);
}

/**
 * Each action as WorkspaceDO's page front classifies it (`ownership.ts`): an action's `admin`
 * predicate is the pages' copy of `pageAllows` for it, and the tests keep the two equal.
 */
export const PAGE_ACTION_OF: Readonly<Record<string, PageAction>> = {
  "set-size": "set_size",
  restart: "restart",
  "stop-without-saving": "stop_without_saving",
  "sign-out": "sign_out",
  "record-revocation": "record_revocation",
  "resolve-removal": "resolve_removal",
  "delete-without-sign-out": "delete_without_sign_out",
  remove: "remove",
};

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
  const text =
    outcome === "accepted" && done?.acceptedText !== undefined
      ? done.acceptedText
      : OUTCOME_TEXT[outcome];
  if (done === undefined || text === undefined) return "";
  const tone = outcome === "accepted" ? "ok" : "warn";
  // An administrator's action on someone else's computer comes back with `as=admin`.
  const title =
    url.searchParams.get("as") === "admin" && done.asAdmin ? done.asAdmin.title : done.title;
  return notice({ tone, kind: "removal_pending", text: `${title}: ${text}` }).replace(
    'data-notice="removal_pending"',
    'data-notice="flash" role="status"',
  );
}

function computerCard(view: ComputerView): string {
  const setup = view.needsSetup ? ` ${badge("warn", "Needs setup")}` : "";
  // WP3.23: the details are on the computer's own page, under "Computer status".
  const lastSave = view.lastSaveFailed
    ? ` <span data-badge="last-save-failed">${badge("danger", "Last save failed")}</span>`
    : "";
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
<p>${badge(view.statusTone, view.status)}${setup}${lastSave}</p>
<ul>${cards}</ul>
<p class="muted" data-saving>${escapeHtml(view.saving)}</p>
${view.notices.map(notice).join("\n")}
<div class="actions">${links.join("")}</div>
</article>`;
}

/**
 * Someone else's computer as an administrator sees it (WP8.4): whose it is, its status and the
 * administrator's own actions; never a link to its setup page, terminal or sign-ins.
 */
function fleetCard(view: ComputerView, ownerName: string | null): string {
  const lastSave = view.lastSaveFailed
    ? ` <span data-badge="last-save-failed">${badge("danger", "Last save failed")}</span>`
    : "";
  const links: string[] = [];
  if (view.running && view.removal !== "pending") {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "restart")}" data-admin-action="restart">Stop (ends work in progress)</a>`,
    );
  }
  if (view.offerRemove) {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "remove")}" data-admin-action="remove">Remove</a>`,
    );
  }
  if (view.removal === "pending" && view.pending?.signOut) {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "sign-out")}" data-admin-action="sign-out">Sign out of Claude and Codex</a>`,
    );
  }
  if (view.removal === "pending" && view.pending?.resolvable) {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "resolve-removal")}" data-admin-action="resolve-removal">Finish the removal</a>`,
    );
  }
  if (view.removal === "pending" && view.pending?.deleteWithoutSignOut) {
    links.push(
      `<a class="button danger" href="${actionPath(view.id, "delete-without-sign-out")}" data-admin-action="delete-without-sign-out">Delete without signing out</a>`,
    );
  }
  const owner = ownerName === null ? "the installation's owner" : ownerName;
  return `<article class="card" data-fleet-computer="${escapeHtml(view.id)}">
<h3>${escapeHtml(view.name)}</h3>
<p class="muted" data-owner>Belongs to ${escapeHtml(owner)}</p>
<p>${badge(view.statusTone, view.status)}${lastSave}</p>
<p class="muted" data-saving>${escapeHtml(view.saving)}</p>
${links.length > 0 ? `<div class="actions">${links.join("")}</div>` : ""}
</article>`;
}

function pendingLine(view: ComputerView): string {
  const p = view.pending;
  if (p === null) return "";
  let what: string;
  if (p.resolvable) what = "Ready to finish.";
  else if (p.signingOut) what = "Signing out now.";
  else if (p.verifying) what = "Signed out; the sign-out is being verified.";
  else if (p.revocationRequired) {
    what = "Still needs your record that you revoked its sessions at the providers.";
  } else if (p.signOut) {
    what = "Still needs a sign-out on the computer, or your record that you revoked its sessions.";
  } else what = "Waiting for the computer to stop before its removal can finish.";
  return `<li data-removal="${escapeHtml(view.id)}"><a href="${computerPath(view.id)}">${escapeHtml(view.name)}</a>: ${escapeHtml(what)} Its saved logins are kept until then.</li>`;
}

/** The outages that need nothing now, collapsed below the computers (a `<details>`: no script). */
function earlierOutages(earlier: readonly Notice[]): string {
  if (earlier.length === 0) return "";
  return `<details class="earlier" data-earlier-outages>
<summary>Earlier interruptions (${earlier.length})</summary>
${earlier.map(notice).join("\n")}
</details>`;
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
  const fleet: { readonly view: ComputerView; readonly ownerName: string | null }[] = [];
  const unreadable: string[] = [];
  // Only an administrator is told which computers could not be read: anyone else learns nothing
  // about computers that are not theirs (WP8.4).
  const admin =
    owner.person === undefined ||
    owner.person.kind === "installation_owner" ||
    owner.person.role !== "member";
  for (const entry of states) {
    if (entry.state === undefined) {
      if (admin) unreadable.push(entry.name);
    } else if (entry.state !== null && entry.state.computer.lifecycle !== "removed") {
      const view = computerView(entry.state.computer, nowMs);
      if (entry.state.computer.access === "admin") {
        fleet.push({ view, ownerName: entry.state.computer.ownerName ?? null });
      } else views.push(view);
    }
  }
  // The computers come first: only what still needs attention is above them (WP8.10).
  const outageGroups = outageNoticeGroups(outages ?? [], nowMs);
  const notices = [
    ...(replicationNotice(replication, nowMs) === null
      ? []
      : [replicationNotice(replication, nowMs)]),
    ...outageGroups.current,
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
${fleet.length > 0 ? `<h2>The team's other computers</h2><p class="muted">As an administrator you can stop another person's computer, remove one Omnigent no longer calls, and finish its pending removal. Setting it up, signing in on it and its terminal are its owner's alone.</p><div class="cards" data-fleet>${fleet.map((f) => fleetCard(f.view, f.ownerName)).join("\n")}</div>` : ""}
${earlierOutages(outageGroups.earlier)}
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
        const again = view.signOutPhase === "none" ? "" : "The last sign-out did not finish. ";
        items.push(
          `<li>${again}<a class="button danger" href="${actionPath(view.id, "sign-out")}">Sign out of Claude and Codex</a>: starts the computer once for the CLIs' logouts.</li>`,
        );
      }
      if (
        p !== null &&
        !p.resolvable &&
        !p.signOut &&
        !p.signingOut &&
        !p.verifying &&
        !p.revocationRequired
      ) {
        items.push(
          "<li>The removal can finish once the computer has stopped; this page updates when it has.</li>",
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
  const asAdmin = state.computer.access === "admin";
  const back = `<a class="button" href="${asAdmin ? COMPUTERS_PATH : computerPath(id)}">Cancel</a>`;
  if (
    !spec.offered(view, state.computer) ||
    state.intentToken === undefined ||
    (asAdmin && !spec.admin(view))
  ) {
    // 409, not 200: a page without the form is never mistaken for a confirmation.
    return htmlResponse(
      layout(
        spec.title,
        `<h1>${escapeHtml(spec.title)}</h1><p data-confirm="not-offered">This is not offered for ${escapeHtml(view.name)} now.</p><div class="actions">${back}</div>`,
      ),
      409,
    );
  }
  const wording = asAdmin && spec.asAdmin !== undefined ? spec.asAdmin : null;
  const title = wording?.title ?? spec.title;
  const extra =
    spec.slug === "set-size"
      ? `<label>Size <select name="size">${InstanceSize.options.map((s) => `<option value="${s}"${s === (state.computer.nextSize ?? state.computer.size) ? " selected" : ""}>${s}</option>`).join("")}</select></label>`
      : "";
  const body = `<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(view.name)}</p>
${wording?.explain ?? spec.explain(view, state.computer)}
<p class="muted">Opening this page changed nothing. Nothing happens until you press the button.</p>
<form method="post" action="${actionPath(id, spec.slug)}" class="actions" data-confirm="${spec.slug}">
${hidden("intent", state.intentToken)}${hidden("op", newOperationId())}
${extra}
<button type="submit" class="${spec.danger ? "danger" : "primary"}">${escapeHtml(wording?.button ?? spec.button)}</button>
${back}
</form>`;
  return htmlResponse(layout(title, body));
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
  // An administrator acting on someone else's computer goes back to the list: its setup page is
  // the owner's alone (WP8.4).
  const after = await backend.state(id, owner).catch(() => null);
  const asAdmin = after?.computer.access === "admin";
  const query = new URLSearchParams({
    done: spec.slug,
    outcome,
    ...(asAdmin ? { as: "admin" } : {}),
  });
  const back = asAdmin ? COMPUTERS_PATH : computerPath(id);
  return seeOther(`${back}?${query.toString()}`);
}

export { flash as flashNotice };
