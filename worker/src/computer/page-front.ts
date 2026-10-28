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
  LAUNCHER_PROTOCOL_VERSION,
  type LauncherCall,
  type LauncherResult,
  PageFrontCall,
  type PageFrontResult,
  PageOwner,
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
import { platformError } from "../shared/errors.ts";
import type { Store } from "./record.ts";
import type { TerminalBridge, TerminalTarget } from "./terminal.ts";

type SignInAnswer =
  | { readonly outcome: "accepted"; readonly view: PageSignInView }
  | { readonly outcome: "refused"; readonly reason: SignInRefusal };

/** What the front needs from the controller: its public RPC answers. */
export interface FrontController {
  pages(call: unknown): Promise<PagesResult>;
  launcher(call: unknown): Promise<LauncherResult>;
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
  sessionAttempts(session: string): readonly {
    readonly service: SignInService;
    readonly attempt: number;
  }[];
  /**
   * Whether this generation's supervisor keeps the setup terminal's shells in sessions that
   * outlive their streams (WP3.28, `terminal_sessions`). Absent or unknown: no.
   */
  terminalShellsKept?(): boolean;
}

export interface PageFrontDeps {
  readonly store: Store;
  readonly controller: FrontController;
  readonly terminal: TerminalBridge;
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

type StateResult = Extract<PagesResult, { action: "state" }>;

const INTENT_SECRET_KEY = "pages/intent-secret";
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

/** A 32-hex launcher operation ID derived from a page operation ID, so a repeat maps to it. */
async function launcherOperationId(pageOperationId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`cfo-page-remove/v1\n${pageOperationId}`),
  );
  return toHex(new Uint8Array(digest)).slice(0, 32);
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

  /** The request-intent token for this owner's session on this computer. */
  async intentFor(owner: PageOwner): Promise<string> {
    const text = `cfo-pages-intent/v1\n${this.#computerId}\n${owner.sub}\n${owner.sessionId}`;
    const mac = await crypto.subtle.sign("HMAC", await this.#secret(), encoder.encode(text));
    return toHex(new Uint8Array(mac));
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
      await this.#state(); // `not_found` for a computer that does not exist
      return this.#read(read.data);
    }
    const front = PageFrontCall.safeParse(raw);
    if (front.success) {
      this.#checkInterface(front.data.interfaceVersion);
      await this.#state(); // `not_found` for a computer that does not exist: nothing is stored
      const owner = await this.#checkIntent(front.data);
      return this.#exclusive(() => this.#front(front.data, owner));
    }
    const parsed = PagesCall.safeParse(raw);
    if (!parsed.success) throw platformError("bad_request", "not a page call");
    const call = parsed.data;
    this.#checkInterface(call.interfaceVersion);
    if (call.action === "state") {
      const result = await this.#stateResult(call.interfaceVersion);
      const computer = { ...result.computer, terminal: this.#d.terminal.view() };
      const owner = PageOwner.safeParse(call.owner);
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
    await this.#state();
    await this.#checkIntent(call as Record<string, unknown>);
    const { owner: _o, intent: _i, ...stripped } = call as Record<string, unknown>;
    if (CREDENTIAL_SENSITIVE.has(call.action)) {
      return this.#exclusive(async () => {
        await this.#d.terminal.close("a sign-in-sensitive step started");
        return this.#d.controller.pages(stripped);
      });
    }
    return this.#d.controller.pages(stripped);
  }

  async #front(call: PageFrontCall, owner: PageOwner): Promise<PageFrontResult> {
    switch (call.action) {
      case "open_terminal":
        return this.#d.terminal.open({
          operationId: call.operationId,
          owner,
          window: call.window,
        });
      case "close_terminal":
        return {
          action: "close_terminal",
          closed: await this.#d.terminal.close("closed on the setup page"),
        };
      case "remove": {
        const state = await this.#state();
        const offered =
          state.noContact === true &&
          state.removal.state === "none" &&
          state.lifecycle !== "removed";
        if (!offered) return { action: "remove", outcome: "refused", reason: "not_offered" };
        await this.#d.terminal.close("the computer is being removed");
        const result = await this.#d.controller.launcher({
          interfaceVersion: WORKSPACE_INTERFACE_VERSION,
          request: {
            operation: "terminate",
            protocolVersion: LAUNCHER_PROTOCOL_VERSION,
            operationId: await launcherOperationId(call.operationId),
            computerId: this.#computerId,
          },
        });
        if (result.operation !== "terminate") throw platformError("internal", "remove");
        this.#d.log("page_removal_recorded", { removal: result.removal });
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
    }
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

  /** Before a launcher call: `terminate` closes the terminal; a sleep checks the window first. */
  async beforeLauncher(raw: LauncherCall | unknown): Promise<void> {
    const operation = (raw as { request?: { operation?: unknown } } | null)?.request?.operation;
    if (operation === "terminate") {
      await this.#exclusive(() => this.#d.terminal.close("the computer is being removed"));
    } else if (operation === "suspend") await this.#d.terminal.enforce();
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
    return this.#d.terminal.connect(upgrade.data);
  }
}
