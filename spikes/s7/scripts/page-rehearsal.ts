// Rehearses the owner's staging page locally: opens /__s7/ of a `wrangler dev` run of
// wrangler.staging.jsonc in headless Chromium, clicks "Run S7" and waits for the summary.
//
//   node spikes/s7/scripts/page-rehearsal.ts http://127.0.0.1:8790 <label>

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openBrowser } from "./cdp.ts";
import { RESULTS_DIR, RUN_DIR, sleep } from "./lib.ts";

const [origin = "http://127.0.0.1:8790", label = "rehearsal"] = process.argv.slice(2);
const browser = await openBrowser(join(RUN_DIR, "chrome-rehearsal"));
const { cdp } = browser;
try {
  await cdp.send("Page.navigate", { url: `${origin}/__s7/` });
  await sleep(2000);
  await cdp.evaluate(`document.getElementById("run").click()`);
  let summary = "";
  for (let i = 0; i < 900; i++) {
    await sleep(2000);
    summary = String(await cdp.evaluate(`document.getElementById("summary").textContent`));
    const lines = summary.split("\n");
    if (lines.includes("finished") || lines.some((l) => l.startsWith("ERROR "))) break;
  }
  const logText = String(await cdp.evaluate(`document.getElementById("log").textContent`));
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
  });
  writeFileSync(
    join(RESULTS_DIR, `page-${label}.png`),
    Buffer.from(String(shot.data ?? ""), "base64"),
  );
  writeFileSync(join(RESULTS_DIR, `page-${label}.txt`), `${summary}\n\n--- log ---\n${logText}\n`);
  console.log(summary);
} finally {
  await browser.close();
}
