// Experiment X1, the UI Worker: the owner's Preflight, Start run and Stop controls and a read-only
// status page, behind owner-only Access. It reaches RunDO in cfo-stg-x1-transport through a
// cross-script Durable Object binding. Its own deploy at S+45 min measures AR-17: nothing on any
// route passes through this Worker.
//
// Campaign controls (IR-017, spikes/README.md). Being through Access is not permission to act: a
// GET or HEAD only shows a confirmation page or the status, and a change is a same-origin POST
// that carries the page's request-intent token, held by RunDO.
import { BUILD } from "./build.js";

export const UI_LABEL = "cfo-stg-x1-ui";
const CONTROLS = { "/x1/preflight": "preflight", "/x1/start": "start", "/x1/stop": "stop" };
const MAX_FORM_BYTES = 4096;
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};
const PAGE_TEXT = {
  preflight:
    "Starts the preflight: both containers, all six routes, one forced ServerDO reset at 5 minutes and the block-list check. About 10 minutes, then both containers stop.",
  start:
    "Starts the run. This moment is T0: 5 minutes of warm-up, then the 120-minute soak with forced resets at 30, 60 and 90 minutes. The laptop's campaign script deploys this UI at 45 minutes and the transport at 75 minutes. Both containers stop at the end.",
  stop: "Stops the run or preflight now: the schedule, both containers and their keep-alive alarms. Teardown is still done with the staging tool.",
};

function log(event, fields = {}) {
  console.log(
    JSON.stringify({ x1: event, worker: "ui", build: BUILD.id, t: Date.now(), ...fields }),
  );
}

function runStub(env) {
  return env.RUN.get(env.RUN.idFromName("run"));
}

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function confirmationPage(action, intent) {
  const label = { preflight: "Start preflight", start: "Start run", stop: "Stop" }[action];
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>X1 ${action}</title></head>
<body>
<h1>Experiment X1: ${action}</h1>
<p>${PAGE_TEXT[action]}</p>
<form method="post" action="/x1/${action}"><input type="hidden" name="intent" value="${escapeHtml(intent)}"><button type="submit">${label}</button></form>
<p>Build ${escapeHtml(BUILD.id)}. The button works once, within 10 minutes; reload the page if it is refused.</p>
</body>
</html>
`;
  return new Response(html, { headers: PAGE_HEADERS });
}

function statusPage(status) {
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>X1 status</title></head>
<body>
<h1>Experiment X1</h1>
<p><a href="/x1/preflight">Preflight</a> · <a href="/x1/start">Start run</a> · <a href="/x1/stop">Stop</a></p>
<pre>${escapeHtml(JSON.stringify(status, null, 2))}</pre>
<p>UI build ${escapeHtml(BUILD.id)}.</p>
</body>
</html>
`;
  return new Response(html, { headers: PAGE_HEADERS });
}

/** Why a control POST is refused before anything else happens, or null when it may proceed. */
export function originRefusal(request, url) {
  const origin = request.headers.get("origin");
  if (origin === null) return "missing_origin";
  if (origin !== url.origin) return "bad_origin"; // includes "null"
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "cross_site";
  return null;
}

async function presentedIntent(request) {
  const header = request.headers.get("x-x1-intent");
  if (header) return header;
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return "";
  if (Number(request.headers.get("content-length") ?? 0) > MAX_FORM_BYTES) return "";
  const text = await request.text();
  if (text.length > MAX_FORM_BYTES) return "";
  return new URLSearchParams(text).get("intent") ?? "";
}

/** The zone this UI is served under, passed to RunDO for P4's and P5's hostnames. */
function zoneOf(hostname) {
  const prefix = `${UI_LABEL}.`;
  if (!hostname.startsWith(prefix)) return null;
  const zone = hostname.slice(prefix.length);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone) ? zone : null;
}

async function control(request, env, url, action) {
  if (request.method === "GET" || request.method === "HEAD") {
    return confirmationPage(action, await runStub(env).intentToken(action));
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }
  const refusal = originRefusal(request, url);
  if (refusal) {
    log("control-refused", { action, reason: refusal });
    return Response.json({ error: refusal }, { status: 403 });
  }
  const result = await runStub(env).control(action, await presentedIntent(request), {
    zone: zoneOf(url.hostname),
  });
  if (!result.ok) {
    log("control-refused", { action, reason: "bad_intent" });
    return Response.json({ error: "bad_intent" }, { status: 403 });
  }
  const { ok: _, ...rest } = result;
  log("control", { action, started: rest.started, runId: rest.runId });
  const conflict = rest.started === false;
  return Response.json({ build: BUILD.id, action, ...rest }, { status: conflict ? 409 : 200 });
}

/** The public entry, behind owner-only Access. Only the owner can start or stop X1. */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const action = CONTROLS[url.pathname];
    if (action) return control(request, env, url, action);
    if (
      (url.pathname === "/" || url.pathname === "/x1/status") &&
      ["GET", "HEAD"].includes(request.method)
    ) {
      const status = await runStub(env).status();
      return url.pathname === "/" ? statusPage(status) : Response.json(status);
    }
    return new Response("not found", { status: 404 });
  },
};
