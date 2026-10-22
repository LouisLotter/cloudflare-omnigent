// The harness Worker's Durable Object and routes, against in-memory fakes of its storage, its
// container and R2 (Node; `cloudflare:workers` is replaced by a minimal base class). The
// container's port 8002 is a scripted harness. What matters here: the token reaches only the
// container's environment and is gone when a run ends; results land in R2 under the run;
// the replacement is timed; and every state change needs the same origin and an intent token.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    protected readonly ctx: unknown;
    protected readonly env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { DrillRun, default: worker } = await import("./src/index.ts");

const ACCOUNT = `${"0".repeat(31)}1`; // synthetic
const SECRET = "5".repeat(64); // synthetic
const CREDS = {
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  accessKeyId: "7".repeat(32),
  secretAccessKey: SECRET,
};
const ORIGIN = "https://cfo-stg-wp25-drill.example.test";

class FakeStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries = typeof key === "string" ? { [key]: value } : key;
    for (const [k, v] of Object.entries(entries)) this.data.set(k, structuredClone(v));
  }
  async delete(key: string | string[]): Promise<boolean | number> {
    if (typeof key === "string") return this.data.delete(key);
    return key.filter((k) => this.data.delete(k)).length;
  }
  async setAlarm(at: number): Promise<void> {
    this.alarm = at;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

interface Harness {
  status: Record<string, unknown>;
  results: Record<string, unknown>;
}

class FakeContainer {
  running = false;
  starts: Record<string, string>[] = [];
  signals: number[] = [];
  harness: Harness | null = null;
  healthy = false;
  failStart = false;
  /** Runs inside destroy(), between its start and its end: another event arriving meanwhile. */
  duringDestroy: (() => Promise<void>) | null = null;
  /** Runs inside a status fetch, before it answers: another event arriving meanwhile. */
  duringStatus: (() => Promise<void>) | null = null;
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void {
    expect(options.enableInternet).toBe(true);
    if (this.failStart) throw new Error("synthetic start failure");
    this.running = true;
    this.starts.push(options.env ?? {});
  }
  async monitor(): Promise<void> {}
  signal(signo: number): void {
    this.signals.push(signo);
  }
  async destroy(): Promise<void> {
    const interleaved = this.duringDestroy;
    this.duringDestroy = null;
    if (interleaved !== null) await interleaved();
    this.running = false;
  }
  getTcpPort(port: number) {
    return {
      fetch: async (input: string) => {
        const path = new URL(input).pathname;
        if (port === 8000) return new Response("", { status: this.healthy ? 200 : 503 });
        if (port !== 8002 || this.harness === null) throw new Error("connection refused");
        if (path === "/status") {
          const answer = this.harness.status;
          const interleaved = this.duringStatus;
          this.duringStatus = null;
          if (interleaved !== null) await interleaved();
          return Response.json(answer);
        }
        const name = path.replace("/results/", "");
        const result = this.harness.results[name];
        return result === undefined ? new Response("{}", { status: 404 }) : Response.json(result);
      },
    };
  }
}

class FakeR2 {
  objects = new Map<string, string>();
  failing = false;
  async put(key: string, value: string): Promise<void> {
    if (this.failing) throw new Error("synthetic R2 failure");
    this.objects.set(key, value);
  }
}

function status(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 1,
    mode: "measure",
    phase: "env",
    done: false,
    results: [],
    errors: {},
    awaiting_replacement: null,
    ...fields,
  };
}

let storage: FakeStorage;
let container: FakeContainer;
let r2: FakeR2;
let drill: InstanceType<typeof DrillRun>;
let env: Record<string, unknown>;
let logs: string[];

beforeEach(() => {
  storage = new FakeStorage();
  container = new FakeContainer();
  r2 = new FakeR2();
  env = {
    RESULTS: r2,
    REPLICA_BUCKET: "cfo-stg-wp25-drill-db",
    DRILL_PLAN: "all",
    DRILL_BARRIER_WRITES: "300",
    DRILL_BARRIER_ITEMS: "150",
    DRILL_IDLE_S: "480",
  };
  const ctx = { storage, container, waitUntil: () => undefined };
  drill = new DrillRun(ctx as never, env as never);
  env.DRILL = { idFromName: () => "id", get: () => drill };
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: string) => {
    logs.push(String(line));
  });
});

function everythingKept(): string {
  return [JSON.stringify([...storage.data.entries()]), ...r2.objects.values(), ...logs].join("\n");
}

async function started(): Promise<string> {
  const result = await drill.run(CREDS);
  expect(result.status).toBe(202);
  return String(result.body.runId);
}

describe("run", () => {
  it("refuses a bad token without storing or starting anything", async () => {
    const result = await drill.run({ ...CREDS, endpoint: "https://example.com" });
    expect(result.status).toBe(400);
    expect(container.starts).toEqual([]);
    expect(storage.data.size).toBe(0);
  });

  it("starts the measurement container with the token as Litestream's variables only", async () => {
    const runId = await started();
    expect(runId).toMatch(/^run-\d{8}t\d{6}z-[0-9a-f]{6}$/);
    const started_ = container.starts[0] ?? {};
    expect(started_.DRILL_MODE).toBe("measure");
    expect(started_.LITESTREAM_SECRET_ACCESS_KEY).toBe(SECRET);
    expect(Object.entries(started_).filter(([, v]) => v === SECRET)).toHaveLength(1);
    expect(storage.alarm).not.toBeNull();
    expect((await drill.run(CREDS)).status).toBe(409);
    const shown = JSON.stringify(await drill.status());
    expect(shown).not.toContain(SECRET);
    expect(shown).toContain('"holdsToken": true'.replace(": ", ":"));
    expect(logs.join("\n")).not.toContain(SECRET);
  });

  it("forgets the token when the container cannot start", async () => {
    // Codex review r1, finding 2.
    container.failStart = true;
    const result = await drill.run(CREDS);
    expect(result.status).toBe(502);
    expect(String(result.body.error)).not.toContain(SECRET);
    expect(storage.data.has("creds")).toBe(false);
    expect(storage.data.has("settings")).toBe(false);
    expect((await storage.get<Record<string, unknown>>("run"))?.outcome).toBe("failed");
    expect(storage.alarm).toBeNull();
  });
});

describe("alarm", () => {
  it("stores results, replaces the container, times it, and forgets the token at the end", async () => {
    const runId = await started();
    container.harness = {
      status: status({ results: ["env"] }),
      results: { env: { phase: "env", litestream: "0.5.17" } },
    };
    await drill.alarm();
    expect(JSON.parse(r2.objects.get(`results/${runId}/env.json`) ?? "{}")).toEqual({
      phase: "env",
      litestream: "0.5.17",
    });

    // The harness asks for the replacement; its last result is stored first.
    container.harness = {
      status: status({
        results: ["env", "cf-replacement"],
        phase: "awaiting-replacement",
        awaiting_replacement: { prefix: "restore-1000mb", manifest: "{}", filler_rows: 9 },
      }),
      results: { env: {}, "cf-replacement": { phase: "cf-replacement" } },
    };
    await drill.alarm();
    expect(r2.objects.has(`results/${runId}/cf-replacement.json`)).toBe(true);
    expect(container.signals).toEqual([]); // nothing irreversible in the alarm that stored
    await drill.alarm();
    expect(container.signals).toEqual([9]);
    const replaced = container.starts[1] ?? {};
    expect(replaced).toMatchObject({
      DRILL_MODE: "replaced",
      DRILL_REPLACED_PREFIX: "restore-1000mb",
      DRILL_REPLACED_FILLER_ROWS: "9",
      DRILL_RUN_ID: runId,
    });
    expect(container.starts[0]?.DRILL_OWNER_PASSWORD).toBe(replaced.DRILL_OWNER_PASSWORD);

    // The new container's server answers; the Durable Object records the timings.
    container.harness = {
      status: status({ mode: "replaced", phase: "replaced", results: [] }),
      results: {},
    };
    container.healthy = true;
    await drill.alarm();
    const timing = JSON.parse(r2.objects.get(`results/${runId}/cf-replacement-do.json`) ?? "{}");
    expect(timing.timings.lossToHealthyMs).toBeGreaterThanOrEqual(0);
    expect(timing.healthyAt).toBeGreaterThanOrEqual(timing.startCalledAt);

    // Done: the result is stored, the container stopped, the token deleted.
    container.harness = {
      status: status({ mode: "replaced", done: true, results: ["cf-replacement-container"] }),
      results: { "cf-replacement-container": { ok: true } },
    };
    await drill.alarm();
    expect(r2.objects.has(`results/${runId}/cf-replacement-container.json`)).toBe(true);
    await drill.alarm(); // every result stored: now the run ends
    const summary = JSON.parse(r2.objects.get(`results/${runId}/summary.json`) ?? "{}");
    expect(summary.outcome).toBe("done");
    expect(summary.stored).toEqual(["env", "cf-replacement", "cf-replacement-container"]);
    expect(summary.missingResults).toEqual([]);
    expect(container.running).toBe(false);
    expect(storage.data.has("creds")).toBe(false);
    expect(storage.data.has("settings")).toBe(false);
    expect(storage.alarm).toBeNull();
    expect(everythingKept()).not.toContain(SECRET);
    expect(everythingKept()).not.toContain(String(container.starts[0]?.DRILL_OWNER_PASSWORD));
    await drill.alarm(); // a stray alarm after the end does nothing
    expect(container.starts).toHaveLength(2);
  });

  it("never starts the replaced container after a stop that came in during the kill", async () => {
    // Codex review r1, finding 1.
    const runId = await started();
    const awaiting = { prefix: "restore-1000mb", manifest: "{}", filler_rows: 9 };
    container.harness = {
      status: status({ results: ["cf-replacement"], awaiting_replacement: awaiting }),
      results: { "cf-replacement": {} },
    };
    await drill.alarm(); // stores
    container.duringDestroy = () => drill.stop();
    await drill.alarm(); // replaces; Stop arrives while the container is being killed
    expect(container.starts).toHaveLength(1);
    expect(container.running).toBe(false);
    const run = await storage.get<Record<string, unknown>>("run");
    expect(run?.outcome).toBe("stopped");
    expect(run?.runId).toBe(runId);
    expect(storage.data.has("creds")).toBe(false);
    expect(storage.alarm).toBeNull();
    await drill.alarm();
    expect(container.starts).toHaveLength(1);
  });

  it("keeps the container and retries while a result cannot be stored", async () => {
    // Codex review r1, finding 4.
    const runId = await started();
    container.harness = {
      status: status({ done: true, results: ["env"] }),
      results: { env: { ok: true } },
    };
    r2.failing = true;
    await drill.alarm();
    await drill.alarm();
    expect(container.running).toBe(true);
    expect((await storage.get<Record<string, unknown>>("run"))?.outcome).toBeUndefined();
    r2.failing = false;
    await drill.alarm(); // stored
    await drill.alarm(); // then done
    expect(r2.objects.has(`results/${runId}/env.json`)).toBe(true);
    expect((await storage.get<Record<string, unknown>>("run"))?.outcome).toBe("done");
  });

  it("names a result lost at the end of the window", async () => {
    const runId = await started();
    container.harness = { status: status({ results: ["env"] }), results: { env: {} } };
    r2.failing = true;
    await drill.alarm();
    const run = (await storage.get<Record<string, unknown>>("run")) ?? {};
    await storage.put("run", { ...run, armedUntil: Date.now() - 1 });
    r2.failing = false;
    container.harness = { status: status({ results: ["env", "drill"] }), results: {} };
    await drill.alarm();
    const summary = JSON.parse(r2.objects.get(`results/${runId}/summary.json`) ?? "{}");
    expect(summary.outcome).toBe("expired");
    expect(summary.missingResults).toEqual(["env", "drill"]);
  });

  it("a stale alarm never touches a newer run's container or token (Codex review r2)", async () => {
    const first = await started();
    container.harness = { status: status({ done: true, results: [] }), results: {} };
    let second = "";
    // Run A's alarm waits on the harness; meanwhile the owner stops A and starts B.
    container.duringStatus = async () => {
      await drill.stop();
      const result = await drill.run(CREDS);
      second = String(result.body.runId);
    };
    await drill.alarm(); // A's alarm resumes with A's "done"
    const run = await storage.get<Record<string, unknown>>("run");
    expect(second).not.toBe(first);
    expect(run?.runId).toBe(second);
    expect(run?.outcome).toBeUndefined();
    expect(container.running).toBe(true);
    expect(container.starts).toHaveLength(2);
    expect(storage.data.has("creds")).toBe(true);
    expect(storage.alarm).not.toBeNull();
  });

  it("keeps the replacement's timing and its alarm when R2 fails (Codex review r2)", async () => {
    await started();
    const awaiting = { prefix: "restore-1000mb", manifest: "{}", filler_rows: 9 };
    container.harness = {
      status: status({ results: ["cf-replacement"], awaiting_replacement: awaiting }),
      results: { "cf-replacement": {} },
    };
    await drill.alarm(); // stored
    await drill.alarm(); // replaced
    container.harness = { status: status({ mode: "replaced", phase: "replaced" }), results: {} };
    container.healthy = true;
    r2.failing = true;
    await drill.alarm();
    const run = await storage.get<{ replacement?: { healthyAt?: number }; outcome?: string }>(
      "run",
    );
    expect(run?.replacement?.healthyAt).toBeGreaterThan(0);
    expect(run?.outcome).toBeUndefined();
    expect(storage.alarm).not.toBeNull();
    expect(storage.data.has("creds")).toBe(true);
  });

  it("reschedules itself when something in the alarm throws", async () => {
    await started();
    container.harness = { status: status({ results: ["env"] }), results: { env: {} } };
    const original = storage.put.bind(storage);
    let calls = 0;
    storage.put = async (key: string | Record<string, unknown>, value?: unknown) => {
      calls += 1;
      if (key === "run") throw new Error("synthetic storage failure");
      return original(key, value);
    };
    await drill.alarm();
    storage.put = original;
    expect(calls).toBeGreaterThan(0);
    expect(storage.alarm).not.toBeNull();
    expect(storage.data.has("creds")).toBe(true);
  });

  it("expires a run at the end of its window", async () => {
    await started();
    const run = (await storage.get<Record<string, unknown>>("run")) ?? {};
    await storage.put("run", { ...run, armedUntil: Date.now() - 1 });
    container.harness = { status: status(), results: {} };
    await drill.alarm();
    expect((await storage.get<Record<string, unknown>>("run"))?.outcome).toBe("expired");
    expect(storage.data.has("creds")).toBe(false);
    expect(container.running).toBe(false);
  });

  it("stop ends the run and deletes the token", async () => {
    await started();
    await drill.stop();
    expect((await storage.get<Record<string, unknown>>("run"))?.outcome).toBe("stopped");
    expect(storage.data.has("creds")).toBe(false);
    expect(container.running).toBe(false);
    expect((await drill.run(CREDS)).status).toBe(202); // a new run may start
  });
});

describe("routes", () => {
  async function page(): Promise<string> {
    const html = await (await worker.fetch(new Request(`${ORIGIN}/`), env as never)).text();
    const match = /const intent = "([0-9a-f]{64})"/.exec(html);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  }

  function run(headers: Record<string, string>, body: unknown = CREDS): Request {
    return new Request(`${ORIGIN}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("refuses foreign, missing and null origins, and missing or forged intents, with no effect", async () => {
    const intent = await page();
    const refusals = [
      run({ origin: "https://evil.example", "x-drill-intent": intent }),
      run({ "x-drill-intent": intent }),
      run({ origin: "null", "x-drill-intent": intent }),
      run({ origin: ORIGIN }),
      run({ origin: ORIGIN, "x-drill-intent": "f".repeat(64) }),
      run({ origin: ORIGIN, "x-drill-intent": intent, "sec-fetch-site": "cross-site" }),
    ];
    for (const request of refusals) {
      expect((await worker.fetch(request, env as never)).status).toBe(403);
    }
    // A simple cross-site form post, and a top-level GET of the action, change nothing either.
    const form = new Request(`${ORIGIN}/api/run`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: "endpoint=x",
    });
    expect((await worker.fetch(form, env as never)).status).toBe(403);
    expect((await worker.fetch(new Request(`${ORIGIN}/api/run`), env as never)).status).toBe(404);
    expect(container.starts).toEqual([]);
    expect(storage.data.has("creds")).toBe(false);
  });

  it("runs with the same origin and the page's intent, and never shows the token", async () => {
    const intent = await page();
    const response = await worker.fetch(
      run({ origin: ORIGIN, "x-drill-intent": intent }),
      env as never,
    );
    expect(response.status).toBe(202);
    expect(container.starts).toHaveLength(1);
    const shown = await (
      await worker.fetch(new Request(`${ORIGIN}/api/status`), env as never)
    ).text();
    expect(shown).not.toContain(SECRET);
    const big = run({ origin: ORIGIN, "x-drill-intent": intent }, { pad: "x".repeat(5000) });
    expect((await worker.fetch(big, env as never)).status).toBe(400);
    // Codex review r1, finding 8: the limit counts bytes, not characters.
    const wide = new Request(`${ORIGIN}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-drill-intent": intent },
      body: `${"\u3000".repeat(1400)}${JSON.stringify(CREDS)}`,
    });
    expect((await worker.fetch(wide, env as never)).status).toBe(400);
    const stop = new Request(`${ORIGIN}/api/stop`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-drill-intent": intent },
    });
    expect((await worker.fetch(stop, env as never)).status).toBe(200);
    expect(storage.data.has("creds")).toBe(false);
  });

  it("answers anything else with 404", async () => {
    expect((await worker.fetch(new Request(`${ORIGIN}/x`), env as never)).status).toBe(404);
  });
});
