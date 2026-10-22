// Campaign controls for the S3 staging page (spikes/README.md, "Campaign
// controls (IR-017)"). Pure request handling, testable without Workers:
// controls.test.js drives it with fake ports.
//
// - GET and HEAD never change anything: no container start, no bench, no write.
//   A GET to a control URL shows a confirmation page with buttons; GET
//   /results shows the campaign's stored progress.
// - A change is a POST with an Origin exactly equal to this deployment's origin
//   (Sec-Fetch-Site, when sent, must be "same-origin") and the request-intent
//   token from the page, compared in constant time.
// - POST /campaign arms an unattended campaign (campaign.js) for a bounded time
//   and starts it; POST /disarm stops it. The manual /probe and /bench run only
//   while armed by POST /arm, which disarms itself after ARM_MS, and never
//   while a campaign runs.

export const ARM_MS = 30 * 60 * 1000;
const PROFILES = ["small", "realistic", "large", "many-small"];
const METHODS = ["rsync", "rsync-2phase", "rsync-incremental", "reflink"];
const CAMPAIGN_PLANS = ["full", "quick"];
const CONTROL_PATHS = new Set(["/", "/arm", "/disarm", "/probe", "/bench", "/campaign"]);

export function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function campaignLine(view) {
  const c = view?.campaign;
  if (!c) return "No campaign yet.";
  const step = c.status === "running" ? `, step ${c.index + 1} of ${c.stepCount}: ${c.step}` : "";
  return `Campaign ${c.id} (${c.plan}): ${c.status}${step}.`;
}

export function confirmationPage(state, now, running, view) {
  const armed = state.armedUntil > now;
  const form = (action, label, extra = "") =>
    `<form method="post" action="${action}"><input type="hidden" name="intent" value="${escapeHtml(state.token)}">${extra}<button>${label}</button></form>`;
  const bench = `<select name="profile">${PROFILES.map((p) => `<option>${p}</option>`).join("")}</select>
<input name="runs" value="5" size="2"> <input name="methods" value="rsync-2phase,reflink">`;
  const body = `<!doctype html><meta charset="utf-8"><title>S3 capture bench</title>
<h1>S3 capture bench</h1>
<p>${escapeHtml(campaignLine(view))} Container: ${running ? "running" : "stopped"}. <a href="/results">Results</a></p>
<h2>Staging campaign</h2>
${form("/campaign", "Start the staging campaign (about 90 minutes, unattended)", '<input type="hidden" name="plan" value="full">')}
${form("/campaign", "Rehearse every step quickly (about 10 minutes)", '<input type="hidden" name="plan" value="quick">')}
${form("/disarm", "Stop the campaign and disarm")}
<h2>Manual controls</h2>
<p>Manual: ${armed ? `armed until ${new Date(state.armedUntil).toISOString()}` : "not armed"}.</p>
${form("/arm", "Arm the manual controls (30 minutes)")}
${form("/probe", "Run the environment probe")}
${form("/bench", "Start a capture bench", bench)}
<p>Results: GET /jobs/&lt;id&gt; while the container runs.</p>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function resultsPage(view) {
  const body = `<!doctype html><meta charset="utf-8"><title>S3 campaign results</title>
<h1>S3 campaign results</h1><p>${escapeHtml(campaignLine(view))} <a href="/">Controls</a></p>
<pre>${escapeHtml(JSON.stringify(view ?? {}, null, 1))}</pre>`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// Origin and request-intent checks, before any effect. Returns null when the
// request may proceed, or the refusal response.
export async function refuseUnlessIntended(request, state) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin === null || origin === "null" || origin !== url.origin) {
    return text(403, "refused: cross-origin or missing Origin");
  }
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin") return text(403, "refused: not same-origin");
  let token = request.headers.get("X-Intent");
  const type = request.headers.get("content-type") ?? "";
  if (token === null && type.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await request.clone().text());
    token = form.get("intent");
  }
  if (!sameToken(token, state.token))
    return text(403, "refused: missing or wrong request-intent token");
  return null;
}

function benchBody(form) {
  const profile = form.get("profile") ?? "realistic";
  const runs = Number(form.get("runs") ?? "5");
  const methods = (form.get("methods") ?? "rsync-2phase,reflink").split(",").map((m) => m.trim());
  if (!PROFILES.includes(profile)) return null;
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) return null;
  if (methods.length === 0 || !methods.every((m) => METHODS.includes(m))) return null;
  return { profile, plan: methods.map((method) => ({ method, runs })) };
}

// ports: {
//   now(),
//   container: { running(), start(), keepAlive(), fetch(path, init) },
//   campaign: { view(), start(plan) -> { ok, reason }, stop(reason) },
//   saveArm(armedUntil),
// }
// state: { token, armedUntil }; the token lives only in the Durable Object's memory.
export async function handle(request, state, ports) {
  const url = new URL(request.url);
  const path = url.pathname;
  const now = ports.now();

  if (request.method === "GET" || request.method === "HEAD") {
    if (CONTROL_PATHS.has(path) || path === "/results") {
      const view = await ports.campaign.view();
      const page =
        path === "/results"
          ? resultsPage(view)
          : confirmationPage(state, now, ports.container.running(), view);
      return request.method === "HEAD"
        ? new Response(null, { status: 200, headers: page.headers })
        : page;
    }
    if (path.startsWith("/jobs/") && /^\/jobs\/[0-9a-f]{1,32}$/.test(path)) {
      // Read-only: never starts the container.
      if (!ports.container.running()) return text(409, "the container is not running");
      return ports.container.fetch(path, { method: "GET" });
    }
    return text(404, "not found");
  }
  if (request.method !== "POST") return text(405, "method not allowed");

  const refusal = await refuseUnlessIntended(request, state);
  if (refusal) return refusal;

  if (path === "/arm") {
    state.armedUntil = now + ARM_MS;
    await ports.saveArm(state.armedUntil);
    return new Response(null, { status: 303, headers: { location: "/" } });
  }
  if (path === "/disarm") {
    state.armedUntil = 0;
    await ports.saveArm(0);
    await ports.campaign.stop("disarmed by the owner");
    return new Response(null, { status: 303, headers: { location: "/" } });
  }
  if (path === "/campaign") {
    const form = new URLSearchParams(await request.text());
    const plan = form.get("plan") ?? "full";
    if (!CAMPAIGN_PLANS.includes(plan)) return text(400, "unknown campaign plan");
    const started = await ports.campaign.start(plan);
    if (!started.ok) return text(409, `refused: ${started.reason}`);
    return new Response(null, { status: 303, headers: { location: "/results" } });
  }
  if (path !== "/probe" && path !== "/bench") return text(404, "not found");
  if (!(state.armedUntil > now)) return text(409, "the manual controls are not armed");
  if ((await ports.campaign.view())?.campaign?.status === "running") {
    return text(409, "a campaign is running");
  }

  let init = { method: "GET" };
  if (path === "/bench") {
    const form = new URLSearchParams(await request.text());
    const body = benchBody(form);
    if (body === null) return text(400, "invalid bench parameters");
    init = {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    };
  }
  if (!ports.container.running()) await ports.container.start();
  await ports.container.keepAlive();
  return ports.container.fetch(path, init);
}
