// IR-017 campaign controls, tested on the real handlers: the Worker's default fetch, its
// /__s7/ platform handler and the real Durable Object classes, with fake storage and fake
// containers standing in for the runtime. Every refusal must have zero effect: no container
// start, stop or request, no job, no arming, no record. The only write a GET may make is the
// page's request-intent token.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAMPAIGN_ROUTES,
  CAMPAIGN_WINDOW_MS,
  checkOrigin,
  constantTimeEqual,
  INTENT_HEADER,
  INTENT_TTL_MS,
  intentMatches,
  MAX_INTENTS,
  POST_ROUTES,
  pruneIntents,
  sha256Hex,
} from "../src/controls.ts";
import worker from "../src/index.ts";
import { ComputerSim, OmnigentServer } from "../src/staging.ts";

const ORIGIN = "https://cfo-stg-s7-managed.example.test";
const EVIL = "https://evil.example";

class FakeStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  readonly writes: string[] = [];
  async get(key: string) {
    return structuredClone(this.data.get(key));
  }
  async put(key: string, value: unknown) {
    this.writes.push(key);
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.writes.push(`-${key}`);
    return this.data.delete(key);
  }
  async list({ prefix }: { prefix: string }) {
    return new Map([...this.data].filter(([k]) => k.startsWith(prefix)));
  }
  async setAlarm(at: number) {
    this.writes.push("alarm");
    this.alarm = at;
  }
  async getAlarm() {
    return this.alarm;
  }
}

class FakeContainer {
  running = false;
  starts = 0;
  destroys = 0;
  requests = 0;
  start() {
    this.starts++;
    this.running = true;
  }
  async destroy() {
    this.destroys++;
    this.running = false;
  }
  monitor() {
    return new Promise(() => undefined);
  }
  getTcpPort() {
    return {
      fetch: async (input: RequestInfo) => {
        this.requests++;
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/health")) return new Response("ok");
        if (url.endsWith("/auth/login")) {
          return Response.json({ token: "t" }, { headers: { "set-cookie": "s=1; Path=/" } });
        }
        return Response.json({ object: "sharing", sharing_mode: "read_only", editable: true });
      },
    };
  }
  async exec() {
    return { output: async () => ({ stdout: new ArrayBuffer(0), stderr: new ArrayBuffer(0) }) };
  }
  async interceptOutboundHttp() {}
}

function state(container: FakeContainer) {
  const fetcher = () => ({ fetch: async () => new Response(null, { status: 204 }) });
  return {
    storage: new FakeStorage(),
    container,
    waitUntil() {},
    exports: { ComputerRoute: fetcher, ResultSink: fetcher },
  };
}

function setup() {
  const serverContainer = new FakeContainer();
  const computerContainer = new FakeContainer();
  const serverState = state(serverContainer);
  const computerState = state(computerContainer);
  const env: Record<string, unknown> = { GUARD_MODE: "strict", BASE_PATH: "" };
  const server = new OmnigentServer(serverState as never, env as never);
  const computer = new ComputerSim(computerState as never, env as never);
  env.SERVER = { idFromName: (n: string) => n, get: () => server };
  env.COMPUTER = { idFromName: (n: string) => n, get: () => computer };
  const ctx = { waitUntil() {}, passThroughOnException() {}, exports: {}, props: {} };
  const handler = worker as unknown as {
    fetch: (r: Request, e: unknown, c: unknown) => Promise<Response>;
  };
  const call = (path: string, init: RequestInit = {}) =>
    handler.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  /** Everything that counts as an effect. Request-intent tokens are excluded. */
  const effects = () => ({
    serverStarts: serverContainer.starts,
    serverStops: serverContainer.destroys,
    serverRequests: serverContainer.requests,
    computerStarts: computerContainer.starts,
    computerStops: computerContainer.destroys,
    serverWrites: serverState.storage.writes.filter((k) => k !== "intents"),
    computerWrites: [...computerState.storage.writes],
    serverAlarm: serverState.storage.alarm,
    computerAlarm: computerState.storage.alarm,
  });
  const token = async () => {
    const page = await (await call("/__s7/")).text();
    const match = /const INTENT = "([0-9a-f]{64})";/.exec(page);
    if (!match?.[1]) throw new Error("no token in the page");
    return match[1];
  };
  const post = (path: string, headers: Record<string, string>, body = "{}") =>
    call(path, { method: "POST", headers, body });
  return {
    call,
    post,
    token,
    effects,
    server,
    computer,
    serverState,
    serverContainer,
    computerContainer,
  };
}

const sameOrigin = (token: string) => ({
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  [INTENT_HEADER]: token,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("IR-017 refusals have zero effect", () => {
  it("a cross-site top-level GET to any control URL only shows a confirmation page", async () => {
    const s = setup();
    const before = s.effects();
    for (const path of POST_ROUTES) {
      for (const method of ["GET", "HEAD"]) {
        const response = await s.call(path, {
          method,
          headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
        });
        expect(response.status, `${method} ${path}`).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/html");
        if (method === "GET") expect(await response.text()).toContain("Nothing has happened yet");
      }
    }
    expect(s.effects()).toEqual(before);
  });

  it("a cross-site top-level GET to the forwarded app never starts the server", async () => {
    const s = setup();
    for (const path of ["/", "/settings/sharing", "/v1/sharing", "/v1/info"]) {
      const response = await s.call(path, { headers: { "sec-fetch-site": "cross-site" } });
      expect(response.status, path).toBe(503);
    }
    expect(s.serverContainer.starts).toBe(0);
    expect(s.serverContainer.requests).toBe(0);
  });

  it("a foreign Origin is refused, even carrying a valid token", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const path of POST_ROUTES) {
      const response = await s.post(path, {
        origin: EVIL,
        "sec-fetch-site": "cross-site",
        [INTENT_HEADER]: token,
      });
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain("foreign-origin");
    }
    expect(s.effects()).toEqual(before);
  });

  it("Origin: null is refused", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const path of POST_ROUTES) {
      const response = await s.post(path, { origin: "null", [INTENT_HEADER]: token });
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain("null-origin");
    }
    expect(s.effects()).toEqual(before);
  });

  it("a missing Origin is refused", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const path of POST_ROUTES) {
      const response = await s.post(path, { [INTENT_HEADER]: token });
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain("missing-origin");
    }
    expect(s.effects()).toEqual(before);
  });

  it("a simple cross-site form POST is refused", async () => {
    const s = setup();
    const before = s.effects();
    for (const path of POST_ROUTES) {
      const response = await s.post(
        path,
        {
          origin: EVIL,
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "content-type": "application/x-www-form-urlencoded",
        },
        "label=x",
      );
      expect(response.status, path).toBe(403);
    }
    expect(s.effects()).toEqual(before);
  });

  it("the right Origin with a cross-site or same-site Sec-Fetch-Site is refused", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const site of ["cross-site", "same-site", "none"]) {
      const response = await s.post("/__s7/api/arm", {
        ...sameOrigin(token),
        "sec-fetch-site": site,
      });
      expect(response.status, site).toBe(403);
    }
    expect(s.effects()).toEqual(before);
  });

  it("the right Origin without a token, with a wrong one or an expired one is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    const { [INTENT_HEADER]: _, ...noToken } = sameOrigin(token);
    expect((await s.post("/__s7/api/arm", noToken)).status).toBe(403);
    expect((await s.post("/__s7/api/arm", sameOrigin("0".repeat(64)))).status).toBe(403);
    expect((await s.post("/__s7/api/arm", sameOrigin(""))).status).toBe(403);
    vi.setSystemTime(Date.now() + INTENT_TTL_MS + 1);
    expect((await s.post("/__s7/api/arm", sameOrigin(token))).status).toBe(403);
    expect(s.effects()).toEqual(before);
  });

  it("campaign routes stay off until a campaign is armed", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const path of CAMPAIGN_ROUTES) {
      const response = await s.post(path, sameOrigin(token));
      expect(response.status, path).toBe(403);
      expect(await response.text()).toContain("no campaign is armed");
    }
    expect(s.effects()).toEqual(before);
  });

  it("other methods are refused without effect", async () => {
    const s = setup();
    const token = await s.token();
    const before = s.effects();
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const response = await s.call("/__s7/api/arm", { method, headers: sameOrigin(token) });
      expect(response.status, method).toBe(405);
    }
    expect(s.effects()).toEqual(before);
  });
});

describe("IR-017 valid same-origin control", () => {
  it("arms, starts the server, runs the computer, and disarms", async () => {
    const s = setup();
    const token = await s.token();
    const armed = await s.post("/__s7/api/arm", sameOrigin(token));
    expect(armed.status).toBe(200);
    expect(((await armed.json()) as { armedUntil: number }).armedUntil).toBeGreaterThan(Date.now());

    expect((await s.post("/__s7/api/start", sameOrigin(token))).status).toBe(200);
    expect(s.serverContainer.starts).toBe(0); // the job runs in the alarm, not the request
    await s.server.alarm();
    expect(s.serverContainer.starts).toBe(1);
    const job = (await (await s.post("/__s7/api/job", sameOrigin(token))).json()) as {
      state: string;
    };
    expect(job.state).toBe("done");

    // With the server running, forwarded traffic reaches it.
    expect((await s.call("/v1/info")).status).toBe(200);

    const login = await s.post("/__s7/api/login", sameOrigin(token));
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("s=1");

    expect((await s.post("/__s7/api/computer-run?label=t", sameOrigin(token))).status).toBe(200);
    const pending = (await (
      await s.post("/__s7/api/computer-result?label=t", sameOrigin(token))
    ).json()) as { job: { state: string } };
    expect(pending.job.state).toBe("running");

    expect((await s.post("/__s7/api/disarm", sameOrigin(token))).status).toBe(200);
    expect(s.serverContainer.running).toBe(false);
    expect((await s.post("/__s7/api/start", sameOrigin(token))).status).toBe(403);
  });

  it("disarms itself after the bounded window and stops the containers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = setup();
    const token = await s.token();
    expect((await s.post("/__s7/api/arm", sameOrigin(token))).status).toBe(200);
    expect(s.serverState.storage.alarm).toBe(Date.now() + CAMPAIGN_WINDOW_MS);
    expect((await s.post("/__s7/api/start", sameOrigin(token))).status).toBe(200);
    await s.server.alarm();
    expect(s.serverContainer.running).toBe(true);

    vi.setSystemTime(Date.now() + CAMPAIGN_WINDOW_MS + 1);
    expect((await s.post("/__s7/api/replace", sameOrigin(token))).status).toBe(403);
    await s.server.alarm();
    expect(s.serverContainer.running).toBe(false);
    expect(await s.server.isArmed()).toBe(false);
  });
});

describe("control helpers", () => {
  it("checkOrigin", () => {
    const req = (headers: Record<string, string>) =>
      new Request(`${ORIGIN}/__s7/api/arm`, { method: "POST", headers });
    expect(checkOrigin(req({ origin: ORIGIN })).ok).toBe(true);
    expect(checkOrigin(req({ origin: ORIGIN, "sec-fetch-site": "same-origin" })).ok).toBe(true);
    expect(checkOrigin(req({}))).toEqual({ ok: false, reason: "missing-origin" });
    expect(checkOrigin(req({ origin: "null" }))).toEqual({ ok: false, reason: "null-origin" });
    expect(checkOrigin(req({ origin: `${ORIGIN}.evil.example` })).ok).toBe(false);
    expect(checkOrigin(req({ origin: ORIGIN.replace("https", "http") })).ok).toBe(false);
  });

  it("constantTimeEqual", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("intent tokens: match, expiry, pruning", async () => {
    const now = 1_000_000;
    const hash = await sha256Hex("tok");
    const intents = [{ hash, expiresAt: now + 10 }];
    expect(await intentMatches("tok", intents, now)).toBe(true);
    expect(await intentMatches("tok", intents, now + 10)).toBe(false);
    expect(await intentMatches("other", intents, now)).toBe(false);
    expect(await intentMatches(null, intents, now)).toBe(false);
    const many = Array.from({ length: 40 }, (_, i) => ({ hash: `h${i}`, expiresAt: now + i }));
    const kept = pruneIntents(many, now + 5);
    expect(kept.length).toBe(MAX_INTENTS - 1);
    expect(kept.every((i) => i.expiresAt > now + 5)).toBe(true);
  });
});
