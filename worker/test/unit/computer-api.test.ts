import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ComputerCall,
  type ComputerId,
  SUPERVISOR_API_PORT,
  type SupervisorReply,
  type WorkspaceCommand,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/ingress/limits.ts";
import {
  COMPUTER_API_LIMITS,
  type ComputerApiDeps,
  classifyFailure,
  handleSupervisorMessage,
  INBOUND_RETRY,
  repeatable,
  sendCommand,
} from "../../src/internal/computer-api.ts";
import { CONNECTION_LOST_MESSAGE, NO_INSTANCE_MESSAGE } from "../../src/shared/computer-port.ts";
import { platformError } from "../../src/shared/errors.ts";
import { FakeComputerContainer } from "../support/fake-computer-container.ts";
import { FakeWorkspace } from "../support/fake-workspace.ts";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "contracts",
  "fixtures",
);
const read = (...parts: string[]) =>
  JSON.parse(readFileSync(join(fixtures, ...parts), "utf8")) as unknown;
const jsonFiles = (...parts: string[]) =>
  readdirSync(join(fixtures, ...parts)).filter((n) => n.endsWith(".json"));

const hello = read("SupervisorMessage", "hello.json") as {
  computerId: ComputerId;
  generation: number;
};
const COMPUTER = hello.computerId;
const GENERATION = hello.generation;
const props = { propsVersion: 1, computerId: COMPUTER, generation: GENERATION, hostId: null };
const URL_MESSAGES = "http://computer.internal/v1/messages";

interface Harness {
  deps: ComputerApiDeps;
  calls: ComputerCall[];
  slept: number[];
  logs: Readonly<Record<string, unknown>>[];
  /** Answers for the next calls, in order; past the end, a FakeWorkspace answers. */
  script: (Error | "ok")[];
  workspace: FakeWorkspace;
}

function harness(): Harness {
  let now = 0;
  const h: Harness = {
    calls: [],
    slept: [],
    logs: [],
    script: [],
    workspace: new FakeWorkspace(COMPUTER),
    deps: undefined as unknown as ComputerApiDeps,
  };
  // The fake's generation follows the messages' (it starts at 0).
  h.workspace.generation = GENERATION;
  h.deps = {
    computer: async (_computerId, call): Promise<SupervisorReply> => {
      h.calls.push(call);
      const next = h.script.shift();
      if (next instanceof Error) throw next;
      return h.workspace.computer(call);
    },
    limiter: new RateLimiter(() => now, COMPUTER_API_LIMITS),
    retry: INBOUND_RETRY,
    sleep: async (ms) => {
      h.slept.push(ms);
      now += ms;
    },
    clock: () => now,
    log: (_event, fields) => h.logs.push(fields),
  };
  return h;
}

const post = (body: unknown, url = URL_MESSAGES) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("inbound: a supervisor's message to its WorkspaceDO", () => {
  it("passes every valid SupervisorMessage fixture with the props, once", async () => {
    for (const name of jsonFiles("SupervisorMessage")) {
      const h = harness();
      const message = read("SupervisorMessage", name);
      const response = await handleSupervisorMessage(post(message), props, h.deps);
      // The fake refuses a credential checkpoint before a restore is confirmed (R-19): 409.
      expect([200, 409], name).toContain(response.status);
      expect(h.calls, name).toHaveLength(1);
      expect(h.calls[0]?.props).toEqual(props);
      expect(h.calls[0]?.interfaceVersion).toBe(1);
    }
  });

  it("refuses every invalid and refined fixture before WorkspaceDO", async () => {
    for (const dir of ["invalid", "refined"]) {
      for (const name of jsonFiles("SupervisorMessage", dir)) {
        const h = harness();
        const response = await handleSupervisorMessage(
          post(read("SupervisorMessage", dir, name)),
          props,
          h.deps,
        );
        // Refined fixtures name another computer or generation in the bundle: refused by the
        // schema's refinement (400) before the props comparison could.
        expect(response.status, `${dir}/${name}`).toBe(400);
        expect(h.calls, `${dir}/${name}`).toHaveLength(0);
      }
    }
  });

  it("refuses a message for another computer or another generation than the props", async () => {
    for (const changed of [
      { ...props, computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" },
      { ...props, generation: GENERATION + 1 },
    ]) {
      const h = harness();
      const response = await handleSupervisorMessage(post(hello), changed, h.deps);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "stale_generation" } });
      expect(h.calls).toHaveLength(0);
    }
  });

  it("refuses an unsupported protocol version, a wrong path or method, bad props, junk", async () => {
    const h = harness();
    const v2 = { ...(hello as object), protocolVersion: 2 };
    expect((await handleSupervisorMessage(post(v2), props, h.deps)).status).toBe(400);
    expect(
      (
        await handleSupervisorMessage(
          post(hello, "http://computer.internal/v1/other"),
          props,
          h.deps,
        )
      ).status,
    ).toBe(404);
    expect((await handleSupervisorMessage(new Request(URL_MESSAGES), props, h.deps)).status).toBe(
      400,
    );
    expect(
      (await handleSupervisorMessage(post(hello), { ...props, propsVersion: 2 }, h.deps)).status,
    ).toBe(503);
    expect((await handleSupervisorMessage(post(hello), undefined, h.deps)).status).toBe(503);
    expect((await handleSupervisorMessage(post("{not json"), props, h.deps)).status).toBe(400);
    const invalidUtf8 = new Request(URL_MESSAGES, {
      method: "POST",
      body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    expect((await handleSupervisorMessage(invalidUtf8, props, h.deps)).status).toBe(400);
    const large = post(`{"pad":"${"x".repeat(513 * 1024)}"}`);
    expect((await handleSupervisorMessage(large, props, h.deps)).status).toBe(400);
    const declared = new Request(URL_MESSAGES, {
      method: "POST",
      headers: { "content-length": String(10 ** 9) },
      body: "{}",
    });
    expect((await handleSupervisorMessage(declared, props, h.deps)).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("repeats an unanswered call to WorkspaceDO unchanged, then answers", async () => {
    const h = harness();
    h.script = [new Error(CONNECTION_LOST_MESSAGE), new Error("Durable Object reset"), "ok"];
    const response = await handleSupervisorMessage(post(hello), props, h.deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: "hello", protocolVersion: 1 });
    expect(h.calls).toHaveLength(3);
    expect(new Set(h.calls.map((c) => JSON.stringify(c))).size).toBe(1);
    expect(h.slept).toEqual([100, 400]);
  });

  it("reports retryable unavailable when WorkspaceDO never answers", async () => {
    const h = harness();
    h.script = Array.from({ length: 10 }, () => new Error(CONNECTION_LOST_MESSAGE));
    const response = await handleSupervisorMessage(post(hello), props, h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable", retryable: true },
    });
    expect(h.calls).toHaveLength(INBOUND_RETRY.backoffMs.length + 1);
  });

  it("never repeats a refusal", async () => {
    const h = harness();
    h.script = [platformError("conflict", "no credential checkpoint while restoring")];
    const response = await handleSupervisorMessage(post(hello), props, h.deps);
    expect(response.status).toBe(409);
    expect(h.calls).toHaveLength(1);
  });

  it("treats a reply of another type as unanswered", async () => {
    const h = harness();
    h.deps = { ...h.deps, computer: async () => ({ type: "report", appliedSeq: 1 }) };
    const response = await handleSupervisorMessage(post(hello), props, h.deps);
    expect(response.status).toBe(503);
  });

  it("limits each computer's messages", async () => {
    const h = harness();
    let last = 0;
    for (let i = 0; i <= COMPUTER_API_LIMITS.burst; i += 1) {
      last = (await handleSupervisorMessage(post(hello), props, h.deps)).status;
    }
    expect(last).toBe(429);
    expect(h.calls).toHaveLength(COMPUTER_API_LIMITS.burst);
  });

  it("logs by path and status, never the message", async () => {
    const h = harness();
    const message = read("SupervisorMessage", "credential-checkpoint.json");
    await handleSupervisorMessage(post(message), props, h.deps);
    const text = JSON.stringify(h.logs);
    expect(text).toContain('"path":"/v1/messages"');
    expect(text).not.toContain("content");
    expect(text).not.toContain("bundle");
  });
});

describe("outbound: a command to the supervisor", () => {
  const status = read("WorkspaceCommand", "status.json") as WorkspaceCommand;
  const statusReply = read("WorkspaceCommandReply", "status.json");

  function container(reply: unknown = statusReply, code = 200) {
    const fake = new FakeComputerContainer();
    fake.start({ instance: "standard-2", env: {} });
    fake.supervisor = () => Response.json(reply, { status: code });
    return fake;
  }
  const quick = {
    sleep: async () => undefined,
    clock: (() => {
      let t = 0;
      return () => (t += 10);
    })(),
  };

  it("every command type may be repeated (COMPUTER_API_MESSAGES)", () => {
    for (const name of jsonFiles("WorkspaceCommand")) {
      expect(repeatable((read("WorkspaceCommand", name) as { type: string }).type), name).toBe(
        true,
      );
    }
    expect(repeatable("not_a_message")).toBe(false);
  });

  it("sends one POST to the supervisor's port and parses the reply", async () => {
    const fake = container();
    const outcome = await sendCommand(fake, status, quick);
    expect(outcome).toMatchObject({ kind: "reply", attempts: 1 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.port).toBe(SUPERVISOR_API_PORT);
    expect(fake.requests[0]?.url).toBe("http://computer/v1/commands");
    expect(JSON.parse(fake.requests[0]?.body ?? "")).toEqual(status);
  });

  it("refuses to send a command the contract refuses", async () => {
    const fake = container();
    for (const dir of ["invalid", "refined"]) {
      for (const name of jsonFiles("WorkspaceCommand", dir)) {
        await expect(
          sendCommand(fake, read("WorkspaceCommand", dir, name) as WorkspaceCommand, quick),
          name,
        ).rejects.toThrow();
      }
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("repeats the same bytes after a connection lost before delivery, then succeeds", async () => {
    const fake = container();
    fake.dropRequests = { count: 2, when: "before" };
    const outcome = await sendCommand(fake, status, quick);
    expect(outcome).toMatchObject({ kind: "reply", attempts: 3 });
    expect(new Set(fake.requests.map((r) => r.body)).size).toBe(1);
  });

  it("repeats after a connection lost after delivery: the supervisor sees it twice, by one operation ID", async () => {
    const fake = container();
    const seen: string[] = [];
    fake.supervisor = async (request) => {
      seen.push(((await request.json()) as { operationId: string }).operationId);
      return Response.json(statusReply);
    };
    fake.dropRequests = { count: 1, when: "after" };
    const outcome = await sendCommand(fake, status, quick);
    expect(outcome.kind).toBe("reply");
    expect(seen).toHaveLength(2);
    expect(new Set(seen).size).toBe(1);
  });

  it("reports unknown, never failure, when the connection keeps dropping", async () => {
    const fake = container();
    fake.dropRequests = { count: 100, when: "after" };
    const outcome = await sendCommand(fake, status, quick);
    expect(outcome).toMatchObject({ kind: "unknown", reason: "connection_lost", attempts: 5 });
  });

  it("stops at the deadline", async () => {
    const fake = container();
    fake.dropRequests = { count: 100, when: "before" };
    let now = 0;
    const outcome = await sendCommand(fake, status, {
      sleep: async (ms) => {
        now += ms;
      },
      clock: () => now,
      retry: { backoffMs: [1_000, 1_000, 1_000], deadlineMs: 1_500 },
    });
    expect(outcome.attempts).toBe(2);
  });

  it("separates a command never delivered (not running, not listening) from an unknown one", async () => {
    const stopped = new FakeComputerContainer();
    expect(await sendCommand(stopped, status, quick)).toMatchObject({
      kind: "undelivered",
      reason: "not_running",
      attempts: 1,
    });
    const refused = new FakeComputerContainer();
    refused.refuseStarts = 1;
    refused.start({ instance: "standard-2", env: {} });
    expect(await sendCommand(refused, status, quick)).toMatchObject({
      kind: "undelivered",
      reason: "not_running",
    });
    const quiet = new FakeComputerContainer();
    quiet.start({ instance: "standard-2", env: {} });
    expect(await sendCommand(quiet, status, quick)).toMatchObject({
      kind: "undelivered",
      reason: "not_listening",
      attempts: 5,
    });
    // A lost connection on any attempt makes the outcome unknown.
    quiet.dropRequests = { count: 1, when: "before" };
    expect(await sendCommand(quiet, status, quick)).toMatchObject({ kind: "unknown" });
  });

  it("keeps the outcome unknown when an attempt that may have applied is followed by a refusal (r1-4)", async () => {
    const fake = container();
    let calls = 0;
    fake.supervisor = () => {
      calls += 1;
      return calls === 1
        ? Response.json(statusReply)
        : Response.json(
            { error: { code: "stale_generation", message: "old", retryable: false } },
            { status: 409 },
          );
    };
    fake.dropRequests = { count: 1, when: "after" }; // the first applies, its answer is lost
    const outcome = await sendCommand(fake, status, quick);
    expect(outcome).toMatchObject({
      kind: "unknown",
      reason: "refused_stale_generation_after_lost_answer",
      attempts: 2,
    });
  });

  it("returns a refusal without repeating it, and repeats a retryable one", async () => {
    const refused = container(
      { error: { code: "stale_generation", message: "old", retryable: false } },
      409,
    );
    expect(await sendCommand(refused, status, quick)).toMatchObject({
      kind: "refused",
      code: "stale_generation",
      attempts: 1,
    });
    const busy = container(
      { error: { code: "unavailable", message: "busy", retryable: true } },
      503,
    );
    expect(await sendCommand(busy, status, quick)).toMatchObject({
      kind: "unknown",
      reason: "refused_unavailable",
      attempts: 5,
    });
  });

  it("treats a malformed or mismatched reply as unknown, never as a reply", async () => {
    for (const reply of [
      { type: "status" },
      read("WorkspaceCommandReply", "sign-out.json"),
      "junk",
    ]) {
      const fake = container(reply);
      expect((await sendCommand(fake, status, quick)).kind).toBe("unknown");
    }
    const html = new FakeComputerContainer();
    html.start({ instance: "standard-2", env: {} });
    html.supervisor = () => new Response("<html>", { status: 502 });
    expect(await sendCommand(html, status, quick)).toMatchObject({
      kind: "unknown",
      reason: "unreadable_reply",
    });
  });

  it("parses every valid reply fixture for its own command type", async () => {
    for (const name of jsonFiles("WorkspaceCommandReply")) {
      const reply = read("WorkspaceCommandReply", name) as { type: string };
      const command = jsonFiles("WorkspaceCommand")
        .map((n) => read("WorkspaceCommand", n) as WorkspaceCommand)
        .find(
          (c) => c.type === reply.type || (reply.type === "job_status" && c.type === "job_status"),
        );
      if (!command) continue;
      const outcome = await sendCommand(container(reply), command, quick);
      expect(outcome.kind, name).toBe("reply");
    }
    for (const name of jsonFiles("WorkspaceCommandReply", "invalid")) {
      const outcome = await sendCommand(
        container(read("WorkspaceCommandReply", "invalid", name)),
        status,
        quick,
      );
      expect(outcome.kind, name).toBe("unknown");
    }
  });

  it("classifies what the container port throws", () => {
    expect(classifyFailure(new Error(CONNECTION_LOST_MESSAGE))).toMatchObject({
      maybeDelivered: true,
      retry: true,
    });
    expect(classifyFailure(new DOMException("t", "TimeoutError"))).toMatchObject({
      reason: "timeout",
      maybeDelivered: true,
    });
    expect(classifyFailure(new Error(NO_INSTANCE_MESSAGE))).toMatchObject({
      reason: "not_running",
      maybeDelivered: false,
      retry: false,
    });
    expect(classifyFailure(new Error("Container is not running."))).toMatchObject({
      reason: "not_running",
    });
    expect(
      classifyFailure(new Error("The container is not listening on the TCP address 10.0.0.1:8090")),
    ).toMatchObject({ reason: "not_listening", maybeDelivered: false, retry: true });
    expect(classifyFailure("weird")).toMatchObject({
      reason: "transport_error",
      maybeDelivered: true,
      retry: false,
    });
  });
});

describe("the computer API's defaults", () => {
  it("waits with real timers between inbound attempts, and reads an empty body as not JSON", async () => {
    const h = harness();
    const { sleep: _sleep, clock: _clock, ...rest } = h.deps;
    const deps = { ...rest, retry: { backoffMs: [1], deadlineMs: 1_000 } };
    h.script = [new Error(CONNECTION_LOST_MESSAGE), "ok"];
    expect((await handleSupervisorMessage(post(hello), props, deps)).status).toBe(200);
    const empty = new Request(URL_MESSAGES, { method: "POST" });
    expect((await handleSupervisorMessage(empty, props, deps)).status).toBe(400);
  });

  it("sends with its default options, and waits with real timers between attempts", async () => {
    const status = read("WorkspaceCommand", "status.json") as WorkspaceCommand;
    const fake = new FakeComputerContainer();
    fake.start({ instance: "standard-2", env: {} });
    fake.supervisor = () => Response.json(read("WorkspaceCommandReply", "status.json"));
    expect((await sendCommand(fake, status)).kind).toBe("reply");
    fake.dropRequests = { count: 1, when: "before" };
    const outcome = await sendCommand(fake, status, {
      retry: { backoffMs: [1], deadlineMs: 1_000 },
    });
    expect(outcome).toMatchObject({ kind: "reply", attempts: 2 });
  });

  it("reads an error answer that is not the contract's as unknown", async () => {
    const status = read("WorkspaceCommand", "status.json") as WorkspaceCommand;
    const fake = new FakeComputerContainer();
    fake.start({ instance: "standard-2", env: {} });
    fake.supervisor = () => Response.json({ detail: "bad gateway" }, { status: 502 });
    const outcome = await sendCommand(fake, status, { sleep: async () => undefined });
    expect(outcome).toMatchObject({ kind: "unknown", reason: "status_502" });
  });
});
