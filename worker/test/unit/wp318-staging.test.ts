// WP3.18's staging soak (RC-26): the schedule, the rendered configuration and the reconnect
// analysis, in Node (worker/test/staging/wp318).
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withRenderedConfig } from "../../../scripts/bootstrap/cloud.ts";
import {
  type Installation,
  installationProblems,
  renderPlatformConfig,
} from "../../../scripts/bootstrap/settings.ts";
import { ownerPin } from "../../../scripts/bootstrap/test/fixtures.ts";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import {
  declaredResources,
  validateDeployConfig,
  withStagingNames,
} from "../../../scripts/staging/guard.ts";
import {
  configRestarts,
  dueEvents,
  HEARTBEAT_MS,
  HEARTBEAT_WINDOW_MS,
  type LogLine,
  MIN,
  NO_DROP_WINDOW_MS,
  nextHeartbeat,
  nextLaptopEvent,
  RC21_MS,
  reconnects,
  replaceResult,
  restartTimes,
  SOAK_MS,
  SOAK_SCHEDULE,
  switchBracket,
  tunnelOpens,
} from "../staging/wp318/plan.ts";
import { soakPlatformConfig } from "../staging/wp318/soak-config.ts";

const T0 = 1_800_000_000_000;
const HOST = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const A = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const B = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4";

function beat(at: number, version: string, from = "server"): LogLine {
  return { timestamp: at, version, source: { cfo: "soak", event: "heartbeat", runId: "r", from } };
}

/** Heartbeats every 5 s from `from` to `to`, switching to `v2` at `switchAt`. */
function beats(from: number, to: number, switchAt: number): LogLine[] {
  const out: LogLine[] = [];
  for (let t = from; t < to; t += HEARTBEAT_MS) out.push(beat(t, t < switchAt ? "v1" : "v2"));
  return out;
}

function open(at: number, computerId = A, version = "v1"): LogLine {
  return {
    timestamp: at,
    version,
    source: {
      cfo: "computer_route",
      event: "request",
      method: "GET",
      path: `/v1/hosts/${HOST}/tunnel`,
      upgrade: true,
      status: 101,
      computerId,
      generation: 1,
    },
  };
}

describe("the soak's schedule", () => {
  it("runs three hours: resets by the Worker, deploys by the laptop, each disruption once", () => {
    expect(SOAK_SCHEDULE.at(-1)).toEqual({ kind: "end", at: SOAK_MS, by: "worker" });
    expect(SOAK_MS).toBe(180 * MIN);
    const kinds = SOAK_SCHEDULE.map((e) => e.kind);
    for (const kind of ["server_reset", "workspace_reset", "web_deploy", "platform_deploy"]) {
      expect(kinds).toContain(kind);
    }
    // Disruptions at least 20 minutes apart, so each reconnect is measured on its own.
    for (let i = 1; i < SOAK_SCHEDULE.length; i += 1) {
      expect((SOAK_SCHEDULE[i]?.at ?? 0) - (SOAK_SCHEDULE[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        20 * MIN,
      );
    }
    for (const event of SOAK_SCHEDULE) {
      expect(event.by).toBe(event.kind.endsWith("_deploy") ? "laptop" : "worker");
    }
  });

  it("gives the Worker its due events once each, never the laptop's", () => {
    expect(dueEvents(T0, new Set(), T0)).toEqual([]);
    expect(dueEvents(T0, new Set(), T0 + 10 * MIN)).toEqual([0]);
    expect(dueEvents(T0, new Set([0]), T0 + 10 * MIN)).toEqual([]);
    // After a long gap every missed event is due, in order; laptop events never are.
    const late = dueEvents(T0, new Set(), T0 + SOAK_MS);
    expect(late.map((i) => SOAK_SCHEDULE[i]?.by)).toEqual(late.map(() => "worker"));
    expect(late.at(-1)).toBe(SOAK_SCHEDULE.length - 1);
  });

  it("tells the laptop its next deploy", () => {
    expect(nextLaptopEvent(T0, T0)).toEqual({ index: 1, at: T0 + 30 * MIN, kind: "web_deploy" });
    expect(nextLaptopEvent(T0, T0 + 31 * MIN)?.kind).toBe("platform_deploy");
    expect(nextLaptopEvent(T0, T0 + SOAK_MS)).toBeNull();
  });
});

describe("the soak's platform configuration", () => {
  it("is the bootstrap's own, with the soak module, its object and the results bucket added", () => {
    const rendered = {
      name: "cfo-stg-wp318-platform",
      main: "src/index.ts",
      durable_objects: { bindings: [{ name: "OMNIGENT", class_name: "OmnigentServer" }] },
      migrations: [{ tag: "v1" }, { tag: "v2" }, { tag: "v3" }],
      r2_buckets: [{ binding: "CHECKPOINTS", bucket_name: "cfo-stg-wp318-platform-checkpoints" }],
      vars: { CFO_INSTALLATION_ID: "ins_x" },
      containers: [{ class_name: "WorkspaceDO" }],
    };
    expect(soakPlatformConfig(rendered, "b1")).toEqual({
      ...rendered,
      main: "test/staging/wp318/soak.ts",
      durable_objects: {
        bindings: [
          { name: "OMNIGENT", class_name: "OmnigentServer" },
          { name: "SOAK", class_name: "SoakRun" },
        ],
      },
      migrations: [
        { tag: "v1" },
        { tag: "v2" },
        { tag: "v3" },
        { tag: "v4", new_sqlite_classes: ["SoakRun"] },
      ],
      r2_buckets: [
        { binding: "CHECKPOINTS", bucket_name: "cfo-stg-wp318-platform-checkpoints" },
        { binding: "RESULTS", bucket_name: "cfo-stg-wp318-platform-results" },
      ],
      vars: { CFO_INSTALLATION_ID: "ins_x", WP318_BUILD: "b1" },
    });
  });
});

describe("the soak's analysis", () => {
  it("reads only successful host-tunnel opens, per computer, in order", () => {
    const other = { ...open(T0 + 3), source: { ...(open(0).source as object), status: 403 } };
    const runner = {
      ...open(T0 + 4),
      source: { ...(open(0).source as object), path: "/v1/sessions/s1/events" },
    };
    const opens = tunnelOpens([open(T0 + 2), open(T0 + 1), other, runner, open(T0 + 5, B)]);
    expect(opens.get(A)).toEqual([T0 + 1, T0 + 2]);
    expect(opens.get(B)).toEqual([T0 + 5]);
    expect(tunnelOpens([{ timestamp: 1, source: "a text line" }]).size).toBe(0);
  });

  it("brackets OmnigentServer's own switch to the deployed version, never a host's reconnect", () => {
    const start = T0 + 50 * MIN;
    const end = T0 + 52 * MIN;
    const lines = [
      ...beats(end - 20_000, end + 400_000, end + 300_002),
      open(end + 300_001, A, "v2"),
    ];
    const deploy = { from: start, version: "v2" };
    expect(switchBracket(lines, deploy)).toEqual({
      lastOld: end + 300_000,
      firstNew: end + 305_000,
      version: "v2",
    });
    // Codex WP3.18 r2-3: the deployed version may already run before the command exits; the
    // bracket is still its own, never a later deployment's.
    const early = [...beats(start - 20_000, start + 400_000, start + 30_002)];
    expect(switchBracket(early, { from: start, version: "v2" })).toMatchObject({
      lastOld: start + 30_000,
      firstNew: start + 35_000,
    });
    expect(switchBracket(early, { from: start, version: "v3" })).toBeNull();
    // Unknown version, no heartbeat of it, none before it, or only another object's: not bracketed.
    expect(switchBracket(lines, { from: start, version: undefined })).toBeNull();
    expect(
      switchBracket(beats(end - 20_000, end + 400_000, Number.POSITIVE_INFINITY), deploy),
    ).toBeNull();
    expect(switchBracket(beats(end, end + 400_000, end), deploy)).toBeNull();
    expect(switchBracket([open(end + 1, A, "v2")], deploy)).toBeNull();
    const soakRunOnly = lines.map((l) =>
      typeof l.source === "object" && l.source?.event === "heartbeat"
        ? beat(l.timestamp, l.version ?? "", "soak-run")
        : l,
    );
    expect(switchBracket(soakRunOnly, deploy)).toBeNull();
  });

  it("schedules heartbeats around each platform deploy only", () => {
    expect(nextHeartbeat(T0, T0)).toBe(T0 + 50 * MIN);
    expect(nextHeartbeat(T0, T0 + 50 * MIN)).toBe(T0 + 50 * MIN + HEARTBEAT_MS);
    expect(nextHeartbeat(T0, T0 + 50 * MIN + HEARTBEAT_WINDOW_MS)).toBe(T0 + 120 * MIN);
    expect(nextHeartbeat(T0, T0 + 120 * MIN + HEARTBEAT_WINDOW_MS)).toBeNull();
  });

  it("judges every connected computer's reconnect against RC-21, and a web deploy by no drop", () => {
    const reset = T0 + 10 * MIN;
    const web = T0 + 30 * MIN;
    const deployEnd = T0 + 52 * MIN;
    const lines = [
      open(T0 + MIN, A, "v1"),
      open(T0 + MIN, B, "v1"),
      open(reset + 20_000, A, "v1"), // A back in 20 s
      open(reset + 90_000, B, "v1"), // B back in 90 s: too late
      // The switch between the heartbeats at +300 s (old) and +305 s (new).
      ...beats(deployEnd - 20_000, deployEnd + 400_000, deployEnd + 302_000),
      open(deployEnd + 310_000, A, "v2"), // back 10 to 5 s after the switch: passes
      open(deployEnd + 362_000, B, "v2"), // 62 to 57 s: inconclusive, never passed
    ];
    const results = reconnects(
      [
        { kind: "server_reset", at: reset },
        { kind: "web_deploy", at: web, deployEndedAt: web + 60_000 },
        { kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd, version: "v2" },
        { kind: "end", at: T0 + SOAK_MS },
      ],
      lines,
    );
    expect(results.map((r) => [r.kind, r.computerId, r.gapMs, r.ok])).toEqual([
      ["server_reset", A, 20_000, true],
      ["server_reset", B, 90_000, false],
      ["web_deploy", A, null, true],
      ["web_deploy", B, null, true],
      ["platform_deploy", A, 10_000, true],
      ["platform_deploy", B, 62_000, false],
    ]);
    expect(results[0]?.boundMs).toBe(RC21_MS);
    expect(results[4]).toMatchObject({ lowerMs: 5_000 });
    expect(results[5]).toMatchObject({
      lowerMs: 57_000,
      note: "inconclusive: the switch is known only within 5000 ms",
    });
    // Codex WP3.18 r1-3: a reconnect is never its own evidence of the switch. With no new-version
    // heartbeat, a late reconnect under the new version is not bracketed, so it never passes.
    const unbracketed = reconnects(
      [{ kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd, version: "v2" }],
      [
        ...beats(deployEnd - 20_000, deployEnd + 400_000, Number.POSITIVE_INFINITY),
        open(T0, A, "v1"),
        open(deployEnd + 300_000, A, "v2"),
      ],
    );
    expect(unbracketed[0]).toMatchObject({ ok: false, gapMs: null });
    // Beyond the bound from the bracket's end: a definite failure, with no inconclusive note.
    const late = reconnects(
      [{ kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd, version: "v2" }],
      [
        ...beats(deployEnd - 20_000, deployEnd + 400_000, deployEnd + 302_000),
        open(T0, A, "v1"),
        open(deployEnd + 380_000, A, "v2"),
      ],
    );
    expect(late[0]).toMatchObject({ ok: false, gapMs: 80_000, lowerMs: 75_000 });
    expect(late[0]?.note).toBeUndefined();
    // A drop during the overlap window, or a reconnect overlapping a pause.
    const dropped = reconnects(
      [{ kind: "web_deploy", at: web, deployEndedAt: web + 60_000 }],
      [open(T0, A), open(web + 60_000 + NO_DROP_WINDOW_MS - 1, A)],
    );
    expect(dropped[0]).toMatchObject({ ok: false, note: "a host tunnel reopened: a drop" });
    const paused = reconnects(
      [{ kind: "server_reset", at: reset, duringPause: true }],
      [open(T0, A), open(reset + 90_000, A)],
    );
    expect(paused[0]).toMatchObject({ ok: true, boundMs: 100_000 });
    // No switch found, a computer that never came back, and one never connected before.
    const missing = reconnects(
      [
        { kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd, version: "v2" },
        { kind: "server_reset", at: reset },
      ],
      [open(T0, A, "v1"), open(reset + 5 * MIN, B, "v1")],
    );
    const notBracketed =
      "inconclusive: no switch to the deployed version bracketed by the server's heartbeats";
    expect(missing).toEqual([
      expect.objectContaining({ computerId: A, ok: false, note: notBracketed }),
      expect.objectContaining({ computerId: B, ok: false, note: notBracketed }),
      // B first connected after the reset: only A is judged by it.
      expect.objectContaining({ kind: "server_reset", computerId: A, gapMs: null, ok: false }),
    ]);
  });
});

describe("the M3 sitting's installation (R2 replica and artifacts bucket, G2-DUR-001)", () => {
  const WORKER = resolve(import.meta.dirname, "..", "..");
  const ACCOUNT = "1".repeat(32);
  /** The plan `run.sh bucket` makes: one holder's two buckets, one endpoint, staging wp318. */
  const planned = async (): Promise<Installation> => ({
    installationId: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
    accountId: ACCOUNT,
    platformWorker: "cfo-stg-wp318-platform",
    webWorker: "cfo-stg-wp318-web",
    hostname: "cfo-stg-wp318-web.example.test",
    ownerPin: await ownerPin(),
    ownerUsername: "owner",
    replica: {
      url: "s3://cfo-stg-wp318-r2-db/omnigent",
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    },
    artifacts: { url: "s3://cfo-stg-wp318-r2-artifacts" },
    target: {
      kind: "staging",
      owner: "WP3.18",
      platformSuffix: "wp318-platform",
      webSuffix: "wp318-web",
      days: 2,
    },
    plannedAt: "2026-10-26T12:00:00.000Z",
  });
  const guard = (path: string, name: string) =>
    validateDeployConfig(readWranglerConfig(path, WORKER), ACCOUNT, name, {
      registry: { owner: "WP3.18", deployments: [] },
    });

  it("runs the server with its artifacts in R2, never on the disk, and passes the staging guard", async () => {
    const plan = await planned();
    expect(installationProblems(plan)).toEqual([]);
    const base = readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER).raw;
    const config = soakPlatformConfig(renderPlatformConfig(base, plan), "b1");
    const vars = config.vars as Record<string, string>;
    expect(vars).toMatchObject({
      SERVER_ENV_CFO_REPLICA_URL: "s3://cfo-stg-wp318-r2-db/omnigent",
      SERVER_ENV_OMNIGENT_ARTIFACT_URI: "s3://cfo-stg-wp318-r2-artifacts",
      SERVER_ENV_AWS_ENDPOINT_URL_S3: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      WP318_BUILD: "b1",
    });
    expect(vars).not.toHaveProperty("SERVER_ENV_CFO_ALLOW_LOCAL_ARTIFACTS");
    expect(vars).not.toHaveProperty("SERVER_ENV_CFO_ALLOW_FILE_REPLICA");
    // No SERVER_ENV_ value differs between two soak deploys: they never restart the server.
    const again = soakPlatformConfig(renderPlatformConfig(base, plan), "b2").vars as Record<
      string,
      string
    >;
    const serverEnv = (v: Record<string, string>) =>
      Object.entries(v).filter(([k]) => k.startsWith("SERVER_ENV_"));
    expect(serverEnv(again)).toEqual(serverEnv(vars));
    expect(config.r2_buckets).toEqual([
      { binding: "CHECKPOINTS", bucket_name: "cfo-stg-wp318-platform-checkpoints" },
      { binding: "RESULTS", bucket_name: "cfo-stg-wp318-platform-results" },
    ]);
    withRenderedConfig(WORKER, config, (path) =>
      expect(() => guard(path, "cfo-stg-wp318-platform")).not.toThrow(),
    );
    // Both containers under the `durable_object` policy (WP3.19): the staging tool records the
    // repositories Wrangler pushes to, so teardown deletes them.
    const name = "cfo-stg-wp318-platform";
    expect(declaredResources(withStagingNames(config, name), name).repositories).toEqual([
      `${name}-omnigentserver-server`,
      `${name}-workspacedo-computer`,
    ]);
  });

  it("holds the replica's and the artifacts' buckets under the holder's own name", () => {
    const path = join(WORKER, "test", "staging", "wp318", "bucket", "wrangler.jsonc");
    expect(readWranglerConfig(path, WORKER).raw.r2_buckets).toEqual([
      { binding: "REPLICA", bucket_name: "cfo-stg-wp318-r2-db" },
      { binding: "ARTIFACTS", bucket_name: "cfo-stg-wp318-r2-artifacts" },
    ]);
    expect(() => guard(path, "cfo-stg-wp318-r2")).not.toThrow();
  });
});

describe("the watchdog's controlled restarts (G2-SEC-001's config_changed)", () => {
  const line = (at: number, source: Record<string, unknown> | string): LogLine => ({
    timestamp: at,
    version: "v1",
    source,
  });
  const started = (at: number, id: string, cause = "config_changed") =>
    line(at, { cfo: "watchdog", event: "outage_started", outageId: id, cause });
  const ended = (at: number, id: string, durationMs: number, cause = "config_changed") =>
    line(at, { cfo: "watchdog", event: "outage_ended", outageId: id, cause, durationMs });

  it("finds each config_changed outage in the window, with its end once logged", () => {
    const lines = [
      ended(T0 + 40_000, "out_a", 34_000),
      started(T0 + 6_000, "out_a"),
      started(T0 + 100_000, "out_b"),
      // Another cause, and a line outside the window, are not this.
      started(T0 + 50_000, "out_c", "not_answering"),
      ended(T0 + 60_000, "out_c", 9_000, "not_answering"),
      started(T0 - 1, "out_d"),
      // A line Workers Logs kept as a string still counts; malformed ones do not.
      line(
        T0 + 101_000,
        JSON.stringify({
          cfo: "watchdog",
          event: "outage_ended",
          outageId: "out_b",
          cause: "config_changed",
          durationMs: 31_000,
        }),
      ),
      line(T0 + 102_000, "{not json"),
      line(T0 + 103_000, { cfo: "watchdog", event: "outage_ended", cause: "config_changed" }),
    ];
    expect(configRestarts(lines, T0, T0 + SOAK_MS)).toEqual([
      { outageId: "out_a", startedAt: T0 + 6_000, endedAt: T0 + 40_000, durationMs: 34_000 },
      { outageId: "out_b", startedAt: T0 + 100_000, endedAt: T0 + 101_000, durationMs: 31_000 },
    ]);
    // Still restarting: started, not ended.
    expect(configRestarts([started(T0 + 1, "out_e")], T0, T0 + 10)).toEqual([
      { outageId: "out_e", startedAt: T0 + 1, endedAt: null, durationMs: null },
    ]);
    expect(configRestarts(lines, T0 + SOAK_MS, T0 + 2 * SOAK_MS)).toEqual([]);
  });
});

describe("the server's measured restarts and the forced replacement (WP3.19)", () => {
  const at = (timestamp: number, source: Record<string, unknown> | string): LogLine => ({
    timestamp,
    version: "v1",
    source,
  });
  const watchdog = (event: string, fields: Record<string, unknown>) => ({
    cfo: "watchdog",
    event,
    ...fields,
  });
  const ready = (fields: Record<string, unknown>) =>
    watchdog("server_ready", { failedStarts: 0, ...fields });

  it("times each config_changed restart from the watchdog's breakdown at its end", () => {
    const lines = [
      at(T0 + 1_000, watchdog("outage_started", { outageId: "out_a", cause: "config_changed" })),
      // Restart #1: a refused start retried, then ready.
      at(
        T0 + 40_000,
        ready({ failedStarts: 1, lastStartToReadyMs: 21_000, firstStartToReadyMs: 33_000 }),
      ),
      at(
        T0 + 40_001,
        watchdog("outage_ended", {
          outageId: "out_a",
          cause: "config_changed",
          durationMs: 39_000,
        }),
      ),
      // Another cause's breakdown, long before #2's end: never #2's.
      at(T0 + 100_000, ready({ lastStartToReadyMs: 99_000 })),
      at(T0 + 200_000, watchdog("outage_started", { outageId: "out_b", cause: "config_changed" })),
      at(
        T0 + 230_000,
        JSON.stringify(ready({ lastStartToReadyMs: 18_000, firstStartToReadyMs: 18_000 })),
      ),
      at(
        T0 + 230_000,
        watchdog("outage_ended", {
          outageId: "out_b",
          cause: "config_changed",
          durationMs: 30_000,
        }),
      ),
      // Still restarting: no end, no times.
      at(T0 + 300_000, watchdog("outage_started", { outageId: "out_c", cause: "config_changed" })),
    ];
    expect(restartTimes(lines, T0, T0 + SOAK_MS)).toEqual([
      expect.objectContaining({
        outageId: "out_a",
        durationMs: 39_000,
        lastStartToReadyMs: 21_000,
        firstStartToReadyMs: 33_000,
        failedStarts: 1,
      }),
      expect.objectContaining({
        outageId: "out_b",
        durationMs: 30_000,
        lastStartToReadyMs: 18_000,
        failedStarts: 0,
      }),
      expect.objectContaining({
        outageId: "out_c",
        endedAt: null,
        lastStartToReadyMs: null,
        failedStarts: null,
      }),
    ]);
    // An end without its breakdown nearby keeps its duration, with no times invented.
    const lone = [
      at(T0, watchdog("outage_started", { outageId: "out_d", cause: "config_changed" })),
      at(
        T0 + 50_000,
        watchdog("outage_ended", {
          outageId: "out_d",
          cause: "config_changed",
          durationMs: 50_000,
        }),
      ),
    ];
    expect(restartTimes(lone, T0, T0 + SOAK_MS)).toEqual([
      expect.objectContaining({ durationMs: 50_000, lastStartToReadyMs: null }),
    ]);
  });

  it("reads the forced replacement's outcome from G2's step lines, and nothing before it ends", () => {
    const step = (event: string, fields: Record<string, unknown>) => ({
      cfo: "g2_sitting",
      event,
      step: "replace-2",
      ...fields,
    });
    const running = [
      at(T0, step("kill_sent", { bootIdBefore: "a".repeat(32) })),
      at(T0 + 1, { cfo: "g2_sitting", event: "step_done", step: "replace-1", verdict: "pass" }),
    ];
    expect(replaceResult(running)).toBeNull();
    const done = step("step_done", {
      verdict: "pass",
      problems: [],
      record: {
        answeredAfterKillS: 41.2,
        phasesS: { starting: 6.1, restoring: 7.0, running: 39.9 },
        replica: { caughtUpAfterS: 3.4 },
        after: { config: { pass: true }, health: 200 },
      },
    });
    expect(replaceResult([...running, at(T0 + 60_000, JSON.stringify(done))])).toEqual({
      stage: "done",
      verdict: "pass",
      problems: [],
      answeredAfterKillS: 41.2,
      phasesS: { starting: 6.1, restoring: 7.0, running: 39.9 },
      replicaCaughtUpAfterS: 3.4,
      configPass: true,
      failure: null,
    });
    const failed = step("step_failed", { failure: "the replacement entered recovery mode" });
    expect(replaceResult([at(T0, failed)])).toMatchObject({
      stage: "failed",
      verdict: "fail",
      failure: "the replacement entered recovery mode",
      answeredAfterKillS: null,
      configPass: null,
    });
  });
});
