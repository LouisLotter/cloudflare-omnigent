// Opens Omnigent's sharing settings page in headless Chromium, logged in as the owner, and
// records what the interface shows: a screenshot and the state of every control.
//
//   node spikes/s7/scripts/ui-check.ts <label> <origin> [--try-put]
//   e.g. node spikes/s7/scripts/ui-check.ts browser-entry http://localhost:8787 --try-put
//
// --try-put also sends the PUT the interface would send, from the page, and records the reply.
// Use it only through the guard or against an authoritative server: directly against a standard
// server it is a real write.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UI_CHECK_SOURCE } from "../src/page.ts";
import { openBrowser } from "./cdp.ts";
import { login, RESULTS_DIR, RUN_DIR, sleep } from "./lib.ts";

async function main(): Promise<void> {
  const [label, origin] = process.argv.slice(2);
  if (!label || !origin) throw new Error("usage: ui-check.ts <label> <origin>");
  const creds = await login();
  const [cookieName = "", cookieValue = ""] = creds.cookie.split("=", 2);
  const browser = await openBrowser(join(RUN_DIR, "chrome-profile"));
  const { cdp } = browser;
  try {
    await cdp.send("Network.setCookie", { name: cookieName, value: cookieValue, url: origin });
    await cdp.send("Page.navigate", { url: `${origin}/settings/sharing` });
    let state: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      state = ((await cdp.evaluate(
        `(async () => { ${UI_CHECK_SOURCE}; return await checkSharingPage(document); })()`,
      )) ?? {}) as Record<string, unknown>;
      if (state.title && Number(state.radios) > 0) break;
    }
    await sleep(1000);
    // What the interface's own PUT would get back, and the message it would display.
    const put = !process.argv.includes("--try-put")
      ? "skipped"
      : await cdp.evaluate(`(async () => {
      const res = await fetch("/v1/sharing", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public_sharing: true }) });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, guard: res.headers.get("x-s7-guard"), message: body?.error?.message ?? null };
    })()`);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
      join(RESULTS_DIR, `ui-${label}.png`),
      Buffer.from(String(shot.data ?? ""), "base64"),
    );
    const out = {
      label,
      origin,
      checkedAt: new Date().toISOString(),
      page: state,
      putFromPage: put,
    };
    writeFileSync(join(RESULTS_DIR, `ui-${label}.json`), `${JSON.stringify(out, null, 2)}\n`);
    console.log(JSON.stringify(out));
  } finally {
    await browser.close();
  }
}

await main();
