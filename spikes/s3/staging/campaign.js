// The S3 staging campaign: every measurement step 9 of the work plan asks for, run unattended
// by the Durable Object's alarm once the owner presses Start (a same-origin POST with the
// request-intent token, IR-017). Pure: everything it touches comes in through `ports`, so
// campaign.test.js drives it with fakes and local-e2e/driver.mjs with a Docker container.
//
// Each alarm runs one bounded piece of one step, stores where it got to, and sets the next
// alarm. A container supervisor job is polled across alarms, so no alarm runs long; the
// longest piece is the held upload of the R2 step, about 3 minutes (alarm limit: 15).
//
// Results go three ways: one JSON line per event to Workers Logs ({"s3": ...}), the full
// result of each step to R2 (results/<campaign>/<step>.json), and a summary in storage for
// the read-only /results page.

export const STEP_ALARM_MS = 1_000;
export const POLL_MS = 15_000;
const LAYER_DIR = "/restore-staging/layer";

/** The step lists. `full` is the staging run; `quick` rehearses every step in minutes. */
export const PLANS = {
  full: {
    armMs: 4 * 3_600_000,
    steps: [
      "probe",
      "setup",
      "bench-realistic",
      "turns",
      "restore",
      "r2-block",
      "calibrate",
      "bench-large",
      "throughput-large",
      "bench-many-small",
    ],
    bench: {
      "bench-realistic": {
        profile: "realistic",
        plan: [
          { method: "rsync-2phase", runs: 5 },
          { method: "reflink", runs: 3 },
        ],
      },
      "bench-large": {
        profile: "large",
        plan: [
          { method: "rsync-2phase", runs: 5 },
          { method: "reflink", runs: 3 },
        ],
      },
      "bench-many-small": {
        profile: "many-small",
        plan: [
          { method: "rsync-2phase", runs: 3 },
          { method: "reflink", runs: 3 },
        ],
      },
    },
    turnsProfile: "realistic",
    deltas: 20,
    r2: [
      { name: "held-then-recovers", holdMs: 120_000, deadlineMs: 600_000, load: 150 },
      { name: "held-past-the-deadline", holdMs: 120_000, deadlineMs: 60_000, load: 150 },
    ],
    holds: [40, 60],
  },
  quick: {
    armMs: 3_600_000,
    steps: ["probe", "setup", "bench-small", "turns", "restore", "r2-block", "calibrate"],
    bench: {
      "bench-small": {
        profile: "small",
        plan: [
          { method: "rsync-2phase", runs: 1 },
          { method: "reflink", runs: 1 },
        ],
      },
    },
    turnsProfile: "small",
    deltas: 3,
    r2: [
      { name: "held-then-recovers", holdMs: 10_000, deadlineMs: 120_000, load: 20 },
      { name: "held-past-the-deadline", holdMs: 10_000, deadlineMs: 5_000, load: 20 },
    ],
    holds: [5],
  },
};

function errorText(error) {
  if (error && typeof error === "object" && "code" in error && "name" in error) {
    return `${error.name} ${error.code}: ${error.message ?? ""}`.slice(0, 500);
  }
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);
}

function median(xs) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Starts a campaign: records it and sets the first alarm. Refuses while one runs. */
export async function startCampaign(ports, planName) {
  const plan = PLANS[planName];
  if (!plan) return { ok: false, reason: "unknown plan" };
  const existing = await ports.storage.get("campaign");
  if (existing && existing.status === "running")
    return { ok: false, reason: "a campaign is running" };
  const now = ports.now();
  const id = `c${new Date(now)
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14)}`;
  const campaign = {
    id,
    plan: planName,
    status: "running",
    index: 0,
    sub: {},
    startedAt: now,
    armedUntil: now + plan.armMs,
    bootId: null,
    steps: {},
  };
  await ports.storage.delete("stopRequested");
  await ports.storage.put("campaign", campaign);
  await ports.storage.setAlarm(now + STEP_ALARM_MS);
  ports.log("campaign_started", { campaign: id, plan: planName, steps: plan.steps });
  return { ok: true, campaign };
}

/** Asks a running campaign to stop; the next alarm records it and sets no further alarm. */
export async function stopCampaign(ports, reason) {
  await ports.storage.put("stopRequested", reason);
}

async function finish(ports, campaign, status) {
  campaign.status = status;
  campaign.endedAt = ports.now();
  await ports.storage.put("campaign", campaign);
  await ports.results.put(`results/${campaign.id}/campaign.json`, campaign);
  ports.log("campaign_ended", { campaign: campaign.id, status, steps: campaign.steps });
  if (status === "done") await ports.container.stop().catch(() => undefined);
}

/**
 * One alarm: check the campaign is still wanted, make sure the container is up (noticing a
 * replaced one), run one piece of the current step, store progress, set the next alarm.
 */
export async function tick(ports) {
  const campaign = await ports.storage.get("campaign");
  if (campaign?.status !== "running") return;
  const plan = PLANS[campaign.plan];
  const stop = await ports.storage.get("stopRequested");
  if (stop) return finish(ports, campaign, `stopped: ${stop}`);
  if (ports.now() > campaign.armedUntil) return finish(ports, campaign, "stopped: arming expired");
  if (campaign.index >= plan.steps.length) return finish(ports, campaign, "done");

  const step = plan.steps[campaign.index];
  const log = (event, data = {}) => ports.log(event, { campaign: campaign.id, step, ...data });
  let outcome;
  try {
    const boot = await ports.container.ensure();
    let replacedAgain = false;
    if (campaign.bootId && boot.boot_id !== campaign.bootId) {
      // A new container: in-container state (workspace, sessions, kept snapshot) is gone, so
      // the step starts again; a second replacement in one step gives the step up.
      log("container_replaced", { previous: campaign.bootId, now: boot.boot_id });
      campaign.sub = {};
      campaign.replaced = (campaign.replaced ?? 0) + 1;
      campaign.replacedIn = campaign.replacedIn ?? {};
      campaign.replacedIn[step] = (campaign.replacedIn[step] ?? 0) + 1;
      replacedAgain = campaign.replacedIn[step] > 1;
    }
    campaign.bootId = boot.boot_id;
    await ports.container.keepAlive();
    outcome = replacedAgain
      ? { done: true, result: { error: "the container was replaced twice during this step" } }
      : await STEPS[step.startsWith("bench-") ? "bench" : step]({
          ports,
          plan,
          step,
          sub: campaign.sub,
          campaign,
          log,
        });
  } catch (error) {
    outcome = { done: true, result: { error: errorText(error) } };
    log("step_error", { error: errorText(error) });
  }
  if (outcome.done) {
    const result = outcome.result ?? {};
    campaign.steps[step] = {
      ok: !result.error,
      summary: outcome.summary ?? (result.error ? { error: result.error } : {}),
      at: ports.now(),
    };
    await ports.results.put(`results/${campaign.id}/${step}.json`, result);
    log("step_done", { ok: !result.error, summary: campaign.steps[step].summary });
    campaign.index += 1;
    campaign.sub = {};
  }
  // The owner may have disarmed while this piece ran.
  if (await ports.storage.get("stopRequested")) {
    return finish(ports, campaign, `stopped: ${await ports.storage.get("stopRequested")}`);
  }
  await ports.storage.put("campaign", campaign);
  await ports.storage.setAlarm(ports.now() + (outcome.delayMs ?? STEP_ALARM_MS));
}

/** Starts a supervisor job once, then polls it on later alarms. */
async function job(ctx, path, body) {
  const { ports, sub } = ctx;
  if (!sub.job) {
    sub.job = (await ports.sup.post(path, body)).job;
    sub.jobStarted = ports.now();
    return { done: false, delayMs: POLL_MS };
  }
  const state = await ports.sup.get(`/jobs/${sub.job}`);
  if (state.state === "running") return { done: false, delayMs: POLL_MS };
  if (state.state === "error") return { done: true, result: { error: state.error } };
  return { done: true, result: state.result };
}

/** Uploads a staged layer and records the time, the stored size and the outcome. */
async function upload(ports, prefix, dir, options = {}) {
  const t0 = ports.now();
  try {
    const record = await ports.backups(prefix, options.hold).backup({
      dir,
      name: options.name,
      signal: options.deadlineMs ? ports.deadline(options.deadlineMs) : undefined,
    });
    return { ok: true, record, ms: ports.now() - t0 };
  } catch (error) {
    return { ok: false, error: errorText(error), ms: ports.now() - t0 };
  }
}

const STEPS = {
  async probe({ ports, log }) {
    const result = await ports.sup.get("/probe");
    log("probe", { result });
    const disk = result.disk ?? {};
    return {
      done: true,
      result,
      summary: {
        kernel: result.kernel,
        reflink: result.reflink,
        cgroup_writable: result.cgroup_freezer?.writable,
        cgroup_froze: result.cgroup_freezer?.froze,
        sigstop: result.sigstop_other_uid,
        cap_kill: result.caps?.CapEff?.CAP_KILL,
        cap_sys_ptrace: result.caps?.CapEff?.CAP_SYS_PTRACE,
        read_cold_mb_s: disk.read_after_fadvise_mb_s,
        write_mb_s: disk.write_fdatasync_mb_s,
        same_ctime: result.ctime_granularity?.same_ctime,
        df: result.df,
      },
    };
  },

  async setup(ctx) {
    const out = await job(ctx, "/setup", {});
    if (out.done) {
      ctx.log("setup", { result: out.result });
      out.summary = out.result;
    }
    return out;
  },

  async bench(ctx) {
    const { plan, step, ports, sub, log } = ctx;
    const spec = plan.bench[step];
    if (!sub.cleared) {
      // Free the snapshot area: a kept snapshot from an earlier step is no longer needed.
      await ports.sup.post("/rm", { path: "/snap", all: true, forget_base: true });
      sub.cleared = true;
    }
    const out = await job(ctx, "/bench", { ...spec, budget_s: 60 });
    if (out.done) {
      for (const row of out.result?.rows ?? []) log("bench_row", { profile: spec.profile, row });
      out.summary = out.result?.summary ?? { error: out.result?.error };
      log("bench_summary", { summary: out.summary });
    }
    return out;
  },

  /**
   * AR-25: a base, then one delta after each scripted Claude Code or Codex turn, alternating,
   * each captured from the kept snapshot (two-phase, content-correct) and uploaded with
   * DirectoryBackup. Records the bytes each turn changed and what they cost to upload.
   */
  async turns(ctx) {
    const { ports, plan, sub, log } = ctx;
    if (!sub.phase) {
      Object.assign(sub, {
        phase: "gen",
        n: 0,
        records: [],
        canary: `S3W${ports.now().toString(36)}`,
      });
      // The restore step reopens the sessions and looks for this word in their history.
      ctx.campaign.turnsCanary = sub.canary;
    }
    if (sub.phase === "gen") {
      const out = await job(ctx, "/genws", { profile: plan.turnsProfile });
      if (!out.done) return out;
      if (out.result?.error) return out;
      await ports.sup.post("/rm", { path: "/snap", all: true, forget_base: true });
      Object.assign(sub, { phase: "layers", job: null });
    }
    const n = sub.n;
    const row = { n };
    if (n > 0) {
      row.cli = n % 2 === 1 ? "claude" : "codex";
      row.turn = await ports.sup.post("/turn", {
        cli: row.cli,
        n: Math.floor((n - 1) / 2),
        canary: sub.canary,
      });
      if (row.turn.rc !== 0) throw new Error(`turn ${n} failed: ${JSON.stringify(row.turn)}`);
    }
    const cap = await ports.sup.post("/capture", {
      method: "rsync-2phase",
      keep: true,
      record_kinds: true,
      budget_s: 60,
    });
    row.capture = {
      outcome: cap.outcome,
      pause_s: cap.pause_s,
      precopy_s: cap.precopy_s,
      copy_s: cap.copy_s,
      reused: cap.reused_snapshot ?? false,
      stopped: cap.stopped_by_kind,
    };
    if (cap.outcome !== "snapshot_ready") throw new Error(`capture ${n}: ${cap.outcome}`);
    const { layer_dir: layerDir, ...layer } = await ports.sup.post("/layer", {
      seq: n,
      base: n === 0,
    });
    row.layer = layer;
    const up = await upload(ports, "layers/", layerDir, { name: `layer-${n}` });
    row.upload = { ok: up.ok, ms: up.ms, stored_bytes: up.record?.size, error: up.error };
    if (!up.ok) {
      await ports.sup.post("/layer/discard", { seq: n });
      throw new Error(`upload of layer ${n}: ${up.error}`);
    }
    await ports.sup.post("/layer/commit", { seq: n });
    sub.records.push(up.record);
    await ports.storage.put(`layers:${ctx.campaign.id}`, sub.records);
    log("turn_layer", { row });
    sub.rows = [...(sub.rows ?? []), row];
    sub.n += 1;
    if (sub.n <= plan.deltas) return { done: false };

    const deltas = sub.rows.slice(1);
    const base = sub.rows[0].upload.stored_bytes;
    let cumulative = 0;
    let rebaseAfter = null;
    for (const r of deltas) {
      cumulative += r.upload.stored_bytes;
      if (rebaseAfter === null && cumulative > base / 2) rebaseAfter = r.n;
    }
    const byCli = (cli) => deltas.filter((r) => r.cli === cli);
    const sumUp = (rows) => ({
      turns: rows.length,
      changed_bytes_median: median(rows.map((r) => r.layer.changed_bytes)),
      changed_bytes_worst: Math.max(...rows.map((r) => r.layer.changed_bytes)),
      stored_bytes_median: median(rows.map((r) => r.upload.stored_bytes)),
      stored_bytes_worst: Math.max(...rows.map((r) => r.upload.stored_bytes)),
      upload_ms_median: median(rows.map((r) => r.upload.ms)),
      pause_s_median: median(rows.map((r) => r.capture.pause_s)),
      pause_s_worst: Math.max(...rows.map((r) => r.capture.pause_s)),
      index_s_median: median(rows.map((r) => r.layer.index_s)),
    });
    const summary = {
      base_files: sub.rows[0].layer.changed_files,
      base_bytes: sub.rows[0].layer.changed_bytes,
      base_stored_bytes: base,
      base_upload_ms: sub.rows[0].upload.ms,
      index_zstd_bytes: sub.rows.at(-1).layer.index_zstd_bytes,
      claude: byCli("claude"),
      codex: byCli("codex"),
      deltas_stored_bytes: cumulative,
      rule_new_base_after_delta: rebaseAfter,
    };
    summary.claude = sumUp(summary.claude);
    summary.codex = sumUp(summary.codex);
    return { done: true, result: { rows: sub.rows, summary }, summary };
  },

  /**
   * AR-25: restore the base and every delta in order into a staging tree, check it against the
   * last index; then the same final state as one full layer, for comparison; then reopen the
   * CLI sessions from the restored copy (VD-09, mock model).
   */
  async restore({ ports, sub, log, campaign }) {
    const records = (await ports.storage.get(`layers:${campaign.id}`)) ?? [];
    if (records.length === 0) throw new Error("no layers to restore (the turns step did not run)");
    if (!sub.phase) {
      await ports.sup.post("/restore/reset", {});
      const t0 = ports.now();
      const rows = [];
      for (const [i, record] of records.entries()) {
        const t = ports.now();
        await ports.backups("layers/").restore(record, { dir: LAYER_DIR });
        const restoreMs = ports.now() - t;
        const merge = await ports.sup.post("/restore/merge", {});
        rows.push({ layer: i, stored_bytes: record.size, restore_ms: restoreMs, merge });
      }
      const verify = await ports.sup.post("/restore/verify", { seq: records.length - 1 });
      sub.chain = { layers: records.length, total_ms: ports.now() - t0, verify, rows };
      log("restore_chain", { chain: sub.chain });
      sub.phase = "full";
      return { done: false };
    }
    const layer = await ports.sup.post("/layer", {
      seq: "final-full",
      base: true,
      standalone: true,
    });
    const up = await upload(ports, "full/", "/snap/.stage/final-full", { name: "final-full" });
    await ports.sup.post("/layer/discard", { seq: "final-full" });
    const full = { stored_bytes: up.record?.size, upload_ms: up.ms, upload_error: up.error };
    if (up.ok) {
      const t = ports.now();
      await ports.backups("full/").restore(up.record, { dir: "/restore-staging/full" });
      full.restore_ms = ports.now() - t;
      full.verify = await ports.sup.post("/restore/verify", { tree: "full", seq: "final-full" });
    }
    full.files = layer.changed_files;
    const reopen = await ports.sup.post("/restore/reopen", { canary: campaign.turnsCanary ?? "" });
    await ports.sup.post("/restore/reset", {});
    const summary = {
      chain_layers: sub.chain.layers,
      chain_total_ms: sub.chain.total_ms,
      chain_verify_equal: sub.chain.verify.equal,
      chain_restore_ms_median: median(sub.chain.rows.map((r) => r.restore_ms)),
      full_restore_ms: full.restore_ms,
      full_verify_equal: full.verify?.equal,
      reopen,
    };
    log("restore_full", { full, reopen });
    return { done: true, result: { chain: sub.chain, full, reopen, summary }, summary };
  },

  /**
   * RC-15 with R2 blocked over 90 s: from the moment the upload starts, the gateway holds every
   * part upload until holdMs have passed, while conversation turns and one capture run in the
   * container. Case 1 waits it out (does the helper survive a 120 s stall?); case 2's deadline
   * aborts the upload. The "pointer" moves only after a completed, verified upload.
   */
  async "r2-block"({ ports, plan, sub, log }) {
    sub.case = sub.case ?? 0;
    const spec = plan.r2[sub.case];
    const seq = `r2-${sub.case}`;
    await ports.sup.post("/layer", { seq, base: true, standalone: true });
    const pointerBefore = (await ports.storage.get("pointer:r2")) ?? null;
    const objectsBefore = await ports.results.count("r2block/");
    const load = await ports.sup.post("/load", {
      duration_s: spec.load,
      turn_every_s: 5,
      capture_at_s: Math.min(30, Math.floor(spec.load / 4)),
    });
    const t0 = ports.now();
    const up = await upload(ports, "r2block/", `/snap/.stage/${seq}`, {
      name: seq,
      deadlineMs: spec.deadlineMs,
      hold: { from: t0, until: t0 + spec.holdMs },
    });
    if (up.ok) await ports.storage.put("pointer:r2", { id: up.record.id, case: spec.name });
    let loadState = await ports.sup.get(`/jobs/${load.job}`);
    while (loadState.state === "running") {
      await ports.sleep(5_000);
      loadState = await ports.sup.get(`/jobs/${load.job}`);
    }
    await ports.sup.post("/layer/discard", { seq });
    const row = {
      case: spec.name,
      hold_ms: spec.holdMs,
      deadline_ms: spec.deadlineMs,
      upload: { ok: up.ok, ms: up.ms, stored_bytes: up.record?.size, error: up.error },
      pointer_before: pointerBefore,
      pointer_after: (await ports.storage.get("pointer:r2")) ?? null,
      objects_before: objectsBefore,
      objects_after: await ports.results.count("r2block/"),
      load: loadState.result ?? { error: loadState.error },
    };
    log("r2_case", { row: { ...row, load: { ...row.load, rows: undefined } } });
    sub.rows = [...(sub.rows ?? []), row];
    sub.case += 1;
    if (sub.case < plan.r2.length) return { done: false };
    const summary = sub.rows.map((r) => ({
      case: r.case,
      upload_ok: r.upload.ok,
      upload_ms: r.upload.ms,
      error: r.upload.error,
      pointer_moved: JSON.stringify(r.pointer_before) !== JSON.stringify(r.pointer_after),
      objects_added: r.objects_after - r.objects_before,
      turns: `${r.load.turns_ok}/${r.load.turns}`,
      capture_pause_s: r.load.capture?.pause_s,
      capture_outcome: r.load.capture?.outcome,
      host: r.load.host,
    }));
    return { done: true, result: { rows: sub.rows, summary }, summary };
  },

  async calibrate(ctx) {
    const out = await job(ctx, "/calibrate", { holds: ctx.plan.holds });
    if (out.done) {
      out.summary = (out.result?.rows ?? []).map((r) => ({
        hold_s: r.hold_s,
        pause_s: r.pause_s,
        outcome: r.outcome,
        host: r.host,
        host_connects: r.host_connects,
        turn_after: r.turn_after?.ok,
        stopped: r.stopped_by_kind,
      }));
      if (out.result?.error) out.summary = { error: out.result.error };
      ctx.log("calibrate", { summary: out.summary });
    }
    return out;
  },

  /** VD-14: container-to-R2 throughput for the large workspace, if the disk has room. */
  async "throughput-large"(ctx) {
    const { ports, sub, log } = ctx;
    if (!sub.df) sub.df = await ports.sup.post("/df", { path: "/snap" });
    const df = sub.df;
    // Minutes for 2.4 GB cold, so the capture runs as a job polled across alarms.
    const out = await job(ctx, "/capture", { method: "rsync-2phase", budget_s: 60, as_job: true });
    if (!out.done) return out;
    const cap = out.result ?? {};
    if (cap.outcome !== "snapshot_ready") {
      return { done: true, result: { error: `capture: ${cap.outcome ?? cap.error}` } };
    }
    const result = { free_bytes: df.free, size_bytes: cap.size_bytes };
    if (df.free < cap.size_bytes * 2.5) {
      await ports.sup.post("/rm", { path: cap.snapshot_dir });
      result.skipped = "not enough free disk for a restore beside the snapshot";
      return { done: true, result, summary: result };
    }
    const layer = await ports.sup.post("/layer", {
      seq: "large",
      base: true,
      standalone: true,
      snapshot_dir: cap.snapshot_dir,
    });
    result.index_s = layer.index_s;
    const up = await upload(ports, "full/", "/snap/.stage/large", { name: "large" });
    await ports.sup.post("/layer/discard", { seq: "large" });
    await ports.sup.post("/rm", { path: cap.snapshot_dir });
    Object.assign(result, { upload_ms: up.ms, stored_bytes: up.record?.size, error: up.error });
    if (up.ok) {
      const t = ports.now();
      await ports.backups("full/").restore(up.record, { dir: "/restore-staging/large" });
      result.restore_ms = ports.now() - t;
      result.verify = await ports.sup.post("/restore/verify", { tree: "large", seq: "large" });
      await ports.sup.post("/restore/reset", {});
      result.upload_mb_s = Math.round((cap.size_bytes / 1e6 / (up.ms / 1000)) * 10) / 10;
      result.restore_mb_s =
        Math.round((cap.size_bytes / 1e6 / (result.restore_ms / 1000)) * 10) / 10;
    }
    log("throughput", { result });
    return { done: true, result, summary: result };
  },
};
