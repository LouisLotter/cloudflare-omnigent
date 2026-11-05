// The setup page's wake wiring (WP3.53, Codex r1-1 and r1-2): the served script, run in a fresh
// context against a synthetic DOM (`support/fake-dom.ts`) built from the page the real router
// renders, with the router answering the page's own reads and POSTs and a scripted Omnigent.
// Fake timers drive the polls, the page's 5 s refresh and every read's 10 s bound.
//
// What it holds the continuations to: once the computer runs, the sign-in or the terminal goes on
// with the generation and intent the wake's last read found, whatever the reads after it do (fail,
// hang, or an older read answer late); a read that hangs never holds a button past the wake's
// bounded end; several buttons pressed during one wake share it and each goes on.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type {
  ComputerId,
  ComputerPageState,
  PageFrontCall,
  PageFrontResult,
  PageOwner,
  PageReadCall,
  PageReadResult,
  PagesCall,
  PagesResult,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import type { PagesBackend, StateResult } from "../../src/pages/backend.ts";
import { routePlatform } from "../../src/pages/router.ts";
import { platformError } from "../../src/shared/errors.ts";
import { FakeDocument, FakeElement } from "../support/fake-dom.ts";
import { NEVER_SIGNED_IN, NOW, PAGE_CMP, pageState } from "../support/page-states.ts";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/pages/client/setup-client.js"),
  "utf8",
);
const ORIGIN = "https://omnigent.example.test";
const PAGE = `/platform/computers/${PAGE_CMP}`;
const HOST_PATH = "/v1/hosts/7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const OLD_INTENT = "a1".repeat(32);
const NEW_INTENT = "b2".repeat(32);
const OWNER: PageOwner = {
  sub: "owner-sub-canary",
  sessionId: "ab".repeat(32),
  person: { kind: "installation_owner" },
};

const asleep = (): ComputerPageState =>
  pageState({
    lifecycle: "asleep",
    status: "stopped",
    generation: 1,
    setupCards: [...NEVER_SIGNED_IN],
  });
const running = (): ComputerPageState =>
  pageState({ generation: 2, setupCards: [...NEVER_SIGNED_IN] });

/** WorkspaceDO's page front, as the router reaches it: one computer, its intent, its answers. */
class Backend implements PagesBackend {
  computer = asleep();
  intent = OLD_INTENT;
  readonly acts: (PagesCall | PageFrontCall)[] = [];
  async computers() {
    return [{ computerId: PAGE_CMP as ComputerId, name: "managed-7f3c2a9e" }];
  }
  async state(_id: ComputerId, _owner: PageOwner): Promise<StateResult> {
    return { action: "state", computer: this.computer, intentToken: this.intent } as StateResult;
  }
  async act(_id: ComputerId, call: PagesCall | PageFrontCall) {
    this.acts.push(call);
    if (call.action === "sign_in_start") {
      return {
        action: "sign_in_start",
        outcome: "accepted",
        view: { service: call.service, attempt: 1, state: "starting" },
      } as unknown as PageFrontResult;
    }
    if (call.action === "open_terminal") {
      return {
        action: "open_terminal",
        outcome: "refused",
        reason: "busy",
      } as unknown as PagesResult;
    }
    throw platformError("unavailable", "not in this test");
  }
  async read(_id: ComputerId, _call: PageReadCall): Promise<PageReadResult> {
    throw platformError("unavailable", "not in this test");
  }
  async upgrade() {
    return new Response(null, { status: 403 });
  }
  async outages() {
    return [];
  }
  async replication() {
    return null;
  }
}

function platform(backend: Backend, request: Request): Promise<Response> {
  const admitted: Admitted = {
    ok: true,
    request,
    origin: ORIGIN,
    identity: { sub: OWNER.sub, sessionId: OWNER.sessionId, issuedAt: 1, expiresAt: 2 },
  };
  return routePlatform(admitted, {} as WebEnv, {
    backend,
    assets: async () => ({}),
    now: () => NOW,
    log: () => undefined,
  });
}

type Reply = Response | "hang" | Promise<Response>;

/** The page, its script, and the network it talks to. */
async function boot(computer?: ComputerPageState) {
  const backend = new Backend();
  if (computer !== undefined) backend.computer = computer;
  const html = await (await platform(backend, new Request(`${ORIGIN}${PAGE}`))).text();
  const document = new FakeDocument(html);
  const calls: { method: string; path: string }[] = [];
  const world = {
    backend,
    document,
    calls,
    /** Omnigent's `persistent_status.state` for the host. */
    hostState: "waking",
    /** Omnigent's answer to `POST …/start`. */
    startStatus: 202,
    /** Overrides the platform's answer to the page's state reads; undefined: the router's. */
    stateReply: undefined as undefined | ((n: number) => Reply | undefined),
    stateReads: 0,
  };
  const fetch = (
    input: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {},
  ) => {
    const url = new URL(input, ORIGIN);
    const method = init.method ?? "GET";
    calls.push({ method, path: url.pathname });
    const reply = (): Reply => {
      if (url.pathname === `${HOST_PATH}/start`) {
        return Response.json(
          { persistent_status: { state: "waking" } },
          { status: world.startStatus },
        );
      }
      if (url.pathname === HOST_PATH) {
        return Response.json({ persistent_status: { state: world.hostState, failure: null } });
      }
      if (url.pathname === `${PAGE}/state`) {
        world.stateReads += 1;
        const override = world.stateReply?.(world.stateReads);
        if (override !== undefined) return override;
      }
      // A browser adds the page's own origin to its same-origin POSTs.
      const headers = { ...(init.headers ?? {}), ...(method === "POST" ? { origin: ORIGIN } : {}) };
      return platform(
        backend,
        new Request(url.href, {
          method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
        }),
      );
    };
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      const r = reply();
      if (r === "hang") return;
      Promise.resolve(r).then(resolve, reject);
    });
  };
  const context: Record<string, unknown> = {
    document,
    window: { addEventListener: () => undefined },
    location: { href: `${ORIGIN}${PAGE}`, protocol: "https:" },
    navigator: {},
    fetch,
    // Each read's bound, on the test's (fake) clock.
    AbortSignal: {
      timeout: (ms: number) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), ms);
        return controller.signal;
      },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    URL,
    TextEncoder,
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes.map((_b, i) => (i * 37 + 11) % 256) },
    Element: FakeElement,
    console,
  };
  runInNewContext(SOURCE, context);
  const el = (selector: string) => {
    const found = document.querySelector(selector);
    if (found === null) throw new Error(`no ${selector}`);
    return found;
  };
  return {
    ...world,
    world,
    el,
    press: (selector: string) => document.click(el(selector)),
    starts: () => calls.filter((c) => c.path === `${HOST_PATH}/start`).length,
    signInStarts: () => backend.acts.filter((a) => a.action === "sign_in_start"),
    opens: () => backend.acts.filter((a) => a.action === "open_terminal"),
  };
}

/** The computer runs from now on, in a new generation with a new intent. */
function wakeUp(page: Awaited<ReturnType<typeof boot>>) {
  page.backend.computer = running();
  page.backend.intent = NEW_INTENT;
  page.world.hostState = "awake";
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the setup page's wake, wired to the page (WP3.53, Codex r1)", () => {
  it("marks the page scripted, and offers the asleep computer's buttons for a wake", async () => {
    const page = await boot();
    expect(page.el("#computer-page").dataset.script).toBe("on");
    expect(page.el('[data-card="codex"] [data-act="start"]').hasAttribute("data-wake")).toBe(true);
    expect(page.el("#terminal-open").disabled).toBe(false);
  });

  it.each([
    ["fails", () => new Response("unavailable", { status: 503 }) as Reply],
    ["hangs", () => "hang" as Reply],
  ])(
    "r1-1, r1-2: starts with the wake's own generation and intent when every read after it %s",
    async (_how, after) => {
      const page = await boot();
      // The first read after the wake call finds it running; every read after that fails or hangs.
      page.world.stateReply = (n) => {
        if (n === 1) {
          wakeUp(page);
          return undefined;
        }
        return after();
      };
      page.press('[data-card="codex"] [data-act="start"]');
      await vi.advanceTimersByTimeAsync(0);
      expect(page.starts()).toBe(1);
      const starts = page.signInStarts();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        action: "sign_in_start",
        service: "codex",
        generation: 2,
        intent: NEW_INTENT,
      });
      expect(page.el("#computer-page").dataset.generation).toBe("2");
      expect(page.el('[data-sign-in="codex"]').textContent).toContain("Starting the sign-in");
      // The page's refreshes keep failing: nothing else starts.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(page.signInStarts()).toHaveLength(1);
    },
  );

  it("r1-1: an older read answering after the wake's last one never replaces its state", async () => {
    const page = await boot();
    let release: (r: Response) => void = () => undefined;
    let hold = false;
    page.world.stateReply = (n) => {
      if (!hold) return undefined;
      hold = false;
      // Answered from the asleep state it was sent in, but only once released.
      const late = platform(page.backend, new Request(`${ORIGIN}${PAGE}/state`)).then(
        (r) => new Promise<Response>((resolve) => (release = () => resolve(r))),
      );
      void n;
      return late;
    };
    page.press('[data-card="claude"] [data-act="start"]');
    // The wake polls at 0, 2 and 4 s; the page's own refresh at 5 s is held; at 6 s it runs.
    await vi.advanceTimersByTimeAsync(4_500);
    hold = true;
    await vi.advanceTimersByTimeAsync(1_000);
    wakeUp(page);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.signInStarts()).toHaveLength(1);
    expect(page.signInStarts()[0]).toMatchObject({ generation: 2, intent: NEW_INTENT });
    release(new Response());
    await vi.advanceTimersByTimeAsync(0);
    // The late asleep answer was not applied: the page keeps the new generation and intent.
    expect(page.el("#computer-page").dataset.generation).toBe("2");
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.opens()).toHaveLength(1);
    expect(page.opens()[0]).toMatchObject({ action: "open_terminal", intent: NEW_INTENT });
  });

  it("r1-2: reads that hang never hold the terminal: released at the wake's give-up, nothing opens later", async () => {
    const page = await boot();
    page.world.stateReply = () => "hang";
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.el("#terminal-open").disabled).toBe(true);
    expect(page.el("#terminal-status").textContent).toContain("Waking the computer");
    // Every read is abandoned after 10 s; the wake gives up at 5 minutes, plus one read.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10_000);
    expect(page.el("#terminal-open").disabled).toBe(false);
    expect(page.el("#terminal-status").textContent).toContain("did not wake within 5 minutes");
    // The page's refreshes go on, first hanging, then answering asleep: the button stays usable
    // and nothing opens.
    await vi.advanceTimersByTimeAsync(60_000);
    page.world.stateReply = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(page.el("#terminal-open").disabled).toBe(false);
    expect(page.opens()).toHaveLength(0);
    expect(page.starts()).toBe(1);
  });

  it("r1-2: every read after the wake's last one hangs: the terminal opens anyway, and its button is released", async () => {
    const page = await boot();
    page.world.stateReply = (n) => {
      if (n === 1) {
        wakeUp(page);
        return undefined;
      }
      return "hang";
    };
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.opens()).toHaveLength(1);
    expect(page.opens()[0]).toMatchObject({ intent: NEW_INTENT });
    expect(page.el("#terminal-open").disabled).toBe(false);
    // Past the wake's deadline, with the page's refreshes still hanging: still usable.
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(page.el("#terminal-open").disabled).toBe(false);
    expect(page.el("#terminal-status").textContent).toContain("stopping or signing out");
    expect(page.opens()).toHaveLength(1);
  });

  it("r1-2: a read that hangs once is abandoned, the next finds it running, and the terminal opens", async () => {
    const page = await boot();
    page.world.stateReply = (n) => {
      if (n === 1) return "hang";
      wakeUp(page);
      return undefined;
    };
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.opens()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.opens()).toHaveLength(1);
    expect(page.opens()[0]).toMatchObject({ intent: NEW_INTENT });
    // The terminal's own answer (busy here) is shown, and its button is usable again.
    expect(page.el("#terminal-status").textContent).toContain("stopping or signing out");
    expect(page.el("#terminal-open").disabled).toBe(false);
  });

  it("shares one wake between the cards and the terminal, and each goes on with the wake's state", async () => {
    const page = await boot();
    page.press('[data-card="codex"] [data-act="start"]');
    page.press('[data-card="claude"] [data-act="start"]');
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.starts()).toBe(1);
    for (const service of ["codex", "claude"]) {
      expect(page.el(`[data-sign-in="${service}"]`).textContent).toContain("Waking the computer");
    }
    expect(page.signInStarts()).toHaveLength(0);
    wakeUp(page);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.starts()).toBe(1);
    const starts = page.signInStarts();
    expect(starts.map((s) => (s as { service: string }).service).sort()).toEqual([
      "claude",
      "codex",
    ]);
    for (const s of starts) expect(s).toMatchObject({ generation: 2, intent: NEW_INTENT });
    expect(page.opens()).toHaveLength(1);
    expect(page.opens()[0]).toMatchObject({ intent: NEW_INTENT });
  });

  it("a refused wake puts each button back with what went wrong, and it outlives the refresh", async () => {
    const page = await boot();
    page.world.startStatus = 403;
    page.press('[data-card="codex"] [data-act="start"]');
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    const message = () => page.el('[data-sign-in="codex"] [data-sign-in-message]').textContent;
    expect(message()).toContain("Omnigent did not wake the computer for the account");
    expect(page.el('[data-card="codex"] [data-act="start"]').disabled).toBe(false);
    expect(page.el("#terminal-status").textContent).toContain("Omnigent did not wake the computer");
    expect(page.el("#terminal-open").disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(message()).toContain("Omnigent did not wake the computer for the account");
    expect(page.signInStarts()).toHaveLength(0);
    expect(page.opens()).toHaveLength(0);
  });
});

// WP8.15 (D62): an owner or administrator helping someone else wakes their computer through
// Omnigent as its owner does. Until Omnigent lets an administrator wake it, the refusal says so in
// an administrator's words.
describe("an administrator's wake, on someone else's computer (WP8.15)", () => {
  const alices = (state: ComputerPageState): ComputerPageState => ({
    ...state,
    access: "admin",
    ownerName: "alice",
    ownerMemberId: "0a1b2c3d4e5f40718293a4b5c6d7e8f9",
  });

  it("offers no sign-in, and says a refused wake in an administrator's words", async () => {
    const page = await boot(alices(asleep()));
    expect(page.document.querySelector('[data-act="start"]')).toBeNull();
    page.world.startStatus = 403;
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.el("#terminal-status").textContent).toBe(
      "Omnigent did not let your account wake this computer. alice can wake it by starting a thread on it.",
    );
    expect(page.el("#terminal-open").disabled).toBe(false);
    expect(page.opens()).toHaveLength(0);
  });

  it("wakes it through Omnigent once Omnigent allows it, then opens the terminal", async () => {
    const page = await boot(alices(asleep()));
    page.press("#terminal-open");
    await vi.advanceTimersByTimeAsync(0);
    expect(page.starts()).toBe(1);
    page.backend.computer = alices(running());
    page.backend.intent = NEW_INTENT;
    page.world.hostState = "awake";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(page.opens()).toHaveLength(1);
    expect(page.opens()[0]).toMatchObject({ action: "open_terminal", intent: NEW_INTENT });
  });
});
