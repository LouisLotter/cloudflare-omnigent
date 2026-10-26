// The setup terminal's bridge (WP3.5), inside the computer's WorkspaceDO. The design's "Platform
// pages" and R-29, RC-24, FH-38:
//
// - **Windows.** The owner opens a terminal window from the setup page (a page POST). A window
//   has a hard deadline, 30 minutes, and a number that only goes up. Opening a new window, closing
//   it, its deadline, a new computer generation, a removal and every credential-sensitive step on
//   the computer close it, and every stream in it. While a window is open the controller refuses
//   a sleep and defers the start deadline (`setWindow`).
// - **Capabilities.** Each stream needs a capability: 32 random bytes, bound to the pinned
//   owner's `sub`, the Access session, the purpose, this computer, its generation and the window.
//   Only its SHA-256 is stored. It must be presented within a minute, and only once: it is marked
//   used, durably, before the computer is dialled, so a replay or a second concurrent use is
//   refused. A reconnect (a dropped stream, FH-38) asks for a fresh capability for the same window.
// - **Bridged streams.** WorkspaceDO accepts the computer's socket (ttyd, `TERMINAL_PORT`) and one
//   end of a `WebSocketPair`, and answers the browser's upgrade with a 101 that carries only the
//   `tty` subprotocol. Both sockets use `binaryType = "arraybuffer"`. Nothing they carry is
//   logged, parsed or kept, except output buffered for a reattach.
// - **Reattach.** A browser stream that drops while its window is open (a web Worker deploy)
//   leaves the computer's socket open for `detachedGraceMs`, buffering at most `bufferBytes` of
//   output, so a reconnect with a fresh capability finds the same shell. ttyd ends the shell when
//   its socket closes.
// - **Enforcement.** While any stream exists, a check runs every `checkMs` (15 s) and closes
//   streams whose window is closed or past its deadline, or whose computer is no longer the
//   restored, running generation they were opened for. A Durable Object restart drops every
//   stream; the persisted window and used capabilities keep the rules after it.
//
// Platform code never reads what passes through: the sign-in codes the person pastes go to the
// CLI on the computer and nowhere else.

import {
  CapabilityPurpose,
  type ComputerId,
  type PageFrontResult,
  type PageOwner,
  TERMINAL_SUBPROTOCOL,
  type TerminalRefusal,
  type TerminalUpgrade,
  type TerminalWindow,
} from "@cfo/contracts";
import { z } from "zod";
import type { Store } from "./record.ts";

/** The parts of a WebSocket the bridge uses: workerd's, or a test's fake. */
export interface BridgeSocket {
  accept(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: "close" | "error", listener: (event: unknown) => void): void;
  binaryType?: string;
}

/** Whether the computer can have a terminal now, as the controller sees it. */
export type TerminalTarget =
  | { readonly ok: true; readonly generation: number }
  | { readonly ok: false; readonly reason: Exclude<TerminalRefusal, "window_closed"> };

export interface TerminalTiming {
  /** A window's hard deadline after it opens. */
  readonly windowMs: number;
  /** How long a capability may wait before it is presented. */
  readonly presentMs: number;
  /** How often open streams are checked against the window and the computer. */
  readonly checkMs: number;
  /** How long a dropped browser stream keeps its computer socket for a reattach. */
  readonly detachedGraceMs: number;
  /** The most output kept for a detached stream; beyond it the session ends. */
  readonly bufferBytes: number;
  /** Retries of a dial that ttyd refused (one client at a time, `--max-clients 1`). */
  readonly dialRetryMs: readonly number[];
}

export const TERMINAL_TIMING: TerminalTiming = {
  windowMs: 30 * 60_000,
  presentMs: 60_000,
  checkMs: 15_000,
  detachedGraceMs: 30_000,
  bufferBytes: 1 << 20,
  dialRetryMs: [250, 500, 1_000],
};

/** Close codes the browser sees. 4001: closed by the platform, do not reconnect on your own. */
export const CLOSED_BY_PLATFORM = 4001;
/** 4002: the computer's side ended (the shell exited, or ttyd went away). */
export const CLOSED_BY_COMPUTER = 4002;

export interface TerminalDeps {
  readonly computerId: ComputerId;
  /** WorkspaceDO's storage; the bridge uses keys under `terminal/` only. */
  readonly store: Store;
  readonly now: () => number;
  readonly timing?: Partial<TerminalTiming>;
  /** The computer as the controller sees it now. */
  readonly target: () => Promise<TerminalTarget>;
  /** An upgrade to ttyd on the computer's terminal port; its answer carries `webSocket`. */
  readonly dial: () => Promise<Response>;
  /** Tells the controller the window is open until `until` (ms), or closed (null). */
  readonly setWindow: (until: number | null) => Promise<void>;
  /** A connected pair: [the end for the browser's response, the end the bridge keeps]. */
  readonly pair: () => readonly [BridgeSocket, BridgeSocket];
  /** The browser's 101: the pair's client end, with only the `tty` subprotocol. */
  readonly upgradeResponse: (client: BridgeSocket) => Response;
  /** The socket of a dialled answer, if it has one. */
  readonly socketOf: (response: Response) => BridgeSocket | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  /** One structured log line. Never given a capability, a token or terminal data. */
  readonly log: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}

const WINDOW_KEY = "terminal/window";
const CAP_PREFIX = "terminal/cap/";
const OP_PREFIX = "terminal/op/";
/** At most this many issued capabilities are kept per window (reconnects, retries). */
const MAX_CAPABILITIES = 64;
const MAX_OPS = 64;

const Millis = z.number().int().min(0).max(8.64e15);

const WindowRecord = z.strictObject({
  window: z.number().int().min(0),
  open: z.boolean(),
  generation: z.number().int().min(0).nullable(),
  until: Millis.nullable(),
  /** The Access session that opened the window: only it may reconnect to the window. */
  sessionId: z.string().max(128).nullable().default(null),
});
type WindowRecord = z.infer<typeof WindowRecord>;

const CapabilityRecord = z.strictObject({
  sub: z.string().min(1).max(256),
  sessionId: z.string(),
  purpose: CapabilityPurpose,
  computerId: z.string(),
  generation: z.number().int().min(0),
  window: z.number().int().min(1),
  presentBy: Millis,
  used: z.boolean(),
  issuedAt: Millis,
});
type CapabilityRecord = z.infer<typeof CapabilityRecord>;

const OpRecord = z.strictObject({ window: z.number().int().min(1), at: Millis });

const CLOSED_WINDOW: WindowRecord = {
  window: 0,
  open: false,
  generation: null,
  until: null,
  sessionId: null,
};

/** Why an upgrade was refused; logged, never sent to the browser. */
export type UpgradeRefusal =
  | "unknown_capability"
  | "used"
  | "wrong_owner"
  | "wrong_session"
  | "wrong_computer"
  | "not_presented_in_time"
  | "window_closed"
  | "stale_window"
  | "generation_changed"
  | "not_available"
  | "dial_failed";

interface Session {
  readonly window: number;
  readonly generation: number;
  readonly computer: BridgeSocket;
  browser: BridgeSocket | null;
  /** Output kept while no browser is attached. */
  buffer: ArrayBuffer[];
  buffered: number;
  graceTimer: unknown;
  ended: boolean;
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function byteLength(data: string | ArrayBuffer | ArrayBufferView): number {
  return typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
}

function asSendable(data: unknown): string | ArrayBuffer | ArrayBufferView | null {
  if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return data;
  }
  return null;
}

function refusedUpgrade(): Response {
  return Response.json(
    { error: { code: "forbidden", message: "Access denied.", retryable: false } },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

export class TerminalBridge {
  readonly #d: TerminalDeps;
  readonly #t: TerminalTiming;
  readonly #sessions = new Set<Session>();
  #checkTimer: unknown = null;

  constructor(deps: TerminalDeps) {
    this.#d = deps;
    this.#t = { ...TERMINAL_TIMING, ...deps.timing };
  }

  #window(): WindowRecord {
    const parsed = WindowRecord.safeParse(this.#d.store.get(WINDOW_KEY));
    return parsed.success ? parsed.data : CLOSED_WINDOW;
  }

  /** Whether `w` is open now. */
  #isOpen(w: WindowRecord): w is WindowRecord & { until: number; generation: number } {
    return w.open && w.until !== null && w.generation !== null && w.until > this.#d.now();
  }

  /** The window as the pages show it. */
  view(): TerminalWindow {
    const w = this.#window();
    const open = this.#isOpen(w);
    return {
      window: w.window,
      open,
      generation: open ? w.generation : null,
      until: open && w.until !== null ? new Date(w.until).toISOString() : null,
      streams: [...this.#sessions].filter((s) => !s.ended && s.browser !== null).length,
    };
  }

  /** Streams bridged now, attached or waiting for a reattach. */
  get sessions(): number {
    return [...this.#sessions].filter((s) => !s.ended).length;
  }

  /**
   * Opens a window (`window` null) and issues a capability for it, or issues a fresh capability
   * for the open window `window`. A repeated operation ID opens no second window.
   */
  async open(call: {
    readonly operationId: string;
    readonly owner: PageOwner;
    readonly window: number | null;
  }): Promise<Extract<PageFrontResult, { action: "open_terminal" }>> {
    const refused = (reason: TerminalRefusal) =>
      ({ action: "open_terminal", outcome: "refused", reason }) as const;
    const target = await this.#d.target();
    if (!target.ok) return refused(target.reason);
    const w = this.#window();
    const opKey = `${OP_PREFIX}${call.operationId}`;
    const prior = OpRecord.safeParse(this.#d.store.get(opKey));
    let wanted = call.window;
    if (wanted === null && prior.success) wanted = prior.data.window;
    if (wanted !== null) {
      if (
        wanted !== w.window ||
        !this.#isOpen(w) ||
        w.generation !== target.generation ||
        w.sessionId !== call.owner.sessionId
      ) {
        return refused("window_closed");
      }
      // Re-asserted before every capability: if telling the controller failed when the window
      // opened, a sleep must still be refused while a stream can connect.
      await this.#d.setWindow(w.until);
      return this.#issue(w, call.owner);
    }
    // A new window: everything in the old one ends first.
    this.#endAll("a new terminal window was opened");
    const now = this.#d.now();
    const next = {
      window: w.window + 1,
      open: true,
      generation: target.generation,
      until: now + this.#t.windowMs,
      sessionId: call.owner.sessionId,
    };
    this.#d.store.transaction(() => {
      this.#dropCapabilities();
      this.#d.store.put(WINDOW_KEY, next);
      this.#d.store.put(opKey, { window: next.window, at: now });
      this.#pruneOps();
    });
    await this.#d.setWindow(next.until);
    this.#d.log("terminal_window_opened", { window: next.window, generation: next.generation });
    return this.#issue(next, call.owner);
  }

  async #issue(
    w: WindowRecord & { until: number; generation: number },
    owner: PageOwner,
  ): Promise<Extract<PageFrontResult, { action: "open_terminal"; outcome: "accepted" }>> {
    const now = this.#d.now();
    const capability = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await sha256Hex(capability);
    const presentBy = Math.min(now + this.#t.presentMs, w.until);
    const record: CapabilityRecord = {
      sub: owner.sub,
      sessionId: owner.sessionId,
      purpose: "setup_terminal",
      computerId: this.#d.computerId,
      generation: w.generation,
      window: w.window,
      presentBy,
      used: false,
      issuedAt: now,
    };
    this.#d.store.transaction(() => {
      this.#pruneCapabilities();
      this.#d.store.put(`${CAP_PREFIX}${hash}`, record);
    });
    return {
      action: "open_terminal",
      outcome: "accepted",
      capability,
      window: w.window,
      generation: w.generation,
      until: new Date(w.until).toISOString(),
      presentBy: new Date(presentBy).toISOString(),
    };
  }

  /**
   * Closes the window and every stream in it, before anything else happens: called before every
   * credential-sensitive step, on the owner's request and when the computer goes away.
   */
  async close(reason: string): Promise<boolean> {
    const w = this.#window();
    const wasOpen = w.open;
    this.#endAll(reason);
    if (wasOpen || this.#d.store.keys(CAP_PREFIX, 1).length > 0) {
      this.#d.store.transaction(() => {
        this.#dropCapabilities();
        this.#d.store.put(WINDOW_KEY, {
          ...w,
          open: false,
          until: null,
          generation: null,
          sessionId: null,
        });
      });
    }
    if (wasOpen) {
      await this.#d.setWindow(null);
      this.#d.log("terminal_window_closed", { window: w.window, reason });
    }
    return wasOpen;
  }

  /**
   * Ends every stream and closes the window at once, synchronously, without telling the
   * controller: for the controller itself, when a transition starts a credential-sensitive step
   * (its `terminal.closeNow` hook), inside that transition.
   */
  closeNow(reason: string): void {
    this.#endAll(reason);
    const w = this.#window();
    this.#dropCapabilities();
    if (w.open) {
      this.#d.store.put(WINDOW_KEY, {
        ...w,
        open: false,
        until: null,
        generation: null,
        sessionId: null,
      });
      this.#d.log("terminal_window_closed", { window: w.window, reason });
    }
  }

  /**
   * Checks every stream against the window and the computer, and closes those that may no
   * longer run. Also expires a window past its deadline. Never throws.
   */
  async enforce(): Promise<void> {
    const w = this.#window();
    if (w.open && !this.#isOpen(w)) {
      await this.close("its window has closed");
      return;
    }
    if (this.#sessions.size === 0) return;
    let target: TerminalTarget;
    try {
      target = await this.#d.target();
    } catch {
      return;
    }
    if (!target.ok) {
      await this.close("the computer is no longer available");
      return;
    }
    // Every session belongs to the open window: opening a new one ends the old ones first.
    if (w.generation !== target.generation) await this.close("the computer was restarted");
  }

  /** The browser's upgrade, after the web Worker checked the origin (`TerminalUpgrade`). */
  async connect(upgrade: TerminalUpgrade): Promise<Response> {
    const refuse = (reason: UpgradeRefusal): Response => {
      this.#d.log("terminal_upgrade_refused", { reason });
      return refusedUpgrade();
    };
    const hash = await sha256Hex(upgrade.capability);
    const key = `${CAP_PREFIX}${hash}`;
    const parsed = CapabilityRecord.safeParse(this.#d.store.get(key));
    if (!parsed.success) return refuse("unknown_capability");
    const cap = parsed.data;
    if (cap.used) return refuse("used");
    // Spent at once, whatever follows: a capability is never accepted twice.
    this.#d.store.put(key, { ...cap, used: true });
    if (cap.sub !== upgrade.owner.sub) return refuse("wrong_owner");
    if (cap.sessionId !== upgrade.owner.sessionId) return refuse("wrong_session");
    if (cap.computerId !== this.#d.computerId || upgrade.computerId !== this.#d.computerId) {
      return refuse("wrong_computer");
    }
    // The purpose is bound by the record's schema: only `setup_terminal` capabilities parse.
    if (this.#d.now() > cap.presentBy) return refuse("not_presented_in_time");
    const w = this.#window();
    if (!this.#isOpen(w)) return refuse("window_closed");
    if (cap.window !== w.window) return refuse("stale_window");
    const target = await this.#d.target();
    if (!target.ok) return refuse("not_available");
    if (cap.generation !== target.generation || w.generation !== target.generation) {
      return refuse("generation_changed");
    }

    const detached = [...this.#sessions].find(
      (s) => !s.ended && s.browser === null && s.window === w.window,
    );
    const session = detached ?? (await this.#dialSession(w.window, target.generation));
    if (session === null) return refuse("dial_failed");
    // Checked again: the window may have closed while ttyd answered.
    const after = this.#window();
    if (!this.#isOpen(after) || after.window !== cap.window) {
      this.#end(session, "its window has closed");
      return refuse("window_closed");
    }
    return this.#attach(session, detached !== undefined);
  }

  async #dialSession(window: number, generation: number): Promise<Session | null> {
    // One client at a time on ttyd: any older socket is ended first.
    for (const s of this.#sessions) this.#end(s, "a newer stream replaced it");
    for (let attempt = 0; ; attempt += 1) {
      let socket: BridgeSocket | null = null;
      try {
        const response = await this.#d.dial();
        socket = this.#d.socketOf(response);
        if (socket === null) await response.body?.cancel();
      } catch {
        socket = null;
      }
      if (socket !== null) {
        socket.accept();
        // workerd otherwise delivers binary frames as Blobs, which send() turns into text.
        socket.binaryType = "arraybuffer";
        const session: Session = {
          window,
          generation,
          computer: socket,
          browser: null,
          buffer: [],
          buffered: 0,
          graceTimer: null,
          ended: false,
        };
        this.#sessions.add(session);
        socket.addEventListener("message", (event) => this.#fromComputer(session, event.data));
        socket.addEventListener("close", () => this.#end(session, "closed by the computer", true));
        socket.addEventListener("error", () => this.#end(session, "computer side error", true));
        return session;
      }
      const wait = this.#t.dialRetryMs[attempt];
      if (wait === undefined) return null;
      await this.#d.sleep(wait);
    }
  }

  #attach(session: Session, reattached: boolean): Response {
    const [client, browser] = this.#d.pair();
    browser.accept();
    browser.binaryType = "arraybuffer";
    if (session.graceTimer !== null) {
      this.#d.clearTimer(session.graceTimer);
      session.graceTimer = null;
    }
    session.browser = browser;
    browser.addEventListener("message", (event) => {
      if (session.browser !== browser || session.ended) return;
      const data = asSendable(event.data);
      if (data === null) return;
      try {
        session.computer.send(data);
      } catch {
        this.#end(session, "a send failed");
      }
    });
    const detach = () => this.#detach(session, browser);
    browser.addEventListener("close", detach);
    browser.addEventListener("error", detach);
    for (const chunk of session.buffer) browser.send(chunk);
    session.buffer = [];
    session.buffered = 0;
    this.#armCheck();
    this.#d.log(reattached ? "terminal_reattached" : "terminal_bridged", {
      window: session.window,
    });
    return this.#d.upgradeResponse(client);
  }

  #fromComputer(session: Session, raw: unknown): void {
    if (session.ended) return;
    const data = asSendable(raw);
    if (data === null) return;
    const browser = session.browser;
    if (browser !== null) {
      try {
        browser.send(data);
      } catch {
        this.#detach(session, browser);
      }
      return;
    }
    const size = byteLength(data);
    if (session.buffered + size > this.#t.bufferBytes) {
      this.#end(session, "too much output while disconnected");
      return;
    }
    const copy =
      typeof data === "string"
        ? encoder.encode(data).buffer
        : data instanceof ArrayBuffer
          ? data.slice(0)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
    session.buffer.push(copy as ArrayBuffer);
    session.buffered += size;
  }

  /** The browser's stream dropped: keep the shell for a reattach while the window is open. */
  #detach(session: Session, browser: BridgeSocket): void {
    if (session.ended || session.browser !== browser) return;
    session.browser = null;
    try {
      browser.close(1000, "detached");
    } catch {
      // already closed
    }
    if (!this.#isOpen(this.#window())) {
      this.#end(session, "its window has closed");
      return;
    }
    // A reattach clears this timer, so when it fires no browser is attached.
    session.graceTimer = this.#d.setTimer(() => {
      session.graceTimer = null;
      this.#end(session, "no reconnect in time");
    }, this.#t.detachedGraceMs);
    this.#d.log("terminal_detached", { window: session.window });
  }

  #end(session: Session, why: string, byComputer = false): void {
    if (session.ended) return;
    session.ended = true;
    this.#sessions.delete(session);
    if (session.graceTimer !== null) this.#d.clearTimer(session.graceTimer);
    session.buffer = [];
    const reason = `terminal closed: ${why}`.slice(0, 120);
    if (session.browser !== null) {
      try {
        session.browser.close(byComputer ? CLOSED_BY_COMPUTER : CLOSED_BY_PLATFORM, reason);
      } catch {
        // already closed
      }
      session.browser = null;
    }
    try {
      session.computer.close(1000, reason);
    } catch {
      // already closed
    }
    this.#d.log("terminal_stream_ended", { window: session.window, reason: why });
    // At most one session exists (ttyd takes one client), so none is left to check.
    this.#disarmCheck();
  }

  #endAll(why: string): void {
    for (const s of [...this.#sessions]) this.#end(s, why);
  }

  #armCheck(): void {
    if (this.#checkTimer !== null) return;
    const tick = () => {
      this.#checkTimer = null;
      void this.enforce().finally(() => {
        if (this.#sessions.size > 0) this.#armCheck();
      });
    };
    this.#checkTimer = this.#d.setTimer(tick, this.#t.checkMs);
  }

  #disarmCheck(): void {
    if (this.#checkTimer === null) return;
    this.#d.clearTimer(this.#checkTimer);
    this.#checkTimer = null;
  }

  #dropCapabilities(): void {
    for (;;) {
      const keys = this.#d.store.keys(CAP_PREFIX, 100);
      if (keys.length === 0) return;
      for (const key of keys) this.#d.store.delete(key);
    }
  }

  /** Keeps the newest capabilities only; expired ones are useless and go first. */
  #pruneCapabilities(): void {
    const keys = this.#d.store.keys(CAP_PREFIX);
    if (keys.length < MAX_CAPABILITIES) return;
    const now = this.#d.now();
    const records = keys
      .map((key) => ({ key, cap: CapabilityRecord.safeParse(this.#d.store.get(key)) }))
      .map(({ key, cap }) => ({ key, issuedAt: cap.success ? cap.data.issuedAt : 0, cap }));
    for (const { key, cap } of records) {
      if (!cap.success || cap.data.presentBy < now) this.#d.store.delete(key);
    }
    const left = records
      .filter(({ cap }) => cap.success && cap.data.presentBy >= now)
      .sort((a, b) => a.issuedAt - b.issuedAt);
    for (const { key } of left.slice(0, Math.max(0, left.length - MAX_CAPABILITIES + 1))) {
      this.#d.store.delete(key);
    }
  }

  #pruneOps(): void {
    const keys = this.#d.store.keys(OP_PREFIX);
    if (keys.length <= MAX_OPS) return;
    const records = keys
      .map((key) => ({ key, op: OpRecord.safeParse(this.#d.store.get(key)) }))
      .sort((a, b) => (a.op.success ? a.op.data.at : 0) - (b.op.success ? b.op.data.at : 0));
    for (const { key } of records.slice(0, keys.length - MAX_OPS)) this.#d.store.delete(key);
  }
}

/** The subprotocol answer to the browser: `tty`, nothing else. */
export const BROWSER_SUBPROTOCOL = TERMINAL_SUBPROTOCOL;
