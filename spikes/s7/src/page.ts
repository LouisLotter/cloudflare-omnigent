// The owner's staging test page, served at /__s7/ behind the deployment's Access application.
// One click runs the whole S7 sequence in the owner's browser, through the real edge, Access
// and Worker: browser-path variants, the computer run, the interface check, a server
// replacement with requests during it, then everything again. Results go to the Worker log.

/** Reads Omnigent's settings page in a same-origin frame. Also used by the local CDP check. */
export const UI_CHECK_SOURCE = `
async function checkSharingPage(doc) {
  const text = (doc.body && doc.body.innerText) || "";
  const radios = [...doc.querySelectorAll('input[type="radio"]')];
  const switches = [...doc.querySelectorAll('[role="switch"]')];
  const selects = [...doc.querySelectorAll('[aria-label="Maximum public permission"]')];
  const fieldsets = [...doc.querySelectorAll("fieldset")];
  return {
    title: text.includes("Session sharing"),
    modeBanner: text.includes("The sharing mode is managed by this deployment and can't be changed here."),
    publicNote: text.includes("Managed by this deployment and can't be changed here."),
    ceilingNote: text.includes("Managed by this deployment."),
    radios: radios.length,
    radiosDisabled: radios.filter((r) => r.disabled).length,
    switches: switches.length,
    switchesDisabled: switches.filter((s) => s.disabled || s.getAttribute("aria-disabled") === "true" || s.hasAttribute("data-disabled")).length,
    selects: selects.length,
    selectsDisabled: selects.filter((s) => s.disabled || s.hasAttribute("data-disabled")).length,
    fieldsets: fieldsets.length,
    fieldsetsDisabled: fieldsets.filter((f) => f.disabled).length,
  };
}`;

/** The page's own script. Long steps start a job and poll it, so no request stays open long. */
const PAGE_SCRIPT = String.raw`
const logEl = document.getElementById("log");
const summaryEl = document.getElementById("summary");
const summary = [];
function log(line) { logEl.textContent += new Date().toISOString() + " " + line + "\n"; }
function show() { summaryEl.textContent = summary.join("\n"); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(path + " -> " + res.status + " " + JSON.stringify(data));
  return data;
}
async function record(entry) { await api("/__s7/api/record", entry); }
function b64(s) { const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); }
async function pollJob(path, done, limitMs) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    const data = await api(path).catch((e) => ({ pollError: String(e) }));
    if (done(data)) return data;
    await wait(3000);
  }
  throw new Error(path + " did not finish in " + Math.round(limitMs / 1000) + " s");
}
const serverJobDone = (j) => j && (j.state === "done" || j.state === "failed");
async function runVariants(label) {
  const rows = [];
  for (const v of VARIANTS) {
    const init = { method: v.method, headers: v.headers, credentials: "same-origin", redirect: "manual", cache: "no-store" };
    if (v.bodyBase64 !== null) init.body = b64(v.bodyBase64);
    let status = 0, guard = "", flags = null, error = "";
    const started = performance.now();
    // Absolute URL: a path such as //v1/sharing would otherwise name another host.
    const target = location.origin + v.path;
    try {
      const res = await fetch(target, init);
      status = res.status; guard = res.headers.get("x-s7-guard") || "";
      if ((res.headers.get("content-type") || "").includes("json") && v.method !== "HEAD") {
        const data = await res.json().catch(() => null);
        if (data && "sharing_mode" in data) flags = ["editable", "public_sharing_editable", "public_sharing_max_level_editable", "default_public_sessions_editable"].map((k) => k + "=" + data[k]).join(" ");
      }
    } catch (e) { error = String(e); }
    const ms = Math.round(performance.now() - started);
    const sent = new URL(target).pathname;
    // Refused by the guard, or rejected by the HTTP stack in front of the Worker (no guard header).
    const pass = v.expect === "refuse" ? ((status === 403 && guard === "refused") || (guard === "" && [0, 400, 405, 500, 501].includes(status)))
      : v.expect === "rewrite" ? (guard === "rewritten" ? !String(flags).includes("=true") : guard === "managed-passthrough")
      : guard === "forwarded";
    rows.push({ id: v.id, method: v.method, path: v.path, sent, expect: v.expect, status, guard, flags, ms, error, pass });
  }
  const passed = rows.filter((r) => r.pass).length;
  summary.push(label + " browser variants: " + passed + "/" + rows.length + " pass"); show();
  for (const r of rows.filter((r) => !r.pass)) log("FAIL " + JSON.stringify(r));
  await record({ kind: "browser-variants", label, passed, total: rows.length, rows });
  return rows;
}
async function inspect(label) {
  const data = await api("/__s7/api/inspect");
  const d = data.direct || {};
  const managed = d.sharing_mode === "read_only" && d.public_sharing_enabled === false && d.public_sharing_max_level === "read" && d.default_public_sessions === "off";
  summary.push(label + ": server settings managed=" + managed + ", override files=" + JSON.stringify(data.overrideFiles)); show();
  await record({ kind: "inspect", label, managed, data });
  return data;
}
function frameOnce(label, attemptNo) {
  return new Promise((resolve) => {
    const frame = document.getElementById("ui");
    const timer = setTimeout(() => resolve({ error: "the frame did not load in 60 s" }), 60000);
    frame.onload = async () => {
      clearTimeout(timer);
      let result = null;
      for (let i = 0; i < 45; i++) {
        await wait(1000);
        try { result = await checkSharingPage(frame.contentDocument); } catch (e) { result = { error: String(e) }; }
        if (result && result.title && result.radios > 0) break;
      }
      if (!(result && result.title && result.radios > 0)) {
        try { result.text = (frame.contentDocument.body.innerText || "").slice(0, 300); } catch (e) { result.text = String(e); }
      }
      resolve(result);
    };
    frame.src = "/settings/sharing?s7=" + encodeURIComponent(label) + "&try=" + attemptNo;
  });
}
async function frameCheck(label) {
  let result = null;
  for (let i = 1; i <= 2; i++) {
    result = await frameOnce(label, i);
    if (result && result.title && result.radios > 0) break;
    log("interface not ready on try " + i + ": " + JSON.stringify(result));
  }
  summary.push(label + " interface: " + JSON.stringify(result)); show();
  await record({ kind: "ui", label, result });
  return result;
}
async function computer(label) {
  log("computer run " + label);
  await api("/__s7/api/computer-run?label=" + encodeURIComponent(label));
  const data = await pollJob("/__s7/api/computer-result?label=" + encodeURIComponent(label),
    (d) => d && (d.results || (d.job && d.job.label === label && d.job.state !== "running")), 12 * 60000);
  const res = data.results || data.job;
  summary.push(label + " computer variants: " + (res && res.passed !== undefined ? res.passed + "/" + res.total + " pass, final state " + JSON.stringify(res.finalState) + (res.error ? ", error " + res.error : "") : JSON.stringify(res).slice(0, 300))); show();
  if (res && res.rows) for (const r of res.rows.filter((r) => !r.pass)) log("computer FAIL " + JSON.stringify(r));
  await record({ kind: "computer", label, data });
  return res;
}
async function attempt(name, fn) {
  try { return await fn(); } catch (e) {
    summary.push("ERROR in " + name + ": " + String(e)); show();
    await record({ kind: "error", step: name, error: String(e) }).catch(() => {});
    return null;
  }
}
async function phase(label) {
  log("phase " + label);
  await attempt(label + " login", () => api("/__s7/api/login"));
  await attempt(label + " inspect", () => inspect(label + " before variants"));
  await attempt(label + " browser variants", () => runVariants(label));
  await attempt(label + " inspect", () => inspect(label + " after browser variants"));
  await attempt(label + " computer", () => computer(label));
  await attempt(label + " inspect", () => inspect(label + " after computer variants"));
  await attempt(label + " interface", () => frameCheck(label));
}
async function during() {
  log("replacing the server");
  await api("/__s7/api/replace");
  const rows = [];
  // Writes sent while the old container is gone and the new one is starting.
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    const res = await fetch("/v1/sharing", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"public_sharing": true}', credentials: "same-origin" });
    rows.push({ i, status: res.status, guard: res.headers.get("x-s7-guard"), ms: Math.round(performance.now() - t) });
    await wait(1500);
  }
  const passed = rows.filter((r) => r.status === 403 && r.guard === "refused").length;
  summary.push("during replacement: " + passed + "/" + rows.length + " PUTs refused"); show();
  await record({ kind: "during-replacement", rows, passed });
  const job = await pollJob("/__s7/api/job", serverJobDone, 10 * 60000);
  summary.push("replacement: " + JSON.stringify(job)); show();
  await record({ kind: "replacement", job });
}
document.getElementById("run").onclick = async () => {
  document.getElementById("run").disabled = true;
  try {
    log("starting the server");
    await api("/__s7/api/start");
    const job = await pollJob("/__s7/api/job", serverJobDone, 10 * 60000);
    summary.push("server start: " + JSON.stringify(job)); show();
    await phase("before-replacement");
    await attempt("replacement", () => during());
    await phase("after-replacement");
    summary.push("finished"); show();
    await record({ kind: "finished", summary });
  } catch (e) {
    summary.push("ERROR " + String(e)); show();
    await record({ kind: "error", error: String(e) }).catch(() => {});
  }
};
`;

export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>S7 managed settings</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 16px; max-width: 1100px; }
button { font-size: 1rem; padding: 0.5rem 1rem; }
pre { white-space: pre-wrap; font-size: 0.8rem; }
iframe { width: 100%; height: 700px; border: 1px solid #888; }
</style></head>
<body>
<h1>Spike S7: managed sharing settings</h1>
<p>Runs the S7 sequence once: browser variants, the computer run, the interface check, a server
replacement with requests during it, then all of it again. It takes about fifteen minutes. Leave
this tab open until the summary says <b>finished</b>.</p>
<button id="run">Run S7</button>
<h2>Summary</h2><pre id="summary">not started</pre>
<h2>Omnigent's sharing settings page</h2><iframe id="ui" title="Omnigent sharing settings"></iframe>
<h2>Log</h2><pre id="log"></pre>
<script>
const VARIANTS = __VARIANTS__;
${UI_CHECK_SOURCE}
${PAGE_SCRIPT}
</script></body></html>`;
