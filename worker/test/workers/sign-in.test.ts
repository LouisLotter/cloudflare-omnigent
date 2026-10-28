// Sign-in from the page, the status and the staging switch (WP3.23) in the Workers runtime: web.ts's
// routes → the WORKSPACE binding → the real WorkspaceDO (page front, controller) → a simulated
// computer whose supervisor fences sign-in attempts as the real one does. The object is evicted
// after each persisted step. The fake CLI's synthetic link states, codes and device codes carry
// the canary prefix; none may reach the Durable Object's storage or the Worker's logs.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ComputerId,
  type SupervisorMessage,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { workspaceObjectName } from "../../src/shared/rpc.ts";
import { routeAdmitted } from "../../src/web.ts";
import { FakeLauncherClient } from "../support/fake-launcher-client.ts";
import type { SimulatedComputer, SupervisorOptions } from "../support/fake-supervisor.ts";
import type { WorkspaceUnderFakes as WorkspaceDO } from "../support/platform-test-worker.ts";
import { testComputers } from "../support/workspace-harness.ts";

type Stub = DurableObjectStub<WorkspaceDO>;
const workspaces = (env as unknown as { WORKSPACE_CONTROLLER: DurableObjectNamespace<WorkspaceDO> })
  .WORKSPACE_CONTROLLER;
const ORIGIN = "https://omnigent.example.test";
const OWNER = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const OTHER_TAB_SESSION = "cd".repeat(32);
const HOST = "7f3c2a9e4b1d4e8a9c2f1a2b3c4d5e6f";
const call = { interfaceVersion: WORKSPACE_INTERFACE_VERSION };

const webEnv = {
  OMNIGENT: env.OMNIGENT,
  WORKSPACE: workspaces,
  CONTROL: {
    getByName: () => ({ control: async () => ({ method: "list_computers", computers: [] }) }),
  },
} as unknown as WebEnv;

let serial = 0;
const logs: string[] = [];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function settle(stub: Stub, computer: SimulatedComputer): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await stub.settle();
    const sup = computer.sup;
    if (sup === null || sup.outbox.length === 0) return;
    await sup.flush((message: SupervisorMessage) =>
      stub.computer({
        ...call,
        props: {
          propsVersion: 1,
          computerId: computer.computerId,
          generation: message.generation,
          hostId: HOST,
        },
        message,
      }),
    );
  }
}

async function running(options: Partial<SupervisorOptions> = {}, staging = false) {
  serial += 1;
  const computerId = `cmp_01hzy3m8k6q4t2v9w7x5s1${String(serial).padStart(4, "0")}` as ComputerId;
  if (staging) testComputers.staging.add(computerId);
  const stub = workspaces.getByName(workspaceObjectName(computerId)) as Stub;
  const computer = testComputers.create(stub.id, computerId);
  computer.supervisorOptions = options;
  const client = new FakeLauncherClient(computerId, (request) =>
    stub.launcher({ ...call, request }),
  );
  await client.send(client.provisionRequest(`managed-s${serial}`));
  await client.send(client.resumeRequest());
  await settle(stub, computer);
  const claim = await client.send(client.claimRequest());
  if (claim.operation !== "claim_start" || !claim.granted) throw new Error("claim refused");
  await client.send(
    client.startRequest({
      attempt: claim.startAttempt,
      token: `synthetic-launch-token-workers-wp323-${String(serial).padStart(6, "0")}`,
      hostId: HOST,
    }),
  );
  testComputers.advance(2_000);
  await runDurableObjectAlarm(stub);
  await settle(stub, computer);
  return { computerId, stub, computer, client, path: `/platform/computers/${computerId}` };
}

function route(path: string, init: RequestInit = {}, sessionId = OWNER.sessionId) {
  const admitted: Admitted = {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { sub: OWNER.sub, sessionId, issuedAt: 1, expiresAt: 2 },
  };
  return routeAdmitted(admitted, webEnv, {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext);
}

async function intentOf(path: string, sessionId = OWNER.sessionId): Promise<string> {
  const html = await (await route(path, {}, sessionId)).text();
  const match = /data-intent="([0-9a-f]{64})"/.exec(html);
  if (!match?.[1]) throw new Error("no intent token on the page");
  return match[1];
}

let ops = 0;
const op = () => {
  ops += 1;
  return `op_${String(ops).padStart(26, "0")}`;
};

async function post(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { origin: ORIGIN },
  sessionId = OWNER.sessionId,
) {
  const response = await route(
    `${path}/sign-in`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ op: op(), ...body }),
    },
    sessionId,
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function read(path: string, service: string, attempt: number, sessionId = OWNER.sessionId) {
  const response = await route(
    `${path}/sign-in?service=${service}&attempt=${attempt}`,
    {},
    sessionId,
  );
  return (await response.json()) as Record<string, unknown>;
}

const view = (answer: Record<string, unknown>) =>
  answer.view as { state: string; attempt: number; url?: string; userCode?: string };

function starts(computer: SimulatedComputer) {
  return computer.supervisors.flatMap((s) => s.commands).filter((c) => c.type === "sign_in_start");
}

/** No sign-in value in the object's storage or in any log line so far. */
async function noSecrets(stub: Stub, computer: SimulatedComputer) {
  const values = computer.supervisors.flatMap((s) => s.issuedValues);
  expect(values.length).toBeGreaterThan(0);
  const rows = await runInDurableObject(stub, (_i: WorkspaceDO, state) =>
    state.storage.sql
      .exec<{ key: string; value: string }>("SELECT key, value FROM workspace_kv")
      .toArray(),
  );
  const stored = JSON.stringify(rows);
  const logged = logs.join("\n");
  for (const value of values) {
    expect(stored.includes(value), "a sign-in value in storage").toBe(false);
    expect(logged.includes(value), "a sign-in value in the logs").toBe(false);
  }
}

describe("sign-in through the pages and the real WorkspaceDO", () => {
  it("signs in to Claude and Codex, evicted after each persisted step; nothing kept", async () => {
    const { stub, computer, path } = await running();
    const intent = await intentOf(path);
    const started = await post(path, { intent, mode: "start", service: "claude" });
    expect(started.status).toBe(200);
    expect(view(started.json).state).toBe("awaiting_user");
    const attempt = view(started.json).attempt;
    await evictDurableObject(stub);
    const status = await read(path, "claude", attempt);
    expect(view(status).url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
    // A reload of the page resumes the session's attempt.
    expect(await (await route(path)).text()).toContain(
      `data-resume="[{&quot;service&quot;:&quot;claude&quot;,&quot;attempt&quot;:${attempt}}]"`,
    );
    await evictDurableObject(stub);
    const code = computer.sup?.issued.claude?.code ?? "";
    const done = await post(path, { intent, mode: "input", service: "claude", attempt, code });
    expect(view(done.json).state).toBe("done");
    await evictDurableObject(stub);
    await settle(stub, computer);
    const codex = await post(path, { intent, mode: "start", service: "codex" });
    expect(view(codex.json).userCode).toBe(computer.sup?.issued.codex?.userCode);
    await evictDurableObject(stub);
    computer.sup?.approve("codex");
    await settle(stub, computer);
    testComputers.advance(20_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    const state = await stub.pages({ ...call, action: "state" });
    expect(
      (state as { computer: { setupCards: { state: string }[] } }).computer.setupCards.map(
        (c) => c.state,
      ),
    ).toEqual(["signed_in", "signed_in"]);
    await noSecrets(stub, computer);
  });

  it("refuses changes without the exact origin or this session's token, and a GET changes nothing", async () => {
    const { stub, computer, path } = await running();
    const intent = await intentOf(path);
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { origin: ORIGIN, "sec-fetch-site": "cross-site" },
      {} as Record<string, string>,
    ]) {
      expect((await post(path, { intent, mode: "start", service: "claude" }, headers)).status).toBe(
        403,
      );
    }
    // Another session's token is not this session's.
    const other = await intentOf(path, OTHER_TAB_SESSION);
    expect((await post(path, { intent: other, mode: "start", service: "claude" })).status).toBe(
      403,
    );
    expect(
      (await post(path, { intent: "00".repeat(32), mode: "start", service: "claude" })).status,
    ).toBe(403);
    // A GET, even one shaped like a change, only reads.
    await route(`${path}/sign-in?service=claude&attempt=1&mode=start&intent=${intent}`);
    await route(`${path}/status`);
    expect(
      (await route(`${path}/status`, { method: "POST", headers: { origin: ORIGIN } })).status,
    ).toBe(405);
    await settle(stub, computer);
    expect(starts(computer)).toEqual([]);
    expect(
      (
        await runInDurableObject(stub, (_i: WorkspaceDO, state) =>
          state.storage.sql
            .exec<{ value: string }>("SELECT value FROM workspace_kv WHERE key = 'computer'")
            .one(),
        )
      ).value,
    ).toContain('"signIn":{"next":0');
  });

  it("fences a stale tab: a newer start supersedes it, its code and cancel are refused", async () => {
    const { stub, computer, path } = await running();
    const intent = await intentOf(path);
    const otherIntent = await intentOf(path, OTHER_TAB_SESSION);
    const first = view(
      (await post(path, { intent, mode: "start", service: "claude" })).json,
    ).attempt;
    await evictDurableObject(stub);
    const second = view(
      (
        await post(
          path,
          { intent: otherIntent, mode: "start", service: "claude" },
          { origin: ORIGIN },
          OTHER_TAB_SESSION,
        )
      ).json,
    ).attempt;
    expect(second).toBeGreaterThan(first);
    await evictDurableObject(stub);
    expect(view(await read(path, "claude", first)).state).toBe("superseded");
    const input = await post(path, {
      intent,
      mode: "input",
      service: "claude",
      attempt: first,
      code: "x#y",
    });
    expect(input.json).toMatchObject({ outcome: "refused", reason: "stale" });
    const cancel = await post(path, { intent, mode: "cancel", service: "claude", attempt: first });
    expect(cancel.json).toMatchObject({ outcome: "refused", reason: "stale" });
    // The newer attempt is the other session's: this one cannot read or cancel it.
    expect(await read(path, "claude", second)).toMatchObject({
      outcome: "refused",
      reason: "not_yours",
    });
    await settle(stub, computer);
    expect(view(await read(path, "claude", second, OTHER_TAB_SESSION)).state).toBe("awaiting_user");
  });

  it("delivers a start whose reply was lost, and never one cancelled before it arrived", async () => {
    const { stub, computer, path } = await running();
    const intent = await intentOf(path);
    const handler = computer.supervisor;
    if (handler === null) throw new Error("no supervisor");
    const unavailable = () =>
      Response.json(
        { error: { code: "unavailable", message: "lost", retryable: true } },
        { status: 503 },
      );
    // `mode` for one command type: `lost` (the supervisor takes it, its reply is lost) or `unsent`.
    const fault = (type: string, mode: "lost" | "unsent") => {
      computer.supervisor = async (request) => {
        const body = (await request.clone().json()) as { type?: string };
        if (body.type !== type) return handler(request);
        if (mode === "lost") await handler(request);
        return unavailable();
      };
    };
    fault("sign_in_start", "lost");
    const lost = view((await post(path, { intent, mode: "start", service: "codex" })).json);
    expect(lost.state).toBe("starting");
    computer.supervisor = handler;
    await evictDurableObject(stub);
    testComputers.advance(2_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    expect(view(await read(path, "codex", lost.attempt)).state).toBe("awaiting_user");
    // A start that never left, then its cancel, also unsent: after an eviction the runner
    // delivers the cancel, and never the start.
    fault("sign_in_start", "unsent");
    const held = view((await post(path, { intent, mode: "start", service: "claude" })).json);
    fault("sign_in_cancel", "unsent");
    const cancel = await post(path, {
      intent,
      mode: "cancel",
      service: "claude",
      attempt: held.attempt,
    });
    expect(view(cancel.json).state).toBe("cancelled");
    computer.supervisor = handler;
    await evictDurableObject(stub);
    testComputers.advance(2_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    const sent = computer.supervisors.flatMap((s) => s.commands) as {
      type: string;
      attempt?: number;
    }[];
    expect(new Set(sent.filter((c) => c.type === "sign_in_start").map((c) => c.attempt))).toEqual(
      new Set([lost.attempt]),
    );
    expect(sent.some((c) => c.type === "sign_in_cancel" && c.attempt === held.attempt)).toBe(true);
  });

  it("holds the computer awake through the sleep and deadline boundaries, then lets go", async () => {
    const { stub, computer, client, path } = await running();
    const intent = await intentOf(path);
    await post(path, { intent, mode: "start", service: "claude" });
    if (computer.sup) computer.sup.runnerProcesses = 0;
    await evictDurableObject(stub);
    expect(await client.send(client.suspendRequest())).toMatchObject({
      outcome: "refused",
      reason: "terminal_open",
    });
    testComputers.advance(9 * 60_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    await evictDurableObject(stub);
    expect(await client.send(client.suspendRequest())).toMatchObject({
      outcome: "refused",
      reason: "terminal_open",
    });
    testComputers.advance(61_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    await evictDurableObject(stub);
    expect(await client.send(client.suspendRequest())).toEqual({
      operation: "suspend",
      outcome: "in_progress",
    });
  });
});

describe("the status and the staging switch in the Workers runtime", () => {
  it("reads the status with a GET, and logs computer_status with names and counts", async () => {
    const { stub, computer, path } = await running();
    const response = await route(`${path}/status`);
    const body = (await response.json()) as { status: { supervisor: string }; html: string };
    expect(body.status.supervisor).toBe("ok");
    expect(body.html).toContain("Claude Code 2.1.311");
    testComputers.advance(5 * 60_000);
    await runDurableObjectAlarm(stub);
    await settle(stub, computer);
    const lines = logs.filter((l) => l.includes('"event":"computer_status"'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toContain('"versions":{"claude":"2.1.311"');
  });

  it("refuses the switch on production and stores nothing; applies it on staging, evicted", async () => {
    const production = await running();
    const intent = await intentOf(production.path);
    const switchIt = (path: string, token: string, rc53: string) =>
      route(`${path}/staging-check`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ op: op(), intent: token, rc53 }),
      });
    const refused = await switchIt(production.path, intent, "on");
    expect(await refused.json()).toMatchObject({ outcome: "refused", reason: "not_staging" });
    expect(await (await route(production.path)).text()).not.toContain("RC-53 save check (staging)");
    const staging = await running({}, true);
    const stagingIntent = await intentOf(staging.path);
    expect(await (await switchIt(staging.path, stagingIntent, "on")).json()).toMatchObject({
      outcome: "accepted",
      rc53: true,
    });
    await evictDurableObject(staging.stub);
    testComputers.advance(2_000);
    await runDurableObjectAlarm(staging.stub);
    await settle(staging.stub, staging.computer);
    expect(staging.computer.sup?.rc53).toBe(true);
    const status = (await (await route(`${staging.path}/status`)).json()) as { html: string };
    expect(status.html).toContain("RC-53 save check (staging)");
    expect(status.html).toContain("On the computer now: on.");
    expect(production.computer.sup?.rc53).toBe(false);
  });
});
