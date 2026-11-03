// The team's move behind Access end to end, locally (WP8.11, D50, D60), on WP3.41's harness
// (update-window-e2e.ts): the installer's real `update --team-admission members` (update.ts,
// team-move.ts), the production web Worker and the production OmnigentServer in one
// `wrangler dev`, whose watchdog starts and replaces the server image's real container (built
// from the Omnigent source the final pin will hold) through Docker (`github-setup-platform-e2e.ts`).
// Cloudflare is a stand-in: each deploy or secrets change restarts `wrangler dev` with that
// version's variables and secrets, and Workers Logs are the platform Worker's own lines. Access
// is a stand-in too: the web Worker checks assertions signed with a synthetic team key; the
// installer's Access, group and token APIs are the installer tests' fakes (fake-cloud.ts), with
// the member group served over HTTP on the loopback address to the platform Worker's own group
// client, whose transport the e2e entrypoint injects (`CFO_E2E_ACCESS_API`; production code reads
// no such setting). The server image is the production one, unchanged: its container's hosts name
// `platform.internal` on its own loopback, where a relay in its network namespace takes each
// call to a Unix socket and the e2e platform Worker's `/__e2e/platform-internal/` route, the
// production `PlatformInternal` entrypoint (the host's firewall keeps the Docker bridge from
// reaching the host, and the loopback keeps it local).
// No real account or Cloudflare resource is involved; every value is synthetic.
//
//   1. An installation, released, owner admission: its owner signs in; the CLI's sign-in sets no
//      cookie; this computer's host (a WebSocket client speaking the host protocol, with that
//      sign-in) connects; another person's Access sign-in is refused at the web Worker.
//   2. `update --team-admission members`: the member group (the owner alone) and its token are
//      made, the update deploys in bind mode and is accepted; the move then waits for the owner's
//      browser sign-in. The host's CLI session, as its bearer, as a request's bearer and as a
//      cookie, never takes the founding binding (F-1).
//   3. The owner's browser sign-in founds the binding; the next run sees the owner bound, the
//      member group written and this computer's host connecting as its owner, then requires
//      Access's sign-in (the server restarts once, the host reconnects), checks again from the
//      required server, deploys members admission and switches the Access application to the
//      member group (read back): finished.
//   4. Members admission: the owner invites a second person; the member group gets the address;
//      that person, through Access, joins by the invitation and works; the owner's credential is
//      refused from another person's Access sign-in, and an uninvited one cannot sign in.
//
//   docker build -f images/server/Dockerfile --target server -t cfo-wp811-e2e-server:runtime .
//   node worker/test/e2e/team-move-e2e.ts [results.json]
//
// Environment: CFO_E2E_SERVER_IMAGE (default cfo-wp811-e2e-server:runtime), CFO_E2E_DIR (default
// ~/.pt/wp811-e2e) for Wrangler's local state, the logs and the results. The Docker containers
// (cfo-wp811-e2e-server, cfo-wp811-e2e-relay) and the replica's volume (cfo-wp811-e2e-replica)
// are removed afterwards.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapCloud,
  type BootstrapState,
  type StateStore,
  VersionNotDeleted,
  type WorkerIdentity,
} from "../../../scripts/bootstrap/machine.ts";
import {
  INITIALIZED_SECRET,
  type Installation,
  PASSWORD_SECRET,
  PLATFORM_FEATURES,
} from "../../../scripts/bootstrap/settings.ts";
import {
  type AccessGroupsApi,
  teamAdmissionVars,
} from "../../../scripts/bootstrap/team-admission.ts";
import {
  ACCESS_GROUP_TOKEN_SECRET,
  IDENTITY_MODE_VAR,
  TEAM_MOVE_SECRET,
} from "../../../scripts/bootstrap/team-move.ts";
import { FakeWorld } from "../../../scripts/bootstrap/test/fake-cloud.ts";
import {
  runUpdate,
  type UpdateContext,
  type UpdateOptions,
  type UpdateOutcome,
} from "../../../scripts/bootstrap/update.ts";
import { latestNotDeployed } from "../../../scripts/bootstrap/window.ts";
import { readWranglerConfig } from "../../../scripts/staging/cloud.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { RESTORE_POINT_VAR } from "../../src/server/maintenance.ts";
import {
  AUD,
  claims,
  makeKey,
  OWNER_EMAIL,
  OWNER_SUB,
  SALT,
  sign,
  TEAM,
} from "../support/access-keys.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "..");
const REPO = join(WORKER, "..");
const DIR = process.env.CFO_E2E_DIR ?? join(homedir(), ".pt", "wp811-e2e");
const OUT = process.argv[2] ?? join(DIR, "results.json");
const IMAGE = process.env.CFO_E2E_SERVER_IMAGE ?? "cfo-wp811-e2e-server:runtime";
const CONTAINER = "cfo-wp811-e2e-server";
const RELAY = "cfo-wp811-e2e-relay";
const VOLUME = "cfo-wp811-e2e-replica";
const RELAY_DIR = join(DIR, "relay");
const RELAY_SOCKET = join(RELAY_DIR, "platform.sock");
/** The relay's port on the server container's own loopback: platform.internal's, HTTP. */
const RELAY_PORT = 80;
const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
const PLATFORM = "cloudflare-omnigent";
const ACCOUNT = "1".repeat(32);
const REPLICA = "file:///replica-root/omnigent";
const CODE = { install: "1".repeat(40), a: "a".repeat(40) };
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const CANARY = ["CFO", "CANARY", ""].join("_");
const OWNER_PASSWORD = `${CANARY}E2EOWNER${randomBytes(6).toString("hex")}`;
const MEMBER_PASSWORD = `${CANARY}E2EMEMBER${randomBytes(6).toString("hex")}`;
const MEMBER_EMAIL = "member@example.invalid";
const MEMBER_SUB = "00000000-0000-4000-8000-000000000002";
const STRANGER_EMAIL = "stranger@example.invalid";
const STRANGER_SUB = "00000000-0000-4000-8000-000000000003";
/** This computer's host, as its configuration names it. */
const HOST_ID = randomUUID();
const HOST_KEY = HOST_ID.replaceAll("-", "");

/**
 * The relay inside the server container's network namespace: its loopback port to the Unix
 * socket the run listens on (bind-mounted), byte for byte.
 */
const FORWARDER = `
import asyncio
async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass
async def handle(reader, writer):
    try:
        upstream_reader, upstream_writer = await asyncio.open_unix_connection("/relay/platform.sock")
    except Exception:
        writer.close()
        return
    await asyncio.gather(pipe(reader, upstream_writer), pipe(upstream_reader, writer))
async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", ${RELAY_PORT})
    async with server:
        await server.serve_forever()
asyncio.run(main())
`;

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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function stopContainers(): void {
  docker("rm", "-f", RELAY);
  docker("rm", "-f", CONTAINER);
}

/**
 * The control server: the watchdog's starts and stops, carried out with Docker, the relay
 * started beside each server container. A start answers once Omnigent answers its health check,
 * or with the exit code once the container exits, as the runtime's `monitor()`.
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
    const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as {
      env?: Record<string, string>;
    };
    if (request.url === "/start") {
      stopContainers();
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
        // platform.internal, which the runtime's intercept serves in production: here, the
        // container's own loopback, where the relay listens.
        "--add-host",
        "platform.internal:127.0.0.1",
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
      docker(
        "run",
        "-d",
        "--name",
        RELAY,
        "--network",
        `container:${CONTAINER}`,
        "-v",
        `${RELAY_DIR}:/relay`,
        "--entrypoint",
        "python",
        IMAGE,
        "-c",
        FORWARDER,
      );
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
      stopContainers();
      return reply({ exitCode: state.code });
    }
    if (request.url === "/kill") {
      keepLogs();
      stopContainers();
      return reply({ exitCode: 137 });
    }
    response.writeHead(404);
    response.end();
  });
}

/**
 * The run's end of the relay, on the Unix socket: each call to `platform.internal` goes to the
 * e2e platform Worker's `/__e2e/platform-internal/` route, headers and body as sent.
 */
function relayServer(local: () => string): Server {
  return createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value !== "string") continue;
        if (["host", "connection", "content-length", "transfer-encoding"].includes(name)) continue;
        headers.set(name, value);
      }
      const answer = await fetch(`${local()}/__e2e/platform-internal${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
      });
      const text = Buffer.from(await answer.arrayBuffer());
      response.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/json",
        connection: "close",
      });
      response.end(text);
    } catch {
      response.writeHead(503, { connection: "close" });
      response.end();
    }
  });
}

interface AccessGroup {
  id: string;
  name: string;
  include: unknown[];
  exclude?: unknown[];
  require?: unknown[];
}

/**
 * Cloudflare's Access groups API, as the platform Worker's group client calls it: GET and PUT of
 * one group, with the token the installer made (refused with any other).
 */
function accessGroupsServer(
  groups: Map<string, AccessGroup>,
  token: () => string | undefined,
  writes: AccessGroup[],
  reads: { count: number },
): Server {
  return createServer(async (request, response) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const body = await readBody(request);
    const expected = token();
    if (expected === undefined || request.headers.authorization !== `Bearer ${expected}`) {
      return json(403, {
        success: false,
        errors: [{ code: 10000, message: "Authentication error" }],
      });
    }
    const match = /^\/accounts\/([0-9a-f]{32})\/access\/groups\/([0-9a-f-]{36})$/.exec(
      request.url ?? "",
    );
    const group = match === null || match[1] !== ACCOUNT ? undefined : groups.get(match[2] ?? "");
    if (group === undefined) return json(404, { success: false, errors: [{ code: 12130 }] });
    if (request.method === "GET") {
      reads.count += 1;
      return json(200, { success: true, result: group });
    }
    if (request.method === "PUT") {
      const next = JSON.parse(body.toString("utf8")) as Omit<AccessGroup, "id">;
      const written: AccessGroup = { ...next, id: group.id };
      groups.set(group.id, written);
      writes.push(structuredClone(written));
      return json(200, { success: true, result: written });
    }
    return json(405, { success: false });
  });
}

function emailsOf(group: AccessGroup | undefined): string[] {
  return (group?.include ?? [])
    .map((rule) => (rule as { email?: { email?: string } }).email?.email ?? "?")
    .sort();
}

/** This computer's host: Omnigent's host protocol over the tunnel, reconnecting until stopped. */
class FakeHost {
  #socket: WebSocket | null = null;
  #stopped = false;
  opens = 0;
  readonly closes: string[] = [];
  readonly url: string;
  readonly headers: () => Record<string, string>;

  constructor(url: string, headers: () => Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }

  connect(): void {
    if (this.#stopped) return;
    const socket = new WebSocket(this.url, { headers: this.headers() } as unknown as string[]);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.opens += 1;
      socket.send(
        JSON.stringify({
          kind: "host.hello",
          version: "0.1.0-e2e",
          frame_protocol_version: 1,
          name: "e2e-host",
          runners: [],
          configured_harnesses: null,
          gateway_inference: null,
          interactive_shells: null,
          telemetry_opt_out: true,
          installation_id: null,
          capabilities: ["runner_replacement_targets"],
          connection_id: null,
          incarnation: null,
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { kind?: string; ts?: unknown };
        if (frame.kind === "ping") socket.send(JSON.stringify({ kind: "pong", ts: frame.ts }));
      } catch {
        // not a frame this host answers
      }
    });
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", (event) => {
      this.closes.push(`${event.code} ${event.reason}`.trim());
      if (this.#socket === socket) this.#socket = null;
      if (!this.#stopped) setTimeout(() => this.connect(), 2_000);
    });
  }

  get open(): boolean {
    return this.#socket?.readyState === 1;
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.close();
  }
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

const RENDERED = [join(HERE, `.team-move-e2e-${process.pid}.web.json`), join(DIR, "platform.json")];

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

/** A cookie's `name=value` from a response's Set-Cookie headers, or undefined. */
function cookieOf(response: Response): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0]?.trim();
    if (pair?.includes("=") && !pair.endsWith("=")) return pair;
  }
  return undefined;
}

async function main(): Promise<number> {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  mkdirSync(RELAY_DIR, { recursive: true, mode: 0o700 });
  stopContainers();
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
  const relay = relayServer(() => local);
  await new Promise<void>((resolve) => relay.listen(RELAY_SOCKET, resolve));
  chmodSync(RELAY_SOCKET, 0o600);

  // Cloudflare's Access, the installer's side (fake-cloud.ts), and the member group served to the
  // platform Worker's client over HTTP.
  const plan: Installation = {
    installationId: INSTALLATION,
    accountId: ACCOUNT,
    platformWorker: "cfo-stg-wp811-platform",
    webWorker: "cfo-stg-wp811-web",
    hostname: "cfo-stg-wp811-web.example.test",
    ownerPin: await makeOwnerPin(OWNER_EMAIL, new Uint8Array(32).fill(7)),
    ownerUsername: "owner",
    replica: { url: REPLICA },
    target: {
      kind: "staging",
      owner: "WP8.11",
      platformSuffix: "wp811-platform",
      webSuffix: "wp811-web",
      days: 1,
    },
    plannedAt: new Date().toISOString(),
  };
  const world = new FakeWorld(plan);
  world.teamDomain = TEAM;
  const groups = new Map<string, AccessGroup>();
  const groupWrites: AccessGroup[] = [];
  const groupReads = { count: 0 };
  const groupsApi: AccessGroupsApi = {
    groups: () => [...groups.values()].map((g) => structuredClone(g)),
    group: (id) => structuredClone(groups.get(id)),
    createGroup: (body) => {
      const id = randomUUID();
      groups.set(id, { ...(structuredClone(body) as Omit<AccessGroup, "id">), id });
      return id;
    },
  };
  const tokenValue = () => [...world.tokens.values()].at(-1)?.value;
  const accessGroups = accessGroupsServer(groups, tokenValue, groupWrites, groupReads);
  const accessGroupsPort = await listen(accessGroups);

  const ownerPin = await makeOwnerPin(OWNER_EMAIL, SALT);
  const ingressVars = (admission: "owner" | "members"): Record<string, string> => ({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: "127.0.0.1",
    OWNER_EMAIL_HASH: ownerPin,
    ACCESS_CERTS_URL_LOCAL_ONLY: `http://127.0.0.1:${certsPort}`,
    ...(admission === "members" ? { TEAM_ADMISSION: "members" } : {}),
  });
  const plain: Record<string, string> = {
    CFO_INSTALLATION_ID: INSTALLATION,
    CFO_PLATFORM_FEATURES: PLATFORM_FEATURES.join(" "),
    CFO_E2E_SERVER_PORTS: JSON.stringify(ports),
    CFO_E2E_CONTROL: `http://127.0.0.1:${controlPort}`,
    CFO_E2E_CONTROL_TOKEN: token,
    CFO_E2E_ACCESS_API: `http://127.0.0.1:${accessGroupsPort}`,
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

  // Cloudflare's versions, as update-window-e2e.ts keeps them; the web Worker's admission is the
  // one setting of its deploys the stand-in carries (a restart with `TEAM_ADMISSION`).
  interface Version {
    readonly id: string;
    readonly vars: Record<string, string>;
    readonly secrets: Record<string, string>;
  }
  const versions: Version[] = [];
  let uploads: Version[] = [];
  const latest = () => uploads.at(-1) as Version;
  let next = 1;
  let current: Version = { id: `v${next++}`, vars: { ...plain }, secrets: { ...installed } };
  let webVersion = "w1";
  let webAdmission = "owner" as "owner" | "members";
  let wrangler: Wrangler | null = null;
  const restart = async () => {
    await stopWrangler(wrangler);
    const ingress = ingressVars(webAdmission);
    wrangler = startWrangler(port, configs(current.vars), ingress, current.secrets, current.id);
    await waitFor("wrangler dev", async () => (await fetch(`${local}/__e2e/cron`)).ok, 120_000);
  };
  const activate = async (version: Version, uploaded = true) => {
    current = version;
    versions.push(version);
    if (uploaded) uploads.push(version);
    await restart();
  };
  const installerOutput: string[] = [];
  let host: FakeHost | null = null;
  try {
    const now = Math.floor(Date.now() / 1000);
    const assertion = (email: string, sub: string) =>
      sign(key, claims(now, { email, sub, exp: now + 4 * 3600 }));
    const owner = await assertion(OWNER_EMAIL, OWNER_SUB);
    const member = await assertion(MEMBER_EMAIL, MEMBER_SUB);
    const stranger = await assertion(STRANGER_EMAIL, STRANGER_SUB);
    const visit = (as: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-access-jwt-assertion", as);
      return fetch(`${local}${path}`, { ...init, headers, redirect: "manual" });
    };
    const post = (as: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
      visit(as, path, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    /** A password sign-in: the browser's (a cookie) or the CLI's (`issue_refresh`, a token). */
    const login = async (as: string, cli: boolean) => {
      const answer = await post(as, "/auth/login", {
        username: "owner",
        password: OWNER_PASSWORD,
        ...(cli ? { issue_refresh: true } : {}),
      });
      const text = await answer.text();
      if (answer.status !== 200) throw new Error(`login answered ${answer.status}: ${text}`);
      return { token: (JSON.parse(text) as { token: string }).token, cookie: cookieOf(answer) };
    };
    const serverAnswers = () =>
      waitFor(
        "Omnigent through the web Worker",
        async () => (await visit(owner, "/v1/info")).ok,
        600_000,
      );
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
    /** The newest team line of the version serving, once one is newer than `after`. */
    const teamLine = (after: number) =>
      waitFor(
        "a team status line",
        async () => {
          const line = printed.findLast(
            (p) =>
              p.at > after &&
              p.version === current.id &&
              p.line.cfo === "bootstrap" &&
              typeof p.line.teamMove === "string" &&
              p.line.team !== null &&
              p.line.team !== undefined,
          );
          return line?.line ?? null;
        },
        120_000,
      );

    // 1. The installation, released, owner admission: the owner, this computer's host.
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
    const cli = await login(owner, true);
    check(
      "the installation's owner signs in: the CLI's sign-in, a token in the body and no cookie",
      cli.token.length > 0 && cli.cookie === undefined,
      String(cli.cookie?.split("=")[0]),
    );
    // The session cookie's name, from a browser's sign-in while no proxy sign-in is bound.
    const sessionCookie = (await login(owner, false)).cookie?.split("=")[0] ?? "omnigent_session";
    host = new FakeHost(`ws://${hostname}/v1/hosts/${HOST_ID}/tunnel`, () => ({
      "cf-access-jwt-assertion": owner,
      authorization: `Bearer ${cli.token}`,
    }));
    host.connect();
    await waitFor("this computer's host connected", async () => host?.open === true, 60_000);
    check("this computer's host connects through the web Worker", true, `opens ${host.opens}`);
    const memberBefore = await visit(member, "/v1/info");
    check(
      "owner admission: another person's Access sign-in is refused at the web Worker",
      memberBefore.status === 403,
      `${memberBefore.status}`,
    );

    // The installer's state and the Cloudflare stand-in.
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
            vars: {
              CFO_INSTALLATION_ID: INSTALLATION,
              ...(webAdmission === "members" ? { TEAM_ADMISSION: "members" } : {}),
            },
          };
    // What the update adds to the platform Worker's variables that the stand-in carries: its
    // deploy, its window, and the team's settings.
    const carried = [
      "SERVER_ENV_CFO_DEPLOY_ID",
      RESTORE_POINT_VAR,
      ...Object.keys(teamAdmissionVars(plan, "x").platform),
    ];
    const cloud: BootstrapCloud = {
      async secretNames(worker) {
        return worker === plan.platformWorker ? Object.keys(latest().secrets).sort() : [];
      },
      async access() {
        return { teamDomain: TEAM, aud: AUD };
      },
      async deployPlatform(_plan, config, secrets) {
        const vars = (config.vars ?? {}) as Record<string, string>;
        const picked = Object.fromEntries(
          Object.entries(vars).filter(([name]) => carried.includes(name)),
        );
        await activate({
          id: `v${next++}`,
          vars: { ...plain, ...picked },
          secrets: { ...latest().secrets, ...secrets },
        });
      },
      async deployWeb(_plan, config) {
        webVersion = `w${next++}`;
        const vars = ((config as { vars?: Record<string, unknown> }).vars ?? {}) as Record<
          string,
          unknown
        >;
        const admission = vars.TEAM_ADMISSION === "members" ? "members" : "owner";
        if (admission !== webAdmission) {
          webAdmission = admission;
          await restart();
        }
      },
      async workerInstallation(worker) {
        return identity(worker);
      },
      async updateSecrets(worker, changes) {
        if (worker !== plan.platformWorker) throw new Error("only the platform Worker's");
        if (latest().id !== current.id) throw new Error(latestNotDeployed(worker));
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
        await activate({ ...version }, false);
      },
      async versions(worker) {
        if (worker !== plan.platformWorker) throw new Error("only the platform Worker's");
        return uploads.map((v) => ({ id: v.id, number: Number(v.id.slice(1)) })).reverse();
      },
      async deleteVersion(_worker, versionId) {
        if (versionId === current.id || !uploads.some((v) => v.id === versionId)) {
          throw new VersionNotDeleted(`no version ${versionId} to delete`);
        }
        uploads = uploads.filter((v) => v.id !== versionId);
      },
      async deleteLatestSecrets(_worker, names) {
        const secrets = { ...latest().secrets };
        for (const name of names) delete secrets[name];
        uploads.push({ id: `v${next++}`, vars: latest().vars, secrets });
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
      accessApi: world.accessApi(),
      ownerEmail: OWNER_EMAIL,
      team: {
        requested: true,
        supported: true,
        groups: groupsApi,
        tokens: world.tokenApi(),
        hostId: HOST_KEY,
        hostConfig: "the run's host",
      },
    });
    const options: UpdateOptions = {
      verify: true,
      pollMs: 3_000,
      switchMs: 2_000,
      verifyWaitMs: 10 * 60_000,
      acceptWaitMs: 5 * 60_000,
      teamWaitMs: 5 * 60_000,
    };

    // 2. The update: member group, token, bind mode, accepted; then it waits for the owner.
    const first: UpdateOutcome = await runUpdate(context(CODE.a), {
      ...options,
      teamWaitMs: 60_000,
    });
    const team = () => state.journal.team;
    const groupId = team()?.memberGroup?.id ?? "none";
    check(
      "the update made the member group with the owner's address alone, and its token",
      emailsOf(groups.get(groupId)).join(",") === OWNER_EMAIL &&
        team()?.token?.id !== undefined &&
        current.secrets[ACCESS_GROUP_TOKEN_SECRET] === tokenValue(),
      JSON.stringify(emailsOf(groups.get(groupId))),
    );
    check(
      "the update deployed in bind mode, with the move's ID, the envelope and the group's settings",
      current.secrets[IDENTITY_MODE_VAR] === "bind" &&
        current.secrets[TEAM_MOVE_SECRET] === team()?.id &&
        current.vars.CFO_IDENTITY_ENVELOPE === "on" &&
        current.vars.CFO_ACCESS_GROUP_ID === groupId &&
        current.vars.SERVER_ENV_CFO_ACCESS_ADMISSION === "true" &&
        webAdmission === "owner" &&
        state.journal.window === undefined &&
        state.journal.restorePoints?.at(-1)?.outcome === "accepted",
    );
    check(
      "the move then waits for the owner's browser sign-in, and says how to give it",
      first.kind === "team" &&
        first.state === "waiting" &&
        /sign in to Omnigent once with your password/.test(first.why),
      JSON.stringify(first),
    );
    await waitFor("this computer's host reconnected in bind mode", async () => host?.open, 120_000);
    // F-1 on the real path: the CLI's session token, as a request's bearer and as a cookie, with
    // the owner's Access sign-in; the host connects with it too.
    const asBearer = await visit(owner, "/v1/agents", {
      headers: { authorization: `Bearer ${cli.token}` },
    });
    const asCookie = await visit(owner, "/v1/agents", {
      headers: { cookie: `${sessionCookie}=${cli.token}` },
    });
    const afterCli = Date.now();
    const unbound = await teamLine(afterCli + 1_000);
    const unboundTeam = unbound.team as {
      ownersBound: number;
      hosts: { hostId: string; identity: string }[];
    };
    check(
      "the CLI's session, as the host's bearer, a request's bearer or a cookie, never founds the owner",
      asBearer.status === 200 &&
        asCookie.status === 200 &&
        unboundTeam.ownersBound === 0 &&
        unboundTeam.hosts.some((h) => h.hostId === HOST_KEY && h.identity === "unbound"),
      `bearer ${asBearer.status}, cookie ${asCookie.status}, ${JSON.stringify(unboundTeam)}`,
    );

    // 3. The owner's browser sign-in founds the binding; the move goes on to the end.
    const browser = await login(owner, false);
    check("the owner's browser sign-in sets a session cookie", browser.cookie !== undefined);
    const ownerCookie = browser.cookie ?? "";
    const finished = await runUpdate(context(CODE.a), options);
    const record = team();
    check(
      "the next run checks the owner bound, the group written and the host as its owner, then finishes",
      finished.kind === "team" &&
        finished.state === "finished" &&
        record?.boundAt !== undefined &&
        record.requiredAt !== undefined &&
        record.webAt !== undefined &&
        record.policyAt !== undefined &&
        record.finishedAt !== undefined &&
        record.hostId === HOST_KEY,
      JSON.stringify(finished),
    );
    const requiredLine = printed.findLast(
      (p) => p.line.cfo === "bootstrap" && p.line.identityMode === "required" && p.line.team,
    );
    const requiredTeam = requiredLine?.line.team as
      | { ownersBound: number; revision: number; hosts: { hostId: string; identity: string }[] }
      | undefined;
    check(
      "in required mode, the restarted server reported the owner bound and the host, reconnected, as its owner",
      requiredTeam !== undefined &&
        requiredTeam.ownersBound >= 1 &&
        requiredTeam.hosts.some((h) => h.hostId === HOST_KEY && h.identity === "owner") &&
        (requiredLine?.line.admissionApplied ?? null) !== null,
      JSON.stringify(requiredTeam),
    );
    const app = state.journal.accessApp?.id
      ? (world.accessApps.get(state.journal.accessApp.id) as
          | { policies?: { include?: unknown[] }[] }
          | undefined)
      : undefined;
    check(
      "Access's application allows the member group (read back), the web Worker admits members, the move's secret is gone",
      JSON.stringify(app?.policies ?? []).includes(groupId) &&
        webAdmission === "members" &&
        current.secrets[IDENTITY_MODE_VAR] === "required" &&
        current.secrets[TEAM_MOVE_SECRET] === undefined,
      JSON.stringify(app?.policies ?? []),
    );
    check(
      "the platform Worker applied revision 1 with the installer's token: it read the group, which already held the owner alone, and wrote nothing",
      groupReads.count > 0 &&
        groupWrites.length === 0 &&
        requiredLine?.line.admissionApplied === 1 &&
        requiredTeam?.revision === 1,
      `${groupReads.count} reads, ${groupWrites.length} writes, applied ${String(requiredLine?.line.admissionApplied)}`,
    );
    await waitFor("this computer's host reconnected", async () => host?.open, 120_000);

    // 4. Members admission: an invitation, the member group, the person joining through Access.
    const ownerHeaders = { cookie: ownerCookie };
    const teamPage = await visit(owner, "/v1/team", { headers: ownerHeaders });
    check("the owner's browser session works in required mode", teamPage.status === 200);
    const invited = await post(
      owner,
      "/v1/team/invitations",
      { email: MEMBER_EMAIL, role: "member" },
      ownerHeaders,
    );
    const invitation = (await invited.json()) as { invite_url?: string };
    const inviteToken = new URL(invitation.invite_url ?? "https://x.invalid/").searchParams.get(
      "invite",
    );
    check(
      "the owner invites a second person",
      invited.status === 200 && inviteToken !== null,
      `${invited.status}`,
    );
    await waitFor(
      "the member group with the invited address",
      async () => emailsOf(groups.get(groupId)).includes(MEMBER_EMAIL),
      120_000,
    );
    check(
      "the platform Worker wrote the invited address into Access's member group",
      emailsOf(groups.get(groupId)).join(",") === [MEMBER_EMAIL, OWNER_EMAIL].sort().join(","),
      JSON.stringify(emailsOf(groups.get(groupId))),
    );
    const joined = await post(member, "/auth/register", {
      invite: inviteToken,
      username: "member",
      password: MEMBER_PASSWORD,
    });
    const memberCookie = cookieOf(joined) ?? "";
    const memberWork = await visit(member, "/v1/agents", { headers: { cookie: memberCookie } });
    check(
      "the invited person, through Access, joins by the invitation and works",
      joined.status === 200 && memberWork.status === 200,
      `register ${joined.status}, agents ${memberWork.status}`,
    );
    const memberAdmin = await visit(member, "/v1/team", { headers: { cookie: memberCookie } });
    check(
      "a member cannot administer the team",
      memberAdmin.status === 403,
      `${memberAdmin.status}`,
    );
    const ownersFromOther = await visit(member, "/v1/agents", {
      headers: { authorization: `Bearer ${cli.token}` },
    });
    check(
      "the owner's credential is refused from another person's Access sign-in",
      ownersFromOther.status === 401 || ownersFromOther.status === 403,
      `${ownersFromOther.status}`,
    );
    const strangerLogin = await post(stranger, "/auth/login", {
      username: "owner",
      password: OWNER_PASSWORD,
    });
    check(
      "an Access sign-in nobody invited cannot sign in as the owner",
      strangerLogin.status === 401 || strangerLogin.status === 403,
      `${strangerLogin.status}`,
    );

    // No secret anywhere it should not be.
    writeFileSync(join(DIR, "installer.log"), `${installerOutput.join("\n")}\n`, { mode: 0o600 });
    const values = [
      OWNER_PASSWORD,
      MEMBER_PASSWORD,
      installed.SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET ?? "missing",
      tokenValue() ?? "missing",
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
        !JSON.stringify(state).includes(tokenValue() ?? "missing"),
      `canary-scan exit ${scan.status}`,
    );
  } catch (error) {
    check("the run", false, error instanceof Error ? error.message : String(error));
  } finally {
    host?.stop();
    const logs = docker("logs", CONTAINER);
    writeFileSync(join(DIR, "server.log"), `${logs.stdout}${logs.stderr}`, { flag: "a" });
    await stopWrangler(wrangler);
    for (const server of [certs, control, relay, accessGroups]) server.close();
    stopContainers();
    docker("volume", "rm", "-f", VOLUME);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(join(DIR, "state"), { recursive: true, force: true });
    rmSync(RELAY_DIR, { recursive: true, force: true });
    rmSync(join(DIR, ".dev.vars"), { force: true });
  }
  writeFileSync(
    OUT,
    `${JSON.stringify({ at: new Date().toISOString(), image: IMAGE, checks }, null, 2)}\n`,
  );
  return checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1;
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
    stopContainers();
    docker("volume", "rm", "-f", VOLUME);
    for (const file of RENDERED) rmSync(file, { force: true });
    rmSync(RELAY_DIR, { recursive: true, force: true });
    rmSync(join(DIR, ".dev.vars"), { force: true });
    process.exit(130);
  });
}

process.exitCode = await main();
