// OmnigentServer's password page interface (WP3.34), in workerd with real Durable Object storage
// and eviction, and a fake server container that checks the platform call's signature with the
// contract's signer. The server image's handler is tested against the same vectors in the image.
import {
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  OWNER_PASSWORD_CALL_PATH,
  OwnerPasswordResult,
  type PageOwner,
  PLATFORM_CALL_SIGNATURE_HEADER,
  PLATFORM_CALL_TIMESTAMP_HEADER,
  signPlatformCall,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { ATTEMPT_WINDOW_MS, MAX_ATTEMPTS } from "../../src/server/owner-password.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { FORWARD_VERSION_HEADER, OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

type Stub = DurableObjectStub<OmnigentServer>;
const v = OMNIGENT_SERVER_INTERFACE_VERSION;
const COOKIE_SECRET = "c".repeat(64); // synthetic
const OWNER: PageOwner = { sub: "owner-sub-1", sessionId: "a".repeat(64) };
const OTHER_SESSION: PageOwner = { sub: "owner-sub-1", sessionId: "b".repeat(64) };
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const CANARY_PREFIX = ["CFO", "CANARY", ""].join("_");
const PASSWORD = `${CANARY_PREFIX}OWNERPAGEPASSWORD01`;

let serial = 0;
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

interface Server {
  readonly stub: Stub;
  readonly fake: FakeServerContainer;
  /** The platform calls the fake received, with their signatures checked. */
  readonly calls: { readonly body: { password: string; nonce: string }; readonly valid: boolean }[];
  /**
   * What the fake's handler answers the next platform calls with, made inside the object (an
   * I/O object made in the test cannot be used by a Durable Object).
   */
  readonly answers: (() => Response | Error)[];
}

/** A running server, with the variables a release would give it. */
async function server(vars: Record<string, string | null> = {}): Promise<Server> {
  const stub = env.OMNIGENT.getByName(`password-${++serial}`) as Stub;
  testServers.release(stub.id, {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
    ...vars,
  });
  const fake = testServers.create(stub.id);
  const calls: Server["calls"][number][] = [];
  const answers: (() => Response | Error)[] = [];
  fake.handler = async (port, request) => {
    if (port !== 8000 || new URL(request.url).pathname !== OWNER_PASSWORD_CALL_PATH) {
      return new Response("unexpected", { status: 500 });
    }
    const text = await request.clone().text();
    const timestamp = Number(request.headers.get(PLATFORM_CALL_TIMESTAMP_HEADER));
    const expected = await signPlatformCall({
      cookieSecret: COOKIE_SECRET,
      method: request.method,
      path: OWNER_PASSWORD_CALL_PATH,
      timestamp,
      body: new TextEncoder().encode(text),
    });
    calls.push({
      body: JSON.parse(text),
      valid:
        request.method === "POST" &&
        Math.abs(timestamp - Date.now() / 1000) < 60 &&
        expected[PLATFORM_CALL_SIGNATURE_HEADER] ===
          request.headers.get(PLATFORM_CALL_SIGNATURE_HEADER),
    });
    const answer = (answers.shift() ?? confirmed)();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  await stub.bootstrapStatus({ interfaceVersion: v });
  expect(await runDurableObjectAlarm(stub)).toBe(true); // starts it
  testServers.clock.advance(60_000);
  expect(await runDurableObjectAlarm(stub)).toBe(true); // it answers
  return { stub, fake, calls, answers };
}

const confirmed = () =>
  Response.json({ ok: true }, { headers: { "x-cfo-durability": "confirmed" } });

async function state(stub: Stub, owner: PageOwner = OWNER) {
  const result = OwnerPasswordResult.parse(
    await stub.ownerPassword({ action: "state", interfaceVersion: v, owner }),
  );
  if (result.action !== "state") throw new Error("not a state");
  return result;
}

async function set(stub: Stub, password = PASSWORD, owner: PageOwner = OWNER, intent?: string) {
  const token = intent ?? (await state(stub, owner)).intentToken;
  return OwnerPasswordResult.parse(
    await stub.ownerPassword({
      action: "set",
      interfaceVersion: v,
      owner,
      intent: token,
      password,
    }),
  );
}

/** The error a call into the object rejects with, caught inside it. */
function rejectionOf(stub: Stub, fn: (server: OmnigentServer) => Promise<unknown>) {
  return runInDurableObject(stub, async (server: OmnigentServer) => {
    try {
      await fn(server);
    } catch (error) {
      return error;
    }
    return undefined;
  });
}

const passwordCalls = (fake: FakeServerContainer) =>
  fake.requests.filter((r) => new URL(r.url).pathname === OWNER_PASSWORD_CALL_PATH);

describe("OmnigentServer: the password page's state", () => {
  it("is chosen unless the installer chose no password, and names the owner", async () => {
    const plain = await server();
    expect(await state(plain.stub)).toMatchObject({ state: "chosen", username: "owner-canary" });
    const page = await server({ CFO_OWNER_PASSWORD_ON_PAGE: "true" });
    expect(await state(page.stub)).toMatchObject({ state: "unchosen", username: "owner-canary" });
    const nameless = await server({ SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: null });
    expect((await state(nameless.stub)).username).toBeNull();
  });

  it("binds the intent token to the Access session, and keeps it across an eviction", async () => {
    const { stub } = await server();
    const first = (await state(stub)).intentToken;
    expect((await state(stub)).intentToken).toBe(first);
    expect((await state(stub, OTHER_SESSION)).intentToken).not.toBe(first);
    await evictDurableObject(stub);
    expect((await state(stub)).intentToken).toBe(first);
  });
});

describe("OmnigentServer: setting the owner's password", () => {
  it("signs the call, says done only once the barrier confirmed it, and records the choice", async () => {
    const { stub, fake, calls } = await server({ CFO_OWNER_PASSWORD_ON_PAGE: "true" });
    expect(await set(stub)).toEqual({ action: "set", outcome: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.valid).toBe(true);
    expect(calls[0]?.body.password).toBe(PASSWORD);
    expect(calls[0]?.body.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(passwordCalls(fake)[0]?.port).toBe(8000);
    expect(await state(stub)).toMatchObject({ state: "chosen", justSet: true });
    // "Done" is this session's alone (Codex r1-3).
    expect((await state(stub, OTHER_SESSION)).justSet).toBe(false);
    await evictDurableObject(stub);
    expect(await state(stub)).toMatchObject({ state: "chosen", justSet: true });
    // A second change: a fresh nonce, so a fresh signature.
    expect(await set(stub, "synthetic-second-password")).toMatchObject({ outcome: "done" });
    expect(calls[1]?.body.nonce).not.toBe(calls[0]?.body.nonce);
  });

  it.each([
    ["a 200 without the barrier's confirmation", () => Response.json({ ok: true }), "unconfirmed"],
    [
      "a 424",
      () =>
        Response.json(
          { error: { code: "durability_unconfirmed", message: "m" }, applied: true },
          { status: 424, headers: { "x-cfo-durability": "unconfirmed" } },
        ),
      "unconfirmed",
    ],
    ["a 503", () => new Response("recovery", { status: 503 }), "unavailable"],
    ["a 401", () => new Response("no", { status: 401 }), "failed"],
    ["a 500", () => new Response("no", { status: 500 }), "failed"],
    [
      "a refused connection",
      () => new Error("The container is not listening on the TCP address 10.0.0.1:8000"),
      "unavailable",
    ],
    ["a lost answer", () => new Error("Network connection lost."), "unavailable"],
  ] as const)("answers %s as %s, and leaves the owner unchosen", async (_, answer, outcome) => {
    const { stub, answers } = await server({ CFO_OWNER_PASSWORD_ON_PAGE: "true" });
    answers.push(answer);
    expect(await set(stub)).toMatchObject({ action: "set", outcome });
    expect(await state(stub)).toMatchObject({ state: "unchosen", justSet: false });
  });

  it("refuses another session's intent token, a wrong one, and sends nothing", async () => {
    const { stub, fake } = await server();
    const foreign = (await state(stub, OTHER_SESSION)).intentToken;
    expect(await set(stub, PASSWORD, OWNER, foreign)).toEqual({
      action: "set",
      outcome: "refused",
      reason: "intent",
    });
    expect(await set(stub, PASSWORD, OWNER, "0".repeat(64))).toMatchObject({ reason: "intent" });
    expect(passwordCalls(fake)).toHaveLength(0);
  });

  it("refuses without a cookie secret or an owner's name", async () => {
    for (const vars of [
      { SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: null },
      { SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: null },
    ]) {
      const { stub, fake } = await server(vars);
      expect(await set(stub)).toMatchObject({ outcome: "refused", reason: "not_configured" });
      expect(passwordCalls(fake)).toHaveLength(0);
    }
  });

  it(`allows ${MAX_ATTEMPTS} attempts in ${ATTEMPT_WINDOW_MS / 60_000} minutes, across an eviction`, async () => {
    const { stub, fake } = await server();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      expect(await set(stub)).toMatchObject({ outcome: "done" });
    }
    await evictDurableObject(stub);
    expect(await set(stub)).toMatchObject({ outcome: "done" });
    const refused = await set(stub);
    expect(refused).toMatchObject({ outcome: "refused", reason: "rate_limited" });
    expect(
      refused.action === "set" && refused.outcome === "refused" && refused.retryAfterSeconds,
    ).toBeGreaterThan(0);
    expect(passwordCalls(fake)).toHaveLength(MAX_ATTEMPTS);
    testServers.clock.advance(ATTEMPT_WINDOW_MS);
    expect(await set(stub)).toMatchObject({ outcome: "done" });
  });

  it("lets no more than the limit through when the attempts arrive at once", async () => {
    const { stub, fake } = await server();
    const token = (await state(stub)).intentToken;
    const results = await Promise.all(
      Array.from({ length: MAX_ATTEMPTS + 3 }, () =>
        stub.ownerPassword({
          action: "set",
          interfaceVersion: v,
          owner: OWNER,
          intent: token,
          password: PASSWORD,
        }),
      ),
    );
    const outcomes = results
      .map((r) => OwnerPasswordResult.parse(r))
      .map((r) => (r.action === "set" ? r.outcome : "state"));
    expect(outcomes.filter((o) => o === "done")).toHaveLength(MAX_ATTEMPTS);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(3);
    expect(passwordCalls(fake)).toHaveLength(MAX_ATTEMPTS);
  });

  it("does not count a refusal before the server", async () => {
    const { stub, fake } = await server();
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      await set(stub, PASSWORD, OWNER, "0".repeat(64));
    }
    expect(await set(stub)).toMatchObject({ outcome: "done" });
    expect(passwordCalls(fake)).toHaveLength(1);
  });

  it("sends nothing to a server in recovery mode, one held after exit 78, or none", async () => {
    const recovering = await server();
    recovering.fake.entrypointPhase = "recovery";
    recovering.fake.recovery = { reason: "replica_empty", transient: false };
    testServers.clock.advance(60_000);
    await runDurableObjectAlarm(recovering.stub);
    expect(await set(recovering.stub)).toMatchObject({ outcome: "unavailable" });
    expect(passwordCalls(recovering.fake)).toHaveLength(0);

    const held = await server();
    await runInDurableObject(held.stub, () => held.fake.stopByPlatform(78));
    testServers.clock.advance(60_000);
    await runDurableObjectAlarm(held.stub);
    expect(await set(held.stub)).toMatchObject({ outcome: "failed" });
    expect(passwordCalls(held.fake)).toHaveLength(0);

    const stopped = await server();
    stopped.fake.listening = false;
    stopped.fake.running = false;
    stopped.fake.refuseForever = true;
    expect(await set(stopped.stub)).toMatchObject({ outcome: "unavailable" });
  });

  it("refuses a malformed call and a newer interface, quoting no password", async () => {
    const { stub } = await server();
    const token = (await state(stub)).intentToken;
    const short = await rejectionOf(stub, (s) =>
      s.ownerPassword({
        action: "set",
        interfaceVersion: v,
        owner: OWNER,
        intent: token,
        password: `${CANARY_PREFIX}SHORT`.slice(0, 7),
      }),
    );
    expect(errorCodeOf(short)).toBe("bad_request");
    expect(String(short)).not.toContain(CANARY_PREFIX.slice(0, 7));
    const newer = await rejectionOf(stub, (s) =>
      s.ownerPassword({ action: "state", interfaceVersion: v + 1, owner: OWNER }),
    );
    expect(errorCodeOf(newer)).toBe("unsupported_version");
  });

  it("logs outcomes only, never the password", async () => {
    const { stub, answers } = await server();
    answers.push(
      () => new Response("no", { status: 401 }),
      () => new Error("Network connection lost."),
    );
    await set(stub);
    await set(stub);
    await set(stub);
    await set(stub, PASSWORD, OWNER, "0".repeat(64));
    const text = logs.join("\n");
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(COOKIE_SECRET);
    const outcomes = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((e) => e.event === "owner_password")
      .map((e) => e.outcome);
    expect(outcomes).toEqual(["failed", "unavailable", "done", "refused"]);
  });
});

describe("OmnigentServer: forwarding never reaches the platform calls", () => {
  it.each([
    "/_cfo/owner-password",
    "/%5Fcfo/owner-password",
    "//_cfo/owner-password",
    "/_cfo%2Fowner-password",
    "/_cfo",
  ])("refuses %s, from a browser or a computer alike", async (path) => {
    const { stub, fake } = await server();
    const before = fake.requests.length;
    const response = await stub.fetch(
      new Request(`https://omnigent.example.test${path}`, {
        method: "POST",
        headers: { [FORWARD_VERSION_HEADER]: String(v), "content-type": "application/json" },
        body: JSON.stringify({ password: PASSWORD, nonce: "0".repeat(32) }),
      }),
    );
    expect(response.status).toBe(404);
    await response.body?.cancel();
    expect(fake.requests.length).toBe(before);
  });
});
