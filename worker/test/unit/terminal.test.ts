// The setup terminal's bridge (WP3.5, `computer/terminal.ts`): capabilities bound to the owner,
// session, purpose, computer, generation and window (R-29); one use only; streams ended on expiry,
// removal, a generation change and before credential-sensitive steps (RC-24); reattach after a
// browser drop (FH-38); nothing the terminal carries is logged.
import type { ComputerId, PageOwner, TerminalUpgrade } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  CLOSED_BY_COMPUTER,
  CLOSED_BY_PLATFORM,
  TerminalBridge,
  type TerminalTarget,
} from "../../src/computer/terminal.ts";
import { FakeSocket, FakeTtyd, fakePair, SocketResponse } from "../support/fake-sockets.ts";
import { MemoryStore } from "../support/memory-store.ts";

const CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
const OWNER: PageOwner = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const OP = (n: number) => `op_${String(n).padStart(26, "0")}`;

/** The browser's 101 in Node: carries the pair's client end. */
class UpgradeResponse extends Response {
  readonly client: FakeSocket;

  constructor(client: FakeSocket) {
    super(null, { status: 200 });
    this.client = client;
  }
}

function harness(start = 1_000_000_000_000) {
  const store = new MemoryStore();
  const ttyd = new FakeTtyd();
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const windows: (number | null)[] = [];
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextTimer = 1;
  const h = {
    now: start,
    store,
    ttyd,
    logs,
    windows,
    target: { ok: true, generation: 3 } as TerminalTarget,
    targetFails: false,
    bridge: null as unknown as TerminalBridge,
    build(): TerminalBridge {
      h.bridge = new TerminalBridge({
        computerId: CMP,
        store,
        now: () => h.now,
        target: async () => {
          if (h.targetFails) throw new Error("the controller cannot be asked");
          return h.target;
        },
        dial: ttyd.dial,
        setWindow: async (until) => {
          windows.push(until);
        },
        pair: () => fakePair("browser"),
        upgradeResponse: (client) => new UpgradeResponse(client as FakeSocket),
        socketOf: (response) => (response instanceof SocketResponse ? response.socket : null),
        sleep: async () => undefined,
        setTimer: (fn, ms) => {
          const id = nextTimer++;
          timers.set(id, { fn, at: h.now + ms });
          return id;
        },
        clearTimer: (id) => {
          timers.delete(id as number);
        },
        log: (event, fields) => logs.push({ event, fields }),
      });
      return h.bridge;
    },
    /** Advances the clock and runs the timers that are due. */
    async advance(ms: number) {
      h.now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= h.now) {
          timers.delete(id);
          timer.fn();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async open(op = OP(1), window: number | null = null) {
      const result = await h.bridge.open({ operationId: op, owner: OWNER, window });
      if (result.outcome !== "accepted") throw new Error(`refused: ${result.reason}`);
      return result;
    },
    upgrade(capability: string, overrides: Partial<TerminalUpgrade> = {}): TerminalUpgrade {
      return { interfaceVersion: 1, computerId: CMP, owner: OWNER, capability, ...overrides };
    },
    async connect(capability: string, overrides: Partial<TerminalUpgrade> = {}) {
      return h.bridge.connect(h.upgrade(capability, overrides));
    },
  };
  h.build();
  return h;
}

function browserOf(response: Response): FakeSocket {
  if (!(response instanceof UpgradeResponse)) throw new Error(`refused: ${response.status}`);
  return response.client;
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("terminal windows and capabilities", () => {
  it("opens a window, tells the controller, and stores only the capability's hash", async () => {
    const h = harness();
    const opened = await h.open();
    expect(opened).toMatchObject({ action: "open_terminal", window: 1, generation: 3 });
    expect(Date.parse(opened.until) - h.now).toBe(30 * 60_000);
    expect(Date.parse(opened.presentBy) - h.now).toBe(60_000);
    expect(h.windows).toEqual([h.now + 30 * 60_000]);
    const stored = JSON.stringify([...h.store.data.values()]);
    expect(stored).not.toContain(opened.capability);
    expect(h.bridge.view()).toMatchObject({ window: 1, open: true, generation: 3, streams: 0 });
  });

  it("refuses to open while the computer cannot have a terminal", async () => {
    const h = harness();
    for (const reason of ["not_running", "busy", "not_offered"] as const) {
      h.target = { ok: false, reason };
      expect(await h.bridge.open({ operationId: OP(1), owner: OWNER, window: null })).toEqual({
        action: "open_terminal",
        outcome: "refused",
        reason,
      });
    }
    expect(h.windows).toEqual([]);
  });

  it("bridges one stream per capability and refuses a replay or a second concurrent use", async () => {
    const h = harness();
    const { capability } = await h.open();
    const [first, second] = await Promise.all([h.connect(capability), h.connect(capability)]);
    const statuses = [first, second].map((r) => (r instanceof UpgradeResponse ? 101 : r.status));
    expect(statuses.sort()).toEqual([101, 403]);
    expect((await h.connect(capability)).status).toBe(403);
    expect(h.ttyd.dials).toBe(1);
    expect(
      h.logs.filter((l) => l.event === "terminal_upgrade_refused").map((l) => l.fields.reason),
    ).toEqual(["used", "used"]);
  });

  it.each([
    ["another owner", { owner: { ...OWNER, sub: "someone-else" } }, "wrong_owner"],
    ["another session", { owner: { ...OWNER, sessionId: "cd".repeat(32) } }, "wrong_session"],
    [
      "another computer",
      { computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" as ComputerId },
      "wrong_computer",
    ],
  ] as const)(
    "refuses a capability presented by %s, and spends it",
    async (_name, overrides, reason) => {
      const h = harness();
      const { capability } = await h.open();
      expect((await h.connect(capability, overrides)).status).toBe(403);
      expect(h.logs.at(-1)?.fields.reason).toBe(reason);
      expect((await h.connect(capability)).status).toBe(403);
      expect(h.ttyd.dials).toBe(0);
    },
  );

  it("refuses an unknown capability and one presented too late", async () => {
    const h = harness();
    expect((await h.connect("A".repeat(43))).status).toBe(403);
    const { capability } = await h.open();
    h.now += 61_000;
    expect((await h.connect(capability)).status).toBe(403);
    expect(h.logs.at(-1)?.fields.reason).toBe("not_presented_in_time");
  });

  it("refuses an upgrade under an older window, and ends the older window's streams", async () => {
    const h = harness();
    const one = await h.open(OP(1));
    const spare = await h.open(OP(1), one.window);
    const browser = browserOf(await h.connect(one.capability));
    const two = await h.open(OP(2));
    expect(two.window).toBe(2);
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
    expect(h.ttyd.shells[0]?.closed).not.toBeNull();
    expect((await h.connect(spare.capability)).status).toBe(403);
    expect(h.logs.at(-1)?.fields.reason).toBe("unknown_capability");
  });

  it("issues a fresh capability for the open window only (reconnect)", async () => {
    const h = harness();
    const one = await h.open(OP(1));
    const again = await h.bridge.open({ operationId: OP(2), owner: OWNER, window: one.window });
    expect(again).toMatchObject({ outcome: "accepted", window: 1 });
    expect(
      await h.bridge.open({ operationId: OP(3), owner: OWNER, window: one.window + 1 }),
    ).toMatchObject({ outcome: "refused", reason: "window_closed" });
    h.target = { ok: true, generation: 4 };
    expect(
      await h.bridge.open({ operationId: OP(4), owner: OWNER, window: one.window }),
    ).toMatchObject({ outcome: "refused", reason: "window_closed" });
  });

  it("reconnects only the Access session that opened the window", async () => {
    const h = harness();
    const one = await h.open(OP(1));
    const other = { ...OWNER, sessionId: "cd".repeat(32) };
    expect(
      await h.bridge.open({ operationId: OP(2), owner: other, window: one.window }),
    ).toMatchObject({ outcome: "refused", reason: "window_closed" });
    expect(
      await h.bridge.open({ operationId: OP(3), owner: OWNER, window: one.window }),
    ).toMatchObject({ outcome: "accepted" });
  });

  it("opens no second window for a repeated operation ID, and re-asserts the open one", async () => {
    const h = harness();
    const first = await h.open(OP(7));
    const repeat = await h.open(OP(7));
    expect(repeat.window).toBe(first.window);
    expect(repeat.capability).not.toBe(first.capability);
    expect(h.windows).toEqual([Date.parse(first.until), Date.parse(first.until)]);
    await h.bridge.close("test");
    expect(await h.bridge.open({ operationId: OP(7), owner: OWNER, window: null })).toMatchObject({
      outcome: "refused",
      reason: "window_closed",
    });
  });

  it("keeps at most 64 capabilities, dropping expired and oldest ones", async () => {
    const h = harness();
    const first = await h.open(OP(1));
    for (let i = 0; i < 80; i += 1) {
      h.now += 10;
      await h.open(OP(1), first.window);
    }
    expect(h.store.keys("terminal/cap/").length).toBeLessThanOrEqual(64);
    expect((await h.connect(first.capability)).status).toBe(403);
  });
});

describe("bridged streams", () => {
  it("passes binary frames both ways unchanged, and never logs them", async () => {
    const h = harness();
    const { capability } = await h.open();
    const browser = browserOf(await h.connect(capability));
    const shell = h.ttyd.shell;
    expect(browser.peer?.binaryType).toBe("arraybuffer");
    const input = new Uint8Array([0x30, 0, 255, 0x7f, 0x80]).buffer;
    browser.send(input);
    expect(shell.received).toEqual([input]);
    shell.send(bytes("0sign-in-code-canary-7351"));
    expect(new TextDecoder().decode(browser.received[0] as ArrayBuffer)).toBe(
      "0sign-in-code-canary-7351",
    );
    browser.send("text frame");
    expect(shell.received.at(-1)).toBe("text frame");
    browser.peer?.emit("message", { data: { notData: true } });
    expect(shell.received).toHaveLength(2);
    expect(JSON.stringify(h.logs)).not.toContain("canary");
    expect(JSON.stringify(h.logs)).not.toContain(capability);
  });

  it("closes the browser with 4002 when the computer's side ends", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    h.ttyd.shell.close(1000, "shell exited");
    expect(browser.closed?.code).toBe(CLOSED_BY_COMPUTER);
    expect(h.bridge.sessions).toBe(0);
  });

  it("ends a stream whose send fails", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    const bridgeEnd = h.ttyd.shell.peer as FakeSocket;
    bridgeEnd.failSends = true;
    browser.send("x");
    expect(h.bridge.sessions).toBe(0);
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
  });

  it("retries a dial ttyd refused, and gives up after its retries", async () => {
    const h = harness();
    h.ttyd.busy = 2;
    expect(browserOf(await h.connect((await h.open(OP(1))).capability))).toBeInstanceOf(FakeSocket);
    expect(h.ttyd.dials).toBe(3);
    const fresh = harness();
    fresh.ttyd.busy = 10;
    expect((await fresh.connect((await fresh.open()).capability)).status).toBe(403);
    expect(fresh.logs.at(-1)?.fields.reason).toBe("dial_failed");
    const failing = harness();
    failing.ttyd.fail = true;
    expect((await failing.connect((await failing.open()).capability)).status).toBe(403);
  });

  it("refuses a stream whose window closed while ttyd answered", async () => {
    const h = harness();
    const { capability } = await h.open();
    const dial = h.ttyd.dial;
    h.ttyd.dial = async () => {
      const answer = await dial();
      await h.bridge.close("closed meanwhile");
      return answer;
    };
    const bridge = h.build();
    expect((await bridge.connect(h.upgrade(capability))).status).toBe(403);
    expect(h.ttyd.shell.closed).not.toBeNull();
  });
});

describe("streams end (RC-24)", () => {
  it("at the window's deadline, through the periodic check", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    await h.advance(15_000);
    expect(browser.closed).toBeNull();
    await h.advance(30 * 60_000);
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
    expect(h.windows.at(-1)).toBeNull();
    expect(h.bridge.view().open).toBe(false);
  });

  it("when the computer is removed or no longer running", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    h.target = { ok: false, reason: "not_offered" };
    await h.bridge.enforce();
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
    expect(h.ttyd.shell.closed).not.toBeNull();
  });

  it("when the computer's generation changes, and its capabilities stop working", async () => {
    const h = harness();
    const opened = await h.open();
    const spare = await h.open(OP(1), opened.window);
    const browser = browserOf(await h.connect(opened.capability));
    h.target = { ok: true, generation: 4 };
    expect((await h.connect(spare.capability)).status).toBe(403);
    expect(h.logs.at(-1)?.fields.reason).toBe("generation_changed");
    await h.bridge.enforce();
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
  });

  it("before a credential-sensitive step: close() ends everything first", async () => {
    const h = harness();
    const opened = await h.open();
    const spare = await h.open(OP(1), opened.window);
    const browser = browserOf(await h.connect(opened.capability));
    expect(await h.bridge.close("a sign-out started")).toBe(true);
    expect(browser.closed?.code).toBe(CLOSED_BY_PLATFORM);
    expect(browser.closed?.reason).toContain("a sign-out started");
    expect(h.windows.at(-1)).toBeNull();
    expect((await h.connect(spare.capability)).status).toBe(403);
    expect(await h.bridge.close("again")).toBe(false);
  });

  it("enforce never throws when the computer cannot be asked, and keeps the stream", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    h.targetFails = true;
    await expect(h.bridge.enforce()).resolves.toBeUndefined();
    expect(browser.closed).toBeNull();
  });

  it("after a Durable Object restart: the window survives, spent capabilities stay spent", async () => {
    const h = harness();
    const opened = await h.open();
    browserOf(await h.connect(opened.capability));
    // The runtime drops every socket with the instance; a new instance reads the same storage.
    const restarted = h.build();
    expect(restarted.view()).toMatchObject({ window: 1, open: true, streams: 0 });
    expect((await h.connect(opened.capability)).status).toBe(403);
    const fresh = await restarted.open({ operationId: OP(9), owner: OWNER, window: 1 });
    expect(fresh.outcome).toBe("accepted");
    if (fresh.outcome === "accepted") {
      expect(browserOf(await h.connect(fresh.capability))).toBeInstanceOf(FakeSocket);
    }
  });
});

describe("reattach after a dropped browser stream (FH-38)", () => {
  it("keeps the shell, buffers its output, and reattaches with a fresh capability", async () => {
    const h = harness();
    const opened = await h.open();
    const browser = browserOf(await h.connect(opened.capability));
    const shell = h.ttyd.shell;
    browser.drop();
    expect(shell.closed).toBeNull();
    shell.send(bytes("0while away"));
    shell.send(new Uint8Array([0x30, 0x21]));
    shell.send("0text");
    const fresh = await h.bridge.open({ operationId: OP(2), owner: OWNER, window: opened.window });
    if (fresh.outcome !== "accepted") throw new Error("refused");
    const again = browserOf(await h.connect(fresh.capability));
    expect(h.ttyd.dials).toBe(1);
    expect(again.received).toHaveLength(3);
    expect(new TextDecoder().decode(again.received[0] as ArrayBuffer)).toBe("0while away");
    again.send("1");
    expect(shell.received.at(-1)).toBe("1");
    expect(h.logs.map((l) => l.event)).toContain("terminal_reattached");
  });

  it("ends the shell when no reconnect comes within the grace time", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    browser.drop();
    await h.advance(30_000);
    expect(h.ttyd.shell.closed).not.toBeNull();
    expect(h.bridge.sessions).toBe(0);
  });

  it("ends the shell when too much output waits", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    browser.drop();
    h.ttyd.shell.send(new Uint8Array(1 << 20).buffer);
    expect(h.bridge.sessions).toBe(1);
    h.ttyd.shell.send(new Uint8Array(1).buffer);
    expect(h.bridge.sessions).toBe(0);
  });

  it("ends the shell at once when the window is already closed", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    h.now += 31 * 60_000;
    browser.drop();
    expect(h.ttyd.shell.closed).not.toBeNull();
  });
});

describe("bridge edges", () => {
  it("counts attached streams in its view", async () => {
    const h = harness();
    browserOf(await h.connect((await h.open()).capability));
    expect(h.bridge.view()).toMatchObject({ streams: 1 });
  });

  it("ends a stream on a computer-side error, and only once", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    const bridgeEnd = h.ttyd.shell.peer as FakeSocket;
    bridgeEnd.emit("error", {});
    bridgeEnd.emit("close", {});
    expect(browser.closed?.code).toBe(CLOSED_BY_COMPUTER);
    expect(h.logs.filter((l) => l.event === "terminal_stream_ended")).toHaveLength(1);
  });

  it("ignores frames after a stream ended, and frames it cannot send", async () => {
    const h = harness();
    const browser = browserOf(await h.connect((await h.open()).capability));
    const bridgeEnd = h.ttyd.shell.peer as FakeSocket;
    const browserEnd = browser.peer as FakeSocket;
    bridgeEnd.emit("message", { data: { notData: true } });
    expect(browser.received).toEqual([]);
    browserEnd.emit("error", {});
    browserEnd.emit("close", {});
    await h.bridge.close("done");
    bridgeEnd.emit("message", { data: "late" });
    browserEnd.emit("message", { data: "late" });
    expect(h.ttyd.shell.received).toEqual([]);
  });

  it("refuses a capability whose window was closed behind its back", async () => {
    const h = harness();
    const { capability } = await h.open();
    const w = h.store.get("terminal/window") as Record<string, unknown>;
    h.store.put("terminal/window", { ...w, open: false });
    expect((await h.connect(capability)).status).toBe(403);
    expect(h.logs.at(-1)?.fields.reason).toBe("window_closed");
  });

  it("refuses a capability when the computer cannot have a terminal any more", async () => {
    const h = harness();
    const { capability } = await h.open();
    h.target = { ok: false, reason: "busy" };
    expect((await h.connect(capability)).status).toBe(403);
    expect(h.logs.at(-1)?.fields.reason).toBe("not_available");
  });

  it("drops unreadable stored records while pruning", async () => {
    const h = harness();
    const first = await h.open(OP(1));
    for (let i = 0; i < 70; i += 1) h.store.put(`terminal/cap/junk${i}`, { nonsense: true });
    for (let i = 0; i < 70; i += 1) h.store.put(`terminal/op/junk${i}`, "nonsense");
    await h.open(OP(1), first.window);
    await h.open(OP(2));
    expect(h.store.keys("terminal/cap/").filter((k) => k.includes("junk"))).toEqual([]);
    expect(h.store.keys("terminal/op/").length).toBeLessThanOrEqual(64);
  });
});
