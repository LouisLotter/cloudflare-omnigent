import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARING,
  FAKE_OWNER,
  FakeOmnigent,
  FakeOmnigentDroppedError,
  type FakeOmnigentOptions,
  type ScheduledTaskJson,
  type ScheduledTaskListJson,
  type ScheduledTaskRunsJson,
  type SharingJson,
} from "../support/fake-omnigent.ts";

const BASE = "https://omnigent.test";
const OTHER_USER = { userId: "other@example.test", isAdmin: false };

function setup(options: FakeOmnigentOptions = {}) {
  let clock = 1_000;
  const sleeps: number[] = [];
  const fake = new FakeOmnigent({
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    ...options,
  });
  const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    fake.fetch(
      new Request(`${BASE}${path}`, {
        method,
        ...(headers === undefined ? {} : { headers }),
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
    );
  const advance = (seconds: number) => {
    clock += seconds;
  };
  return { fake, call, sleeps, advance };
}

/** Identifies callers by an `x-user` header; no header means no valid login. */
const byHeader: FakeOmnigentOptions["identify"] = (request) => {
  const user = request.headers.get("x-user");
  if (user === null) return null;
  return user === FAKE_OWNER.userId ? FAKE_OWNER : { userId: user, isAdmin: false };
};

// Field order as omnigent/server/routes/scheduled_tasks.py:158-182 emits it.
const TASK_KEYS = [
  "id",
  "name",
  "prompt",
  "rrule",
  "owner_user_id",
  "agent_id",
  "timezone",
  "created_at",
  "model_override",
  "reasoning_effort",
  "permission_mode",
  "max_cost_usd",
  "workspace",
  "host_id",
  "execution_target",
  "state",
  "last_run_at",
  "last_run_status",
  "last_run_conversation_id",
  "next_run_at",
  "updated_at",
];
// omnigent/server/routes/scheduled_tasks.py:191-200.
const RUN_KEYS = [
  "id",
  "scheduled_task_id",
  "status",
  "scheduled_at",
  "conversation_id",
  "fired_at",
  "finished_at",
  "error_code",
];
// omnigent/server/routes/sharing.py:65-88.
const SHARING_KEYS = [
  "object",
  "sharing_mode",
  "editable",
  "options",
  "public_sharing_enabled",
  "public_sharing_editable",
  "public_sharing_max_level",
  "public_sharing_max_level_editable",
  "public_sharing_max_level_options",
  "default_public_sessions",
  "default_public_sessions_editable",
  "default_public_sessions_options",
];

describe("GET /v1/me", () => {
  it("returns the caller's identity", async () => {
    const { call } = setup();
    const response = await call("GET", "/v1/me");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user_id: FAKE_OWNER.userId, is_admin: true });
  });

  it("returns a null user without a login, as header auth does", async () => {
    const { call } = setup({ identify: () => null });
    expect(await (await call("GET", "/v1/me")).json()).toEqual({ user_id: null, is_admin: false });
  });
});

describe("scheduled tasks", () => {
  it("lists the caller's tasks with Omnigent's fields, oldest first", async () => {
    const { fake, call, advance } = setup({ identify: byHeader });
    advance(10);
    const second = fake.addTask({ id: "b".repeat(32), host_id: "host-1", next_run_at: "x" });
    const first = fake.addTask({ id: "a".repeat(32), created_at: 500 });
    fake.addTask({ owner_user_id: OTHER_USER.userId });

    const response = await call("GET", "/v1/scheduled-tasks", undefined, {
      "x-user": FAKE_OWNER.userId,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ScheduledTaskListJson;
    expect(Object.keys(body)).toEqual(["scheduled_tasks"]);
    expect(body.scheduled_tasks.map((task) => task.id)).toEqual([first.id, second.id]);
    for (const task of body.scheduled_tasks) expect(Object.keys(task)).toEqual(TASK_KEYS);
    expect(body.scheduled_tasks[1]).toMatchObject({
      host_id: "host-1",
      next_run_at: "x",
      created_at: 1_010,
      state: "active",
      last_run_status: null,
      updated_at: null,
    });
  });

  it("derives last_run_status from the newest run", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    fake.addRun(task.id, { scheduled_at: 300, status: "failed" });
    fake.addRun(task.id, { scheduled_at: 100, status: "succeeded" });

    const body = (await (
      await call("GET", `/v1/scheduled-tasks/${task.id}`)
    ).json()) as ScheduledTaskJson;

    expect(body.last_run_status).toBe("failed");
  });

  it("answers 404 for a missing task and for another user's task", async () => {
    const { fake, call } = setup({ identify: byHeader });
    const theirs = fake.addTask({ owner_user_id: OTHER_USER.userId });
    const notFound = { error: { code: "not_found", message: "Scheduled task not found" } };

    for (const id of [theirs.id, "f".repeat(32)]) {
      for (const [method, suffix] of [
        ["GET", ""],
        ["GET", "/runs"],
        ["POST", "/run"],
      ] as const) {
        const response = await call(method, `/v1/scheduled-tasks/${id}${suffix}`, undefined, {
          "x-user": FAKE_OWNER.userId,
        });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual(notFound);
      }
    }
    expect(fake.runs(theirs.id)).toEqual([]);
  });

  it("answers 401 without a login", async () => {
    const { fake, call } = setup({ identify: byHeader });
    const task = fake.addTask();
    const unauthorized = { error: { code: "unauthorized", message: "Authentication required" } };

    for (const [method, path] of [
      ["GET", "/v1/scheduled-tasks"],
      ["GET", `/v1/scheduled-tasks/${task.id}`],
      ["GET", `/v1/scheduled-tasks/${task.id}/runs`],
      ["POST", `/v1/scheduled-tasks/${task.id}/run`],
      ["GET", "/v1/sharing"],
      ["PUT", "/v1/sharing"],
    ] as const) {
      const response = await call(
        method,
        path,
        method === "PUT" ? { public_sharing: true } : undefined,
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(unauthorized);
    }
  });

  it("reflects edits made through the fake, bumping updated_at", async () => {
    const { fake, call, advance } = setup();
    const task = fake.addTask();
    advance(60);
    fake.updateTask(task.id, { state: "paused", next_run_at: null });
    expect(fake.updateTask(task.id, { state: "paused" }).updated_at).toBe(1_060);
    advance(60);
    expect(fake.updateTask(task.id, { state: "paused" }).updated_at).toBe(1_060);

    const body = (await (
      await call("GET", `/v1/scheduled-tasks/${task.id}`)
    ).json()) as ScheduledTaskJson;
    expect(body).toMatchObject({ state: "paused", updated_at: 1_060 });

    fake.deleteTask(task.id);
    expect((await call("GET", `/v1/scheduled-tasks/${task.id}`)).status).toBe(404);
  });
});

describe("GET /v1/scheduled-tasks/{id}/runs", () => {
  async function runsPage(call: ReturnType<typeof setup>["call"], path: string) {
    const response = await call("GET", path);
    expect(response.status).toBe(200);
    return (await response.json()) as ScheduledTaskRunsJson;
  }

  it("lists runs newest first, by scheduled_at then id, with Omnigent's fields", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    fake.addRun(task.id, { id: "1".repeat(32), scheduled_at: 100 });
    fake.addRun(task.id, { id: "3".repeat(32), scheduled_at: 200 });
    fake.addRun(task.id, {
      id: "2".repeat(32),
      scheduled_at: 200,
      status: "failed",
      error_code: "timeout",
    });

    const body = await runsPage(call, `/v1/scheduled-tasks/${task.id}/runs`);

    expect(Object.keys(body)).toEqual(["runs", "next_cursor"]);
    expect(body.runs.map((run) => run.id)).toEqual(
      ["3", "2", "1"].map((digit) => digit.repeat(32)),
    );
    for (const run of body.runs) expect(Object.keys(run)).toEqual(RUN_KEYS);
    expect(body.runs[1]).toMatchObject({ scheduled_task_id: task.id, error_code: "timeout" });
    expect(body.next_cursor).toBeNull();
  });

  it("pages with limit and after, ending with a null cursor", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    for (let at = 1; at <= 5; at += 1) fake.addRun(task.id, { scheduled_at: at });
    const path = `/v1/scheduled-tasks/${task.id}/runs?limit=2`;

    const first = await runsPage(call, path);
    const second = await runsPage(call, `${path}&after=${first.next_cursor}`);
    const third = await runsPage(call, `${path}&after=${second.next_cursor}`);

    expect([first, second, third].map((page) => page.runs.map((run) => run.scheduled_at))).toEqual([
      [5, 4],
      [3, 2],
      [1],
    ]);
    expect(first.next_cursor).toBe(first.runs[1]?.id);
    expect(third.next_cursor).toBeNull();
    expect((await runsPage(call, `${path}&after=${"e".repeat(32)}`)).runs).toEqual([]);
  });

  it.each([
    ["0", "greater_than_equal"],
    ["1001", "less_than_equal"],
    ["ten", "int_parsing"],
  ])("rejects limit=%s with FastAPI's 422", async (limit, type) => {
    const { fake, call } = setup();
    const task = fake.addTask();

    const response = await call("GET", `/v1/scheduled-tasks/${task.id}/runs?limit=${limit}`);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      detail: [{ type, loc: ["query", "limit"], input: limit }],
    });
  });
});

describe("POST /v1/scheduled-tasks/{id}/run", () => {
  it("answers 202 and records a running run, as the fire path does", async () => {
    const { fake, call, advance } = setup();
    const task = fake.addTask();
    advance(5);

    const response = await call("POST", `/v1/scheduled-tasks/${task.id}/run`);

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ triggered: true, id: task.id });
    const [run] = fake.runs(task.id);
    expect(run).toMatchObject({ status: "running", scheduled_at: 1_005, fired_at: 1_005 });
    expect(run?.conversation_id).toMatch(/^conv_[0-9a-f]{32}$/);
    expect(fake.task(task.id)).toMatchObject({
      last_run_at: 1_005,
      last_run_conversation_id: run?.conversation_id,
      updated_at: 1_005,
    });
  });
});

describe("sharing", () => {
  it("reports the default settings with Omnigent's fields", async () => {
    const { call } = setup();
    const response = await call("GET", "/v1/sharing");

    expect(response.status).toBe(200);
    const body = (await response.json()) as SharingJson;
    expect(Object.keys(body)).toEqual(SHARING_KEYS);
    expect(body).toEqual(DEFAULT_SHARING);
  });

  it("applies an update and returns the new state", async () => {
    const { fake, call } = setup();

    const response = await call("PUT", "/v1/sharing", {
      sharing_mode: " Read_Only ",
      public_sharing: true,
      default_public_sessions: "sandbox",
      unknown_field: "ignored",
    });

    expect(response.status).toBe(200);
    const expected = {
      ...DEFAULT_SHARING,
      sharing_mode: "read_only",
      public_sharing_enabled: true,
      default_public_sessions: "sandbox",
    };
    expect(await response.json()).toEqual(expected);
    expect(fake.sharing).toEqual(expected);
  });

  it("requires an admin", async () => {
    const { call } = setup({ identify: () => OTHER_USER });
    const forbidden = {
      error: { code: "forbidden", message: "Admin privileges required to manage sharing settings" },
    };

    for (const method of ["GET", "PUT"]) {
      const response = await call(
        method,
        "/v1/sharing",
        method === "PUT" ? { public_sharing: true } : undefined,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(forbidden);
    }
  });

  it("rejects a write to a deployment-managed setting without applying any field", async () => {
    const { fake, call } = setup({ sharing: { public_sharing_editable: false } });

    const response = await call("PUT", "/v1/sharing", {
      sharing_mode: "off",
      public_sharing: true,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "forbidden",
        message: "Public access is managed by this deployment and cannot be changed here.",
      },
    });
    expect(fake.sharing.sharing_mode).toBe("on");
  });

  it.each([
    [{}, 400, "No sharing settings to update."],
    [{ sharing_mode: null }, 400, "No sharing settings to update."],
    [
      { sharing_mode: "wide_open" },
      400,
      "Unknown sharing mode 'wide_open'. Expected one of: on, read_only, restricted_read_only, off.",
    ],
    [{ public_sharing_max_level: "admin" }, 400, "Public permission ceiling must be read or edit."],
    [
      { default_public_sessions: "some" },
      400,
      "Unknown default_public_sessions 'some'. Expected one of: off, sandbox, all.",
    ],
  ])("rejects %j with %i", async (body, status, message) => {
    const { fake, call } = setup();

    const response = await call("PUT", "/v1/sharing", body);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code: "invalid_input", message } });
    expect(fake.sharing).toEqual(DEFAULT_SHARING);
  });

  it("refuses public edit when the server does not offer it", async () => {
    const { call } = setup({ sharing: { public_sharing_max_level_options: ["read"] } });

    const response = await call("PUT", "/v1/sharing", { public_sharing_max_level: "edit" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { message: "Public edit access requires authenticated multi-user access." },
    });
  });

  it.each([
    ["", "missing"],
    ["{not json", "json_invalid"],
    ["[]", "model_attributes_type"],
    [JSON.stringify({ public_sharing: "yes" }), "bool_type"],
    [JSON.stringify({ sharing_mode: 3 }), "string_type"],
  ])("answers 422 for the body %j", async (text, type) => {
    const { call } = setup();

    const response = await call("PUT", "/v1/sharing", text);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ detail: [{ type }] });
  });
});

describe("unknown routes", () => {
  it("answers Starlette's 404 and 405 and logs them without a route", async () => {
    const { fake, call } = setup();

    const missing = await call("GET", "/v1/sessions/abc");
    const wrongMethod = await call("DELETE", "/v1/sharing");

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Not Found" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, PUT");
    expect(fake.requests.map((entry) => [entry.route, entry.status])).toEqual([
      [null, 404],
      [null, 405],
    ]);
  });
});

describe("request log", () => {
  it("records method, path, query, route, headers, body and status", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();

    await call("GET", `/v1/scheduled-tasks/${task.id}/runs?limit=5`, undefined, {
      authorization: "Bearer platform",
    });
    await call("PUT", "/v1/sharing", { public_sharing: true });

    expect(fake.requests).toEqual([
      {
        seq: 1,
        method: "GET",
        path: `/v1/scheduled-tasks/${task.id}/runs`,
        search: "?limit=5",
        route: "GET /v1/scheduled-tasks/{id}/runs",
        headers: { authorization: "Bearer platform" },
        body: null,
        fault: null,
        outcome: "responded",
        status: 200,
      },
      expect.objectContaining({
        seq: 2,
        route: "PUT /v1/sharing",
        body: { public_sharing: true },
        status: 200,
      }),
    ]);
    expect(fake.requestsTo("PUT /v1/sharing")).toHaveLength(1);
    fake.clearRequests();
    expect(fake.requests).toEqual([]);
  });
});

describe("fault injection", () => {
  it("delays a route through the sleep option", async () => {
    const { fake, call, sleeps } = setup();
    fake.inject("GET /v1/me", { delayMs: 250 });

    expect((await call("GET", "/v1/me")).status).toBe(200);
    expect((await call("GET", "/v1/sharing")).status).toBe(200);

    expect(sleeps).toEqual([250]);
  });

  it("shows a delayed request as pending until it completes", async () => {
    let release = () => {};
    const { fake, call } = setup({
      sleep: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    fake.inject("GET /v1/me", { delayMs: 1 });

    const pending = call("GET", "/v1/me");
    expect(fake.requests.map((entry) => entry.outcome)).toEqual(["pending"]);
    release();
    await pending;

    expect(fake.requests.map((entry) => entry.outcome)).toEqual(["responded"]);
  });

  it("answers an injected status with Omnigent's error body, without applying the change", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    fake.inject("POST /v1/scheduled-tasks/{id}/run", { status: 503 });

    const response = await call("POST", `/v1/scheduled-tasks/${task.id}/run`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "runner_unavailable", message: "Injected fault: 503" },
    });
    expect(fake.runs(task.id)).toEqual([]);
  });

  it("can send a custom error body, such as a proxy's text page", async () => {
    const { fake, call } = setup();
    fake.inject("GET /v1/sharing", { status: 502, body: "Bad gateway" });
    fake.inject("GET /v1/me", {
      status: 409,
      body: { error: { code: "conflict", message: "busy" } },
    });

    const text = await call("GET", "/v1/sharing");
    expect(text.status).toBe(502);
    expect(await text.text()).toBe("Bad gateway");
    expect(await (await call("GET", "/v1/me")).json()).toEqual({
      error: { code: "conflict", message: "busy" },
    });
  });

  it("drops a request before it changes anything", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    fake.inject("POST /v1/scheduled-tasks/{id}/run", { drop: "request" });

    const result = call("POST", `/v1/scheduled-tasks/${task.id}/run`);

    await expect(result).rejects.toBeInstanceOf(FakeOmnigentDroppedError);
    await expect(result).rejects.toMatchObject({ phase: "request" });
    expect(fake.runs(task.id)).toEqual([]);
    expect(fake.requests[0]).toMatchObject({ outcome: "dropped", status: null });
  });

  it("drops a response after the change was applied", async () => {
    const { fake, call } = setup();
    const task = fake.addTask();
    fake.inject("POST /v1/scheduled-tasks/{id}/run", { drop: "response" });

    await expect(call("POST", `/v1/scheduled-tasks/${task.id}/run`)).rejects.toMatchObject({
      name: "FakeOmnigentDroppedError",
      phase: "response",
    });

    expect(fake.runs(task.id)).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ outcome: "dropped", status: 202 });
  });

  it("applies a fault the given number of times", async () => {
    const { fake, call } = setup();
    fake.inject("GET /v1/me", { status: 500, times: 2 });

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1)
      statuses.push((await call("GET", "/v1/me")).status);

    expect(statuses).toEqual([500, 500, 200]);
  });

  it("applies a wildcard fault to every route, unless the route has its own", async () => {
    const { fake, call } = setup();
    fake.inject("*", { status: 503 });
    fake.inject("GET /v1/me", { delayMs: 0 });

    expect((await call("GET", "/v1/sharing")).status).toBe(503);
    expect((await call("GET", "/v1/unknown")).status).toBe(503);
    expect((await call("GET", "/v1/me")).status).toBe(200);

    fake.clearFaults("*");
    expect((await call("GET", "/v1/sharing")).status).toBe(200);
    fake.clearFaults();
    await call("GET", "/v1/me");
    expect(fake.requests.at(-1)?.fault).toBeNull();
  });

  it("records the fault in the request log", async () => {
    const { fake, call } = setup();
    fake.inject("GET /v1/me", { status: 500 });

    await call("GET", "/v1/me");

    expect(fake.requests[0]?.fault).toEqual({ status: 500 });
  });

  it.each([
    [{ delayMs: -1 }, "delayMs"],
    [{ status: 200 }, "status"],
    [{ status: 503, drop: "response" as const }, "both"],
    [{ times: 0 }, "times"],
  ])("rejects the invalid fault %j", (fault, message) => {
    const { fake } = setup();
    expect(() => fake.inject("GET /v1/me", fault)).toThrow(message);
  });
});

describe("state helpers", () => {
  it("returns copies, so tests cannot change the fake's state by accident", () => {
    const { fake } = setup();
    const task = fake.addTask();
    task.name = "changed";
    const sharing = fake.sharing;
    sharing.options.pop();

    expect(fake.task(task.id)?.name).toBe("Scheduled task");
    expect(fake.sharing.options).toHaveLength(4);
  });

  it("refuses duplicate ids and unknown tasks or runs", () => {
    const { fake } = setup();
    const task = fake.addTask();

    expect(() => fake.addTask({ id: task.id })).toThrow("already exists");
    expect(() => fake.addRun("missing")).toThrow("no task");
    expect(() => fake.updateTask("missing", {})).toThrow("no task");
    expect(() => fake.updateRun("missing", {})).toThrow("no run");
  });

  it("deletes a task's runs with it", () => {
    const { fake } = setup();
    const task = fake.addTask();
    const run = fake.addRun(task.id);
    fake.updateRun(run.id, { status: "failed" });

    fake.deleteTask(task.id);

    expect(fake.runs(task.id)).toEqual([]);
    expect(fake.tasks()).toEqual([]);
  });

  it("uses the system clock and setTimeout by default", async () => {
    const fake = new FakeOmnigent();
    const before = Math.floor(Date.now() / 1000);
    fake.inject("GET /v1/me", { delayMs: 1 });

    const response = await fake.fetch(new Request(`${BASE}/v1/me`));

    expect(response.status).toBe(200);
    expect(fake.addTask().created_at).toBeGreaterThanOrEqual(before);
  });
});
