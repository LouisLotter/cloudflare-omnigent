// G2 sitting, local rehearsal (test tooling, laptop only): the sitting's steps (steps.ts), run
// against the real server image in Docker with an S3 stand-in, before anything is deployed. It
// checks every Omnigent request the steps make (sign-in and its cookie, agents, schedules,
// sessions, attachments and their headers, the session check after a cookie-key change,
// recovery mode) and the step machine around them. Docker plays the platform: a kill removes
// the container and starts a fresh one from the replica, as the production watchdog does; a
// configuration change restarts it once, as G2-SEC-001's controlled restart will.
//
//   node worker/test/staging/g2/rehearse.ts [image]     (default cfo-g2-server:dev)
//
// Containers are named cfo-g2-rh-*, on the Compose project cfo-g2-rh (MinIO only), and removed
// at the end. Every credential is generated here and never printed.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ConfigView,
  EMPTY_REPLICA_MARK,
  type G2Ports,
  type HttpAnswer,
  type KeptSession,
  type OutageView,
  recordKill,
  runStep,
  type StepName,
  type StepRecord,
} from "./steps.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IMAGE = process.argv[2] ?? "cfo-g2-server:dev";
const PROJECT = "cfo-g2-rh";
const BUCKET = "cfo-g2-rh-replica";
const COMPOSE = join(ROOT, "images", "server", "tests", "integration", "compose.yaml");
const scratch = mkdtempSync(join(homedir(), ".pt", "g2-rh-"));

const s3User = `cfo${randomBytes(6).toString("hex")}`;
const s3Password = randomBytes(20).toString("hex");
const ownerPassword = `owner-${randomBytes(12).toString("hex")}`;
const composeEnv = { ...process.env, CFO_IT_S3_USER: s3User, CFO_IT_S3_PASSWORD: s3Password };

function sh(command: string, args: string[], env = process.env, check = true) {
  const result = spawnSync(command, args, { encoding: "utf8", env, timeout: 600_000 });
  if (check && result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} ${args[1] ?? ""} exited ${result.status}: ${result.stderr.slice(-400)}`,
    );
  }
  return result.stdout.trim();
}
const docker = (...args: string[]) => sh("docker", args);
const compose = (...args: string[]) =>
  sh("docker", ["compose", "-p", PROJECT, "-f", COMPOSE, ...args], composeEnv);

/** The server's environment, as the platform passes it: this is the "configuration". */
let config: Record<string, string> = {
  CFO_INSTALLATION_INITIALIZED: "false",
  CFO_REPLICA_URL: `s3://${BUCKET}/omnigent`,
  CFO_REPLICA_ENDPOINT: "http://minio:9000",
  CFO_REPLICA_REGION: "us-east-1",
  LITESTREAM_ACCESS_KEY_ID: s3User,
  LITESTREAM_SECRET_ACCESS_KEY: s3Password,
  OMNIGENT_ACCOUNTS_BASE_URL: "http://cfo-g2-rh.invalid",
  OMNIGENT_ACCOUNTS_COOKIE_SECRET: randomBytes(32).toString("hex"),
  OMNIGENT_ACCOUNTS_INIT_ADMIN_USERNAME: "owner",
  OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: ownerPassword,
};
const fingerprint = (env: Record<string, string>) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex")
    .slice(0, 32);

let serial = 0;
let current = { name: "", app: 0, control: 0, startedWith: "" };

function start(): void {
  serial += 1;
  const name = `${PROJECT}-server-${serial}`;
  const envFile = join(scratch, `${name}.env`);
  writeFileSync(
    envFile,
    Object.entries(config)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
    {
      mode: 0o600,
    },
  );
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    `${PROJECT}_default`,
    "-p",
    "127.0.0.1::8000",
    "-p",
    "127.0.0.1::8001",
    "--env-file",
    envFile,
    "--stop-timeout",
    "60",
    IMAGE,
  );
  rmSync(envFile);
  const port = (inner: string) => Number(docker("port", name, inner).split(":").at(-1));
  current = {
    name,
    app: port("8000/tcp"),
    control: port("8001/tcp"),
    startedWith: fingerprint(config),
  };
}

function running(): boolean {
  if (current.name === "") return false;
  const out = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", current.name], {
    encoding: "utf8",
  });
  return out.stdout.trim() === "true";
}

/** The watchdog's outage records, as the rehearsal's own restarts make them. */
const outageLog: OutageView[] = [];

/** The controlled restart: SIGTERM (a confirmed final sync), then a fresh container. */
function restart(): void {
  const now = Date.now();
  outageLog.push({ cause: "config_changed", startedAt: now, detectedAt: now, endedAt: null });
  docker("stop", current.name);
  docker("rm", "-f", current.name);
  start();
}

/** The restarted server answers: the open outage ends. */
function endOutage(): void {
  const open = outageLog.findLast((o) => o.endedAt === null);
  if (open) outageLog[outageLog.indexOf(open)] = { ...open, endedAt: Date.now() };
}

async function control(path: string): Promise<Response | null> {
  try {
    return await fetch(`http://127.0.0.1:${current.control}${path}`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
}

const records = new Map<StepName, StepRecord>();
const kept = new Map<string, KeptSession>();
const logs: string[] = [];

const ports: G2Ports = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  running,
  destroy: async () => {
    // A platform loss: SIGKILL and no disk. The "watchdog" starts a fresh container at once.
    docker("rm", "-f", current.name);
    setTimeout(start, 1_000);
  },
  status: async () => {
    const response = running() ? await control("/status") : null;
    return response?.status === 200 ? await response.json() : null;
  },
  position: async () => {
    const response = running() ? await control("/position") : null;
    if (response === null) return { status: 0, body: null };
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  },
  http: async (method, path, init): Promise<HttpAnswer> => {
    const headers = new Headers();
    if (init?.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    if (init?.cookie) headers.set("cookie", init.cookie);
    let body: BodyInit | null = null;
    if (init?.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    } else if (init?.upload) {
      const form = new FormData();
      form.append(
        "file",
        new File([init.upload.content], init.upload.filename, { type: init.upload.type }),
      );
      body = form;
    }
    const sent = Date.now();
    try {
      const response = await fetch(`http://127.0.0.1:${current.app}${path}`, {
        method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      const recorded: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== "set-cookie") recorded[k] = v;
      });
      return {
        status: response.status,
        headers: recorded,
        json,
        ms: Date.now() - sent,
        cookies: response.headers.getSetCookie().map((c) => c.split(";")[0] ?? ""),
      };
    } catch {
      return { status: 0, headers: {}, cookies: [], json: null, ms: Date.now() - sent };
    }
  },
  outages: async (fromMs, toMs) =>
    outageLog.filter((o) => o.detectedAt <= toMs && (o.endedAt ?? toMs) >= fromMs),
  config: async (): Promise<ConfigView> => ({
    startedWith: current.startedWith || null,
    current: fingerprint(config),
    initialized: config.CFO_INSTALLATION_INITIALIZED ?? null,
    bootstrapPassword: "OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD" in config,
    replicaUrl: config.CFO_REPLICA_URL ?? null,
  }),
  load: async (step) => structuredClone(records.get(step)),
  save: async (record) => {
    records.set(record.step, structuredClone(record));
  },
  keep: async (name, session) => {
    kept.set(name, session);
  },
  kept: async (name) => kept.get(name),
  forget: async (name) => {
    kept.delete(name);
  },
  log: (event, fields) => {
    const line = JSON.stringify({ event, ...fields });
    logs.push(line);
    console.log(line.length > 400 ? `${line.slice(0, 400)}…` : line);
  },
};

async function until(what: string, ok: () => Promise<boolean>, ms = 300_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function run(step: StepName, password?: string): Promise<StepRecord> {
  for (let i = 0; i < 30; i++) {
    const record = await runStep(ports, { step, ownerPassword: password, ownerUsername: "owner" });
    if (record.stage === "done" || record.stage === "failed") return record;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`${step} did not finish`);
}

const results: Record<string, unknown> = {
  image: IMAGE,
  imageId: docker("image", "inspect", "-f", "{{.Id}}", IMAGE),
};
try {
  compose("up", "-d", "minio");
  const minio = compose("port", "minio", "9000").split(":").at(-1);
  sh(
    "uv",
    [
      "run",
      "--no-project",
      "--with",
      "boto3==1.40.0",
      "python",
      "-I",
      "-c",
      "import boto3,os,sys,time\nc=boto3.client('s3',endpoint_url=sys.argv[1],region_name='us-east-1',aws_access_key_id=os.environ['CFO_IT_S3_USER'],aws_secret_access_key=os.environ['CFO_IT_S3_PASSWORD'])\nfor i in range(60):\n  try:\n    c.create_bucket(Bucket=sys.argv[2]); break\n  except Exception:\n    time.sleep(1)\nelse:\n  sys.exit(1)",
      `http://127.0.0.1:${minio}`,
      BUCKET,
    ],
    composeEnv,
  );

  // The bootstrap: a new installation with the owner's password, until the owner is durable.
  start();
  const owner = async () =>
    (await ports.status())?.phase === "running" &&
    (await ports.http("GET", "/v1/info")).status === 200;
  await until("the first server", owner);
  await until("the owner on the replica", async () => {
    const p = await ports.position();
    return (
      p.status === 200 && p.body !== null && p.body.replicatedTxid >= p.body.txid && p.body.txid > 0
    );
  });
  // The release: INITIALIZED=true, the password gone, then the controlled restart.
  const { OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: _gone, ...released } = config;
  config = { ...released, CFO_INSTALLATION_INITIALIZED: "true" };
  restart();
  await until("the released server", owner);
  endOutage();

  results["replace-1"] = await run("replace-1", ownerPassword);

  // The cookie key changes; the "watchdog" restarts the server with it.
  config = { ...config, OMNIGENT_ACCOUNTS_COOKIE_SECRET: randomBytes(32).toString("hex") };
  restart();
  await until("the rotated server", owner);
  endOutage();
  results.rotate = await run("rotate", ownerPassword);

  results["replace-2"] = await run("replace-2");

  // WP2.6's 1 GB run kills the server itself and the probe follows it (here at a small size).
  await recordKill(ports, "resnapshot");
  await ports.destroy();
  results.resnapshot = await run("resnapshot", ownerPassword);

  config = {
    ...config,
    CFO_REPLICA_URL: `s3://${BUCKET}${EMPTY_REPLICA_MARK}${randomBytes(4).toString("hex")}`,
  };
  restart();
  await until("recovery mode", async () => (await ports.status())?.phase === "recovery");
  results.recovery = await run("recovery");
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  for (let i = 1; i <= serial; i++) spawnSync("docker", ["rm", "-f", `${PROJECT}-server-${i}`]);
  spawnSync("docker", ["compose", "-p", PROJECT, "-f", COMPOSE, "down", "-v", "--remove-orphans"], {
    env: composeEnv,
  });
  rmSync(scratch, { recursive: true, force: true });
}
const text = JSON.stringify(results, null, 2);
for (const secret of [ownerPassword, s3Password, config.OMNIGENT_ACCOUNTS_COOKIE_SECRET ?? ""]) {
  if (secret && text.includes(secret))
    throw new Error("a generated credential reached the results");
}
console.log(text);
// Each step's verdict decides, not its completion (Codex G2 review, 5).
const verdicts = Object.fromEntries(
  Object.entries(results)
    .filter(([, r]) => typeof (r as { verdict?: unknown } | null)?.verdict === "string")
    .map(([name, r]) => [name, (r as StepRecord).verdict]),
);
console.log(`verdicts: ${JSON.stringify(verdicts)}`);
if (Object.keys(verdicts).length !== 5 || Object.values(verdicts).some((v) => v !== "pass")) {
  process.exitCode = 1;
}
