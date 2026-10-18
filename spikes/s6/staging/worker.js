// Spike S6 staging Worker: one cloud computer for the sign-in and credential-checkpoint session.
//
// - The owner opens the page (behind the staging tool's owner-only Access application), starts
//   the computer, and signs in to Claude and Codex in the embedded terminal (ttyd, at /term/).
// - The Durable Object plays WorkspaceDO: it numbers, stores and publishes checkpoints, fences
//   them by generation, and restores them into each new container, workspace first. Checkpoint
//   bytes move over exec() pipes (credsync export/import/watch-export) and are kept in the
//   Durable Object's SQLite storage, standing in for R2 until R2 is enabled on staging.
// - Nothing here parses a login file, and nothing logs checkpoint bytes. The container scripts
//   print masked output only: paths, modes, sizes, key names, states and timestamps.
import { DurableObject } from "cloudflare:workers";

const PC = "s6-pc";
const CHUNK = 1 << 20;
const MAX_AWAKE_MS = 2 * 60 * 60 * 1000;
const TERM_PORT = 7681;
const CLI = "/opt/s6/credsync/cli.py";
const OUT = "/var/lib/s6/out";
const FAKE_PROVIDER = "/tmp/s6-selftest-provider.json";
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskText = (s) => s.replace(/https?:\/\/\S+/g, "<url>").slice(-400);

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
    this.schema();
  }

  schema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS counters (computer TEXT, kind TEXT, next_seq INTEGER, PRIMARY KEY (computer, kind));
      CREATE TABLE IF NOT EXISTS pointers (computer TEXT, kind TEXT, seq INTEGER, generation INTEGER,
        manifest_key TEXT, published_at REAL, PRIMARY KEY (computer, kind));
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

  // Atomic pointer switch, fenced by generation and by sequence number.
  publish(computer, kind, generation, seq, manifestKey) {
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
      .exec("SELECT seq FROM pointers WHERE computer = ? AND kind = ?", computer, kind)
      .toArray()[0];
    if (row && row.seq >= seq) return refuse("not-newer");
    this.sql.exec(
      `INSERT INTO pointers VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(computer, kind) DO UPDATE SET seq = excluded.seq,
       generation = excluded.generation, manifest_key = excluded.manifest_key, published_at = excluded.published_at`,
      computer,
      kind,
      seq,
      generation,
      manifestKey,
      Date.now() / 1000,
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
      captured_at: payload.taken_at,
      archive: { key: `${base}.tar`, sha256: sha },
      ...(kind === "credential"
        ? { files: payload.records }
        : { file_count: payload.file_count, bytes: payload.bytes }),
    };
    this.putBlob(`${base}.json`, enc.encode(JSON.stringify(manifest)));
    const published = this.publish(computer, kind, generation, seq, `${base}.json`);
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

  async start() {
    if (this.ctx.container.running) await this.stop();
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
    // Heartbeat while awake; a hard limit keeps staging cost small.
    if (!this.ctx.container.running) return;
    if (Date.now() - Number(this.meta("started_at") ?? 0) > MAX_AWAKE_MS) {
      await this.stop();
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
    return { exit: out.exitCode, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
  }

  // For masked scripts only: the inner.sh actions and the audits print no login material.
  async run(cmd, opts = {}, timeoutMs = 300_000) {
    const r = await this.runRaw(cmd, opts, undefined, timeoutMs);
    return { exit: r.exit, stdout: r.stdout.trim(), stderr: maskText(r.stderr.trim()) };
  }

  s6(args, opts = {}) {
    return this.run(["bash", "/opt/s6/owner/inner.sh", ...args], opts);
  }

  async capture(kind, opts = {}) {
    const generation = this.generation();
    const r = await this.runRaw(
      ["python3", "-I", CLI, "export", "--kind", kind, "--home", opts.home ?? "/root"],
      opts,
    );
    if (r.exit !== 0) return { error: `export failed (${r.exit})`, stderr: maskText(r.stderr) };
    return this.publishPayload(kind, parseSecretJson(r.stdout), opts.computer ?? PC, generation);
  }

  async restore(opts = {}) {
    const computer = opts.computer ?? PC;
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
      const home = opts.home ?? "/root";
      const r = await this.runRaw(
        [
          "python3",
          "-I",
          CLI,
          "import",
          "--kind",
          kind,
          "--home",
          home,
          "--staging",
          "/var/lib/s6/staging",
        ],
        opts,
        stdin,
      );
      report[kind] =
        r.exit === 0
          ? JSON.parse(r.stdout)
          : { error: `import failed (${r.exit})`, stderr: maskText(r.stderr) };
    }
    return report;
  }

  // The settle-and-copy watcher runs in the container; this end numbers, stores and publishes
  // each settled change and acknowledges it, so the container can time change-to-published.
  async startWatcher(emit, opts = {}) {
    const generation = this.generation();
    const computer = opts.computer ?? PC;
    const p = await this.ctx.container.exec(
      [
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
      ],
      { env: this.execEnv(opts), cwd: "/root", stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const writer = p.stdin.getWriter();
    const reader = p.stdout.pipeThrough(new TextDecoderStream()).getReader();
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
          if (msg.event !== "snapshot") continue;
          const res = await this.publishPayload("credential", msg, computer, generation);
          await writer.write(
            enc.encode(`${JSON.stringify({ seq: res.seq, published: res.published })}\n`),
          );
          await emit({ step: "watcher: checkpoint published", ...res });
        }
      }
    })();
    return {
      stop: async () => {
        try {
          await writer.close();
        } catch {}
        await Promise.race([loop.catch(() => {}), sleep(5000)]);
        p.kill(15);
      },
    };
  }

  // ---------------------------------------------------------------- phases
  async phase(name, emit, o = {}) {
    const step = async (label, fn) => {
      const t0 = Date.now();
      const r = await fn();
      await emit({ phase: name, step: label, ms: Date.now() - t0, ...r });
      return r;
    };
    const statuses = async (opts = o) => {
      await step("claude status", () => this.s6(["claude-status"], opts));
      await step("codex status", () => this.s6(["codex-status"], opts));
    };
    const watchLog = (computer) =>
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
    const restart = async (letter) => {
      // Dry run only: the fake provider's state (token hashes) stands for the provider's
      // servers, so it is carried from one container to the next.
      const provider = o.fake ? (await this.runRaw(["cat", FAKE_PROVIDER], o)).stdout : null;
      await step("stop previous computer", () => this.stop());
      await step(`start computer ${letter}`, () => this.start());
      if (provider) await this.runRaw(["bash", "-c", `cat > ${FAKE_PROVIDER}`], o, provider);
      await step("restore: workspace, then credentials", () => this.restore(o));
      await step("audit", () => this.s6(["audit", `${letter} after restore`], o));
      await statuses();
    };
    switch (name) {
      case "selftest": {
        if (!this.ctx.container.running) await step("start computer", () => this.start());
        await step("file handling in this container (local store)", () =>
          this.run(["python3", "-I", "/opt/s6/staging/selftest.py", "--rounds", "5"], {}, 600_000),
        );
        const f1 = { fake: true, home: "/tmp/s6-selftest-home1", computer: "s6-selftest" };
        const f2 = { ...f1, home: "/tmp/s6-selftest-home2" };
        const f3 = { ...f1, home: "/tmp/s6-selftest-home3" };
        await step("fake sign-ins", () =>
          this.run(
            [
              "bash",
              "-c",
              "claude auth login && codex login && omnigent login http://omnigent.internal",
            ],
            f1,
          ),
        );
        await step("workspace checkpoint", () => this.capture("workspace", f1));
        await step("credential checkpoint", () => this.capture("credential", f1));
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
        await watchLog("s6-selftest");
        await step("restore into a fresh home", () => this.restore(f2));
        await step("fake statuses after restore", () =>
          this.run(
            ["bash", "-c", "claude auth status; codex login status; codex refresh; claude refresh"],
            f2,
          ),
        );
        await step("fake sign-out", () =>
          this.run(["bash", "-c", "claude auth logout; codex logout; omnigent signout-delete"], f2),
        );
        await step("credential checkpoint after sign-out", () => this.capture("credential", f2));
        await step("restore into another fresh home", () => this.restore(f3));
        await step("fake statuses: must be signed out", () =>
          this.run(
            ["bash", "-c", "claude auth status; codex login status; ls -a ~/.claude ~/.codex 2>&1"],
            f3,
          ),
        );
        break;
      }
      case "start":
        await step("start computer A", () => this.start());
        await step("audit", () => this.s6(["audit", "A fresh"], o));
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
        await step("fake sign-ins", () =>
          this.run(["bash", "-c", "claude auth login --claudeai && codex login --device-auth"], o),
        );
        break;
      case "after-sign-in": {
        await statuses();
        await step("audit", () => this.s6(["audit", "A after sign-in"], o));
        await step("files holding login values", () => this.s6(["copies", "A after sign-in"], o));
        await step("login lifetimes", () => this.s6(["lifetimes", "A after sign-in"], o));
        await step("claude request", () => this.s6(["claude-ask"], o));
        await step("codex request", () => this.s6(["codex-ask"], o));
        await step("workspace checkpoint W1", () => this.capture("workspace", o));
        await step("credential checkpoint C1", () => this.capture("credential", o));
        const w = await this.startWatcher(emit, o);
        await step("force Claude refresh", () => this.s6(["claude-force-refresh"], o));
        await step("force Codex refresh", () => this.s6(["codex-force-refresh"], o));
        await sleep(4000);
        await w.stop();
        await watchLog(PC);
        await step("audit", () => this.s6(["audit", "A after refresh"], o));
        await step("files holding login values", () => this.s6(["copies", "A after refresh"], o));
        await step("login lifetimes", () => this.s6(["lifetimes", "A after refresh"], o));
        await step("leak check of results", () => this.s6(["leak-check", "A"], o));
        break;
      }
      case "restore-b":
        await restart("B");
        await step("claude request", () => this.s6(["claude-ask"], o));
        await step("codex request", () => this.s6(["codex-ask"], o));
        await step("workspace checkpoint W2", () => this.capture("workspace", o));
        break;
      case "restore-c-sign-out": {
        await restart("C");
        await step("codex request", () => this.s6(["codex-ask"], o));
        await step("leak check of results", () => this.s6(["leak-check", "C"], o));
        const w = await this.startWatcher(emit, o);
        await step("claude auth logout", () => this.run(["claude", "auth", "logout"], o));
        await step("codex logout", () => this.run(["codex", "logout"], o));
        await sleep(4000);
        await w.stop();
        await watchLog(PC);
        await step("credential checkpoint after sign-out", () => this.capture("credential", o));
        await step("audit", () => this.s6(["audit", "C after sign-out"], o));
        await statuses();
        break;
      }
      case "restore-d":
        await restart("D");
        break;
      case "stop":
        await step("stop computer", () => this.stop());
        break;
      case "wipe":
        await step("stop computer", () => this.stop());
        await step("delete all stored checkpoints and state", async () => {
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
          this.schema();
          return { wiped: true, objects_left: this.state().objects };
        });
        break;
      default:
        await emit({ error: `unknown phase ${name}` });
    }
  }

  state() {
    const pointers = this.sql
      .exec("SELECT computer, kind, seq, generation FROM pointers")
      .toArray();
    const refusals = this.sql
      .exec("SELECT computer, kind, seq, generation, reason FROM refusals")
      .toArray();
    const blobs = this.sql
      .exec("SELECT COUNT(DISTINCT key) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM blobs")
      .toArray()[0];
    return {
      running: this.ctx.container.running,
      generation: this.generation(),
      pointers,
      refusals,
      objects: blobs.n,
      bytes: blobs.bytes,
    };
  }

  // ---------------------------------------------------------------- owner page
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/term" || url.pathname.startsWith("/term/")) {
      if (!this.ctx.container.running) {
        return new Response("The computer is not running.", { status: 503 });
      }
      return this.ctx.container.getTcpPort(TERM_PORT).fetch(request);
    }
    if (url.pathname === "/api/state") return Response.json(this.state());
    if (url.pathname === "/api/phase" && request.method === "POST") {
      const name = url.searchParams.get("name");
      // fake=1: the same phases with the fake CLIs first on PATH (a dry run, no real accounts).
      const opts = url.searchParams.get("fake") === "1" ? { fake: true } : {};
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
          await emit({ phase: name, error: String(e?.message ?? e).slice(0, 300) });
        } finally {
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
.note{color:#555}#state{font-family:monospace;font-size:13px}
</style></head><body>
<h1>S6: sign-in and credential checkpoints</h1>
<p class="note">Owner-only staging page. Output below is masked: paths, modes, sizes, key names, states and timestamps. The terminal is not recorded. Run the steps in order; each waits until it is done.</p>
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
<pre id="out"></pre>
<script>
const out=document.getElementById("out");const lines=[];
async function state(){const s=await (await fetch("/api/state")).json();document.getElementById("state").textContent=JSON.stringify(s);}
for(const b of document.querySelectorAll("button[data-phase]")){b.onclick=async()=>{
 if(b.dataset.phase==="wipe"&&!confirm("Stop the computer and delete every stored checkpoint?"))return;
 for(const x of document.querySelectorAll("button"))x.disabled=true;
 const r=await fetch("/api/phase?name="+b.dataset.phase,{method:"POST"});const rd=r.body.getReader();const dec=new TextDecoder();let buf="";
 for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
  while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l)continue;lines.push(l);out.textContent+=l+"\\n";out.scrollTop=out.scrollHeight;}}
 for(const x of document.querySelectorAll("button"))x.disabled=false;state();};}
document.getElementById("save").onclick=()=>{const a=document.createElement("a");
 a.href=URL.createObjectURL(new Blob([lines.join("\\n")+"\\n"],{type:"application/x-ndjson"}));a.download="s6-staging-session.jsonl";a.click();};
state();
</script></body></html>`;
