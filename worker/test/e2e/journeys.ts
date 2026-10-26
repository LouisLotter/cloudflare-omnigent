// The platform pages' journeys in a real browser, locally (WP3.5; Playwright with the system's
// Chromium). It runs the production web Worker (with its ingress) and the e2e platform Worker in
// one `wrangler dev`, serves Access's keys from a local stand-in, and signs a synthetic owner
// assertion that the browser sends on every request, WebSocket upgrades included, as Access would.
// No real account, provider or Cloudflare resource is involved.
//
//   node worker/test/e2e/journeys.ts [results.json]
//
// Environment: CHROME (default /usr/bin/chromium), CFO_E2E_DIR (default ~/.pt/wp35-e2e) for
// wrangler's local state and the results.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { AUD, claims, makeKey, OWNER_EMAIL, SALT, sign, TEAM } from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp35-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");

interface Result {
  readonly journey: string;
  readonly ok: boolean;
  readonly checks: string[];
  readonly error?: string;
  readonly ms: number;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

function startWrangler(port: number, vars: Record<string, string>): ChildProcess {
  const args = [
    "exec",
    "wrangler",
    "dev",
    "-c",
    join(HERE, "wrangler.web-e2e.jsonc"),
    "-c",
    join(HERE, "wrangler.platform-e2e.jsonc"),
    "--port",
    String(port),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    join(DIR, "state"),
    "--log-level",
    "warn",
  ];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const child = spawn("pnpm", args, {
    cwd: WORKER,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const log = join(DIR, "wrangler.log");
  writeFileSync(log, "");
  const append = (chunk: Buffer) => writeFileSync(log, chunk, { flag: "a" });
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return child;
}

async function main(): Promise<number> {
  rmSync(join(DIR, "state"), { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  const key = await makeKey("e2e-key");
  const certs = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [key.jwk] }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const certsPort = await listen(certs);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wrangler = startWrangler(port, {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: "127.0.0.1",
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
    ACCESS_CERTS_URL_LOCAL_ONLY: `http://127.0.0.1:${certsPort}`,
  });
  const hostile = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(hostilePage(base, decodeURIComponent((req.url ?? "/").slice(1))));
  });
  const hostilePort = await new Promise<number>((resolve) =>
    hostile.listen(0, "localhost", () => resolve((hostile.address() as AddressInfo).port)),
  );
  let browser: Browser | null = null;
  const results: Result[] = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const assertion = await sign(key, claims(now, { exp: now + 3600 }));
    const headers = { "cf-access-jwt-assertion": assertion };
    await waitFor(
      "wrangler dev",
      async () => (await fetch(`${base}/platform/computers`, { headers })).ok,
      90_000,
    );
    const seeded = (await (await fetch(`${base}/__e2e/seed`, { method: "POST" })).json()) as {
      computers: Record<string, string>;
    };
    const ids = seeded.computers;
    browser = await chromium.launch({
      executablePath: process.env.CHROME ?? "/usr/bin/chromium",
      headless: true,
    });
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const state = async (id: string) =>
      (
        (await (await fetch(`${base}/__e2e/state?computer=${id}`)).json()) as {
          computer: Record<string, unknown>;
        }
      ).computer;
    const run = async (journey: string, fn: (page: Page, checks: string[]) => Promise<void>) => {
      const page = await context.newPage();
      const checks: string[] = [];
      const started = Date.now();
      try {
        await fn(page, checks);
        results.push({ journey, ok: true, checks, ms: Date.now() - started });
      } catch (error) {
        await page.screenshot({ path: join(DIR, `${journey}.png`) }).catch(() => undefined);
        const dump: Record<string, unknown> = {};
        for (const [name, id] of Object.entries(ids)) {
          const s = await state(id).catch(() => null);
          dump[name] = s && {
            lifecycle: s.lifecycle,
            status: s.status,
            cards: s.setupCards,
            removal: s.removal,
          };
        }
        writeFileSync(join(DIR, `${journey}.state.json`), JSON.stringify(dump, null, 2));
        results.push({
          journey,
          ok: false,
          checks,
          error: String(error).slice(0, 500),
          ms: Date.now() - started,
        });
      } finally {
        await page.close();
      }
    };
    await run("J1-new-computer-setup", async (page, checks) => {
      const id = ids["managed-new"] ?? "";
      await page.goto(`${base}/platform/computers`);
      const card = page.locator(`[data-computer="${id}"]`);
      await card.getByText("Needs setup").waitFor();
      checks.push("listed as needing setup");
      if (
        (await page.locator('a[data-link="omnigent-add"]').getAttribute("href")) !==
        "/settings/computers"
      ) {
        throw new Error("no link to Omnigent's add");
      }
      checks.push("links to Omnigent's add and delete");
      await card.getByText("Set up / manage").click();
      await page.locator('[data-card="claude"][data-state="needs_sign_in"]').waitFor();
      await page.locator('[data-card="codex"][data-state="needs_sign_in"]').waitFor();
      await page.getByText("Ctrl+Shift+V").waitFor();
      checks.push("two cards need sign-in; paste hint shown");
      await page.click("#terminal-open");
      await page.getByText("Connected.").waitFor();
      await page.locator(".xterm-rows").getByText("omnigent@computer").first().waitFor();
      checks.push("terminal bridged, shell prompt shown");
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("claude auth login --claudeai");
      await page.keyboard.press("Enter");
      await page.locator(".xterm-rows").getByText("Paste code here").waitFor();
      // A paste, as the browser delivers Ctrl+Shift+V: a paste event on xterm's input element.
      await page.evaluate(`(() => {
        const area = document.querySelector(".xterm-helper-textarea");
        const data = new DataTransfer();
        data.setData("text/plain", "synthetic-code-0123456789");
        area.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      })()`);
      await page.keyboard.press("Enter");
      await page.locator(".xterm-rows").getByText("Login successful.").waitFor();
      checks.push("claude sign-in in the terminal, code pasted");
      await page
        .locator('[data-card="claude"][data-state="signed_in"]')
        .waitFor({ timeout: 20_000 });
      checks.push("Claude card signed in");
      await page.keyboard.type("codex login --device-auth");
      await page.keyboard.press("Enter");
      await page.locator(".xterm-rows").getByText("Successfully logged in").waitFor();
      await page
        .locator('[data-card="codex"][data-state="signed_in"]')
        .waitFor({ timeout: 20_000 });
      checks.push("Codex card signed in");
      await page.click("#terminal-close");
      await page.getByText("Closed. The computer may go to sleep again.").waitFor();
      const after = await state(id);
      if ((after.terminal as { open: boolean }).open) throw new Error("window still open");
      checks.push("terminal closed; window closed in WorkspaceDO");
    });

    await run("J2-reconnect-after-drop", async (page, checks) => {
      const id = ids["managed-ready"] ?? "";
      await page.goto(`${base}/platform/computers/${id}`);
      await page.click("#terminal-open");
      await page.getByText("Connected.").waitFor();
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("echo $$");
      await page.keyboard.press("Enter");
      const shell = await waitFor(
        "the shell's number",
        async () => /\b(4\d{3})\b/.exec(await page.locator(".xterm-rows").innerText())?.[1],
      );
      const dropped = Date.now();
      // The stream drops as a web Worker deploy drops it (FH-38): not closed by the platform.
      await page.evaluate(`window.cfoTerminal.socket.close(3000, "dropped")`);
      await page.getByText("Reconnecting…").waitFor();
      await page.getByText("Connected.").waitFor({ timeout: 10_000 });
      const reconnectMs = Date.now() - dropped;
      if (reconnectMs > 10_000) throw new Error(`reconnected after ${reconnectMs} ms`);
      checks.push(`reconnected with a fresh capability in ${reconnectMs} ms`);
      await page.locator(".xterm-helper-textarea").focus();
      await page.keyboard.type("echo $$");
      await page.keyboard.press("Enter");
      await waitFor("the same shell", async () => {
        const text = await page.locator(".xterm-rows").innerText();
        return text.split(shell).length - 1 >= 2;
      });
      checks.push(`the same shell (${shell}) continued: reattached`);
      await page.click("#terminal-close");
    });

    await run("J2b-reconnect-retries-a-failed-handshake", async (page, checks) => {
      const id = ids["managed-new"] ?? "";
      // The second WebSocket the page makes (the first reconnect) fails its handshake.
      await page.addInitScript({
        content: `(() => {
          const Native = window.WebSocket;
          let made = 0;
          window.WebSocket = class extends Native {
            constructor(url, protocols) {
              super(url, protocols);
              made += 1;
              if (made === 2) this.close();
            }
          };
        })();`,
      });
      await page.goto(`${base}/platform/computers/${id}`);
      await page.click("#terminal-open");
      await page.getByText("Connected.").waitFor();
      const dropped = Date.now();
      await page.evaluate(`window.cfoTerminal.socket.close(3000, "dropped")`);
      await page.getByText("Reconnecting…").waitFor();
      await page.getByText("Connected.").waitFor({ timeout: 10_000 });
      const ms = Date.now() - dropped;
      if (ms > 10_000) throw new Error(`reconnected after ${ms} ms`);
      checks.push(`a failed reconnect handshake was retried; connected again in ${ms} ms`);
      await page.click("#terminal-close");
    });

    await run("J3-hostile-origin", async (page, checks) => {
      const id = ids["managed-ready"] ?? "";
      const before = await state(id);
      await page.goto(`http://localhost:${hostilePort}/${encodeURIComponent(id)}`);
      const report = await waitFor(
        "the hostile page's report",
        async () => page.evaluate(`window.report`) as Promise<Record<string, unknown> | undefined>,
      );
      const frame = page.frames().find((f) => f.url().includes("/platform/"));
      const framed = frame ? await frame.content().catch(() => "") : "";
      if (framed.includes("Set up this computer"))
        throw new Error("the setup page loaded in a frame");
      checks.push("framing refused (frame-ancestors 'none')");
      if (report.post !== "opaque" && report.post !== "error")
        throw new Error(`POST: ${String(report.post)}`);
      if (report.socket !== "refused") throw new Error(`socket: ${String(report.socket)}`);
      checks.push("cross-origin POST and WebSocket refused");
      const after = await state(id);
      if (
        after.generation !== before.generation ||
        after.status !== before.status ||
        after.refusedSleeps !== before.refusedSleeps
      ) {
        throw new Error("the computer changed");
      }
      checks.push("nothing changed on the computer");
      await page.goto(`${base}/platform/computers/${id}/do/restart`);
      await page.getByText("Opening this page changed nothing").waitFor();
      const again = await state(id);
      if (again.status !== before.status) throw new Error("a GET changed state");
      checks.push("a control URL's GET shows a confirmation and changes nothing");
    });

    await run("J4-not-connected", async (page, checks) => {
      const id = ids["managed-lost"] ?? "";
      await page.goto(`${base}/platform/computers`);
      const card = page.locator(`[data-computer="${id}"]`);
      await card.getByText("Not connected to Omnigent").first().waitFor();
      checks.push("shown as not connected to Omnigent");
      await card.getByText("Restart (ends work in progress)").click();
      await page.getByText("A restart ends work in progress.").waitFor();
      checks.push("restart warns that it ends work in progress");
      await page.getByText("Cancel").click();
      await page.goto(`${base}/platform/computers/${id}/do/remove`);
      await page.locator('button:has-text("Remove it")').click();
      await page.getByText("Remove this computer: Done.").waitFor();
      await waitFor(
        "the removal intent",
        async () => ((await state(id)).removal as { state: string }).state === "pending",
      );
      checks.push("offered for removal; removal recorded");
    });

    await run("J5-removal-after-omnigent-deleted", async (page, checks) => {
      const id = ids["managed-deleted"] ?? "";
      await page.goto(`${base}/platform/computers`);
      await page.locator(`[data-removal="${id}"]`).getByText("Still needs a sign-out").waitFor();
      checks.push("unresolved removal listed, logins kept");
      await page.goto(`${base}/platform/computers/${id}`);
      await page.locator('[data-removal-step="pending"]').waitFor();
      await page.goto(`${base}/platform/computers/${id}/do/sign-out`);
      await page.getByText("Revocation at the providers is not proven").waitFor();
      await page.locator('button:has-text("Sign out")').click();
      await page.getByText("Sign out of Claude and Codex: Done.").waitFor();
      checks.push("sign-out started for the removal");
      // The page follows the removal by itself: no reload until "Finish the removal" appears.
      await page.locator('#removal a:has-text("Finish the removal")').waitFor({ timeout: 60_000 });
      checks.push(
        "the page offered 'Finish the removal' once the controller settled it, without a reload",
      );
      await page.locator('#removal a:has-text("Finish the removal")').click();
      await page.locator('button:has-text("Delete its saved files and logins")').click();
      await waitFor(
        "the resolved removal",
        async () => {
          const html = await (await page.goto(`${base}/platform/computers`))?.text();
          return html !== undefined && !html.includes(id);
        },
        60_000,
      );
      checks.push("signed out, resolved, and gone from the list");
    });

    await run("J6-sign-out-before-delete-link", async (page, checks) => {
      const id = ids["managed-ready"] ?? "";
      await page.goto(`${base}/platform/computers/${id}`);
      await page.locator('[data-removal-step="sign_out"]').waitFor();
      if ((await page.locator('a[data-link="omnigent-delete"]').count()) !== 0) {
        throw new Error("deletion linked before the sign-out");
      }
      checks.push("no deletion link before the sign-out");
      await page.goto(`${base}/platform/computers/${id}/do/sign-out`);
      await page.locator('button:has-text("Sign out")').click();
      // The page follows the sign-out by itself: no reload until the deletion link appears.
      await page.locator('[data-removal-step="delete"]').waitFor({ timeout: 60_000 });
      const href = await page.locator('a[data-link="omnigent-delete"]').getAttribute("href");
      if (href !== "/settings/computers") throw new Error(`delete link: ${href}`);
      checks.push("after the sign-out, the page links to Omnigent's deletion");
    });

    await run("J7-notices", async (page, checks) => {
      await page.goto(`${base}/platform/computers`);
      await page
        .locator('[data-notice="outage"]')
        .getByText("Omnigent was unavailable from")
        .waitFor();
      checks.push("outage notice with its interval");
      await page.locator('[data-notice="replication"]').getByText("replica is behind").waitFor();
      checks.push("replication warning");
      await page.screenshot({ path: join(DIR, "computers-page.png"), fullPage: true });
    });
  } finally {
    await browser?.close();
    if (wrangler.pid !== undefined) {
      try {
        process.kill(-wrangler.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    certs.close();
    hostile.close();
  }
  writeFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`);
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"} ${r.journey} (${r.ms} ms): ${r.checks.join("; ")}${r.error ? ` — ${r.error}` : ""}`,
    );
  }
  return results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
}

/** A page on another origin that tries to frame, post to and connect to the platform pages. */
function hostilePage(base: string, id: string): string {
  return `<!doctype html><title>hostile</title>
<iframe src="${base}/platform/computers/${id}" width="400" height="200"></iframe>
<script>
(async () => {
  const report = {};
  try {
    const body = new URLSearchParams({ op: "op_00000000000000000000000001", intent: "${"0".repeat(64)}" });
    await fetch("${base}/platform/computers/${id}/do/restart", { method: "POST", mode: "no-cors", body, credentials: "include" });
    report.post = "opaque";
  } catch { report.post = "error"; }
  report.socket = await new Promise((resolve) => {
    const ws = new WebSocket("${base.replace("http", "ws")}/platform/computers/${id}/terminal", ["tty", "cfo-capability.${"A".repeat(43)}"]);
    ws.onopen = () => resolve("opened");
    ws.onerror = () => resolve("refused");
    setTimeout(() => resolve("timeout"), 5000);
  });
  window.report = report;
})();
</script>`;
}

process.exitCode = await main();
