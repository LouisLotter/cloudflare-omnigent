// The G2 sitting's steps (worker/test/staging/g2/steps.ts) against a fake server: one kill per
// step whatever restarts in between (persist before effect), the probe's views from the first
// `running` report, the checks before and after, the rotation's refusal of the old session, and
// recovery mode reached by the watchdog's restart or, failing that, by a kill; and RC-07's files,
// uploaded before replace-1's kill, served after it and after rotate's restart (G2-DUR-001).
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
  type OutageView,
  RC07_FILES,
  recordKill,
  runStep,
  type StepContext,
  type StepName,
  type StepRecord,
  verdictOf,
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
  /** Uploaded files' bytes by file ID: in an artifact bucket, or on the container's disk. */
  files = new Map<string, string>();
  /** Whether the files outlive a container (G2-DUR-001's fix) or die with its disk. */
  artifactsInBucket = true;
  /** Litestream makes no progress until the next kill. */
  replicationStalled = false;
  records = new Map<StepName, StepRecord>();
  kept = new Map<string, KeptSession>();
  /** The watchdog's records: the release's controlled restart, before the test starts. */
  outageList: OutageView[] = [
    {
      cause: "config_changed",
      startedAt: this.clock - 600_000,
      detectedAt: this.clock - 600_000,
      endedAt: this.clock - 540_000,
    },
  ];
  /** When the current boot's app first answered (its `/status.app.readyAt`). */
  readyAtMs = this.clock - 60_000;
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
        this.loseDisk();
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
        this.readyAtMs = this.clock;
        this.unconfirmedLeft = this.unconfirmedAfterBoot;
      }
    }
    if (ms >= 500 && this.replicated < this.txid && !this.replicationStalled) this.replicated += 1;
    if (this.appliesConfig && this.running && this.startedWith !== this.configCurrent) {
      // The watchdog's controlled restart (G2-SEC-001's fix), modelled as an instant restart.
      this.outageList.push({
        cause: "config_changed",
        startedAt: this.clock,
        detectedAt: this.clock,
        endedAt: this.replicaUrl.includes("/g2-empty-") ? null : this.clock + 1,
      });
      this.loseDisk();
      this.boot += 1;
      this.startedWith = this.configCurrent;
      this.phase = this.replicaUrl.includes("/g2-empty-") ? "recovery" : "running";
      this.readyAtMs = this.clock;
    }
  }

  /** A new container: files kept only on its disk are gone. */
  loseDisk() {
    if (!this.artifactsInBucket) this.files.clear();
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
          { token: `token-${this.cookieKey}`, expires_in: 86_400 },
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
          const id = `file-${this.files.size}-${init?.upload?.filename.replace(/\W/g, "-")}`;
          this.files.set(id, init?.upload?.content ?? "");
          return this.answer(201, { id });
        }
        if (route.endsWith("/:file/content")) {
          if (!this.authorised(init)) return this.answer(401);
          const id = path.split("/").at(-2) ?? "";
          const text = this.files.get(id);
          // Omnigent at the pinned fork: a row without its blob is a 500 (upstream candidate).
          if (text === undefined) return this.answer(500, { error: { code: "internal_error" } });
          return this.answer(200, null, {
            text,
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
        this.replicationStalled = false;
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
              app: { readyAt: new Date(this.readyAtMs).toISOString() },
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
      outages: async (fromMs, toMs) =>
        this.outageList.filter((o) => o.detectedAt <= toMs && (o.endedAt ?? toMs) >= fromMs),
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
      keep: async (name, session) => {
        this.kept.set(name, session);
      },
      kept: async (name) => this.kept.get(name),
      forget: async (name) => {
        this.kept.delete(name);
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
    expect(done.probe).toMatchObject({ unconfirmedWritesBefore: 2 });
    expect(done).toMatchObject({ verdict: "pass", problems: [], originFrom: "app.readyAt" });
    expect(done.after).toMatchObject({
      sessionFromBeforeRestart: { cookie: 200, bearer: 200 },
      keptForRotate: { cookie: 200, bearer: 200 },
    });
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
    // Uploaded before the kill, their rows replicated, served the same after it (G2-DUR-001).
    expect(done.rc07).toMatchObject({
      uploadedBeforeKill: true,
      replicatedBeforeKill: { replicated: true },
      checkedAfter: true,
    });
    for (const f of files) {
      expect(f).toMatchObject({ before: { content: 200, same: true }, content: 200, same: true });
    }
    // The files' text stays out of the record and the logs.
    expect(JSON.stringify(done)).not.toContain("SCRIPT RAN");
    expect(JSON.stringify(server.logs)).not.toContain("SCRIPT RAN");
    expect(server.kept.get("rotate")).toMatchObject({ fingerprint: "fp-released" });
    expect(server.kept.has("before")).toBe(false);
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

  it("fails when the replacement lost the files uploaded before the kill (G2-DUR-001)", async () => {
    const server = new FakeServer();
    server.artifactsInBucket = false;
    const done = await runStep(server.ports(), ctx("replace-1"));
    expect(done).toMatchObject({ stage: "done", verdict: "fail" });
    expect(done.problems).toEqual([
      "rc07: g2-rc07.html content not served after the replacement",
      "rc07: g2-rc07.html is not the uploaded file after the replacement",
      "rc07: g2-rc07.html not served as an attachment",
      "rc07: g2-rc07.html without nosniff",
      "rc07: g2-rc07.svg content not served after the replacement",
      "rc07: g2-rc07.svg is not the uploaded file after the replacement",
      "rc07: g2-rc07.svg not served as an attachment",
      "rc07: g2-rc07.svg without nosniff",
    ]);
    const first = (done.rc07 as { files: Record<string, unknown>[] }).files[0];
    expect(first).toMatchObject({ before: { same: true }, content: 500, code: "internal_error" });
  });

  it("waits for the uploads' rows on the replica before the kill, and fails without them", async () => {
    const server = new FakeServer();
    server.replicationStalled = true;
    const done = await runStep(server.ports(), ctx("replace-1"));
    expect(server.destroys).toBe(1);
    expect(done.rc07).toMatchObject({
      replicatedBeforeKill: { replicated: false, why: "not within 60 s" },
    });
    expect(done.killSentAt).toBeGreaterThanOrEqual(done.createdAt + LIMITS.replicateBeforeKillMs);
    expect(done.verdict).toBe("fail");
    expect(done.problems).toContain("rc07: the uploads' rows were not replicated before the kill");
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
    server.clock += 30_000; // which came before the step's first tick on the new version
    const done = await runStep(server.ports(), ctx("rotate"));
    expect(done).toMatchObject({
      stage: "done",
      appliedBy: "watchdog",
      verdict: "pass",
      rotation: { oldCookie: 401, oldBearer: 401, newCookie: 200 },
    });
    // replace-1's files, after the controlled restart: the URLs the owner opens (G2-DUR-001).
    const files = (done.artifacts as { files: Record<string, unknown>[] }).files;
    expect(files.map((f) => f.filename)).toEqual(RC07_FILES.map((f) => f.filename));
    for (const f of files) expect(f).toMatchObject({ content: 200, same: true });
    expect(server.destroys).toBe(1); // only replace-1's
    expect(server.kept.size).toBe(0);
  });

  it("fails when the controlled restart lost RC-07's files, as in the G2 sitting", async () => {
    const server = await afterReplace1();
    server.artifactsInBucket = false; // from here on, the next container starts without them
    server.cookieKey = "k2";
    server.configCurrent = "fp-rotated";
    server.tick(1000);
    const done = await runStep(server.ports(), ctx("rotate"));
    expect(done).toMatchObject({ stage: "done", verdict: "fail" });
    expect(done.problems).toEqual([
      "artifacts: g2-rc07.html lost after the controlled restart (G2-DUR-001)",
      "artifacts: g2-rc07.html without its download headers after the restart",
      "artifacts: g2-rc07.svg lost after the controlled restart (G2-DUR-001)",
      "artifacts: g2-rc07.svg without its download headers after the restart",
    ]);
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
      verdict: "pass",
      probe: { unconfirmedWritesBefore: 2 },
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

describe("verdicts (Codex G2 review: completion is not acceptance)", () => {
  async function replaced() {
    const server = new FakeServer();
    const done = await runStep(server.ports(), ctx("replace-1"));
    expect(done.verdict).toBe("pass");
    return done;
  }

  it("a measurement resumed after the answer is inconclusive, never re-measured late", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    await recordKill(ports, "resnapshot");
    await ports.destroy();
    const answered = {
      ...(server.records.get("resnapshot") as StepRecord),
      stage: "answered" as const,
    };
    // As if the invocation that saw the answer had died before measuring.
    while (server.phase !== "running" || server.restartPhase !== -1) server.tick(1000);
    answered.newBootId = server.bootId();
    answered.answeredAt = server.clock;
    answered.originFrom = "app.readyAt";
    server.records.set("resnapshot", answered);
    const done = await runStep(ports, ctx("resnapshot"));
    expect(done).toMatchObject({ stage: "done", verdict: "inconclusive", answerResumed: true });
    expect(done.problems).toContain("the measurement was interrupted");
  });

  it("a measured boot that is no longer running fails the step", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    server.records.set("resnapshot", {
      step: "resnapshot",
      stage: "answered",
      createdAt: server.clock,
      updatedAt: server.clock,
      invocations: 1,
      newBootId: "boot-0",
      answeredAt: server.clock,
    });
    const done = await runStep(ports, ctx("resnapshot"));
    expect(done).toMatchObject({ stage: "failed", verdict: "fail" });
    expect(done.failure).toContain("restarted after the measured boot answered");
  });

  it("an old bearer still accepted fails the rotation", async () => {
    const rotated: StepRecord = {
      step: "rotate",
      stage: "done",
      createdAt: 0,
      updatedAt: 0,
      invocations: 1,
      rotation: { config: { pass: true }, oldCookie: 401, oldBearer: 200, newCookie: 200 },
      artifacts: {
        files: RC07_FILES.map((f) => ({
          filename: f.filename,
          content: 200,
          same: true,
          headers: { "content-disposition": "attachment", "x-content-type-options": "nosniff" },
        })),
      },
    };
    const verdict = verdictOf(rotated);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.problems).toContain("the old bearer was not refused");
    // An expired session or a missing outage record cannot pass either.
    const expired = { ...rotated.rotation, oldBearer: 401, beforeExpiry: false };
    expect(verdictOf({ ...rotated, rotation: { ...expired, outage: { durationS: 60 } } })).toEqual({
      verdict: "inconclusive",
      problems: ["the kept session may have expired"],
    });
  });

  it("a probe error or a missing confirmation is inconclusive; a lost attachment header fails", async () => {
    const done = await replaced();
    expect(verdictOf({ ...done, probe: { error: "boom" } }).verdict).toBe("inconclusive");
    expect(verdictOf({ ...done, originFrom: "observed" }).verdict).toBe("inconclusive");
    expect(verdictOf({ ...done, observationLagS: 30 }).verdict).toBe("inconclusive");
    const files = (done.rc07 as { files: Record<string, unknown>[] }).files;
    const stripped = files.map((f) => ({ ...f, headers: { "content-type": "text/html" } }));
    expect(verdictOf({ ...done, rc07: { files: stripped } })).toMatchObject({ verdict: "fail" });
    // Files uploaded only after the kill prove nothing about the replacement (G2-DUR-001).
    const late = { ...done.rc07, uploadedBeforeKill: false };
    expect(verdictOf({ ...done, rc07: late }).problems).toEqual([
      "rc07: the files were not uploaded before the kill",
    ]);
    const changed = files.map((f) => ({ ...f, same: false }));
    expect(verdictOf({ ...done, rc07: { ...done.rc07, files: changed } }).problems).toEqual(
      RC07_FILES.map((f) => `rc07: ${f.filename} is not the uploaded file after the replacement`),
    );
  });

  it("recovery fails if setup is offered, recovery ends, or the server restarts", () => {
    const base = {
      step: "recovery" as const,
      stage: "done" as const,
      createdAt: 0,
      updatedAt: 0,
      invocations: 1,
    };
    const good = {
      reason: "replica_empty",
      answers: { "/": 503, "/v1/info": 503, "/health": 503 },
      setupPost: 503,
      stillRecovery: true,
      sameBoot: true,
    };
    expect(verdictOf({ ...base, recovery: good }).verdict).toBe("pass");
    for (const bad of [{ setupPost: 200 }, { stillRecovery: false }, { sameBoot: false }]) {
      expect(verdictOf({ ...base, recovery: { ...good, ...bad } }).verdict).toBe("fail");
    }
  });

  it("pauses at the invocation's request deadline, then resumes, its timing inconclusive", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    let calls = 0;
    const slow: G2Ports = {
      ...ports,
      // The first request after the answer takes the whole budget.
      http: async (method, path, init) => {
        const answer = await ports.http(method, path, init);
        if (path === "/health" && ++calls === 2) server.clock += LIMITS.invocationDeadlineMs;
        return answer;
      },
    };
    const paused = await runStep(slow, ctx("replace-2", null));
    expect(paused.stage).toBe("answered");
    expect(server.logs.some((l) => l.event === "step_paused")).toBe(true);
    const done = await runStep(ports, ctx("replace-2", null));
    expect(done).toMatchObject({ stage: "done", answerResumed: true, verdict: "inconclusive" });
    expect(server.destroys).toBe(1);
  });
});

describe("boot identity and the deadline (Codex G2 review run 2)", () => {
  /** The fake, with the replica behind until `catchUpAfter` reads after the answer. */
  function lagging() {
    const server = new FakeServer();
    server.txid = 40; // the replica needs many half-second ticks to catch up
    return server;
  }

  it("a restart while the replica catches up fails replace-2", async () => {
    const server = lagging();
    const ports = server.ports();
    let reads = 0;
    const restarting: G2Ports = {
      ...ports,
      status: async () => {
        const status = await ports.status();
        // After the answer, the server restarts under the measurement.
        if (status?.phase === "running" && server.boot === 2 && ++reads === 3) server.boot = 3;
        return status;
      },
    };
    const done = await runStep(restarting, ctx("replace-2", null));
    expect(done).toMatchObject({ stage: "failed", verdict: "fail" });
    expect(done.failure).toMatch(/restarted/);
  });

  it("an unreadable boot identity after the measurement is inconclusive, never a pass", async () => {
    const server = new FakeServer();
    const ports = server.ports();
    const blind: G2Ports = {
      ...ports,
      // Once the step has its answer, the control port stops naming the boot.
      status: async () => {
        const status = await ports.status();
        const answered = server.records.get("replace-2")?.stage === "answered";
        return answered && status ? { ...status, bootId: null } : status;
      },
    };
    const done = await runStep(blind, ctx("replace-2", null));
    expect(done).toMatchObject({ stage: "done", verdict: "inconclusive", bootUnverified: true });
  });

  it("the deadline also stops control-port reads and sleeps: the step pauses, saved", async () => {
    const server = lagging();
    const ports = server.ports();
    let answeredSleeps = 0;
    const slow: G2Ports = {
      ...ports,
      sleep: async (ms) => {
        await ports.sleep(ms);
        // While the replica catches up, the polls take the whole budget.
        if (server.boot === 2 && server.phase === "running" && ++answeredSleeps === 2) {
          server.clock += LIMITS.invocationDeadlineMs;
        }
      },
    };
    const paused = await runStep(slow, ctx("replace-2", null));
    expect(paused.stage).toBe("answered");
    expect(server.logs.some((l) => l.event === "step_paused")).toBe(true);
  });
});
