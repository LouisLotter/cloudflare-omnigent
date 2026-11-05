// WorkspaceDO's page front (WP3.5, `computer/page-front.ts`): the request-intent token checked in
// constant time before any effect (P1); owner and token stripped before the controller; the
// terminal closed before every credential-sensitive step; removal offered only for a computer
// Omnigent no longer calls (FH-29).
import type {
  ComputerPageState,
  PagePersonCall,
  PagePersonResult,
  PagesResult,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import type { OwnerBinding } from "../../src/computer/ownership.ts";
import {
  constantTimeEqual,
  type FrontController,
  PageFront,
  terminalTarget,
} from "../../src/computer/page-front.ts";
import { TerminalBridge } from "../../src/computer/terminal.ts";
import { errorCodeOf, platformError } from "../../src/shared/errors.ts";
import { FakeTtyd, fakePair, SocketResponse } from "../support/fake-sockets.ts";
import { MemoryStore } from "../support/memory-store.ts";
import { PAGE_CMP, pageState } from "../support/page-states.ts";

const OWNER = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const OP = (n: number) => `op_${String(n).padStart(26, "0")}`;

class FakeController implements FrontController {
  state: ComputerPageState | null = pageState();
  readonly calls: unknown[] = [];
  /** Who each mutating call came from, as the front named it (WP8.15). */
  readonly actors: (string | undefined)[] = [];
  readonly launches: unknown[] = [];

  async pages(call: unknown, actor?: string): Promise<PagesResult> {
    if (this.state === null) throw platformError("not_found", "no such computer");
    const c = call as { action: string };
    if (c.action === "state") return { action: "state", computer: this.state };
    this.calls.push(call);
    this.actors.push(actor);
    if (c.action === "set_size") return { action: "set_size", appliesAt: "next_start" };
    return { action: c.action, outcome: "accepted" } as PagesResult;
  }

  /** The computer's owner binding (WP8.4); none: the installation owner's. */
  binding: OwnerBinding | null = null;
  installationOwner: string | null = "founder";
  ownership() {
    return this.state === null
      ? null
      : { binding: this.binding, installationOwner: this.installationOwner };
  }

  async removeForPage() {
    this.launches.push("remove");
    return "pending" as const;
  }

  // WP3.23: sign-in, status and the staging switch, recorded.
  readonly signIns: { method: string; input: unknown }[] = [];
  attempts: { service: "claude" | "codex"; attempt: number }[] = [];
  #view(input: { service: "claude" | "codex"; attempt?: number }) {
    return {
      outcome: "accepted" as const,
      view: { service: input.service, attempt: input.attempt ?? 1, state: "starting" as const },
    };
  }
  async signInStart(input: Parameters<FrontController["signInStart"]>[0]) {
    this.signIns.push({ method: "start", input });
    return this.#view(input);
  }
  async signInInput(input: Parameters<FrontController["signInInput"]>[0]) {
    this.signIns.push({ method: "input", input });
    return this.#view(input);
  }
  async signInCancel(input: Parameters<FrontController["signInCancel"]>[0]) {
    this.signIns.push({ method: "cancel", input });
    return this.#view(input);
  }
  async signInStatus(input: Parameters<FrontController["signInStatus"]>[0]) {
    this.signIns.push({ method: "status", input });
    return this.#view(input);
  }
  async computerStatus() {
    this.signIns.push({ method: "computer_status", input: null });
    return { observedAt: "2026-10-28T10:00:00.000Z" } as Awaited<
      ReturnType<FrontController["computerStatus"]>
    >;
  }
  async setStagingCheck(input: { readonly rc53: boolean }) {
    this.signIns.push({ method: "staging", input });
    return { outcome: "accepted" as const, rc53: input.rc53 };
  }
  async setStagingKeepAwake(input: { readonly on: boolean }) {
    this.signIns.push({ method: "keep_awake", input });
    return { outcome: "accepted" as const, on: input.on };
  }
  sessionAttempts(session: string) {
    this.signIns.push({ method: "sessionAttempts", input: session });
    return this.attempts;
  }
}

function harness() {
  const store = new MemoryStore();
  const controller = new FakeController();
  const ttyd = new FakeTtyd();
  const events: string[] = [];
  /** Every log line with its fields (WP8.15: the support lines, and that no address is logged). */
  const logged: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const log = (event: string, fields: Readonly<Record<string, unknown>>) => {
    events.push(event);
    logged.push({ event, fields });
  };
  let front: PageFront | null = null;
  /** WP8.15: OmnigentServer's `pagePerson`, as each test sets it, and every call made to it. */
  const people = {
    answer: (async () => ({ action: "unavailable" })) as (
      call: PagePersonCall,
    ) => Promise<PagePersonResult>,
    asked: [] as PagePersonCall[],
  };
  const terminal = new TerminalBridge({
    computerId: PAGE_CMP,
    store,
    now: () => 1_000_000,
    target: () => (front as PageFront).target(),
    dial: ttyd.dial,
    setWindow: async (until) => {
      events.push(until === null ? "window:closed" : "window:open");
    },
    pair: () => fakePair("browser"),
    upgradeResponse: () => new Response(null, { status: 200 }),
    socketOf: (r) => (r instanceof SocketResponse ? r.socket : null),
    sleep: async () => undefined,
    setTimer: () => 0,
    clearTimer: () => undefined,
    log,
    authority: () => (front as PageFront).supportAuthority(),
  });
  front = new PageFront(PAGE_CMP, {
    store,
    controller,
    terminal,
    log,
    person: (call) => {
      people.asked.push(call);
      return people.answer(call);
    },
    personTimeoutMs: 20,
  });
  return { store, controller, terminal, front, events, logged, ttyd, people };
}

async function intentOf(front: PageFront): Promise<string> {
  const result = await front.pages({ action: "state", interfaceVersion: 1, owner: OWNER });
  if (result.action !== "state" || !("intentToken" in result) || !result.intentToken) {
    throw new Error("no intent");
  }
  return result.intentToken as string;
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (e: unknown) => e,
    ),
  );
}

describe("request-intent tokens", () => {
  it("are bound to the session and computer, and stable for them", async () => {
    const { front } = harness();
    const a = await intentOf(front);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await intentOf(front)).toBe(a);
    const other = await front.intentFor({ ...OWNER, sessionId: "cd".repeat(32) });
    expect(other).not.toBe(a);
    expect(await front.intentFor({ ...OWNER, sub: "another" })).not.toBe(a);
    const second = harness();
    expect(await intentOf(second.front)).not.toBe(a);
  });

  it("are checked before any effect, and stripped before the controller", async () => {
    const { front, controller } = harness();
    const intent = await intentOf(front);
    const call = {
      action: "set_size",
      interfaceVersion: 1,
      operationId: OP(1),
      size: "standard-3",
    };
    expect(await codeOf(front.pages(call))).toBe("forbidden");
    expect(await codeOf(front.pages({ ...call, owner: OWNER }))).toBe("forbidden");
    expect(await codeOf(front.pages({ ...call, owner: OWNER, intent: "0".repeat(64) }))).toBe(
      "forbidden",
    );
    const otherSession = { ...OWNER, sessionId: "cd".repeat(32) };
    expect(await codeOf(front.pages({ ...call, owner: otherSession, intent }))).toBe("forbidden");
    expect(controller.calls).toEqual([]);
    expect(await front.pages({ ...call, owner: OWNER, intent })).toEqual({
      action: "set_size",
      appliesAt: "next_start",
    });
    expect(controller.calls).toEqual([call]);
  });

  it("are refused for the front's own calls too", async () => {
    const { front, events } = harness();
    const call = { interfaceVersion: 1, operationId: OP(1), owner: OWNER, intent: "1".repeat(64) };
    for (const action of ["close_terminal", "remove"]) {
      expect(await codeOf(front.pages({ action, ...call }))).toBe("forbidden");
    }
    expect(await codeOf(front.pages({ action: "open_terminal", ...call, window: null }))).toBe(
      "forbidden",
    );
    expect(events.filter((e) => e === "window:open")).toEqual([]);
  });

  it("store nothing for a computer that does not exist", async () => {
    const { front, controller, store } = harness();
    controller.state = null;
    expect(await codeOf(front.pages({ action: "state", interfaceVersion: 1, owner: OWNER }))).toBe(
      "not_found",
    );
    const call = { interfaceVersion: 1, operationId: OP(1), owner: OWNER, intent: "1".repeat(64) };
    expect(await codeOf(front.pages({ action: "remove", ...call }))).toBe("not_found");
    expect(await codeOf(front.pages({ action: "restart", ...call }))).toBe("not_found");
    expect([...store.data.keys()]).toEqual([]);
  });

  it("compare in constant time over the whole string", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("the page front's answers", () => {
  it("adds the terminal's window to the state, and the token only for a named owner", async () => {
    const { front } = harness();
    const plain = await front.pages({ action: "state", interfaceVersion: 1 });
    expect(plain).not.toHaveProperty("intentToken");
    expect(
      plain.action === "state" && (plain.computer as { terminal?: unknown }).terminal,
    ).toMatchObject({ window: 0, open: false });
  });

  it("refuses an unknown call, and a newer interface version", async () => {
    const { front } = harness();
    expect(await codeOf(front.pages({ action: "launch_rockets", interfaceVersion: 1 }))).toBe(
      "bad_request",
    );
    expect(await codeOf(front.pages({ action: "state", interfaceVersion: 2 }))).toBe(
      "unsupported_version",
    );
    const intent = await intentOf(front);
    expect(
      await codeOf(
        front.pages({
          action: "close_terminal",
          interfaceVersion: 2,
          operationId: OP(1),
          owner: OWNER,
          intent,
        }),
      ),
    ).toBe("unsupported_version");
  });

  it.each(["restart", "stop_without_saving", "sign_out"])(
    "closes the terminal before %s reaches the controller",
    async (action) => {
      const { front, controller, events, terminal } = harness();
      const intent = await intentOf(front);
      await front.pages({
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP(1),
        owner: OWNER,
        intent,
        window: null,
      });
      expect(terminal.view().open).toBe(true);
      const at = events.length;
      await front.pages({ action, interfaceVersion: 1, operationId: OP(2), owner: OWNER, intent });
      expect(events.slice(at)).toContain("window:closed");
      expect(terminal.view().open).toBe(false);
      expect(controller.calls).toHaveLength(1);
    },
  );

  it("keeps the terminal for a size change or a revocation record", async () => {
    const { front, terminal } = harness();
    const intent = await intentOf(front);
    await front.pages({
      action: "open_terminal",
      interfaceVersion: 1,
      operationId: OP(1),
      owner: OWNER,
      intent,
      window: null,
    });
    await front.pages({
      action: "set_size",
      interfaceVersion: 1,
      operationId: OP(2),
      owner: OWNER,
      intent,
      size: "standard-1",
    });
    await front.pages({
      action: "record_revocation",
      interfaceVersion: 1,
      operationId: OP(3),
      owner: OWNER,
      intent,
    });
    expect(terminal.view().open).toBe(true);
  });

  it("closes the terminal before Omnigent's terminate, and checks it before a sleep", async () => {
    const { front, terminal, events } = harness();
    const intent = await intentOf(front);
    await front.pages({
      action: "open_terminal",
      interfaceVersion: 1,
      operationId: OP(1),
      owner: OWNER,
      intent,
      window: null,
    });
    await front.beforeLauncher(
      { interfaceVersion: 1, request: { operation: "suspend" } },
      () => undefined,
    );
    expect(terminal.view().open).toBe(true);
    // A call its authorization refuses (Codex WP8.4 r1-1) touches nothing: neither a sleep's
    // window check nor a terminate's close runs.
    const refuse = () => {
      throw platformError("forbidden", "someone else's computer");
    };
    for (const operation of ["suspend", "terminate", "status"]) {
      expect(
        await codeOf(front.beforeLauncher({ interfaceVersion: 1, request: { operation } }, refuse)),
        operation,
      ).toBe("forbidden");
      expect(terminal.view().open, operation).toBe(true);
    }
    await front.beforeLauncher(
      { interfaceVersion: 1, request: { operation: "terminate" } },
      () => undefined,
    );
    expect(terminal.view().open).toBe(false);
    expect(events).toContain("terminal_window_closed");
    await front.beforeLauncher(null, () => undefined);
    await front.beforeAlarm();
  });

  it("opens, reconnects and closes the terminal", async () => {
    const { front } = harness();
    const intent = await intentOf(front);
    const base = { interfaceVersion: 1, owner: OWNER, intent };
    const opened = await front.pages({
      action: "open_terminal",
      ...base,
      operationId: OP(1),
      window: null,
    });
    expect(opened).toMatchObject({
      action: "open_terminal",
      outcome: "accepted",
      window: 1,
      generation: 7,
    });
    expect(
      await front.pages({ action: "open_terminal", ...base, operationId: OP(2), window: 1 }),
    ).toMatchObject({ outcome: "accepted" });
    expect(await front.pages({ action: "close_terminal", ...base, operationId: OP(3) })).toEqual({
      action: "close_terminal",
      closed: true,
    });
    expect(await front.pages({ action: "close_terminal", ...base, operationId: OP(4) })).toEqual({
      action: "close_terminal",
      closed: false,
    });
  });

  it("offers a removal only for a computer Omnigent no longer calls", async () => {
    const { front, controller } = harness();
    const intent = await intentOf(front);
    const remove = (n: number) =>
      front.pages({
        action: "remove",
        interfaceVersion: 1,
        operationId: OP(n),
        owner: OWNER,
        intent,
      });
    expect(await remove(1)).toEqual({
      action: "remove",
      outcome: "refused",
      reason: "not_offered",
    });
    controller.state = pageState({
      noContact: true,
      removal: {
        state: "pending",
        signOut: "none",
        loginPossiblyLost: false,
        revocationRecorded: false,
      },
    });
    expect(await remove(2)).toMatchObject({ outcome: "refused" });
    expect(controller.launches).toEqual([]);
    controller.state = pageState({ noContact: true });
    expect(await remove(3)).toEqual({ action: "remove", outcome: "accepted" });
    expect(await remove(3)).toEqual({ action: "remove", outcome: "accepted" });
    // A repeat records the same intent again, which is the same intent (semantic idempotency).
    expect(controller.launches).toEqual(["remove", "remove"]);
  });

  it("answers the terminal's upgrade only with a well-formed header", async () => {
    const { front } = harness();
    expect((await front.fetch(new Request("https://w/"))).status).toBe(404);
    const up = (header: string) =>
      front.fetch(
        new Request("https://w/", { headers: { upgrade: "websocket", "x-cfo-terminal": header } }),
      );
    expect((await up("not json")).status).toBe(404);
    expect((await up(JSON.stringify({ interfaceVersion: 1 }))).status).toBe(404);
    const good = {
      interfaceVersion: 1,
      computerId: PAGE_CMP,
      owner: OWNER,
      capability: "A".repeat(43),
    };
    expect((await up(JSON.stringify({ ...good, interfaceVersion: 2 }))).status).toBe(400);
    expect((await up(JSON.stringify(good))).status).toBe(403);
  });
});

describe("whether a computer can have a terminal", () => {
  it.each([
    [{}, { ok: true, generation: 7, keepsShells: false }],
    [
      { lifecycle: "started_no_host", status: "started_no_host" },
      { ok: true, generation: 7, keepsShells: false },
    ],
    [
      { lifecycle: "host_refused", status: "host_refused" },
      { ok: true, generation: 7, keepsShells: false },
    ],
    [{ status: "stopping" }, { ok: false, reason: "busy" }],
    [
      {
        removal: {
          state: "none",
          signOut: "requested",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      { ok: false, reason: "busy" },
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "tombstoned",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      { ok: true, generation: 7, keepsShells: false },
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "verified",
          loginPossiblyLost: false,
          revocationRecorded: false,
          signOutRunning: true,
        },
      },
      { ok: false, reason: "busy" },
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "tombstoned",
          loginPossiblyLost: false,
          revocationRecorded: false,
          signOutRunning: true,
        },
      },
      { ok: false, reason: "busy" },
    ],
    [
      {
        removal: {
          state: "none",
          signOut: "requested",
          loginPossiblyLost: false,
          revocationRecorded: false,
          signOutRunning: false,
        },
      },
      { ok: true, generation: 7, keepsShells: false },
    ],
    [
      { lifecycle: "asleep", status: "stopped" },
      { ok: false, reason: "not_running" },
    ],
    [
      { lifecycle: "restoring", status: "started_no_host" },
      { ok: false, reason: "not_running" },
    ],
    [
      {
        removal: {
          state: "pending",
          signOut: "none",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      },
      { ok: false, reason: "not_offered" },
    ],
  ] as const)("%o → %o", (overrides, expected) => {
    expect(terminalTarget(pageState(overrides as Partial<ComputerPageState>))).toEqual(expected);
  });

  it("tells the bridge whether the supervisor keeps the shells (WP3.28)", async () => {
    expect(terminalTarget(pageState(), true)).toEqual({
      ok: true,
      generation: 7,
      keepsShells: true,
    });
    const { front, controller } = harness();
    expect(await front.target()).toMatchObject({ ok: true, keepsShells: false });
    (controller as { terminalShellsKept?: () => boolean }).terminalShellsKept = () => true;
    expect(await front.target()).toMatchObject({ ok: true, keepsShells: true });
  });
});

describe("the page front's own failures", () => {
  it("compares strings of different lengths either way round", () => {
    expect(constantTimeEqual("ab", "abc")).toBe(false);
  });

  it("reports a controller answer of the wrong kind as internal", async () => {
    const { front, controller } = harness();
    controller.pages = async () => ({ action: "set_size", appliesAt: "next_start" });
    expect(await codeOf(front.pages({ action: "state", interfaceVersion: 1 }))).toBe("internal");
  });

  it("answers an upgrade without the platform's header with 404", async () => {
    const { front } = harness();
    expect(
      (await front.fetch(new Request("https://w/", { headers: { upgrade: "websocket" } }))).status,
    ).toBe(404);
  });
});

describe("terminal admission is serialized with the steps that end it (Codex r1-1)", () => {
  it("an open that arrives during a sign-out waits for it, then finds the sign-out running", async () => {
    const { front, controller, terminal } = harness();
    const intent = await intentOf(front);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pages = controller.pages.bind(controller);
    let reached = false;
    controller.pages = async (call: unknown) => {
      const c = call as { action: string };
      if (c.action === "sign_out") {
        reached = true;
        await gate;
        controller.state = pageState({
          removal: {
            state: "none",
            signOut: "requested",
            loginPossiblyLost: false,
            revocationRecorded: false,
          },
        });
      }
      return pages(call);
    };
    const signOut = front.pages({
      action: "sign_out",
      interfaceVersion: 1,
      operationId: OP(1),
      owner: OWNER,
      intent,
    });
    // The sign-out holds the front's queue before the open arrives (not one event-loop turn,
    // which a loaded machine may not give it: this flaked under coverage).
    while (!reached) await new Promise((resolve) => setTimeout(resolve, 0));
    const opening = front.pages({
      action: "open_terminal",
      interfaceVersion: 1,
      operationId: OP(2),
      owner: OWNER,
      intent,
      window: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(terminal.view().open).toBe(false);
    release();
    await signOut;
    expect(await opening).toEqual({ action: "open_terminal", outcome: "refused", reason: "busy" });
    expect(terminal.view().open).toBe(false);
  });

  it("a failed step does not block the next one", async () => {
    const { front, controller } = harness();
    const intent = await intentOf(front);
    controller.pages = async (call: unknown) => {
      if ((call as { action: string }).action === "restart")
        throw platformError("internal", "boom");
      return { action: "state", computer: pageState() } as PagesResult;
    };
    expect(
      await codeOf(
        front.pages({
          action: "restart",
          interfaceVersion: 1,
          operationId: OP(1),
          owner: OWNER,
          intent,
        }),
      ),
    ).toBe("internal");
    expect(
      await front.pages({
        action: "close_terminal",
        interfaceVersion: 1,
        operationId: OP(2),
        owner: OWNER,
        intent,
      }),
    ).toEqual({
      action: "close_terminal",
      closed: false,
    });
  });
});

describe("sign-in from the page (WP3.23)", () => {
  it("keeps the terminal closed while a sign-in's CLI is not yet confirmed stopped", () => {
    expect(
      terminalTarget(pageState({ signIn: { available: "yes", cancelPending: true } })),
    ).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(
      terminalTarget(pageState({ signIn: { available: "yes", cancelPending: false } })).ok,
    ).toBe(true);
  });

  const base = (intent: string, extra: Record<string, unknown>) => ({
    interfaceVersion: 1,
    operationId: OP(7),
    owner: OWNER,
    intent,
    ...extra,
  });

  it("checks the intent token before any sign-in effect", async () => {
    const { front, controller } = harness();
    for (const extra of [
      { action: "sign_in_start", service: "claude", generation: 7 },
      { action: "sign_in_input", service: "claude", attempt: 1, code: "a#b" },
      { action: "sign_in_cancel", service: "codex", attempt: 2 },
      { action: "staging_check", rc53: true },
      { action: "staging_keep_awake", on: true },
    ]) {
      expect(await codeOf(front.pages(base("00".repeat(32), extra)))).toBe("forbidden");
    }
    expect(controller.signIns).toEqual([]);
  });

  it("binds each change to the caller's session; nothing of the token reaches the controller", async () => {
    const { front, controller } = harness();
    const intent = await intentOf(front);
    expect(
      await front.pages(
        base(intent, { action: "sign_in_start", service: "claude", generation: 7 }),
      ),
    ).toMatchObject({ action: "sign_in_start", outcome: "accepted" });
    await front.pages(
      base(intent, { action: "sign_in_input", service: "claude", attempt: 1, code: "a#b" }),
    );
    await front.pages(base(intent, { action: "sign_in_cancel", service: "claude", attempt: 1 }));
    expect(await front.pages(base(intent, { action: "staging_check", rc53: false }))).toEqual({
      action: "staging_check",
      outcome: "accepted",
      rc53: false,
    });
    expect(await front.pages(base(intent, { action: "staging_keep_awake", on: true }))).toEqual({
      action: "staging_keep_awake",
      outcome: "accepted",
      on: true,
    });
    const calls = controller.signIns.filter((c) => c.method !== "sessionAttempts");
    expect(calls).toEqual([
      {
        method: "start",
        input: { service: "claude", session: OWNER.sessionId, operationId: OP(7), generation: 7 },
      },
      {
        method: "input",
        input: {
          service: "claude",
          attempt: 1,
          code: "a#b",
          session: OWNER.sessionId,
          operationId: OP(7),
        },
      },
      { method: "cancel", input: { service: "claude", attempt: 1, session: OWNER.sessionId } },
      { method: "staging", input: { rc53: false } },
      { method: "keep_awake", input: { on: true } },
    ]);
    expect(JSON.stringify(calls)).not.toContain(intent);
  });

  it("answers reads without a token, naming the caller's session", async () => {
    const { front, controller } = harness();
    expect(
      await front.pages({
        action: "sign_in_status",
        interfaceVersion: 1,
        owner: OWNER,
        service: "codex",
        attempt: 3,
      }),
    ).toMatchObject({ action: "sign_in_status", outcome: "accepted" });
    expect(
      await front.pages({ action: "computer_status", interfaceVersion: 1, owner: OWNER }),
    ).toMatchObject({ action: "computer_status", status: { observedAt: expect.any(String) } });
    expect(controller.signIns).toEqual([
      { method: "status", input: { service: "codex", attempt: 3, session: OWNER.sessionId } },
      { method: "computer_status", input: null },
    ]);
    expect(
      await codeOf(front.pages({ action: "computer_status", interfaceVersion: 99, owner: OWNER })),
    ).toBe("unsupported_version");
    controller.state = null;
    expect(
      await codeOf(front.pages({ action: "computer_status", interfaceVersion: 1, owner: OWNER })),
    ).toBe("not_found");
  });

  it("adds the caller's running attempts to the page state", async () => {
    const { front, controller } = harness();
    controller.attempts = [{ service: "codex", attempt: 4 }];
    controller.state = pageState({ signIn: { available: "yes" } });
    const state = await front.pages({ action: "state", interfaceVersion: 1, owner: OWNER });
    expect((state as { computer: { signIn: unknown } }).computer.signIn).toEqual({
      available: "yes",
      attempts: [{ service: "codex", attempt: 4 }],
    });
    // Without the owner, or from an older controller without `signIn`, nothing is added.
    const anonymous = await front.pages({ action: "state", interfaceVersion: 1 });
    expect((anonymous as { computer: { signIn: unknown } }).computer.signIn).toEqual({
      available: "yes",
    });
    controller.state = pageState();
    const older = await front.pages({ action: "state", interfaceVersion: 1, owner: OWNER });
    expect((older as { computer: { signIn?: unknown } }).computer.signIn).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// WP8.4 (D50): every page call checked against the computer's owner binding (T3, T13).

describe("a computer's pages are its owner's (WP8.4)", () => {
  const TEAM = "9f8e7d6c5b4a49382716f5e4d3c2b1a0";
  const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
  const person = (memberId: string, userId: string, role: "owner" | "admin" | "member") =>
    ({ kind: "member", memberId, userId, role }) as const;
  const ALICE = {
    sub: "alice-sub",
    sessionId: "a1".repeat(32),
    person: person("0a1b2c3d4e5f40718293a4b5c6d7e8f9", "alice", "member"),
  };
  const BOB = {
    sub: "bob-sub",
    sessionId: "b2".repeat(32),
    person: person("1b2c3d4e5f60718293a4b5c6d7e8f90a", "bob", "member"),
  };
  const CAROL = {
    sub: "carol-sub",
    sessionId: "c3".repeat(32),
    person: person("2c3d4e5f60718293a4b5c6d7e8f90a1b", "carol", "admin"),
  };
  const FOUNDER = {
    sub: "founder-sub",
    sessionId: "f4".repeat(32),
    person: { kind: "installation_owner" } as const,
  };
  const alicesBinding: OwnerBinding = {
    userId: "alice",
    memberId: ALICE.person.memberId,
    teamId: TEAM,
    hostId: HOST,
    how: "provision",
    boundAt: 1,
  };

  function alicesComputer(state: Partial<ComputerPageState> = {}) {
    const h = harness();
    h.controller.binding = alicesBinding;
    h.controller.state = pageState(state);
    return h;
  }

  async function tokenFor(front: PageFront, owner: object): Promise<string | undefined> {
    const result = await front.pages({ action: "state", interfaceVersion: 1, owner });
    return result.action === "state" && "intentToken" in result
      ? (result.intentToken as string)
      : undefined;
  }

  /** Every mutating page call, from `owner` with `intent`. */
  const changes = (owner: object, intent: string) => [
    {
      action: "open_terminal",
      interfaceVersion: 1,
      operationId: OP(1),
      owner,
      intent,
      window: null,
    },
    { action: "close_terminal", interfaceVersion: 1, operationId: OP(2), owner, intent },
    {
      action: "sign_in_start",
      interfaceVersion: 1,
      operationId: OP(3),
      owner,
      intent,
      service: "claude",
      generation: 7,
    },
    {
      action: "sign_in_input",
      interfaceVersion: 1,
      operationId: OP(4),
      owner,
      intent,
      service: "claude",
      attempt: 1,
      code: "code-canary-0123456789",
    },
    {
      action: "sign_in_cancel",
      interfaceVersion: 1,
      operationId: OP(5),
      owner,
      intent,
      service: "claude",
      attempt: 1,
    },
    { action: "staging_check", interfaceVersion: 1, operationId: OP(6), owner, intent, rc53: true },
    { action: "set_size", interfaceVersion: 1, operationId: OP(7), owner, intent, size: "basic" },
    { action: "stop_without_saving", interfaceVersion: 1, operationId: OP(8), owner, intent },
    { action: "record_revocation", interfaceVersion: 1, operationId: OP(9), owner, intent },
    { action: "sign_out", interfaceVersion: 1, operationId: OP(10), owner, intent },
    { action: "resolve_removal", interfaceVersion: 1, operationId: OP(11), owner, intent },
    { action: "restart", interfaceVersion: 1, operationId: OP(12), owner, intent },
    { action: "remove", interfaceVersion: 1, operationId: OP(13), owner, intent },
  ];

  it("answers another member as if the computer did not exist: no state, read, change or token", async () => {
    const { front, controller, events } = alicesComputer({ noContact: true });
    expect(await codeOf(front.pages({ action: "state", interfaceVersion: 1, owner: BOB }))).toBe(
      "not_found",
    );
    for (const read of [
      { action: "computer_status", interfaceVersion: 1, owner: BOB },
      { action: "sign_in_status", interfaceVersion: 1, owner: BOB, service: "claude", attempt: 1 },
    ]) {
      expect(await codeOf(front.pages(read)), read.action).toBe("not_found");
    }
    // With a well-formed token of his own making, or Alice's own token replayed: not found either.
    const alicesToken = (await tokenFor(front, ALICE)) as string;
    for (const intent of ["0".repeat(64), alicesToken]) {
      for (const change of changes(BOB, intent)) {
        expect(await codeOf(front.pages(change)), change.action).toBe("not_found");
      }
    }
    expect(controller.calls).toEqual([]);
    expect(controller.launches).toEqual([]);
    expect(controller.signIns.filter((s) => s.method !== "sessionAttempts")).toEqual([]);
    expect(events.filter((e) => e === "page_refused").length).toBeGreaterThan(20);
  });

  it("lets the owner do every one of those things", async () => {
    const { front, controller } = alicesComputer({ noContact: true });
    const state = await front.pages({ action: "state", interfaceVersion: 1, owner: ALICE });
    expect(state).toMatchObject({ computer: { access: "owner" } });
    expect(
      await codeOf(front.pages({ action: "computer_status", interfaceVersion: 1, owner: ALICE })),
    ).toBeUndefined();
    const intent = (await tokenFor(front, ALICE)) as string;
    for (const change of changes(ALICE, intent)) {
      expect(await codeOf(front.pages(change)), change.action).toBeUndefined();
    }
    expect(controller.calls.map((c) => (c as { action: string }).action)).toEqual([
      "set_size",
      "stop_without_saving",
      "record_revocation",
      "sign_out",
      "resolve_removal",
      "restart",
    ]);
    expect(controller.launches).toEqual(["remove"]);
  });

  // WP8.15 (D62) replaces WP8.4's "the fleet view and the stop only": an administrator helping the
  // owner gets the setup page, its status, the terminal and the size too. The sign-ins, the
  // revocation record and the staging switches stay the owner's, and so does a sign-out outside
  // a removal.
  it("gives an administrator the setup page, its status, the terminal, the size and the stop, never a sign-in", async () => {
    const { front, controller } = alicesComputer({ noContact: true, signIn: { available: "yes" } });
    const state = await front.pages({ action: "state", interfaceVersion: 1, owner: CAROL });
    expect(state).toMatchObject({
      computer: {
        access: "admin",
        ownerName: "alice",
        ownerMemberId: ALICE.person.memberId,
        terminal: { window: 0, open: false },
        setupCards: pageState().setupCards,
      },
    });
    const computer = (state as { computer: Record<string, unknown> }).computer;
    expect(computer.signIn).toBeUndefined();
    expect(
      await codeOf(front.pages({ action: "computer_status", interfaceVersion: 1, owner: CAROL })),
    ).toBeUndefined();
    expect(
      await codeOf(
        front.pages({
          action: "sign_in_status",
          interfaceVersion: 1,
          owner: CAROL,
          service: "claude",
          attempt: 1,
        }),
      ),
    ).toBe("forbidden");
    const intent = (await tokenFor(front, CAROL)) as string;
    const allowed: string[] = [];
    for (const change of changes(CAROL, intent)) {
      const code = await codeOf(front.pages(change));
      if (code === undefined) allowed.push(change.action);
      else expect(code, change.action).toBe("forbidden");
    }
    // Without a pending removal: the terminal, the size, the stop, and the removal of a computer
    // Omnigent no longer calls; no sign-in, staging switch, sign-out or revocation record.
    expect(allowed).toEqual(["open_terminal", "close_terminal", "set_size", "restart", "remove"]);
    expect(controller.calls.map((c) => (c as { action: string }).action)).toEqual([
      "set_size",
      "restart",
    ]);
    expect(
      controller.signIns.filter(
        (s) => s.method !== "sessionAttempts" && s.method !== "computer_status",
      ),
    ).toEqual([]);
    // Acting on the computer never moves it: the binding still names Alice.
    expect(controller.ownership()?.binding).toEqual(alicesBinding);
    // Alice's token is hers: Carol presenting it is refused.
    const alicesToken = (await tokenFor(front, ALICE)) as string;
    expect(
      await codeOf(
        front.pages({
          action: "restart",
          interfaceVersion: 1,
          operationId: OP(20),
          owner: CAROL,
          intent: alicesToken,
        }),
      ),
    ).toBe("forbidden");
  });

  it("never shows an administrator the owner's sign-in attempt, even while it runs, nor lets them read it", async () => {
    const { front, controller } = alicesComputer({ signIn: { available: "yes" } });
    controller.attempts = [{ service: "claude", attempt: 3 }];
    // Alice's page resumes her running attempt.
    const alices = await front.pages({ action: "state", interfaceVersion: 1, owner: ALICE });
    expect((alices as { computer: { signIn: unknown } }).computer.signIn).toEqual({
      available: "yes",
      attempts: [{ service: "claude", attempt: 3 }],
    });
    // Carol's state carries no attempt, and her read of it is refused before the controller.
    const carols = await front.pages({ action: "state", interfaceVersion: 1, owner: CAROL });
    const text = JSON.stringify(carols);
    expect(text).not.toContain('"signIn"');
    expect(text).not.toContain('"attempts"');
    const read = (owner: object) =>
      front.pages({
        action: "sign_in_status",
        interfaceVersion: 1,
        owner,
        service: "claude",
        attempt: 3,
      });
    expect(await codeOf(read(CAROL))).toBe("forbidden");
    expect(await codeOf(read(FOUNDER))).toBe("forbidden");
    expect(controller.signIns.filter((s) => s.method === "status")).toEqual([]);
    expect(await codeOf(read(ALICE))).toBeUndefined();
    expect(controller.signIns.filter((s) => s.method === "status")).toHaveLength(1);
  });

  it("logs each support action with the computer, the action and the actor's member ID, never an account or address", async () => {
    const { front, logged } = alicesComputer({ noContact: true });
    const carol = (await tokenFor(front, CAROL)) as string;
    const founder = (await tokenFor(front, FOUNDER)) as string;
    const alice = (await tokenFor(front, ALICE)) as string;
    await front.pages({ action: "computer_status", interfaceVersion: 1, owner: CAROL });
    const base = (owner: object, intent: string, n: number) => ({
      interfaceVersion: 1,
      operationId: OP(n),
      owner,
      intent,
    });
    await front.pages({ action: "open_terminal", ...base(CAROL, carol, 80), window: null });
    await front.pages({ action: "set_size", ...base(CAROL, carol, 81), size: "basic" });
    await front.pages({ action: "restart", ...base(FOUNDER, founder, 82) });
    // The owner's own actions are not support actions.
    await front.pages({ action: "set_size", ...base(ALICE, alice, 83), size: "basic" });
    await front.pages({ action: "computer_status", interfaceVersion: 1, owner: ALICE });
    // A refused call is not one either.
    await codeOf(front.pages({ action: "record_revocation", ...base(CAROL, carol, 84) }));
    const carolKey = `member:${CAROL.person.memberId}`;
    expect(logged.filter((e) => e.event === "page_support_action").map((e) => e.fields)).toEqual([
      { computer: PAGE_CMP, action: "computer_status", actor: carolKey },
      { computer: PAGE_CMP, action: "open_terminal", actor: carolKey },
      { computer: PAGE_CMP, action: "set_size", actor: carolKey },
      { computer: PAGE_CMP, action: "restart", actor: "installation" },
    ]);
    const text = JSON.stringify(logged);
    for (const personal of ["alice", "carol", "founder", "-sub", "@"]) {
      expect(text, personal).not.toContain(personal);
    }
  });

  it("names who acted to the controller's journal: a member, or the installation's owner", async () => {
    const { front, controller } = alicesComputer();
    for (const [who, n] of [
      [CAROL, 90],
      [ALICE, 91],
      [FOUNDER, 92],
    ] as const) {
      const intent = (await tokenFor(front, who)) as string;
      await front.pages({
        action: "set_size",
        interfaceVersion: 1,
        operationId: OP(n),
        owner: who,
        intent,
        size: "basic",
      });
    }
    expect(controller.actors).toEqual([
      `member:${CAROL.person.memberId}`,
      `member:${ALICE.person.memberId}`,
      "installation",
    ]);
    // The owner and the token are still stripped: the actor goes beside the call, not in it.
    for (const call of controller.calls) {
      expect(Object.keys(call as object)).not.toContain("owner");
      expect(Object.keys(call as object)).not.toContain("intent");
      expect(Object.keys(call as object)).not.toContain("actor");
    }
  });

  it("lets an administrator sign a computer being removed out and finish its removal, only then", async () => {
    const pendingRemoval = {
      state: "pending" as const,
      signOut: "none" as const,
      loginPossiblyLost: false,
      revocationRecorded: false,
    };
    const { front, controller } = alicesComputer({ removal: pendingRemoval });
    const intent = (await tokenFor(front, CAROL)) as string;
    for (const action of ["sign_out", "resolve_removal"]) {
      expect(
        await codeOf(
          front.pages({ action, interfaceVersion: 1, operationId: OP(30), owner: CAROL, intent }),
        ),
        action,
      ).toBeUndefined();
    }
    // The revocation record and the staging switches stay the owner's (D62).
    for (const action of ["record_revocation", "staging_check"]) {
      expect(
        await codeOf(
          front.pages({
            action,
            interfaceVersion: 1,
            operationId: OP(31),
            owner: CAROL,
            intent,
            rc53: true,
          }),
        ),
        action,
      ).toBe("forbidden");
    }
    expect(controller.calls.map((c) => (c as { action: string }).action)).toEqual([
      "sign_out",
      "resolve_removal",
    ]);
  });

  it("lets an administrator delete a computer being removed without signing out, never its owner", async () => {
    const pendingRemoval = {
      state: "pending" as const,
      signOut: "requested" as const,
      loginPossiblyLost: false,
      revocationRecorded: false,
    };
    const { front, controller } = alicesComputer({
      lifecycle: "removal_pending",
      removal: pendingRemoval,
    });
    const call = (owner: object, intent: string) =>
      front.pages({
        action: "delete_without_sign_out",
        interfaceVersion: 1,
        operationId: OP(50),
        owner,
        intent,
      });
    // Alice records that she revoked the sessions instead; Bob learns nothing.
    expect(await codeOf(call(ALICE, (await tokenFor(front, ALICE)) as string))).toBe("forbidden");
    expect(await codeOf(call(BOB, "0".repeat(64)))).toBe("not_found");
    expect(controller.calls).toEqual([]);
    expect(await codeOf(call(CAROL, (await tokenFor(front, CAROL)) as string))).toBeUndefined();
    expect(controller.calls.map((c) => (c as { action: string }).action)).toEqual([
      "delete_without_sign_out",
    ]);
  });

  it("refuses an administrator's delete without sign-out while no removal is pending", async () => {
    const { front, controller } = alicesComputer({ noContact: true });
    const intent = (await tokenFor(front, CAROL)) as string;
    expect(
      await codeOf(
        front.pages({
          action: "delete_without_sign_out",
          interfaceVersion: 1,
          operationId: OP(51),
          owner: CAROL,
          intent,
        }),
      ),
    ).toBe("forbidden");
    expect(controller.calls).toEqual([]);
  });

  it("removes only a lost host, awake and not called for an hour, for its owner and an admin alike", async () => {
    const remove = (front: PageFront, owner: object, intent: string, n: number) =>
      front.pages({ action: "remove", interfaceVersion: 1, operationId: OP(n), owner, intent });
    // Asleep for an hour, as WorkspaceDO reports it: never without contact, so for nobody.
    const asleep = alicesComputer({ noContact: false, lifecycle: "asleep", status: "stopped" });
    for (const [who, n] of [
      [CAROL, 60],
      [ALICE, 61],
    ] as const) {
      expect(
        await remove(asleep.front, who, (await tokenFor(asleep.front, who)) as string, n),
      ).toEqual({ action: "remove", outcome: "refused", reason: "not_offered" });
    }
    expect(asleep.controller.launches).toEqual([]);
    // Awake and not called for an hour: a lost host, which either may remove.
    for (const [who, n] of [
      [CAROL, 62],
      [ALICE, 63],
    ] as const) {
      const awake = alicesComputer({ noContact: true, lifecycle: "host_running" });
      expect(
        await remove(awake.front, who, (await tokenFor(awake.front, who)) as string, n),
      ).toEqual({ action: "remove", outcome: "accepted" });
    }
  });

  it("lets an administrator stop a removed member's computer without saving only once its saves failed", async () => {
    const removal = {
      state: "pending" as const,
      signOut: "none" as const,
      loginPossiblyLost: false,
      revocationRecorded: false,
      memberRemoved: true,
    };
    const call = (front: PageFront, owner: object, intent: string, n: number) =>
      front.pages({
        action: "stop_without_saving",
        interfaceVersion: 1,
        operationId: OP(n),
        owner,
        intent,
      });
    // Two refused stops: not yet, for an administrator; nothing reaches the controller.
    const early = alicesComputer({
      lifecycle: "host_running",
      removal: { ...removal, refusedStops: 2 },
    });
    expect(
      await call(early.front, CAROL, (await tokenFor(early.front, CAROL)) as string, 70),
    ).toEqual({
      action: "stop_without_saving",
      outcome: "refused",
      reason: "not_offered",
    });
    expect(early.controller.calls).toEqual([]);
    // Three: Carol's call reaches the controller; Bob learns nothing.
    const due = alicesComputer({
      lifecycle: "host_running",
      removal: { ...removal, refusedStops: 3 },
    });
    expect(await codeOf(call(due.front, BOB, "0".repeat(64), 71))).toBe("not_found");
    expect(
      await codeOf(call(due.front, CAROL, (await tokenFor(due.front, CAROL)) as string, 72)),
    ).toBeUndefined();
    expect(due.controller.calls.map((c) => (c as { action: string }).action)).toEqual([
      "stop_without_saving",
    ]);
    // Not a member removal (Alice deleted it herself): not for an administrator.
    const own = alicesComputer({
      lifecycle: "host_running",
      removal: { ...removal, memberRemoved: false, refusedStops: 5 },
    });
    expect(
      await call(own.front, CAROL, (await tokenFor(own.front, CAROL)) as string, 73),
    ).toMatchObject({ outcome: "refused", reason: "not_offered" });
  });

  it("keeps the remove's own gate for an administrator: only while Omnigent no longer calls", async () => {
    const { front, controller } = alicesComputer({ noContact: false });
    const intent = (await tokenFor(front, CAROL)) as string;
    expect(
      await front.pages({
        action: "remove",
        interfaceVersion: 1,
        operationId: OP(40),
        owner: CAROL,
        intent,
      }),
    ).toEqual({ action: "remove", outcome: "refused", reason: "not_offered" });
    expect(controller.launches).toEqual([]);
  });

  // WP8.15 (D62) replaces WP8.4's "anyone but the owner": an administrator's upgrade reaches the
  // capability check too, and the capability stays bound to their own Access session.
  it("accepts an administrator's own terminal capability, never one replayed in another session, and refuses others before it is looked at", async () => {
    const { front, logged } = alicesComputer();
    const up = (owner: object, capability: string) =>
      front.fetch(
        new Request("https://w/", {
          headers: {
            upgrade: "websocket",
            "x-cfo-terminal": JSON.stringify({
              interfaceVersion: 1,
              computerId: PAGE_CMP,
              owner,
              capability,
            }),
          },
        }),
      );
    const unknown = "A".repeat(43);
    expect((await up(BOB, unknown)).status).toBe(404);
    // The owner and the administrators reach the capability check (an unknown capability: 403).
    for (const who of [ALICE, CAROL, FOUNDER]) expect((await up(who, unknown)).status).toBe(403);
    const intent = (await tokenFor(front, CAROL)) as string;
    const open = async (n: number, window: number | null) => {
      const result = await front.pages({
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP(n),
        owner: CAROL,
        intent,
        window,
      });
      return result as { outcome: string; window: number; capability: string };
    };
    const first = await open(100, null);
    expect(first.outcome).toBe("accepted");
    // Replayed in another of Carol's sessions, or by Bob: refused; and spent either way.
    expect((await up({ ...CAROL, sessionId: "c4".repeat(32) }, first.capability)).status).toBe(403);
    expect(logged).toContainEqual({
      event: "terminal_upgrade_refused",
      fields: { reason: "wrong_session" },
    });
    expect((await up(BOB, first.capability)).status).toBe(404);
    expect((await up(CAROL, first.capability)).status).toBe(403);
    // A fresh capability for the same window, in her own session: bridged.
    const again = await open(101, first.window);
    const bridged = await up(CAROL, again.capability);
    expect(bridged.status).not.toBe(403);
    expect(bridged.status).not.toBe(404);
    expect(logged.filter((e) => e.event === "terminal_upgrade_refused")).toHaveLength(5);
    expect(logged).toContainEqual({
      event: "page_support_action",
      fields: {
        computer: PAGE_CMP,
        action: "terminal_connect",
        actor: `member:${CAROL.person.memberId}`,
      },
    });
  });

  // Codex WP8.15 r1 R1: an administrator's terminal on someone else's computer ends once that
  // person loses their authority there (demoted, suspended, removed, no longer admitted),
  // through the answer the pages' seam trusts; the owner's own streams never depend on it.
  describe("an administrator's terminal while their authority holds (Codex r1 R1)", () => {
    const ISSUER = "https://team.cloudflareaccess.com";
    const AUD = "a".repeat(64);
    const carolIn = { ...CAROL, admission: "members" as const, issuer: ISSUER, audience: AUD };
    const carolAs = (fields: Partial<Extract<PagePersonResult, { action: "member" }>> = {}) =>
      ({
        action: "member",
        memberId: CAROL.person.memberId,
        userId: "carol",
        role: "admin",
        state: "active",
        ...fields,
      }) as PagePersonResult;

    /** Alice's computer with `who`'s terminal connected; the answer is Carol's, active admin. */
    async function connected(who: object) {
      const h = alicesComputer();
      h.people.answer = async () => carolAs();
      const intent = (await tokenFor(h.front, who)) as string;
      const opened = (await h.front.pages({
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP(110),
        owner: who,
        intent,
        window: null,
      })) as { outcome: string; capability: string };
      expect(opened.outcome).toBe("accepted");
      const bridged = await h.front.fetch(
        new Request("https://w/", {
          headers: {
            upgrade: "websocket",
            "x-cfo-terminal": JSON.stringify({
              interfaceVersion: 1,
              computerId: PAGE_CMP,
              owner: who,
              capability: opened.capability,
            }),
          },
        }),
      );
      expect(bridged.status).not.toBe(403);
      expect(h.terminal.view()).toMatchObject({ open: true, streams: 1 });
      return h;
    }

    const ended = (h: Awaited<ReturnType<typeof connected>>) =>
      h.logged.filter((e) => e.event === "page_support_ended").map((e) => e.fields);

    it("keeps the terminal while the answer is unchanged, asking with the admitted identity", async () => {
      const h = await connected(carolIn);
      await h.terminal.enforceAuthority();
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: true, streams: 1 });
      expect(h.people.asked).toEqual([
        { interfaceVersion: 1, issuer: ISSUER, subject: "carol-sub", audience: AUD },
        { interfaceVersion: 1, issuer: ISSUER, subject: "carol-sub", audience: AUD },
      ]);
      expect(ended(h)).toEqual([]);
    });

    it.each([
      ["demoted to member", async () => carolAs({ role: "member" }), "not_admin"],
      ["suspended", async () => carolAs({ state: "suspended" }), "suspended"],
      ["removed", async () => carolAs({ state: "removed" }), "removed"],
      ["no longer bound to a member", async () => ({ action: "none" }) as const, "not_bound"],
      [
        "bound to a new membership",
        async () => carolAs({ memberId: "3d4e5f60718293a4b5c6d7e8f90a1b2c" }),
        "another_member",
      ],
      [
        "unanswered: the server is down",
        async () => ({ action: "unavailable" }) as const,
        "unanswered",
      ],
      [
        "unanswered: an older server",
        async () => ({ action: "unsupported" }) as const,
        "unanswered",
      ],
      [
        "unanswered: the call fails",
        async () => {
          throw new Error("no such method");
        },
        "unanswered",
      ],
      ["unanswered: no answer in time", () => new Promise<never>(() => undefined), "unanswered"],
    ] as const)("ends it, and its shell, once Carol is %s", async (_name, answer, reason) => {
      const h = await connected(carolIn);
      h.people.answer = answer as (call: PagePersonCall) => Promise<PagePersonResult>;
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: false, streams: 0 });
      expect(h.terminal.pendingEnd()).not.toBeNull();
      expect(h.events).toContain("window:closed");
      expect(ended(h)).toEqual([
        { computer: PAGE_CMP, actor: `member:${CAROL.person.memberId}`, reason },
      ]);
      // Her next upgrade is refused: the window is closed.
      expect(JSON.stringify(h.logged)).not.toContain("carol-sub");
    });

    it("never asks about the owner's own terminal, whatever the answer", async () => {
      const h = await connected({ ...ALICE, admission: "members", issuer: ISSUER, audience: AUD });
      h.people.answer = async () => ({ action: "none" });
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: true, streams: 1 });
      expect(h.people.asked).toEqual([]);
    });

    it("stops asking once the owner opens a window of their own", async () => {
      const h = await connected(carolIn);
      const intent = (await tokenFor(h.front, ALICE)) as string;
      const mine = (await h.front.pages({
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP(111),
        owner: ALICE,
        intent,
        window: null,
      })) as { capability: string };
      expect(h.terminal.view().window).toBe(2);
      await h.front.fetch(
        new Request("https://w/", {
          headers: {
            upgrade: "websocket",
            "x-cfo-terminal": JSON.stringify({
              interfaceVersion: 1,
              computerId: PAGE_CMP,
              owner: ALICE,
              capability: mine.capability,
            }),
          },
        }),
      );
      h.people.answer = async () => ({ action: "none" });
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: true, streams: 1 });
      expect(h.people.asked).toEqual([]);
    });

    it("keeps the installation's owner's in owner admission, where the owner pin is the answer", async () => {
      const h = await connected({ ...FOUNDER, admission: "owner", issuer: ISSUER, audience: AUD });
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: true, streams: 1 });
      expect(h.people.asked).toEqual([]);
    });

    it("ends one whose web Worker named no admission: no answer can be had", async () => {
      const h = await connected(CAROL);
      await h.terminal.enforceAuthority();
      expect(h.terminal.view()).toMatchObject({ open: false, streams: 0 });
      expect(h.people.asked).toEqual([]);
      expect(ended(h)).toEqual([
        { computer: PAGE_CMP, actor: `member:${CAROL.person.memberId}`, reason: "unanswered" },
      ]);
    });
  });

  it("gives the installation's owner every computer recorded without an owner, and an administrator's view of a member's", async () => {
    const unbound = harness();
    unbound.controller.binding = null;
    expect(
      await unbound.front.pages({ action: "state", interfaceVersion: 1, owner: FOUNDER }),
    ).toMatchObject({ computer: { access: "owner" } });
    // A web Worker from before WP8.4 names no person: the installation's owner.
    expect(
      await unbound.front.pages({ action: "state", interfaceVersion: 1, owner: OWNER }),
    ).toMatchObject({ computer: { access: "owner" } });
    // A member is not the owner of a computer recorded without an owner.
    expect(
      await codeOf(unbound.front.pages({ action: "state", interfaceVersion: 1, owner: BOB })),
    ).toBe("not_found");
    // An administrator helps on it as the installation owner's: no account or member to name.
    expect(
      await unbound.front.pages({ action: "state", interfaceVersion: 1, owner: CAROL }),
    ).toMatchObject({ computer: { access: "admin", ownerName: null, ownerMemberId: null } });
    const { front } = alicesComputer();
    expect(
      await front.pages({ action: "state", interfaceVersion: 1, owner: FOUNDER }),
    ).toMatchObject({ computer: { access: "admin", ownerName: "alice" } });
  });

  it("binds the intent token to the person as well as the Access session", async () => {
    const { front } = alicesComputer();
    const asAlice = await front.intentFor(ALICE);
    expect(await front.intentFor({ ...ALICE, person: BOB.person })).not.toBe(asAlice);
    expect(await front.intentFor({ ...ALICE, sessionId: "a2".repeat(32) })).not.toBe(asAlice);
    expect(await front.intentFor(ALICE)).toBe(asAlice);
  });
});
