// The restore phases (backup-<size>, rwake-<size>=N), driven through S1Computer's real alarm
// handler with a scripted container, a fake DirectoryBackup and a fake server. They check the
// design's wake order (container, restore, then the host), the records kept, failure handling,
// and that nothing runs outside an arming (IR-017).

import { describe, expect, it } from "vitest";
import { S1Computer } from "../src/index.js";

const TOOL = "/usr/local/bin/s1-workspace.py";
const WORKSPACE = { bytes: 663_237_644, files: 11_222 };
const RECORD = {
  id: "00000000-0000-4000-8000-000000000001",
  dir: "/root/workspace",
  size: 410_000_000,
  sha256: "a".repeat(64),
  format: "tar+zstd/1",
};

function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort());
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

/**
 * A container whose processes are scripted: the workspace tool, `true`, the host release and
 * the incarnation file. `log` records what happened, in order.
 */
function scriptedContainer({ images, measured = WORKSPACE } = {}) {
  const log = [];
  const state = { running: false, held: false, released: false, starts: [] };
  const answer = (cmd) => {
    if (cmd[0] === "python3" && cmd[1] === TOOL && cmd[2] === "--measure") {
      return JSON.stringify(measured);
    }
    if (cmd[0] === "python3" && cmd[1] === TOOL) {
      return JSON.stringify({ size: cmd[3], ...WORKSPACE });
    }
    if (cmd[0] === "touch" && cmd[1] === "/tmp/s1-host-release") state.released = true;
    if (cmd[0] === "cat") return "incarnation-1";
    return "";
  };
  const container = {
    images,
    get running() {
      return state.running;
    },
    start(options) {
      if (state.running) throw new Error("already running");
      state.running = true;
      state.held = options.env?.S1_HOLD_HOST === "1";
      state.released = false;
      state.starts.push(options);
      log.push(state.held ? "start(held)" : "start");
    },
    async destroy() {
      state.running = false;
      log.push("destroy");
    },
    async setInactivityTimeout() {},
    async interceptOutboundHttp() {},
    async exec(cmd) {
      if (!state.running) throw new Error("not running");
      log.push(`exec:${cmd[0] === "python3" ? cmd.slice(1, 3).join(" ") : cmd.join(" ")}`);
      const stdout = new TextEncoder().encode(answer(cmd));
      return { output: async () => ({ exitCode: 0, stdout, stderr: new Uint8Array() }) };
    },
  };
  return { container, log, state };
}

/** The server reports the host online only while the container runs and the host is released. */
function fakeServer(container) {
  const calls = [];
  return {
    calls,
    async hostStatus() {
      calls.push("hostStatus");
      const { running, held, released } = container.state;
      return running && (!held || released) ? "online" : "offline";
    },
    async marks() {
      return {};
    },
    async keepAlive() {
      return true;
    },
    async ensureUp() {
      calls.push("ensureUp");
      return { started: true, readyMs: 1 };
    },
    async stop() {
      calls.push("stop");
    },
  };
}

async function setup({ command, armed = true, images, restoreFails = false, measured } = {}) {
  const scripted = scriptedContainer({ images, measured });
  const server = fakeServer(scripted);
  const storage = memoryStorage();
  const ctx = {
    storage,
    container: scripted.container,
    exports: { HostRoute: () => ({}), DirectoryBackupGateway: () => ({}) },
    blockConcurrencyWhile: async (fn) => fn(),
    waitUntil() {},
  };
  const env = {
    S1_VERSION: "1",
    S1_START_GAP_MS: "0",
    S1_COMMAND: command,
    SERVER: { idFromName: (name) => name, get: () => server },
  };
  const computer = new S1Computer(ctx, env);
  const backups = { backups: [], restores: [] };
  computer.makeBackups = () => ({
    backup: async (options) => {
      scripted.log.push(`backup ${options.dir}`);
      backups.backups.push(options);
      return { ...RECORD, name: options.name };
    },
    restore: async (record) => {
      scripted.log.push(`restore ${record.id}`);
      backups.restores.push(record);
      if (restoreFails) throw new Error("BACKUP_TRANSFER: synthetic failure");
    },
  });
  if (armed) await computer.kickoff({ armedUntil: Date.now() + 3_600_000 });
  else {
    await storage.put("hostId", "0".repeat(32));
    await storage.put("queue", []);
    await storage.setAlarm(Date.now());
  }
  return { computer, storage, server, backups, ...scripted };
}

/** Runs alarms until the command's phases are done, without waiting for alarm times. */
async function runCampaign(t, maxAlarms = 60) {
  for (let i = 0; i < maxAlarms; i++) {
    if ((await t.storage.getAlarm()) === null) return;
    await t.computer.alarm();
    const idle =
      (await t.storage.get("lastCommand")) !== undefined &&
      (await t.storage.get("phase")) === undefined &&
      ((await t.storage.get("queue")) ?? []).length === 0;
    if (idle) return;
  }
  throw new Error("the campaign did not finish");
}

async function records(storage, event) {
  const out = [];
  for (const [, value] of await storage.list({ prefix: "result:" })) {
    if (value.s1 === event) out.push(value);
  }
  return out;
}

describe("backup-<size>", () => {
  it("builds the workspace on a running computer, backs it up and keeps the record", async () => {
    const t = await setup({ command: "t:backup-medium" });
    await runCampaign(t);
    expect(t.backups.backups).toEqual([{ dir: "/root/workspace", name: "s1-medium" }]);
    const stored = await t.storage.get("backup:medium");
    expect(stored.record.id).toBe(RECORD.id);
    expect(stored).toMatchObject(WORKSPACE);
    const [done] = await records(t.storage, "backup");
    expect(done).toMatchObject({
      size: "medium",
      ok: true,
      rawBytes: WORKSPACE.bytes,
      files: WORKSPACE.files,
      archiveBytes: RECORD.size,
      backupId: RECORD.id,
    });
    // The workspace is built before the backup reads it, on a container that is not held.
    expect(t.log.indexOf("exec:/usr/local/bin/s1-workspace.py /root/workspace")).toBeLessThan(
      t.log.indexOf("backup /root/workspace"),
    );
    expect(t.state.starts[0].env.S1_HOLD_HOST).toBeUndefined();
  });
});

describe("rwake-<size>=N", () => {
  it("restores before the host is released, on every wake", async () => {
    const t = await setup({ command: "t:backup-medium,rwake-medium=2" });
    await runCampaign(t);
    const wakes = (await records(t.storage, "wake")).filter((w) => w.label === "restore-medium");
    expect(wakes).toHaveLength(2);
    for (const wake of wakes) {
      expect(wake).toMatchObject({
        ok: true,
        status: "online",
        restoreError: null,
        restoredMatches: true,
        rawBytes: WORKSPACE.bytes,
        archiveBytes: RECORD.size,
      });
      expect(wake.execReadyMs).not.toBeNull();
      expect(wake.restoreMs).not.toBeNull();
      expect(wake.releasedMs).toBeGreaterThanOrEqual(wake.restoredMs);
      expect(wake.onlineMs).toBeGreaterThanOrEqual(wake.releasedMs);
    }
    expect(t.backups.restores.map((r) => r.id)).toEqual([RECORD.id, RECORD.id]);
    const held = t.state.starts.filter((s) => s.env.S1_HOLD_HOST === "1");
    expect(held).toHaveLength(2);
    // In each held start: the container runs commands, the restore finishes, then the release.
    let from = 0;
    for (let n = 0; n < 2; n++) {
      const start = t.log.indexOf("start(held)", from);
      const ready = t.log.indexOf("exec:true", start);
      const restore = t.log.indexOf(`restore ${RECORD.id}`, start);
      const release = t.log.indexOf("exec:touch /tmp/s1-host-release", start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(ready).toBeGreaterThan(start);
      expect(restore).toBeGreaterThan(ready);
      expect(release).toBeGreaterThan(restore);
      from = release;
    }
    // Every wake starts from a stopped container: one computer at a time.
    expect(t.log.filter((e) => e.startsWith("start")).length).toBe(
      t.log.filter((e) => e === "destroy").length,
    );
  });

  it("records a failed restore, still releases the host, and goes on", async () => {
    const t = await setup({ command: "t:backup-small,rwake-small=2", restoreFails: true });
    await runCampaign(t);
    const wakes = (await records(t.storage, "wake")).filter((w) => w.label === "restore-small");
    expect(wakes).toHaveLength(2);
    for (const wake of wakes) {
      expect(wake.ok).toBe(false);
      expect(wake.restoreError).toMatch(/BACKUP_TRANSFER/);
      expect(wake.releasedMs).not.toBeNull();
      expect(wake.restoreMs).toBeNull();
    }
    expect(t.log.filter((e) => e === "exec:touch /tmp/s1-host-release")).toHaveLength(2);
  });

  it("flags a restored tree that does not match the backup", async () => {
    const t = await setup({
      command: "t:backup-small,rwake-small=1",
      measured: { bytes: WORKSPACE.bytes - 1, files: WORKSPACE.files },
    });
    await runCampaign(t);
    const [wake] = (await records(t.storage, "wake")).filter((w) => w.label === "restore-small");
    expect(wake.restoredMatches).toBe(false);
  });

  it("is skipped, with no container started, when the size has no backup", async () => {
    const t = await setup({ command: "t:rwake-large=3" });
    await runCampaign(t);
    expect(await records(t.storage, "rwake-skipped")).toHaveLength(1);
    expect(t.state.starts).toEqual([]);
    expect(t.backups.restores).toEqual([]);
  });

  it("passes the image and size under the durable_object policy", async () => {
    const t = await setup({
      command: "t:backup-small,rwake-small=1",
      images: { computer: "registry.example/computer@sha256:1" },
    });
    await runCampaign(t);
    const held = t.state.starts.find((s) => s.env.S1_HOLD_HOST === "1");
    expect(held).toMatchObject({
      image: "registry.example/computer@sha256:1",
      instance: "standard-2",
      enableInternet: true,
    });
  });
});

describe("IR-017: the restore phases run only while armed", () => {
  it("an unarmed alarm builds, backs up and restores nothing", async () => {
    const t = await setup({ command: "t:backup-medium,rwake-medium=2", armed: false });
    await t.computer.alarm();
    expect(t.log).toEqual([]);
    expect(t.backups.backups).toEqual([]);
    expect(t.backups.restores).toEqual([]);
    expect(await t.storage.getAlarm()).toBeNull();
  });

  it("an arming that ends mid-phase stops the computer and the restores", async () => {
    const t = await setup({ command: "t:backup-medium,rwake-medium=20" });
    // Run the backup and a few restore wakes, then let the arming lapse.
    for (let i = 0; i < 8; i++) await t.computer.alarm();
    const restoresBefore = t.backups.restores.length;
    await t.storage.put("armedUntil", Date.now() - 1);
    await t.computer.alarm();
    expect(t.state.running).toBe(false);
    expect(await t.storage.get("phase")).toBeUndefined();
    expect(await t.storage.getAlarm()).toBeNull();
    await t.computer.alarm();
    expect(t.backups.restores.length).toBe(restoresBefore);
  });
});
