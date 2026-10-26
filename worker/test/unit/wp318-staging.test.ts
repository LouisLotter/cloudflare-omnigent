// WP3.18's staging soak (RC-26): the schedule, the rendered configuration and the reconnect
// analysis, in Node (worker/test/staging/wp318).
import { describe, expect, it } from "vitest";
import {
  dueEvents,
  type LogLine,
  MIN,
  NO_DROP_WINDOW_MS,
  nextLaptopEvent,
  RC21_MS,
  reconnects,
  SOAK_MS,
  SOAK_SCHEDULE,
  tunnelOpens,
  versionSwitch,
} from "../staging/wp318/plan.ts";
import { soakPlatformConfig } from "../staging/wp318/soak-config.ts";

const T0 = 1_800_000_000_000;
const HOST = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const A = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const B = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4";

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

  it("finds a deploy's version switch: the first new version after its upload", () => {
    const lines = [open(T0, A, "v1"), open(T0 + 100_000, A, "v1"), open(T0 + 400_000, A, "v2")];
    expect(versionSwitch(lines, T0 + 50_000)).toBe(T0 + 400_000);
    expect(versionSwitch(lines, T0 + 500_000)).toBeNull();
    expect(versionSwitch([], T0)).toBeNull();
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
      open(deployEnd + 300_000, A, "v2"), // the switch, and A's reconnect at once
      open(deployEnd + 330_000, B, "v2"),
    ];
    const results = reconnects(
      [
        { kind: "server_reset", at: reset },
        { kind: "web_deploy", at: web, deployEndedAt: web + 60_000 },
        { kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd },
        { kind: "end", at: T0 + SOAK_MS },
      ],
      lines,
    );
    expect(results.map((r) => [r.kind, r.computerId, r.gapMs, r.ok])).toEqual([
      ["server_reset", A, 20_000, true],
      ["server_reset", B, 90_000, false],
      ["web_deploy", A, null, true],
      ["web_deploy", B, null, true],
      ["platform_deploy", A, 0, true],
      ["platform_deploy", B, 30_000, true],
    ]);
    expect(results[0]?.boundMs).toBe(RC21_MS);
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
        { kind: "platform_deploy", at: T0 + 50 * MIN, deployEndedAt: deployEnd },
        { kind: "server_reset", at: reset },
      ],
      [open(T0, A, "v1"), open(reset + 5 * MIN, B, "v1")],
    );
    expect(missing).toEqual([
      expect.objectContaining({ computerId: A, ok: false, note: "no version switch found" }),
      expect.objectContaining({ computerId: B, ok: false, note: "no version switch found" }),
      // B first connected after the reset: only A is judged by it.
      expect.objectContaining({ kind: "server_reset", computerId: A, gapMs: null, ok: false }),
    ]);
  });
});
