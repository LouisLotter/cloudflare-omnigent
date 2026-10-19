// Spike S6, review s6-r3 finding 4: an already-connected terminal must be closed by the Worker
// when its window expires, and before After sign-in, Recover, Stop, Force stop and Wipe take any
// step. Run against `wrangler dev` with fault injection on (the short window is a dry-run knob),
// with the fake CLIs only.
//
//   node spikes/s6/staging/terminal-close-check.mjs http://127.0.0.1:18786 out.json
//
// Each terminal is a real WebSocket to /term/ws through the Worker, to ttyd in the container. A
// closure counts only if the Worker sends a close frame with its own code (4001); a terminal that
// ends because the container stopped does not count.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";

const base = new URL(process.argv[2]);
const outFile = process.argv[3];
const own = base.origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failures = 0;
const check = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const WORKER_CLOSE = 4001;

const page = await fetch(`${own}/`);
const html = await page.text();
const token = /data-intent="([0-9a-f]+)"/.exec(html)?.[1];

// POST a phase; returns the NDJSON lines with the time each arrived.
async function phase(query) {
  const r = await fetch(`${own}/api/phase?${query}`, {
    method: "POST",
    headers: { origin: own, "sec-fetch-site": "same-origin", "x-s6-intent": token },
  });
  const lines = [];
  if (r.status !== 200) return { status: r.status, lines, text: await r.text(), done: false };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf("\n");
    while (i >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      i = buf.indexOf("\n");
      if (l) lines.push({ ...JSON.parse(l), received_at: Date.now() });
    }
  }
  return { status: 200, lines, done: lines.some((l) => l.done) };
}

// A masked client frame; binary by default, as ttyd's client sends.
const frame = (data, op = 0x2) => {
  const p = Buffer.from(data);
  const mask = randomBytes(4);
  const head =
    p.length < 126
      ? Buffer.from([0x80 | op, 0x80 | p.length])
      : Buffer.from([0x80 | op, 0x80 | 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]);
};

// A terminal as the owner's browser opens it: exact origin, the Strict cookie, the tty protocol.
function connect(caseTag) {
  return new Promise((resolve) => {
    const req = http.request({
      host: base.hostname,
      port: base.port,
      path: `/term/ws?case=${caseTag}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": "tty",
        Origin: own,
        "Sec-Fetch-Site": "same-origin",
        Cookie: `s6_term=${token}`,
      },
    });
    // A refused upgrade: the same shape, inert.
    const refused = (extra) => ({
      upgraded: false,
      text: "",
      close: null,
      ended: null,
      send: () => false,
      destroy: () => {},
      until: async (pred) => pred(),
      ...extra,
    });
    req.on("response", (res) => resolve(refused({ status: res.statusCode })));
    req.on("error", (e) => resolve(refused({ error: e.code })));
    req.on("upgrade", (res, socket, head) => {
      const names = res.rawHeaders.filter((_, i) => i % 2 === 0).map((h) => h.toLowerCase());
      const t = {
        upgraded: true,
        status: res.statusCode,
        protocol: res.headers["sec-websocket-protocol"] ?? null,
        upgrade_headers: names.filter((h) => h === "upgrade").length,
        text: "",
        close: null,
        ended: null,
      };
      let buf = Buffer.from(head ?? []);
      const parse = () => {
        while (buf.length >= 2) {
          const op = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (op === 0x8) {
            t.close ??= {
              at: Date.now(),
              code: payload.length >= 2 ? payload.readUInt16BE(0) : null,
              reason: payload.subarray(2).toString(),
            };
          } else if (op === 0x1 || op === 0x2) {
            t.text += payload.toString("latin1");
          } else if (op === 0x9 && !socket.destroyed) {
            socket.write(frame(payload, 0xa)); // answer pings, as a browser does
          }
        }
      };
      socket.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        parse();
      });
      socket.on("close", () => {
        t.ended ??= Date.now();
      });
      socket.on("error", () => {
        t.ended ??= Date.now();
      });
      t.send = (s) => {
        if (socket.destroyed) return false;
        socket.write(frame(s));
        return true;
      };
      t.destroy = () => socket.destroy();
      t.until = async (pred, ms) => {
        for (let i = 0; i < ms && !pred(); i += 50) await sleep(50);
        return pred();
      };
      t.send(JSON.stringify({ AuthToken: "", columns: 80, rows: 24 }));
      resolve(t);
    });
    req.end();
  });
}

async function workingTerminal(caseTag) {
  const t = await connect(caseTag);
  if (!t.upgraded) return { t, ran: false };
  await sleep(800);
  t.send("0echo S6TERM$((40+2))OK\r");
  const ran = await t.until(() => t.text.includes("S6TERM42OK"), 10000);
  return { t, ran };
}

const closedByWorker = (t) => t.close?.code === WORKER_CLOSE;
const summary = (t) => ({
  status: t.status,
  close: t.close,
  ended: Boolean(t.ended),
  protocol: t.protocol,
  upgrade_headers: t.upgrade_headers,
});

// The terminal is open while `query` runs: it must be closed by the Worker before the phase's
// first step line, and typing afterwards must not run anything.
async function closedBefore(label, query, idleMs = 0) {
  const { t, ran } = await workingTerminal(`before-${label}`);
  check(`${label}: a connected terminal runs a command first`, ran, summary(t));
  if (!t.upgraded) return phase(query);
  if (idleMs) {
    // The owner's sign-in takes minutes: an idle terminal must stay usable inside its window.
    await sleep(idleMs);
    t.text = "";
    t.send("0echo S6IDLE$((2+3))\r");
    check(
      `${label}: still usable after ${idleMs / 1000} s idle`,
      await t.until(() => t.text.includes("S6IDLE5"), 5000),
      summary(t),
    );
  }
  const sentAt = Date.now();
  const r = await phase(query);
  const firstStep = r.lines.find((l) => l.step || l.error);
  await t.until(() => t.close || t.ended, 3000);
  check(
    `${label}: the Worker closed the terminal before the phase's first step`,
    closedByWorker(t) && (!firstStep || t.close.at <= firstStep.received_at),
    {
      ...summary(t),
      close_after_post_ms: t.close ? t.close.at - sentAt : null,
      first_step_after_post_ms: firstStep ? firstStep.received_at - sentAt : null,
    },
  );
  t.text = "";
  t.send("0echo S6LATE$((1+1))\r");
  await sleep(1500);
  check(`${label}: nothing typed afterwards runs`, !t.text.includes("S6LATE2"));
  t.destroy();
  return r;
}

// ------------------------------------------------------------------ 1. the window expires
let r = await phase("name=start&fake=1&window_s=4");
check("setup: start with a 4-second terminal window", r.done, { error: r.text ?? null });
{
  const { t, ran } = await workingTerminal("window-expiry");
  check("the terminal answers the tty subprotocol", t.protocol === "tty", summary(t));
  check("one Upgrade header in the handshake", t.upgrade_headers === 1, summary(t));
  check("a terminal opened inside the window runs a command", ran);
  await t.until(() => t.close || t.ended, 10000);
  check(
    "the Worker closed the open terminal when its window expired",
    closedByWorker(t),
    summary(t),
  );
  t.text = "";
  t.send("0echo S6LATE$((1+1))\r");
  await sleep(1500);
  check("nothing typed after the expiry runs", !t.text.includes("S6LATE2"));
  t.destroy();
  const again = await connect("after-expiry");
  check("a new terminal is refused after the expiry", !again.upgraded && again.status === 403, {
    status: again.status,
  });
  again.destroy?.();
}

// ------------------------------------------------------------------ 2. before each phase
await phase("name=reopen-terminal&fake=1");
await phase("name=fake-sign-in&fake=1");
r = await closedBefore("after-sign-in", "name=after-sign-in&fake=1", 30000);
check("setup: after-sign-in completed", r.done);

await phase("name=reopen-terminal&fake=1");
r = await closedBefore("recover", "name=recover&fake=1");
check("setup: recover completed", r.done);

r = await phase("name=start&fake=1");
check("setup: start", r.done);
await phase("name=fake-sign-in&fake=1");
r = await closedBefore("stop", "name=stop&fake=1");
check("setup: stop completed", r.done);
r = await phase("name=recover&fake=1");
check("setup: recover after stop", r.done);

r = await phase("name=start&fake=1");
check("setup: start", r.done);
r = await closedBefore("wipe", "name=wipe");
check("wipe was refused while the computer runs", !r.done);

await phase("name=fake-sign-in&fake=1");
await phase("name=reopen-terminal&fake=1"); // the refused wipe closed the window too
r = await closedBefore("force-stop", "name=force-stop&fake=1&confirm=credentials-may-be-lost");
check("setup: force-stop completed", r.done);

// ------------------------------------------------------------------ clean up (synthetic only)
await phase("name=recover&fake=1");
await phase("name=confirm-revoked&confirm=revoked-at-providers");
const wiped = await phase("name=wipe");
check("cleanup: wiped", wiped.done);

writeFileSync(outFile, `${JSON.stringify({ base: own, failures, results }, null, 1)}\n`);
console.log(`failures: ${failures}`);
process.exit(failures ? 1 : 0);
