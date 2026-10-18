// Spike S6: drive the owner page's qualification buttons in headless Chromium (DevTools
// protocol), against `wrangler dev`, to check the page itself before the owner uses it:
// Q2 starts a synthetic computer, Q3 runs the terminal self-check from the page (same origin,
// with the Strict cookie), Q5 shows the report, Q6 stops, Q7 wipes. No real accounts.
//
//   node spikes/s6/staging/page-check.mjs http://127.0.0.1:18786 out.json
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2];
const outFile = process.argv[3];
const profile = mkdtempSync(join(tmpdir(), "s6-page-"));
const port = 19000 + Math.floor(Math.random() * 500);
const chrome = spawn(
  process.env.CHROME ?? "chromium",
  [
    "--headless=new",
    "--no-first-run",
    "--disable-gpu",
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 50; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    if (targets.length) break;
  } catch {}
  await sleep(200);
}
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => {
  ws.onopen = r;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))
    .result?.result?.value;
const outText = () => evaluate("document.getElementById('out').textContent");
async function clickAndWait(selector, until, ms = 120000) {
  const before = (await outText()).length;
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  for (let t = 0; t < ms; t += 500) {
    await sleep(500);
    const text = (await outText()).slice(before);
    if (until.test(text)) return text;
  }
  return (await outText()).slice(before);
}

await send("Page.enable");
await send("Page.navigate", { url: `${base}/` });
await sleep(2000);
const results = {};
results.q2_start = /"phase":"start","done":true/.test(
  await clickAndWait('button[data-phase="start"][data-fake="1"]', /"done":true|"error"/),
);
results.q3_terminal_self_check = /command ran/.test(
  await clickAndWait("#termcheck", /terminal_self_check/, 20000),
);
const report = await clickAndWait("#report", /qualification_report/, 10000);
results.q5_report_shows_running = /"running":true/.test(report);
results.q6_stop = /"phase":"stop","done":true/.test(
  await clickAndWait('button[data-phase="stop"][data-fake="1"]', /"done":true|"error"/),
);
await evaluate("window.confirm = () => true; true");
results.q7_wipe = /"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', /"done":true|"error"/),
);
results.ok = Object.values(results).every(Boolean);
writeFileSync(outFile, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results));
ws.close();
chrome.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(results.ok ? 0 : 1);
