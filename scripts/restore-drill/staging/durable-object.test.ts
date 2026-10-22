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
  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
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
  start(options: { enableInternet: boolean; env?: Record<string, string> }): void {
    expect(options.enableInternet).toBe(true);
    this.running = true;
    this.starts.push(options.env ?? {});
  }
  async monitor(): Promise<void> {}
  signal(signo: number): void {
    this.signals.push(signo);
  }
  async destroy(): Promise<void> {
    this.running = false;
  }
  getTcpPort(port: number) {
    return {
      fetch: async (input: string) => {
        const path = new URL(input).pathname;
        if (port === 8000) return new Response("", { status: this.healthy ? 200 : 503 });
        if (port !== 8002 || this.harness === null) throw new Error("connection refused");
        if (path === "/status") return Response.json(this.harness.status);
        const name = path.replace("/results/", "");
        const result = this.harness.results[name];
        return result === undefined ? new Response("{}", { status: 404 }) : Response.json(result);
      },
    };
  }
}

class FakeR2 {
  objects = new Map<string, string>();
  async put(key: string, value: string): Promise<void> {
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
    const summary = JSON.parse(r2.objects.get(`results/${runId}/summary.json`) ?? "{}");
    expect(summary.outcome).toBe("done");
    expect(summary.stored).toEqual(["env", "cf-replacement", "cf-replacement-container"]);
    expect(container.running).toBe(false);
    expect(storage.data.has("creds")).toBe(false);
    expect(storage.data.has("settings")).toBe(false);
    expect(storage.alarm).toBeNull();
    expect(everythingKept()).not.toContain(SECRET);
    expect(everythingKept()).not.toContain(String(container.starts[0]?.DRILL_OWNER_PASSWORD));
    await drill.alarm(); // a stray alarm after the end does nothing
    expect(container.starts).toHaveLength(2);
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
