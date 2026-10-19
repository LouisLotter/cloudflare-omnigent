// Spike S6: drive the owner page's qualification buttons in headless Chromium (DevTools
// protocol), against `wrangler dev`, to check the page itself before the owner uses it:
// Q2 starts a synthetic computer, Q3 runs the terminal self-check from the page (same origin,
// with the Strict cookie), Q3b checks that the Worker closes a working terminal, Q5 shows the
// report, Q6 stops, Q7 wipes. Then (review s6-r3) control URLs' confirmation pages with their
// options, the revocation record after a force-stop, and Q8, the page's own lost-credentials
// sequence. Run with fault injection on (`--var S6_ALLOW_INJECTION:1`), for the fail=capture
// case. No real accounts.
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
  const clicked = await evaluate(
    `(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return false; b.click(); return true; })()`,
  );
  if (!clicked) return `no such button: ${selector}`;
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
// Review s6-r3 finding 4: Q3b closes a working terminal from the Worker, then is refused.
const q3b = await clickAndWait("#closecheck", /terminal_after_closure/, 30000);
results.q3b_terminal_closed_by_the_worker = /"closed by the Worker"/.test(q3b);
results.q3b_terminal_refused_after_closure = /"terminal_after_closure":"refused"/.test(q3b);
const report = await clickAndWait("#report", /qualification_report/, 10000);
results.q5_report_shows_running = /"running":true/.test(report);
results.q6_stop = /"phase":"stop","done":true/.test(
  await clickAndWait('button[data-phase="stop"][data-fake="1"]', /"done":true|"error"/),
);
await evaluate("window.confirm = () => true; true");
results.q7_wipe = /"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', /"done":true|"error"/),
);

// Review s6-r3, findings 5 and 1 (run with fault injection on, for fail=capture): a control URL's
// confirmation page must send every option of its URL, and the page must show the revocation
// instruction and record the owner's confirmation before Wipe is allowed again.
const navigate = async (path) => {
  await send("Page.navigate", { url: `${base}${path}` });
  await sleep(2000);
};
async function confirmPageRun(query, until) {
  await navigate(`/api/phase?${query}`);
  await evaluate('document.getElementById("go").click(); true');
  for (let t = 0; t < 120000; t += 500) {
    await sleep(500);
    const text = await outText();
    if (until.test(text)) return text;
  }
  return outText();
}
const finished = /"done":true|"error"|^\d{3} /m;
await navigate("/"); // the wipe replaced the request-intent token
results.r3_start = /"phase":"start","done":true/.test(
  await clickAndWait('button[data-phase="start"][data-fake="1"]', finished),
);
results.r3_confirmation_keeps_fake = /"phase":"fake-sign-in","done":true/.test(
  await confirmPageRun("name=fake-sign-in&fake=1&case=confirm-fake", finished),
);
results.r3_confirmation_keeps_failure_option = /injected failure/.test(
  await confirmPageRun("name=stop&fake=1&fail=capture&case=confirm-fail", finished),
);
results.r3_confirmation_keeps_force_stop_confirmation = /"phase":"force-stop","done":true/.test(
  await confirmPageRun(
    "name=force-stop&confirm=credentials-may-be-lost&fake=1&case=confirm-force",
    finished,
  ),
);
await navigate("/");
await evaluate("window.confirm = () => true; true");
results.r3_page_shows_revocation_instruction = /Claude and ChatGPT account settings/.test(
  await evaluate("document.getElementById('unresolved')?.textContent ?? ''"),
);
results.r3_wipe_refused_while_unresolved = !/"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', finished),
);
results.r3_revocation_recorded = /"phase":"confirm-revoked","done":true/.test(
  await clickAndWait('button[data-phase="confirm-revoked"]', finished),
);
results.r3_wipe_after_the_record = /"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', finished),
);

// Q8, the page's own lost-credentials qualification (finding 1), with its buttons.
await navigate("/"); // the wipe replaced the request-intent token
await evaluate("window.confirm = () => true; true");
const q8 = async (phase) => clickAndWait(`button[data-phase="${phase}"][data-fake="1"]`, finished);
results.q8a_start = /"phase":"start","done":true/.test(await q8("start"));
results.q8b_synthetic_sign_in = /"phase":"fake-sign-in","done":true/.test(await q8("fake-sign-in"));
results.q8c_force_stop = /"phase":"force-stop","done":true/.test(await q8("force-stop"));
const q8d = await q8("recover");
results.q8d_recover_ends_unresolved =
  /"unresolved"/.test(q8d) &&
  !/"phase":"recover","done":true/.test(q8d) &&
  !/"verified signed out in a fresh computer","ms":\d+,"ok":true/.test(q8d);
results.q8_wipe_refused = !/"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', finished),
);
results.q8_revocation_recorded = /"phase":"confirm-revoked","done":true/.test(
  await clickAndWait('button[data-phase="confirm-revoked"]', finished),
);
results.q8_wipe = /"phase":"wipe","done":true/.test(
  await clickAndWait('button[data-phase="wipe"]', finished),
);
results.ok = Object.values(results).every(Boolean);
writeFileSync(outFile, `${JSON.stringify(results, null, 1)}\n`);
console.log(JSON.stringify(results));
ws.close();
chrome.kill();
await sleep(500);
rmSync(profile, { recursive: true, force: true });
process.exit(results.ok ? 0 : 1);
