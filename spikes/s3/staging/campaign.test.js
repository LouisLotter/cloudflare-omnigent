// The staging campaign's step machine (campaign.js), driven alarm by alarm with a fake
// supervisor, fake DirectoryBackup and fake storage. Checks the order of the work, what is
// recorded, the R2 cases' publication rule, and that stopping, expiry, errors and a replaced
// container are handled.
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs

import { beforeEach, describe, expect, it } from "vitest";
import { PLANS, startCampaign, stopCampaign, tick } from "./campaign.js";

let clock;
let calls;
let logs;
let objects;
let alarm;
let map;
let boot;
let failPaths;
let uploadHook;
let stopped;

function fakeSupervisor() {
  const jobs = new Map();
  let jobN = 0;
  const startJob = (result) => {
    const id = `j${++jobN}`;
    jobs.set(id, { polls: 0, result });
    return { job: id };
  };
  const capture = (body) => ({
    outcome: "snapshot_ready",
    pause_s: 0.5,
    precopy_s: 1,
    copy_s: 0.4,
    snapshot_dir: "/snap/x",
    size_bytes: 700e6,
    reused_snapshot: Boolean(body.keep),
    stopped_by_kind: { "omnigent-host": 1 },
  });
  return {
    get: async (path) => {
      calls.push(`GET ${path}`);
      if (path === "/probe") return { kernel: "k", disk: { read_after_fadvise_mb_s: 100 } };
      const job = jobs.get(path.split("/").at(-1));
      if (job) {
        job.polls += 1;
        return job.polls < 2 ? { state: "running" } : { state: "done", result: job.result };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    post: async (path, body) => {
      calls.push(`POST ${path}${body?.seq !== undefined ? ` ${body.seq}` : ""}`);
      if (failPaths.has(path)) throw new Error(`supervisor ${path}: 500 boom`);
      switch (path) {
        case "/setup":
          return startJob({ host: "online", sessions: 3 });
        case "/bench":
          return startJob({ summary: { profile: body.profile }, rows: [{ n: 1 }, { n: 2 }] });
        case "/genws":
          return startJob({ profile: body.profile });
        case "/calibrate":
          return startJob({ rows: body.holds.map((h) => ({ hold_s: h, pause_s: h })) });
        case "/load":
          return startJob({ turns: 4, turns_ok: 4, capture: { pause_s: 0.6 }, host: {} });
        case "/rm":
        case "/restore/reset":
          return {};
        case "/turn":
          return { rc: 0, cli: body.cli, n: body.n };
        case "/capture":
          return capture(body);
        case "/layer":
          return {
            seq: String(body.seq),
            layer_dir: `/snap/.stage/${body.seq}`,
            changed_files: body.base ? 14000 : 3,
            changed_bytes: body.base ? 700e6 : 250e3,
            index_s: 0.2,
            index_zstd_bytes: 500e3,
          };
        case "/layer/commit":
        case "/layer/discard":
          return { seq: String(body.seq) };
        case "/restore/merge":
          return { moved: 1 };
        case "/restore/verify":
          return { equal: true };
        case "/restore/reopen":
          return { claude_rc: 0, codex_rc: 0, claude_history: true, codex_history: true };
        case "/df":
          return { free: 10e9 };
        default:
          throw new Error(`unexpected POST ${path}`);
      }
    },
  };
}

function ports() {
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    log: (event, data) => logs.push({ event, ...data }),
    deadline: (ms) => ({ deadlineMs: ms }),
    storage: {
      get: async (key) => structuredClone(map.get(key)),
      put: async (key, value) => {
        map.set(key, structuredClone(value));
      },
      delete: async (key) => map.delete(key),
      setAlarm: async (time) => {
        alarm = time;
      },
    },
    sup: fakeSupervisor.current,
    container: {
      ensure: async () => ({ boot_id: boot }),
      keepAlive: async () => {
        calls.push("keepAlive");
      },
      stop: async () => {
        stopped = true;
      },
    },
    backups: (prefix, hold) => ({
      backup: async ({ dir, name, signal }) => {
        calls.push(`backup ${prefix}${name}`);
        const outcome = uploadHook?.({ prefix, dir, name, signal, hold });
        if (outcome instanceof Error) throw outcome;
        clock += 2_000;
        const record = {
          id: `${name}-id`,
          dir,
          size: name.startsWith("layer-0") ? 300e6 : 100e3,
          sha256: "a".repeat(64),
          format: "tar+zstd/1",
        };
        objects.set(`${prefix}${record.id}`, record.size);
        return record;
      },
      restore: async (record, options) => {
        calls.push(`restore ${prefix}${record.id} -> ${options.dir}`);
        clock += 1_000;
      },
    }),
    results: {
      put: async (key, value) => {
        objects.set(key, value);
      },
      count: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).length,
    },
  };
}

/** Runs alarms until none is set or `max` have run. Returns how many ran. */
async function runAlarms(max = 500) {
  let n = 0;
  while (alarm !== null && n < max) {
    clock = Math.max(clock, alarm);
    alarm = null;
    await tick(ports());
    n += 1;
  }
  return n;
}

beforeEach(() => {
  clock = Date.UTC(2026, 9, 22, 10, 0, 0);
  calls = [];
  logs = [];
  objects = new Map();
  alarm = null;
  map = new Map();
  boot = "boot-1";
  failPaths = new Set();
  uploadHook = null;
  stopped = false;
  fakeSupervisor.current = fakeSupervisor();
});

describe("starting and stopping", () => {
  it("records the campaign, sets the first alarm, and refuses a second start", async () => {
    const first = await startCampaign(ports(), "quick");
    expect(first.ok).toBe(true);
    expect(alarm).toBeGreaterThan(clock);
    expect(map.get("campaign").status).toBe("running");
    const second = await startCampaign(ports(), "full");
    expect(second).toEqual({ ok: false, reason: "a campaign is running" });
    expect((await startCampaign(ports(), "nope")).ok).toBe(false);
  });

  it("a stop request ends the campaign at the next alarm, with no further alarm", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms(1);
    await stopCampaign(ports(), "disarmed by the owner");
    await runAlarms(1);
    expect(map.get("campaign").status).toBe("stopped: disarmed by the owner");
    expect(alarm).toBe(null);
    const before = calls.length;
    await tick(ports());
    expect(calls.length).toBe(before);
  });

  it("a stop requested while a piece runs is honoured before the next alarm is set", async () => {
    await startCampaign(ports(), "quick");
    uploadHook = () => {
      map.set("stopRequested", "disarmed by the owner");
    };
    await runAlarms();
    expect(map.get("campaign").status).toBe("stopped: disarmed by the owner");
    expect(alarm).toBe(null);
  });

  it("stops when the arming expires", async () => {
    await startCampaign(ports(), "quick");
    clock += PLANS.quick.armMs + 1;
    alarm = clock;
    await runAlarms();
    expect(map.get("campaign").status).toBe("stopped: arming expired");
  });
});

describe("the quick plan, end to end against fakes", () => {
  it("runs every step in order and records each result", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    const campaign = map.get("campaign");
    expect(campaign.status).toBe("done");
    expect(stopped).toBe(true);
    expect(Object.keys(campaign.steps)).toEqual(PLANS.quick.steps);
    for (const step of PLANS.quick.steps) {
      expect(campaign.steps[step].ok).toBe(true);
      expect(objects.has(`results/${campaign.id}/${step}.json`)).toBe(true);
    }
    expect(objects.has(`results/${campaign.id}/campaign.json`)).toBe(true);
  });

  it("turns: a base, then one layer per turn, alternating Claude Code and Codex", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    const seq = calls.filter((c) => /^POST \/(turn|capture|layer|layer\/commit)\b/.test(c));
    const firstTurns = seq.slice(0, 3 + 4 * 2);
    expect(firstTurns).toEqual([
      "POST /capture",
      "POST /layer 0",
      "POST /layer/commit 0",
      "POST /turn",
      "POST /capture",
      "POST /layer 1",
      "POST /layer/commit 1",
      "POST /turn",
      "POST /capture",
      "POST /layer 2",
      "POST /layer/commit 2",
    ]);
    const turnRows = logs.filter((l) => l.event === "turn_layer").map((l) => l.row);
    expect(turnRows.map((r) => r.cli)).toEqual([undefined, "claude", "codex", "claude"]);
    expect(turnRows[0].upload.stored_bytes).toBe(300e6);
    const result = objects.get(`results/${map.get("campaign").id}/turns.json`);
    expect(result.summary.claude.turns).toBe(2);
    expect(result.summary.codex.turns).toBe(1);
    expect(map.get(`layers:${map.get("campaign").id}`)).toHaveLength(PLANS.quick.deltas + 1);
  });

  it("restore: every layer in order into the layer directory, each merged, then verified", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    const restores = calls.filter((c) => c.startsWith("restore layers/"));
    expect(restores).toEqual(
      [0, 1, 2, 3].map((n) => `restore layers/layer-${n}-id -> /restore-staging/layer`),
    );
    expect(calls.filter((c) => c === "POST /restore/merge")).toHaveLength(4);
    const result = objects.get(`results/${map.get("campaign").id}/restore.json`);
    expect(result.summary.chain_verify_equal).toBe(true);
    expect(result.summary.full_verify_equal).toBe(true);
    expect(result.reopen.codex_history).toBe(true);
  });

  it("r2-block: the pointer moves only after a completed upload", async () => {
    await startCampaign(ports(), "quick");
    uploadHook = ({ prefix, signal, hold }) => {
      if (prefix !== "r2block/") return undefined;
      expect(hold.until - hold.from).toBe(10_000);
      return signal.deadlineMs < 10_000 ? new Error("TimeoutError: deadline") : undefined;
    };
    await runAlarms();
    const result = objects.get(`results/${map.get("campaign").id}/r2-block.json`);
    expect(result.summary.map((r) => [r.case, r.upload_ok, r.pointer_moved])).toEqual([
      ["held-then-recovers", true, true],
      ["held-past-the-deadline", false, false],
    ]);
    expect(result.summary[1].objects_added).toBe(0);
    expect(result.summary[0].turns).toBe("4/4");
  });
});

describe("failures", () => {
  it("a failing step is recorded and the campaign goes on", async () => {
    failPaths.add("/calibrate");
    await startCampaign(ports(), "quick");
    await runAlarms();
    const campaign = map.get("campaign");
    expect(campaign.status).toBe("done");
    expect(campaign.steps.calibrate.ok).toBe(false);
    expect(campaign.steps.calibrate.summary.error).toContain("boom");
    expect(logs.some((l) => l.event === "step_error" && l.step === "calibrate")).toBe(true);
  });

  it("a failed upload of a layer fails the turns step and discards the staged layer", async () => {
    uploadHook = ({ prefix, name }) =>
      prefix === "layers/" && name === "layer-1" ? new Error("BACKUP_TRANSFER") : undefined;
    await startCampaign(ports(), "quick");
    await runAlarms();
    const campaign = map.get("campaign");
    expect(campaign.steps.turns.ok).toBe(false);
    expect(calls).toContain("POST /layer/discard 1");
    expect(calls).not.toContain("POST /layer/commit 1");
    // The restore step restores what was published: the base alone.
    expect(campaign.steps.restore.ok).toBe(true);
    expect(calls.filter((c) => c.startsWith("restore layers/"))).toHaveLength(1);
  });

  it("a container replaced twice in one step gives that step up", async () => {
    await startCampaign(ports(), "quick");
    for (let i = 0; i < 200 && map.get("campaign").index < 2; i++) await runAlarms(1);
    // In the bench step: replace the container on two of its alarms.
    boot = "boot-2";
    await runAlarms(1);
    boot = "boot-3";
    await runAlarms(1);
    await runAlarms();
    const campaign = map.get("campaign");
    expect(campaign.steps["bench-small"].ok).toBe(false);
    expect(campaign.steps["bench-small"].summary.error).toContain("replaced twice");
    expect(campaign.steps.turns.ok).toBe(true);
    expect(campaign.status).toBe("done");
  });

  it("a replaced container mid-step restarts the step and is logged", async () => {
    await startCampaign(ports(), "quick");
    // Run until the turns step has done its base and one turn.
    for (let i = 0; i < 200 && !logs.some((l) => l.event === "turn_layer" && l.row.n === 1); i++) {
      await runAlarms(1);
    }
    boot = "boot-2";
    await runAlarms();
    expect(logs.some((l) => l.event === "container_replaced")).toBe(true);
    expect(map.get("campaign").containerReplaced ?? map.get("campaign").replaced).toBe(1);
    expect(map.get("campaign").status).toBe("done");
  });
});
