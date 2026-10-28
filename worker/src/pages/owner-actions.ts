// The setup page's owner actions (WP3.23; D31: every happy path has UI, the terminal is the
// fallback): sign in to Claude and Codex from the page, the computer's status, and the staging-only
// RC-53 switch. Routes, under a computer's page:
//
//   GET  …/sign-in?service=claude&attempt=3   an attempt's state now (JSON with escaped markup)
//   POST …/sign-in                            start, the pasted code, or cancel (JSON body)
//   GET  …/status                             the computer's status now (JSON with escaped markup)
//   POST …/staging-check                      staging only: RC-53's save check on or off
//
// Every POST passes the pages' checks (`readChange`: exact Origin, fetch metadata, a bounded JSON
// body) and carries the page's request-intent token, which WorkspaceDO's page front compares for
// the caller's Access session before any effect. A GET changes nothing. The provider's link,
// Codex's code and the pasted code are never logged: logs name events and refusals only, request
// paths are logged without their query, and bodies never.

import {
  type ComputerId,
  type ComputerStatusView,
  Generation,
  OperationId,
  type PageOwner,
  type PageSignInView,
  SignInAttempt,
  SignInCode,
  type SignInRefusal,
  SignInService,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { errorCodeOf } from "../shared/errors.ts";
import type { PagesBackend } from "./backend.ts";
import { errorText } from "./computers.ts";
import { badge } from "./html.ts";
import { escapeHtml, jsonResponse, readChange } from "./http.ts";
import { formatTime } from "./view.ts";

type Log = (fields: Readonly<Record<string, string>>) => void;

const TITLE = { claude: "Claude", codex: "Codex" } as const;
const PROVIDER = { claude: "Anthropic", codex: "OpenAI" } as const;
/** ChatGPT's security settings, where device-code sign-in is turned on. */
export const CHATGPT_SECURITY_URL = "https://chatgpt.com/#settings/Security";
/** The terminal fallback's command per card. */
export const FALLBACK_COMMAND = {
  claude: "claude auth login --claudeai",
  codex: "codex login --device-auth",
} as const;

function button(act: string, text: string, kind = ""): string {
  return `<button type="button" data-act="${act}"${kind ? ` class="${kind}"` : ""}>${escapeHtml(text)}</button>`;
}

function terminalOffer(service: SignInService): string {
  return `<p class="muted" data-fallback>Or sign in with the terminal below: open it and run <code>${escapeHtml(FALLBACK_COMMAND[service])}</code>.</p>${button("terminal", "Use the terminal instead")}`;
}

const FAILED: Readonly<Record<string, (s: SignInService) => string>> = {
  code_rejected: () =>
    "The code was not accepted. It may be incomplete, expired or from an earlier attempt. Start again and paste the new code.",
  denied: () =>
    "OpenAI did not accept this sign-in. Check that device-code sign-in is turned on in ChatGPT's security settings, then start again.",
  network: (s) => `The computer could not reach ${PROVIDER[s]}. Start again in a moment.`,
  unexpected_output: (s) =>
    `${s === "claude" ? "Claude Code" : "Codex"} answered something unexpected, so this page cannot continue. Open the terminal to sign in by hand.`,
  cli_exited: () => "The sign-in stopped unexpectedly. Start again, or sign in with the terminal.",
  start_failed: () => "The sign-in could not start on the computer. Start again shortly.",
  not_ready: () => "The computer is still starting. Start again in a moment.",
};

const REFUSED: Readonly<Record<SignInRefusal, string>> = {
  not_running:
    "The computer is not running. Send it work in Omnigent (a new conversation on it wakes it), then start again.",
  busy: "The computer is stopping or signing out. Try again shortly.",
  not_offered: "Signing in is not offered while a removal is pending.",
  unsupported:
    "This computer's software is older and cannot sign in from this page. Use the terminal instead.",
  not_yours:
    "This sign-in was started in another browser window. Start a new one here if you want to continue here.",
  stale: "This sign-in has ended, or the computer restarted since this page loaded. Start again.",
  unreachable: "The computer did not answer just now. This page keeps trying.",
};

function codexNote(service: SignInService): string {
  return service === "codex"
    ? `<p class="muted" data-codex-setting>Device-code sign-in must first be turned on in <a href="${CHATGPT_SECURITY_URL}" target="_blank" rel="noopener noreferrer">ChatGPT's security settings</a>.</p>`
    : "";
}

/** The start button (with what precedes a first attempt); `again` once the card is signed in. */
export function signInIdleHtml(
  service: SignInService,
  offered: boolean,
  note = "",
  again = false,
): string {
  const label = `Sign in to ${TITLE[service]}${again ? " again" : ""}`;
  return `${note ? `<p data-sign-in-note>${escapeHtml(note)}</p>` : ""}${codexNote(service)}<div class="actions"><button type="button" class="primary" data-act="start"${offered ? "" : " disabled"}>${escapeHtml(label)}</button></div>`;
}

/** The flow's markup for an attempt (or a refusal): escaped, and the link only on its host. */
export function signInHtml(
  service: SignInService,
  answer:
    | { readonly outcome: "accepted"; readonly view: PageSignInView }
    | { readonly outcome: "refused"; readonly reason: SignInRefusal },
  nowMs: number,
): string {
  if (answer.outcome === "refused") {
    const fallback = answer.reason === "unsupported" ? terminalOffer(service) : "";
    const again =
      answer.reason === "unreachable" || answer.reason === "unsupported"
        ? ""
        : signInIdleHtml(service, answer.reason !== "not_offered");
    return `<p class="tone-warn" data-sign-in-refused="${answer.reason}">${escapeHtml(REFUSED[answer.reason])}</p>${fallback}${again}`;
  }
  const v = answer.view;
  if (v.pending === true) {
    // Ended here, not yet confirmed stopped on the computer: no terminal offer until it is.
    return `<p class="muted" data-sign-in-state="stopping">Stopping the sign-in on the computer…</p>`;
  }
  const until = v.deadline
    ? ` It ends at ${escapeHtml(formatTime(v.deadline, nowMs))} if not finished.`
    : "";
  const cancel = button("cancel", "Cancel");
  switch (v.state) {
    case "starting":
      return `<p data-sign-in-state="starting">Starting the sign-in…</p><div class="actions">${cancel}</div>`;
    case "awaiting_user": {
      const link = v.url
        ? `<a class="button primary" data-provider-link href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer">Open ${PROVIDER[service]}'s ${service === "claude" ? "sign-in page" : "page"}</a>`
        : "";
      if (service === "claude") {
        const notice =
          v.notice === "incomplete_code"
            ? `<p class="tone-warn" data-sign-in-notice>That code looks incomplete. Copy the whole code from Anthropic's page and paste it again.</p>`
            : "";
        return `<ol class="steps" data-sign-in-state="awaiting_user">
<li>${link} Sign in there with your Claude account. Anthropic then shows you a code.</li>
<li><label>Paste the code Anthropic shows you <input type="text" name="code" autocomplete="off" spellcheck="false" maxlength="1024" data-code></label> ${button("continue", "Continue", "primary")}</li>
</ol>${notice}<p class="muted">${until}</p><div class="actions">${cancel}</div>`;
      }
      const code = v.userCode ? escapeHtml(v.userCode) : "";
      return `<ol class="steps" data-sign-in-state="awaiting_user">
<li>${link} Sign in there with your ChatGPT account.</li>
<li>Enter this code on OpenAI's page: <code class="user-code" data-user-code>${code}</code> ${button("copy", "Copy")}</li>
</ol><p class="muted">This page waits until you finish on OpenAI's page.${until}</p>${codexNote(service)}<div class="actions">${cancel}</div>`;
    }
    case "completing":
      return `<p data-sign-in-state="completing">Signing in…</p><div class="actions">${cancel}</div>`;
    case "done":
      return `<p class="tone-ok" data-sign-in-state="done">Signed in. The login is being saved with this computer; this card shows "Signed in" once it is.</p>`;
    case "failed": {
      const text = (FAILED[v.reason ?? "cli_exited"] ?? FAILED.cli_exited)?.(service) ?? "";
      return `<p class="tone-danger" data-sign-in-state="failed" data-reason="${escapeHtml(v.reason ?? "cli_exited")}">${escapeHtml(text)}</p>${terminalOffer(service)}${signInIdleHtml(service, true)}`;
    }
    case "expired":
      return `<p class="tone-warn" data-sign-in-state="expired">The sign-in expired after 10 minutes. Start again.</p>${terminalOffer(service)}${signInIdleHtml(service, true)}`;
    case "cancelled":
      return `<p class="muted" data-sign-in-state="cancelled">Cancelled.</p>${signInIdleHtml(service, true)}`;
    case "superseded":
      return `<p class="tone-warn" data-sign-in-state="superseded">A newer sign-in was started, perhaps in another tab or window, so this one ended.</p>${signInIdleHtml(service, true)}`;
    default:
      return `<p class="tone-warn" data-sign-in-state="none">The computer restarted, so this sign-in ended. Start again.</p>${terminalOffer(service)}${signInIdleHtml(service, true)}`;
  }
}

function parseService(value: string | undefined | null): SignInService | null {
  const parsed = SignInService.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseAttempt(value: string | undefined | null): number | null {
  if (value === undefined || value === null || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = SignInAttempt.safeParse(Number(value));
  return parsed.success ? parsed.data : null;
}

/** GET `…/sign-in?service=&attempt=`: an attempt's state now. Changes nothing. */
export async function signInRead(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  url: URL,
  nowMs: number,
  log: Log,
): Promise<Response> {
  const service = parseService(url.searchParams.get("service"));
  const attempt = parseAttempt(url.searchParams.get("attempt"));
  if (service === null || attempt === null)
    return jsonResponse({ error: { code: "bad_request" } }, 400);
  try {
    const result = await backend.read(id, {
      action: "sign_in_status",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      owner,
      service,
      attempt,
    });
    if (result.action !== "sign_in_status") throw new Error("not a sign-in status");
    return jsonResponse({ ...result, html: signInHtml(service, result, nowMs) });
  } catch (error) {
    return failure(error, "sign_in_read_failed", log);
  }
}

function failure(error: unknown, event: string, log: Log): Response {
  const code = errorCodeOf(error);
  log({ event, code: code ?? "unknown" });
  const [status] = errorText(code);
  return jsonResponse({ error: { code: code ?? "unavailable" } }, status);
}

/** POST `…/sign-in`: `mode` start, input (Claude's code) or cancel. */
export async function signInChange(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  request: Request,
  origin: string,
  nowMs: number,
  log: Log,
): Promise<Response> {
  const change = await readChange(request, origin, "json");
  if (!change.ok) {
    log({ event: "sign_in_change_refused", reason: change.refusal });
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  const {
    op,
    intent,
    mode,
    service: rawService,
    attempt: rawAttempt,
    code,
    generation: rawGeneration,
  } = change.value;
  const operationId = OperationId.safeParse(op);
  const service = parseService(rawService);
  if (!operationId.success || intent === undefined || !/^[0-9a-f]{64}$/.test(intent)) {
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  if (service === null) return jsonResponse({ error: { code: "bad_request" } }, 400);
  const base = {
    interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    operationId: operationId.data,
    owner,
    intent,
  };
  let call: Parameters<PagesBackend["act"]>[1];
  if (mode === "start") {
    // The generation the page shows: a start for another is refused (WorkspaceDO checks it).
    const generation = Generation.safeParse(
      rawGeneration !== undefined && /^[0-9]{1,15}$/.test(rawGeneration)
        ? Number(rawGeneration)
        : -1,
    );
    if (!generation.success) return jsonResponse({ error: { code: "bad_request" } }, 400);
    call = { action: "sign_in_start", ...base, service, generation: generation.data };
  } else {
    const attempt = parseAttempt(rawAttempt);
    if (attempt === null) return jsonResponse({ error: { code: "bad_request" } }, 400);
    if (mode === "cancel") call = { action: "sign_in_cancel", ...base, service, attempt };
    else if (mode === "input") {
      // A code is pasted with spaces or a line break around it often; inside, only printable
      // characters (the contract's `SignInCode`). Never logged.
      const pasted = SignInCode.safeParse((code ?? "").trim());
      if (!pasted.success)
        return jsonResponse({ error: { code: "bad_request", field: "code" } }, 400);
      call = { action: "sign_in_input", ...base, service, attempt, code: pasted.data };
    } else return jsonResponse({ error: { code: "bad_request" } }, 400);
  }
  try {
    const result = await backend.act(id, call);
    if (
      result.action !== "sign_in_start" &&
      result.action !== "sign_in_input" &&
      result.action !== "sign_in_cancel"
    ) {
      throw new Error("not a sign-in answer");
    }
    const answer = result as
      | { readonly outcome: "accepted"; readonly view: PageSignInView }
      | { readonly outcome: "refused"; readonly reason: SignInRefusal };
    if (answer.outcome === "refused") log({ event: "sign_in_refused", reason: answer.reason });
    return jsonResponse({ ...result, html: signInHtml(service, answer, nowMs) });
  } catch (error) {
    return failure(error, "sign_in_change_failed", log);
  }
}

// ---------------------------------------------------------------------------------------------
// The computer's status.

const OUTCOME: Readonly<Record<string, string>> = {
  published: "Saved",
  unchanged: "Nothing changed",
  discarded: "Not used (a newer save came first)",
  failed: "Failed",
};

const SAVE_REASON: Readonly<Record<string, string>> = {
  lease_expired: "the computer could not be paused briefly enough",
  disk_budget: "not enough disk space",
  copy_failed: "the files could not be copied",
  stage_failed: "the save could not be prepared",
  parent_mismatch: "the previous save did not match",
  policy_violation: "the save held something it must not",
  busy: "another save was running",
  upload: "the upload failed",
  deadline: "it took too long",
  parent_changed: "a newer save came first",
  internal: "an unexpected error",
};

const ALERT_TEXT: Readonly<Record<string, string>> = {
  command_failed: "A command from the platform failed",
  restore_stripped: "A restored save held something it should not, and it was left out",
  restore_failed: "A restore failed",
  rc53_collect_failed: "RC-53: the logins' values could not be collected",
  rc53_finding: "RC-53: a save held a login value, or could not be checked",
  capture_skipped_paths: "A save left some paths out",
  capture_resumed: "Processes a save had paused were resumed",
  capture_journal_failed: "A save's pause record could not be replayed",
  capture_no_result: "A save ended without a result",
  credential_refused: "A login save was refused",
  credential_alert: "A login file could not be read for saving",
  hello_unanswered: "The computer's first message got no answer",
  report_failed: "A status report failed",
  sign_in_failed: "A sign-in failed",
  other: "Other",
};

const LOGIN_TEXT: Readonly<Record<string, string>> = {
  signed_in: "signed in",
  signed_out: "signed out",
  expired: "expired",
  unknown: "not known",
};

const FILE_TEXT: Readonly<Record<string, string>> = {
  present: "saved",
  tombstone: "saved as removed (a tombstone)",
  none: "nothing saved yet",
};

const SIGN_OUT_TEXT: Readonly<Record<string, string>> = {
  none: "No sign-out has run.",
  requested: "A sign-out was asked for and has not been confirmed yet.",
  tombstoned:
    "Signed out: the saved logins now hold tombstones (removed files). This is not yet a check of the stored copy.",
  verified:
    "Signed out and checked: the stored copy of the saved logins holds four tombstones. This is not a test in a fresh computer, and not proof that the providers revoked the sessions.",
};

const SUPERVISOR_TEXT: Readonly<Record<string, string>> = {
  not_running: "The computer is not running, so only what the platform saved is shown.",
  unreachable: "The computer did not answer just now, so only what the platform saved is shown.",
  unsupported:
    "This computer's software is older and does not report its own status; only what the platform saved is shown.",
};

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** The status section's body: escaped, names and counts only. */
export function statusHtml(view: ComputerStatusView, nowMs: number): string {
  const rows: string[] = [];
  const m = view.metrics;
  const row = (label: string, value: string, key: string) =>
    rows.push(`<dt>${escapeHtml(label)}</dt><dd data-status="${key}">${value}</dd>`);
  if (view.supervisor !== "ok") {
    rows.push(
      `<dt>Computer</dt><dd data-status="supervisor">${escapeHtml(SUPERVISOR_TEXT[view.supervisor] ?? "")}</dd>`,
    );
  }
  if (m !== null) {
    const v = m.versions;
    row(
      "Software",
      escapeHtml(
        `Claude Code ${v.claude ?? "not known"}, Codex ${v.codex ?? "not known"}, gh ${v.gh ?? "not known"}`,
      ),
      "versions",
    );
    row(
      "The CLIs say",
      escapeHtml(
        `Claude ${LOGIN_TEXT[m.logins.claude] ?? "not known"}, Codex ${LOGIN_TEXT[m.logins.codex] ?? "not known"}`,
      ),
      "logins",
    );
    row(
      "Hostname",
      escapeHtml(
        m.hostname === "mapped"
          ? "mapped (sudo works without a warning)"
          : m.hostname === "unmapped"
            ? "not mapped (sudo prints a warning)"
            : "not known",
      ),
      "hostname",
    );
    if (m.disk !== null) {
      row("Disk", escapeHtml(`${gb(m.disk.freeBytes)} free of ${gb(m.disk.totalBytes)}`), "disk");
    }
  }
  const checkpoint = view.credentials.checkpoint;
  row(
    "Saved logins",
    `${escapeHtml(checkpoint === null ? "No login has been saved." : `Saved at ${formatTime(checkpoint.createdAt, nowMs)} (save ${checkpoint.order}).`)}<ul>${view.credentials.files
      .map(
        (f) =>
          `<li data-file="${escapeHtml(f.path)}"><code>~/${escapeHtml(f.path)}</code>: ${escapeHtml(FILE_TEXT[f.state] ?? f.state)}</li>`,
      )
      .join("")}</ul>`,
    "credentials",
  );
  row(
    "Sign-out",
    escapeHtml(
      `${SIGN_OUT_TEXT[view.signOut.phase] ?? ""}${view.signOut.running ? " A sign-out runs now." : ""}`,
    ),
    "sign-out",
  );
  const saves = view.saves.slice(0, 5);
  row(
    "Last saves",
    saves.length === 0
      ? escapeHtml("No save has finished yet.")
      : `<ul>${saves
          .map((s) => {
            const why =
              s.reason === null ? "" : `: ${SAVE_REASON[s.reason] ?? "an unexpected error"}`;
            const rc53 =
              s.rc53 === null
                ? ""
                : `. RC-53: ${s.rc53.findings} ${s.rc53.findings === 1 ? "match" : "matches"} in ${s.rc53.files} files${s.rc53.incomplete > 0 ? `, ${s.rc53.incomplete} not checked` : ""}`;
            return `<li data-save="${escapeHtml(s.outcome)}">${escapeHtml(`${formatTime(s.at, nowMs)}: ${OUTCOME[s.outcome] ?? s.outcome}${why}${rc53}`)}</li>`;
          })
          .join("")}</ul>`,
    "saves",
  );
  if (m !== null && m.alerts.length > 0) {
    row(
      "Recent alerts",
      `<ul>${m.alerts
        .map(
          (a) =>
            `<li data-alert="${escapeHtml(a.kind)}">${escapeHtml(`${ALERT_TEXT[a.kind] ?? "Other"}: ${a.count}`)}</li>`,
        )
        .join("")}</ul>`,
      "alerts",
    );
  }
  const rc53 = view.rc53;
  if (rc53.staging) {
    const desired = rc53.desired === true;
    const applied = rc53.applied === null ? "not known now" : rc53.applied ? "on" : "off";
    row(
      "RC-53 save check (staging)",
      `${badge(desired ? "info" : "warn", desired ? "On" : "Off")} <span class="muted">On the computer now: ${escapeHtml(applied)}.</span> ${button(
        "rc53",
        desired ? "Turn it off" : "Turn it on",
      ).replace('data-act="rc53"', `data-act="rc53" data-rc53="${desired ? "off" : "on"}"`)}`,
      "rc53",
    );
  } else if (m !== null) {
    row("RC-53 save check", escapeHtml(m.rc53 ? "on" : "off"), "rc53");
  }
  return `<p class="muted" data-observed>As of ${escapeHtml(formatTime(view.observedAt, nowMs))}.</p><dl class="facts">${rows.join("")}</dl>`;
}

/** GET `…/status`: the computer's status now. Changes nothing. */
export async function statusRead(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  nowMs: number,
  log: Log,
): Promise<Response> {
  try {
    const result = await backend.read(id, {
      action: "computer_status",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      owner,
    });
    if (result.action !== "computer_status") throw new Error("not a status");
    const status = (result as { readonly status: ComputerStatusView }).status;
    return jsonResponse({ status, html: statusHtml(status, nowMs) });
  } catch (error) {
    return failure(error, "status_read_failed", log);
  }
}

/** POST `…/staging-check`: RC-53's save check on or off (staging only). */
export async function stagingChange(
  backend: PagesBackend,
  owner: PageOwner,
  id: ComputerId,
  request: Request,
  origin: string,
  log: Log,
): Promise<Response> {
  const change = await readChange(request, origin, "json");
  if (!change.ok) {
    log({ event: "staging_change_refused", reason: change.refusal });
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  const { op, intent, rc53 } = change.value;
  const operationId = OperationId.safeParse(op);
  if (!operationId.success || intent === undefined || !/^[0-9a-f]{64}$/.test(intent)) {
    return jsonResponse({ error: { code: "forbidden" } }, 403);
  }
  if (rc53 !== "on" && rc53 !== "off") return jsonResponse({ error: { code: "bad_request" } }, 400);
  try {
    const result = await backend.act(id, {
      action: "staging_check",
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      operationId: operationId.data,
      owner,
      intent,
      rc53: rc53 === "on",
    });
    if (result.action !== "staging_check") throw new Error("not a staging answer");
    if ("reason" in result) log({ event: "staging_check_refused", reason: String(result.reason) });
    return jsonResponse(result);
  } catch (error) {
    return failure(error, "staging_change_failed", log);
  }
}
