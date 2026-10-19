// IR-017: the S1 campaign controls. These tests drive the Worker's real public `fetch` handler
// and the real Durable Object classes from src/index.js, with in-memory storage and recording
// stubs in place of Cloudflare bindings. Every refused request must have zero effect: no call
// into the experiment's Durable Objects, no arming, and no use of the request-intent token.

import { describe, expect, it, vi } from "vitest";
import * as s1 from "../src/index.js";

const worker = s1.default;
const ORIGIN = "https://cfo-stg-s1-life.staging.example";
const EVIL = "https://attacker.example";

function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort());
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

function fakeState(extra = {}) {
  return {
    storage: memoryStorage(),
    blockConcurrencyWhile: async (fn) => fn(),
    waitUntil() {},
    ...extra,
  };
}

/** A stub whose every method call is recorded and resolves to a harmless value. */
function recorder(answers = {}) {
  const calls = [];
  const stub = new Proxy(
    {},
    {
      get: (_, name) => {
        if (name === "then") return undefined;
        return (...args) => {
          calls.push({ name, args });
          const answer = answers[name];
          return Promise.resolve(
            typeof answer === "function" ? answer(...args) : (answer ?? { ok: true }),
          );
        };
      },
    },
  );
  return { calls, stub };
}

function namespace(make) {
  const instances = new Map();
  return {
    idFromName: (name) => name,
    get(id) {
      if (!instances.has(id)) instances.set(id, make(id));
      return instances.get(id);
    },
    instances,
  };
}

/** The Worker's bindings: recording stubs for the experiment, the real S1Control. */
function setup() {
  // The fake S1Computer answers kickoff as the real one does: with the arming it stored.
  const computer = recorder({ kickoff: ({ armedUntil }) => ({ armedUntil }) });
  const server = recorder();
  const env = { S1_VERSION: "1", S1_ARM_HOURS: "6" };
  env.COMPUTER = namespace(() => computer.stub);
  env.SERVER = namespace(() => server.stub);
  let control = null;
  env.CONTROL = namespace(() => {
    control = s1.S1Control ? new s1.S1Control(fakeState(), env) : recorder().stub;
    return control;
  });
  return { env, computer, server, control: () => control };
}

const get = (path, headers = {}) => new Request(`${ORIGIN}${path}`, { method: "GET", headers });

function post(path, { origin, site, token, contentType } = {}) {
  const headers = { "content-type": contentType ?? "application/x-www-form-urlencoded" };
  if (origin !== undefined) headers.origin = origin;
  if (site !== undefined) headers["sec-fetch-site"] = site;
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: token === undefined ? "" : `intent=${encodeURIComponent(token)}`,
  });
}

/** Opens the confirmation page as the owner's browser would and reads its intent token. */
async function confirmationToken(env, path) {
  const response = await worker.fetch(get(path, { "sec-fetch-site": "none" }), env);
  expect(response.status).toBe(200);
  const html = await response.text();
  const match = html.match(/name="intent" value="([0-9a-f]{64})"/);
  expect(match, "the confirmation page embeds a request-intent token").not.toBeNull();
  return match?.[1];
}

function storageSnapshot(control) {
  return control?.ctx?.storage?.map ? JSON.stringify([...control.ctx.storage.map]) : null;
}

/** Asserts that nothing reached the experiment's Durable Objects. */
function expectNoExperimentEffect(t) {
  expect(t.computer.calls, "no call into S1Computer").toEqual([]);
  expect(t.server.calls, "no call into S1Server").toEqual([]);
}

describe("IR-017: refused requests have zero effect", () => {
  for (const path of ["/s1/kickoff", "/s1/stop"]) {
    describe(path, () => {
      it("refuses a foreign Origin with 403, and the token stays unused", async () => {
        const t = setup();
        const token = await confirmationToken(t.env, path);
        const before = storageSnapshot(t.control());
        const response = await worker.fetch(post(path, { origin: EVIL, token }), t.env);
        expect(response.status).toBe(403);
        expectNoExperimentEffect(t);
        expect(storageSnapshot(t.control())).toBe(before);
      });

      it("refuses Origin: null with 403", async () => {
        const t = setup();
        const token = await confirmationToken(t.env, path);
        const before = storageSnapshot(t.control());
        const response = await worker.fetch(post(path, { origin: "null", token }), t.env);
        expect(response.status).toBe(403);
        expectNoExperimentEffect(t);
        expect(storageSnapshot(t.control())).toBe(before);
      });

      it("refuses a missing Origin with 403", async () => {
        const t = setup();
        const token = await confirmationToken(t.env, path);
        const before = storageSnapshot(t.control());
        const response = await worker.fetch(post(path, { token }), t.env);
        expect(response.status).toBe(403);
        expectNoExperimentEffect(t);
        expect(storageSnapshot(t.control())).toBe(before);
      });

      it("refuses a simple cross-site form post with 403", async () => {
        const t = setup();
        const response = await worker.fetch(
          post(path, { origin: EVIL, site: "cross-site", token: "0".repeat(64) }),
          t.env,
        );
        expect(response.status).toBe(403);
        expectNoExperimentEffect(t);
      });

      it("refuses a same-origin Origin header when Sec-Fetch-Site says otherwise", async () => {
        const t = setup();
        const token = await confirmationToken(t.env, path);
        const before = storageSnapshot(t.control());
        const response = await worker.fetch(
          post(path, { origin: ORIGIN, site: "same-site", token }),
          t.env,
        );
        expect(response.status).toBe(403);
        expectNoExperimentEffect(t);
        expect(storageSnapshot(t.control())).toBe(before);
      });

      it("treats a cross-site top-level GET as a confirmation page only", async () => {
        const t = setup();
        const response = await worker.fetch(
          get(path, {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          }),
          t.env,
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(/text\/html/);
        const html = await response.text();
        expect(html).toMatch(/<form method="post" action="\/s1\/(kickoff|stop)">/);
        expectNoExperimentEffect(t);
      });

      it("refuses a same-origin post without a token, or with a wrong one", async () => {
        const t = setup();
        const token = await confirmationToken(t.env, path);
        const before = storageSnapshot(t.control());
        for (const wrong of [undefined, "", "0".repeat(64), `${token.slice(0, 63)}x`]) {
          const response = await worker.fetch(
            post(path, { origin: ORIGIN, site: "same-origin", token: wrong }),
            t.env,
          );
          expect(response.status).toBe(403);
        }
        expectNoExperimentEffect(t);
        expect(storageSnapshot(t.control())).toBe(before);
      });

      it("ignores HEAD", async () => {
        const t = setup();
        const response = await worker.fetch(
          new Request(`${ORIGIN}${path}`, { method: "HEAD" }),
          t.env,
        );
        expect(response.status).toBe(200);
        expectNoExperimentEffect(t);
      });
    });
  }

  it("serves no read route that wakes the experiment's Durable Objects", async () => {
    const t = setup();
    for (const path of ["/s1/status", "/s1/results", "/"]) {
      await worker.fetch(get(path), t.env);
    }
    expectNoExperimentEffect(t);
  });
});

describe("pages that post keep the Origin header", () => {
  // Under `Referrer-Policy: no-referrer`, a browser sends `Origin: null` with a page's own
  // form POST (Fetch, "append a request Origin header"), so Start was refused in the owner's
  // browser. Every page with a form must use a policy that keeps same-origin origins.
  for (const path of ["/s1/kickoff", "/s1/stop"]) {
    it(`${path} uses a referrer policy that keeps the origin on its own POST`, async () => {
      const t = setup();
      const response = await worker.fetch(get(path, { "sec-fetch-site": "none" }), t.env);
      expect(await response.text()).toMatch(/<form method="post"/);
      const policy = (response.headers.get("referrer-policy") ?? "").toLowerCase();
      expect(policy.split(",").map((p) => p.trim())).not.toContain("no-referrer");
      expect(policy).toBe("same-origin");
    });
  }
});

describe("IR-017: valid same-origin controls", () => {
  it("Start arms the campaign once, for a bounded time, and the token is single-use", async () => {
    const t = setup();
    const token = await confirmationToken(t.env, "/s1/kickoff");
    const started = Date.now();
    const response = await worker.fetch(
      post("/s1/kickoff", { origin: ORIGIN, site: "same-origin", token }),
      t.env,
    );
    expect(response.status).toBe(200);
    expect(t.computer.calls.map((c) => c.name)).toEqual(["kickoff"]);
    const { armedUntil } = t.computer.calls[0].args[0];
    expect(armedUntil).toBeGreaterThan(started);
    expect(armedUntil).toBeLessThanOrEqual(Date.now() + 6 * 3_600_000);

    const replay = await worker.fetch(
      post("/s1/kickoff", { origin: ORIGIN, site: "same-origin", token }),
      t.env,
    );
    expect(replay.status).toBe(403);
    expect(t.computer.calls).toHaveLength(1);
  });

  it("Start works without Sec-Fetch-Site, from an older browser", async () => {
    const t = setup();
    const token = await confirmationToken(t.env, "/s1/kickoff");
    const response = await worker.fetch(post("/s1/kickoff", { origin: ORIGIN, token }), t.env);
    expect(response.status).toBe(200);
    expect(t.computer.calls.map((c) => c.name)).toEqual(["kickoff"]);
  });

  it("Stop disarms the campaign", async () => {
    const t = setup();
    const token = await confirmationToken(t.env, "/s1/stop");
    const response = await worker.fetch(
      post("/s1/stop", { origin: ORIGIN, site: "same-origin", token }),
      t.env,
    );
    expect(response.status).toBe(200);
    expect(t.computer.calls.map((c) => c.name)).toEqual(["disarm"]);
  });

  it("an expired token is refused with zero effect", async () => {
    const t = setup();
    const token = await confirmationToken(t.env, "/s1/kickoff");
    vi.useFakeTimers({ now: Date.now() + 16 * 60_000 });
    try {
      const response = await worker.fetch(
        post("/s1/kickoff", { origin: ORIGIN, site: "same-origin", token }),
        t.env,
      );
      expect(response.status).toBe(403);
      expectNoExperimentEffect(t);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Start token does not work for Stop", async () => {
    const t = setup();
    const token = await confirmationToken(t.env, "/s1/kickoff");
    const response = await worker.fetch(
      post("/s1/stop", { origin: ORIGIN, site: "same-origin", token }),
      t.env,
    );
    expect(response.status).toBe(403);
    expectNoExperimentEffect(t);
  });
});

/** A container stub for S1Computer that records start, destroy and timeout calls. */
function fakeContainer(running) {
  const calls = [];
  return {
    calls,
    get running() {
      return running;
    },
    start(options) {
      calls.push({ name: "start", options });
      running = true;
    },
    async destroy() {
      calls.push({ name: "destroy" });
      running = false;
    },
    async setInactivityTimeout(ms) {
      calls.push({ name: "setInactivityTimeout", ms });
    },
    async interceptOutboundHttp() {
      calls.push({ name: "interceptOutboundHttp" });
    },
  };
}

async function computerWith({ running, armedUntil, phase, command }) {
  const server = recorder({ hostStatus: "offline", keepAlive: true });
  const container = fakeContainer(running);
  const state = fakeState({ container });
  await state.storage.put("hostId", "0".repeat(32));
  await state.storage.put("queue", []);
  if (armedUntil !== undefined) await state.storage.put("armedUntil", armedUntil);
  if (phase) await state.storage.put("phase", phase);
  await state.storage.setAlarm(Date.now());
  const env = { S1_VERSION: "1", S1_COMMAND: command, SERVER: namespace(() => server.stub) };
  const computer = new s1.S1Computer(state, env);
  return { computer, container, server, state };
}

describe("IR-017: the campaign runs only while armed", () => {
  it("an alarm on a campaign that was never armed starts nothing and ends the alarm loop", async () => {
    const t = await computerWith({ running: false, command: "c1:server-up,wake=1" });
    await t.computer.alarm();
    expect(t.server.calls.map((c) => c.name)).not.toContain("ensureUp");
    expect(t.container.calls.filter((c) => c.name === "start")).toEqual([]);
    expect(await t.state.storage.getAlarm()).toBeNull();
  });

  it("an expired arming stops the running campaign, its containers and the alarm loop", async () => {
    const t = await computerWith({
      running: true,
      armedUntil: Date.now() - 1000,
      phase: { kind: "heartbeat", state: { startedAt: Date.now() - 60_000 } },
      command: "c1:server-up,wake=1",
    });
    await t.computer.alarm();
    expect(t.container.calls.map((c) => c.name)).toContain("destroy");
    expect(t.container.calls.filter((c) => c.name === "start")).toEqual([]);
    expect(t.server.calls.map((c) => c.name)).toContain("stop");
    expect(await t.state.storage.get("phase")).toBeUndefined();
    expect(await t.state.storage.getAlarm()).toBeNull();
  });

  it("kickoff needs an arming time and caps it at 12 hours", async () => {
    const t = await computerWith({ running: false });
    await expect(t.computer.kickoff()).rejects.toThrow(TypeError);
    expect(await t.state.storage.get("armedUntil")).toBeUndefined();
    const { armedUntil } = await t.computer.kickoff({ armedUntil: Date.now() + 100 * 3_600_000 });
    expect(armedUntil).toBeLessThanOrEqual(Date.now() + 12 * 3_600_000);
    expect(await t.state.storage.get("armedUntil")).toBe(armedUntil);
  });

  it("disarm stops a running campaign at the next alarm", async () => {
    const t = await computerWith({
      running: true,
      armedUntil: Date.now() + 3_600_000,
      phase: { kind: "heartbeat", state: { startedAt: Date.now() } },
    });
    await t.computer.disarm();
    await t.computer.alarm();
    expect(t.container.calls.map((c) => c.name)).toContain("destroy");
    expect(t.server.calls.map((c) => c.name)).toContain("stop");
    expect(await t.state.storage.getAlarm()).toBeNull();
  });

  it("an armed campaign runs its queued phases", async () => {
    const t = await computerWith({
      running: false,
      armedUntil: Date.now() + 3_600_000,
      command: "c1:server-up",
    });
    await t.computer.alarm();
    expect(t.server.calls.map((c) => c.name)).toContain("ensureUp");
    expect(await t.state.storage.getAlarm()).not.toBeNull();
  });
});
