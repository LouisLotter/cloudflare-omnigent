// An update's restore point, read-only window, acceptance and rollback end to end, locally
// (WP3.41, ADR 0007), on WP3.36's harness: the installer's real `update` and `update --rollback`
// (update.ts, rollback.ts), the production web Worker and the production OmnigentServer in one
// `wrangler dev`, whose watchdog starts, replaces and holds the server image's real container
// (Omnigent at the pinned fork commit, Litestream on a file replica in a Docker volume, the
// restore point taken and put back by the image) through Docker (`github-setup-platform-e2e.ts`).
// Cloudflare is a stand-in: each deploy, secrets change or version rollback restarts `wrangler
// dev` with that version's variables and secrets (a version), and Workers Logs are the platform
// Worker's own lines as Wrangler prints them. Access is a local stand-in with a synthetic owner.
// No real account or Cloudflare resource is involved; every value is synthetic.
//
//   1. An installation, released: its owner, and a write.
//   2. Update A: the window opens; the new server takes its restore point before Omnigent starts;
//      while the update is unchecked, no request reaches Omnigent (reads and writes, the password
//      page); the update then checks and accepts it, and writes work again. Restoring the restore
//      point gives exactly the database from before the update.
//   3. Update B, whose check does not pass in time: a write lands inside the window by a hand that
//      reaches the database directly (as a migration would); `update --rollback` puts the restore
//      point back and the previous versions; the database is the one from before update B, the
//      migration's write is gone, and writes work again.
//
//   docker build -f images/server/Dockerfile --target server -t cfo-wp341-server:runtime .
//   node worker/test/e2e/update-window-e2e.ts [results.json]
//
// Environment: CFO_E2E_SERVER_IMAGE (default cfo-wp341-server:runtime), CFO_E2E_DIR (default
// ~/.pt/wp341-e2e) for Wrangler's local state, the logs and the results. The Docker container
// (cfo-wp341-e2e-server), its helper (cfo-wp341-e2e-helper) and the replica's volume
// (cfo-wp341-e2e-replica) are removed afterwards.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BootstrapCloud,
  BootstrapState,
  StateStore,
  WorkerIdentity,
} from "../../../scripts/bootstrap/machine.ts";
import { runRollback } from "../../../scripts/bootstrap/rollback.ts";
import {
  INITIALIZED_SECRET,
  type Installation,
  PASSWORD_SECRET,
  PLATFORM_FEATURES,
} from "../../../scripts/bootstrap/settings.ts";
import {
  runUpdate,
  type UpdateContext,
  type UpdateOptions,
} from "../../../scripts/bootstrap/update.ts";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import {
  MAINTENANCE_WINDOW_SECRET,
  RESTORE_POINT_VAR,
  ROLLBACK_SECRET,
} from "../../src/server/maintenance.ts";
import { AUD, claims, makeKey, OWNER_EMAIL, SALT, sign, TEAM } from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const REPO = join(WORKER, "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp341-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");
const IMAGE = process.env.CFO_E2E_SERVER_IMAGE ?? "cfo-wp341-server:runtime";
const CONTAINER = "cfo-wp341-e2e-server";
const HELPER = "cfo-wp341-e2e-helper";
const VOLUME = "cfo-wp341-e2e-replica";
const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const PLATFORM = "cloudflare-omnigent";
const REPLICA = "file:///replica-root/omnigent";
const CODE = { install: "1".repeat(40), a: "a".repeat(40), b: "b".repeat(40) };
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const CANARY = ["CFO", "CANARY", ""].join("_");
const OWNER_PASSWORD = `${CANARY}E2EOWNER${randomBytes(6).toString("hex")}`;

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
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The control server: the watchdog's starts and stops, carried out with Docker. A start answers
 * once Omnigent answers its health check, or with the exit code once the container exits (an
 * exit 79 after a rollback, an exit 74 without a restore point), as the runtime's `monitor()`.
 */
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
        "-v",
        `${VOLUME}:/replica-root`,
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
      for (let i = 0; i < 300; i += 1) {
        const state = exitCode();
        if (!state.running) {
          keepLogs();
          return reply({ exitCode: state.code });
        }
        try {
          if ((await fetch(`http://127.0.0.1:${ports["8000"]}/health`)).ok) return reply({});
        } catch {
          // not yet
        }
        await sleep(1000);
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

interface Wrangler {
  readonly child: ChildProcess;
  readonly version: string;
  readonly exited: Promise<void>;
}

/** What the platform Worker printed, as Workers Logs would deliver it, by version. */
const printed: { at: number; version: string; line: Record<string, unknown> }[] = [];
let running: Wrangler | null = null;

function startWrangler(
  port: number,
  configs: readonly string[],
  vars: Record<string, string>,
  secrets: Record<string, string>,
  version: string,
): Wrangler {
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

async function stopWrangler(wrangler: Wrangler | null): Promise<void> {
  if (wrangler?.child.pid === undefined) return;
  try {
    process.kill(-wrangler.child.pid, "SIGTERM");
  } catch {
    return;
  }
  await Promise.race([wrangler.exited, sleep(20_000)]);
}

const RENDERED = [
  join(HERE, `.update-window-e2e-${process.pid}.web.json`),
  join(DIR, "platform.json"),
];

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

/** The server's database, read in its own container (never written, except by `write`). */
function sql(query: string): string {
  const result = docker("exec", CONTAINER, "sqlite3", "/data/omnigent.db", query);
  if (result.status !== 0) throw new Error(`sqlite3 failed: ${result.stderr.slice(0, 200)}`);
  return result.stdout.trim();
}

/** A restore point's database, restored by the image's own Litestream in a helper container. */
function restorePointNames(id: string): string {
  docker("rm", "-f", HELPER);
  const result = docker(
    "run",
    "--rm",
    "--name",
    HELPER,
    "-v",
    `${VOLUME}:/replica-root`,
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    `litestream restore -o /tmp/rp.db file:///replica-root/cfo-restore-points/${id}/replica >/dev/null && sqlite3 /tmp/rp.db 'SELECT name FROM scheduled_tasks ORDER BY name'`,
  );
  if (result.status !== 0) throw new Error(`restore failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout.trim().replaceAll("\n", " | ");
}

async function main(): Promise<number> {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  docker("rm", "-f", CONTAINER);
  docker("volume", "rm", "-f", VOLUME);
  docker("volume", "create", VOLUME);
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
  const plain: Record<string, string> = {
    CFO_INSTALLATION_ID: INSTALLATION,
    CFO_PLATFORM_FEATURES: PLATFORM_FEATURES.join(" "),
    CFO_E2E_SERVER_PORTS: JSON.stringify(ports),
    CFO_E2E_CONTROL: `http://127.0.0.1:${controlPort}`,
    CFO_E2E_CONTROL_TOKEN: token,
    SERVER_ENV_CFO_REPLICA_URL: REPLICA,
    SERVER_ENV_CFO_ALLOW_FILE_REPLICA: "true",
    SERVER_ENV_CFO_ALLOW_LOCAL_ARTIFACTS: "true",
    SERVER_ENV_OMNIGENT_ACCOUNTS_BASE_URL: site,
    SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
    SERVER_ENV_OMNIGENT_DISABLE_CATALOG_LOOKUP: "1",
  };
  // The installation's secrets after `install`, before its release (synthetic).
  const installed: Record<string, string> = {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: randomBytes(32).toString("hex"),
    [PASSWORD_SECRET]: OWNER_PASSWORD,
    [INITIALIZED_SECRET]: "false",
  };

  // Cloudflare's versions, as the stand-in keeps them: each a variable and secret set.
  interface Version {
    readonly id: string;
    readonly vars: Record<string, string>;
    readonly secrets: Record<string, string>;
  }
  const versions: Version[] = [];
  let next = 1;
  let current: Version = { id: `v${next++}`, vars: { ...plain }, secrets: { ...installed } };
  let webVersion = "w1";
  let wrangler: Wrangler | null = null;
  const activate = async (version: Version) => {
    current = version;
    versions.push(version);
    await stopWrangler(wrangler);
    wrangler = startWrangler(port, configs(version.vars), ingressVars, version.secrets, version.id);
    await waitFor("wrangler dev", async () => (await fetch(`${local}/__e2e/cron`)).ok, 120_000);
  };
  const installerOutput: string[] = [];
  try {
    const now = Math.floor(Date.now() / 1000);
    const owner = await sign(key, claims(now, { exp: now + 7200 }));
    const visit = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", owner);
      return fetch(`${local}${path}`, { ...init, headers, redirect: "manual" });
    };
    const bearer = async () => {
      const login = await visit("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "owner", password: OWNER_PASSWORD }),
      });
      if (login.status !== 200) throw new Error(`login answered ${login.status}`);
      return { authorization: `Bearer ${((await login.json()) as { token: string }).token}` };
    };
    const schedule = async (name: string) => {
      const auth = await bearer();
      const agents = (await (await visit("/v1/agents", { headers: auth })).json()) as {
        data?: { id: string }[];
        agents?: { id: string }[];
      };
      const agent = (agents.data ?? agents.agents ?? [])[0]?.id;
      return visit("/v1/scheduled-tasks", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          name,
          prompt: "synthetic task",
          rrule: "FREQ=DAILY;BYHOUR=3",
          agent_id: agent,
          timezone: "UTC",
        }),
      });
    };
    const names = () =>
      sql("SELECT name FROM scheduled_tasks ORDER BY name").replaceAll("\n", " | ");
    const serverAnswers = () =>
      waitFor("Omnigent through the web Worker", async () => (await visit("/v1/info")).ok, 600_000);
    const durable = (version: string) =>
      waitFor(
        `a durable owner on ${version}`,
        async () =>
          printed.some(
            (p) =>
              p.version === version &&
              p.line.cfo === "bootstrap" &&
              p.line.configApplied === true &&
              (p.line.bootstrapStatus as { initialized?: boolean } | undefined)?.initialized ===
                true,
          ),
        600_000,
      );

    // 1. The installation: its first start creates the owner; the release marks it initialized
    // and removes the bootstrap password; a write.
    await activate(current);
    await durable(current.id);
    const { [PASSWORD_SECRET]: _p, ...released } = current.secrets;
    await activate({
      id: `v${next++}`,
      vars: { ...plain },
      secrets: { ...released, [INITIALIZED_SECRET]: "true" },
    });
    await durable(current.id);
    await serverAnswers();
    check("the installation's owner signs in", (await bearer()).authorization.startsWith("Bearer"));
    check("a write before any update", (await schedule("1 before update A")).ok);

    // The installer's state and the Cloudflare stand-in.
    const plan: Installation = {
      installationId: INSTALLATION,
      accountId: "1".repeat(32),
      platformWorker: "cfo-stg-wp341-platform",
      webWorker: "cfo-stg-wp341-web",
      hostname: "cfo-stg-wp341-web.example.test",
      ownerPin: await makeOwnerPin(OWNER_EMAIL, new Uint8Array(32).fill(7)),
      ownerUsername: "owner",
      replica: { url: REPLICA },
      target: {
        kind: "staging",
        owner: "WP3.41",
        platformSuffix: "wp341-platform",
        webSuffix: "wp341-web",
        days: 1,
      },
      plannedAt: new Date().toISOString(),
    };
    let state: BootstrapState = {
      stateVersion: 3,
      installation: plan,
      journal: {
        releasedAt: new Date().toISOString(),
        verifiedAt: new Date().toISOString(),
        platformCode: CODE.install,
        webCode: CODE.install,
      },
    };
    const store: StateStore = {
      load: () => state,
      save: (s) => {
        state = structuredClone(s);
      },
    };
    const identity = (worker: string): WorkerIdentity =>
      worker === plan.platformWorker
        ? { exists: true, installationId: INSTALLATION, versionId: current.id, vars: current.vars }
        : {
            exists: true,
            installationId: INSTALLATION,
            versionId: webVersion,
            vars: { CFO_INSTALLATION_ID: INSTALLATION },
          };
    const cloud: BootstrapCloud = {
      async secretNames(worker) {
        return worker === plan.platformWorker ? Object.keys(current.secrets).sort() : [];
      },
      async access() {
        return { teamDomain: TEAM, aud: AUD };
      },
      async deployPlatform(_plan, config, secrets) {
        // The stand-in deploys the run's own platform Worker: of the rendered configuration, only
        // what the update adds to the server's environment.
        const vars = (config.vars ?? {}) as Record<string, string>;
        const picked = Object.fromEntries(
          Object.entries(vars).filter(([name]) =>
            ["SERVER_ENV_CFO_DEPLOY_ID", RESTORE_POINT_VAR].includes(name),
          ),
        );
        await activate({
          id: `v${next++}`,
          vars: { ...plain, ...picked },
          secrets: { ...current.secrets, ...secrets },
        });
      },
      async deployWeb() {
        webVersion = `w${next++}`;
      },
      async workerInstallation(worker) {
        return identity(worker);
      },
      async updateSecrets(worker, changes) {
        if (worker !== plan.platformWorker) throw new Error("only the platform Worker's");
        const secrets = { ...current.secrets };
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) delete secrets[name];
          else secrets[name] = value;
        }
        await activate({ id: `v${next++}`, vars: current.vars, secrets });
        return "sent";
      },
      async activeVersion(worker) {
        return worker === plan.platformWorker ? current.id : webVersion;
      },
      async deployVersion(worker, versionId) {
        if (worker !== plan.platformWorker) {
          webVersion = versionId;
          return;
        }
        const version = versions.findLast((v) => v.id === versionId);
        if (version === undefined) throw new Error(`no version ${versionId}`);
        await activate({ ...version });
      },
      async logs(_worker, fromMs, toMs) {
        return printed
          .filter((p) => p.at >= fromMs && p.at <= toMs)
          .map((p) => ({
            timestamp: p.at,
            $workers: {
              scriptName: plan.platformWorker,
              scriptVersion: { id: p.version },
              eventType: "alarm",
              entrypoint: ["watchdog", "bootstrap", "server"].includes(String(p.line.cfo))
                ? "OmnigentServer"
                : "WebWorker",
            },
            source: p.line,
          }));
      },
    };
    const context = (code: string): UpdateContext => ({
      cloud,
      store,
      baseConfigs: {
        platform: readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER).raw,
        web: readWranglerConfig(join(WORKER, "wrangler.web.jsonc"), WORKER).raw,
      },
      codeVersion: code,
      random: (n) => new Uint8Array(randomBytes(n)),
      now: () => Date.now(),
      sleep,
      log: (message) => {
        installerOutput.push(message);
        console.log(`  installer: ${message}`);
      },
    });
    const options: UpdateOptions = {
      verify: true,
      pollMs: 3_000,
      switchMs: 2_000,
      verifyWaitMs: 10 * 60_000,
      acceptWaitMs: 5 * 60_000,
    };
    const refusedInWindow = async (what: string) => {
      const answers = await Promise.all([
        visit("/v1/info"),
        visit("/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "owner", password: OWNER_PASSWORD }),
        }),
        visit("/v1/scheduled-tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: what }),
        }),
      ]);
      const bodies = await Promise.all(answers.map((a) => a.text()));
      return answers.every((a) => a.status === 503) && bodies.every((b) => /being updated/.test(b));
    };

    // 2. Update A: deployed, not yet checked (the window open); then checked and accepted.
    const beforeA = names();
    const deployedA = await runUpdate(context(CODE.a), { ...options, verify: false });
    const windowA = state.journal.window;
    check(
      "update A opens its window before the deploy and carries it",
      deployedA.kind === "deployed" &&
        deployedA.window === "open" &&
        windowA !== undefined &&
        current.secrets[MAINTENANCE_WINDOW_SECRET] === windowA.id &&
        current.vars[RESTORE_POINT_VAR] === windowA.id,
      JSON.stringify(deployedA),
    );
    const idA = windowA?.id ?? "none";
    await waitFor(
      "the restore point the new server reports",
      async () =>
        printed.some(
          (p) =>
            p.version === current.id &&
            p.line.cfo === "bootstrap" &&
            (p.line.restorePoint as { id?: string } | null)?.id === idA,
        ),
      600_000,
    );
    check(
      "the new server took its restore point before Omnigent started",
      /"cfo\.restore_point\.taken"/.test(docker("logs", CONTAINER).stderr) &&
        docker("logs", CONTAINER).stderr.indexOf("cfo.restore_point.taken") <
          docker("logs", CONTAINER).stderr.indexOf('"cfo.started"'),
    );
    check(
      "inside the window, nothing reaches Omnigent: reads, sign-in and writes get 503",
      await refusedInWindow("inside window A"),
    );
    const bootLines = () =>
      docker("logs", CONTAINER)
        .stderr.split("\n")
        .filter((l) => l.includes('"cfo.boot"'));
    check(
      "inside the window, the server started Omnigent without its scheduler",
      bootLines().at(-1)?.includes('"maintenance": true') === true,
      bootLines().at(-1)?.slice(0, 120),
    );
    check("no write landed inside the window", names() === beforeA, names());
    const acceptedA = await runUpdate(context(CODE.a), options);
    check(
      "update A is checked and accepted, and the window's secret is gone",
      acceptedA.kind === "done" &&
        state.journal.window === undefined &&
        current.secrets[MAINTENANCE_WINDOW_SECRET] === undefined &&
        state.journal.restorePoints?.[0]?.outcome === "accepted",
      JSON.stringify(acceptedA),
    );
    await serverAnswers();
    check(
      "acceptance restarted the server without the window, its scheduler on",
      bootLines().at(-1)?.includes('"maintenance": false') === true,
    );
    check("after acceptance, writes work again", (await schedule("2 after update A")).ok);
    check(
      "restoring update A's restore point gives back the database from before it",
      restorePointNames(idA) === beforeA,
      `${restorePointNames(idA)} | ${beforeA}`,
    );

    // 3. Update B: its check does not pass in time; a write lands in the database directly; the
    // rollback puts back the restore point and the previous versions.
    const beforeB = names();
    const previousPlatform = current.id;
    const deployedB = await runUpdate(context(CODE.b), { ...options, verifyWaitMs: 1 });
    const idB = state.journal.window?.id ?? "none";
    check(
      "update B's check does not pass in time: the window stays open, and it says how to go back",
      deployedB.kind === "deployed" && deployedB.window === "open",
      JSON.stringify(deployedB),
    );
    await waitFor(
      "update B's restore point",
      async () =>
        printed.some(
          (p) =>
            p.line.cfo === "bootstrap" &&
            (p.line.restorePoint as { id?: string } | null)?.id === idB,
        ),
      600_000,
    );
    // As a migration would: a write the new server replicates, reaching the database directly.
    sql("CREATE TABLE cfo_e2e_migration (x); INSERT INTO cfo_e2e_migration VALUES (1);");
    await waitFor(
      "the migration's write replicated",
      async () => {
        const status = (await (await fetch(`http://127.0.0.1:${ports["8001"]}/status`)).json()) as {
          replication?: { caughtUp?: boolean };
        };
        return status.replication?.caughtUp === true;
      },
      60_000,
    );
    check("inside update B's window, writes get 503", await refusedInWindow("inside window B"));
    const rolled = await runRollback(context(CODE.b), options);
    check(
      "the rollback finishes: the restore point back, the previous versions, the server checked",
      rolled.kind === "done" &&
        state.journal.window === undefined &&
        current.id === previousPlatform &&
        current.secrets[ROLLBACK_SECRET] === undefined &&
        current.secrets[MAINTENANCE_WINDOW_SECRET] === undefined &&
        state.journal.platformCode === CODE.a &&
        state.journal.restorePoints?.at(-1)?.outcome === "rolled back",
      JSON.stringify(rolled),
    );
    check(
      "the watchdog said the server put the restore point back, and held it",
      printed.some(
        (p) =>
          p.line.cfo === "watchdog" &&
          p.line.event === "rolled_back" &&
          p.line.held === true &&
          p.line.restorePoint === idB,
      ),
    );
    await serverAnswers();
    check(
      "the database is the one from before update B, and the migration's write is gone",
      names() === beforeB &&
        sql("SELECT count(*) FROM sqlite_master WHERE name = 'cfo_e2e_migration'") === "0",
      names(),
    );
    check("after the rollback, writes work again", (await schedule("3 after the rollback")).ok);
    await expectRefusal(
      () => runRollback(context(CODE.b), options),
      "there is nothing to go back to: the last update's window was rolled back",
    );

    // No secret anywhere it should not be.
    writeFileSync(join(DIR, "installer.log"), `${installerOutput.join("\n")}\n`, { mode: 0o600 });
    const values = [
      OWNER_PASSWORD,
      installed.SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET ?? "missing",
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
    check(
      "no secret in Wrangler's log, the installer's output or the server's log (canary scan)",
      scan.status === 0 &&
        !installerOutput.join("\n").includes(OWNER_PASSWORD) &&
        !JSON.stringify(state).includes(OWNER_PASSWORD),
      `canary-scan exit ${scan.status}`,
    );
  } catch (error) {
    check("the run", false, error instanceof Error ? error.message : String(error));
  } finally {
    const logs = docker("logs", CONTAINER);
    writeFileSync(join(DIR, "server.log"), `${logs.stdout}${logs.stderr}`, { flag: "a" });
    await stopWrangler(wrangler);
    certs.close();
    control.close();
    docker("rm", "-f", CONTAINER);
    docker("rm", "-f", HELPER);
    docker("volume", "rm", "-f", VOLUME);
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

async function expectRefusal(run: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await run();
    check(`refused: ${message}`, false, "it ran");
  } catch (error) {
    check(`refused: ${message}`, String(error).includes(message), String(error));
  }
}

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
    docker("rm", "-f", HELPER);
    docker("volume", "rm", "-f", VOLUME);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(join(DIR, ".dev.vars"), { force: true });
    process.exit(130);
  });
}

process.exitCode = await main();
