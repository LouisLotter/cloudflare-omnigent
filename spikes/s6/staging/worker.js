// Spike S6 staging Worker: one cloud computer for the sign-in and credential-checkpoint session.
//
// - The owner opens the page (behind the staging tool's owner-only Access application), starts
//   the computer, and signs in to Claude and Codex in the embedded terminal (ttyd, at /term/).
// - The Durable Object plays WorkspaceDO: it numbers, stores and publishes checkpoints, fences
//   them by generation and by the order the copies were taken, refuses credential checkpoints
//   until a computer's restore is done, and restores into each new container, workspace first.
//   Checkpoint bytes move over exec() pipes (credsync export/import/watch-export) and are kept in
//   the Durable Object's SQLite storage, standing in for R2 until R2 is enabled on staging.
// - Nothing here parses a login file or logs checkpoint bytes. The container scripts print
//   masked output only, and their stderr is never forwarded.
// - State-changing requests and the terminal's WebSocket must come from this page's own origin.
import { DurableObject } from "cloudflare:workers";

const PC = "s6-pc";
const CHUNK = 1 << 20;
const MAX_AWAKE_MS = 2 * 60 * 60 * 1000;
const TERM_PORT = 7681;
const CLI = "/opt/s6/credsync/cli.py";
const OUT = "/var/lib/s6/out";
const FAKE_PROVIDER = "/tmp/s6-selftest-provider.json";
const LOGIN_FILES = [".claude/.credentials.json", ".codex/auth.json", ".omnigent/auth_tokens.json"];
// Headers that identify the owner to Access; they never go into the computer.
const STRIP_TO_CONTAINER = [
  "cookie",
  "authorization",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cf-access-client-id",
  "cf-access-client-secret",
];
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Checkpoint payloads carry login bytes. A JSON.parse error message can quote part of its input,
// so never let one reach a log or the page.
function parseSecretJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("could not parse a checkpoint payload");
  }
}

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  fetch(request, env) {
    return env.COMPUTER.get(env.COMPUTER.idFromName(PC)).fetch(request);
  },
};

export class S6Computer extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.busy = null;
    this.schema();
  }

  schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS counters (computer TEXT, kind TEXT, next_seq INTEGER, PRIMARY KEY (computer, kind));
      CREATE TABLE IF NOT EXISTS pointers (computer TEXT, kind TEXT, seq INTEGER, generation INTEGER,
        manifest_key TEXT, published_at REAL, snap_order INTEGER, PRIMARY KEY (computer, kind));
      CREATE TABLE IF NOT EXISTS refusals (computer TEXT, kind TEXT, seq INTEGER, generation INTEGER, reason TEXT, at REAL);
      CREATE TABLE IF NOT EXISTS blobs (key TEXT, part INTEGER, data BLOB, PRIMARY KEY (key, part));
    `);
  }

  meta(k, v) {
    if (v !== undefined) {
      this.sql.exec(
        "INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
        k,
        String(v),
      );
      return v;
    }
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return row ? row.v : null;
  }

  generation() {
    return Number(this.meta("generation") ?? 0);
  }

  // ---------------------------------------------------------------- store and pointers
  putBlob(key, bytes) {
    this.sql.exec("DELETE FROM blobs WHERE key = ?", key);
    for (let i = 0, part = 0; i === 0 || i < bytes.length; i += CHUNK, part++) {
      this.sql.exec(
        "INSERT INTO blobs VALUES (?, ?, ?)",
        key,
        part,
        bytes.slice(i, i + CHUNK).buffer,
      );
    }
  }

  getBlob(key) {
    const parts = this.sql
      .exec("SELECT data FROM blobs WHERE key = ? ORDER BY part", key)
      .toArray();
    if (!parts.length) throw new Error(`missing object ${key}`);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.data.byteLength, 0));
    let off = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p.data), off);
      off += p.data.byteLength;
    }
    return out;
  }

  nextSeq(computer, kind) {
    const row = this.sql
      .exec("SELECT next_seq FROM counters WHERE computer = ? AND kind = ?", computer, kind)
      .toArray()[0];
    const seq = row ? row.next_seq : 1;
    this.sql.exec(
      "INSERT INTO counters VALUES (?, ?, ?) ON CONFLICT(computer, kind) DO UPDATE SET next_seq = excluded.next_seq",
      computer,
      kind,
      seq + 1,
    );
    return seq;
  }

  // Atomic pointer switch. Refused from an older generation, and refused unless the copy was
  // taken after the published one (snapshot order within one generation), whatever order the
  // uploads arrive in.
  publish(computer, kind, generation, seq, manifestKey, order) {
    const refuse = (reason) => {
      this.sql.exec(
        "INSERT INTO refusals VALUES (?, ?, ?, ?, ?, ?)",
        computer,
        kind,
        seq,
        generation,
        reason,
        Date.now() / 1000,
      );
      return false;
    };
    if (generation !== this.generation()) return refuse("stale-generation");
    const row = this.sql
      .exec(
        "SELECT seq, generation, snap_order FROM pointers WHERE computer = ? AND kind = ?",
        computer,
        kind,
      )
      .toArray()[0];
    let notNewer = false;
    if (row && order != null && row.generation === generation && row.snap_order != null) {
      notNewer = row.snap_order >= order;
    } else if (row && order == null) {
      notNewer = row.seq >= seq;
    }
    if (notNewer) return refuse("not-newer");
    this.sql.exec(
      `INSERT INTO pointers VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(computer, kind) DO UPDATE SET seq = excluded.seq,
       generation = excluded.generation, manifest_key = excluded.manifest_key,
       published_at = excluded.published_at, snap_order = excluded.snap_order`,
      computer,
      kind,
      seq,
      generation,
      manifestKey,
      Date.now() / 1000,
      order ?? null,
    );
    return true;
  }

  current(computer, kind) {
    return this.sql
      .exec(
        "SELECT seq, manifest_key FROM pointers WHERE computer = ? AND kind = ?",
        computer,
        kind,
      )
      .toArray()[0];
  }

  // True when the latest credential checkpoint records every declared file as absent.
  // True when the latest credential checkpoint records every login file as absent. (A device
  // key that survives a logout is reported in the state, but is not a login.)
  signedOutInCheckpoint(computer = PC) {
    const ptr = this.current(computer, "credential");
    if (!ptr) return true;
    const manifest = JSON.parse(dec.decode(this.getBlob(ptr.manifest_key)));
    return manifest.files
      .filter((f) => LOGIN_FILES.includes(f.path))
      .every((f) => f.state === "absent");
  }

  async publishPayload(kind, payload, computer, generation) {
    const archive = b64ToBytes(payload.archive_b64);
    const sha = await sha256Hex(archive);
    if (sha !== payload.archive_sha256) throw new Error("archive digest mismatch");
    const seq = this.nextSeq(computer, kind);
    const base = `computers/${computer}/${kind === "credential" ? "cred" : "ws"}/${String(seq).padStart(8, "0")}`;
    this.putBlob(`${base}.tar`, archive);
    if ((await sha256Hex(this.getBlob(`${base}.tar`))) !== sha) throw new Error("verify failed");
    const manifest = {
      format: `cfo.s6.${kind}-checkpoint`,
      version: 1,
      kind,
      computer_id: computer,
      generation,
      seq,
      snapshot_order: payload.order ?? null,
      captured_at: payload.taken_at,
      archive: { key: `${base}.tar`, sha256: sha },
      ...(kind === "credential"
        ? { files: payload.records }
        : { file_count: payload.file_count, bytes: payload.bytes }),
    };
    this.putBlob(`${base}.json`, enc.encode(JSON.stringify(manifest)));
    const published = this.publish(
      computer,
      kind,
      generation,
      seq,
      `${base}.json`,
      kind === "credential" ? payload.order : null,
    );
    // Report paths, states, sizes and modes only; the content digests stay in the manifest.
    return {
      kind,
      seq,
      published,
      ...(kind === "credential"
        ? {
            files: payload.records.map(({ path, state, size, mode }) => ({
              path,
              state,
              size,
              mode,
            })),
          }
        : { file_count: payload.file_count, bytes: payload.bytes }),
    };
  }

  // ---------------------------------------------------------------- container
  execEnv(opts = {}) {
    const fakes = opts.fake ? "/opt/s6/fakes/bin:" : "";
    return {
      HOME: opts.home ?? "/root",
      PATH: `${fakes}/opt/venv/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin`,
      LANG: "C.UTF-8",
      IS_SANDBOX: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_UPDATES: "1",
      S6_OUT: OUT,
      ...(opts.fake ? { S6_FAKE: "1", S6_FAKE_PROVIDER: FAKE_PROVIDER } : {}),
    };
  }

  restoredGeneration(computer) {
    return Number(this.meta(`restored:${computer}`) ?? -1);
  }

  async start() {
    if (this.ctx.container.running) throw new Error("a computer is already running");
    const generation = this.generation() + 1;
    this.meta("generation", generation); // persisted before the container starts
    this.meta("started_at", Date.now());
    this.ctx.container.start({ enableInternet: true });
    await this.ctx.container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
    for (let i = 0; i < 180; i++) {
      try {
        const r = await this.ctx.container.getTcpPort(TERM_PORT).fetch("http://container/term/");
        if (r.ok) return { generation, ready_after_s: i };
      } catch {}
      await sleep(1000);
    }
    return { generation, ready: false };
  }

  async stop() {
    if (this.ctx.container.running) await this.ctx.container.destroy();
    for (let i = 0; i < 60 && this.ctx.container.running; i++) await sleep(1000);
    return { stopped: !this.ctx.container.running };
  }

  async alarm() {
    if (!this.ctx.container.running) return;
    if (Date.now() - Number(this.meta("started_at") ?? 0) > MAX_AWAKE_MS && !this.busy) {
      // Awake too long: sign out and verify, then stop. Keeps cost small and never leaves a
      // login behind in an unattended computer.
      this.busy = "recover (alarm)";
      try {
        await this.phase("recover", async (o) => console.log(`S6RESULT ${JSON.stringify(o)}`));
      } catch (e) {
        console.log(
          `S6RESULT ${JSON.stringify({ alarm: "recover failed", error: String(e?.message ?? e).slice(0, 200) })}`,
        );
      } finally {
        this.busy = null;
      }
      return;
    }
    await this.ctx.container.setInactivityTimeout(30 * 60 * 1000);
    await this.ctx.storage.setAlarm(Date.now() + 60_000);
  }

  async runRaw(cmd, opts = {}, stdinText = undefined, timeoutMs = 300_000) {
    const p = await this.ctx.container.exec(cmd, {
      env: this.execEnv(opts),
      cwd: "/root",
      ...(stdinText !== undefined ? { stdin: "pipe" } : {}),
    });
    const timer = setTimeout(() => p.kill(9), timeoutMs);
    if (stdinText !== undefined) {
      const w = p.stdin.getWriter();
      await w.write(enc.encode(stdinText));
      await w.close();
    }
    const out = await p.output();
    clearTimeout(timer);
    return {
      exit: out.exitCode,
      stdout: dec.decode(out.stdout),
      stderr_bytes: out.stderr.byteLength,
    };
  }

  // Masked scripts only (inner.sh, the audits, the self-test); their stderr is never forwarded.
  async run(cmd, opts = {}, timeoutMs = 300_000) {
    const r = await this.runRaw(cmd, opts, undefined, timeoutMs);
    return { exit: r.exit, stdout: r.stdout.trim(), stderr_bytes: r.stderr_bytes };
  }

  s6(args, opts = {}) {
    if (opts.fake && opts.fail === "logout" && args[0].endsWith("-logout")) {
      return Promise.resolve({
        exit: 1,
        stdout: '{"injected_failure": "logout"}',
        stderr_bytes: 0,
      });
    }
    return this.run(["bash", "/opt/s6/owner/inner.sh", ...args], opts);
  }

  async capture(kind, opts = {}) {
    const computer = opts.computer ?? PC;
    const generation = this.generation();
    if (opts.fake && opts.fail === "capture")
      return { error: "injected failure", published: false };
    if (kind === "credential" && this.restoredGeneration(computer) !== generation) {
      return { error: "refused: this computer's restore has not finished", published: false };
    }
    const r = await this.runRaw(
      ["python3", "-I", CLI, "export", "--kind", kind, "--home", opts.home ?? "/root"],
      opts,
    );
    if (r.exit !== 0) return { error: `export failed (${r.exit})`, published: false };
    return this.publishPayload(kind, parseSecretJson(r.stdout), computer, generation);
  }

  async restore(opts = {}) {
    const computer = opts.computer ?? PC;
    const generation = this.generation();
    const report = {};
    for (const kind of ["workspace", "credential"]) {
      const ptr = this.current(computer, kind);
      if (!ptr) {
        report[kind] = null;
        continue;
      }
      const manifest = JSON.parse(dec.decode(this.getBlob(ptr.manifest_key)));
      const archive = this.getBlob(manifest.archive.key);
      const stdin = JSON.stringify({ manifest, archive_b64: bytesToB64(archive) });
      const r = await this.runRaw(
        [
          "python3",
          "-I",
          CLI,
          "import",
          "--kind",
          kind,
          "--home",
          opts.home ?? "/root",
          "--staging",
          "/var/lib/s6/staging",
        ],
        opts,
        stdin,
      );
      report[kind] = r.exit === 0 ? JSON.parse(r.stdout) : { error: `import failed (${r.exit})` };
    }
    const ok = Object.values(report).every((v) => v === null || !v.error);
    if (ok) this.meta(`restored:${computer}`, generation); // only now may credentials be captured
    return { ...report, restore_complete: ok };
  }

  // The settle-and-copy watcher runs in the container; this end numbers, stores and publishes
  // each settled change and acknowledges it, so the container can time change-to-published.
  async startWatcher(emit, opts = {}) {
    const generation = this.generation();
    const computer = opts.computer ?? PC;
    if (this.restoredGeneration(computer) !== generation) {
      throw new Error("refused to watch: this computer's restore has not finished");
    }
    const watchCmd = [
      "python3",
      "-I",
      CLI,
      "watch-export",
      "--home",
      opts.home ?? "/root",
      "--settle-ms",
      "500",
      "--log",
      `${OUT}/watch-${computer}-gen${generation}.jsonl`,
    ];
    // Dry runs only: a watcher that exits at once, to test that its absence stops the phase.
    const cmd = opts.fake && opts.fail === "watch" ? ["python3", "-c", "pass"] : watchCmd;
    const p = await this.ctx.container.exec(cmd, {
      env: this.execEnv(opts),
      cwd: "/root",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const writer = p.stdin.getWriter();
    const reader = p.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let ready;
    const readyPromise = new Promise((r) => {
      ready = r;
    });
    const loop = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i = buf.indexOf("\n");
        while (i >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
          const msg = parseSecretJson(line);
          if (msg.event === "watching") {
            ready();
            continue;
          }
          if (msg.event !== "snapshot") continue;
          const res = await this.publishPayload("credential", msg, computer, generation);
          await writer.write(
            enc.encode(`${JSON.stringify({ seq: res.seq, published: res.published })}\n`),
          );
          await emit({ step: "watcher: checkpoint published", ...res });
        }
      }
    })();
    // The watcher records the current files as published before anything else may run. It must
    // say so; a timeout, or an end before that, fails the step.
    let ended = false;
    const loopDone = loop.then(
      () => {
        ended = true;
        return "ended";
      },
      () => {
        ended = true;
        return "ended";
      },
    );
    const first = await Promise.race([
      readyPromise.then(() => "ready"),
      loopDone,
      sleep(15000).then(() => "timeout"),
    ]);
    if (first !== "ready") {
      p.kill(9);
      throw new Error(`the credential watcher did not start (${first})`);
    }
    return {
      stop: async () => {
        await sleep(1500); // let a pending change settle and publish first
        const diedEarly = ended;
        try {
          await writer.close();
        } catch {}
        await Promise.race([loopDone, sleep(5000)]);
        p.kill(15);
        return { watcher_ran_to_stop: !diedEarly };
      },
    };
  }

  // ---------------------------------------------------------------- phases
  async phase(name, emit, o = {}) {
    const step = async (label, fn, ok = () => true) => {
      const t0 = Date.now();
      const r = await fn();
      const passed = Boolean(ok(r));
      await emit({ phase: name, step: label, ms: Date.now() - t0, ok: passed, ...r });
      if (!passed) throw new Error(`step failed: ${label}`);
      return r;
    };
    const exit0 = (r) => r.exit === 0;
    const published = (r) => r.published === true;
    const restored = (r) => r.restore_complete === true;
    const isIn = (who) => (r) => r.exit === 0 && r.stdout.includes(`"${who}_logged_in": "true"`);
    const loggedIn = async (opts = o) => {
      await step(
        "claude status: signed in",
        () => this.s6(["claude-status"], opts),
        isIn("claude"),
      );
      await step("codex status: signed in", () => this.s6(["codex-status"], opts), isIn("codex"));
    };
    const watchSummary = (computer = PC) =>
      step("watcher timings (container clock: change to acknowledged publish)", () =>
        this.run([
          "python3",
          "-I",
          CLI,
          "watch-summary",
          "--log",
          `${OUT}/watch-${computer}-gen${this.generation()}.jsonl`,
        ]),
      );
    // End of a phase with a running, restored computer: nothing un-checkpointed is left behind.
    const finish = async (w) => {
      if (w)
        await step(
          "stop watcher",
          () => w.stop(),
          (r) => r.watcher_ran_to_stop,
        );
      await watchSummary();
      await step("final credential checkpoint", () => this.capture("credential", o), published);
    };
    const stopAndStart = async (letter) => {
      if (this.ctx.container.running) {
        if (this.restoredGeneration(PC) === this.generation()) {
          await step(
            "final credential checkpoint of the previous computer",
            () => this.capture("credential", o),
            published,
          );
        }
        await step(
          "stop previous computer",
          () => this.stop(),
          (r) => r.stopped,
        );
      }
      // Dry run only: the fake provider's state (token hashes) stands for the providers' servers,
      // so it is carried from one container to the next.
      const provider = o.fake ? this.meta("fake_provider") : null;
      await step(
        `start computer ${letter}`,
        () => this.start(),
        (r) => r.ready !== false,
      );
      if (provider) await this.runRaw(["bash", "-c", `cat > ${FAKE_PROVIDER}`], o, provider);
      await step("restore: workspace, then credentials", () => this.restore(o), restored);
    };
    const keepFakeProvider = async () => {
      if (o.fake) this.meta("fake_provider", (await this.runRaw(["cat", FAKE_PROVIDER], o)).stdout);
    };

    switch (name) {
      case "selftest": {
        if (this.ctx.container.running) throw new Error("stop the computer before the self-test");
        await step(
          "start computer",
          () => this.start(),
          (r) => r.ready !== false,
        );
        await step(
          "file handling in this container (local store)",
          () =>
            this.run(
              ["python3", "-I", "/opt/s6/staging/selftest.py", "--rounds", "5"],
              {},
              600_000,
            ),
          exit0,
        );
        const f1 = { fake: true, home: "/tmp/s6-selftest-home1", computer: "s6-selftest" };
        const f2 = { ...f1, home: "/tmp/s6-selftest-home2" };
        const f3 = { ...f1, home: "/tmp/s6-selftest-home3" };
        await step("new computer: nothing to restore", () => this.restore(f1), restored);
        await step(
          "fake sign-ins",
          () =>
            this.run(
              [
                "bash",
                "-c",
                "claude auth login && codex login && omnigent login http://omnigent.internal",
              ],
              f1,
            ),
          exit0,
        );
        await step("credential checkpoint", () => this.capture("credential", f1), published);
        await step("workspace checkpoint", () => this.capture("workspace", f1), published);
        const w = await this.startWatcher(emit, f1);
        for (let round = 0; round < 5; round++) {
          for (const cmd of [
            "claude refresh",
            "codex refresh",
            "omnigent refresh http://omnigent.internal",
          ]) {
            await this.run(["bash", "-c", cmd], f1);
            await sleep(1500);
          }
        }
        await w.stop();
        await watchSummary("s6-selftest");
        await step("restore into a fresh home", () => this.restore(f2), restored);
        await loggedIn(f2);
        await step(
          "restored tokens are the rotated ones: refresh works",
          () => this.run(["bash", "-c", "codex refresh && claude refresh"], f2),
          exit0,
        );
        await step("credential checkpoint", () => this.capture("credential", f2), published);
        await step(
          "fake sign-out",
          () =>
            this.run(
              ["bash", "-c", "claude auth logout; codex logout; omnigent signout-delete"],
              f2,
            ),
          exit0,
        );
        await step(
          "credential checkpoint after sign-out",
          () => this.capture("credential", f2),
          published,
        );
        await step("restore into another fresh home", () => this.restore(f3), restored);
        await step("must be signed out", () => this.s6(["signed-out-check"], f3), exit0);
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        break;
      }
      case "start":
        if (this.ctx.container.running) throw new Error("a computer is already running");
        if (!this.signedOutInCheckpoint()) {
          throw new Error("an earlier session is still signed in: run Recover first");
        }
        await step(
          "start computer A",
          () => this.start(),
          (r) => r.ready !== false,
        );
        await step(
          "restore: nothing yet, or a signed-out checkpoint",
          () => this.restore(o),
          restored,
        );
        await step("audit", () => this.s6(["audit-json", "A fresh"], o), exit0);
        await step("versions", () =>
          this.run([
            "bash",
            "-c",
            "claude --version; codex --version; omnigent --version | tail -1",
          ]),
        );
        break;
      case "fake-sign-in":
        if (!o.fake) throw new Error("fake-sign-in is for dry runs only (fake=1)");
        await step(
          "fake sign-ins",
          () =>
            this.run(
              ["bash", "-c", "claude auth login --claudeai && codex login --device-auth"],
              o,
            ),
          exit0,
        );
        break;
      case "after-sign-in": {
        if (!this.ctx.container.running) throw new Error("no computer is running");
        await loggedIn();
        await step(
          "credential checkpoint C1, right after sign-in",
          () => this.capture("credential", o),
          published,
        );
        const w = await this.startWatcher(emit, o);
        await step("audit", () => this.s6(["audit-json", "A after sign-in"], o), exit0);
        await step(
          "files holding login values",
          () => this.s6(["copies", "A after sign-in"], o),
          exit0,
        );
        await step("login lifetimes", () => this.s6(["lifetimes", "A after sign-in"], o), exit0);
        await step("claude request", () => this.s6(["claude-ask"], o), exit0);
        await step("codex request", () => this.s6(["codex-ask"], o), exit0);
        await step("workspace checkpoint W1", () => this.capture("workspace", o), published);
        await step("force Claude refresh", () => this.s6(["claude-force-refresh"], o), exit0);
        await step("force Codex refresh", () => this.s6(["codex-force-refresh"], o), exit0);
        await finish(w);
        await step("audit", () => this.s6(["audit-json", "A after refresh"], o), exit0);
        await step(
          "files holding login values",
          () => this.s6(["copies", "A after refresh"], o),
          exit0,
        );
        await step("login lifetimes", () => this.s6(["lifetimes", "A after refresh"], o), exit0);
        await step("leak check of results", () => this.s6(["leak-check", "A"], o), exit0);
        await keepFakeProvider();
        break;
      }
      case "restore-b": {
        await stopAndStart("B");
        const w = await this.startWatcher(emit, o);
        await step("audit", () => this.s6(["audit-json", "B after restore"], o), exit0);
        await loggedIn();
        await step("claude request", () => this.s6(["claude-ask"], o), exit0);
        await step("codex request", () => this.s6(["codex-ask"], o), exit0);
        await step("workspace checkpoint W2", () => this.capture("workspace", o), published);
        await finish(w);
        await keepFakeProvider();
        break;
      }
      case "restore-c-sign-out": {
        await stopAndStart("C");
        const w = await this.startWatcher(emit, o);
        await step("audit", () => this.s6(["audit-json", "C after restore"], o), exit0);
        await loggedIn();
        await step("codex request", () => this.s6(["codex-ask"], o), exit0);
        await step("leak check of results", () => this.s6(["leak-check", "C"], o), exit0);
        await step("claude auth logout", () => this.s6(["claude-logout"], o), exit0);
        await step("codex logout", () => this.s6(["codex-logout"], o), exit0);
        await finish(w);
        await step("signed out here", () => this.s6(["signed-out-check"], o), exit0);
        await step("audit", () => this.s6(["audit-json", "C after sign-out"], o), exit0);
        await keepFakeProvider();
        break;
      }
      case "restore-d":
        await stopAndStart("D");
        await step(
          "signed out after restore (tombstones hold)",
          () => this.s6(["signed-out-check"], o),
          exit0,
        );
        await step("audit", () => this.s6(["audit-json", "D after restore"], o), exit0);
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        break;
      case "recover": {
        // Sign out from whatever state the session stopped in, and verify it in a fresh computer.
        // A running computer may hold a login newer than any checkpoint: sign out there first,
        // and checkpoint the sign-out before the computer is destroyed.
        if (this.ctx.container.running) {
          await step(
            "claude auth logout (running computer)",
            () => this.s6(["claude-logout"], o),
            exit0,
          );
          await step("codex logout (running computer)", () => this.s6(["codex-logout"], o), exit0);
          await step("signed out here", () => this.s6(["signed-out-check"], o), exit0);
          if (this.restoredGeneration(PC) === this.generation()) {
            await step(
              "credential checkpoint of the sign-out",
              () => this.capture("credential", o),
              published,
            );
          }
          await step(
            "stop computer",
            () => this.stop(),
            (r) => r.stopped,
          );
        }
        await stopAndStart("R1");
        const out = await this.s6(["signed-out-check"], o);
        await emit({ phase: name, step: "signed-out check after restore", ...out });
        if (out.exit !== 0) {
          await step("claude auth logout", () => this.s6(["claude-logout"], o), exit0);
          await step("codex logout", () => this.s6(["codex-logout"], o), exit0);
          await step("signed out here", () => this.s6(["signed-out-check"], o), exit0);
          await step(
            "credential checkpoint of the sign-out",
            () => this.capture("credential", o),
            published,
          );
        }
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        await stopAndStart("R2");
        await step(
          "verified signed out in a fresh computer",
          () => this.s6(["signed-out-check"], o),
          exit0,
        );
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        break;
      }
      case "stop":
        if (this.ctx.container.running && this.restoredGeneration(PC) === this.generation()) {
          await step("final credential checkpoint", () => this.capture("credential", o));
        }
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        break;
      case "wipe":
        if (this.ctx.container.running) throw new Error("stop the computer first (or run Recover)");
        if (!this.signedOutInCheckpoint()) {
          throw new Error("the latest checkpoint is still signed in: run Recover first");
        }
        await step(
          "delete all stored checkpoints and state",
          async () => {
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.deleteAll();
            this.schema();
            return { wiped: true, objects_left: this.state().objects };
          },
          (r) => r.objects_left === 0,
        );
        break;
      default:
        throw new Error(`unknown phase ${name}`);
    }
  }

  state() {
    const pointers = this.sql
      .exec("SELECT computer, kind, seq, generation, snap_order FROM pointers")
      .toArray();
    const refusals = this.sql
      .exec("SELECT computer, kind, seq, generation, reason FROM refusals")
      .toArray();
    const blobs = this.sql
      .exec("SELECT COUNT(DISTINCT key) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM blobs")
      .toArray()[0];
    return {
      running: this.ctx.container.running,
      busy: this.busy,
      generation: this.generation(),
      signed_out_in_checkpoint: this.signedOutInCheckpoint(),
      pointers,
      refusals,
      objects: blobs.n,
      bytes: blobs.bytes,
    };
  }

  // ---------------------------------------------------------------- owner page
  async fetch(request) {
    const url = new URL(request.url);
    const sameOrigin = request.headers.get("origin") === url.origin;
    if (url.pathname === "/term" || url.pathname.startsWith("/term/")) {
      if (!this.ctx.container.running) {
        return new Response("The computer is not running.", { status: 503 });
      }
      const upgrade = (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
      if (upgrade && !sameOrigin)
        return new Response("cross-origin terminal refused", { status: 403 });
      const headers = new Headers(request.headers);
      for (const h of STRIP_TO_CONTAINER) headers.delete(h);
      return this.ctx.container.getTcpPort(TERM_PORT).fetch(new Request(request, { headers }));
    }
    if (url.pathname === "/api/state") return Response.json(this.state());
    if (url.pathname === "/api/phase" && request.method === "POST") {
      if (!sameOrigin || request.headers.get("x-s6-request") !== "1") {
        return new Response("cross-origin request refused", { status: 403 });
      }
      if (this.busy) return new Response(`busy: ${this.busy}`, { status: 409 });
      const name = url.searchParams.get("name");
      // fake=1: the same phases with the fake CLIs first on PATH (a dry run, no real accounts).
      const opts = url.searchParams.get("fake") === "1" ? { fake: true } : {};
      if (opts.fake && url.searchParams.get("fail")) opts.fail = url.searchParams.get("fail");
      this.busy = name;
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const emit = async (obj) => {
        const line = JSON.stringify({ at: new Date().toISOString(), ...obj });
        console.log(`S6RESULT ${line}`);
        await writer.write(enc.encode(`${line}\n`));
      };
      (async () => {
        try {
          await this.phase(name, emit, opts);
          await emit({ phase: name, done: true, state: this.state() });
        } catch (e) {
          await emit({
            phase: name,
            error: String(e?.message ?? e).slice(0, 300),
            advice: "Stop here. Run Recover (sign out and verify), then Stop and wipe.",
            state: this.state(),
          });
        } finally {
          this.busy = null;
          await writer.close();
        }
      })();
      return new Response(readable, { headers: { "content-type": "application/x-ndjson" } });
    }
    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  }
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>S6 computer</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:24px auto;max-width:980px;padding:0 16px;color:#1d1d1f;background:#fafafa}
h1{font-size:22px}ol{padding-left:20px}li{margin:10px 0}button{font:inherit;padding:6px 12px;margin-right:8px;cursor:pointer}
code{background:#eee;padding:1px 4px;border-radius:3px}pre{background:#111;color:#ddd;padding:12px;border-radius:6px;max-height:520px;overflow:auto;white-space:pre-wrap;font-size:12px}
.note{color:#555}.warn{color:#8a1c1c}#state{font-family:monospace;font-size:13px}
</style></head><body>
<h1>S6: sign-in and credential checkpoints</h1>
<p class="note">Owner-only staging page. Output below is masked: paths, modes, sizes, key names, states and timestamps. The terminal is not recorded. Run the steps in order; each waits until it is done.</p>
<p class="warn">If a step reports an error: stop there, click <b>Recover</b>, then <b>Stop and wipe</b>.</p>
<p id="state"></p>
<ol>
<li><button data-phase="selftest">Run the fake-CLI self-test</button> about 3 minutes; no real accounts.</li>
<li><button data-phase="start">Start computer A</button> then <a href="/term/" target="_blank">open the terminal</a>.</li>
<li>In the terminal: <code>claude auth login --claudeai</code>, open the link, sign in, paste the code back.
 Then <code>codex login --device-auth</code>, open the link, sign in, enter the code. Close the terminal tab.</li>
<li><button data-phase="after-sign-in">After sign-in: audit, checkpoints, forced refresh</button></li>
<li><button data-phase="restore-b">Computer B: restore older workspace + newer credentials</button></li>
<li><button data-phase="restore-c-sign-out">Computer C: restore, then sign out of both</button></li>
<li><button data-phase="restore-d">Computer D: restore; both must stay signed out</button></li>
<li><button data-phase="wipe">Stop and wipe everything stored</button> then <button id="save">Download results</button></li>
</ol>
<p><button data-phase="recover">Recover: sign out and verify</button> only if a step failed.</p>
<pre id="out"></pre>
<script>
const out=document.getElementById("out");const lines=[];
async function state(){const s=await (await fetch("/api/state")).json();document.getElementById("state").textContent=JSON.stringify(s);}
for(const b of document.querySelectorAll("button[data-phase]")){b.onclick=async()=>{
 if(b.dataset.phase==="wipe"&&!confirm("Delete every stored checkpoint?"))return;
 for(const x of document.querySelectorAll("button"))x.disabled=true;
 try{const r=await fetch("/api/phase?name="+b.dataset.phase,{method:"POST",headers:{"X-S6-Request":"1"}});
 if(!r.ok){out.textContent+=r.status+" "+(await r.text())+"\\n";}else{const rd=r.body.getReader();const dec=new TextDecoder();let buf="";
 for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
  while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;lines.push(l);out.textContent+=l+"\\n";out.scrollTop=out.scrollHeight;}}}}
 finally{for(const x of document.querySelectorAll("button"))x.disabled=false;state();}};}
document.getElementById("save").onclick=()=>{const a=document.createElement("a");
 a.href=URL.createObjectURL(new Blob([lines.join("\\n")+"\\n"],{type:"application/x-ndjson"}));a.download="s6-staging-session.jsonl";a.click();};
state();
</script></body></html>`;
