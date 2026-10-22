import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ALARM_MS,
  type Awaiting,
  decide,
  type HarnessStatus,
  harnessEnv,
  MAX_MISSED_POLLS,
  missingResults,
  newRunId,
  parseCredentials,
  parseHarnessStatus,
  REPLACEMENT_HEALTH_TIMEOUT_MS,
  type RunRecord,
  type RunSettings,
  replacedEnv,
  replacementTimings,
  resultKey,
} from "./src/plan.ts";

// Synthetic values in R2's formats; no real account or token.
const ACCOUNT = `${"0".repeat(31)}1`;
const CREDS = {
  endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  accessKeyId: "a".repeat(32),
  secretAccessKey: "b".repeat(64),
};

describe("parseCredentials", () => {
  it("accepts exactly the three fields in R2's formats", () => {
    const parsed = parseCredentials({ ...CREDS, endpoint: ` ${CREDS.endpoint.toUpperCase()} ` });
    expect(parsed).toEqual({ ok: true, value: CREDS });
    const eu = parseCredentials({
      ...CREDS,
      endpoint: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    });
    expect(eu.ok).toBe(true);
  });

  it.each([
    ["not an object", "x"],
    ["an array", [CREDS]],
    ["an extra field", { ...CREDS, extra: "1" }],
    ["a missing field", { endpoint: CREDS.endpoint, accessKeyId: CREDS.accessKeyId }],
    ["another host", { ...CREDS, endpoint: "https://example.com" }],
    ["plain http", { ...CREDS, endpoint: `http://${ACCOUNT}.r2.cloudflarestorage.com` }],
    ["a path", { ...CREDS, endpoint: `${CREDS.endpoint}/bucket` }],
    ["a short key id", { ...CREDS, accessKeyId: "a".repeat(31) }],
    ["a non-hex secret", { ...CREDS, secretAccessKey: "z".repeat(64) }],
    ["a number", { ...CREDS, accessKeyId: 1 }],
  ])("refuses %s, without echoing a value", (_, input) => {
    const parsed = parseCredentials(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).not.toContain("b".repeat(64));
      expect(parsed.reason).not.toContain("a".repeat(32));
    }
  });

  it("never accepts anything with a character outside R2's formats", () => {
    fc.assert(
      fc.property(fc.string(), (junk) => {
        const parsed = parseCredentials({ ...CREDS, secretAccessKey: `${"b".repeat(63)}${junk}` });
        return !parsed.ok || /^[0-9a-f]{64}$/.test(parsed.value.secretAccessKey);
      }),
    );
  });
});

const SETTINGS: RunSettings = {
  runId: "run-20261022t120000z-abcdef",
  ownerPassword: "c".repeat(32),
  cookieSecret: "d".repeat(64),
  bucket: "cfo-stg-wp25-drill-db",
  plan: "all",
  barrierWrites: "300",
  barrierItems: "150",
  idleSeconds: "480",
};

describe("environments", () => {
  it("passes the token only as Litestream's variables, and the run's settings", () => {
    const env = harnessEnv(SETTINGS, CREDS);
    expect(env.LITESTREAM_ACCESS_KEY_ID).toBe(CREDS.accessKeyId);
    expect(env.LITESTREAM_SECRET_ACCESS_KEY).toBe(CREDS.secretAccessKey);
    expect(env.DRILL_ENDPOINT).toBe(CREDS.endpoint);
    expect(env.DRILL_MODE).toBe("measure");
    const secretKeys = Object.entries(env)
      .filter(([, v]) => v === CREDS.secretAccessKey)
      .map(([k]) => k);
    expect(secretKeys).toEqual(["LITESTREAM_SECRET_ACCESS_KEY"]);
  });

  it("restores the awaited prefix in the replaced container", () => {
    const awaiting: Awaiting = { prefix: "restore-1000mb", manifest: "{}", fillerRows: 7 };
    const env = replacedEnv(SETTINGS, CREDS, awaiting);
    expect(env).toMatchObject({
      DRILL_MODE: "replaced",
      DRILL_REPLACED_PREFIX: "restore-1000mb",
      DRILL_REPLACED_MANIFEST: "{}",
      DRILL_REPLACED_FILLER_ROWS: "7",
      DRILL_RUN_ID: SETTINGS.runId,
    });
  });
});

describe("names", () => {
  it("makes run ids and result keys in fixed forms only", () => {
    const id = newRunId(new Date("2026-10-22T12:00:00.123Z"), "abcdef");
    expect(id).toBe("run-20261022t120000z-abcdef");
    expect(resultKey(id, "barrier-1s")).toBe(`results/${id}/barrier-1s.json`);
    expect(() => resultKey(id, "../x")).toThrow();
    expect(() => resultKey("x", "summary")).toThrow();
    expect(() => newRunId(new Date(), "ABCDEF")).toThrow();
  });
});

const STATUS = {
  protocol: 1,
  run_id: "r",
  mode: "measure",
  phases: [],
  phase: "drill",
  done: false,
  awaiting_replacement: null,
  errors: { env: "OSError" },
  results: ["env"],
};

describe("parseHarnessStatus", () => {
  it("reads the harness's status", () => {
    const parsed = parseHarnessStatus(STATUS);
    expect(parsed).toEqual({
      ok: true,
      value: {
        mode: "measure",
        phase: "drill",
        done: false,
        results: ["env"],
        errors: { env: "OSError" },
        awaiting: null,
      },
    });
    const waiting = parseHarnessStatus({
      ...STATUS,
      awaiting_replacement: { prefix: "restore-60mb", manifest: "{}", filler_rows: 3 },
    });
    expect(waiting.ok && waiting.value.awaiting).toEqual({
      prefix: "restore-60mb",
      manifest: "{}",
      fillerRows: 3,
    });
  });

  it.each([
    ["not an object", null],
    ["no mode", { ...STATUS, mode: undefined }],
    ["a bad phase", { ...STATUS, phase: 3 }],
    ["a result name that is a path", { ...STATUS, results: ["../../x"] }],
    [
      "a bad prefix",
      { ...STATUS, awaiting_replacement: { prefix: "a/b", manifest: "", filler_rows: 1 } },
    ],
    [
      "a huge manifest",
      {
        ...STATUS,
        awaiting_replacement: { prefix: "p", manifest: "x".repeat(70_000), filler_rows: 1 },
      },
    ],
    [
      "fractional rows",
      { ...STATUS, awaiting_replacement: { prefix: "p", manifest: "", filler_rows: 1.5 } },
    ],
  ])("refuses %s", (_, input) => {
    expect(parseHarnessStatus(input).ok).toBe(false);
  });
});

const NOW = 1_000_000_000;
const RUN: RunRecord = {
  runId: SETTINGS.runId,
  startedAt: NOW,
  armedUntil: NOW + 3 * 3600_000,
  mode: "measure",
  phase: null,
  stored: [],
  errors: {},
  missedPolls: 0,
};

function status(fields: Partial<HarnessStatus> = {}): HarnessStatus {
  return {
    mode: "measure",
    phase: "drill",
    done: false,
    results: [],
    errors: {},
    awaiting: null,
    ...fields,
  };
}

describe("decide", () => {
  it("stores new results and waits", () => {
    expect(
      decide({ ...RUN, stored: ["env"] }, status({ results: ["env", "drill"] }), true, NOW),
    ).toEqual([{ kind: "store", names: ["drill"] }]);
    expect(decide(RUN, status(), true, NOW)).toEqual([]);
  });

  it("does nothing for a finished run", () => {
    expect(decide({ ...RUN, outcome: "done" }, status({ done: true }), true, NOW)).toEqual([]);
  });

  it("replaces the container only once every reported result is stored", () => {
    const awaiting = { prefix: "restore-1000mb", manifest: "{}", fillerRows: 1 };
    const asking = status({ results: ["cf-replacement"], awaiting });
    expect(decide(RUN, asking, true, NOW)).toEqual([{ kind: "store", names: ["cf-replacement"] }]);
    const stored = { ...RUN, stored: ["cf-replacement"], reported: ["cf-replacement"] };
    expect(decide(stored, asking, true, NOW)).toEqual([{ kind: "replace", awaiting }]);
  });

  it("polls health until the replaced server answers, and gives up after its timeout", () => {
    const started = { prefix: "p", requestedAt: NOW, startCalledAt: NOW + 5 };
    const replacing: RunRecord = { ...RUN, mode: "replaced", replacement: started };
    expect(decide(replacing, null, true, NOW + ALARM_MS)).toEqual([{ kind: "await-health" }]);
    expect(decide(replacing, null, true, NOW + REPLACEMENT_HEALTH_TIMEOUT_MS + 1)).toEqual([
      { kind: "finish", outcome: "failed" },
    ]);
    const broken = { ...replacing, replacement: { ...started, error: "x" } };
    expect(decide(broken, null, true, NOW)).toEqual([{ kind: "finish", outcome: "failed" }]);
    const healthy = { ...replacing, replacement: { ...started, healthyAt: NOW + 9 } };
    expect(decide(healthy, status({ mode: "replaced" }), true, NOW)).toEqual([]);
    expect(decide(healthy, status({ mode: "replaced", done: true }), true, NOW)).toEqual([
      { kind: "finish", outcome: "done" },
    ]);
  });

  it("never ends a broken replacement while a result waits for R2 (Codex review r2)", () => {
    const old = { prefix: "p", requestedAt: NOW - REPLACEMENT_HEALTH_TIMEOUT_MS - 1 };
    const run: RunRecord = { ...RUN, mode: "replaced", replacement: old };
    const reporting = status({ mode: "replaced", results: ["cf-replacement-container"] });
    expect(decide(run, reporting, true, NOW)).toEqual([
      { kind: "store", names: ["cf-replacement-container"] },
    ]);
    // A silent harness whose earlier result is still unstored: the container still holds it.
    const silent = { ...RUN, reported: ["drill"], missedPolls: MAX_MISSED_POLLS };
    expect(decide(silent, null, true, NOW)).toEqual([]);
    // Once the container is gone, nothing is left to wait for.
    expect(decide(silent, null, false, NOW)).toEqual([{ kind: "finish", outcome: "failed" }]);
    expect(decide({ ...run, reported: ["x"] }, null, false, NOW)).toEqual([
      { kind: "finish", outcome: "failed" },
    ]);
  });

  it("never replaces twice", () => {
    const awaiting = { prefix: "p", manifest: "{}", fillerRows: 1 };
    const replaced = {
      ...RUN,
      mode: "replaced" as const,
      replacement: { prefix: "p", requestedAt: NOW, healthyAt: NOW + 1 },
    };
    expect(decide(replaced, status({ awaiting }), true, NOW)).toEqual([]);
  });

  it("finishes a run only once every reported result is stored", () => {
    const done = status({ done: true, results: ["env"] });
    expect(decide(RUN, done, true, NOW)).toEqual([{ kind: "store", names: ["env"] }]);
    expect(decide({ ...RUN, stored: ["env"], reported: ["env"] }, done, true, NOW)).toEqual([
      { kind: "finish", outcome: "done" },
    ]);
  });

  it("names the results that never reached R2", () => {
    expect(missingResults({ ...RUN, reported: ["env", "drill"], stored: ["env"] })).toEqual([
      "drill",
    ]);
    expect(missingResults(RUN)).toEqual([]);
  });

  it("expires at the end of the window, after storing", () => {
    expect(decide(RUN, status({ results: ["env"] }), true, RUN.armedUntil)).toEqual([
      { kind: "store", names: ["env"] },
      { kind: "finish", outcome: "expired" },
    ]);
  });

  it("fails a run whose harness stays silent", () => {
    expect(decide({ ...RUN, missedPolls: MAX_MISSED_POLLS - 2 }, null, true, NOW)).toEqual([]);
    expect(decide({ ...RUN, missedPolls: MAX_MISSED_POLLS - 1 }, null, true, NOW)).toEqual([
      { kind: "finish", outcome: "failed" },
    ]);
  });

  it("never finishes twice, stores first, and acts irreversibly only with every result stored (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          missed: fc.nat(20),
          done: fc.boolean(),
          silent: fc.boolean(),
          running: fc.boolean(),
          results: fc.subarray(["env", "drill", "barrier-1s", "summary"]),
          stored: fc.subarray(["env", "drill"]),
          reported: fc.subarray(["env", "drill", "barrier-1s"]),
          replacement: fc.constantFrom("none", "pending", "error", "late", "healthy"),
          awaiting: fc.boolean(),
          late: fc.boolean(),
        }),
        (g) => {
          const replacement =
            g.replacement === "none"
              ? undefined
              : {
                  prefix: "p",
                  requestedAt:
                    g.replacement === "late" ? NOW - REPLACEMENT_HEALTH_TIMEOUT_MS - 1 : NOW,
                  ...(g.replacement === "error" ? { error: "x" } : {}),
                  ...(g.replacement === "healthy" ? { healthyAt: NOW } : {}),
                };
          const run: RunRecord = {
            ...RUN,
            missedPolls: g.missed,
            stored: g.stored,
            reported: g.reported,
            ...(replacement ? { replacement, mode: "replaced" as const } : {}),
          };
          const harness = g.silent
            ? null
            : status({
                done: g.done,
                results: g.results,
                awaiting: g.awaiting ? { prefix: "p", manifest: "{}", fillerRows: 1 } : null,
              });
          const running = g.silent ? g.running : true;
          const actions = decide(run, harness, running, g.late ? RUN.armedUntil : NOW);
          const finishes = actions.filter((a) => a.kind === "finish");
          const storeIndex = actions.findIndex((a) => a.kind === "store");
          const finishIndex = actions.findIndex((a) => a.kind === "finish");
          const irreversible = actions.some((a) => a.kind === "finish" || a.kind === "replace");
          const unstored =
            [...g.reported, ...(harness?.results ?? [])].filter((n) => !g.stored.includes(n))
              .length > 0;
          return (
            finishes.length <= 1 &&
            (storeIndex === -1 || finishIndex === -1 || storeIndex < finishIndex) &&
            // Nothing irreversible while a running container holds an unstored result,
            // unless the window is over.
            (!irreversible || g.late || !running || !unstored)
          );
        },
      ),
    );
  });
});

describe("replacementTimings", () => {
  it("spans the steps it has", () => {
    expect(
      replacementTimings({
        prefix: "p",
        requestedAt: 10,
        stoppedAt: 30,
        startCalledAt: 31,
        healthyAt: 100,
      }),
    ).toEqual({ stopMs: 20, startToHealthyMs: 69, lossToHealthyMs: 90 });
    expect(replacementTimings({ prefix: "p", requestedAt: 10 })).toEqual({
      stopMs: null,
      startToHealthyMs: null,
      lossToHealthyMs: null,
    });
  });
});
