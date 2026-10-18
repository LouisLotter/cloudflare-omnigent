// Spike S6: campaign-control and terminal boundary tests (IR-010, IR-017), with the fake CLIs.
//
// Against `wrangler dev` (local) it sends every case directly: foreign, null and missing Origin,
// a cross-site Sec-Fetch-Site, a missing or wrong request-intent token, a simple cross-site form,
// a cross-site top-level GET, other methods, and the terminal WebSocket without the exact origin,
// without the SameSite=Strict cookie, or outside its window. Each refusal must leave the state
// unchanged; the valid same-origin controls must work. Run it with fault injection off.
//
//   node spikes/s6/staging/boundary-check.mjs http://127.0.0.1:18786 spikes/s6/results/review-checkpoint-m1/boundary-check.json
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";

const base = new URL(process.argv[2]);
const outFile = process.argv[3];
const own = base.origin;
const results = [];
let failures = 0;
const check = (name, ok, detail = {}) => {
  results.push({ name, ok, ...detail });
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

const page = await fetch(`${own}/`);
const html = await page.text();
const token = /data-intent="([0-9a-f]+)"/.exec(html)?.[1];
const setCookie = page.headers.get("set-cookie") ?? "";
const termCookie = /s6_term=([0-9a-f]+)/.exec(setCookie)?.[1];
check(
  "the page carries a request-intent token and a Strict terminal cookie",
  Boolean(token) && termCookie === token && /SameSite=Strict/i.test(setCookie),
  {
    cookie_attributes: setCookie.replace(/=[0-9a-f]{16,}/, "=<token>"),
  },
);
check("the page cannot be framed", page.headers.get("x-frame-options") === "DENY");

const state = async () => (await fetch(`${own}/api/state`)).json();
const effectState = (s) =>
  JSON.stringify({
    r: s.running,
    g: s.generation,
    p: s.pointers,
    o: s.objects,
    t: s.terminal_open,
  });
async function post(
  name,
  { origin, fetchSite, intent, contentType, body, query = "&fake=1" } = {},
) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (fetchSite) headers["sec-fetch-site"] = fetchSite;
  if (intent) headers["x-s6-intent"] = intent;
  if (contentType) headers["content-type"] = contentType;
  const r = await fetch(`${own}/api/phase?name=${name}${query}`, { method: "POST", headers, body });
  return { status: r.status, text: await r.text() };
}

// ------------------------------------------------------------------ refusals with zero effect
const before = effectState(await state());
const negatives = [
  ["foreign origin", { origin: "https://attacker.invalid", intent: token }],
  ["null origin", { origin: "null", intent: token }],
  ["missing origin", { intent: token }],
  [
    "same origin but Sec-Fetch-Site cross-site",
    { origin: own, fetchSite: "cross-site", intent: token },
  ],
  ["same origin without the token", { origin: own }],
  ["same origin with a wrong token", { origin: own, intent: randomBytes(32).toString("hex") }],
  [
    "simple cross-site form (no custom header)",
    {
      origin: "https://attacker.invalid",
      contentType: "application/x-www-form-urlencoded",
      body: `x-s6-intent=${token}`,
    },
  ],
  // Run this check with fault injection off (no S6_ALLOW_INJECTION), as deployed.
  [
    "fault injection asked for while it is off",
    { origin: own, intent: token, query: "&fake=1&fail=capture" },
  ],
];
for (const [label, opts] of negatives) {
  const r = await post("start", opts);
  check(`POST start refused: ${label}`, r.status === 403, { status: r.status });
}
for (const m of ["PUT", "DELETE", "PATCH"]) {
  const r = await fetch(`${own}/api/phase?name=start&fake=1`, {
    method: m,
    headers: { origin: own, "x-s6-intent": token },
  });
  check(`${m} refused`, r.status === 405, { status: r.status });
}
const g = await fetch(`${own}/api/phase?name=wipe&case=cross-site-get`, {
  headers: { "sec-fetch-site": "cross-site" },
});
const gText = await g.text();
check(
  "a cross-site top-level GET of a control URL shows a confirmation page",
  g.status === 200 && gText.includes("changes nothing"),
);
const h = await fetch(`${own}/api/phase?name=start&fake=1`, { method: "HEAD" });
check("HEAD of a control URL changes nothing", h.status === 200);
check("no refusal or GET had any effect", effectState(await state()) === before);

// ------------------------------------------------------------------ valid control: start
const started = await post("start", { origin: own, fetchSite: "same-origin", intent: token });
check(
  "valid same-origin POST start works",
  started.status === 200 && started.text.includes('"done":true'),
);

// ------------------------------------------------------------------ terminal WebSocket
function ws(headers) {
  return new Promise((resolve) => {
    const req = http.request({
      host: base.hostname,
      port: base.port,
      path: `/term/ws?case=${headers["x-case"] ?? ""}`,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Protocol": "tty",
        ...headers,
      },
    });
    const done = (r) => {
      resolve(r);
    };
    req.on("response", (res) => done({ upgraded: false, status: res.statusCode }));
    req.on("upgrade", (_res, socket) => {
      let seen = "";
      const frame = (text) => {
        const p = Buffer.from(text);
        const mask = randomBytes(4);
        const head =
          p.length < 126
            ? Buffer.from([0x82, 0x80 | p.length])
            : Buffer.from([0x82, 0x80 | 126, p.length >> 8, p.length & 255]);
        return Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]);
      };
      socket.on("data", (d) => {
        seen += d.toString("latin1");
        if (seen.includes("S6TERM42OK")) {
          socket.destroy();
          done({ upgraded: true, command_ran: true });
        }
      });
      socket.write(frame(JSON.stringify({ AuthToken: "", columns: 80, rows: 24 })));
      setTimeout(() => socket.write(frame("0echo S6TERM$((40+2))OK\r")), 800);
      setTimeout(() => {
        socket.destroy();
        done({ upgraded: true, command_ran: false });
      }, 10000);
    });
    req.on("error", (e) => done({ error: e.code }));
    req.end();
  });
}
const cookie = `s6_term=${token}`;
const before2 = effectState(await state());
const termNeg = [
  ["foreign origin", { Origin: "https://attacker.invalid", Cookie: cookie }],
  ["null origin", { Origin: "null", Cookie: cookie }],
  ["missing origin", { Cookie: cookie }],
  [
    "same origin, Sec-Fetch-Site cross-site",
    { Origin: own, "Sec-Fetch-Site": "cross-site", Cookie: cookie },
  ],
  ["same origin without the terminal cookie", { Origin: own }],
  [
    "same origin with a wrong cookie",
    { Origin: own, Cookie: `s6_term=${randomBytes(32).toString("hex")}` },
  ],
];
for (const [label, headers] of termNeg) {
  const r = await ws(headers);
  check(`terminal refused: ${label}`, r.upgraded === false && r.status === 403, r);
}
const okTerm = await ws({ Origin: own, Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
check("valid same-origin terminal runs a command", okTerm.command_ran === true, okTerm);
check("terminal refusals had no effect", effectState(await state()) === before2);

// The terminal window closes after sign-in; a valid request is then refused.
await post("fake-sign-in", { origin: own, intent: token });
await post("after-sign-in", { origin: own, intent: token });
const closed = await ws({ Origin: own, Cookie: cookie });
check(
  "terminal refused once its window is closed (after sign-in)",
  closed.upgraded === false && closed.status === 403,
  closed,
);

// ------------------------------------------------------------------ boundary log, then clean up
const log = await (await fetch(`${own}/api/boundary`)).json();
check(
  "every refusal reached the boundary log",
  log.length >= negatives.length + 3 + termNeg.length,
  { refusals_logged: log.length },
);
await post("recover", { origin: own, intent: token });
const wiped = await post("wipe", { origin: own, intent: token });
check("cleanup: recover and wipe", wiped.text.includes('"done":true'));
writeFileSync(
  outFile,
  `${JSON.stringify({ base: own, failures, results, boundary_log: log }, null, 1)}\n`,
);
console.log(`failures: ${failures}`);
process.exit(failures ? 1 : 0);
