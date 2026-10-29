// The owner's password page end to end, locally (WP3.34): the production web Worker (ingress,
// the page, the first-visit redirect) and the production OmnigentServer in one `wrangler dev`,
// and the server image's real container (Omnigent at the pinned fork commit, the response
// barrier, Litestream on a file replica) under Docker, which OmnigentServer reaches on the ports
// Docker publishes on the loopback interface (`password-platform-e2e.ts`). Access is a local
// stand-in for the team's keys, with a synthetic owner assertion. No real account or Cloudflare
// resource is involved.
//
//   docker build -f images/server/Dockerfile --target server -t cfo-wp334-server:runtime .
//   node worker/test/e2e/password-e2e.ts [results.json]
//
// Environment: CFO_E2E_SERVER_IMAGE (default cfo-wp334-server:runtime), CFO_E2E_DIR (default
// ~/.pt/wp334-e2e) for wrangler's local state, the logs and the results. The Docker container is
// named cfo-wp334-e2e-server and removed afterwards. Every value is generated for the run; the
// server's starting password is generated, handed to Docker in a file that is deleted at once,
// and kept by nobody, as the installer does it.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { AUD, claims, makeKey, OWNER_EMAIL, SALT, sign, TEAM } from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const REPO = join(WORKER, "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp334-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");
const IMAGE = process.env.CFO_E2E_SERVER_IMAGE ?? "cfo-wp334-server:runtime";
const CONTAINER = "cfo-wp334-e2e-server";
const OWNER = "owner";
const PASSWORD_PATH = "/platform/password";
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const CANARY = ["CFO", "CANARY", ""].join("_");
const FIRST = `${CANARY}E2EFIRST${randomBytes(6).toString("hex")}`;
const SECOND = `${CANARY}E2ESECOND${randomBytes(6).toString("hex")}`;

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

/** The server image's container, with the settings the platform Worker would give it. */
function startServer(
  base: string,
  cookieSecret: string,
  ports: Record<string, number>,
): Record<string, number> {
  docker("rm", "-f", CONTAINER);
  const envFile = join(DIR, "server.env");
  writeFileSync(
    envFile,
    `${Object.entries({
      CFO_INSTALLATION_ID: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
      CFO_INSTALLATION_INITIALIZED: "false",
      CFO_REPLICA_URL: "file:///replica",
      CFO_ALLOW_FILE_REPLICA: "true",
      CFO_ALLOW_LOCAL_ARTIFACTS: "true",
      OMNIGENT_ACCOUNTS_BASE_URL: base,
      OMNIGENT_ACCOUNTS_COOKIE_SECRET: cookieSecret,
      OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: OWNER,
      // As the installer: random, and kept by nobody (this file is deleted once Docker read it).
      OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: randomBytes(32).toString("base64url"),
      OMNIGENT_DISABLE_CATALOG_LOOKUP: "1",
    })
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
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  return ports;
}

function startWrangler(port: number, configs: string[], vars: Record<string, string>) {
  const args = ["exec", "wrangler", "dev"];
  for (const config of configs) args.push("-c", config);
  args.push("--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(DIR, "state"));
  args.push("--log-level", "info");
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const child: ChildProcess = spawn("pnpm", args, {
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

/**
 * The platform and web configurations for this run, with its ports and its cookie secret
 * (synthetic): written next to the checked-in ones, so Wrangler resolves the modules and the
 * text-module rules as it does for those, mode 0600, and removed when the run ends.
 */
const RENDERED = [
  join(HERE, `.password-e2e-${process.pid}.web.json`),
  join(HERE, `.password-e2e-${process.pid}.platform.json`),
];

function configs(ports: Record<string, number>, cookieSecret: string): string[] {
  const [web, platform] = RENDERED as [string, string];
  const webBase = JSON.parse(
    readFileSync(join(HERE, "wrangler.web-e2e.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as Record<string, unknown>;
  writeFileSync(
    platform,
    JSON.stringify({
      name: "cloudflare-omnigent",
      main: "password-platform-e2e.ts",
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
      vars: {
        CFO_INSTALLATION_ID: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
        CFO_E2E_SERVER_PORTS: JSON.stringify(ports),
        CFO_OWNER_PASSWORD_ON_PAGE: "true",
        SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: cookieSecret,
        SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: OWNER,
      },
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
  const base = `http://127.0.0.1:${port}`;
  const cookieSecret = randomBytes(32).toString("hex");
  let wrangler: ChildProcess | null = null;
  try {
    const ports = startServer(base, cookieSecret, {
      "8000": await freePort(),
      "8001": await freePort(),
    });
    await waitFor(
      "the server image's Omnigent",
      async () => (await fetch(`http://127.0.0.1:${ports["8000"]}/v1/info`)).ok,
      300_000,
    );
    wrangler = startWrangler(port, configs(ports, cookieSecret), {
      ACCESS_TEAM_DOMAIN: TEAM,
      ACCESS_AUD: AUD,
      ALLOWED_HOSTNAMES: "127.0.0.1",
      OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
      ACCESS_CERTS_URL_LOCAL_ONLY: `http://127.0.0.1:${certsPort}`,
    });
    const now = Math.floor(Date.now() / 1000);
    const owner = await sign(key, claims(now, { exp: now + 3600 }));
    const stranger = await sign(
      key,
      claims(now, { exp: now + 3600, email: "someone@example.invalid" }),
    );
    const visit = (path: string, init: RequestInit = {}, as: string | null = owner) => {
      const headers = new Headers(init.headers);
      if (as !== null) headers.set("cf-access-jwt-assertion", as);
      return fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
    };
    await waitFor("wrangler dev", async () => (await visit("/v1/info")).ok, 120_000);
    const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const form = (fields: Record<string, string>, origin = base): RequestInit => ({
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": origin === base ? "same-origin" : "cross-site",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    });
    const intent = async () => {
      const html = await (await visit(PASSWORD_PATH)).text();
      return /name="intent" value="([0-9a-f]{64})"/.exec(html)?.[1] ?? "";
    };
    const login = (password: string) =>
      visit("/auth/login", {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({ username: OWNER, password }),
      });
    const me = (cookie: string) => visit("/auth/me", { headers: { cookie } });
    const cookieOf = (response: Response) =>
      response.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");

    // 1. The installer's state: the owner exists; nobody can sign in as them.
    const info = (await (await visit("/v1/info")).json()) as Record<string, unknown>;
    check(
      "the owner exists before anyone chose a password (no first-visitor setup)",
      info.accounts_enabled === true && info.needs_setup === false,
      JSON.stringify({ accounts_enabled: info.accounts_enabled, needs_setup: info.needs_setup }),
    );
    const guesses = ["", "password", OWNER, "owner-password", cookieSecret];
    const refused = await Promise.all(guesses.map(async (g) => (await login(g)).status));
    check(
      "nobody can sign in as the owner before the page is used",
      refused.every((s) => s === 401 || s === 422),
      refused.join(","),
    );

    // 2. Who can reach the page.
    const nobody = [
      (await visit(PASSWORD_PATH, {}, null)).status,
      (await visit(PASSWORD_PATH, {}, stranger)).status,
      (await visit(PASSWORD_PATH, form({ password: FIRST, confirm: FIRST }), null)).status,
      (await visit(PASSWORD_PATH, form({ password: FIRST, confirm: FIRST }), stranger)).status,
    ];
    check(
      "no Access, or Access for anyone but the owner: refused",
      nobody.every((s) => s === 403),
      nobody.join(","),
    );

    // 3. The first visit.
    const first = await visit("/", { headers: navigation });
    check(
      "the owner's first page load goes to the password page",
      first.status === 303 && first.headers.get("location") === PASSWORD_PATH,
      `${first.status} ${first.headers.get("location")}`,
    );
    const page = await visit(PASSWORD_PATH);
    const html = await page.text();
    check(
      "the page asks to choose the password, framed by nobody, no script",
      html.includes("Choose your Omnigent password") &&
        !html.includes("<script") &&
        (page.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'") &&
        page.headers.get("x-frame-options") === "DENY",
    );

    // 4. Origin, CSRF, validation: nothing set.
    const token = await intent();
    const foreign = await visit(
      PASSWORD_PATH,
      form({ intent: token, password: FIRST, confirm: FIRST }, "https://evil.example"),
    );
    const stale = await visit(
      PASSWORD_PATH,
      form({ intent: "0".repeat(64), password: FIRST, confirm: FIRST }),
    );
    const mismatch = await visit(
      PASSWORD_PATH,
      form({ intent: token, password: FIRST, confirm: `${FIRST}x` }),
    );
    const platformPath = await visit("/_cfo/owner-password", {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ password: FIRST, nonce: "0".repeat(32) }),
    });
    const direct = await fetch(`http://127.0.0.1:${ports["8000"]}/_cfo/owner-password`, {
      method: "POST",
      body: JSON.stringify({ password: FIRST, nonce: "0".repeat(32) }),
    });
    check(
      "a foreign origin, a stale intent, a mismatch, the platform path and an unsigned call set nothing",
      foreign.status === 403 &&
        stale.headers.get("location") === `${PASSWORD_PATH}?result=intent` &&
        mismatch.status === 400 &&
        platformPath.status === 404 &&
        direct.status === 401 &&
        (await login(FIRST)).status === 401,
      [foreign.status, stale.status, mismatch.status, platformPath.status, direct.status].join(","),
    );

    // 5. Choose it.
    const chosen = await visit(
      PASSWORD_PATH,
      form({ intent: await intent(), username: OWNER, password: FIRST, confirm: FIRST }),
    );
    check(
      "the owner chooses the password: done, after the barrier confirmed it",
      chosen.headers.get("location") === `${PASSWORD_PATH}?result=done`,
      `${chosen.status} ${chosen.headers.get("location")}`,
    );
    const signedIn = await login(FIRST);
    const session = cookieOf(signedIn);
    check(
      "the owner signs in to Omnigent with it, through the web Worker",
      signedIn.status === 200 && (await me(session)).status === 200,
      String(signedIn.status),
    );
    const home = await visit("/", { headers: navigation });
    check(
      "page loads reach Omnigent once the password is chosen",
      home.status === 200,
      String(home.status),
    );

    // 6. Forgot it: the reset.
    const resetPage = await (await visit(PASSWORD_PATH)).text();
    const reset = await visit(
      PASSWORD_PATH,
      form({ intent: await intent(), password: SECOND, confirm: SECOND }),
    );
    check(
      "the page is the reset now, and resets",
      resetPage.includes("Reset your Omnigent password") &&
        reset.headers.get("location") === `${PASSWORD_PATH}?result=done`,
    );
    const afterReset = [
      (await me(session)).status,
      (await login(FIRST)).status,
      (await login(SECOND)).status,
    ];
    check(
      "a reset signs the owner out everywhere; only the new password works",
      afterReset[0] === 401 && afterReset[1] === 401 && afterReset[2] === 200,
      afterReset.join(","),
    );

    // 7. The server down: "try again", never a silent no-op; then back.
    docker("stop", "-t", "60", CONTAINER);
    const down = await visit(
      PASSWORD_PATH,
      form({ intent: await intent(), password: SECOND, confirm: SECOND }),
    );
    const downResult = new URL(down.headers.get("location") ?? "/", base).searchParams.get(
      "result",
    );
    check("a stopped server: try again", downResult === "unavailable", String(downResult));
    docker("start", CONTAINER);
    await waitFor("the server again", async () => (await login(SECOND)).status === 200, 300_000);
    check("restarted on its own database, the reset's password still works", true);

    // 8. The attempts limit: the choice, the reset and perhaps the attempt while down reached
    // the server; the rest of the 6, then refused.
    const results: string[] = [];
    for (let i = 0; i < 6 && !results.includes("rate_limited"); i += 1) {
      const r = await visit(
        PASSWORD_PATH,
        form({ intent: await intent(), password: SECOND, confirm: SECOND }),
      );
      results.push(
        new URL(r.headers.get("location") ?? "/", base).searchParams.get("result") ?? "?",
      );
    }
    const done = results.filter((r) => r === "done").length;
    check(
      "at most 6 attempts in 10 minutes reach the server, then 'too many attempts'",
      results.at(-1) === "rate_limited" && (done === 3 || done === 4),
      results.join(","),
    );

    // 9. No password in any log line.
    const logs = [
      readFileSync(join(DIR, "wrangler.log"), "utf8"),
      docker("logs", CONTAINER).stdout + docker("logs", CONTAINER).stderr,
    ].join("\n");
    writeFileSync(join(DIR, "server.log"), docker("logs", CONTAINER).stderr, { mode: 0o600 });
    const scan = spawnSync(
      "node",
      [join(REPO, "scripts", "canary-scan.ts"), join(DIR, "wrangler.log"), join(DIR, "server.log")],
      { encoding: "utf8", env: { ...process.env, CFO_CANARY_VALUES: [FIRST, SECOND].join(",") } },
    );
    check(
      "no chosen password in Wrangler's or the server's log (canary scan)",
      !logs.includes(FIRST) && !logs.includes(SECOND) && scan.status === 0,
      `canary-scan exit ${scan.status}`,
    );
  } catch (error) {
    check("the run", false, error instanceof Error ? error.message : String(error));
  } finally {
    if (wrangler?.pid !== undefined) {
      try {
        process.kill(-wrangler.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    certs.close();
    docker("rm", "-f", CONTAINER);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(join(DIR, "state"), { recursive: true, force: true });
  }
  writeFileSync(
    OUT,
    `${JSON.stringify({ at: new Date().toISOString(), image: IMAGE, checks }, null, 2)}\n`,
  );
  return checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1;
}

process.exitCode = await main();
