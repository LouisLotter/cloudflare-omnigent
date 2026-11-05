// WorkspaceDO's page front (WP3.5): the one way the web Worker's pages reach a computer's
// WorkspaceDO, in front of the controller's narrow `pages` interface (WP3.1). It:
//   - answers `PageFrontCall` itself: the setup terminal's window and capability
//     (`terminal.ts`), and a removal the page starts for a computer Omnigent no longer calls;
//   - checks every mutating page call's owner and request-intent token in constant time before
//     any effect (design, Platform pages, "State changes"; P1), and strips both before the
//     controller sees the call, so its operation journal never holds a token;
//   - closes the setup terminal before every credential-sensitive step: a restart, "Stop without
//     saving", a sign-out, a removal, Omnigent's `terminate`, and a sleep or a start-deadline
//     stop once the window has expired (design, "Live streams end");
//   - adds the session's intent token and the terminal's window to the page state;
//   - support access (WP8.15, owner decision D62): an owner or administrator helping someone else
//     opens the computer's setup page, its status and its terminal, changes its size and stops
//     it, but never signs in on it or reads a sign-in attempt. Their state carries each service's
//     sign-in state only, never an attempt, link or code. Each support action logs
//     `page_support_action` with the computer, the action and the actor's member ID (never an
//     account or an address), and every journaled page action records its actor. While an
//     administrator's terminal on someone else's computer is connected, every terminal check
//     (15 s) asks OmnigentServer's `pagePerson` again, bounded at 10 s, whether that person may
//     still help here; a no, a failure or no answer closes the terminal and ends its shell;
//   - sign-in from the page (WP3.23): starts, input and cancels pass the same intent check, bound
//     to the caller's Access session, and run one at a time with the terminal's steps; reads (an
//     attempt's state, the computer's status) change nothing and carry no token, but an attempt is
//     shown only to the session that started it. The pasted code passes through to the controller
//     on the request path only: it is never journaled, stored or logged here.
//
// The request-intent token is HMAC-SHA256 under a random secret kept in this WorkspaceDO's
// storage, over the owner's `sub` and Access session ID: stored, bound to the session, and never
// derivable outside the platform Worker.

import {
  type ComputerPageState,
  type ComputerStatusView,
  IntentToken,
  type LauncherCall,
  PageFrontCall,
  type PageFrontResult,
  PageOwner,
  type PagePersonCall,
  type PagePersonResult,
  PageReadCall,
  type PageReadResult,
  type PageSignInView,
  PagesCall,
  type PagesResult,
  type SignInRefusal,
  type SignInService,
  TERMINAL_UPGRADE_HEADER,
  TerminalUpgrade,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { z } from "zod";
import { platformError } from "../shared/errors.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../shared/rpc.ts";
import {
  pageAccess as accessOf,
  type OwnerBinding,
  type PageAccess,
  type PageAction,
  type PagePersonFields,
  pageAllows,
  personKey,
  removalFactsOf,
  removalStopWithoutSavingDue,
  removeOffered,
} from "./ownership.ts";
import type { Store } from "./record.ts";
import type { TerminalBridge, TerminalTarget } from "./terminal.ts";

type SignInAnswer =
  | { readonly outcome: "accepted"; readonly view: PageSignInView }
  | { readonly outcome: "refused"; readonly reason: SignInRefusal };

/** What the front needs from the controller: its public RPC answers. */
export interface FrontController {
  /**
   * The controller's page calls. `actor`: who made a mutating call (`personKey`: a member ID, or
   * the installation's owner), recorded in the operation journal with its outcome (WP8.15).
   */
  pages(call: unknown, actor?: string): Promise<PagesResult>;
  /**
   * Records a removal intent, as Omnigent's `terminate` does, for the page (WP3.5). Not a launcher
   * call: it names no launcher owner, since the page front decides who may remove (WP8.4).
   */
  removeForPage(): Promise<"pending" | "resolved" | "absent">;
  signInStart(input: {
    readonly service: SignInService;
    readonly session: string;
    readonly operationId: string;
    readonly generation: number;
  }): Promise<SignInAnswer>;
  signInInput(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly code: string;
    readonly session: string;
    readonly operationId: string;
  }): Promise<SignInAnswer>;
  signInCancel(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly session: string;
  }): Promise<SignInAnswer>;
  signInStatus(input: {
    readonly service: SignInService;
    readonly attempt: number;
    readonly session: string;
  }): Promise<SignInAnswer>;
  computerStatus(): Promise<ComputerStatusView>;
  setStagingCheck(input: {
    readonly rc53: boolean;
  }): Promise<
    | { readonly outcome: "accepted"; readonly rc53: boolean }
    | { readonly outcome: "refused"; readonly reason: "not_staging" | "not_offered" }
  >;
  setStagingKeepAwake(input: {
    readonly on: boolean;
  }): Promise<
    | { readonly outcome: "accepted"; readonly on: boolean }
    | { readonly outcome: "refused"; readonly reason: "not_staging" | "not_offered" }
  >;
  sessionAttempts(session: string): readonly {
    readonly service: SignInService;
    readonly attempt: number;
  }[];
  /**
   * Whether this generation's supervisor keeps the setup terminal's shells in sessions that
   * outlive their streams (WP3.28, `terminal_sessions`). Absent or unknown: no.
   */
  terminalShellsKept?(): boolean;
  /**
   * The computer's owner binding and the installation's owner (WP8.4), for the page front's
   * decisions; null for a computer with no record.
   */
  ownership(): {
    readonly binding: OwnerBinding | null;
    readonly installationOwner: string | null;
  } | null;
}

/** The person a page call names; without one (a web Worker before WP8.4), the installation's owner. */
export function personOf(owner: PageOwner | undefined): PagePersonFields {
  return owner?.person ?? { kind: "installation_owner" };
}

/** The owner a raw page call names, if it names a well-formed one. */
function ownerIn(raw: Record<string, unknown>): PageOwner | undefined {
  const owner = PageOwner.safeParse(raw.owner);
  return owner.success ? owner.data : undefined;
}

/** The page front's own calls, as the access rules classify them (`ownership.ts`). */
const FRONT_ACTIONS: Readonly<Record<PageFrontCall["action"], PageAction>> = {
  open_terminal: "terminal",
  close_terminal: "terminal",
  remove: "remove",
  sign_in_start: "sign_in",
  sign_in_input: "sign_in",
  sign_in_cancel: "sign_in",
  staging_check: "staging",
  staging_keep_awake: "staging",
};

/** The controller's mutating page calls, as the access rules classify them. */
const PAGES_ACTIONS: Readonly<Record<Exclude<PagesCall["action"], "state">, PageAction>> = {
  set_size: "set_size",
  restart: "restart",
  stop_without_saving: "stop_without_saving",
  sign_out: "sign_out",
  record_revocation: "record_revocation",
  resolve_removal: "resolve_removal",
  delete_without_sign_out: "delete_without_sign_out",
};

export interface PageFrontDeps {
  readonly store: Store;
  readonly controller: FrontController;
  readonly terminal: TerminalBridge;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  /**
   * OmnigentServer's `pagePerson` (WP8.3), the answer the pages' seam trusts in members
   * admission: asked again while an administrator's terminal on someone else's computer is
   * connected (WP8.15). Absent: no answer, which counts as no.
   */
  readonly person?: (call: PagePersonCall) => Promise<PagePersonResult>;
  /** How long that answer may take before it counts as no; 10 s unless a test sets it. */
  readonly personTimeoutMs?: number;
}

/** How long OmnigentServer's answer about a helping administrator may take (WP8.15). */
export const SUPPORT_ANSWER_MS = 10_000;

/** Why a helping administrator's terminal ended (WP8.15); for the log. */
export type SupportEnd =
  | "suspended"
  | "removed"
  | "invited"
  | "not_bound"
  | "another_member"
  | "not_admin"
  | "unanswered";

function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("no answer in time")), ms);
  });
  return Promise.race([promise, late]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type StateResult = Extract<PagesResult, { action: "state" }>;

const INTENT_SECRET_KEY = "pages/intent-secret";

/**
 * The person who opened the terminal's current window, when it was an administrator helping on
 * someone else's computer (WP8.15, Codex r2 R2-1), and the Access identity WorkspaceDO asks about
 * them with. Written when such a window opens, deleted when its owner opens one. Under its own key,
 * beside the bridge's strict `terminal/` records, so a Worker before WP8.15 still reads those.
 */
const SUPPORT_WINDOW_KEY = "pages/support-window";
const SupportWindow = z.strictObject({
  window: z.number().int().min(1),
  /** The opener's `personKey`: a member ID, or the installation's owner. */
  person: z.string().min(1).max(64),
  sub: z.string().min(1).max(256),
  admission: z.enum(["owner", "members"]).nullable(),
  issuer: z.string().min(1).max(512).nullable(),
  audience: z.string().min(1).max(255).nullable(),
});
type SupportWindow = z.infer<typeof SupportWindow>;
const encoder = new TextEncoder();

/** Page actions that touch the computer's logins: the terminal closes before each. */
const CREDENTIAL_SENSITIVE = new Set(["restart", "stop_without_saving", "sign_out"]);

/** Lifecycle states in which a restored container runs (the terminal can be offered). */
const RESTORED_RUNNING = new Set([
  "started_no_host",
  "start_claimed",
  "host_running",
  "host_refused",
]);

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time equality of two strings of the same alphabet. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Whether a sign-out job runs now: the controller's `signOutRunning`, or, from an older
 * WorkspaceDO without it, a sign-out still `requested`.
 */
export function signOutRunning(state: ComputerPageState): boolean {
  return state.removal.signOutRunning ?? state.removal.signOut === "requested";
}

/** Whether the computer can have a terminal, from the controller's page state. */
export function terminalTarget(state: ComputerPageState, keepsShells = false): TerminalTarget {
  if (state.removal.state !== "none") return { ok: false, reason: "not_offered" };
  // A stop being prepared, or a sign-out job at any of its steps (Codex r1-1, r2-1); or a page
  // sign-in whose CLI is not yet confirmed stopped, so a manual sign-in never races it (WP3.23).
  if (
    state.status === "stopping" ||
    signOutRunning(state) ||
    state.signIn?.cancelPending === true
  ) {
    return { ok: false, reason: "busy" };
  }
  if (!RESTORED_RUNNING.has(state.lifecycle)) return { ok: false, reason: "not_running" };
  return { ok: true, generation: state.generation, keepsShells };
}

export class PageFront {
  readonly #d: PageFrontDeps;
  readonly #computerId: string;
  /**
   * Terminal admission and the steps that end it run one at a time (Codex r1-1): opening a window
   * never interleaves with a sign-out, a restart, a stop without saving or a removal.
   */
  #serial: Promise<unknown> = Promise.resolve();
  constructor(computerId: string, deps: PageFrontDeps) {
    this.#computerId = computerId;
    this.#d = deps;
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(fn, fn);
    this.#serial = run.catch(() => undefined);
    return run;
  }

  async #secret(): Promise<CryptoKey> {
    let hex = this.#d.store.get(INTENT_SECRET_KEY);
    if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) {
      hex = toHex(crypto.getRandomValues(new Uint8Array(32)));
      this.#d.store.put(INTENT_SECRET_KEY, hex);
    }
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1)
      raw[i] = Number.parseInt((hex as string).slice(2 * i, 2 * i + 2), 16);
    return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  }

  /**
   * The request-intent token for this person's session on this computer: bound to the Access
   * subject and session and (WP8.4) to the person the seam decided.
   */
  async intentFor(owner: PageOwner): Promise<string> {
    const person = personKey(personOf(owner));
    const text = `cfo-pages-intent/v2\n${this.#computerId}\n${owner.sub}\n${owner.sessionId}\n${person}`;
    const mac = await crypto.subtle.sign("HMAC", await this.#secret(), encoder.encode(text));
    return toHex(new Uint8Array(mac));
  }

  /**
   * What `owner`'s person may do with this computer (WP8.4, `ownership.ts`), from its binding. A
   * computer with no record answers `none`: `#state()` refuses it as not found first anyway.
   */
  #access(owner: PageOwner | undefined): PageAccess {
    return this.#accessFor(personOf(owner));
  }

  #accessFor(person: PagePersonFields): PageAccess {
    const ownership = this.#d.controller.ownership();
    if (ownership === null) return "none";
    return accessOf(person, ownership.binding, ownership.installationOwner);
  }

  /**
   * The terminal bridge's `authority` (WP8.15): whether the streams bridged now may go on. The
   * owner's always may. An administrator's on someone else's computer may while OmnigentServer
   * still answers, within `SUPPORT_ANSWER_MS`, that the same person is an active member whose
   * role makes them an administrator here; any other answer, a failure or none ends them. In
   * owner admission the only person Access admits is the installation's owner, by the owner pin,
   * who cannot be demoted, suspended or removed: the pin is the answer, as for the pages.
   */
  async supportAuthority(): Promise<boolean> {
    const support = this.#supportWindow();
    if (support === null || support.window !== this.#d.terminal.view().window) return true;
    const end = await this.#supportEnd(support);
    if (end === null) return true;
    this.#d.log("page_support_ended", {
      computer: this.#computerId,
      actor: support.person,
      reason: end,
    });
    return false;
  }

  /** The current support window's record, if the stored one is well formed. */
  #supportWindow(): SupportWindow | null {
    const parsed = SupportWindow.safeParse(this.#d.store.get(SUPPORT_WINDOW_KEY));
    return parsed.success ? parsed.data : null;
  }

  /**
   * Whether `owner`'s person is the person of `window` (Codex r2 R2-1): `same` for the
   * administrator who opened a support window, or anyone but an administrator for a window
   * without a record (the owner's); `rebound` for the opener's Access identity bound to another
   * membership, which is someone else; `other` for anyone else.
   */
  #windowPerson(owner: PageOwner, window: number): "same" | "rebound" | "other" {
    const support = this.#supportWindow();
    if (support !== null && support.window === window) {
      if (personKey(personOf(owner)) === support.person) return "same";
      return owner.sub === support.sub ? "rebound" : "other";
    }
    return this.#access(owner) === "admin" ? "other" : "same";
  }

  /** Why the person who opened `support` may no longer help on this computer; null while they may. */
  async #supportEnd(support: SupportWindow): Promise<SupportEnd | null> {
    if (support.admission === "owner") {
      return support.person === "installation" &&
        this.#accessFor({ kind: "installation_owner" }) === "admin"
        ? null
        : "not_admin";
    }
    const { issuer, audience } = support;
    const ask = this.#d.person;
    if (support.admission !== "members" || issuer === null || audience === null || !ask) {
      return "unanswered";
    }
    let answer: PagePersonResult;
    try {
      answer = await bounded(
        ask({
          interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
          issuer,
          subject: support.sub,
          audience,
        }),
        this.#d.personTimeoutMs ?? SUPPORT_ANSWER_MS,
      );
    } catch {
      return "unanswered";
    }
    if (answer.action === "none") return "not_bound";
    if (answer.action !== "member") return "unanswered";
    if (answer.state !== "active") return answer.state;
    const now: PagePersonFields =
      answer.role === "owner" && answer.installationOwner === true
        ? { kind: "installation_owner" }
        : { kind: "member", memberId: answer.memberId, userId: answer.userId, role: answer.role };
    // The same Access identity bound to a new membership (removed, then invited again) is
    // someone new: the one who opened the window is gone.
    if (personKey(now) !== support.person) return "another_member";
    return this.#accessFor(now) === "admin" ? null : "not_admin";
  }

  /**
   * Refuses, before any effect, a call this person may not make: someone else's computer is
   * answered as if it did not exist (`not_found`, nothing about it is said); an administrator's
   * call that is the owner's alone is `forbidden`.
   */
  #authorize(
    owner: PageOwner | undefined,
    action: PageAction,
    state: ComputerPageState,
  ): "owner" | "admin" {
    const access = this.#access(owner);
    if (access === "none") {
      this.#d.log("page_refused", { action, access });
      throw platformError("not_found", "no such computer");
    }
    if (!pageAllows(access, action, state.removal.state === "pending")) {
      this.#d.log("page_refused", { action, access });
      throw platformError("forbidden", "this is the computer's owner's alone");
    }
    return access;
  }

  /** Refuses, before any effect, a mutating call without this session's intent token. */
  async #checkIntent(raw: Record<string, unknown>): Promise<PageOwner> {
    const owner = PageOwner.safeParse(raw.owner);
    const intent = IntentToken.safeParse(raw.intent);
    if (!owner.success || !intent.success) {
      throw platformError("forbidden", "a page change needs its owner and request-intent token");
    }
    const expected = await this.intentFor(owner.data);
    if (!constantTimeEqual(expected, intent.data)) {
      this.#d.log("page_intent_refused", { action: String(raw.action).slice(0, 40) });
      throw platformError("forbidden", "the request-intent token does not match");
    }
    return owner.data;
  }

  /**
   * An administrator's action on someone else's computer (D62): logged with the computer, the
   * action and the actor's member ID (`personKey`), never the account or an address.
   */
  #logSupport(access: PageAccess, owner: PageOwner | undefined, action: string): void {
    if (access !== "admin") return;
    this.#d.log("page_support_action", {
      computer: this.#computerId,
      action,
      actor: personKey(personOf(owner)),
    });
  }

  #checkInterface(version: number): void {
    if (version > WORKSPACE_INTERFACE_VERSION) {
      throw platformError("unsupported_version", `interface ${version}`);
    }
  }

  async #stateResult(version: number): Promise<StateResult> {
    const result = await this.#d.controller.pages({ action: "state", interfaceVersion: version });
    if (result.action !== "state") throw platformError("internal", "state");
    return result as StateResult;
  }

  async #state(): Promise<ComputerPageState> {
    return (await this.#stateResult(WORKSPACE_INTERFACE_VERSION)).computer;
  }

  /** The computer as the terminal sees it: for `TerminalBridge`'s `target`. */
  async target(): Promise<TerminalTarget> {
    const state = await this.#state();
    return terminalTarget(state, this.#d.controller.terminalShellsKept?.() === true);
  }

  /** WorkspaceDO's `pages` RPC. */
  async pages(raw: unknown): Promise<PagesResult | PageFrontResult | PageReadResult> {
    const read = PageReadCall.safeParse(raw);
    if (read.success) {
      this.#checkInterface(read.data.interfaceVersion);
      const state = await this.#state(); // `not_found` for a computer that does not exist
      // A sign-in attempt's read is the sign-in's: its link and code are the owner's alone (D62).
      const access = this.#authorize(
        read.data.owner,
        read.data.action === "sign_in_status" ? "sign_in" : "view",
        state,
      );
      this.#logSupport(access, read.data.owner, read.data.action);
      return this.#read(read.data);
    }
    const front = PageFrontCall.safeParse(raw);
    if (front.success) {
      this.#checkInterface(front.data.interfaceVersion);
      const state = await this.#state(); // `not_found` for a computer that does not exist
      // Someone else's computer is not found before its intent token says it exists.
      if (this.#access(ownerIn(front.data)) === "none")
        this.#authorize(ownerIn(front.data), "fleet", state);
      const owner = await this.#checkIntent(front.data);
      const access = this.#authorize(owner, FRONT_ACTIONS[front.data.action], state);
      this.#logSupport(access, owner, front.data.action);
      return this.#exclusive(() => this.#front(front.data, owner));
    }
    const parsed = PagesCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a page call");
    const call = parsed.data;
    this.#checkInterface(call.interfaceVersion);
    if (call.action === "state") {
      const result = await this.#stateResult(call.interfaceVersion);
      const named = PageOwner.safeParse(call.owner);
      const access = this.#authorize(
        named.success ? named.data : undefined,
        "fleet",
        result.computer,
      );
      if (access === "admin") {
        // An administrator's view of someone else's computer (D62): its facts and terminal, the
        // owner's account and member ID, and the token for the administrator's own actions.
        // Each service's sign-in state is in `setupCards`; `signIn` (the owner's attempts, and
        // whether sign-in is offered) is dropped, so no attempt, link or code is ever here.
        const { signIn: _s, ...facts } = result.computer;
        const binding = this.#d.controller.ownership()?.binding ?? null;
        return {
          ...result,
          computer: {
            ...facts,
            terminal: this.#d.terminal.view(),
            access,
            ownerName: binding?.userId ?? null,
            ownerMemberId: binding?.memberId ?? null,
          },
          ...(named.success ? { intentToken: await this.intentFor(named.data) } : {}),
        };
      }
      const computer = { ...result.computer, terminal: this.#d.terminal.view(), access };
      const owner = named;
      if (!owner.success) return { ...result, computer };
      // The caller's own sign-in attempts still running, so a reloaded page resumes them.
      const signIn = computer.signIn;
      const attempts = this.#d.controller.sessionAttempts(owner.data.sessionId);
      return {
        ...result,
        computer:
          signIn === undefined
            ? computer
            : { ...computer, signIn: { ...signIn, attempts: [...attempts] } },
        intentToken: await this.intentFor(owner.data),
      };
    }
    const state = await this.#state();
    const claimed = ownerIn(call as Record<string, unknown>);
    if (this.#access(claimed) === "none") this.#authorize(claimed, "fleet", state);
    const owner = await this.#checkIntent(call as Record<string, unknown>);
    const access = this.#authorize(
      owner,
      PAGES_ACTIONS[call.action as Exclude<PagesCall["action"], "state">],
      state,
    );
    // On someone else's computer only a removed member's, whose save keeps failing (WP8.9).
    if (
      access === "admin" &&
      call.action === "stop_without_saving" &&
      !removalStopWithoutSavingDue(removalFactsOf(state))
    ) {
      return { action: "stop_without_saving", outcome: "refused", reason: "not_offered" };
    }
    this.#logSupport(access, owner, call.action);
    // The owner and the token go; who acted is journaled with the outcome (WP8.15).
    const { owner: _o, intent: _i, ...stripped } = call as Record<string, unknown>;
    const actor = personKey(personOf(owner));
    if (CREDENTIAL_SENSITIVE.has(call.action)) {
      return this.#exclusive(async () => {
        await this.#d.terminal.close("a sign-in-sensitive step started");
        return this.#d.controller.pages(stripped, actor);
      });
    }
    return this.#d.controller.pages(stripped, actor);
  }

  async #front(call: PageFrontCall, owner: PageOwner): Promise<PageFrontResult> {
    switch (call.action) {
      case "open_terminal": {
        const before = this.#d.terminal.view().window;
        const opened = await this.#d.terminal.open({
          operationId: call.operationId,
          owner,
          window: call.window,
        });
        if (opened.outcome !== "accepted") return opened;
        if (opened.window > before) {
          // A new window: whoever opened it is its person (Codex r2 R2-1).
          this.#bindWindow(opened.window, owner);
          return opened;
        }
        // A capability for an open window, only for its own person: another membership of the
        // same Access identity (the only other person the bridge's session check lets this far)
        // gets a new window, and this one, its shell and the capability just issued end now.
        if (this.#windowPerson(owner, opened.window) !== "same") {
          await this.#endForeignWindow("open_terminal");
          return { action: "open_terminal", outcome: "refused", reason: "window_closed" };
        }
        return opened;
      }
      case "close_terminal":
        return {
          action: "close_terminal",
          closed: await this.#d.terminal.close("closed on the setup page"),
        };
      case "remove": {
        const state = await this.#state();
        if (!removeOffered(removalFactsOf(state))) {
          return { action: "remove", outcome: "refused", reason: "not_offered" };
        }
        await this.#d.terminal.close("the computer is being removed");
        const removal = await this.#d.controller.removeForPage();
        this.#d.log("page_removal_recorded", { removal });
        return { action: "remove", outcome: "accepted" };
      }
      case "sign_in_start":
        return {
          action: "sign_in_start",
          ...(await this.#d.controller.signInStart({
            service: call.service,
            session: owner.sessionId,
            operationId: call.operationId,
            generation: call.generation,
          })),
        };
      case "sign_in_input":
        return {
          action: "sign_in_input",
          ...(await this.#d.controller.signInInput({
            service: call.service,
            attempt: call.attempt,
            code: call.code,
            session: owner.sessionId,
            operationId: call.operationId,
          })),
        };
      case "sign_in_cancel":
        return {
          action: "sign_in_cancel",
          ...(await this.#d.controller.signInCancel({
            service: call.service,
            attempt: call.attempt,
            session: owner.sessionId,
          })),
        };
      case "staging_check":
        return {
          action: "staging_check",
          ...(await this.#d.controller.setStagingCheck({ rc53: call.rc53 })),
        };
      case "staging_keep_awake":
        return {
          action: "staging_keep_awake",
          ...(await this.#d.controller.setStagingKeepAwake({ on: call.on })),
        };
    }
  }

  /** Records the person of a window just opened: an administrator's, or none (the owner's). */
  #bindWindow(window: number, owner: PageOwner): void {
    if (this.#access(owner) !== "admin") {
      this.#d.store.delete(SUPPORT_WINDOW_KEY);
      return;
    }
    const record: SupportWindow = {
      window,
      person: personKey(personOf(owner)),
      sub: owner.sub,
      admission: owner.admission ?? null,
      issuer: owner.issuer ?? null,
      audience: owner.audience ?? null,
    };
    this.#d.store.put(SUPPORT_WINDOW_KEY, record);
  }

  /** Ends the current window, its streams and its shell: it is another person's (R2-1). */
  async #endForeignWindow(action: string): Promise<void> {
    const support = this.#supportWindow();
    await this.#d.terminal.close("its window was opened by someone else");
    this.#d.log("page_support_ended", {
      computer: this.#computerId,
      actor: support?.person ?? "none",
      reason: "another_member",
      action,
    });
  }

  /** A page GET's read: changes nothing. */
  async #read(call: PageReadCall): Promise<PageReadResult> {
    if (call.action === "computer_status") {
      return { action: "computer_status", status: await this.#d.controller.computerStatus() };
    }
    return {
      action: "sign_in_status",
      ...(await this.#d.controller.signInStatus({
        service: call.service,
        attempt: call.attempt,
        session: call.owner.sessionId,
      })),
    };
  }

  /**
   * Before a launcher call: `terminate` closes the terminal; a sleep checks the window first.
   * `authorize` validates the call and its owner (WP8.4) and throws to refuse it; it runs before
   * either step, and for `terminate` in the same turn of the terminal's serialization as the close,
   * so a refused call never touches the terminal.
   */
  async beforeLauncher(raw: LauncherCall | unknown, authorize: () => void): Promise<void> {
    const operation = (raw as { request?: { operation?: unknown } } | null)?.request?.operation;
    if (operation === "terminate") {
      await this.#exclusive(async () => {
        authorize();
        await this.#d.terminal.close("the computer is being removed");
      });
      return;
    }
    authorize();
    if (operation === "suspend") await this.#d.terminal.enforce();
  }

  /** Before the controller's alarm: an expired window closes before a start-deadline stop. */
  async beforeAlarm(): Promise<void> {
    await this.#d.terminal.enforce();
  }

  /** WorkspaceDO's `fetch`: the terminal's upgrade from the web Worker. */
  async fetch(request: Request): Promise<Response> {
    const notFound = () =>
      Response.json(
        { error: { code: "not_found", message: "Not found.", retryable: false } },
        { status: 404 },
      );
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return notFound();
    let header: unknown;
    try {
      header = JSON.parse(request.headers.get(TERMINAL_UPGRADE_HEADER) ?? "null");
    } catch {
      header = null;
    }
    const upgrade = TerminalUpgrade.safeParse(header);
    if (!upgrade.success) return notFound();
    if (upgrade.data.interfaceVersion > WORKSPACE_INTERFACE_VERSION) {
      return Response.json(
        { error: { code: "unsupported_version", message: "Unsupported.", retryable: false } },
        { status: 400 },
      );
    }
    // The terminal is its owner's, and an administrator's helping them (D62): anyone else's
    // upgrade is not found, before the capability is even looked at. The capability stays bound
    // to the Access subject and session it was issued to (`terminal.ts`).
    const access = this.#access(upgrade.data.owner);
    if (!pageAllows(access, "terminal", false)) {
      this.#d.log("page_refused", { action: "terminal", access });
      return notFound();
    }
    this.#logSupport(access, upgrade.data.owner, "terminal_connect");
    // An administrator's stream only in the window they opened, as the same person (Codex r2
    // R2-1): their Access identity as another membership ends that window and its shell; anyone
    // else's upgrade is refused and changes nothing. The owner's are the bridge's to decide.
    const person =
      access === "admin"
        ? this.#windowPerson(upgrade.data.owner, this.#d.terminal.view().window)
        : "same";
    if (person !== "same") {
      if (person === "rebound") await this.#endForeignWindow("terminal_connect");
      else this.#d.log("page_refused", { action: "terminal", access, reason: "not_its_window" });
      return Response.json(
        { error: { code: "forbidden", message: "Access denied.", retryable: false } },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    return this.#d.terminal.connect(upgrade.data);
  }
}
