// The G2 sitting's steps (worker/test/staging/g2/steps.ts) against a fake server: one kill per
// step whatever restarts in between (persist before effect), the probe's views from the first
// `running` report, the checks before and after, the rotation's refusal of the old session, and
// recovery mode reached by the watchdog's restart or, failing that, by a kill.
import { describe, expect, it } from "vitest";
import {
  type ConfigView,
  EDIT_ME,
  type EntrypointStatus,
  type G2Ports,
  type HttpAnswer,
  type HttpInit,
  type KeptSession,
  LIMITS,
  RC07_FILES,
  recordKill,
  runStep,
  type StepContext,
  type StepName,
  type StepRecord,
} from "../staging/g2/steps.ts";

const PASSWORD = "cfo-stg-synthetic-owner-password";

class FakeServer {
  clock = Date.parse("2026-10-26T12:00:00.000Z");
  running = true;
  boot = 1;
  phase = "running";
  /** Polls until the watchdog's replacement reaches each phase after a kill. */
  restartPlan = ["starting", "restoring", "initializing", "running"];
  restartPhase = -1;
  destroys = 0;
  /** Security writes answered 424 after a new boot, before the re-snapshot is done. */
  unconfirmedAfterBoot = 2;
  unconfirmedLeft = 0;
  txid = 10;
  replicated = 10;
  bootstrapPassword = false;
  initialized = "true";
  replicaUrl = "s3://cfo-stg-g2-sitting-r2-db/omnigent";
  cookieKey = "k1";
  configCurrent = "fp-released";
  startedWith: string | null = "fp-released";
  /** Whether the fake watchdog restarts the server when its configuration changes. */
  appliesConfig = true;
  /** Where a kill leads: the normal start, or recovery mode (an empty replica). */
  bootsInto: "running" | "recovery" = "running";
  schedules: { id: string; name: string }[] = [];
  records = new Map<StepName, StepRecord>();
  keptSession: KeptSession | undefined;
  logs: { event: string; fields: Record<string, unknown> }[] = [];
  crashOnDestroy = false;

  bootId() {
    return `boot-${this.boot}`;
  }

  /** One fake second: the replacement advances one phase, Litestream catches up. */
  tick(ms: number) {
    this.clock += ms;
    if (this.restartPhase >= 0 && ms >= 1000) {
      if (!this.running) {
        this.running = true;
        this.boot += 1;
        this.startedWith = this.configCurrent;
        this.restartPhase = 0;
      } else if (this.restartPhase < this.restartPlan.length - 1) {
        this.restartPhase += 1;
      }
      this.phase = this.restartPlan[this.restartPhase] ?? "running";
      if (this.bootsInto === "recovery" && this.phase === "initializing") this.phase = "recovery";
      if (this.phase === "running" || this.phase === "recovery") {
        this.restartPhase = -1;
        this.unconfirmedLeft = this.unconfirmedAfterBoot;
      }
    }
    if (ms >= 500 && this.replicated < this.txid) this.replicated += 1;
    if (this.appliesConfig && this.running && this.startedWith !== this.configCurrent) {
      // The watchdog's controlled restart (G2-SEC-001's fix), modelled as an instant restart.
      this.boot += 1;
      this.startedWith = this.configCurrent;
      this.phase = this.replicaUrl.includes("/g2-empty-") ? "recovery" : "running";
    }
  }

  answer(status: number, json: unknown = null, extra: Partial<HttpAnswer> = {}): HttpAnswer {
    this.clock += 50;
    return { status, json, headers: {}, cookies: [], ms: 50, ...extra };
  }

  authorised(init?: HttpInit) {
    return init?.bearer === `token-${this.cookieKey}` || init?.cookie === `s=${this.cookieKey}`;
  }

  http(method: string, path: string, init?: HttpInit): HttpAnswer {
    const route = `${method} ${path.replace(/\/[0-9a-z-]+\/content$/, "/:file/content")}`;
    if (this.phase === "recovery") return this.answer(503, { error: { code: "recovery_mode" } });
    if (!this.running || this.phase !== "running") return this.answer(503);
    switch (route) {
      case "GET /health":
        return this.answer(200);
      case "GET /v1/info":
        return this.answer(200, { accounts_enabled: true, needs_setup: false });
      case "POST /auth/login": {
        const body = init?.json as { password?: string };
        if (body.password !== PASSWORD) return this.answer(401);
        return this.answer(
          200,
          { token: `token-${this.cookieKey}` },
          { cookies: [`s=${this.cookieKey}`] },
        );
      }
      case "GET /auth/me":
        return this.answer(this.authorised(init) ? 200 : 401);
      case "GET /v1/agents":
        return this.answer(200, { data: [{ id: "agent-1" }] });
      case "GET /v1/sharing":
        return this.answer(200, { editable: false, mode_editable: false });
      case "GET /v1/scheduled-tasks":
        return this.answer(200, { data: this.schedules });
      case "POST /v1/scheduled-tasks": {
        const name = String((init?.json as { name?: string } | undefined)?.name);
        const id = `task-${this.schedules.length}`;
        this.schedules.push({ id, name });
        this.txid += 1;
        if (this.unconfirmedLeft > 0) {
          this.unconfirmedLeft -= 1;
          this.clock += 10_000;
          return this.answer(424, { error: { code: "durability_unconfirmed" } });
        }
        return this.answer(200, { id });
      }
      case "POST /v1/sessions":
        this.txid += 1;
        return this.answer(200, { id: `session-${this.txid}` });
      default:
        if (/^POST \/v1\/sessions\/session-\d+\/resources\/files$/.test(route)) {
          return this.answer(201, { id: `file-${init?.upload?.filename.replace(/\W/g, "-")}` });
        }
        if (route.endsWith("/:file/content")) {
          return this.answer(200, null, {
            headers: {
              "content-type": "text/html",
              "content-disposition": 'attachment; filename="x"',
              "x-content-type-options": "nosniff",
            },
          });
        }
        if (route === "POST /auth/setup") return this.answer(404);
        throw new Error(`unexpected ${route}`);
    }
  }

  ports(): G2Ports {
    return {
      now: () => this.clock,
      sleep: async (ms) => this.tick(ms),
      running: () => this.running,
      destroy: async () => {
        this.destroys += 1;
        if (this.crashOnDestroy) throw new Error("the object restarted");
        this.running = false;
        this.restartPhase = 0;
        this.phase = "stopped";
      },
      status: async (): Promise<EntrypointStatus | null> =>
        this.running
          ? {
              phase: this.phase,
              bootId: this.bootId(),
              installationInitializedExpected: this.initialized === "true",
              recovery: this.phase === "recovery" ? { reason: "replica_empty" } : null,
              replication: {
                txid: this.txid,
                replicatedTxid: this.replicated,
                caughtUp: this.replicated >= this.txid,
              },
            }
          : null,
      position: async () =>
        this.running
          ? {
              status: 200,
              body: { bootId: this.bootId(), txid: this.txid, replicatedTxid: this.replicated },
            }
          : { status: 0, body: null },
      http: async (method, path, init) => this.http(method, path, init),
      config: async (): Promise<ConfigView> => ({
        startedWith: this.startedWith,
        current: this.configCurrent,
        initialized: this.initialized,
        bootstrapPassword: this.bootstrapPassword,
        replicaUrl: this.replicaUrl,
      }),
      load: async (step) => structuredClone(this.records.get(step)),
      save: async (record) => {
        this.records.set(record.step, structuredClone(record));
      },
      keep: async (session) => {
        this.keptSession = session;
      },
      kept: async () => this.keptSession,
      forget: async () => {
        this.keptSession = undefined;
      },
      log: (event, fields) => this.logs.push({ event, fields }),
    };
  }
}

const ctx = (step: StepName, ownerPassword: string | null = PASSWORD): StepContext => ({
  step,
  ownerPassword: ownerPassword ?? undefined,
  ownerUsername: "owner",
});

describe("replace-1", () => {
  it("waits for the release, then kills once and measures from the first running report", async () => {
    const server = new FakeServer();
    server.bootstrapPassword = true;
    const waiting = await runStep(server.ports(), ctx("replace-1"));
    expect(waiting).toMatchObject({
      stage: "pending",
      waiting: "the bootstrap has not released yet",
    });
    expect(server.destroys).toBe(0);

    server.bootstrapPassword = false;
    const done = await runStep(server.ports(), ctx("replace-1"));
    expect(done.stage).toBe("done");
    expect(server.destroys).toBe(1);
    expect(done.before).toMatchObject({
      config: { pass: true, startedWithCurrent: true, released: true },
      sharing: { managed: true },
      editMe: { id: "task-0", status: 200 },
    });
    expect(done.phasesS).toHaveProperty("running");
    expect(done.newBootId).toBe("boot-2");
    expect(done.probe).toMatchObject({ unconfirmedWritesBefore: 2, interrupted: false });
    expect((done.probe as { writes: unknown[] }).writes).toHaveLength(3);
    expect(done.replica).toMatchObject({ newCommitDurableAfterS: expect.any(Number) });
    expect(done.after).toMatchObject({
      ownerLogin: 200,
      wrongPassword: 401,
      editMeKept: true,
      config: { pass: true },
      sharing: { managed: true },
      info: { accounts_enabled: true, needs_setup: false },
    });
    const files = (done.rc07 as { files: { filename: string; headers: object }[] }).files;
    expect(files.map((f) => f.filename)).toEqual(RC07_FILES.map((f) => f.filename));
    expect(files[0]?.headers).toMatchObject({ "x-content-type-options": "nosniff" });
    expect(server.keptSession).toMatchObject({ fingerprint: "fp-released" });
    // Nothing logged carries the password or a session.
    expect(JSON.stringify(server.logs)).not.toContain(PASSWORD);
    expect(JSON.stringify(server.logs)).not.toContain("token-k1");
  });

  it("records a container that still runs the bootstrap's configuration", async () => {
    const server = new FakeServer();
    server.appliesConfig = false;
    server.startedWith = "fp-before-release";
    const done = await runStep(server.ports(), ctx("replace-1"));
    expect(done.before).toMatchObject({ config: { pass: false, startedWithCurrent: false } });
    expect(server.logs.some((l) => l.event === "config_mismatch")).toBe(true);
    // The replacement then starts with the released configuration.
    expect(done.after).toMatchObject({ config: { pass: true } });
  });

  it("never kills twice: a restart after the kill resumes the watch", async () => {
    const server = new FakeServer();
    server.restartPlan = Array.from({ length: 2 + LIMITS.invocationMs / 1000 }, () => "restoring");
    server.restartPlan.push("running");
    const first = await runStep(server.ports(), ctx("replace-1"));
    expect(first.stage).toBe("killed");
    const second = await runStep(server.ports(), ctx("replace-1"));
    expect(second.stage).toBe("done");
    expect(second.resumed).toBe(true);
    expect(server.destroys).toBe(1);
  });

  it("a destroy that throws leaves the step killed, never pending", async () => {
    const server = new FakeServer();
    server.crashOnDestroy = true;
    const failed = await runStep(server.ports(), ctx("replace-1"));
    expect(failed.stage).toBe("failed");
    expect(server.records.get("replace-1")?.killSentAt).toBeDefined();
    expect(await runStep(server.ports(), ctx("replace-1"))).toMatchObject({ stage: "failed" });
    expect(server.destroys).toBe(1);
  });

  it("fails when the replacement enters recovery mode", async () => {
    const server = new FakeServer();
    server.bootsInto = "recovery";
    const failed = await runStep(server.ports(), ctx("replace-1"));
    expect(failed).toMatchObject({ stage: "failed", recovery: { reason: "replica_empty" } });
  });

  it("waits without the owner's password", async () => {
    const server = new FakeServer();
    expect(await runStep(server.ports(), ctx("replace-1", null))).toMatchObject({
      waiting: "G2_OWNER_PASSWORD is not set",
    });
  });
});

describe("rotate", () => {
  async function afterReplace1() {
    const server = new FakeServer();
    expect((await runStep(server.ports(), ctx("replace-1"))).stage).toBe("done");
    return server;
  }

  it("waits for the new configuration, then refuses the old session", async () => {
    const server = await afterReplace1();
    expect(await runStep(server.ports(), ctx("rotate"))).toMatchObject({
      stage: "pending",
      waiting: "this object still runs the configuration from before the rotation",
    });
    server.cookieKey = "k2";
    server.configCurrent = "fp-rotated";
    server.tick(1000); // the watchdog's controlled restart
    const done = await runStep(server.ports(), ctx("rotate"));
    expect(done).toMatchObject({
      stage: "done",
      appliedBy: "watchdog",
      rotation: { oldCookie: 401, oldBearer: 401, newCookie: 200, pass: true },
    });
    expect(server.destroys).toBe(1); // only replace-1's
    expect(server.keptSession).toBeUndefined();
  });

  it("fails, naming G2-SEC-001, when the server keeps the old configuration", async () => {
    const server = await afterReplace1();
    server.appliesConfig = false;
    server.cookieKey = "k2";
    server.configCurrent = "fp-rotated";
    const waiting = await runStep(server.ports(), ctx("rotate"));
    expect(waiting.stage).toBe("pending");
    const failed = await runStep(server.ports(), ctx("rotate"));
    expect(failed.stage).toBe("failed");
    expect(failed.failure).toContain("G2-SEC-001");
  });
});

describe("replace-2", () => {
  it("needs no credential and records when the replica covers the new boot", async () => {
    const server = new FakeServer();
    server.schedules.push({ id: "task-0", name: EDIT_ME });
    const done = await runStep(server.ports(), ctx("replace-2", null));
    expect(done).toMatchObject({
      stage: "done",
      replica: { caughtUpAfterS: expect.any(Number) },
      after: { health: 200, config: { pass: true } },
    });
    expect(server.destroys).toBe(1);
  });
});

describe("recovery", () => {
  it("waits until the object runs with the empty replica", async () => {
    const server = new FakeServer();
    expect(await runStep(server.ports(), ctx("recovery"))).toMatchObject({
      waiting: "this object does not run with the empty replica yet",
    });
  });

  it("is reached by the watchdog's restart and holds, never offering setup", async () => {
    const server = new FakeServer();
    server.replicaUrl = "s3://cfo-stg-g2-sitting-r2-db/g2-empty-0123";
    server.configCurrent = "fp-empty";
    server.tick(1000);
    const done = await runStep(server.ports(), ctx("recovery"));
    expect(done).toMatchObject({
      stage: "done",
      appliedBy: "watchdog",
      recovery: {
        reason: "replica_empty",
        answers: { "/": 503, "/v1/info": 503, "/health": 503 },
        setupPost: 503,
        stillRecovery: true,
        sameBoot: true,
      },
    });
    expect(server.destroys).toBe(0);
  });

  it("falls back to a kill when the watchdog does not restart it", async () => {
    const server = new FakeServer();
    server.appliesConfig = false;
    server.bootsInto = "recovery";
    server.replicaUrl = "s3://cfo-stg-g2-sitting-r2-db/g2-empty-0123";
    server.configCurrent = "fp-empty";
    await runStep(server.ports(), ctx("recovery"));
    const done = await runStep(server.ports(), ctx("recovery"));
    expect(done).toMatchObject({ stage: "done", appliedBy: "harness kill" });
    expect(server.destroys).toBe(1);
  });
});

describe("resnapshot (WP2.6's 1 GB run kills the server itself)", () => {
  it("waits for the run's kill, then probes from the new boot's first running report", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    expect(await runStep(ports, ctx("resnapshot"))).toMatchObject({
      stage: "pending",
      waiting: "the run has not killed the server yet",
    });
    await recordKill(ports, "resnapshot"); // over the pending record a tick left
    await ports.destroy(); // the run's own kill
    const done = await runStep(ports, ctx("resnapshot"));
    expect(done).toMatchObject({
      stage: "done",
      bootIdBefore: "boot-1",
      newBootId: "boot-2",
      probe: { unconfirmedWritesBefore: 2, interrupted: false },
      replica: { newCommitDurableAfterS: expect.any(Number) },
    });
    expect(done.after).toBeUndefined();
    expect(done.rc07).toBeUndefined();
  });

  it("counts only the first kill", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    await recordKill(ports, "resnapshot");
    const first = structuredClone(server.records.get("resnapshot"));
    server.clock += 60_000;
    await recordKill(ports, "resnapshot");
    expect(server.records.get("resnapshot")).toEqual(first);
  });
});
