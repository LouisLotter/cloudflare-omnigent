// The installer's MCP services step end to end, locally (WP5.10), on WP3.36's harness: the
// installer's real `services` step (`changeServices`: its checks, the one secrets change, the wait
// for a server started with it), the production web Worker and the production OmnigentServer in
// one `wrangler dev`, whose watchdog starts and replaces the server image's real container
// (Omnigent at the pinned fork commit, the shipped MCP manifests) through Docker
// (`github-setup-platform-e2e.ts`). Cloudflare is a stand-in as in WP3.36's run: the secrets change
// restarts `wrangler dev` with the new settings (a new version), and Workers Logs are the platform
// Worker's own lines as Wrangler prints them. Access is a local stand-in with a synthetic owner.
// No real account or Cloudflare resource is involved; every value is synthetic. The MCP service
// itself is not reached here (the image only builds Omnigent's registry from the choices): calls
// through the gateway are images/server/tests/integration/mcp_registry's.
//
//   docker build -f images/server/Dockerfile --target server -t cfo-wp510-server:runtime .
//   node worker/test/e2e/mcp-services-e2e.ts [results.json]
//
// Environment: CFO_E2E_SERVER_IMAGE (default cfo-wp510-server:runtime), CFO_E2E_DIR (default
// ~/.pt/wp510-e2e) for Wrangler's local state, the logs and the results. The Docker container is
// named cfo-wp510-e2e-installer-server and removed afterwards.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BootstrapState, StateStore } from "../../../scripts/bootstrap/machine.ts";
import {
  changeServices,
  MCP_REVISION_SECRET,
  type ServiceManifest,
  type ServicesChange,
  type ServicesOutcome,
  type ServicesPorts,
  servicesMessage,
} from "../../../scripts/bootstrap/services.ts";
import { shippedManifests } from "../../../scripts/bootstrap/services-command.ts";
import {
  type Installation,
  KEY_SERVICE_KEY_ID_SECRET,
  KEY_SERVICE_KEY_SECRET,
  MCP_STATE_SECRET,
  PLATFORM_FEATURES,
  RECORD_KEYS_SECRET,
} from "../../../scripts/bootstrap/settings.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { recordKeysSecret } from "../../src/internal/key-service.ts";
import { AUD, claims, makeKey, OWNER_EMAIL, SALT, sign, TEAM } from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const REPO = join(WORKER, "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp510-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");
const IMAGE = process.env.CFO_E2E_SERVER_IMAGE ?? "cfo-wp510-server:runtime";
const CONTAINER = "cfo-wp510-e2e-installer-server";
const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const PLATFORM = "cloudflare-omnigent";
const WEB = "cloudflare-omnigent-web-e2e";
const ORIGIN = "https://mcp-demo.example.test";
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
  join(HERE, `.mcp-services-e2e-${process.pid}.web.json`),
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
  // The installation's address as the server knows it: https, as on Cloudflare (Omnigent's OAuth
  // callbacks need it). The run reaches the same web Worker over http on the loopback interface.
  const hostname = `127.0.0.1:${port}`;
  const site = `https://${hostname}`;
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
  // The platform Worker's secrets after `install` (synthetic): since WP5.10 they include the
  // credential store's keys and the MCP state secret, made by install, not by github-app.
  const secrets: Record<string, string> = {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: randomBytes(32).toString("hex"),
    SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: randomBytes(32).toString("base64url"),
    [KEY_SERVICE_KEY_ID_SECRET]: `ks-${randomBytes(4).toString("hex")}`,
    [KEY_SERVICE_KEY_SECRET]: randomBytes(32).toString("hex"),
    [RECORD_KEYS_SECRET]: recordKeysSecret(
      `${INSTALLATION}.records`,
      new Uint8Array(randomBytes(32)),
    ),
    [MCP_STATE_SECRET]: randomBytes(32).toString("hex"),
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
    const visit = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", owner);
      return fetch(`${local}${path}`, { ...init, headers, redirect: "manual" });
    };
    const listed = async () => {
      const info = (await (await visit("/v1/info")).json()) as { enabled_connections?: unknown };
      return JSON.stringify(info.enabled_connections);
    };

    // 1. The installation after `install`, before any service: the key service is on, MCP off.
    await restart();
    await waitFor("wrangler dev", async () => (await fetch(`${local}/__e2e/cron`)).ok, 120_000);
    await waitFor(
      "the server, started by the watchdog",
      async () => (await visit("/v1/info")).ok,
      300_000,
    );
    check("before any service, Omnigent lists no MCP", (await listed()) === "[]", await listed());

    // 2. The installer's services step, with the Cloudflare stand-in.
    let state: BootstrapState = {
      stateVersion: 4,
      installation: {
        installationId: INSTALLATION,
        hostname,
        platformWorker: PLATFORM,
        webWorker: WEB,
      } as unknown as Installation,
      journal: {},
    };
    const store: StateStore = {
      load: () => state,
      save: (next) => {
        state = next;
      },
    };
    const plan = state.installation;
    const shipped = shippedManifests(REPO);
    const ports: ServicesPorts = {
      cloud: {
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
      },
      store,
      manifests: shipped,
      ask: async () => {
        throw new Error("the run gives every value on the command line");
      },
      random: (n) => new Uint8Array(randomBytes(n)),
      now: () => Date.now(),
      sleep,
      log: (message) => {
        installerOutput.push(message);
        console.log(`  installer: ${message}`);
      },
    };
    const step = async (
      change: ServicesChange,
      manifests: ReadonlyMap<string, ServiceManifest> = shipped,
    ): Promise<{ outcome: ServicesOutcome; exitCode: number; lines: readonly string[] }> => {
      const outcome = await changeServices(plan, { ...ports, manifests }, change, {
        pollMs: 3_000,
        waitMs: 10 * 60_000,
      });
      const words = servicesMessage(plan, change, manifests, outcome);
      installerOutput.push(...words.lines);
      for (const line of words.lines) console.log(`  installer: ${line}`);
      return { outcome, ...words };
    };

    // 2a. A bad origin: refused before any change, the server untouched.
    const before = version;
    const bad = await step({ kind: "add", id: "tracker", origin: "https://10.0.0.1" }).catch(
      (error: unknown) => error,
    );
    check(
      "the step refuses an origin that breaks a destination rule, before any change",
      bad instanceof Error &&
        bad.message.includes("must name a host, not an IP address") &&
        version === before,
      bad instanceof Error ? bad.message : String(bad),
    );

    // 2b. The test service on.
    const added = await step({ kind: "add", id: "tracker", origin: ORIGIN });
    const revision = secrets[MCP_REVISION_SECRET] ?? "";
    check(
      "services add tracker ends ready, naming Settings → MCP",
      added.outcome.kind === "ready" &&
        added.exitCode === 0 &&
        added.lines.join(" ").includes(`${site}/settings/mcp`),
      added.lines.join(" | "),
    );
    const applied = printed.filter(
      (p) =>
        p.version === `v${version}` && p.line.cfo === "bootstrap" && p.line.configApplied === true,
    );
    check(
      "the server the watchdog restarted with the choices reported its revision, and Omnigent lists MCP",
      applied.some((p) => p.line.mcpRevision === revision && p.line.mcpRegistry === true) &&
        printed.some((p) => p.line.cfo === "watchdog" && p.line.event === "config_changed"),
      `${applied.length} applied status lines`,
    );
    check("Omnigent's /v1/info lists mcp", (await listed()) === '["mcp"]', await listed());
    const page = await visit("/settings/mcp", { headers: navigation });
    check("Settings → MCP is Omnigent's page", page.status === 200, String(page.status));
    check(
      "the image's boot line says the key service and MCP are on (with no GitHub App)",
      /"key_service": "on"/.test(readServerLog()) &&
        /"mcp_registry": "on: tracker"/.test(readServerLog()),
      "",
    );

    // 2c. A choice the image refuses (a service it does not ship, offered by a checkout that
    // differs from the release): the server exits 78, the watchdog holds it, the step says so,
    // and turning it off again brings the server back.
    const ghost = new Map(shipped);
    ghost.set("ghost", { id: "ghost", title: "Not shipped", auth: "none", asks: [] });
    const held = await step({ kind: "add", id: "ghost" }, ghost);
    check(
      "a choice the image refuses ends held (exit 78), naming the way back",
      held.outcome.kind === "held" &&
        held.exitCode === 1 &&
        held.lines.join(" ").includes("services remove ghost") &&
        printed.some(
          (p) =>
            p.line.cfo === "watchdog" &&
            p.line.event === "config_error" &&
            p.line.held === true &&
            p.line.mcpRevision === secrets[MCP_REVISION_SECRET],
        ),
      held.outcome.kind,
    );
    const back = await step({ kind: "remove", id: "ghost" }, ghost);
    check(
      "removing it brings the server back with the test service on",
      back.outcome.kind === "ready" && (await listed()) === '["mcp"]',
      `${back.outcome.kind} ${await listed()}`,
    );

    // 2d. The last service off: Omnigent lists no MCP again.
    const removed = await step({ kind: "remove", id: "tracker" });
    check(
      "services remove tracker ends ready, and Omnigent lists no MCP",
      removed.outcome.kind === "ready" && (await listed()) === "[]",
      `${removed.outcome.kind} ${await listed()}`,
    );
    check(
      "the journal records the list the step wrote, confirmed",
      state.journal.mcpServices?.on.length === 0 &&
        state.journal.mcpServices.confirmedAt !== undefined &&
        state.journal.mcpServices.pending === undefined,
      JSON.stringify(state.journal.mcpServices),
    );

    // 3. No secret anywhere it should not be.
    writeFileSync(join(DIR, "installer.log"), `${installerOutput.join("\n")}\n`, { mode: 0o600 });
    const records = JSON.parse(secrets[RECORD_KEYS_SECRET] ?? "{}") as {
      versions?: Record<string, string>;
    };
    const values = [
      secrets[KEY_SERVICE_KEY_SECRET] ?? "missing",
      ...Object.values(records.versions ?? {}),
      secrets[MCP_STATE_SECRET] ?? "missing",
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
    writeFileSync(join(DIR, "canary-scan.txt"), `${scan.stdout}${scan.stderr}`, { mode: 0o600 });
    const everything = [readFileSync(join(DIR, "wrangler.log"), "utf8"), ...installerOutput].join(
      "\n",
    );
    check(
      "no secret of the credential store or the installation in Wrangler's log, the installer's output or the server's log (canary scan)",
      scan.status === 0 && values.length === 5 && values.every((v) => !everything.includes(v)),
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

/** The server container's log so far: what the control server kept, and what runs now. */
function readServerLog(): string {
  const kept = readFileSync(join(DIR, "server.log"), "utf8");
  const now = docker("logs", CONTAINER);
  return `${kept}${now.stdout}${now.stderr}`;
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
