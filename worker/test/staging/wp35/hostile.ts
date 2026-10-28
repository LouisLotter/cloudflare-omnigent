// WP3.5 staging (the G3 sitting; RC-07's platform-page part, P2's synthetic negatives): a page on
// a foreign origin that the owner opens in the browser signed in to the installation's Access. It
// frames the computer's setup page, sends a change to a control URL, tries WP3.23's routes (start
// a sign-in, send a code, cancel, turn the staging RC-53 switch, read an attempt and the status
// across origins), and opens the terminal's WebSocket with a made-up capability, then records what
// it saw. Nothing it sends can change
// anything: each attempt must be refused (by Access, whose cookie is SameSite=Lax, or by the
// platform's own origin checks). The owner also confirms by eye that the frame shows an error.
//
//   node worker/test/staging/wp35/hostile.ts <hostname> <computer-id> [results.json]
//
// Serves http://127.0.0.1:8088/ only on the loopback interface. Writes the page's observations to
// the results file (default ~/.pt/wp35-staging/hostile.json): no cookie, token or account data.

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const [hostname, computerId, out = join(homedir(), ".pt", "wp35-staging", "hostile.json")] =
  process.argv.slice(2);
if (
  !hostname ||
  !/^[a-z0-9.-]+$/.test(hostname) ||
  !computerId ||
  !/^cmp_[0-9a-z]{26}$/.test(computerId)
) {
  console.error("usage: hostile.ts <hostname> <computer-id> [results.json]");
  process.exit(2);
}
const base = `https://${hostname}`;
const page = `<!doctype html><meta charset="utf-8"><title>WP3.5 hostile origin</title>
<h1>WP3.5: a foreign origin</h1>
<p>The frame below must show an error, not the setup page. Do not press anything on this page.</p>
<iframe src="${base}/platform/computers/${computerId}" width="640" height="240"></iframe>
<pre id="out">running…</pre>
<script>
(async () => {
  const report = { at: new Date().toISOString() };
  try {
    const body = new URLSearchParams({ op: "op_00000000000000000000000001", intent: "${"0".repeat(64)}" });
    await fetch("${base}/platform/computers/${computerId}/do/restart", { method: "POST", mode: "no-cors", body, credentials: "include" });
    report.post = "sent (opaque answer)";
  } catch (e) { report.post = "refused by the browser or network"; }
  // WP3.23's changes: each must be refused before any effect (no attempt may start).
  const json = (o) => JSON.stringify({ op: "op_00000000000000000000000001", intent: "${"0".repeat(64)}", ...o });
  for (const [name, path, body] of [
    ["signInStart", "sign-in", { mode: "start", service: "claude" }],
    ["signInInput", "sign-in", { mode: "input", service: "claude", attempt: "1", code: "synthetic-code#synthetic" }],
    ["signInCancel", "sign-in", { mode: "cancel", service: "codex", attempt: "1" }],
    ["stagingCheck", "staging-check", { rc53: "off" }],
  ]) {
    try {
      await fetch("${base}/platform/computers/${computerId}/" + path, { method: "POST", mode: "no-cors", body: json(body), credentials: "include" });
      report[name] = "sent (opaque answer)";
    } catch (e) { report[name] = "refused by the browser or network"; }
  }
  // Reads across origins: the browser must not let this page see them.
  for (const [name, path] of [["signInRead", "sign-in?service=claude&attempt=1"], ["statusRead", "status"]]) {
    try {
      const r = await fetch("${base}/platform/computers/${computerId}/" + path, { credentials: "include" });
      report[name] = "READABLE (failure): " + r.status;
    } catch (e) { report[name] = "unreadable"; }
  }
  report.socket = await new Promise((resolve) => {
    const ws = new WebSocket("wss://${hostname}/platform/computers/${computerId}/terminal", ["tty", "cfo-capability.${"A".repeat(43)}"]);
    ws.onopen = () => { ws.close(); resolve("OPENED (failure)"); };
    ws.onerror = () => resolve("refused");
    setTimeout(() => resolve("no answer in 10 s"), 10000);
  });
  document.getElementById("out").textContent = JSON.stringify(report, null, 2) + "\\n\\ndone";
  await fetch("/report", { method: "POST", body: JSON.stringify(report) });
})();
</script>`;

const server = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      if (body.length < 4096) body += chunk.toString("utf8");
    });
    req.on("end", () => {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${body}\n`, { mode: 0o600 });
      console.log(`recorded: ${body}`);
      res.writeHead(204);
      res.end();
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
});
server.listen(8088, "127.0.0.1", () =>
  console.log("open http://127.0.0.1:8088/ in the owner's browser"),
);
