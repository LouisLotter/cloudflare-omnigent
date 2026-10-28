// WorkspaceDO's page front (WP3.5, `computer/page-front.ts`): the request-intent token checked in
// constant time before any effect (P1); owner and token stripped before the controller; the
// terminal closed before every credential-sensitive step; removal offered only for a computer
// Omnigent no longer calls (FH-29).
import type { ComputerPageState, PagesResult } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
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
  readonly launches: unknown[] = [];

  async pages(call: unknown): Promise<PagesResult> {
    if (this.state === null) throw platformError("not_found", "no such computer");
    const c = call as { action: string };
    if (c.action === "state") return { action: "state", computer: this.state };
    this.calls.push(call);
    if (c.action === "set_size") return { action: "set_size", appliesAt: "next_start" };
    return { action: c.action, outcome: "accepted" } as PagesResult;
  }

  async launcher(call: unknown) {
    this.launches.push(call);
    return { operation: "terminate" as const, removal: "pending" as const };
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
  let front: PageFront | null = null;
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
    log: (event) => events.push(event),
  });
  front = new PageFront(PAGE_CMP, { store, controller, terminal, log: (e) => events.push(e) });
  return { store, controller, terminal, front, events, ttyd };
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
    await front.beforeLauncher({ interfaceVersion: 1, request: { operation: "suspend" } });
    expect(terminal.view().open).toBe(true);
    await front.beforeLauncher({ interfaceVersion: 1, request: { operation: "terminate" } });
    expect(terminal.view().open).toBe(false);
    expect(events).toContain("terminal_window_closed");
    await front.beforeLauncher(null);
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
    const [first, second] = controller.launches as {
      request: { operationId: string; operation: string; computerId: string };
    }[];
    expect(first?.request).toMatchObject({ operation: "terminate", computerId: PAGE_CMP });
    expect(first?.request.operationId).toMatch(/^[0-9a-f]{32}$/);
    expect(second?.request.operationId).toBe(first?.request.operationId);
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
    [{}, { ok: true, generation: 7 }],
    [
      { lifecycle: "started_no_host", status: "started_no_host" },
      { ok: true, generation: 7 },
    ],
    [
      { lifecycle: "host_refused", status: "host_refused" },
      { ok: true, generation: 7 },
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
      { ok: true, generation: 7 },
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
      { ok: true, generation: 7 },
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
});

describe("the page front's own failures", () => {
  it("compares strings of different lengths either way round", () => {
    expect(constantTimeEqual("ab", "abc")).toBe(false);
  });

  it("reports a controller answer of the wrong kind as internal", async () => {
    const { front, controller } = harness();
    const intent = await intentOf(front);
    controller.launcher = async () => ({ operation: "status" }) as never;
    controller.state = pageState({ noContact: true });
    expect(
      await codeOf(
        front.pages({
          action: "remove",
          interfaceVersion: 1,
          operationId: OP(1),
          owner: OWNER,
          intent,
        }),
      ),
    ).toBe("internal");
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
    controller.pages = async (call: unknown) => {
      const c = call as { action: string };
      if (c.action === "sign_out") {
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
    await new Promise((resolve) => setTimeout(resolve, 0));
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
