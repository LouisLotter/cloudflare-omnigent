import {
  createExecutionContext,
  createScheduledController,
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  BootstrapStatus,
  DurabilityUnconfirmed,
  ErrorBody,
  OutageRecord,
  type ReplicationPosition,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import platform from "../../src/index.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../src/shared/rpc.ts";
import { defined, gaps } from "../support/defined.ts";
import { stepsWithEviction } from "../support/eviction.ts";
import { unconfirmedResponse } from "../support/fake-omnigent-server.ts";
import { FakeServerContainer } from "../support/fake-server-container.ts";
import { TEST_TIMING, testServers } from "../support/server-harness.ts";

const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const ORIGIN = "https://omnigent.example.test";
const call = { interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION };
const T = TEST_TIMING;

let serial = 0;
type Stub = DurableObjectStub<OmnigentServer>;

/** A fresh OmnigentServer object with its own fake container, constructed and with its alarm set. */
async function freshServer(): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const stub = env.OMNIGENT.getByName(`server-${++serial}`) as Stub;
  const fake = testServers.create(stub.id);
  await stub.bootstrapStatus(call);
  return { stub, fake };
}

/** Runs the watchdog's alarm once, at the test clock's current time. */
async function check(stub: Stub): Promise<void> {
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

/** Advances the clock to the alarm's time and runs it. */
async function nextCheck(stub: Stub): Promise<number> {
  const at = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  expect(at).not.toBeNull();
  testServers.clock.advance(Math.max(0, (at as number) - testServers.clock.now()));
  await check(stub);
  return at as number;
}

/** A started server that has answered once. */
async function runningServer(): Promise<{ stub: Stub; fake: FakeServerContainer }> {
  const server = await freshServer();
  await check(server.stub); // starts it
  await nextCheck(server.stub); // it answers
  return server;
}

/**
 * A forwarded request, as the web Worker's forward.ts sends it: versioned, redirects not followed.
 * The answer's body is read at once: an unread body keeps the object busy, and eviction waits.
 */
async function forward(stub: Stub, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(FORWARD_VERSION_HEADER)) headers.set(FORWARD_VERSION_HEADER, "1");
  const response = await stub.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
  );
  return buffered(response);
}

async function buffered(response: Response): Promise<Response> {
  if (response.webSocket) return response;
  const body = await response.arrayBuffer();
  return new Response([204, 304].includes(response.status) ? null : body, {
    status: response.status,
    headers: response.headers,
  });
}

const iso = (ms: number) => new Date(ms).toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The error a call refuses with, called on the instance itself. Not through RPC: with
 * @cloudflare/vitest-plugin 1.4.0 a Durable Object whose RPC method rejected can no longer be
 * evicted, and every later eviction in the file waits out its timeout (upstream candidate).
 * The error code travels in the message, which RPC keeps (shared/errors.ts).
 */
function rejectionOf(
  stub: Stub,
  fn: (server: OmnigentServer) => Promise<unknown>,
): Promise<unknown> {
  return runInDurableObject(stub, async (server: OmnigentServer) => {
    try {
      await fn(server);
    } catch (error) {
      return error;
    }
    return undefined;
  });
}
const everything = { ...call, from: "2000-01-01T00:00:00.000Z", to: "2100-01-01T00:00:00.000Z" };

let logs: string[] = [];
beforeEach(() => {
  testServers.clock.reset();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

const events = (source: string) =>
  logs
    .map((line) => JSON.parse(line) as { cfo: string; event: string } & Record<string, unknown>)
    .filter((entry) => entry.cfo === source);

describe("OmnigentServer: always on", () => {
  it("registers platform.internal, then starts with only the server's variables, and keeps it running", async () => {
    const { stub, fake } = await freshServer();
    await check(stub);
    expect(fake.ops.slice(0, 3)).toEqual(["intercept:platform.internal", "start", "timeout"]);
    expect(fake.starts[0]?.env).toEqual({
      OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner-canary",
      OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: "cfo-canary-bootstrap-password",
      CFO_INSTALLATION_ID: INSTALLATION,
    });
    expect(new Set(fake.inactivityTimeouts)).toEqual(new Set([T.inactivityTimeoutMs]));
    // The secret's value never reaches a log line.
    expect(logs.join("\n")).not.toContain("cfo-canary-bootstrap-password");
  });

  it("checks an answering server every interval, renews its timeout, and never stops it, across evictions", async () => {
    const { stub, fake } = await freshServer();
    const at: number[] = [];
    await stepsWithEviction(stub, [
      () => check(stub),
      async () => at.push(await nextCheck(stub)),
      async () => at.push(await nextCheck(stub)),
      async () => at.push(await nextCheck(stub)),
    ]);
    expect(gaps(at)).toEqual([T.intervalMs, T.intervalMs]);
    expect(fake.starts).toHaveLength(1);
    expect(fake.destroys).toEqual([]);
    expect(fake.inactivityTimeouts.length).toBeGreaterThanOrEqual(4);
    expect(await stub.outages(everything)).toEqual([]);
  });

  it("re-registers the intercept and renews the timeout in every new instance", async () => {
    const { stub, fake } = await runningServer();
    const before = { intercepts: fake.intercepts.length, timeouts: fake.inactivityTimeouts.length };
    await evictDurableObject(stub);
    await stub.bootstrapStatus(call);
    expect(fake.intercepts.length).toBe(before.intercepts + 1);
    expect(fake.intercepts.at(-1)?.host).toBe("platform.internal");
    expect(fake.inactivityTimeouts.length).toBe(before.timeouts + 1);
    expect(fake.starts).toHaveLength(1);
  });

  it("restarts a server found stopped and records the outage from its last answer", async () => {
    const { stub, fake } = await runningServer();
    const lastAnswer = testServers.clock.now();
    fake.stopByPlatform();
    const [detected, , ended] = await stepsWithEviction(stub, [
      () => nextCheck(stub), // found stopped: restarted
      async () => {
        fake.listening = false; // booting
        return nextCheck(stub);
      },
      async () => {
        fake.listening = true;
        return nextCheck(stub);
      },
    ]);
    expect(fake.starts).toHaveLength(2);
    const [record] = await stub.outages(everything);
    expect(OutageRecord.parse(record)).toEqual({
      outageId: expect.stringMatching(/^out_/) as string,
      cause: "container_stopped",
      startedAt: iso(lastAnswer),
      detectedAt: iso(detected),
      endedAt: iso(ended),
      restarts: 1,
    });
    const ready = events("watchdog").findLast((e) => e.event === "server_ready");
    expect(ready).toMatchObject({ failedStarts: 0, detectedToReadyMs: ended - detected });
  });

  it("retries a start refused right after a stop (DC-37) with its backoff, never early", async () => {
    const { stub, fake } = await runningServer();
    fake.stopByPlatform();
    fake.refuseStarts = 2;
    const starts: number[] = [];
    for (let i = 0; i < 6 && fake.running === false; i += 1) {
      const before = fake.starts.length;
      const at = await nextCheck(stub);
      if (fake.starts.length > before) starts.push(at);
    }
    expect(fake.starts).toHaveLength(4); // the first start, two refused, one taken
    expect(fake.running).toBe(true);
    // Each refused start is found at the next poll and retried after 5 s, then 10 s.
    expect(gaps(starts)).toEqual(T.startRetryMs.slice(0, 2).map((delay) => T.pollMs + delay));
    await nextCheck(stub); // answers
    // An extra check before a retry is due starts nothing.
    fake.stopByPlatform();
    fake.refuseStarts = 1;
    await nextCheck(stub); // found stopped: start, refused
    await nextCheck(stub); // the refused start found: retry due in 5 s
    const count = fake.starts.length;
    await check(stub); // early
    expect(fake.starts.length).toBe(count);
    expect(events("watchdog").some((e) => e.event === "container_exited")).toBe(true);
  });

  it("waits the full readiness wait after a start, then counts it failed and starts again", async () => {
    const { stub, fake } = await runningServer();
    fake.stopByPlatform();
    await nextCheck(stub); // restarted
    fake.listening = false;
    const startedAt = testServers.clock.now();
    while (testServers.clock.now() - startedAt < T.readinessWaitMs - T.pollMs) {
      await nextCheck(stub);
      expect(fake.destroys).toEqual([]);
    }
    await nextCheck(stub);
    expect(testServers.clock.now() - startedAt).toBeGreaterThanOrEqual(T.readinessWaitMs);
    expect(fake.destroys).toEqual(["not ready within the readiness wait"]);
    expect(events("watchdog").map((e) => e.event)).toContain("start_not_ready");
    fake.listening = true;
    await nextCheck(stub); // the retry
    await nextCheck(stub); // answers
    expect(fake.starts).toHaveLength(3);
    const [record] = await stub.outages(everything);
    expect(record).toMatchObject({ cause: "container_stopped", restarts: 2 });
    expect(record?.endedAt).not.toBeNull();
  });

  it("restarts a running server that stops answering, after the wait", async () => {
    const { stub, fake } = await runningServer();
    fake.listening = false;
    const silentFrom = testServers.clock.now();
    while (fake.destroys.length === 0) await nextCheck(stub);
    expect(testServers.clock.now() - silentFrom).toBeGreaterThanOrEqual(T.hungAfterMs);
    expect(fake.destroys).toEqual(["not answering"]);
    fake.listening = true;
    await nextCheck(stub);
    await nextCheck(stub);
    const [record] = await stub.outages(everything);
    expect(record).toMatchObject({
      cause: "not_answering",
      startedAt: iso(silentFrom),
      restarts: 1,
    });
    expect(record?.endedAt).not.toBeNull();
  });

  it("calls off a restart when the server answers again before it is stopped (Codex r1-1)", async () => {
    const { stub, fake } = await runningServer();
    fake.healthResults = Array.from({ length: 200 }, () => false); // silent, but running
    const silentFrom = testServers.clock.now();
    // Checks up to the one that decides the restart: the server answers its last look.
    while (testServers.clock.now() - silentFrom < T.hungAfterMs - T.pollMs) await nextCheck(stub);
    fake.healthResults = [false, false, true];
    await nextCheck(stub);
    expect(fake.destroys).toEqual([]);
    expect(events("watchdog").map((e) => e.event)).toContain("restart_called_off");
    const [record] = await stub.outages(everything);
    expect(record).toMatchObject({ cause: "not_answering", restarts: 0 });
    expect(record?.endedAt).not.toBeNull();
    expect(fake.starts).toHaveLength(1);
  });

  it("passes no request on while the watchdog stops the server (Codex r1-1)", async () => {
    const { stub, fake } = await runningServer();
    fake.healthResults = Array.from({ length: 200 }, () => false);
    const silentFrom = testServers.clock.now();
    while (testServers.clock.now() - silentFrom < T.hungAfterMs - T.pollMs) await nextCheck(stub);
    // The deciding check: two failed probes and a failed last look. From then on the server
    // would answer health checks, so only the stop itself keeps a request out.
    fake.healthResults = [false, false, false];
    fake.destroyMs = 300;
    const at = await runInDurableObject(stub, (_i: OmnigentServer, s) => s.storage.getAlarm());
    testServers.clock.advance(Math.max(0, (at ?? 0) - testServers.clock.now()));
    const alarm = runDurableObjectAlarm(stub);
    for (let i = 0; i < 200 && fake.destroys.length === 0; i += 1) await sleep(5);
    expect(fake.destroys).toHaveLength(1); // the watchdog is stopping the server now
    const during = await forward(stub, "/v1/sessions", { method: "POST", body: "{}" });
    expect(during.status).toBe(503);
    expect(ErrorBody.parse(await during.json()).error.retryable).toBe(true);
    expect(fake.forwarded()).toEqual([]);
    expect(await alarm).toBe(true);
    expect(fake.destroys).toEqual(["not answering"]);
  });

  it("does not start without platform.internal, and retries a failed registration (Codex r1-2)", async () => {
    const { stub, fake } = await freshServer();
    const register = fake.interceptOutboundHttp.bind(fake);
    let failures = 1;
    fake.interceptOutboundHttp = async (host, target) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("intercept registration failed");
      }
      return register(host, target);
    };
    await check(stub);
    expect(fake.starts).toEqual([]);
    await nextCheck(stub); // the start found not to have happened
    await nextCheck(stub); // retried after the backoff, with the intercept
    expect(fake.starts).toHaveLength(1);
    expect(fake.ops.slice(0, 2)).toEqual(["intercept:platform.internal", "start"]);
    // A running container whose new instance failed to register: retried at the next check.
    await nextCheck(stub);
    failures = 1;
    await evictDurableObject(stub);
    await stub.bootstrapStatus(call);
    const registered = fake.intercepts.length;
    await nextCheck(stub);
    expect(fake.intercepts.length).toBe(registered + 1);
    await nextCheck(stub);
    expect(fake.intercepts.length).toBe(registered + 1);
  });

  it("re-arms its alarm even when a check fails", async () => {
    const { stub, fake } = await runningServer();
    Object.defineProperty(fake, "running", {
      configurable: true,
      get() {
        throw new Error("container API unavailable");
      },
    });
    await nextCheck(stub);
    expect(events("watchdog").some((e) => e.event === "check_error")).toBe(true);
    const alarm = await runInDurableObject(stub, (_i: OmnigentServer, s) => s.storage.getAlarm());
    expect(alarm).toBe(testServers.clock.now() + T.pollMs);
  });

  it("logs a failing container call and carries on watching", async () => {
    const { stub, fake } = await freshServer();
    const fail = (what: string) => async () => {
      throw new Error(`${what} failed`);
    };
    fake.interceptOutboundHttp = fail("intercept");
    fake.setInactivityTimeout = fail("timeout");
    fake.destroy = fail("destroy");
    await check(stub);
    expect(fake.starts).toEqual([]); // no start without platform.internal
    fake.interceptOutboundHttp = FakeServerContainer.prototype.interceptOutboundHttp.bind(fake);
    await nextCheck(stub);
    await nextCheck(stub);
    expect(fake.starts).toHaveLength(1);
    fake.listening = false;
    for (
      let i = 0;
      i < 40 && !events("watchdog").some((e) => e.event === "destroy_error");
      i += 1
    ) {
      await nextCheck(stub);
    }
    const names = events("watchdog").map((e) => e.event);
    expect(names).toEqual(
      expect.arrayContaining(["intercept_error", "inactivity_timeout_error", "destroy_error"]),
    );
    fake.start = () => {
      throw new Error("start() called while the container is running");
    };
    fake.running = false;
    await nextCheck(stub);
    expect(events("watchdog").map((e) => e.event)).toContain("start_error");
    const alarm = await runInDurableObject(stub, (_i: OmnigentServer, s) => s.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it("is started by the platform Worker's cron trigger, without a browser", async () => {
    const stub = env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as Stub;
    const fake = testServers.create(stub.id);
    const ctx = createExecutionContext();
    await platform.scheduled?.(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    await check(stub);
    expect(fake.starts).toHaveLength(1);
  });

  it("starts over from damaged state rather than stop watching", async () => {
    const { stub, fake } = await freshServer();
    await runInDurableObject(stub, (_i: OmnigentServer, state) => {
      const damaged = {
        phase: "waiting",
        phaseSince: 1e20,
        startDueAt: 1e20,
        failedStarts: 0,
        lastAnsweredAt: null,
        startsSince: null,
        outage: null,
      };
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO server_state (key, value) VALUES ('watchdog', ?)",
        JSON.stringify(damaged),
      );
    });
    await check(stub);
    expect(fake.starts).toHaveLength(1);
    expect(events("watchdog").some((e) => e.event === "state_unreadable")).toBe(true);
  });

  it("starts over from unreadable state rather than stop watching", async () => {
    const { stub, fake } = await freshServer();
    await runInDurableObject(stub, (_i: OmnigentServer, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO server_state (key, value) VALUES ('watchdog', 'not json')",
      );
    });
    await check(stub);
    expect(fake.starts).toHaveLength(1);
    expect(events("watchdog").some((e) => e.event === "state_unreadable")).toBe(true);
  });

  it("answers 503 when its class has no container configured", async () => {
    const stub = env.OMNIGENT.getByName(`server-no-container-${++serial}`) as Stub;
    const response = await forward(stub, "/");
    expect(response.status).toBe(503);
    expect(ErrorBody.parse(await response.json()).error.retryable).toBe(false);
    await check(stub);
    expect(events("watchdog").some((e) => e.event === "no_container")).toBe(true);
  });
});

describe("OmnigentServer: native forwarding", () => {
  it("forwards once over http:// to port 8000, keeping the path, query, host and body", async () => {
    const { stub, fake } = await runningServer();
    const response = await forward(stub, "/v1/sessions?limit=5&q=a%20b", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer omnigent-session",
        "x-forwarded-email": "attacker@example.invalid",
        "x-cfo-computer-id": "cmp_spoofed",
      },
      body: '{"name":"x"}',
    });
    expect(await response.json()).toEqual({
      method: "POST",
      path: "/v1/sessions",
      body: '{"name":"x"}',
    });
    const [sent] = fake.forwarded();
    expect(fake.forwarded()).toHaveLength(1);
    expect(sent?.port).toBe(8000);
    expect(sent?.url).toBe("http://omnigent.example.test/v1/sessions?limit=5&q=a%20b");
    expect(sent?.headers).toMatchObject({ authorization: "Bearer omnigent-session" });
    expect(Object.keys(sent?.headers ?? {}).filter((h) => /^x-cfo-|^x-forwarded-/.test(h))).toEqual(
      [],
    );
  });

  it("passes redirects and a 424 through untouched, and never retries", async () => {
    const { stub, fake } = await runningServer();
    fake.handler = (_port, request) =>
      new URL(request.url).pathname === "/login-redirect"
        ? new Response(null, { status: 302, headers: { location: "/login" } })
        : unconfirmedResponse(new URL(request.url).pathname);
    const redirect = await forward(stub, "/login-redirect");
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, "/login"]);
    const unconfirmed = await forward(stub, "/v1/scheduled-tasks", { method: "POST", body: "{}" });
    expect(unconfirmed.status).toBe(424);
    expect(DurabilityUnconfirmed.safeParse(await unconfirmed.json()).success).toBe(true);
    expect(fake.forwarded().map((r) => r.method)).toEqual(["GET", "POST"]);
  });

  it("answers a WebSocket upgrade with the container's socket under a bare 101 (R-24)", async () => {
    const { stub, fake } = await runningServer();
    const response = await forward(stub, "/v1/sessions/updates", {
      headers: { upgrade: "websocket", "sec-websocket-protocol": "omnigent.v1" },
    });
    expect(response.status).toBe(101);
    expect([...response.headers.keys()].sort()).toEqual(["sec-websocket-protocol"]);
    expect(response.headers.get("sec-websocket-protocol")).toBe("omnigent.v1");
    const socket = defined(response.webSocket, "a WebSocket");
    socket.binaryType = "arraybuffer";
    socket.accept();
    const received: (string | ArrayBuffer)[] = [];
    const two = new Promise<void>((resolve) =>
      socket.addEventListener("message", (event) => {
        received.push(event.data as string | ArrayBuffer);
        if (received.length === 2) resolve();
      }),
    );
    socket.send("hello");
    socket.send(new Uint8Array([0, 1, 254, 255]));
    await two;
    expect(received[0]).toBe("hello");
    expect([...new Uint8Array(received[1] as ArrayBuffer)]).toEqual([0, 1, 254, 255]);
    socket.close(1000, "done");
    expect(fake.forwarded()).toHaveLength(1);
    expect(fake.forwarded()[0]?.url.startsWith("http://")).toBe(true);
  });

  it("reports a lost answer to a change as not retryable, and a refused connection as retryable", async () => {
    const { stub, fake } = await runningServer();
    fake.handler = () => {
      throw new Error("Network connection lost.");
    };
    const change = await forward(stub, "/auth/password", { method: "POST", body: "{}" });
    expect(change.status).toBe(502);
    expect(ErrorBody.parse(await change.json()).error.retryable).toBe(false);
    fake.handler = null;
    expect((await forward(stub, "/")).status).toBe(200);
    // The server stops listening: the request never reached it, so retrying is safe.
    fake.listening = false;
    const refused = await forward(stub, "/auth/password", { method: "POST", body: "{}" });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect(ErrorBody.parse(await refused.json()).error.retryable).toBe(true);
  });

  it("makes a request wait for a starting server, then answers 503 with Retry-After", async () => {
    const { stub, fake } = await runningServer();
    await evictDurableObject(stub); // a new instance does not know the server is ready
    fake.listening = false;
    const response = await forward(stub, "/");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(fake.forwarded()).toEqual([]);
    fake.listening = true;
    const ok = await forward(stub, "/");
    expect(ok.status).toBe(200);
  });

  it("starts a stopped server for a request when no retry is pending", async () => {
    const { stub, fake } = await runningServer();
    fake.stopByPlatform();
    await evictDurableObject(stub);
    const response = await forward(stub, "/");
    expect(fake.starts).toHaveLength(2);
    expect(response.status).toBe(200);
    expect(fake.forwarded()).toHaveLength(1);
  });

  it("refuses a call without, or newer than, its interface version (R-26)", async () => {
    const { stub, fake } = await runningServer();
    const missing = await buffered(await stub.fetch(new Request(`${ORIGIN}/`)));
    expect(missing.status).toBe(400);
    expect(ErrorBody.parse(await missing.json()).error.code).toBe("bad_request");
    const newer = await forward(stub, "/", {
      headers: { [FORWARD_VERSION_HEADER]: String(OMNIGENT_SERVER_INTERFACE_VERSION + 1) },
    });
    expect(ErrorBody.parse(await newer.json()).error.code).toBe("unsupported_version");
    expect(fake.forwarded()).toEqual([]);
    const refused = await rejectionOf(stub, (server) =>
      server.outages({ ...everything, interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION + 1 }),
    );
    expect(errorCodeOf(refused)).toBe("unsupported_version");
    const unversioned = await rejectionOf(stub, (server) =>
      server.bootstrapStatus({} as typeof call),
    );
    expect(errorCodeOf(unversioned)).toBe("unsupported_version");
    // Unknown fields are tolerated.
    const tolerant = { ...everything, futureField: true } as typeof everything;
    expect(await stub.outages(tolerant)).toEqual([]);
  });

  it("refuses everything on platform.internal until the launcher API exists", async () => {
    const { stub, fake } = await runningServer();
    expect(fake.intercepts.map((i) => i.host)).toEqual(["platform.internal"]);
    // The intercept's target belongs to the object's I/O context: call it from there, as the
    // container's egress would.
    const [status, body] = await runInDurableObject(stub, async () => {
      const response = await defined(fake.intercepts[0]).target.fetch(
        "http://platform.internal/v1/provision",
        {
          method: "POST",
          body: "{}",
        },
      );
      return [response.status, await response.json()] as const;
    });
    expect(status).toBe(503);
    expect(ErrorBody.parse(body).error.code).toBe("unavailable");
    expect(events("platform_internal")).toMatchObject([
      { event: "refused", path: "/v1/provision", propsVersion: 1 },
    ]);
  });
});

describe("OmnigentServer: outage records", () => {
  it("returns the records that overlap a range, oldest first, and refuses a bad range", async () => {
    const { stub, fake } = await runningServer();
    const first = testServers.clock.now();
    fake.stopByPlatform();
    await nextCheck(stub);
    await nextCheck(stub);
    const firstEnd = testServers.clock.now();
    testServers.clock.advance(3_600_000);
    await nextCheck(stub);
    fake.stopByPlatform();
    await nextCheck(stub);
    const all = await stub.outages(everything);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.endedAt === null)).toEqual([false, true]);
    const onlyFirst = await stub.outages({ ...call, from: iso(first), to: iso(firstEnd) });
    expect(onlyFirst.map((r) => r.outageId)).toEqual([all[0]?.outageId]);
    const later = await stub.outages({ ...call, from: iso(firstEnd + 1), to: iso(firstEnd + 2) });
    expect(later).toEqual([]);
    const bad = await rejectionOf(stub, (server) =>
      server.outages({ ...call, from: "yesterday", to: iso(firstEnd) }),
    );
    expect(errorCodeOf(bad)).toBe("bad_request");
  });
});

describe("OmnigentServer: bootstrap status (G1BR-002, R-30)", () => {
  const BOOT = "c".repeat(32);
  const position = (txid: number, replicatedTxid: number, bootId = BOOT): ReplicationPosition => ({
    protocolVersion: 1,
    bootId,
    txid,
    replicatedTxid,
  });
  const statusEvents = () =>
    events("bootstrap").map((e) => e as unknown as { reason: string; bootstrapStatus: unknown });

  it("records initialized only once the owner is shown and replicated, and logs each check", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: true };
    fake.position = position(3, 3);
    const [setup, held, durable] = await stepsWithEviction(stub, [
      async () => {
        await check(stub);
        await nextCheck(stub);
        return stub.bootstrapStatus(call);
      },
      async () => {
        fake.info = { accounts_enabled: true, needs_setup: false };
        fake.position = position(9, 4); // replication held back
        await nextCheck(stub);
        return stub.bootstrapStatus(call);
      },
      async () => {
        fake.position = position(15, 9);
        await nextCheck(stub);
        return stub.bootstrapStatus(call);
      },
    ]);
    expect(setup?.initialized).toBe(false);
    expect(held?.initialized).toBe(false);
    expect(durable?.initialized).toBe(true);
    expect(BootstrapStatus.parse(durable)).toMatchObject({ installationId: INSTALLATION });
    expect(statusEvents().map((e) => e.reason)).toEqual([
      "not_initialized",
      "not_replicated",
      "durable",
    ]);
    expect(statusEvents().at(-1)?.bootstrapStatus).toEqual(durable);
    // Read over the container's ports, in order: position, /v1/info, position.
    const reads = fake.requests
      .filter((r) => r.url.endsWith("/position") || r.url.endsWith("/v1/info"))
      .slice(-3)
      .map((r) => `${r.port}${new URL(r.url).pathname}`);
    expect(reads).toEqual(["8001/position", "8000/v1/info", "8001/position"]);
  });

  it("does not accept a /v1/info read that a restarted server may have answered", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(5, 5);
    fake.onPosition = (read) => {
      if (read % 2 === 0) fake.position = position(1, 1, "d".repeat(32));
      else fake.position = position(5, 5);
    };
    await check(stub);
    await nextCheck(stub);
    expect((await stub.bootstrapStatus(call))?.initialized).toBe(false);
    expect(statusEvents().at(-1)?.reason).toBe("boot_changed");
  });

  it("restarts the comparison when the server's boot changes (a replaced or restored server)", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(5, 2, "a".repeat(32)); // boot A: target 5, replica at 2
    await check(stub);
    await nextCheck(stub);
    expect(statusEvents().at(-1)?.reason).toBe("not_replicated");
    // Boot B: its replica (6) passes boot A's target (5), but says nothing about B's own owner
    // commit: the target is B's position after /v1/info, 20.
    fake.position = position(20, 6, "b".repeat(32));
    await nextCheck(stub);
    expect((await stub.bootstrapStatus(call))?.initialized).toBe(false);
    expect(statusEvents().at(-1)?.reason).toBe("not_replicated");
    fake.position = position(31, 20, "b".repeat(32));
    await nextCheck(stub);
    expect((await stub.bootstrapStatus(call))?.initialized).toBe(true);
    const target = await runInDurableObject(stub, (_i: OmnigentServer, state) =>
      state.storage.sql
        .exec<{ value: string }>("SELECT value FROM server_state WHERE key = 'bootstrap_target'")
        .one(),
    );
    expect(JSON.parse(target.value)).toEqual({ bootId: "b".repeat(32), txid: 20 });
  });

  it("stops checking once the owner is durable and the secret is gone", async () => {
    const { stub, fake } = await freshServer();
    fake.info = { accounts_enabled: true, needs_setup: false };
    fake.position = position(5, 5);
    await check(stub);
    await nextCheck(stub);
    expect((await stub.bootstrapStatus(call))?.initialized).toBe(true);
    await runInDurableObject(stub, (instance: OmnigentServer) => {
      const withoutSecret: Record<string, unknown> = {
        ...(instance as unknown as { env: object }).env,
      };
      delete withoutSecret.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD;
      Object.defineProperty(instance, "env", { value: withoutSecret });
    });
    const reads = fake.requests.length;
    const logged = statusEvents().length;
    await nextCheck(stub);
    expect(fake.requests.length).toBe(reads + 1); // the health check only
    expect(statusEvents().length).toBe(logged);
  });
});
