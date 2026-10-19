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
// - Campaign controls (spikes/README.md, IR-017): a GET never changes anything; a control URL
//   opened with GET shows a confirmation page. A change is a POST with this deployment's exact
//   Origin, Sec-Fetch-Site same-origin when present, and the stored request-intent token. The
//   terminal's WebSocket needs the exact Origin, a SameSite=Strict cookie holding the same token,
//   and a terminal window opened by a POST (Start, or Re-open). Every terminal is bridged through
//   the Durable Object, which closes it when the window expires and before any other phase's
//   first step. Fault injection exists only when the S6_ALLOW_INJECTION variable is "1", which
//   only local `wrangler dev` runs set.
//   Refusals change nothing but an audit row in boundary_log, so the deployed qualification can
//   tell which attempts reached the Worker.
import { DurableObject } from "cloudflare:workers";

const PC = "s6-pc";
const CHUNK = 1 << 20;
const MAX_AWAKE_MS = 2 * 60 * 60 * 1000;
const TERM_PORT = 7681;
const CLI = "/opt/s6/credsync/cli.py";
const OUT = "/var/lib/s6/out";
const FAKE_PROVIDER = "/tmp/s6-selftest-provider.json";
const LOGIN_FILES = [".claude/.credentials.json", ".codex/auth.json", ".omnigent/auth_tokens.json"];
// Headers that identify the owner to Access, or carry the request-intent token; they never go
// into the computer.
const STRIP_TO_CONTAINER = [
  "cookie",
  "authorization",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cf-access-client-id",
  "cf-access-client-secret",
  "x-s6-intent",
];
const TERMINAL_WINDOW_MS = 20 * 60 * 1000;
const TERMINAL_CLOSE_CODE = 4001; // this Worker closed the terminal (window, or a phase began)
// Every phase but these closes the terminal before its first step (review s6-r3, finding 4).
const KEEPS_TERMINAL = new Set(["reopen-terminal", "fake-sign-in"]);
const BOUNDARY_LOG_MAX = 500;
const PHASES = new Set([
  "selftest",
  "start",
  "fake-sign-in",
  "after-sign-in",
  "restore-b",
  "restore-c-sign-out",
  "restore-d",
  "recover",
  "stop",
  "force-stop",
  "reopen-terminal",
  "close-terminal",
  "confirm-revoked",
  "wipe",
]);
// Review s6-r3, finding 1. A login that was lost before it was checkpointed (Force stop, or a
// computer that stopped by itself) can still be valid at the provider, and no restore can sign it
// out: a signed-out checkpoint says nothing about it. Until the owner records that the sessions
// were revoked at the providers, only these phases run.
const WHILE_UNRESOLVED = new Set([
  "recover",
  "stop",
  "force-stop",
  "confirm-revoked",
  "close-terminal",
]);
const REVOKE_ADVICE =
  "Revoke the sessions in the Claude and ChatGPT account settings (sign out of all devices or sessions there), then record it on this page with 'I revoked both sessions'. Start and Wipe refuse until then.";
// HTML from this Worker, and the terminal it proxies, is never framed (clickjacking).
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "same-origin",
};
const enc = new TextEncoder();
const dec = new TextDecoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  const x = enc.encode(String(a ?? ""));
  const y = enc.encode(String(b ?? ""));
  if (x.length !== y.length || x.length === 0) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function originClass(origin, own) {
  if (origin === null) return "missing origin";
  if (origin === "null") return "null origin";
  return origin === own ? "same origin" : "foreign origin";
}

const maskImage = (ref) =>
  ref
    ? ref.replace(/registry\.cloudflare\.com\/[^/]+\//, "registry.cloudflare.com/<account>/")
    : null;
const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
    this.env = env;
    this.sql = ctx.storage.sql;
    this.busy = null;
    this.terminals = new Set(); // connected terminals, each { browser, computer } (finding 4)
    this.terminalTimer = null;
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
      CREATE TABLE IF NOT EXISTS boundary_log (at REAL, method TEXT, path TEXT, case_tag TEXT, origin TEXT,
        fetch_site TEXT, reason TEXT);
      CREATE TABLE IF NOT EXISTS owner_confirmations (at TEXT, what TEXT, cleared TEXT, lost_since TEXT);
    `);
    // The request-intent token: created once with the storage it protects (here, or after a
    // wipe), never by a request.
    if (!this.meta("intent")) this.meta("intent", randomHex(32));
  }

  logBoundary(method, path, caseTag, origin, fetchSite, reason) {
    this.sql.exec(
      "INSERT INTO boundary_log VALUES (?, ?, ?, ?, ?, ?, ?)",
      Date.now() / 1000,
      method,
      path,
      caseTag,
      origin,
      fetchSite,
      reason,
    );
    this.sql.exec(
      `DELETE FROM boundary_log WHERE rowid NOT IN (SELECT rowid FROM boundary_log ORDER BY at DESC LIMIT ${BOUNDARY_LOG_MAX})`,
    );
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

  deleteMeta(k) {
    this.sql.exec("DELETE FROM meta WHERE k = ?", k);
  }

  generation() {
    return Number(this.meta("generation") ?? 0);
  }

  // ---------------------------------------------------------------- lost credentials (finding 1)
  lostCredentials() {
    const v = this.meta("credentials_lost");
    if (v) return JSON.parse(v);
    // The flag an earlier revision's force-stop set (cleared by a wipe then): still unresolved.
    if (this.meta("credentials_may_be_lost") === "1") {
      return { reason: "force stop (recorded by an earlier revision)", since: null };
    }
    return null;
  }

  markCredentialsLost(reason) {
    const prev = this.lostCredentials();
    this.meta(
      "credentials_lost",
      JSON.stringify(
        prev
          ? { ...prev, reason: `${prev.reason}; then ${reason}` }
          : { reason, since: new Date().toISOString(), generation: this.generation() },
      ),
    );
  }

  // A computer this Worker started, and has not stopped itself, that no longer runs: it took any
  // login it held, checkpointed or not, with it.
  computerMissing() {
    return this.meta("computer_live") === "1" && !this.ctx.container.running;
  }

  // ---------------------------------------------------------------- terminal lifetime (finding 4)
  // The window bounds the terminal's whole life, not only new connections: every connected
  // terminal passes through this object, and is closed here when the window expires or closes.
  terminalOpen() {
    return Number(this.meta("terminal_open_until") ?? 0) > Date.now();
  }

  // Opens the window until `until` (ms since the epoch), or closes it (0). Closing persists the
  // closed window first, then closes every connected terminal.
  setTerminalWindow(until, why) {
    this.meta("terminal_open_until", until);
    if (until > Date.now()) this.armTerminalTimer();
    else this.closeTerminals(why);
  }

  armTerminalTimer() {
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = null;
    if (!this.terminals.size) return;
    const left = Number(this.meta("terminal_open_until") ?? 0) - Date.now();
    if (left <= 0) {
      this.closeTerminals("its window has closed");
      return;
    }
    this.terminalTimer = setTimeout(() => {
      this.terminalTimer = null;
      this.enforceTerminalWindow();
    }, left + 50);
  }

  enforceTerminalWindow() {
    if (this.terminalOpen()) this.armTerminalTimer();
    else this.closeTerminals("its window has closed");
  }

  closeTerminals(why) {
    if (this.terminalTimer) clearTimeout(this.terminalTimer);
    this.terminalTimer = null;
    for (const t of [...this.terminals]) this.endTerminal(t, why);
  }

  // Closes both ends: the browser's with this Worker's code, and the computer's, which makes
  // ttyd end the shell.
  endTerminal(t, why) {
    if (!this.terminals.delete(t)) return;
    const reason = `terminal closed: ${why}`.slice(0, 120);
    try {
      t.browser.close(TERMINAL_CLOSE_CODE, reason);
    } catch {}
    try {
      t.computer.close(1000, reason);
    } catch {}
  }

  // Bridges the browser's WebSocket to ttyd's through this object, so it can be closed from
  // here. Every message is checked against the window. The response is a 101 with the WebSocket
  // and, when the browser offered it, the tty subprotocol; the runtime writes the other handshake
  // headers (Upgrade, Connection, Sec-WebSocket-Accept), so none are set here.
  bridgeTerminal(upstream, request) {
    const computer = upstream.webSocket;
    const pair = new WebSocketPair();
    const client = pair[0];
    const browser = pair[1];
    computer.accept();
    browser.accept();
    // ttyd and its browser client speak binary frames. With the standard binary type, workerd
    // delivers them as Blobs, which send() would write as the text "[object Blob]".
    computer.binaryType = "arraybuffer";
    browser.binaryType = "arraybuffer";
    const t = { browser, computer };
    this.terminals.add(t);
    const forward = (to, data) => {
      if (!this.terminals.has(t)) return;
      if (!this.terminalOpen()) {
        this.closeTerminals("its window has closed");
        return;
      }
      try {
        to.send(data);
      } catch {
        this.endTerminal(t, "a send failed");
      }
    };
    // Messages in order; a Blob (a runtime that ignores binaryType) is read first, then checked.
    const pass = (to) => {
      let queue = Promise.resolve();
      return (e) => {
        const data =
          typeof Blob !== "undefined" && e.data instanceof Blob ? e.data.arrayBuffer() : e.data;
        queue = queue
          .then(async () => forward(to, await data))
          .catch(() => this.endTerminal(t, "forwarding failed"));
      };
    };
    browser.addEventListener("message", pass(computer));
    computer.addEventListener("message", pass(browser));
    browser.addEventListener("close", () => this.endTerminal(t, "closed by the browser"));
    computer.addEventListener("close", () => this.endTerminal(t, "closed by the computer"));
    browser.addEventListener("error", () => this.endTerminal(t, "browser side error"));
    computer.addEventListener("error", () => this.endTerminal(t, "computer side error"));
    this.armTerminalTimer();
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((p) => p.trim());
    const answered = upstream.headers?.get?.("sec-websocket-protocol");
    const chosen = offered.includes(answered) ? answered : offered.includes("tty") ? "tty" : null;
    return new Response(null, {
      status: 101,
      webSocket: client,
      ...(chosen ? { headers: { "sec-websocket-protocol": chosen } } : {}),
    });
  }

  noteUnplannedStop() {
    if (!this.computerMissing()) return;
    this.markCredentialsLost(
      "the computer stopped unexpectedly, without a final credential checkpoint",
    );
    this.meta("computer_live", "0");
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

  async publishPayload(kind, payload, computer, generation, fail = undefined) {
    if (fail === "store") throw new Error("injected store failure");
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
      fail === "publish" ? generation - 1 : generation, // injected: refused as a stale generation
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
    this.meta("computer_live", "1"); // until stop() confirms it stopped
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
    if (!this.ctx.container.running) this.meta("computer_live", "0");
    return { stopped: !this.ctx.container.running };
  }

  async alarm() {
    if (this.terminals.size) this.enforceTerminalWindow(); // backs up the window's own timer
    if (!this.busy) this.noteUnplannedStop();
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
    const r =
      opts.fail === "export"
        ? { exit: 1 }
        : await this.runRaw(
            ["python3", "-I", CLI, "export", "--kind", kind, "--home", opts.home ?? "/root"],
            opts,
          );
    if (r.exit !== 0) return { error: `export failed (${r.exit})`, published: false };
    try {
      return await this.publishPayload(
        kind,
        parseSecretJson(r.stdout),
        computer,
        generation,
        opts.fail,
      );
    } catch (e) {
      return {
        error: `checkpoint failed: ${String(e?.message ?? e).slice(0, 120)}`,
        published: false,
      };
    }
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
    if (!PHASES.has(name)) throw new Error(`unknown phase ${name}`);
    // Finding 4: the terminal is closed, server-side, before the phase's first step.
    if (!KEEPS_TERMINAL.has(name)) this.setTerminalWindow(0, `${name} began`);
    this.noteUnplannedStop();
    const lost = this.lostCredentials();
    if (lost && !WHILE_UNRESOLVED.has(name)) {
      throw new Error(`refused: credentials are unresolved (${lost.reason}). ${REVOKE_ADVICE}`);
    }
    const step = async (label, fn, ok = () => true) => {
      const t0 = Date.now();
      const r = await fn();
      const passed = Boolean(ok(r));
      await emit({ phase: name, step: label, ms: Date.now() - t0, ok: passed, ...r });
      if (!passed) throw new Error(`step failed: ${label}`);
      return r;
    };
    const exit0 = (r) => r.exit === 0;
    // Dry runs with fault injection on may shorten the window, to test its expiry.
    const windowMs = o.windowS ? o.windowS * 1000 : TERMINAL_WINDOW_MS;
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
        this.setTerminalWindow(Date.now() + windowMs);
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
        // The sign-ins are done: the terminal was closed on entry (KEEPS_TERMINAL).
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
        // Finding 1: a signed-out checkpoint verifies only what was checkpointed. Lost
        // credentials stay unresolved, however the fresh computer looks.
        const unresolved = this.lostCredentials();
        await step(
          unresolved
            ? "the latest checkpoint is signed out in a fresh computer (this cannot cover the lost credentials)"
            : "verified signed out in a fresh computer",
          () => this.s6(["signed-out-check"], o),
          exit0,
        );
        this.meta("unsaved_computer", "0");
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        if (unresolved) {
          await emit({
            phase: name,
            unresolved: unresolved.reason,
            since: unresolved.since,
            action: REVOKE_ADVICE,
          });
          throw new Error(
            `unresolved: credentials were lost (${unresolved.reason}), so the sign-out cannot be verified here. ${REVOKE_ADVICE}`,
          );
        }
        break;
      }
      case "stop": {
        // IR-013: a computer is stopped only after its final credential checkpoint is published.
        if (this.ctx.container.running && this.restoredGeneration(PC) === this.generation()) {
          const r = await this.capture("credential", o);
          await emit({
            phase: name,
            step: "final credential checkpoint",
            ok: r.published === true,
            ...r,
          });
          if (r.published !== true) {
            this.meta("unsaved_computer", "1");
            throw new Error(
              "the final credential checkpoint failed, so the computer keeps running. Retry Stop, or run Recover (signs out and verifies), or, last, Force stop (credentials may be lost)",
            );
          }
        }
        await step(
          "stop computer",
          () => this.stop(),
          (r) => r.stopped,
        );
        this.meta("unsaved_computer", "0");
        break;
      }
      case "force-stop":
        // Stops without the final checkpoint. A login not yet checkpointed (a sign-in, or a
        // refresh) is lost, and its provider session stays valid: the credentials are unresolved
        // until the owner records that the sessions were revoked at the providers (finding 1).
        if (o.confirm !== "credentials-may-be-lost") {
          throw new Error("force-stop needs confirm=credentials-may-be-lost");
        }
        if (!this.ctx.container.running) throw new Error("no computer is running");
        this.markCredentialsLost(
          "force stop: the computer was stopped without a final credential checkpoint",
        );
        await step(
          "stop computer without a final checkpoint",
          () => this.stop(),
          (r) => r.stopped,
        );
        this.meta("unsaved_computer", "0");
        await emit({
          phase: name,
          warning: `Stopped without a final credential checkpoint. A login it held that was not checkpointed is lost, and stays valid at the provider until revoked. Run Recover to sign out what was checkpointed. ${REVOKE_ADVICE}`,
        });
        break;
      case "confirm-revoked": {
        // The only way to clear lost credentials: the owner's explicit, recorded statement that
        // the sessions were revoked at the providers. The record survives a wipe.
        if (o.confirm !== "revoked-at-providers") {
          throw new Error(
            "confirm-revoked needs confirm=revoked-at-providers, and only after revoking the sessions in the Claude and ChatGPT account settings",
          );
        }
        const unresolved = this.lostCredentials();
        if (!unresolved) throw new Error("nothing to record: no credentials are recorded as lost");
        if (this.ctx.container.running)
          throw new Error("stop the computer first (Stop or Recover)");
        const at = new Date().toISOString();
        this.sql.exec(
          "INSERT INTO owner_confirmations VALUES (?, ?, ?, ?)",
          at,
          "revoked-at-providers",
          unresolved.reason,
          unresolved.since,
        );
        this.deleteMeta("credentials_lost");
        this.deleteMeta("credentials_may_be_lost");
        await emit({
          phase: name,
          recorded: {
            at,
            what: "the owner revoked the Claude and ChatGPT sessions in the account settings",
            cleared: unresolved.reason,
            lost_since: unresolved.since,
          },
        });
        break;
      }
      case "close-terminal":
        // Closes the window and every connected terminal (done on entry), and nothing else: the
        // owner's "close the terminal now", and the qualification's closure check (Q3b).
        await emit({ phase: name, terminal: "closed", terminal_open: this.terminalOpen() });
        break;
      case "reopen-terminal":
        if (!this.ctx.container.running) throw new Error("no computer is running");
        // Only a computer whose restore finished: its credential checkpoints work, so a login
        // made in the terminal can be checkpointed before the computer stops.
        if (this.restoredGeneration(PC) !== this.generation()) {
          throw new Error("this computer's restore has not finished: no terminal");
        }
        this.setTerminalWindow(Date.now() + windowMs);
        await emit({ phase: name, terminal_open_for_s: windowMs / 1000 });
        break;
      case "wipe":
        if (this.ctx.container.running) throw new Error("stop the computer first (or run Recover)");
        if (!this.signedOutInCheckpoint()) {
          throw new Error("the latest checkpoint is still signed in: run Recover first");
        }
        await step(
          "delete all stored checkpoints and state",
          async () => {
            // The owner's revocation records are evidence, not state: they are kept.
            const kept = this.sql.exec("SELECT * FROM owner_confirmations").toArray();
            await this.ctx.storage.deleteAlarm();
            await this.ctx.storage.deleteAll();
            this.schema(); // new storage, new request-intent token: reload the page
            for (const c of kept) {
              this.sql.exec(
                "INSERT INTO owner_confirmations VALUES (?, ?, ?, ?)",
                c.at,
                c.what,
                c.cleared,
                c.lost_since,
              );
            }
            return {
              wiped: true,
              objects_left: this.state().objects,
              revocation_records_kept: kept.length,
            };
          },
          (r) => r.objects_left === 0,
        );
        break;
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
    const boundary = this.sql.exec("SELECT COUNT(*) AS n FROM boundary_log").toArray()[0];
    // Read-only: a computer found missing is reported here, and recorded by the next phase.
    const lost =
      this.lostCredentials() ??
      (this.computerMissing() && !this.busy
        ? { reason: "the computer stopped unexpectedly (recorded by the next step)", since: null }
        : null);
    return {
      running: this.ctx.container.running,
      busy: this.busy,
      generation: this.generation(),
      signed_out_in_checkpoint: this.signedOutInCheckpoint(),
      unsaved_computer: this.ctx.container.running && this.meta("unsaved_computer") === "1",
      credentials_may_be_lost: Boolean(lost),
      credentials_lost: lost,
      revocations_confirmed: this.sql
        .exec("SELECT at, what, cleared, lost_since FROM owner_confirmations ORDER BY at")
        .toArray(),
      terminal_open: this.terminalOpen(),
      terminals_connected: this.terminals.size,
      fault_injection: this.env?.S6_ALLOW_INJECTION === "1",
      boundary_refusals: boundary.n,
      pointers,
      refusals,
      objects: blobs.n,
      bytes: blobs.bytes,
    };
  }

  // ---------------------------------------------------------------- owner page
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    const caseTag = (url.searchParams.get("case") ?? "").slice(0, 40);
    const token = this.meta("intent");
    const refuse = (status, reason) => {
      this.logBoundary(
        method,
        url.pathname,
        caseTag,
        originClass(origin, url.origin),
        fetchSite,
        reason,
      );
      return new Response(`refused: ${reason}\n`, { status });
    };
    // Origin exact, and Sec-Fetch-Site same-origin when the browser sends it.
    const crossSite = () => {
      if (origin !== url.origin) return originClass(origin, url.origin);
      if (fetchSite !== null && fetchSite !== "same-origin") return `sec-fetch-site ${fetchSite}`;
      return null;
    };
    const readOnly = method === "GET" || method === "HEAD";

    if (url.pathname === "/term" || url.pathname.startsWith("/term/")) {
      if (!readOnly) return refuse(405, "method");
      if (!this.ctx.container.running)
        return new Response("The computer is not running.", { status: 503 });
      const wantsSocket = /websocket/i.test(request.headers.get("upgrade") ?? "");
      if (wantsSocket) {
        const bad = crossSite();
        if (bad) return refuse(403, `terminal: ${bad}`);
        if (!constantTimeEqual(cookieValue(request, "s6_term"), token))
          return refuse(403, "terminal: no terminal cookie");
        if (!this.terminalOpen()) return refuse(403, "terminal: window closed");
      }
      const headers = new Headers(request.headers);
      for (const h of STRIP_TO_CONTAINER) headers.delete(h);
      // The container port speaks plain HTTP. On Cloudflare an https:// URL to it throws
      // ("Connecting to a container using HTTPS is not currently supported"); wrangler dev
      // serves http://, so only the deployed Worker hit it. Only GET and HEAD reach here.
      const target = new URL(request.url);
      target.protocol = "http:";
      const r = await this.ctx.container
        .getTcpPort(TERM_PORT)
        .fetch(new Request(target, { method: request.method, headers }));
      if (r.webSocket) {
        // Checked again: a phase may have closed the window while ttyd answered.
        if (!wantsSocket || !this.terminalOpen()) {
          try {
            r.webSocket.accept();
            r.webSocket.close(1000, "refused");
          } catch {}
          return refuse(403, "terminal: window closed");
        }
        return this.bridgeTerminal(r, request);
      }
      const out = new Response(r.body, r);
      out.headers.set("x-frame-options", "DENY");
      out.headers.set("content-security-policy", "frame-ancestors 'none'");
      return out;
    }
    if (url.pathname === "/api/state") {
      if (!readOnly) return refuse(405, "method");
      const info = this.ctx.container.running ? await this.ctx.container.inspect() : null;
      return Response.json({ ...this.state(), container_image: maskImage(info?.image) });
    }
    if (url.pathname === "/api/boundary") {
      if (!readOnly) return refuse(405, "method");
      return Response.json(
        this.sql
          .exec(
            "SELECT at, method, path, case_tag, origin, fetch_site, reason FROM boundary_log ORDER BY at",
          )
          .toArray(),
      );
    }
    if (url.pathname === "/api/phase") {
      const name = url.searchParams.get("name") ?? "";
      if (readOnly) {
        // A control URL opened with GET (for example from a link on another site) only shows a
        // confirmation page; nothing runs until its button sends the POST.
        return new Response(confirmPage(name, url.search, token), { headers: PAGE_HEADERS });
      }
      if (method !== "POST") return refuse(405, "method");
      const bad = crossSite();
      if (bad) return refuse(403, bad);
      if (!constantTimeEqual(request.headers.get("x-s6-intent"), token))
        return refuse(403, "missing or wrong request-intent token");
      // fake=1: the same phases with the fake CLIs first on PATH (a dry run, no real accounts).
      const opts = url.searchParams.get("fake") === "1" ? { fake: true } : {};
      if (url.searchParams.get("fail")) {
        if (!(opts.fake && this.env?.S6_ALLOW_INJECTION === "1"))
          return refuse(403, "fault injection is off");
        opts.fail = url.searchParams.get("fail");
      }
      // A shorter terminal window, to test its expiry: a dry-run knob like `fail`.
      if (url.searchParams.get("window_s")) {
        if (!(opts.fake && this.env?.S6_ALLOW_INJECTION === "1"))
          return refuse(403, "fault injection is off");
        opts.windowS = Math.min(Math.max(Number(url.searchParams.get("window_s")) || 1, 1), 3600);
      }
      if (url.searchParams.get("confirm")) opts.confirm = url.searchParams.get("confirm");
      if (this.busy) return new Response(`busy: ${this.busy}`, { status: 409 });
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
            error: String(e?.message ?? e).slice(0, 600),
            advice: this.lostCredentials()
              ? REVOKE_ADVICE
              : "Stop here. Run Recover (sign out and verify), then Stop and wipe.",
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
      if (!readOnly) return refuse(405, "method");
      // The terminal cookie carries the same token; SameSite=Strict keeps it off cross-site requests.
      return new Response(PAGE.replace("__INTENT__", token), {
        headers: {
          ...PAGE_HEADERS,
          "set-cookie": `s6_term=${token}; Path=/term; Secure; HttpOnly; SameSite=Strict`,
        },
      });
    }
    return new Response("Not found", { status: 404 });
  }
}

// The query travels as data, never as script text (review s6-r3, finding 5): it is JSON in an
// HTML attribute, escaped for that attribute, which the browser decodes and the handler parses.
// The page lists every option, so the owner sees exactly what the button sends.
function confirmPage(name, search, token) {
  const query = search.startsWith("?") ? search : "";
  const options = [...new URLSearchParams(query)]
    .map(([k, v]) => `<li><code>${escapeHtml(k)}</code> = <code>${escapeHtml(v)}</code></li>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>S6: confirm</title></head>
<body style="font:15px system-ui;margin:24px" data-intent="${token}" data-query="${escapeHtml(JSON.stringify(query))}">
<p>This page changes nothing. Run the phase <b>${escapeHtml(name)}</b> with these options?</p>
<ul>${options}</ul>
<p><button id="go">Run ${escapeHtml(name)}</button> <a href="/">Back to the S6 page</a></p><pre id="out"></pre>
<script>document.getElementById("go").onclick=async()=>{const q=JSON.parse(document.body.dataset.query);
const r=await fetch("/api/phase"+q,{method:"POST",headers:{"X-S6-Intent":document.body.dataset.intent}});
document.getElementById("out").textContent=await r.text();};</script>
</body></html>`;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>S6 computer</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:24px auto;max-width:980px;padding:0 16px;color:#1d1d1f;background:#fafafa}
h1{font-size:22px}h2{font-size:17px;margin-top:22px}ol{padding-left:20px}li{margin:10px 0}button{font:inherit;padding:6px 12px;margin-right:8px;cursor:pointer}
code{background:#eee;padding:1px 4px;border-radius:3px}pre{background:#111;color:#ddd;padding:12px;border-radius:6px;max-height:520px;overflow:auto;white-space:pre-wrap;font-size:12px}
.note{color:#555}.warn{color:#8a1c1c}#state{font-family:monospace;font-size:13px}
</style></head><body data-intent="__INTENT__">
<h1>S6: sign-in and credential checkpoints</h1>
<p class="note">Owner-only staging page. Output below is masked: fixed text, exit codes, paths, modes, sizes, key names, states and timestamps. The terminal is not recorded. Run the steps in order; each waits until it is done.</p>
<p class="warn">If a step reports an error: stop there, click <b>Recover</b>, then <b>Stop and wipe</b>.</p>
<p id="unresolved" class="warn" hidden></p>
<p id="state"></p>
<h2>Part 1: qualification, synthetic credentials only</h2>
<ol>
<li><button data-phase="selftest" data-fake="1">Q1 Fake-CLI self-test</button> about 3 minutes.</li>
<li><button data-phase="start" data-fake="1">Q2 Start a synthetic computer</button> then <button id="termcheck">Q3 Terminal self-check</button> then <button id="closecheck">Q3b Terminal closure check</button></li>
<li>Q4: open the attacker page (see the runbook) in another tab and let it finish, then come back.</li>
<li><button id="report">Q5 Qualification report</button></li>
<li><button data-phase="stop" data-fake="1">Q6 Stop the synthetic computer</button> then <button data-phase="wipe">Q7 Wipe</button></li>
<li>Q8 lost credentials, synthetic: <button data-phase="start" data-fake="1">Q8a Start</button> <button data-phase="fake-sign-in" data-fake="1">Q8b Synthetic sign-in</button>
 <button data-phase="force-stop" data-fake="1" data-confirm="credentials-may-be-lost" data-question="Q8: force-stop the synthetic computer?">Q8c Force stop</button>
 <button data-phase="recover" data-fake="1">Q8d Recover</button> (must end unresolved), then Q7 Wipe (must refuse), then I revoked both sessions (below), then Q7 Wipe.</li>
</ol>
<h2>Part 2: real accounts</h2>
<ol>
<li><button data-phase="start">Start computer A</button> then <a href="/term/" target="_blank">open the terminal</a> (open for 20 minutes; <button data-phase="reopen-terminal">re-open</button>; <button data-phase="close-terminal">close it now</button>). Any other step closes it first.</li>
<li>In the terminal: <code>claude auth login --claudeai</code>, open the link, sign in, paste the code back.
 Then <code>codex login --device-auth</code>, open the link, sign in, enter the code. Close the terminal tab.</li>
<li><button data-phase="after-sign-in">After sign-in: audit, checkpoints, forced refresh</button></li>
<li><button data-phase="restore-b">Computer B: restore older workspace + newer credentials</button></li>
<li><button data-phase="restore-c-sign-out">Computer C: restore, then sign out of both</button></li>
<li><button data-phase="restore-d">Computer D: restore; both must stay signed out</button></li>
<li><button data-phase="wipe">Stop and wipe everything stored</button> then <button id="save">Download results</button></li>
</ol>
<p><button data-phase="recover">Recover: sign out and verify</button> only if a step failed.
 <button data-phase="stop">Stop</button> <button data-phase="force-stop" data-confirm="credentials-may-be-lost" data-question="Stop without a final checkpoint? A login not yet checkpointed is lost, and you will have to revoke the sessions in the Claude and ChatGPT account settings.">Force stop (credentials may be lost)</button></p>
<p>If the page says credentials are unresolved: revoke the sessions in the Claude and ChatGPT account settings (sign out of all devices or sessions there), then
 <button data-phase="confirm-revoked" data-confirm="revoked-at-providers" data-question="Have you revoked the sessions in both the Claude and the ChatGPT account settings? This is recorded.">I revoked both sessions</button></p>
<pre id="out"></pre>
<script>
const out=document.getElementById("out");const lines=[];const intent=document.body.dataset.intent;
const log=(l)=>{lines.push(l);out.textContent+=l+"\\n";out.scrollTop=out.scrollHeight;};
async function state(){const s=await (await fetch("/api/state")).json();document.getElementById("state").textContent=JSON.stringify(s);
 const u=document.getElementById("unresolved");u.hidden=!s.credentials_may_be_lost;
 u.textContent=s.credentials_may_be_lost?"Credentials are unresolved: "+((s.credentials_lost&&s.credentials_lost.reason)||"lost")+". A signed-out checkpoint does not cover them. Revoke the sessions in the Claude and ChatGPT account settings, then click 'I revoked both sessions'. Start and Wipe refuse until then.":"";
 return s;}
for(const b of document.querySelectorAll("button[data-phase]")){b.onclick=async()=>{
 if(b.dataset.phase==="wipe"&&!confirm("Delete every stored checkpoint?"))return;
 if(b.dataset.confirm&&!confirm(b.dataset.question||"Are you sure?"))return;
 for(const x of document.querySelectorAll("button"))x.disabled=true;
 const q="name="+b.dataset.phase+(b.dataset.fake?"&fake=1":"")+(b.dataset.confirm?"&confirm="+b.dataset.confirm:"");
 try{const r=await fetch("/api/phase?"+q,{method:"POST",headers:{"X-S6-Intent":intent}});
 if(!r.ok){log(r.status+" "+(await r.text()).trim());}else{const rd=r.body.getReader();const dec=new TextDecoder();let buf="";
 for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
  while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(l)log(l);}}}}
 finally{for(const x of document.querySelectorAll("button"))x.disabled=false;state();}};}
document.getElementById("termcheck").onclick=()=>{
 const ws=new WebSocket((location.protocol==="https:"?"wss://":"ws://")+location.host+"/term/ws?case=same-origin-control",["tty"]);
 ws.binaryType="arraybuffer";let seen="";const t=setTimeout(()=>{log(JSON.stringify({terminal_self_check:"no reply"}));ws.close();},15000);
 ws.onopen=()=>{ws.send(JSON.stringify({AuthToken:"",columns:80,rows:24}));setTimeout(()=>ws.send("0echo S6TERM$((40+2))OK\\r"),800);};
 ws.onmessage=(e)=>{const b=new Uint8Array(e.data);if(b[0]===0x30)seen+=new TextDecoder().decode(b.slice(1));
  if(seen.includes("S6TERM42OK")){clearTimeout(t);log(JSON.stringify({terminal_self_check:"command ran"}));ws.close();}};
 ws.onerror=()=>{clearTimeout(t);log(JSON.stringify({terminal_self_check:"refused or failed"}));};};
document.getElementById("closecheck").onclick=()=>{
 const url=(location.protocol==="https:"?"wss://":"ws://")+location.host+"/term/ws?case=closure-check";
 const ws=new WebSocket(url,["tty"]);ws.binaryType="arraybuffer";let seen="";let asked=false;
 const t=setTimeout(()=>{log(JSON.stringify({terminal_closure_check:"not closed within 20 s"}));ws.close();},20000);
 ws.onopen=()=>{ws.send(JSON.stringify({AuthToken:"",columns:80,rows:24}));setTimeout(()=>ws.send("0echo S6TERM$((40+2))OK\\r"),800);};
 ws.onmessage=(e)=>{const b=new Uint8Array(e.data);if(b[0]===0x30)seen+=new TextDecoder().decode(b.slice(1));
  if(!asked&&seen.includes("S6TERM42OK")){asked=true;fetch("/api/phase?name=close-terminal",{method:"POST",headers:{"X-S6-Intent":intent}}).then((r)=>r.text());}};
 ws.onclose=(e)=>{clearTimeout(t);
  log(JSON.stringify({terminal_closure_check:asked&&e.code===4001?"closed by the Worker":"not closed by the Worker",ran_first:asked,code:e.code,reason:e.reason}));
  const again=new WebSocket(url,["tty"]);
  again.onopen=()=>{log(JSON.stringify({terminal_after_closure:"accepted (wrong)"}));again.close();};
  again.onerror=()=>log(JSON.stringify({terminal_after_closure:"refused"}));};};
document.getElementById("report").onclick=async()=>{
 const b=await (await fetch("/api/boundary")).json();const s=await state();
 log(JSON.stringify({qualification_report:{state:{running:s.running,generation:s.generation,objects:s.objects,container_image:s.container_image},refused:b}}));};
document.getElementById("save").onclick=()=>{const a=document.createElement("a");
 a.href=URL.createObjectURL(new Blob([lines.join("\\n")+"\\n"],{type:"application/x-ndjson"}));a.download="s6-staging-session.jsonl";a.click();};
state();
</script></body></html>`;
