// The watchdog drill (WP2.6, AIR2-010 and AIR2-009): the production watchdog's decisions
// (`step` in src/server/watchdog.ts, with the timing and settings OmnigentServer gives it) drive
// the real server image in Docker, against an S3 stand-in behind Toxiproxy, at `basic`'s quarter
// CPU and 1 GiB. Laptop only, test tooling; never shipped. Every credential is generated for the
// stack and kept in its directory (mode 600); no log or result holds one (canary scan at the end).
//
//   node worker/test/drill/watchdog-drill.ts up                  the stack (MinIO, Toxiproxy, bucket)
//   node worker/test/drill/watchdog-drill.ts seed <prefix> <MB>  a replica of that size, written by
//                                                                 the image itself (a fresh install)
//   node worker/test/drill/watchdog-drill.ts run <scenario> [--prefix p] [--image i] [--cpus c]
//   node worker/test/drill/watchdog-drill.ts down                remove the containers and the stack
//
// Scenarios (each starts from a stopped server, as after a loss, and records every check):
//   restore         the start after a loss, until the server answers (the representative 1 GB case)
//   hung-init       the app's initialization never ends: stopped once its budget is used up
//   restore-deadline  CFO_RESTORE_DEADLINE_S=10: recovery mode, never restarted
//   recovery-exit   the replica blackholed, then back: recovery, the entrypoint's own retry, then
//                   a start the watchdog follows (add --hang for a hung app after recovery)
//   exit-78         a malformed setting: held, then started once the setting is corrected
//   refused         Cloudflare refuses the first two starts (DC-37's backoff)
//
// What differs from OmnigentServer: the container port is the Docker CLI (a refused start is
// injected, not Cloudflare's), checks run at the times the watchdog asks for in real time, and
// the last look before a stop, the intercepts and the bootstrap check are left out. The Workers
// runtime tests cover those with a fake container; the staging run covers the whole object.
//
// State and results: $CFO_DRILL_DIR (default $HOME/.pt/drill): stack.json (credentials, mode 600),
// runs/<scenario>-<time>/ (timeline.jsonl, summary.json, containers/*.log).

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configFingerprint,
  serverContainerEnv,
  serverDeadlines,
} from "../../src/server/server-env.ts";
import {
  ANSWERING,
  type EntrypointPhase,
  INITIAL_WATCHDOG_STATE,
  type Observation,
  randomOutageId,
  signalled,
  step,
  WATCHDOG_TIMING,
  type WatchdogState,
  type WatchdogTiming,
} from "../../src/server/watchdog.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const COMPOSE = join(ROOT, "images", "server", "tests", "integration", "compose.yaml");
const PROJECT = "cfo-drill";
const NETWORK = `${PROJECT}_default`;
const BUCKET = "cfo-drill-replica";
const DIR = process.env.CFO_DRILL_DIR ?? join(process.env.HOME ?? ".", ".pt", "drill");
const DEFAULT_IMAGE = process.env.CFO_DRILL_IMAGE ?? "cfo-server:dev";
const INSTALLATION_ID = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc"; // synthetic
/** The DO's probe timeout and the pause before a failed health check is repeated. */
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_RETRY_MS = 1_000;

interface Stack {
  readonly s3User: string;
  readonly s3Password: string;
  readonly cookieSecret: string;
  readonly ownerPassword: string;
  readonly s3Port: number;
  readonly toxiPort: number;
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const iso = (ms: number) => new Date(ms).toISOString();

function sh(command: string, args: readonly string[], input?: string): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} exited ${result.status}: ${result.stderr.slice(-800)}`,
    );
  }
  return result.stdout;
}

const docker = (...args: string[]) => sh("docker", args);
function dockerQuiet(...args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { ok: result.status === 0, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function loadStack(): Stack {
  const path = join(DIR, "stack.json");
  if (!existsSync(path)) throw new Error("no stack: run `up` first");
  return JSON.parse(readFileSync(path, "utf8")) as Stack;
}

function composeEnv(stack: Pick<Stack, "s3User" | "s3Password">): NodeJS.ProcessEnv {
  return { ...process.env, CFO_IT_S3_USER: stack.s3User, CFO_IT_S3_PASSWORD: stack.s3Password };
}

function mappedPort(container: string, port: number): number {
  const out = docker("port", container, `${port}/tcp`).trim().split("\n")[0] ?? "";
  return Number(out.slice(out.lastIndexOf(":") + 1));
}

// ---------------------------------------------------------------------------------------------
// The stack

async function up(): Promise<void> {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const secrets = {
    s3User: `cfo${hex(6)}`,
    s3Password: hex(20),
    cookieSecret: hex(32),
    ownerPassword: `owner-${hex(12)}`,
  };
  const result = spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE, "up", "-d"], {
    env: composeEnv(secrets),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`compose up: ${result.stderr.slice(-800)}`);
  const s3Port = mappedPort(`${PROJECT}-minio-1`, 9000);
  const toxiPort = mappedPort(`${PROJECT}-toxiproxy-1`, 8474);
  const stack: Stack = { ...secrets, s3Port, toxiPort };
  writeFileSync(join(DIR, "stack.json"), JSON.stringify(stack), { mode: 0o600 });
  chmodSync(join(DIR, "stack.json"), 0o600);
  // The bucket, through boto3 as the image tests make theirs.
  const script = [
    "import boto3, sys, time",
    "s3 = boto3.client('s3', endpoint_url=sys.argv[1], region_name='us-east-1',",
    "    aws_access_key_id=sys.argv[2], aws_secret_access_key=sys.argv[3])",
    "for _ in range(60):",
    "    try:",
    `        s3.create_bucket(Bucket='${BUCKET}'); break`,
    "    except s3.exceptions.BucketAlreadyOwnedByYou: break",
    "    except Exception: time.sleep(1)",
    "else: sys.exit('no bucket')",
  ].join("\n");
  sh("uv", [
    "run",
    "--no-project",
    "--with",
    "boto3==1.40.0",
    "python",
    "-I",
    "-c",
    script,
    `http://127.0.0.1:${s3Port}`,
    stack.s3User,
    stack.s3Password,
  ]);
  await resetLink(stack);
  console.log(JSON.stringify({ drill: "up", s3Port, toxiPort, dir: DIR }));
}

async function toxi(stack: Stack, method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${stack.toxiPort}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  await response.body?.cancel();
}

/** The "R2" link: Toxiproxy's `r2` proxy in front of MinIO, with no toxic. */
async function resetLink(stack: Stack): Promise<void> {
  await toxi(stack, "DELETE", "/proxies/r2");
  await toxi(stack, "POST", "/proxies", {
    name: "r2",
    listen: "0.0.0.0:9000",
    upstream: "minio:9000",
    enabled: true,
  });
}

/** Connections open and no data flows, as in the image tests' blackhole. */
async function blackhole(stack: Stack): Promise<void> {
  for (const stream of ["upstream", "downstream"]) {
    await toxi(stack, "POST", "/proxies/r2/toxics", {
      name: `bh_${stream}`,
      type: "timeout",
      stream,
      attributes: { timeout: 0 },
    });
  }
}

function down(): void {
  for (const name of docker("ps", "-a", "--format", "{{.Names}}").split("\n")) {
    if (name.startsWith(`${PROJECT}-srv-`) || name.startsWith(`${PROJECT}-seed-`)) {
      dockerQuiet("rm", "-f", name);
    }
  }
  const stack = existsSync(join(DIR, "stack.json")) ? loadStack() : null;
  spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE, "down", "-v"], {
    env: stack
      ? composeEnv(stack)
      : { ...process.env, CFO_IT_S3_USER: "x", CFO_IT_S3_PASSWORD: "x" },
    encoding: "utf8",
  });
  rmSync(join(DIR, "stack.json"), { force: true });
  console.log(JSON.stringify({ drill: "down" }));
}

// ---------------------------------------------------------------------------------------------
// The server's environment, as the Worker passes it (SERVER_ENV_<NAME> → <NAME>)

function workerEnv(
  stack: Stack,
  prefix: string,
  extra: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    CFO_INSTALLATION_INITIALIZED: "true",
    CFO_REPLICA_URL: `s3://${BUCKET}/${prefix}`,
    CFO_REPLICA_ENDPOINT: "http://toxiproxy:9000",
    CFO_REPLICA_REGION: "us-east-1",
    LITESTREAM_ACCESS_KEY_ID: stack.s3User,
    LITESTREAM_SECRET_ACCESS_KEY: stack.s3Password,
    // The watchdog's decisions are this drill's subject and it uploads no file: artifacts stay
    // on the container's disk, which the image allows for tests only (G2-DUR-001).
    CFO_ALLOW_LOCAL_ARTIFACTS: "true",
    OMNIGENT_ACCOUNTS_BASE_URL: "http://cfo-drill.invalid",
    OMNIGENT_ACCOUNTS_COOKIE_SECRET: stack.cookieSecret,
    OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
    OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: stack.ownerPassword,
    ...extra,
  };
  const env: Record<string, string> = { CFO_INSTALLATION_ID: INSTALLATION_ID };
  for (const [name, value] of Object.entries(vars)) env[`SERVER_ENV_${name}`] = value;
  return env;
}

interface ContainerSpec {
  readonly image: string;
  readonly cpus: string;
  readonly memory: string;
  readonly mounts: readonly string[];
}

/** Starts a server container; returns its name. The env file is removed once it started. */
function runContainer(
  name: string,
  vars: Readonly<Record<string, string>>,
  spec: ContainerSpec,
): void {
  const envFile = join(DIR, `${name}.env`);
  writeFileSync(
    envFile,
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    { mode: 0o600 },
  );
  try {
    docker(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      NETWORK,
      "--cpus",
      spec.cpus,
      "--memory",
      spec.memory,
      "-p",
      "127.0.0.1::8000",
      "-p",
      "127.0.0.1::8001",
      "--env-file",
      envFile,
      ...spec.mounts.flatMap((m) => ["-v", m]),
      spec.image,
    );
  } finally {
    rmSync(envFile, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The container port, over the Docker CLI

class DockerServer {
  #serial = 0;
  name: string | null = null;
  ports: { app: number; control: number } | null = null;
  /** The configuration fingerprint the current container started with. */
  ranWith: string | null = null;
  /** Starts Cloudflare refuses still to come (injected). */
  refuseStarts = 0;
  #refusedPending = false;
  #exitReported = true;
  readonly started: string[] = [];

  readonly spec: ContainerSpec;
  readonly onContainerEnd: (name: string) => void;

  constructor(spec: ContainerSpec, onContainerEnd: (name: string) => void) {
    this.spec = spec;
    this.onContainerEnd = onContainerEnd;
  }

  running(): boolean {
    if (this.name === null) return false;
    const out = dockerQuiet("inspect", "-f", "{{.State.Running}}", this.name);
    return out.ok && out.out.trim() === "true";
  }

  /** The exit code of the container that stopped last, once, as `monitor()` reports it. */
  exit(): { exitCode: number | null; ranWith: string | null } {
    if (this.#refusedPending) {
      this.#refusedPending = false;
      return { exitCode: null, ranWith: this.ranWith };
    }
    if (this.#exitReported || this.name === null) return { exitCode: null, ranWith: null };
    this.#exitReported = true;
    const out = dockerQuiet("inspect", "-f", "{{.State.ExitCode}}", this.name);
    this.onContainerEnd(this.name);
    return { exitCode: out.ok ? Number(out.out.trim()) : null, ranWith: this.ranWith };
  }

  start(vars: Readonly<Record<string, string>>, fingerprint: string): void {
    if (this.refuseStarts > 0) {
      // UC-03: the start returns, no container runs, monitor() rejects without an exit code.
      this.refuseStarts -= 1;
      this.#refusedPending = true;
      return;
    }
    if (this.name !== null) {
      this.onContainerEnd(this.name); // its log, before it is removed
      dockerQuiet("rm", "-f", this.name);
    }
    this.#serial += 1;
    const name = `${PROJECT}-srv-${process.pid}-${this.#serial}`;
    runContainer(name, vars, this.spec);
    this.name = name;
    this.started.push(name);
    this.ranWith = fingerprint;
    this.#exitReported = false;
    this.ports = { app: mappedPort(name, 8000), control: mappedPort(name, 8001) };
  }

  signal(sig: "TERM" | "KILL"): void {
    if (this.name !== null) dockerQuiet("kill", "-s", sig, this.name);
  }

  async get(port: "app" | "control", path: string): Promise<Response | null> {
    if (this.ports === null) return null;
    try {
      return await fetch(`http://127.0.0.1:${this.ports[port]}${path}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
  }

  async healthy(): Promise<boolean> {
    const response = await this.get("app", "/health");
    await response?.body?.cancel();
    return response?.ok ?? false;
  }

  async entrypoint(): Promise<{
    phase: EntrypointPhase;
    recovery: { reason: string; transient: boolean } | null;
  } | null> {
    const response = await this.get("control", "/status");
    if (response === null || !response.ok) {
      await response?.body?.cancel();
      return null;
    }
    try {
      const body = (await response.json()) as {
        phase?: EntrypointPhase;
        recovery?: { reason: string; transient: boolean } | null;
      };
      return body.phase === undefined
        ? null
        : { phase: body.phase, recovery: body.recovery ?? null };
    } catch {
      return null;
    }
  }

  /** What OmnigentServer's `#observe` sees. */
  async observe(): Promise<Observation> {
    if (!this.running()) return { kind: "stopped", ...this.exit() };
    if (await this.healthy()) return ANSWERING;
    await sleep(PROBE_RETRY_MS);
    if (!this.running()) return { kind: "stopped", ...this.exit() };
    if (await this.healthy()) return ANSWERING;
    return { kind: "silent", entrypoint: await this.entrypoint() };
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios

interface Scenario {
  readonly prefix: string;
  readonly extra: Record<string, string>;
  readonly mounts: readonly string[];
  /** Ends the run: true once the scenario has seen what it is for. */
  done(view: RunView): boolean;
  /** Changes the world at a point of the run (the link, the configuration). */
  act?(view: RunView, ctl: Controls): Promise<void>;
  readonly limitMs: number;
  readonly refuseStarts?: number;
}

interface RunView {
  readonly sinceMs: number;
  readonly answered: boolean;
  readonly stops: number;
  readonly starts: number;
  readonly lastPhase: EntrypointPhase | null;
  readonly phasesSeen: ReadonlySet<string>;
  readonly watchdog: WatchdogState;
  readonly recoverySeenAtMs: number | null;
}

interface Controls {
  readonly stack: Stack;
  setExtra(extra: Record<string, string>): void;
  readonly flags: Record<string, boolean>;
}

const HANG_ENTRYPOINT = `"""The drill's stand-in for Omnigent's Docker entrypoint: its configuration never resolves,
so the app hangs in its initialization, as a stuck migration would."""
import time


def _resolve_config():
    while True:
        time.sleep(60)
`;

function scenario(name: string, prefix: string, hang: boolean, runDir: string): Scenario {
  const hangMount = (): string[] => {
    writeFileSync(join(runDir, "hang_entrypoint.py"), HANG_ENTRYPOINT);
    return [`${runDir}:/drill:ro`];
  };
  const hangEnv = { CFO_OMNIGENT_DOCKER_ENTRYPOINT: "/drill/hang_entrypoint.py" };
  switch (name) {
    case "restore":
      return { prefix, extra: {}, mounts: [], limitMs: 30 * 60_000, done: (v) => v.answered };
    case "hung-init":
      return {
        prefix,
        extra: hangEnv,
        mounts: hangMount(),
        limitMs: 20 * 60_000,
        // The stop after the app-start budget, and the restart that follows it.
        done: (v) => v.stops >= 1 && v.starts >= 2,
      };
    case "restore-deadline":
      return {
        prefix,
        extra: { CFO_RESTORE_DEADLINE_S: "10" },
        mounts: [],
        limitMs: 8 * 60_000,
        done: (v) => v.recoverySeenAtMs !== null && v.sinceMs - v.recoverySeenAtMs > 6 * 60_000,
      };
    case "recovery-exit":
      return {
        prefix,
        extra: { CFO_RESTORE_DEADLINE_S: "15", ...(hang ? hangEnv : {}) },
        mounts: hang ? hangMount() : [],
        limitMs: 25 * 60_000,
        done: (v) => (hang ? v.stops >= 1 : v.answered),
        async act(v, ctl) {
          if (!ctl.flags.blocked && v.sinceMs < 1_000) {
            await blackhole(ctl.stack);
            ctl.flags.blocked = true;
          }
          // Back once the watchdog has seen recovery mode for two minutes.
          if (ctl.flags.blocked && !ctl.flags.unblocked && v.recoverySeenAtMs !== null) {
            if (v.sinceMs - v.recoverySeenAtMs > 120_000) {
              await resetLink(ctl.stack);
              ctl.flags.unblocked = true;
            }
          }
        },
      };
    case "exit-78":
      return {
        prefix,
        extra: { OMNIGENT_SHARING_MODE: "everyone" },
        mounts: [],
        limitMs: 15 * 60_000,
        done: (v) => v.answered,
        async act(v, ctl) {
          // Held for two minutes, then the installer corrects the setting.
          if (!ctl.flags.fixed && v.watchdog.phase === "held" && v.sinceMs > 120_000) {
            ctl.setExtra({});
            ctl.flags.fixed = true;
          }
        },
      };
    case "refused":
      return {
        prefix,
        extra: {},
        mounts: [],
        limitMs: 15 * 60_000,
        refuseStarts: 2,
        done: (v) => v.answered,
      };
    default:
      throw new Error(`unknown scenario ${name}`);
  }
}

async function runScenario(name: string, options: Record<string, string | boolean>): Promise<void> {
  const stack = loadStack();
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const runDir = join(DIR, "runs", `${name}-${stamp}`);
  mkdirSync(join(runDir, "containers"), { recursive: true });
  const prefix = String(options.prefix ?? "drill-small");
  const sc = scenario(name, prefix, options.hang === true, runDir);
  const spec: ContainerSpec = {
    image: String(options.image ?? DEFAULT_IMAGE),
    cpus: String(options.cpus ?? "0.25"),
    memory: String(options.memory ?? "1g"),
    mounts: sc.mounts,
  };
  let extra = sc.extra;
  // A container's log, kept once it can be read; a removed container's earlier copy stays.
  const logsOf = (container: string) => {
    const out = dockerQuiet("logs", container);
    if (out.ok) writeFileSync(join(runDir, "containers", `${container}.log`), out.out);
  };
  const server = new DockerServer(spec, logsOf);
  server.refuseStarts = sc.refuseStarts ?? 0;
  const timelinePath = join(runDir, "timeline.jsonl");
  writeFileSync(timelinePath, "");
  const record = (entry: Record<string, unknown>) =>
    writeFileSync(timelinePath, `${JSON.stringify(entry)}\n`, { flag: "a" });

  await resetLink(stack);
  let state = INITIAL_WATCHDOG_STATE;
  const t0 = Date.now();
  let answeredAt: number | null = null;
  let stops = 0;
  let recoverySeenAt: number | null = null;
  let lastPhase: EntrypointPhase | null = null;
  const phasesSeen = new Set<string>();
  const flags: Record<string, boolean> = {};
  const outages = new Map<string, unknown>();
  const timingFor = (env: Record<string, string>): WatchdogTiming => ({
    ...WATCHDOG_TIMING,
    ...serverDeadlines(env),
  });

  for (;;) {
    const now = Date.now();
    const view: RunView = {
      sinceMs: now - t0,
      answered: answeredAt !== null,
      stops,
      starts: server.started.length,
      lastPhase,
      phasesSeen,
      watchdog: state,
      recoverySeenAtMs: recoverySeenAt === null ? null : recoverySeenAt - t0,
    };
    if (sc.done(view) || now - t0 > sc.limitMs) break;
    await sc.act?.(view, { stack, flags, setExtra: (e) => (extra = e) });

    const env = workerEnv(stack, sc.prefix, extra);
    const vars = serverContainerEnv(env).vars;
    const config = await configFingerprint(vars);
    const timing = timingFor(env);
    const observation = await server.observe();
    const at = Date.now();
    const result = step(state, observation, at, timing, randomOutageId, config);
    state = result.state;
    const phase = observation.kind === "silent" ? (observation.entrypoint?.phase ?? null) : null;
    if (phase !== null) {
      lastPhase = phase;
      phasesSeen.add(phase);
    }
    if (phase === "recovery" && recoverySeenAt === null) recoverySeenAt = at;
    if (observation.kind === "answering" && answeredAt === null) answeredAt = at;
    for (const effect of result.effects) {
      switch (effect.type) {
        case "start":
          server.start(vars, config);
          break;
        case "stop":
          stops += 1;
          server.signal("TERM");
          state = signalled(state, Date.now());
          break;
        case "destroy":
          server.signal("KILL");
          break;
        case "outage":
          outages.set(effect.record.outageId, effect.record);
          break;
        case "event":
          console.log(JSON.stringify({ cfo: "watchdog", event: effect.name, ...effect.fields }));
          break;
      }
    }
    record({
      at: iso(at),
      sinceMs: at - t0,
      observation:
        observation.kind === "silent" ? `silent:${phase ?? "unknown"}` : observation.kind,
      exitCode: observation.kind === "stopped" ? observation.exitCode : undefined,
      watchdog: state.phase,
      effects: result.effects.map((e) =>
        e.type === "event"
          ? { event: e.name, ...e.fields }
          : { [e.type]: e.type === "outage" ? e.record : true },
      ),
      container: server.name,
    });
    await sleep(Math.max(0, result.nextCheckAt - Date.now()));
  }

  // The end: every container's log, then the summary.
  for (const name of server.started) {
    logsOf(name);
    dockerQuiet("rm", "-f", name);
  }
  const summary = {
    scenario: name,
    prefix: sc.prefix,
    image: spec.image,
    imageId: dockerQuiet("image", "inspect", "-f", "{{.Id}}", spec.image).out.trim(),
    cpus: spec.cpus,
    memory: spec.memory,
    startedAt: iso(t0),
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    answeredAfterMs: answeredAt === null ? null : answeredAt - t0,
    stops,
    containers: server.started.length,
    phasesSeen: [...phasesSeen],
    recoverySeenAfterMs: recoverySeenAt === null ? null : recoverySeenAt - t0,
    finalWatchdogPhase: state.phase,
    failedStarts: state.failedStarts,
    outages: [...outages.values()],
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  canaryScan(runDir, stack);
  console.log(
    JSON.stringify({ drill: "done", runDir, ...summary, outages: summary.outages.length }),
  );
}

function canaryScan(runDir: string, stack: Stack): void {
  const result = spawnSync("node", [join(ROOT, "scripts", "canary-scan.ts"), runDir], {
    env: {
      ...process.env,
      CFO_CANARY_VALUES: [stack.s3Password, stack.cookieSecret, stack.ownerPassword].join(","),
    },
    encoding: "utf8",
  });
  writeFileSync(join(runDir, "canary-scan.txt"), `${result.stdout}${result.stderr}`);
  if (result.status !== 0) throw new Error(`canary scan failed: see ${runDir}/canary-scan.txt`);
}

// ---------------------------------------------------------------------------------------------
// Seeding: a replica of a given size, written by the image itself

/**
 * SQL that adds `rows` conversation items in transactions of 5,000: about 2.6 KB each with
 * Omnigent's four indexes, half random (as application data compresses), the rest words.
 */
function seedSql(rows: number): string {
  const lines = [".timeout 120000"];
  for (let done = 0; done < rows; done += 5_000) {
    const n = Math.min(5_000, rows - done);
    lines.push(
      "BEGIN IMMEDIATE;",
      `WITH RECURSIVE n(i) AS (SELECT ${done + 1} UNION ALL SELECT i + 1 FROM n WHERE i < ${done + n})`,
      "INSERT INTO conversation_items (id, conversation_id, response_id, created_at, position, data,",
      "  search_text, created_by, workspace_id, type, status)",
      "SELECT randomblob(16), CAST(printf('drill-conv-%06d', i % 300) AS BLOB),",
      "  printf('resp_%016x', random()), 1700000000 + i, i,",
      "  json_object('type', 'message', 'role', 'assistant', 'content',",
      "    json_array(json_object('type', 'output_text', 'text',",
      "      hex(randomblob(300)) || ' agent conversation computer schedule replica restore' ||",
      "      ' barrier durable window host runner token grant session item turn wake'))),",
      "  hex(randomblob(300)) || ' search text for the drill',",
      "  'owner', 0, 1 + (i % 11), 1 + (i % 4) FROM n;",
      "COMMIT;",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function seed(prefix: string, megabytes: number, image: string): Promise<void> {
  const stack = loadStack();
  const name = `${PROJECT}-seed-${process.pid}`;
  const env = workerEnv(stack, prefix, {
    CFO_INSTALLATION_INITIALIZED: "false",
    CFO_REPLICA_ENDPOINT: "http://minio:9000",
  });
  runContainer(name, serverContainerEnv(env).vars, {
    image,
    cpus: "2",
    memory: "4g",
    mounts: [],
  });
  const started = Date.now();
  try {
    const app = mappedPort(name, 8000);
    const control = mappedPort(name, 8001);
    for (;;) {
      const ok = await fetch(`http://127.0.0.1:${app}/health`, {
        signal: AbortSignal.timeout(5_000),
      }).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) break;
      if (Date.now() - started > 600_000) throw new Error("the seeding server never answered");
      await sleep(1_000);
    }
    const rows = Math.ceil((megabytes * 1024 * 1024) / 2_700);
    const seeded = Date.now();
    sh("docker", ["exec", "-i", name, "sqlite3", "/data/omnigent.db"], seedSql(rows));
    const seedSeconds = (Date.now() - seeded) / 1000;
    // Until the replica covers every commit (the watchdog's own check, one boot).
    const syncFrom = Date.now();
    // `/position` answers 503 (retryable) while Litestream cannot say, as when it is busy with a
    // large seed's backlog: ask again until a position comes back (the WP2.6 staging seeder
    // failed on the first 503, and this wait would have ended early on one).
    const position = async (): Promise<{ txid: number; replicatedTxid: number }> => {
      for (;;) {
        const answer = await fetch(`http://127.0.0.1:${control}/position`, {
          signal: AbortSignal.timeout(10_000),
        }).then(
          async (r) =>
            r.ok ? ((await r.json()) as { txid?: unknown; replicatedTxid?: unknown }) : null,
          () => null,
        );
        if (typeof answer?.txid === "number" && typeof answer.replicatedTxid === "number") {
          return { txid: answer.txid, replicatedTxid: answer.replicatedTxid };
        }
        if (Date.now() - syncFrom > 1_800_000) throw new Error("the position never answered");
        await sleep(2_000);
      }
    };
    const target = (await position()).txid;
    while ((await position()).replicatedTxid < target) {
      if (Date.now() - syncFrom > 1_800_000) throw new Error("never replicated");
      await sleep(1_000);
    }
    const size = docker("exec", name, "stat", "-c", "%s", "/data/omnigent.db").trim();
    docker("stop", "-t", "600", name);
    const exitCode = docker("inspect", "-f", "{{.State.ExitCode}}", name).trim();
    console.log(
      JSON.stringify({
        drill: "seeded",
        prefix,
        rows,
        bytes: Number(size),
        seedSeconds,
        replicatedAfterSeconds: (Date.now() - syncFrom) / 1000,
        exitCode: Number(exitCode),
      }),
    );
    if (exitCode !== "0") throw new Error(`the seeding server exited ${exitCode}`);
  } finally {
    mkdirSync(join(DIR, "seed"), { recursive: true });
    writeFileSync(join(DIR, "seed", `${name}.log`), dockerQuiet("logs", name).out);
    dockerQuiet("rm", "-f", name);
  }
}

// ---------------------------------------------------------------------------------------------

function parseOptions(args: readonly string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) options[arg.slice(2)] = true;
    else {
      options[arg.slice(2)] = next;
      i += 1;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "up":
      return up();
    case "down":
      return down();
    case "seed": {
      const [prefix, mb] = rest;
      if (prefix === undefined || mb === undefined) throw new Error("seed <prefix> <MB>");
      const options = parseOptions(rest.slice(2));
      return seed(prefix, Number(mb), String(options.image ?? DEFAULT_IMAGE));
    }
    case "run": {
      const [name] = rest;
      if (name === undefined) throw new Error("run <scenario>");
      return runScenario(name, parseOptions(rest.slice(1)));
    }
    default:
      console.error(
        readFileSync(fileURLToPath(import.meta.url), "utf8")
          .split("\n")
          .slice(0, 30)
          .join("\n"),
      );
      process.exitCode = 2;
  }
}

await main();
