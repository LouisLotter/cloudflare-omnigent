// The owner's Omnigent password page (WP3.34), under `/platform/password`, behind ingress (Access
// and the owner pin) like every platform page:
//
//   GET  /platform/password             "Choose your Omnigent password" while the owner has none
//                                       (the installer chose none), else "Reset your Omnigent
//                                       password"; `?result=<word>` shows a change's outcome
//   POST /platform/password             the change: exact origin, fetch metadata, form type, a
//                                       bounded body (`http.ts`), and the request-intent token,
//                                       which OmnigentServer compares in constant time; then a
//                                       303 to `?result=…`, so a reload never repeats it
//
// and the first-visit redirect: a top-level navigation outside `/platform/` while the owner has no
// password yet goes to this page. It is a convenience, never a control: any failure to ask
// forwards the request as usual, and an isolate that has seen "chosen" stops asking.
//
// The password goes from the form to OmnigentServer (`ownerPassword`) and nowhere else: it is
// never logged, echoed back, put in a URL or kept. The page carries no script. A reset signs the
// owner out of Omnigent everywhere (Omnigent's own password change), which the page says first.

import {
  MAX_OWNER_PASSWORD_LENGTH,
  MIN_OWNER_PASSWORD_LENGTH,
  type OwnerPasswordCall,
  OwnerPasswordResult,
  ownerPasswordProblem,
  type PageOwner,
} from "@cfo/contracts";
import type { Admitted } from "../ingress/index.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION, OMNIGENT_SERVER_OBJECT_NAME } from "../shared/rpc.ts";
import { hidden, layout, PASSWORD_PAGE_PATH } from "./html.ts";
import { escapeHtml, htmlResponse, readChange, seeOther } from "./http.ts";

export const PASSWORD_PATH = PASSWORD_PAGE_PATH;
/** Where the page sends the owner once the password is set: Omnigent, which asks for it. */
const SIGN_IN_PATH = "/";

/** What the password page calls: OmnigentServer's `ownerPassword`. */
export interface PasswordBackend {
  ownerPassword(call: OwnerPasswordCall): Promise<OwnerPasswordResult>;
}

/** The web Worker's binding, typed down to the one method the page may call. */
export function bindingsPasswordBackend(env: {
  readonly OMNIGENT: { getByName(name: string): unknown };
}): PasswordBackend {
  return {
    async ownerPassword(call) {
      const stub = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as PasswordBackend;
      return OwnerPasswordResult.parse(await stub.ownerPassword(call));
    },
  };
}

type Log = (fields: Readonly<Record<string, string>>) => void;
type Tone = "ok" | "info" | "warn" | "danger";
type State = Extract<OwnerPasswordResult, { action: "state" }>;

/** The outcomes `?result=` may name, and what the page says for each. */
const RESULTS = {
  unconfirmed: {
    tone: "warn",
    text: "The change could not be confirmed yet. Wait a minute, then set your password again, so that it is kept.",
  },
  unavailable: {
    tone: "warn",
    text: "Omnigent is starting or restoring right now. Wait a minute, then try again.",
  },
  rate_limited: { tone: "warn", text: "Too many attempts. Wait a few minutes, then try again." },
  intent: { tone: "warn", text: "This page was out of date, so nothing was changed. Try again." },
  not_configured: {
    tone: "danger",
    text: "This installation names no Omnigent owner, so the password cannot be set here.",
  },
  failed: {
    tone: "danger",
    text: "The password could not be changed. Try again; if it keeps failing, the installation needs a look.",
  },
} as const satisfies Readonly<Record<string, { readonly tone: Tone; readonly text: string }>>;

type ResultWord = keyof typeof RESULTS;

function resultOf(word: string | null): ResultWord | null {
  return word !== null && Object.hasOwn(RESULTS, word) ? (word as ResultWord) : null;
}

/** An error's name for a log line, never its message (which could quote a request). */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

const PROBLEMS = {
  mismatch: "The two passwords differ. Type the same password twice.",
  too_short: `The password needs at least ${MIN_OWNER_PASSWORD_LENGTH} characters.`,
  too_long: `The password can have at most ${MAX_OWNER_PASSWORD_LENGTH} characters.`,
} as const;

function notice(tone: Tone, kind: string, text: string): string {
  return `<div class="notice tone-${tone}" data-notice="${escapeHtml(kind)}"><span>${escapeHtml(text)}</span></div>`;
}

const unavailablePage = () =>
  htmlResponse(
    layout(
      "Omnigent password",
      `<h1>Not available right now</h1><p data-refused>The password page cannot reach Omnigent right now. Wait a minute, then reload this page.</p>`,
    ),
    503,
  );

async function readState(backend: PasswordBackend, owner: PageOwner): Promise<State> {
  const result = await backend.ownerPassword({
    action: "state",
    interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
    owner,
  });
  if (result.action !== "state") throw new Error("not a state");
  return result;
}

function formPage(state: State, problem: string | null, status = 200): Response {
  const choosing = state.state === "unchosen";
  const title = choosing ? "Choose your Omnigent password" : "Reset your Omnigent password";
  const intro = choosing
    ? "Omnigent is ready. Choose the password you will sign in with, and save it in your password manager: nobody else knows it, not even the installer."
    : "Forgot your Omnigent password? Choose a new one here. This signs you out of Omnigent everywhere, in every browser and on every device; your cloud computers keep running.";
  const username = state.username;
  const body =
    username === null
      ? `<h1>${title}</h1>${notice("danger", "not_configured", RESULTS.not_configured.text)}`
      : `<h1>${title}</h1>
<p>${escapeHtml(intro)}</p>
${problem === null ? "" : notice("warn", "problem", problem)}
<form class="password" method="post" action="${PASSWORD_PATH}" data-password-form="${choosing ? "choose" : "reset"}">
${hidden("intent", state.intentToken)}
<label>Your Omnigent username
<input type="text" name="username" autocomplete="username" value="${escapeHtml(username)}" readonly></label>
<label>New password
<input type="password" name="password" autocomplete="new-password" minlength="${MIN_OWNER_PASSWORD_LENGTH}" maxlength="${MAX_OWNER_PASSWORD_LENGTH}" required></label>
<label>The same password again
<input type="password" name="confirm" autocomplete="new-password" minlength="${MIN_OWNER_PASSWORD_LENGTH}" maxlength="${MAX_OWNER_PASSWORD_LENGTH}" required></label>
<p class="muted">At least ${MIN_OWNER_PASSWORD_LENGTH} characters.</p>
<div class="actions"><button class="primary" type="submit">${choosing ? "Set my password" : "Reset my password"}</button></div>
</form>`;
  return htmlResponse(layout(title, body), status);
}

function donePage(state: State): Response {
  const as = state.username === null ? "" : ` as <strong>${escapeHtml(state.username)}</strong>`;
  return htmlResponse(
    layout(
      "Your Omnigent password is set",
      `<h1>Your Omnigent password is set</h1>
${notice("ok", "done", "Done. Every earlier Omnigent sign-in of yours has ended.")}
<p>Sign in to Omnigent${as} with your new password.</p>
<div class="actions"><a class="button primary" href="${SIGN_IN_PATH}" data-sign-in>Sign in to Omnigent</a></div>`,
    ),
  );
}

/** GET: the form, or a change's outcome. */
export async function passwordPage(
  backend: PasswordBackend,
  owner: PageOwner,
  url: URL,
  log: Log,
): Promise<Response> {
  let state: State;
  try {
    state = await readState(backend, owner);
  } catch (error) {
    log({ event: "password_page_unavailable", error: errorName(error) });
    return unavailablePage();
  }
  const word = url.searchParams.get("result");
  // "Done" only when OmnigentServer says this session's change was confirmed, never on the URL's
  // word alone (Codex WP3.34 r1-3); otherwise the form, with no outcome.
  if (word === "done" && state.justSet === true) return donePage(state);
  const result = resultOf(word);
  const page = formPage(state, null);
  if (result === null) return page;
  // The outcome above the form, which stays for another try.
  const shown = RESULTS[result];
  const html = (await page.text()).replace(
    "<form ",
    `${notice(shown.tone, result, shown.text)}\n<form `,
  );
  return htmlResponse(html);
}

/** POST: the change, after every check, then a 303 to its outcome. */
export async function passwordChange(
  backend: PasswordBackend,
  owner: PageOwner,
  request: Request,
  origin: string,
  log: Log,
): Promise<Response> {
  const change = await readChange(request, origin, "form");
  if (!change.ok) {
    log({ event: "page_change_refused", reason: change.refusal, action: "password" });
    return htmlResponse(
      layout(
        "Refused",
        `<h1>Not done</h1><p data-refused>This change did not come from this installation's own page, so nothing was done.</p><p><a href="${PASSWORD_PATH}">Back to the password page</a></p>`,
      ),
      403,
    );
  }
  const form = change.value;
  const intent = form.intent ?? "";
  const password = form.password ?? "";
  if (!/^[0-9a-f]{64}$/.test(intent)) {
    log({ event: "page_change_refused", reason: "malformed", action: "password" });
    return seeOther(`${PASSWORD_PATH}?result=intent`);
  }
  const problem: keyof typeof PROBLEMS | null =
    password !== (form.confirm ?? "") ? "mismatch" : ownerPasswordProblem(password);
  if (problem !== null) {
    try {
      return formPage(await readState(backend, owner), PROBLEMS[problem], 400);
    } catch {
      return unavailablePage();
    }
  }
  let result: OwnerPasswordResult;
  try {
    result = await backend.ownerPassword({
      action: "set",
      interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
      owner,
      intent,
      password,
    });
  } catch (error) {
    // An object still on an older build, or a lost call: nothing to show but "try again".
    log({ event: "password_change_error", error: errorName(error) });
    return seeOther(`${PASSWORD_PATH}?result=unavailable`);
  }
  if (result.action !== "set") return seeOther(`${PASSWORD_PATH}?result=failed`);
  const word = result.outcome === "refused" ? result.reason : result.outcome;
  log({ event: "password_change", outcome: word });
  return seeOther(`${PASSWORD_PATH}?result=${word}`);
}

/** Whether a request is a browser's top-level page load. */
function isNavigation(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (request.headers.get("upgrade") !== null) return false;
  return (
    request.headers.get("sec-fetch-mode") === "navigate" ||
    request.headers.get("sec-fetch-dest") === "document"
  );
}

/** What one web Worker isolate remembers: once the owner has a password, it stops asking. */
export interface FirstVisitMemo {
  chosen: boolean;
}

/**
 * The first-visit redirect: a page load outside `/platform/` while the owner still has to choose
 * a password goes to the password page. Null: forward as usual.
 */
export async function firstVisitRedirect(
  admitted: Admitted,
  backend: PasswordBackend,
  memo: FirstVisitMemo,
  log: Log,
): Promise<Response | null> {
  if (memo.chosen || !isNavigation(admitted.request)) return null;
  const owner: PageOwner = { sub: admitted.identity.sub, sessionId: admitted.identity.sessionId };
  try {
    const state = await readState(backend, owner);
    if (state.state === "chosen") {
      memo.chosen = true;
      return null;
    }
    return seeOther(PASSWORD_PATH);
  } catch (error) {
    log({ event: "first_visit_unknown", error: errorName(error) });
    return null;
  }
}
