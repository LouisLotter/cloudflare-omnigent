// The staging campaign's step machine (campaign.js), driven alarm by alarm with a fake
// supervisor (which keeps the container's published layer, kept snapshot and workspace
// profile), a fake DirectoryBackup and fake storage. Checks the order of the work, what is
// recorded, the R2 cases' publication and blocking rules, the restore's acceptance checks, and
// that stopping, expiry, errors, a slow or replaced container and a reset between a layer's
// commit and the stored progress are handled.
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs

import { beforeEach, describe, expect, it } from "vitest";
import {
  isTransient,
  PLANS,
  READY_LIMIT_MS,
  startCampaign,
  stopCampaign,
  tick,
} from "./campaign.js";

let clock;
let calls;
let logs;
let objects;
let alarm;
let map;
let boot;
let ready;
let failPaths;
let uploadHook;
let commitHook;
let holds;
let stopped;
let box;
let mergeHook;
let resultsFail;
let stopFails;
let holdNotWaited;
let ignoreDeadline;
let putHook;

function fakeSupervisor() {
  const jobs = new Map();
  let jobN = 0;
  const startJob = (result) => {
    const id = `j${++jobN}`;
    jobs.set(id, { polls: 0, result });
    return { job: id };
  };
  const capture = (body) => {
    if (body.keep) box.kept = "/snap/kept";
    return {
      outcome: "snapshot_ready",
      pause_s: 0.5,
      precopy_s: 1,
      copy_s: 0.4,
      snapshot_dir: "/snap/x",
      size_bytes: 700e6,
      reused_snapshot: Boolean(body.keep),
      stopped_by_kind: { "omnigent-host": 1 },
    };
  };
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
          box.profile = body.profile;
          return startJob({ summary: { profile: body.profile }, rows: [{ n: 1 }, { n: 2 }] });
        case "/genws":
          box.profile = body.profile;
          return startJob({ profile: body.profile });
        case "/calibrate":
          return startJob({ rows: body.holds.map((h) => ({ hold_s: h, pause_s: h })) });
        case "/load":
          return startJob({
            turns: 4,
            turns_ok: 4,
            capture: { pause_s: 0.6, outcome: "snapshot_ready" },
            host: {},
          });
        case "/rm":
          if (body.all) box.kept = null;
          return {};
        case "/restore/reset":
          box.merged = null;
          return {};
        case "/turn":
          return { rc: 0, cli: body.cli, n: body.n };
        case "/capture":
          return body.as_job ? startJob(capture(body)) : capture(body);
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
          box.published = String(body.seq);
          commitHook?.(body.seq);
          return { seq: String(body.seq) };
        case "/layer/discard":
          return { seq: String(body.seq) };
        case "/restore/merge":
          box.merged = String(body.seq);
          mergeHook?.(body.seq);
          return { seq: String(body.seq), moved: 1, merge_s: 0.01 };
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
        putHook?.(key, value);
      },
      delete: async (key) => map.delete(key),
      setAlarm: async (time) => {
        alarm = time;
      },
    },
    sup: fakeSupervisor.current,
    container: {
      ensure: async () =>
        ready
          ? {
              boot_id: boot,
              published_layer: box.published,
              kept_snapshot: box.kept,
              profile: box.profile,
              restore_merged: box.merged,
            }
          : null,
      keepAlive: async () => {
        calls.push("keepAlive");
      },
      stop: async () => {
        if (stopFails > 0) {
          stopFails -= 1;
          throw new Error("destroy failed");
        }
        stopped = true;
      },
    },
    holdRecord: async (key) => holds.get(key) ?? null,
    backups: (prefix, hold) => ({
      backup: async ({ dir, name, signal }) => {
        calls.push(`backup ${prefix}${name}`);
        if (hold) {
          holds.set(hold.key, {
            first: clock + 500,
            until: clock + 500 + hold.ms,
            parts: 16,
            promisedMaxMs: hold.ms,
            observedMaxMs: 0,
          });
        }
        const outcome = uploadHook?.({ prefix, dir, name, signal, hold });
        if (outcome instanceof Error) throw outcome;
        // A deadline that ends inside the hold aborts the upload, as on Cloudflare.
        if (hold && signal?.deadlineMs < hold.ms + 500 && !ignoreDeadline) {
          throw new Error("TimeoutError: The operation was aborted due to timeout");
        }
        if (hold && holds.get(hold.key).observedMaxMs === 0 && !holdNotWaited) {
          holds.get(hold.key).observedMaxMs = hold.ms + 400;
        }
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
        if (resultsFail > 0) {
          resultsFail -= 1;
          throw new Error("R2 unavailable");
        }
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

const campaign = () => map.get("campaign");
const result = (step) => objects.get(`results/${campaign().id}/${step}.json`);

beforeEach(() => {
  clock = Date.UTC(2026, 9, 22, 10, 0, 0);
  calls = [];
  logs = [];
  objects = new Map();
  alarm = null;
  map = new Map();
  boot = "boot-1";
  ready = true;
  failPaths = new Set();
  uploadHook = null;
  commitHook = null;
  holds = new Map();
  stopped = false;
  box = { published: null, kept: null, profile: null, merged: null };
  mergeHook = null;
  resultsFail = 0;
  stopFails = 0;
  holdNotWaited = false;
  ignoreDeadline = false;
  putHook = null;
  fakeSupervisor.current = fakeSupervisor();
});

describe("starting and stopping", () => {
  it("records the campaign, sets the first alarm, and refuses a second start", async () => {
    const first = await startCampaign(ports(), "quick");
    expect(first.ok).toBe(true);
    expect(alarm).toBeGreaterThan(clock);
    expect(campaign().status).toBe("running");
    const second = await startCampaign(ports(), "full");
    expect(second).toEqual({ ok: false, reason: "a campaign is running" });
    expect((await startCampaign(ports(), "nope")).ok).toBe(false);
  });

  it("a stop request ends the campaign at the next alarm, stops the container, sets no alarm", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms(1);
    await stopCampaign(ports(), "disarmed by the owner");
    await runAlarms(1);
    expect(campaign().status).toBe("stopped: disarmed by the owner");
    expect(stopped).toBe(true);
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
    expect(campaign().status).toBe("stopped: disarmed by the owner");
    expect(stopped).toBe(true);
    expect(alarm).toBe(null);
  });

  it("stops, and stops the container, when the arming expires", async () => {
    await startCampaign(ports(), "quick");
    clock += PLANS.quick.armMs + 1;
    alarm = clock;
    await runAlarms();
    expect(campaign().status).toBe("stopped: arming expired");
    expect(stopped).toBe(true);
  });
});

describe("the quick plan, end to end against fakes", () => {
  it("runs every step in order and records each result", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    expect(campaign().status).toBe("done");
    expect(stopped).toBe(true);
    expect(Object.keys(campaign().steps)).toEqual(PLANS.quick.steps);
    for (const step of PLANS.quick.steps) {
      expect([step, campaign().steps[step].ok, campaign().steps[step].failed]).toEqual([
        step,
        true,
        undefined,
      ]);
      expect(result(step)).toBeDefined();
    }
    expect(objects.has(`results/${campaign().id}/campaign.json`)).toBe(true);
  });

  it("turns: a base, then one layer per turn, alternating Claude Code and Codex", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    const seq = calls.filter((c) => /^POST \/(turn|capture|layer|layer\/commit)\b/.test(c));
    expect(seq.slice(0, 11)).toEqual([
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
    const rows = logs.filter((l) => l.event === "turn_layer").map((l) => l.row);
    expect(rows.map((r) => r.cli)).toEqual([undefined, "claude", "codex", "claude"]);
    expect(rows[0].upload.stored_bytes).toBe(300e6);
    expect(result("turns").summary.claude.turns).toBe(2);
    expect(result("turns").summary.codex.turns).toBe(1);
    expect(map.get(`layers:${campaign().id}`)).toHaveLength(PLANS.quick.deltas + 1);
  });

  it("restore: every layer in order into the layer directory, each merged, then verified", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms();
    const restores = calls.filter((c) => c.startsWith("restore layers/"));
    expect(restores).toEqual(
      [0, 1, 2, 3].map((n) => `restore layers/layer-${n}-id -> /restore-staging/layer`),
    );
    expect(calls.filter((c) => c.startsWith("POST /restore/merge"))).toHaveLength(4);
    expect(result("restore").summary.chain_verify_equal).toBe(true);
    expect(result("restore").summary.full_verify_equal).toBe(true);
    expect(result("restore").failed).toEqual([]);
  });

  it("r2-block: the pointer moves only after a completed upload; both cases meet their checks", async () => {
    await startCampaign(ports(), "quick");
    uploadHook = ({ prefix, signal, hold }) => {
      if (prefix !== "r2block/") return undefined;
      expect(hold.ms).toBe(10_000);
      return signal.deadlineMs < 10_000 ? new Error("TimeoutError: deadline") : undefined;
    };
    await runAlarms();
    const summary = result("r2-block").summary;
    expect(summary.map((r) => [r.case, r.upload_ok, r.pointer_moved, r.failed])).toEqual([
      ["held-then-recovers", true, true, []],
      ["held-past-the-deadline", false, false, []],
    ]);
    expect(summary[0].observed_max_wait_ms).toBeGreaterThanOrEqual(10_000);
    expect(summary[1].objects_added).toBe(0);
    expect(summary[0].turns).toBe("4/4");
    expect(campaign().steps["r2-block"].ok).toBe(true);
  });

  it("r2-block: a hold no part was seen to wait out does not show R2 blocked", async () => {
    await startCampaign(ports(), "quick");
    holdNotWaited = true;
    uploadHook = ({ prefix, signal }) =>
      prefix === "r2block/" && signal.deadlineMs < 10_000 ? new Error("TimeoutError") : undefined;
    await runAlarms();
    expect(campaign().steps["r2-block"].ok).toBe(false);
    expect(campaign().steps["r2-block"].failed).toEqual([
      "held-then-recovers: no part was seen to wait 7500 ms, so R2 was not shown blocked",
    ]);
  });

  it("r2-block: an unexpected publication, failed turns or a failed capture are reported", async () => {
    await startCampaign(ports(), "quick");
    ignoreDeadline = true;
    const sup = fakeSupervisor.current;
    const post = sup.post;
    sup.post = async (path, body) => {
      if (path === "/load") {
        calls.push("POST /load");
        return post("/setup", {}).then(() => ({ job: "load-bad" }));
      }
      return post(path, body);
    };
    const get = sup.get;
    sup.get = async (path) =>
      path === "/jobs/load-bad"
        ? {
            state: "done",
            result: { turns: 4, turns_ok: 0, capture: { outcome: "worker_died" }, host: {} },
          }
        : get(path);
    await runAlarms();
    const failed = campaign().steps["r2-block"].failed;
    expect(failed).toContain("held-past-the-deadline: the upload completed despite the deadline");
    expect(failed).toContain("held-past-the-deadline: something was published");
    expect(failed).toContain("held-then-recovers: turns during the block: 0/4");
    expect(failed).toContain("held-then-recovers: the capture during the block: worker_died");
  });
});

describe("the full plan, against fakes", () => {
  it("runs all ten steps, with the 120 s holds, the 40 s and 60 s pauses and the large throughput", async () => {
    const seen = [];
    uploadHook = ({ prefix, hold, signal }) => {
      if (prefix === "r2block/") seen.push([hold.ms, signal.deadlineMs]);
      return undefined;
    };
    await startCampaign(ports(), "full");
    await runAlarms(2000);
    expect(campaign().status).toBe("done");
    expect(Object.keys(campaign().steps)).toEqual(PLANS.full.steps);
    expect(Object.values(campaign().steps).every((s) => s.ok)).toBe(true);
    expect(seen).toEqual([
      [120_000, 480_000],
      [120_000, 60_000],
    ]);
    expect(calls.filter((c) => c.startsWith("restore layers/"))).toHaveLength(21);
    expect(result("throughput-large").verify.equal).toBe(true);
    expect(calls).toContain("restore full/large-id -> /restore-staging/large");
    expect(result("calibrate").rows.map((r) => r.hold_s)).toEqual([40, 60]);
    // Every transfer had a deadline within the alarm's budget.
    expect(logs.filter((l) => l.event === "step_error")).toEqual([]);
  });
});

describe("transient connection drops and the AR-25 rerun", () => {
  it("a dropped connection during a turn resumes the step; the repeated unit is marked", async () => {
    await startCampaign(ports(), "quick");
    let dropped = 0;
    const sup = fakeSupervisor.current;
    const post = sup.post;
    sup.post = async (path, body) => {
      if (path === "/turn" && body.cli === "claude" && body.n === 1 && dropped === 0) {
        dropped += 1;
        await post(path, body); // the container ran the turn; the reply was lost
        throw new Error("Network connection lost.");
      }
      return post(path, body);
    };
    await runAlarms();
    expect(logs.some((l) => l.event === "step_transient_error" && l.step === "turns")).toBe(true);
    expect(campaign().steps.turns.ok).toBe(true);
    expect(result("turns").summary.repeated_turns).toEqual([3]);
    expect(map.get(`layers:${campaign().id}`)).toHaveLength(4);
    expect(campaign().steps.restore.ok).toBe(true);
  });

  it("a connection that keeps dropping fails the step but keeps what it gathered", async () => {
    await startCampaign(ports(), "quick");
    const sup = fakeSupervisor.current;
    const post = sup.post;
    sup.post = async (path, body) => {
      if (path === "/turn" && body.n === 1) throw new Error("Network connection lost.");
      return post(path, body);
    };
    await runAlarms();
    expect(campaign().steps.turns.ok).toBe(false);
    expect(
      logs.filter((l) => l.event === "step_transient_error" && l.step === "turns"),
    ).toHaveLength(3);
    const partial = result("turns").partial;
    expect(partial.rows.map((r) => r.n)).toEqual([0, 1, 2]);
    expect(partial.records).toHaveLength(3);
  });

  it("isTransient sees the message through causes, and nothing else", () => {
    expect(isTransient(new Error("Network connection lost."))).toBe(true);
    expect(
      isTransient(new Error("wrapped", { cause: new Error("Network connection lost.") })),
    ).toBe(true);
    expect(isTransient(new Error("supervisor /turn: 500 boom"))).toBe(false);
  });

  it("the ar25 plan runs the conversations, 20 turns and the restore", async () => {
    await startCampaign(ports(), "ar25");
    await runAlarms(2000);
    expect(campaign().status).toBe("done");
    expect(Object.keys(campaign().steps)).toEqual(["setup", "turns", "restore"]);
    expect(Object.values(campaign().steps).every((st) => st.ok)).toBe(true);
    expect(map.get(`layers:${campaign().id}`)).toHaveLength(21);
    expect(result("turns").summary.claude.turns).toBe(10);
    expect(result("turns").summary.codex.turns).toBe(10);
  });
});

describe("failures", () => {
  it("R2 failing to take the result files neither stops nor strands the campaign", async () => {
    resultsFail = 1_000_000;
    await startCampaign(ports(), "quick");
    await runAlarms();
    expect(campaign().status).toBe("done");
    expect(stopped).toBe(true);
    expect(logs.filter((l) => l.event === "result_write_failed").length).toBeGreaterThan(5);
  });

  it("a stop request is recorded even when no alarm is pending", async () => {
    await startCampaign(ports(), "quick");
    await runAlarms(1);
    alarm = null; // the runtime gave up retrying the alarm
    await stopCampaign(ports(), "disarmed by the owner");
    expect(alarm).not.toBe(null);
    await runAlarms();
    expect(campaign().status).toBe("stopped: disarmed by the owner");
    expect((await startCampaign(ports(), "quick")).ok).toBe(true);
  });

  it("a container that does not stop at the end is stopped by a later alarm", async () => {
    stopFails = 2;
    await startCampaign(ports(), "quick");
    await runAlarms();
    expect(campaign().status).toBe("done");
    expect(stopped).toBe(true);
    expect(campaign().stopPending).toBe(false);
    expect(logs.some((l) => l.event === "container_stop_failed")).toBe(true);
  });

  it("a reset after the last layer's progress was stored summarises without another turn", async () => {
    await startCampaign(ports(), "quick");
    let before = null;
    putHook = (key, value) => {
      const done = value.sub?.n === PLANS.quick.deltas + 1 && !value.sub.pending;
      if (key === "campaign" && value.index === 3 && done && !before)
        before = structuredClone(value);
    };
    for (let i = 0; i < 300 && !before; i++) await runAlarms(1);
    expect(before).not.toBe(null);
    const turnsBefore = calls.filter((c) => c === "POST /turn").length;
    map.set("campaign", before);
    alarm = clock;
    await runAlarms();
    expect(calls.filter((c) => c === "POST /turn").length).toBe(turnsBefore);
    expect(map.get(`layers:${campaign().id}`)).toHaveLength(PLANS.quick.deltas + 1);
    expect(campaign().steps.turns.ok).toBe(true);
    expect(campaign().steps.restore.ok).toBe(true);
  });

  it("a reset after a merge, before its progress was stored, never merges that layer twice", async () => {
    await startCampaign(ports(), "quick");
    let before = null;
    mergeHook = (seq) => {
      if (String(seq) === "2" && !before) before = structuredClone(map.get("campaign"));
    };
    for (let i = 0; i < 300 && !before; i++) await runAlarms(1);
    // The alarm that merged layer 2 completed; the reset brings back the earlier state.
    map.set("campaign", before);
    alarm = clock;
    await runAlarms();
    const merges = calls.filter((c) => c.startsWith("POST /restore/merge"));
    expect(merges).toEqual([0, 1, 2, 3].map((n) => `POST /restore/merge ${n}`));
    expect(logs.some((l) => l.event === "restore_resumed")).toBe(true);
    expect(campaign().steps.restore.ok).toBe(true);
    // Layers 2 and 3 were merged in the alarm the reset undid; neither is merged again.
    expect(result("restore").summary.chain_resumed_layers).toBe(2);
  });

  it("a failing step is recorded and the campaign goes on", async () => {
    failPaths.add("/calibrate");
    await startCampaign(ports(), "quick");
    await runAlarms();
    expect(campaign().status).toBe("done");
    expect(campaign().steps.calibrate.ok).toBe(false);
    expect(campaign().steps.calibrate.summary.error).toContain("boom");
    expect(logs.some((l) => l.event === "step_error" && l.step === "calibrate")).toBe(true);
  });

  it("a failed layer upload fails the turns step, and the short chain fails the restore's check", async () => {
    uploadHook = ({ prefix, name }) =>
      prefix === "layers/" && name === "layer-1" ? new Error("BACKUP_TRANSFER") : undefined;
    await startCampaign(ports(), "quick");
    await runAlarms();
    expect(campaign().steps.turns.ok).toBe(false);
    expect(calls).toContain("POST /layer/discard 1");
    expect(calls).not.toContain("POST /layer/commit 1");
    expect(calls.filter((c) => c.startsWith("restore layers/"))).toHaveLength(1);
    expect(campaign().steps.restore.ok).toBe(false);
    expect(campaign().steps.restore.failed).toEqual(["1 layers, not 4"]);
  });

  it("a Durable Object reset after a layer's commit neither loses nor repeats that layer", async () => {
    await startCampaign(ports(), "quick");
    let before = null;
    commitHook = (seq) => {
      // The state the campaign had stored just before this commit: what a reset leaves.
      if (String(seq) === "2" && !before) {
        before = { campaign: structuredClone(map.get("campaign")), layers: null };
        before.layers = structuredClone(map.get(`layers:${before.campaign.id}`));
      }
    };
    for (let i = 0; i < 300 && !before; i++) await runAlarms(1);
    // The tick that committed layer 2 finished; now the reset throws its progress away.
    map.set("campaign", before.campaign);
    map.set(`layers:${before.campaign.id}`, before.layers);
    alarm = clock;
    await runAlarms();
    const records = map.get(`layers:${campaign().id}`);
    expect(records.map((r) => r.id)).toEqual([
      "layer-0-id",
      "layer-1-id",
      "layer-2-id",
      "layer-3-id",
    ]);
    expect(calls.filter((c) => c === "POST /layer/commit 2")).toHaveLength(1);
    expect(calls.filter((c) => c === "POST /layer 2")).toHaveLength(1);
    expect(campaign().steps.restore.ok).toBe(true);
  });

  it("a container that is slow to start gets later alarms; after 15 minutes the step is given up", async () => {
    await startCampaign(ports(), "quick");
    ready = false;
    await runAlarms(3);
    expect(logs.filter((l) => l.event === "container_not_ready")).toHaveLength(3);
    expect(campaign().index).toBe(0);
    ready = true;
    await runAlarms(1);
    expect(campaign().steps.probe.ok).toBe(true);
    ready = false;
    const since = clock;
    for (let i = 0; i < 500 && !campaign().steps.setup; i++) await runAlarms(1);
    expect(clock - since).toBeGreaterThanOrEqual(READY_LIMIT_MS);
    expect(campaign().steps.setup.ok).toBe(false);
    expect(campaign().steps.setup.summary.error).toContain("not ready for 15 minutes");
  });

  it("a container replaced twice in one step gives that step up", async () => {
    await startCampaign(ports(), "quick");
    for (let i = 0; i < 200 && campaign().index < 2; i++) await runAlarms(1);
    boot = "boot-2";
    await runAlarms(1);
    boot = "boot-3";
    await runAlarms(1);
    await runAlarms();
    expect(campaign().steps["bench-small"].ok).toBe(false);
    expect(campaign().steps["bench-small"].summary.error).toContain("replaced twice");
    expect(campaign().steps.turns.ok).toBe(true);
    expect(campaign().status).toBe("done");
  });

  it("a container replaced during the turns restarts the chain; one replaced before the restore fails it", async () => {
    await startCampaign(ports(), "quick");
    for (let i = 0; i < 200 && !logs.some((l) => l.event === "turn_layer" && l.row.n === 1); i++) {
      await runAlarms(1);
    }
    boot = "boot-2";
    box = { published: null, kept: null, profile: null };
    await runAlarms();
    expect(logs.some((l) => l.event === "container_replaced")).toBe(true);
    expect(campaign().steps.turns.ok).toBe(true);
    expect(map.get(`layers:${campaign().id}`)).toHaveLength(4);
    expect(campaign().steps.restore.ok).toBe(true);
  });

  it("the restore refuses a chain the container no longer has", async () => {
    await startCampaign(ports(), "quick");
    for (let i = 0; i < 300 && campaign().index < 4; i++) await runAlarms(1);
    // Between the turns and the restore, the container was replaced (a new one, no chain).
    box.published = null;
    await runAlarms();
    expect(campaign().steps.restore.ok).toBe(false);
    expect(campaign().steps.restore.summary.error).toContain("was replaced");
  });

  it("throughput-large regenerates the large workspace when it is not there", async () => {
    await startCampaign(ports(), "full");
    for (let i = 0; i < 2000 && campaign().index < 8; i++) await runAlarms(1);
    box.profile = null;
    await runAlarms(2000);
    expect(calls.filter((c) => c === "POST /genws").length).toBeGreaterThanOrEqual(2);
    expect(campaign().steps["throughput-large"].ok).toBe(true);
    expect(result("throughput-large").profile).toBe("large");
  });
});
