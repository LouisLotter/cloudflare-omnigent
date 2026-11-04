// The setup page's wake (WP3.53, `pages/client/setup-client.js`): the sequence that wakes an
// asleep computer through Omnigent's `POST /v1/hosts/{id}/start`, polls until the platform says
// it runs, and gives up after 5 minutes, with every failure named. The script is the one the page
// serves, run in a fresh context without a page, so only its wake sequence is defined; the page's
// wiring (the auto-start of the sign-in or the terminal) is driven in a real browser by the local
// journeys (`test/e2e/journeys.ts`, J14).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/pages/client/setup-client.js"),
  "utf8",
);
const HOST_URL = "/v1/hosts/7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";

type Outcome = { ok: true } | { ok: false; reason: string; detail?: string | null };
interface HostStatus {
  readonly state: string;
  readonly failure?: unknown;
}
interface Deps {
  startHost(hostUrl: string): Promise<number>;
  readRunning(): Promise<boolean | null>;
  readHost(hostUrl: string): Promise<HostStatus | null>;
  wait(ms: number): Promise<void>;
  now(): number;
}
type CreateWake = (deps: Deps) => (hostUrl: string) => Promise<Outcome>;

/** The script in a fresh context with no page: what it defines on the global object. */
function load(): { createWake: CreateWake; defined: string[] } {
  const context: Record<string, unknown> = { document: { getElementById: () => null } };
  const before = new Set(Object.keys(context));
  runInNewContext(SOURCE, context);
  return {
    createWake: context.cfoWake as CreateWake,
    defined: Object.keys(context).filter((k) => !before.has(k)),
  };
}

/** A scripted Omnigent and platform, on a clock that moves only when the sequence waits. */
function world(opts: {
  start?: () => Promise<number>;
  running?: (tick: number) => boolean | null | Error;
  host?: (tick: number) => HostStatus | null | Error;
}) {
  let clock = 1_000_000;
  let tick = 0;
  const calls = { start: [] as string[], running: 0, host: [] as string[], waits: [] as number[] };
  const deps: Deps = {
    startHost: async (hostUrl) => {
      calls.start.push(hostUrl);
      return opts.start ? opts.start() : 202;
    },
    readRunning: async () => {
      calls.running += 1;
      const value = opts.running ? opts.running(tick) : false;
      if (value instanceof Error) throw value;
      return value;
    },
    readHost: async (hostUrl) => {
      calls.host.push(hostUrl);
      const value = opts.host ? opts.host(tick) : { state: "waking" };
      if (value instanceof Error) throw value;
      return value;
    },
    wait: async (ms) => {
      calls.waits.push(ms);
      clock += ms;
      tick += 1;
    },
    now: () => clock,
  };
  return { deps, calls, elapsed: () => clock - 1_000_000 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the setup page's script exports only the wake", () => {
  it("defines `cfoWake` and nothing else on the global object; the wake holds no page state", () => {
    const { createWake, defined } = load();
    expect(defined).toEqual(["cfoWake"]);
    expect(typeof createWake).toBe("function");
    const wake = createWake(world({}).deps);
    expect(typeof wake).toBe("function");
    expect(Object.keys(wake)).toEqual([]);
    // The page's own wake is made inside the page's closure: no other global is assigned.
    expect([...SOURCE.matchAll(/globalThis\.(\w+)\s*=/g)].map((m) => m[1])).toEqual(["cfoWake"]);
    expect(SOURCE).not.toMatch(/sessionStorage|localStorage|indexedDB|document\.cookie/);
  });
});

describe("the wake: Omnigent's call, then the platform's state", () => {
  it("calls Omnigent once, polls every 2 s while it wakes, and resolves once the computer runs", async () => {
    const { createWake } = load();
    const w = world({ running: (tick) => tick >= 3 });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: true });
    expect(w.calls.start).toEqual([HOST_URL]);
    expect(w.calls.running).toBe(4);
    expect(w.calls.host).toEqual([HOST_URL, HOST_URL, HOST_URL]);
    expect(w.calls.waits).toEqual([2000, 2000, 2000]);
  });

  it("goes on at once when the computer already runs", async () => {
    const { createWake } = load();
    const w = world({ running: () => true });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: true });
    expect([w.calls.running, w.calls.host.length, w.calls.waits.length]).toEqual([1, 0, 0]);
  });

  it("asks again when a read fails, never taking it as a refusal", async () => {
    const { createWake } = load();
    const w = world({
      running: (tick) => (tick === 0 ? new Error("network") : tick === 1 ? null : tick >= 3),
      host: (tick) => (tick === 0 ? new Error("network") : tick === 1 ? null : { state: "awake" }),
    });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: true });
    expect(w.calls.running).toBe(4);
  });

  it.each([
    [401, "signed_out"],
    [403, "refused"],
    [404, "unknown"],
    [400, "unavailable"],
    [409, "unavailable"],
    [429, "unavailable"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
    [0, "unavailable"],
    [302, "unavailable"],
  ])("names Omnigent's answer %i as %s, and polls nothing after it", async (status, reason) => {
    const { createWake } = load();
    const w = world({ start: async () => status });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: false, reason });
    expect([w.calls.running, w.calls.host.length, w.calls.waits.length]).toEqual([0, 0, 0]);
  });

  it("names an unreachable Omnigent as unavailable", async () => {
    const { createWake } = load();
    const w = world({ start: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: false, reason: "unavailable" });
    expect(w.calls.running).toBe(0);
  });

  it("accepts any 2xx from Omnigent (it answers 202 while it wakes)", async () => {
    const { createWake } = load();
    for (const status of [200, 202]) {
      const w = world({ start: async () => status, running: () => true });
      expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: true });
    }
  });
});

describe("the wake's failures", () => {
  it("passes Omnigent's reason on as it is, for the page to show as text", async () => {
    const { createWake } = load();
    const failure =
      "Work computer could not wake: All computers are busy: the installation's limit of awake computers is reached.";
    const w = world({
      host: (tick) => (tick < 2 ? { state: "waking" } : { state: "failed", failure }),
    });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({
      ok: false,
      reason: "failed",
      detail: failure,
    });
    expect(w.calls.waits).toEqual([2000, 2000]);
  });

  it("cuts a long reason, and has none when Omnigent gives none", async () => {
    const { createWake } = load();
    const long = world({ host: () => ({ state: "failed", failure: "x".repeat(2000) }) });
    const cut = await createWake(long.deps)(HOST_URL);
    expect(cut.ok === false && cut.detail?.length).toBe(500);
    for (const failure of [undefined, null, 42, { html: "<b>" }]) {
      const w = world({ host: () => ({ state: "failed", failure }) });
      expect(await createWake(w.deps)(HOST_URL)).toEqual({
        ok: false,
        reason: "failed",
        detail: null,
      });
    }
  });

  it("names a computer asleep again without a reason as not woken", async () => {
    const { createWake } = load();
    const w = world({ host: (tick) => (tick < 1 ? { state: "waking" } : { state: "asleep" }) });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: false, reason: "not_woken" });
  });

  it("keeps waiting while Omnigent reports waking, awake or going to sleep", async () => {
    const { createWake } = load();
    const states = ["waking", "sleeping", "awake", "waking", "mystery"];
    const w = world({
      host: (tick) => ({ state: states[tick] ?? "waking" }),
      running: (tick) => tick >= 5,
    });
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: true });
  });

  it("gives up after 5 minutes, and polls nothing after it", async () => {
    const { createWake } = load();
    const w = world({});
    expect(await createWake(w.deps)(HOST_URL)).toEqual({ ok: false, reason: "timeout" });
    expect(w.elapsed()).toBe(300_000);
    expect(w.calls.waits.every((ms) => ms <= 2000)).toBe(true);
    const reads = [w.calls.running, w.calls.host.length];
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([w.calls.running, w.calls.host.length]).toEqual(reads);
  });

  it("leaves no timer running after the give-up, on real timers", async () => {
    vi.useFakeTimers();
    const { createWake } = load();
    let reads = 0;
    const wake = createWake({
      startHost: async () => 202,
      readRunning: async () => {
        reads += 1;
        return false;
      },
      readHost: async () => ({ state: "waking" }),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
    });
    let outcome: Outcome | null = null;
    void wake(HOST_URL).then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(299_000);
    expect(outcome).toBeNull();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
    const after = reads;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(after);
  });
});

describe("one wake for the whole page", () => {
  it("shares a wake in flight between every button, then starts a new one for a retry", async () => {
    const { createWake } = load();
    let release: (status: number) => void = () => undefined;
    let starts = 0;
    const w = world({
      start: () => {
        starts += 1;
        return starts === 1
          ? new Promise<number>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(202);
      },
      running: () => true,
    });
    const wake = createWake(w.deps);
    const claude = wake(HOST_URL);
    const codex = wake(HOST_URL);
    const terminal = wake(HOST_URL);
    expect(starts).toBe(1);
    release(429);
    const outcomes = await Promise.all([claude, codex, terminal]);
    expect(outcomes).toEqual([
      { ok: false, reason: "unavailable" },
      { ok: false, reason: "unavailable" },
      { ok: false, reason: "unavailable" },
    ]);
    // Ended: the next press is a new wake.
    expect(await wake(HOST_URL)).toEqual({ ok: true });
    expect(starts).toBe(2);
  });
});
