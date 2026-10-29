// The GitHub setup flow end to end, locally (WP3.36): the installer's real GitHub step
// (`createGitHubApp`: its local page, the progress page, the wait for GitHub linking), the
// production web Worker (ingress, the GitHub setup page) and the production OmnigentServer in one
// `wrangler dev`, whose watchdog starts and replaces the server image's real container (Omnigent
// at the pinned fork commit) through Docker (`github-setup-platform-e2e.ts`). GitHub is a stand-in
// in this process: a scripted browser that does what GitHub does (it reads the manifest, comes
// back with a code, and, after "Install", goes to the App's setup URL), and the conversion answer.
// Cloudflare is a stand-in too: the installer's secrets change restarts `wrangler dev` with the
// new settings (a new version), and its Workers Logs are the platform Worker's own lines as
// Wrangler prints them, labelled with the version that printed them. Access is a local stand-in
// for the team's keys, with a synthetic owner assertion. No real account or Cloudflare resource
// is involved; every value is synthetic.
//
//   docker build -f images/server/Dockerfile --target server -t cfo-wp336-server:runtime .
//   node worker/test/e2e/github-setup-e2e.ts [results.json]
//
// Environment: CFO_E2E_SERVER_IMAGE (default cfo-wp336-server:runtime), CFO_E2E_DIR (default
// ~/.pt/wp336-e2e) for Wrangler's local state, the logs and the results. The Docker container is
// named cfo-wp336-e2e-server and removed afterwards.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGitHubApp,
  finalMessage,
  GITHUB_APP_SECRETS,
  type GitHubAppCloud,
  type GitHubAppOutcome,
  type Manifest,
} from "../../../scripts/bootstrap/github-app.ts";
import { type Installation, PLATFORM_FEATURES } from "../../../scripts/bootstrap/settings.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { KEY_SERVICE_SECRETS } from "../../src/internal/key-service.ts";
import { AUD, claims, makeKey, OWNER_EMAIL, SALT, sign, TEAM } from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const REPO = join(WORKER, "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp336-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");
const IMAGE = process.env.CFO_E2E_SERVER_IMAGE ?? "cfo-wp336-server:runtime";
const CONTAINER = "cfo-wp336-e2e-server";
const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const PLATFORM = "cloudflare-omnigent";
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const CANARY = ["CFO", "CANARY", ""].join("_");
const CLIENT_SECRET = `${CANARY}E2EGITHUBCLIENTSECRET${randomBytes(6).toString("hex")}`;
const PEM = `${CANARY}E2EGITHUBPEM${randomBytes(6).toString("hex")}`;
const WEBHOOK = `${CANARY}E2EGITHUBWEBHOOK${randomBytes(6).toString("hex")}`;
const CODE = `cfoe2ecode${randomBytes(6).toString("hex")}`;
const SLUG = "omnigent-01hs3f9q-e2e";
const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
}

function docker(...args: string[]) {
  return spawnSync("docker", args, { encoding: "utf8", timeout: 300_000 });
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | null | false>, ms: number) {
  const deadline = Date.now() + ms;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

function decode(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The control server: the watchdog's starts and stops, carried out with Docker. */
function controlServer(ports: Record<string, number>, token: string): Server {
  const serverLog = join(DIR, "server.log");
  writeFileSync(serverLog, "", { mode: 0o600 });
  const keepLogs = () => {
    const logs = docker("logs", CONTAINER);
    writeFileSync(serverLog, `${logs.stdout}${logs.stderr}`, { flag: "a" });
  };
  const exitCode = () => {
    const inspect = docker("inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", CONTAINER);
    const [running, code] = inspect.stdout.trim().split(" ");
    return { running: running === "true", code: code === undefined ? null : Number(code) };
  };
  return createServer(async (request, response) => {
    const reply = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.headers["x-e2e-token"] !== token || request.method !== "POST") {
      response.writeHead(403);
      response.end();
      return;
    }
    const body = JSON.parse((await readBody(request)) || "{}") as {
      env?: Record<string, string>;
    };
    if (request.url === "/start") {
      docker("rm", "-f", CONTAINER);
      const envFile = join(DIR, "server.env");
      writeFileSync(
        envFile,
        `${Object.entries(body.env ?? {})
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")}\n`,
        { mode: 0o600 },
      );
      const run = docker(
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-p",
        `127.0.0.1:${ports["8000"]}:8000`,
        "-p",
        `127.0.0.1:${ports["8001"]}:8001`,
        "--env-file",
        envFile,
        IMAGE,
      );
      rmSync(envFile, { force: true });
      if (run.status !== 0) return reply({ exitCode: null });
      // Until the entrypoint answers on its status port, or the container has exited.
      for (let i = 0; i < 120; i += 1) {
        const state = exitCode();
        if (!state.running) {
          keepLogs();
          return reply({ exitCode: state.code });
        }
        try {
          if ((await fetch(`http://127.0.0.1:${ports["8001"]}/status`)).ok) return reply({});
        } catch {
          // not yet
        }
        await sleep(500);
      }
      return reply({});
    }
    if (request.url === "/stop") {
      docker("stop", "-t", "60", CONTAINER);
      const state = exitCode();
      keepLogs();
      docker("rm", "-f", CONTAINER);
      return reply({ exitCode: state.code });
    }
    if (request.url === "/kill") {
      keepLogs();
      docker("rm", "-f", CONTAINER);
      return reply({ exitCode: 137 });
    }
    response.writeHead(404);
    response.end();
  });
}

/** One `wrangler dev`: a version of the platform Worker, and the web Worker in front of it. */
interface Wrangler {
  readonly child: ChildProcess;
  readonly version: string;
  readonly exited: Promise<void>;
}

/** What the platform Worker printed, as Workers Logs would deliver it, by version. */
const printed: { at: number; version: string; line: Record<string, unknown> }[] = [];

function startWrangler(
  port: number,
  configs: readonly string[],
  vars: Record<string, string>,
  secrets: Record<string, string>,
  version: string,
): Wrangler {
  // The platform Worker's secrets as Wrangler's secrets (shown as hidden, never as values): the
  // `.dev.vars` beside its rendered configuration, in the run's own directory, mode 0600, which
  // Wrangler reads at its start; removed when the run ends. (`--env-file` and `--var` reach only
  // the first configuration's Worker, the web Worker.)
  const secretsFile = join(DIR, ".dev.vars");
  writeFileSync(
    secretsFile,
    `${Object.entries(secrets)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
  const args = ["exec", "wrangler", "dev"];
  for (const config of configs) args.push("-c", config);
  args.push("--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(DIR, "state"));
  // "log": console.log lines, the watchdog's included ("info" would hide them).
  args.push("--log-level", "log");
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const child: ChildProcess = spawn("pnpm", args, {
    cwd: WORKER,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
  });
  const log = join(DIR, "wrangler.log");
  let rest = "";
  const append = (chunk: Buffer) => {
    writeFileSync(log, chunk, { flag: "a", mode: 0o600 });
    const text = rest + chunk.toString("utf8");
    const lines = text.split("\n");
    rest = lines.pop() ?? "";
    for (const raw of lines) {
      const start = raw.indexOf('{"cfo"');
      if (start < 0) continue;
      try {
        printed.push({ at: Date.now(), version, line: JSON.parse(raw.slice(start)) });
      } catch {
        // not one line of JSON
      }
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  running = { child, version, exited };
  return running;
}

/** The `wrangler dev` running now, for a stop from outside. */
let running: Wrangler | null = null;

async function stopWrangler(wrangler: Wrangler | null): Promise<void> {
  if (wrangler?.child.pid === undefined) return;
  try {
    process.kill(-wrangler.child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([wrangler.exited, sleep(20_000)]);
}

/** The web configuration beside the checked-in one (its text-module rules), the platform's in DIR. */
const RENDERED = [
  join(HERE, `.github-setup-e2e-${process.pid}.web.json`),
  join(DIR, "platform.json"),
];

/** The web and platform configurations for one version, mode 0600, removed at the end. */
function configs(platformVars: Record<string, string>): string[] {
  const [web, platform] = RENDERED as [string, string];
  const webBase = JSON.parse(
    readFileSync(join(HERE, "wrangler.web-e2e.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as Record<string, unknown>;
  writeFileSync(
    platform,
    JSON.stringify({
      name: PLATFORM,
      main: join(HERE, "github-setup-platform-e2e.ts"),
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      durable_objects: {
        bindings: [
          { name: "CONTROL", class_name: "ControlDO" },
          { name: "OMNIGENT", class_name: "OmnigentServer" },
          { name: "WORKSPACE", class_name: "WorkspaceDO" },
        ],
      },
      vars: platformVars,
      migrations: [
        { tag: "v1", new_sqlite_classes: ["ControlDO"] },
        { tag: "v2", new_sqlite_classes: ["OmnigentServer"] },
        { tag: "v3", new_sqlite_classes: ["WorkspaceDO"] },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(web, JSON.stringify({ ...webBase, $schema: undefined }), { mode: 0o600 });
  return [web, platform];
}

async function main(): Promise<number> {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
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
  const local = `http://127.0.0.1:${port}`;
  // The installation's address as the server and the App know it: https, as on Cloudflare. The
  // run reaches the same web Worker over http on the loopback interface (`toLocal`).
  const hostname = `127.0.0.1:${port}`;
  const site = `https://${hostname}`;
  const toLocal = (url: string) => url.replace(site, local);
  const ports = { "8000": await freePort(), "8001": await freePort() };
  const token = randomBytes(16).toString("hex");
  const control = controlServer(ports, token);
  const controlPort = await listen(control);
  const ingressVars = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: "127.0.0.1",
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
    ACCESS_CERTS_URL_LOCAL_ONLY: `http://127.0.0.1:${certsPort}`,
  };
  // The platform Worker's variables and secrets before the GitHub step (synthetic).
  const secrets: Record<string, string> = {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: randomBytes(32).toString("hex"),
    SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: randomBytes(32).toString("base64url"),
  };
  const plain: Record<string, string> = {
    CFO_INSTALLATION_ID: INSTALLATION,
    CFO_PLATFORM_FEATURES: PLATFORM_FEATURES.join(" "),
    CFO_E2E_SERVER_PORTS: JSON.stringify(ports),
    CFO_E2E_CONTROL: `http://127.0.0.1:${controlPort}`,
    CFO_E2E_CONTROL_TOKEN: token,
    SERVER_ENV_CFO_INSTALLATION_INITIALIZED: "false",
    SERVER_ENV_CFO_REPLICA_URL: "file:///replica",
    SERVER_ENV_CFO_ALLOW_FILE_REPLICA: "true",
    SERVER_ENV_CFO_ALLOW_LOCAL_ARTIFACTS: "true",
    SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL: site,
    SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
    SERVER_ENV_OMNIGENT_DISABLE_CATALOG_LOOKUP: "1",
  };
  let version = 1;
  let wrangler: Wrangler | null = null;
  const installerOutput: string[] = [];
  const restart = async () => {
    await stopWrangler(wrangler);
    wrangler = startWrangler(port, configs(plain), ingressVars, secrets, `v${version}`);
  };
  try {
    const now = Math.floor(Date.now() / 1000);
    const owner = await sign(key, claims(now, { exp: now + 7200 }));
    const stranger = await sign(
      key,
      claims(now, { exp: now + 7200, email: "someone@example.invalid" }),
    );
    const visit = (path: string, init: RequestInit = {}, as: string | null = owner) => {
      const headers = new Headers(init.headers);
      if (as !== null) headers.set("cf-access-jwt-assertion", as);
      const url = path.startsWith("http") ? toLocal(path) : `${local}${path}`;
      return fetch(url, { ...init, headers, redirect: "manual" });
    };
    const info = async () =>
      (await (await visit("/v1/info")).json()) as { enabled_connections?: unknown };

    // 1. The installation before the GitHub step: the watchdog starts the server without an App.
    await restart();
    await waitFor("wrangler dev", async () => (await fetch(`${local}/__e2e/cron`)).ok, 120_000);
    await waitFor(
      "the server, started by the watchdog",
      async () => (await visit("/v1/info")).ok,
      300_000,
    );
    const before = await info();
    check(
      "without an App, Omnigent lists no GitHub linking",
      Array.isArray(before.enabled_connections) && before.enabled_connections.length === 0,
      JSON.stringify(before.enabled_connections),
    );

    // 2. The setup page's doors, before anything is set.
    const refused = [
      (await visit("/platform/github", { headers: navigation }, null)).status,
      (await visit("/platform/github?installation_id=1&setup_action=install", {}, stranger)).status,
      (
        await visit("/platform/github", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
      (await visit("/_cfo/github", { method: "POST", headers: { origin: local } })).status,
      (
        await fetch(`http://localhost:${port}/platform/github`, {
          headers: { "cf-access-jwt-assertion": owner },
          redirect: "manual",
        })
      ).status,
    ];
    check(
      "the setup page: no Access, a stranger, a foreign origin, /_cfo/ and another hostname are refused",
      refused.join(",") === "403,403,403,404,404",
      refused.join(","),
    );
    const early = await visit("/platform/github", { headers: navigation });
    const earlyHtml = await early.text();
    check(
      "the setup page waits while the installation has no App",
      early.status === 200 && earlyHtml.includes('data-step="switching"'),
      String(early.status),
    );

    // 3. The installer's GitHub step, with GitHub and Cloudflare stand-ins.
    const cloud: GitHubAppCloud = {
      async secretNames() {
        return Object.keys(secrets).sort();
      },
      async workerInstallation() {
        return {
          exists: true,
          installationId: INSTALLATION,
          versionId: `v${version}`,
          vars: { ...plain },
        };
      },
      async updateSecrets(_worker, changes) {
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) delete secrets[name];
          else secrets[name] = value;
        }
        // A new version: the objects switch to it (here at once, by Wrangler's restart).
        version += 1;
        await restart();
        return "sent";
      },
      async activeVersion() {
        return `v${version}`;
      },
      async logs(worker, fromMs, toMs) {
        return printed
          .filter((p) => p.at >= fromMs && p.at <= toMs)
          .map((p) => ({
            timestamp: p.at,
            $workers: {
              scriptName: worker,
              scriptVersion: { id: p.version },
              eventType: "alarm",
              entrypoint: "OmnigentServer",
            },
            source: p.line,
          }));
      },
    };
    const plan = {
      installationId: INSTALLATION,
      hostname,
      platformWorker: PLATFORM,
    } as unknown as Installation;
    const browser: {
      manifest?: Manifest;
      progress: { status: number; html: string; location: string | null }[];
      during?: { status: number; html: string };
    } = { progress: [] };
    let browsing: Promise<void> = Promise.resolve();
    const outcome: GitHubAppOutcome = await createGitHubApp(
      plan,
      {
        cloud,
        openBrowser: (url) => {
          browsing = (async () => {
            const page = await (await fetch(url)).text();
            const action = decode(/action="([^"]+)"/.exec(page)?.[1] ?? "");
            browser.manifest = JSON.parse(
              decode(/name="manifest" value="([^"]+)"/.exec(page)?.[1] ?? "{}"),
            ) as Manifest;
            // "Create GitHub App": back to the redirect URL with a code and the state.
            const back = new URL(browser.manifest.redirect_url);
            back.searchParams.set("code", CODE);
            back.searchParams.set("state", new URL(action).searchParams.get("state") ?? "");
            const callback = await fetch(back, { redirect: "manual" });
            const status = new URL(callback.headers.get("location") ?? "/", back).toString();
            for (let i = 0; i < 2000; i += 1) {
              const r = await fetch(status, { redirect: "manual" });
              const html = await r.text();
              browser.progress.push({
                status: r.status,
                html,
                location: r.headers.get("location"),
              });
              if (r.status !== 200 || !html.includes('http-equiv="refresh"')) break;
              // Meanwhile, as if the owner reached the setup page early: it waits.
              if (browser.during === undefined && html.includes("restarting")) {
                const d = await visit(browser.manifest.setup_url, { headers: navigation });
                browser.during = { status: d.status, html: await d.text() };
              }
              await sleep(3_000);
            }
          })();
        },
        githubApi: async (url) => {
          check(
            "the installer exchanges GitHub's code at GitHub's conversion, once",
            url === `https://api.github.com/app-manifests/${CODE}/conversions`,
          );
          return Response.json(
            {
              id: 424242,
              slug: SLUG,
              client_id: "Iv23liE2EClient00000",
              client_secret: CLIENT_SECRET,
              webhook_secret: WEBHOOK,
              pem: PEM,
              permissions: { contents: "write", metadata: "read", pull_requests: "write" },
            },
            { status: 201 },
          );
        },
        random: (n) => new Uint8Array(randomBytes(n)),
        now: () => Date.now(),
        sleep,
        log: (message) => {
          installerOutput.push(message);
          console.log(`  installer: ${message}`);
        },
      },
      { linkingPollMs: 3_000, linkingWaitMs: 10 * 60_000, finalPageMs: 15_000 },
    );
    await browsing;
    const words = finalMessage(plan, outcome);
    installerOutput.push(...words.lines);
    for (const line of words.lines) console.log(`  installer: ${line}`);
    check("the GitHub step ends with GitHub linking on", outcome.kind === "on", outcome.kind);
    check(
      "the manifest sends GitHub's Install to the setup page, after updates too",
      browser.manifest?.setup_url === `${site}/platform/github` &&
        browser.manifest.setup_on_update === true,
      `${browser.manifest?.setup_url} ${browser.manifest?.setup_on_update}`,
    );
    const shown = browser.progress.slice(0, -1);
    const last = browser.progress.at(-1);
    check(
      "the progress page says what happens, and goes on to GitHub's install page only at the end",
      shown.length > 0 &&
        shown.every((p) => p.status === 200 && p.location === null) &&
        last?.status === 302 &&
        last.location === `https://github.com/apps/${SLUG}/installations/new`,
      `${shown.length} pages, then ${last?.status} ${last?.location}`,
    );
    check(
      "the setup page, reached during the restart, says it is finishing",
      browser.during?.status === 200 && browser.during.html.includes("Finishing GitHub setup"),
      String(browser.during?.status),
    );
    check(
      "the installer's last words name the install page, then Integrations, and nothing else",
      words.exitCode === 0 &&
        words.lines.join(" ").includes(`https://github.com/apps/${SLUG}/installations/new`) &&
        words.lines.join(" ").includes(`${site}/settings/integrations`),
      words.lines.join(" | "),
    );
    const applied = printed.filter(
      (p) =>
        p.version === `v${version}` && p.line.cfo === "bootstrap" && p.line.configApplied === true,
    );
    check(
      "the server the watchdog restarted with the App's settings reported GitHub linking on",
      applied.some((p) => p.line.githubApp === true && p.line.githubLinking === true) &&
        printed.some((p) => p.line.cfo === "watchdog" && p.line.event === "config_changed"),
      `${applied.length} applied status lines`,
    );

    // 4. "Install" on GitHub: GitHub sends the browser to the setup URL, with its own values.
    const back = await visit(
      `${browser.manifest?.setup_url}?installation_id=424242&setup_action=install`,
      { headers: navigation },
    );
    check(
      "GitHub's return lands on the setup page, which opens Omnigent's Integrations at once",
      back.status === 303 && back.headers.get("location") === "/settings/integrations",
      `${back.status} ${back.headers.get("location")}`,
    );
    const integrations = await visit("/settings/integrations", { headers: navigation });
    const after = await info();
    check(
      "Integrations is Omnigent's page, and Omnigent lists GitHub linking",
      integrations.status === 200 &&
        Array.isArray(after.enabled_connections) &&
        after.enabled_connections.includes("github"),
      `${integrations.status} ${JSON.stringify(after.enabled_connections)}`,
    );

    // 5. An hour that ran out (shortened): the local page says so, and stores nothing.
    let start = "";
    const changesBefore = version;
    const expiring = createGitHubApp(
      { ...plan } as Installation,
      {
        cloud: {
          ...cloud,
          // The step would refuse an installation that has an App; this one's names say none.
          secretNames: async () => [],
        },
        openBrowser: (url) => {
          start = url;
        },
        githubApi: async () => new Response(null, { status: 500 }),
        random: (n) => new Uint8Array(randomBytes(n)),
        now: () => Date.now(),
        sleep,
        log: (message) => installerOutput.push(message),
      },
      { timeoutMs: 2_000, expiredPageMs: 5_000 },
    ).catch((error: unknown) => error);
    await waitFor("the local page", async () => start !== "", 10_000);
    await sleep(3_000);
    const expired = await fetch(`${new URL(start).origin}/callback?code=${CODE}&state=x`);
    const expiredHtml = await expired.text();
    const refusal = await expiring;
    check(
      "after its wait, the local page says the link expired and what to do; nothing is stored",
      expired.status === 410 &&
        expiredHtml.includes("This link has expired") &&
        expiredHtml.includes("bootstrap.ts github-app") &&
        refusal instanceof Error &&
        version === changesBefore,
      `${expired.status} ${refusal instanceof Error ? refusal.message : String(refusal)}`,
    );

    // 6. No secret anywhere it should not be.
    writeFileSync(join(DIR, "installer.log"), `${installerOutput.join("\n")}\n`, { mode: 0o600 });
    // The secrets themselves (the App's ID, slug, client ID and callback are not secret, and
    // the record keys' JSON names the installation): the client secret, what GitHub's answer
    // also carried, the key service's signing key and record key, and the installation's own.
    const records = JSON.parse(secrets[KEY_SERVICE_SECRETS.recordKeys] ?? "{}") as {
      versions?: Record<string, string>;
    };
    const values = [
      CLIENT_SECRET,
      PEM,
      WEBHOOK,
      secrets[GITHUB_APP_SECRETS.clientSecret] ?? "missing",
      secrets[KEY_SERVICE_SECRETS.current] ?? "missing",
      ...Object.values(records.versions ?? {}),
      secrets.SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET ?? "missing",
      secrets.SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD ?? "missing",
    ];
    const scan = spawnSync(
      "node",
      [
        join(REPO, "scripts", "canary-scan.ts"),
        join(DIR, "wrangler.log"),
        join(DIR, "installer.log"),
        join(DIR, "server.log"),
      ],
      { encoding: "utf8", env: { ...process.env, CFO_CANARY_VALUES: values.join(",") } },
    );
    const everything = [
      readFileSync(join(DIR, "wrangler.log"), "utf8"),
      installerOutput.join("\n"),
      ...browser.progress.map((p) => p.html),
    ].join("\n");
    writeFileSync(join(DIR, "canary-scan.txt"), `${scan.stdout}${scan.stderr}`, { mode: 0o600 });
    check(
      "no secret of the App or the key service in Wrangler's log, the installer's output, the server's log or the pages (canary scan)",
      scan.status === 0 && values.length === 8 && values.every((v) => !everything.includes(v)),
      `canary-scan exit ${scan.status}, ${values.length} values`,
    );
  } catch (error) {
    check("the run", false, error instanceof Error ? error.message : String(error));
  } finally {
    await stopWrangler(wrangler);
    certs.close();
    control.close();
    docker("rm", "-f", CONTAINER);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(join(DIR, "state"), { recursive: true, force: true });
    rmSync(join(DIR, ".dev.vars"), { force: true });
  }
  writeFileSync(
    OUT,
    `${JSON.stringify({ at: new Date().toISOString(), image: IMAGE, checks }, null, 2)}\n`,
  );
  return checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1;
}

// Stopped from outside (Ctrl-C, a timeout): Wrangler, the container and the rendered files go too.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    const pid = running?.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    docker("rm", "-f", CONTAINER);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(join(DIR, ".dev.vars"), { force: true });
    process.exit(130);
  });
}

process.exitCode = await main();
