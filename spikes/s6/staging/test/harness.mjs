// Spike S6: an in-memory harness that runs the actual staging Durable Object (../worker.js) in
// Node, with the Workers pieces it uses replaced by fakes:
// - `ctx.storage.sql` on node:sqlite, in memory;
// - `ctx.container`: a fake computer whose homes hold synthetic login ids, with the inner.sh
//   actions, the credsync export/import/watch-export commands and a ttyd WebSocket;
// - a fake "provider" that records which synthetic logins are still active (not revoked), so a
//   test can tell a real sign-out from a home that merely looks signed out;
// - WebSocketPair, and a Response that accepts status 101 with a webSocket, as in workerd.
// Time runs WARP times faster (Date.now and setTimeout), so sleeps and windows stay short.
// No real CLI, container, account or network is involved.
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as realSleep } from "node:timers/promises";
import vm from "node:vm";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: new URL("./cloudflare-workers.mjs", import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// ------------------------------------------------------------------ time warp
export const WARP = 200;
const realNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout;
const t0 = realNow();
Date.now = () => Math.floor(t0 + (realNow() - t0) * WARP);
globalThis.setTimeout = (fn, ms = 0, ...args) =>
  realSetTimeout(fn, Math.max(0, ms / WARP), ...args);
export const sleepReal = (ms) => realSleep(ms);
// Wait until `cond()` holds, polling in real time; false after `realMs`.
export async function until(cond, realMs = 2000) {
  for (let t = 0; t < realMs; t += 5) {
    if (cond()) return true;
    await realSleep(5);
  }
  return Boolean(cond());
}

// The Worker logs every result line (Workers Logs); keep the test output readable.
const realLog = console.log;
console.log = (...args) => {
  if (!String(args[0]).startsWith("S6RESULT ")) realLog(...args);
};

// ------------------------------------------------------------------ workerd shapes
const BaseResponse = globalThis.Response;
globalThis.Response = class WorkerResponse extends BaseResponse {
  constructor(body, init = {}) {
    if (init?.status === 101) {
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, "status", { value: 101 });
    } else {
      super(body, init);
    }
    this.webSocket = init?.webSocket ?? null;
  }
};

const closeEvent = (code, reason) => Object.assign(new Event("close"), { code, reason });
const validCloseCode = (code) => code === 1000 || (code >= 3000 && code <= 4999);

// Message data as workerd handles it (compatibility date 2026-10-01). send() takes a string, an
// ArrayBuffer or a view; anything else goes out as its string form (a Blob as "[object Blob]").
// A received binary message is a Blob unless the socket's binaryType is "arraybuffer" (the
// standard default, which workerd follows since its standard binary-type change).
const toWire = (data) => {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return String(data);
};
// A runtime that ignores binaryType (always Blobs), for the Worker's fallback path.
export const runtime = { ignoreBinaryType: false };
const fromWire = (wire, binaryType) =>
  typeof wire === "string"
    ? wire
    : binaryType === "arraybuffer" && !runtime.ignoreBinaryType
      ? wire.buffer
      : new Blob([wire]);

// One end of a WebSocketPair. send() delivers to the peer; close() closes both ends.
class PairSocket extends EventTarget {
  constructor() {
    super();
    this.peer = null;
    this.closed = null;
    this.binaryType = "blob";
  }
  accept() {}
  send(data) {
    if (this.closed) throw new TypeError("WebSocket is closed");
    const peer = this.peer;
    const wire = toWire(data);
    queueMicrotask(() => {
      if (!peer.closed)
        peer.dispatchEvent(new MessageEvent("message", { data: fromWire(wire, peer.binaryType) }));
    });
  }
  close(code = 1000, reason = "") {
    if (!validCloseCode(code)) throw new TypeError(`invalid close code ${code}`);
    if (this.closed) return;
    this.closed = { code, reason };
    const peer = this.peer;
    if (!peer.closed) {
      peer.closed = { code, reason, by_peer: true };
      queueMicrotask(() => peer.dispatchEvent(closeEvent(code, reason)));
    }
  }
}
globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const a = new PairSocket();
    const b = new PairSocket();
    a.peer = b;
    b.peer = a;
    this[0] = a;
    this[1] = b;
  }
};

// ------------------------------------------------------------------ storage
class Sql {
  constructor() {
    this.db = new DatabaseSync(":memory:");
  }
  exec(query, ...bindings) {
    const args = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b));
    const rows = (r) => ({ toArray: () => r });
    if (!args.length && query.trim().replace(/;\s*$/, "").includes(";")) {
      this.db.exec(query);
      return rows([]);
    }
    const stmt = this.db.prepare(query);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) return rows(stmt.all(...args));
    stmt.run(...args);
    return rows([]);
  }
  reset() {
    for (const { name } of this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      this.db.exec(`DROP TABLE "${name}"`);
    }
  }
}

// ------------------------------------------------------------------ the fake computer
const enc = new TextEncoder();
const dec = new TextDecoder();
const CRED_FILES = [
  [".claude/.credentials.json", "claude"],
  [".claude/.device-keys.json", null],
  [".codex/auth.json", "codex"],
  [".omnigent/auth_tokens.json", "omnigent"],
];
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// ttyd's end of the terminal WebSocket, as the Worker sees it. Input "0echo X" is answered with
// "0X" (the shell runs in the computer), in a binary frame as ttyd sends; close() ends the shell.
// Like ttyd, it reads a message's first byte as its type: "[object Blob]" is not input.
class FakeTtyd extends EventTarget {
  constructor(world) {
    super();
    this.world = world;
    this.input = [];
    this.closed = null;
    this.binaryType = "blob";
  }
  accept() {}
  send(data) {
    if (this.closed) throw new TypeError("WebSocket is closed");
    const wire = toWire(data);
    const text = typeof wire === "string" ? wire : dec.decode(wire);
    this.input.push(text);
    this.world.log("ttyd-input", text);
    const m = text.startsWith("0") ? /echo (\S+)/.exec(text) : null;
    if (m) {
      const out = enc.encode(`0${m[1].replace("$((40+2))", "42")}\r\n`);
      queueMicrotask(() => {
        if (!this.closed)
          this.dispatchEvent(new MessageEvent("message", { data: fromWire(out, this.binaryType) }));
      });
    }
  }
  close(code = 1000, reason = "") {
    if (!validCloseCode(code)) throw new TypeError(`invalid close code ${code}`);
    this.end(code, reason);
  }
  end(code, reason) {
    if (this.closed) return;
    this.closed = { code, reason };
    this.world.log("ttyd-closed", reason);
    queueMicrotask(() => this.dispatchEvent(closeEvent(code, reason)));
  }
}

// Cloudflare's answer to a start right after a stop (DC-37), as seen on staging on 19 Oct.
export const START_REFUSED_TEXT =
  "There is no container instance that can be provided to this Durable Object, try again later";

class FakeContainer {
  constructor(world) {
    this.world = world;
    this.running = false;
    this.homes = new Map();
    this.ttyd = [];
    this.termRequests = [];
    // DC-37 models: refuse the next N starts, and/or every start within this many ms of the
    // last stop (warped time). A destroy that does nothing models a stop that does not happen.
    this.refuseStarts = 0;
    this.refuseWithinMs = 0;
    this.lastStopAt = null;
    this.ignoreDestroy = false;
    // Review s6-fu-r1: start() returns after validating its options, and a placement refusal
    // can arrive later, through monitor(); destroy() can fail; other start errors exist.
    this.refuseLateStarts = 0;
    this.destroyThrows = false;
    this.holdDestroy = false;
    this.heldDestroy = null;
    this.startErrors = [];
    this.monitorPromise = null;
    this.resolveMonitor = null;
  }
  start() {
    const sinceStop = this.lastStopAt === null ? Infinity : Date.now() - this.lastStopAt;
    if (this.startErrors.length) {
      this.world.log("container-start-error");
      throw new Error(this.startErrors.shift());
    }
    if (this.refuseStarts > 0 || sinceStop < this.refuseWithinMs) {
      if (this.refuseStarts > 0) this.refuseStarts--;
      this.world.log("container-start-refused");
      throw new Error(START_REFUSED_TEXT);
    }
    if (this.refuseLateStarts > 0) {
      this.refuseLateStarts--;
      this.world.log("container-start-refused-late");
      this.monitorPromise = new Promise((_, reject) =>
        queueMicrotask(() => reject(new Error(START_REFUSED_TEXT))),
      );
      this.monitorPromise.catch(() => {});
      return;
    }
    this.world.log("container-start");
    this.running = true;
    this.homes = new Map();
    this.monitorPromise = new Promise((resolve) => {
      this.resolveMonitor = resolve;
    });
  }
  monitor() {
    return this.monitorPromise ?? new Promise(() => {});
  }
  async destroy() {
    this.world.log("container-destroy");
    if (this.holdDestroy) {
      // The test settles it: resolve, or reject after whatever it does meanwhile.
      await new Promise((resolve, reject) => {
        this.heldDestroy = { resolve, reject };
      });
      this.heldDestroy = null;
    }
    if (this.destroyThrows) throw new Error("destroy failed (test)");
    if (this.ignoreDestroy) return;
    this.stopNow("container stopped");
  }
  // The computer goes away without the Worker asking (a crash, a host restart).
  crash() {
    this.world.log("container-crash");
    this.stopNow("container crashed");
  }
  stopNow(why) {
    if (this.running) this.lastStopAt = Date.now();
    this.running = false;
    this.resolveMonitor?.();
    this.resolveMonitor = null;
    this.homes = new Map();
    for (const t of this.ttyd) t.end(1006, why);
  }
  async setInactivityTimeout() {}
  async inspect() {
    return {
      image: `registry.cloudflare.com/acct0123/cfo-stg-s6-creds-pc@sha256:${"0".repeat(64)}`,
    };
  }
  home(path) {
    if (!this.homes.has(path)) this.homes.set(path, { claude: null, codex: null, omnigent: null });
    return this.homes.get(path);
  }
  getTcpPort() {
    return {
      fetch: async (input) => {
        if (!this.running) throw new Error("container is not running");
        const req = typeof input === "string" ? new Request(input) : input;
        this.termRequests.push({ url: req.url, headers: new Headers(req.headers) });
        if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
          const ws = new FakeTtyd(this.world);
          this.ttyd.push(ws);
          this.world.log("ttyd-connected");
          return {
            status: 101,
            webSocket: ws,
            headers: new Headers({ "sec-websocket-protocol": "tty" }),
            body: null,
          };
        }
        return new Response("<html>ttyd</html>", { status: 200 });
      },
    };
  }

  // --------------------------------------------------------------- synthetic logins
  signIn(h, who) {
    const id = `${who}-${++this.world.n}`;
    this.world.active.add(id);
    h[who] = id;
  }
  signOut(h, who) {
    if (h[who]) this.world.active.delete(h[who]); // the CLI revokes at the provider
    h[who] = null;
  }
  rotate(h, who) {
    if (!h[who]) return false;
    this.world.active.delete(h[who]);
    this.signIn(h, who);
    return true;
  }

  async exec(cmd, opts = {}) {
    if (!this.running) throw new Error("container is not running");
    this.world.log("exec", cmd.join(" "));
    const h = this.home(opts.env?.HOME ?? "/root");
    if (opts.stdout === "pipe") return this.watchProcess(cmd);
    let stdinText = "";
    let stdinClosed;
    const closed = new Promise((r) => {
      stdinClosed = r;
    });
    const stdin = new WritableStream({
      write(chunk) {
        stdinText += dec.decode(chunk);
      },
      close() {
        stdinClosed();
      },
    });
    if (opts.stdin !== "pipe") stdinClosed();
    return {
      stdin,
      kill() {},
      output: async () => {
        await closed;
        const r = this.run(cmd, h, stdinText);
        return {
          exitCode: r.exit,
          stdout: enc.encode(r.stdout ?? ""),
          stderr: new Uint8Array(0),
        };
      },
    };
  }

  watchProcess(cmd) {
    let ctrl;
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        ctrl.close();
      }
    };
    const stdout = new ReadableStream({
      start(c) {
        ctrl = c;
      },
    });
    if (cmd.includes("watch-export")) ctrl.enqueue(enc.encode('{"event": "watching"}\n'));
    else end(); // the injected watcher that exits at once
    return { stdin: new WritableStream({ close: end }), stdout, kill: end };
  }

  run(cmd, h, stdinText) {
    const [c0, c1, c2] = cmd;
    if (c0 === "bash" && c1 === "/opt/s6/owner/inner.sh") return this.inner(c2, h);
    if (c0 === "bash" && c1 === "-c") return this.shell(c2, h);
    if (c0 === "cat") return { exit: 0, stdout: "{}" };
    const cli = cmd.indexOf("/opt/s6/credsync/cli.py");
    if (cli >= 0) return this.credsync(cmd[cli + 1], cmd, h, stdinText);
    return { exit: 0, stdout: "{}" };
  }

  shell(script, h) {
    if (script.startsWith("cat > ")) return { exit: 0 };
    let exit = 0;
    for (const part of script.split(/&&|;/).map((s) => s.trim())) {
      const who = ["claude", "codex", "omnigent"].find((w) => part.startsWith(w));
      if (!who) continue;
      if (/ login\b/.test(part)) this.signIn(h, who);
      else if (/ refresh\b/.test(part)) exit ||= this.rotate(h, who) ? 0 : 1;
      else if (/logout|signout/.test(part)) this.signOut(h, who);
    }
    return { exit, stdout: "" };
  }

  // Output as inner.sh prints it (`echo "{\"x\": \"y\"}"`, with a space after each colon).
  inner(action, h) {
    const json = (o) => JSON.stringify(o).replaceAll('":', '": ');
    const state = (who) => (h[who] ? "true" : "false");
    switch (action) {
      case "claude-status":
        return { exit: 0, stdout: json({ claude_logged_in: state("claude") }) };
      case "codex-status":
        return { exit: 0, stdout: json({ codex_logged_in: state("codex") }) };
      case "signed-out-check":
        return {
          exit: h.claude || h.codex ? 1 : 0,
          stdout: json({ claude_logged_in: state("claude"), codex_logged_in: state("codex") }),
        };
      case "claude-logout":
      case "codex-logout": {
        this.signOut(h, action.split("-")[0]);
        return { exit: 0, stdout: json({ [`${action.replace("-", "_")}_exit`]: 0 }) };
      }
      case "claude-force-refresh":
      case "codex-force-refresh":
        return { exit: this.rotate(h, action.split("-")[0]) ? 0 : 1, stdout: "{}" };
      case "claude-ask":
      case "codex-ask":
        return { exit: h[action.split("-")[0]] ? 0 : 1, stdout: "{}" };
      default:
        return { exit: 0, stdout: "{}" };
    }
  }

  credsync(verb, cmd, h, stdinText) {
    const kind = cmd[cmd.indexOf("--kind") + 1];
    if (verb === "export") {
      const order = ++this.world.order;
      if (kind === "credential") {
        const archive = enc.encode(JSON.stringify({ ...h }));
        const records = CRED_FILES.map(([path, who]) => {
          const present = Boolean(who && h[who]);
          return {
            path,
            state: present ? "present" : "absent",
            size: present ? 100 : null,
            mode: present ? "0600" : null,
          };
        });
        return {
          exit: 0,
          stdout: JSON.stringify({
            archive_b64: b64(archive),
            archive_sha256: sha256(archive),
            records,
            order,
            taken_at: Date.now() / 1000,
          }),
        };
      }
      const archive = enc.encode("workspace");
      return {
        exit: 0,
        stdout: JSON.stringify({
          archive_b64: b64(archive),
          archive_sha256: sha256(archive),
          file_count: 1,
          bytes: archive.length,
          taken_at: Date.now() / 1000,
        }),
      };
    }
    if (verb === "import") {
      const { manifest, archive_b64 } = JSON.parse(stdinText);
      if (manifest.kind === "credential") {
        const logins = JSON.parse(dec.decode(Buffer.from(archive_b64, "base64")));
        for (const who of ["claude", "codex", "omnigent"]) h[who] = logins[who] ?? null;
      }
      return { exit: 0, stdout: JSON.stringify({ installed: manifest.kind }) };
    }
    return { exit: 0, stdout: "{}" };
  }
}

// ------------------------------------------------------------------ a world: one DO and its fakes
export const ORIGIN = "https://s6.test";

export async function makeWorld({ injection = false } = {}) {
  const { S6Computer } = await import("../worker.js");
  const world = {
    active: new Set(), // synthetic logins not yet revoked at the "provider"
    n: 0,
    order: 0,
    events: [],
    log(type, detail = "") {
      world.events.push({ type, detail });
    },
  };
  const sql = new Sql();
  const container = new FakeContainer(world);
  const ctx = {
    storage: {
      sql,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
      deleteAll: async () => sql.reset(),
    },
    container,
  };
  const env = { S6_ALLOW_INJECTION: injection ? "1" : "0" };
  const obj = new S6Computer(ctx, env);
  Object.assign(world, { obj, container, sql, env });
  world.token = () => obj.meta("intent");
  world.state = async () => (await obj.fetch(new Request(`${ORIGIN}/api/state`))).json();

  // POST a phase the way the owner page does; returns the parsed NDJSON lines.
  world.phase = async (query, extraHeaders = {}) => {
    const res = await obj.fetch(
      new Request(`${ORIGIN}/api/phase?${query}`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-s6-intent": world.token(), ...extraHeaders },
      }),
    );
    const text = await res.text();
    const lines =
      res.status === 200
        ? text
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    return {
      status: res.status,
      text,
      lines,
      done: lines.some((l) => l.done === true),
      error: lines.find((l) => l.error)?.error ?? (res.status === 200 ? null : text),
    };
  };

  // The browser's terminal: a WebSocket to /term/ws with the page's origin and Strict cookie.
  world.connectTerminal = async (headers = {}) => {
    const res = await obj.fetch(
      new Request(`${ORIGIN}/term/ws`, {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "sec-websocket-protocol": "tty",
          cookie: `s6_term=${world.token()}; CF_Authorization=synthetic-access-cookie`,
          "x-s6-intent": world.token(),
          ...headers,
        },
      }),
    );
    const ws = res.webSocket;
    const term = { res, ws, received: [], closeEvent: null };
    if (ws) {
      ws.accept?.();
      ws.binaryType = "arraybuffer"; // as the owner page's terminal (ttyd's client) sets it
      ws.addEventListener("message", (e) => {
        if (e.data instanceof Blob) e.data.text().then((t) => term.received.push(t));
        else term.received.push(typeof e.data === "string" ? e.data : dec.decode(e.data));
      });
      ws.addEventListener("close", (e) => {
        term.closeEvent = { code: e.code, reason: e.reason };
      });
    }
    term.closed = () => Boolean(term.closeEvent || ws?.closed);
    // ttyd's client sends keystrokes as binary frames.
    term.type = async (text) => {
      try {
        ws.send(enc.encode(text));
      } catch {
        return false;
      }
      await sleepReal(10);
      return true;
    };
    return term;
  };
  return world;
}

// ------------------------------------------------------------------ the confirmation page in a tiny DOM
const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(
      /&(quot|apos|lt|gt|amp);/g,
      (_, n) => ({ quot: '"', apos: "'", lt: "<", gt: ">", amp: "&" })[n],
    );

function attributes(tagText) {
  const out = {};
  for (const m of tagText.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? "");
  }
  return out;
}

// Parses the page's elements (attributes decoded as a browser decodes them), runs its inline
// script, clicks the button with id "go", and returns the fetch the click made.
export async function clickConfirmButton(html) {
  const elements = {};
  let body = null;
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g)) {
    const attrs = attributes(m[2]);
    const el = { tag: m[1].toLowerCase(), attrs, dataset: {}, textContent: "", onclick: null };
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("data-"))
        el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    }
    el.getAttribute = (k) => attrs[k.toLowerCase()] ?? null;
    el.addEventListener = (type, fn) => {
      if (type === "click") el.onclick = fn;
    };
    if (el.tag === "body") body = el;
    if (attrs.id) elements[attrs.id] = el;
  }
  const calls = [];
  const document = {
    body,
    getElementById: (id) => elements[id] ?? null,
    querySelector: (sel) => (sel.startsWith("#") ? (elements[sel.slice(1)] ?? null) : null),
  };
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => "" };
  };
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
  vm.runInNewContext(script, { document, fetch, JSON, URLSearchParams, window: {} });
  const go = elements.go;
  if (!go?.onclick) throw new Error("the confirmation page has no button handler");
  await go.onclick({ preventDefault() {} });
  return calls[0];
}
