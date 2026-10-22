// The owner's page: the run's status, the R2 token form and the two buttons. Opening it
// changes nothing; the buttons send same-origin POSTs with the embedded intent token.

import { INTENT_HEADER } from "./controls.ts";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(intent: string): string {
  const token = JSON.stringify(intent);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WP2.5 data drill</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 16px; max-width: 46rem; }
label { display: block; margin-top: 0.75rem; }
input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.3rem; }
button { margin-top: 1rem; margin-right: 0.5rem; font: inherit; padding: 0.4rem 1rem; }
pre { white-space: pre-wrap; word-break: break-word; }
</style></head><body>
<h1>WP2.5 data drill</h1>
<p>Measures the Omnigent server image against this deployment's R2 bucket from one
<code>basic</code> container, for about an hour, then stops itself. Paste the R2 API token you
created for this bucket only (Object Read &amp; Write), then press <b>Run</b>. The values go
to this deployment's Durable Object and its container, nowhere else, and are deleted when the
run ends.</p>
<form id="run" autocomplete="off">
<label>S3 endpoint <input name="endpoint" placeholder="https://&lt;account id&gt;.r2.cloudflarestorage.com" required></label>
<label>Access Key ID <input name="accessKeyId" required spellcheck="false"></label>
<label>Secret Access Key <input name="secretAccessKey" type="password" required></label>
<button type="submit">Run</button><button type="button" id="stop">Stop</button>
</form>
<h2>Status</h2>
<pre id="status">loading…</pre>
<pre id="out"></pre>
<script>
const intent = ${token};
const out = document.getElementById("out");
async function post(path, body) {
  const res = await fetch(path, { method: "POST", credentials: "same-origin",
    headers: { "content-type": "application/json", "${escapeHtml(INTENT_HEADER)}": intent },
    body: JSON.stringify(body) });
  out.textContent = res.status + " " + await res.text();
}
document.getElementById("run").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const body = { endpoint: form.get("endpoint"), accessKeyId: form.get("accessKeyId"),
    secretAccessKey: form.get("secretAccessKey") };
  event.target.reset();
  await post("/api/run", body);
  refresh();
};
document.getElementById("stop").onclick = async () => {
  if (confirm("Stop the run and delete the token from the Durable Object?")) await post("/api/stop", {});
  refresh();
};
async function refresh() {
  const res = await fetch("/api/status", { credentials: "same-origin" });
  document.getElementById("status").textContent = JSON.stringify(await res.json(), null, 2);
}
refresh();
setInterval(refresh, 15000);
</script></body></html>`;
}
