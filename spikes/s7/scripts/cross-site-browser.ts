// IR-017 in a real browser: headless Chromium attacks a local `wrangler dev` run of
// wrangler.staging.jsonc from another origin, then the check confirms that no container started.
//
//   node spikes/s7/scripts/cross-site-browser.ts http://127.0.0.1:8790
//
// 1. A page on another origin (a data: URL, so Origin is null) auto-submits a form POST to
//    each control route.
// 2. A page on another origin (http://localhost:<port>, a different origin from 127.0.0.1)
//    sends a no-cors fetch POST to each control route.
// 3. A top-level cross-site GET navigates to each control URL.
// Writes results/cross-site-browser.json.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBrowser } from "./cdp.ts";
import { RESULTS_DIR, RUN_DIR, sleep } from "./lib.ts";

const target = process.argv[2] ?? "http://127.0.0.1:8790";
const foreign = target.replace("127.0.0.1", "localhost");
const routes = ["/__s7/api/arm", "/__s7/api/start", "/__s7/api/replace", "/__s7/api/computer-run"];

function s7Containers(): string[] {
  return execFileSync(
    "docker",
    ["ps", "--filter", "name=cfo-stg-s7-managed", "--format", "{{.Names}}"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((n) => n && !n.endsWith("-proxy"));
}

const browser = await openBrowser(join(RUN_DIR, "chrome-cross-site"));
const { cdp } = browser;
const results: Record<string, unknown>[] = [];
const before = s7Containers();
try {
  for (const route of routes) {
    // 1. Cross-site form from an opaque origin.
    const form = `<form method="post" action="${target}${route}"><input name="x" value="1"></form><script>document.forms[0].submit()</script>`;
    await cdp.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(form)}` });
    await sleep(1500);
    results.push({
      attack: "cross-site form from data: URL",
      route,
      page: String(await cdp.evaluate("document.body.innerText")).slice(0, 120),
    });

    // 2. Cross-site fetch from a page on another origin.
    await cdp.send("Page.navigate", { url: `${foreign}/__s7/api/records` });
    await sleep(800);
    const fetched = await cdp.evaluate(
      `fetch(${JSON.stringify(target + route)}, { method: "POST", mode: "no-cors", credentials: "include", body: "x=1" }).then(r => r.type + " " + r.status).catch(e => String(e))`,
    );
    results.push({ attack: `no-cors fetch from ${foreign}`, route, result: fetched });

    // 3. Top-level cross-site GET.
    await cdp.send("Page.navigate", { url: `${target}${route}` });
    await sleep(1200);
    results.push({
      attack: "top-level GET",
      route,
      page: String(await cdp.evaluate("document.body.innerText")).slice(0, 120),
    });
  }
} finally {
  await browser.close();
}
const after = s7Containers();
const out = { target, foreign, checkedAt: new Date().toISOString(), before, after, results };
writeFileSync(join(RESULTS_DIR, "cross-site-browser.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
