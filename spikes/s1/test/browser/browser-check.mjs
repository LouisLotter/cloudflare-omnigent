// Real-browser check of the S1 campaign controls (IR-017), against `wrangler dev` with the Worker
// only. Headless Chromium, driven over the DevTools protocol:
//   1. a cross-site page (http://localhost:<attacker port>) auto-submits a form to Start: refused;
//   2. the owner's flow: open /s1/kickoff, click Start: accepted, with the browser's own Origin;
//   3. the cross-site form again: refused, and the last action is still the owner's Start.
// The headers Chromium actually sent are recorded.
//
//   node spikes/s1/test/browser/browser-check.mjs [chromium path] > spikes/s1/results/browser-check.json

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", "..");
const CHROMIUM = process.argv[2] ?? "/usr/bin/chromium";
const WORKER_PORT = 18712;
const ATTACKER_PORT = 18713;
const DEBUG_PORT = 18714;
const ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;
const ATTACKER = `http://localhost:${ATTACKER_PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const temp = mkdtempSync(join(tmpdir(), "s1-browser-"));

async function waitFor(url, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return response;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// 1. The Worker under wrangler dev, from the worker package's pinned Wrangler.
const wranglerCli = join(
  dirname(createRequire(join(ROOT, "worker", "package.json")).resolve("wrangler/package.json")),
  "wrangler-dist",
  "cli.js",
);
const wrangler = spawn(
  process.execPath,
  [
    wranglerCli,
    "dev",
    "--config",
    join(HERE, "wrangler.browser.jsonc"),
    "--ip",
    "127.0.0.1",
    "--port",
    String(WORKER_PORT),
    "--persist-to",
    join(temp, "state"),
    "--show-interactive-dev-session=false",
  ],
  { stdio: ["ignore", "pipe", "pipe"], cwd: join(ROOT, "worker") },
);
children.push(wrangler);
let wranglerLog = "";
wrangler.stdout.on("data", (d) => (wranglerLog += d));
wrangler.stderr.on("data", (d) => (wranglerLog += d));

// 2. The attacker's page, on another site: a form that posts to Start as soon as it loads.
const attacker = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><form id="f" method="post" action="${ORIGIN}/s1/kickoff">` +
      `<input type="hidden" name="intent" value="${"0".repeat(64)}"></form>` +
      `<script>document.getElementById("f").submit()</script>`,
  );
}).listen(ATTACKER_PORT, "127.0.0.1");

// 3. Headless Chromium with the DevTools protocol.
const chromium = spawn(
  CHROMIUM,
  [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(temp, "profile")}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);
children.push(chromium);

const results = { chromium: null, steps: [] };
try {
  await waitFor(`${ORIGIN}/s1/kickoff`);
  const version = await (await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  results.chromium = version.Browser;
  const pages = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = pages.find((p) => p.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r) => {
      const n = ++id;
      pending.set(n, r);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Page.enable");
  await send("Network.enable");
  await send("Runtime.enable");

  // Requests to the Worker's control path: what Chromium sent, and what came back.
  let posts = [];
  listeners.push((msg) => {
    if (msg.method === "Network.requestWillBeSentExtraInfo") {
      const h = Object.fromEntries(
        Object.entries(msg.params.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      if (h[":method"] === "POST" || h.origin !== undefined) {
        posts.push({ requestId: msg.params.requestId, headers: h });
      }
    }
    if (msg.method === "Network.responseReceived" && msg.params.response.url.includes("/s1/")) {
      const post = posts.find((p) => p.requestId === msg.params.requestId);
      if (post) post.status = msg.params.response.status;
    }
  });
  const loaded = () =>
    new Promise((r) => {
      const l = (msg) => {
        if (msg.method === "Page.loadEventFired") {
          listeners.splice(listeners.indexOf(l), 1);
          r();
        }
      };
      listeners.push(l);
    });
  const bodyText = async () =>
    (await send("Runtime.evaluate", { expression: "document.body.innerText" })).result.result.value;
  const step = async (name, action) => {
    posts = [];
    await action();
    await sleep(1500);
    const text = await bodyText();
    const sent = posts.map((p) => ({
      status: p.status ?? null,
      origin: p.headers.origin ?? null,
      secFetchSite: p.headers["sec-fetch-site"] ?? null,
      referer: p.headers.referer ?? null,
    }));
    results.steps.push({ name, posts: sent, page: text.trim().slice(0, 300) });
  };
  const navigate = async (url) => {
    const done = loaded();
    await send("Page.navigate", { url });
    await done;
  };

  await step("cross-site form posts to Start (before the owner's Start)", () =>
    navigate(`${ATTACKER}/`),
  );
  await step("owner opens /s1/kickoff", () => navigate(`${ORIGIN}/s1/kickoff`));
  await step("owner clicks Start", async () => {
    const done = loaded();
    await send("Runtime.evaluate", { expression: "document.querySelector('button').click()" });
    await done;
  });
  await step("cross-site form posts to Start (after)", () => navigate(`${ATTACKER}/`));
  await step("owner reopens /s1/kickoff", () => navigate(`${ORIGIN}/s1/kickoff`));
  ws.close();

  const [before, open, start, after, reopen] = results.steps;
  results.checks = {
    crossSiteBeforeRefused:
      before.posts.length === 1 && before.posts[0].status === 403 && /refused/.test(before.page),
    pageShowsNoActionYet: /No control has been used yet/.test(open.page),
    ownerStartAccepted:
      start.posts.length === 1 &&
      start.posts[0].status === 200 &&
      start.posts[0].origin === ORIGIN &&
      /S1 campaign started/.test(start.page),
    crossSiteAfterRefused:
      after.posts.length === 1 && after.posts[0].status === 403 && /refused/.test(after.page),
    lastActionIsOwnersStart: /Last action: start at/.test(reopen.page),
  };
  results.ok = Object.values(results.checks).every(Boolean);
} catch (error) {
  results.error = String(error);
  results.wranglerLog = wranglerLog.slice(-2000);
  results.ok = false;
} finally {
  for (const child of children) child.kill("SIGTERM");
  attacker.close();
  await sleep(1000);
  rmSync(temp, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.ok ? 0 : 1);
