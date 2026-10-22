// Local end-to-end run of the S3 staging campaign, without Cloudflare: the real Bench Durable
// Object code (controls, campaign, alarms), the real DirectoryBackup and the S3 HoldingGateway
// over the SDK's DirectoryBackupGateway, the real sandbox-shim in the real spike image, and the
// real supervisor with Omnigent's server, host, runners, the CLIs and the mock LLM inside it.
// Only the platform parts are stand-ins (adapted from spikes/s1/local-e2e):
//   - ctx.container drives a Docker container (`docker run`, `docker exec -i`, `docker rm`),
//     limited to 1 vCPU and 6 GiB like standard-2, with its API port published on 127.0.0.1;
//   - the backups.sandbox.internal intercept is a Docker network alias for the gateway
//     container (gateway-server.mjs), which reads the grant this driver registers;
//   - R2 is a directory shared with the gateway container (fake-r2.mjs);
//   - Durable Object storage is in memory, and alarms run back to back after their delay.
//
// Started by run.sh. The campaign starts through the real controls: a same-origin POST to
// /campaign with the page's request-intent token. Writes the Worker's log lines (JSON) to
// $S3E2E_OUT and leaves results/<campaign>/*.json in the fake bucket.

import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { HoldingGateway } from "../gateway.js";
import { Bench } from "../index.js";
import { fileBucket } from "./fake-r2.mjs";

const NAME = process.env.S3E2E_NAME ?? "cfo-s3stg-e2e-box";
const NETWORK = process.env.S3E2E_NETWORK ?? "cfo-s3stg-e2e";
const IMAGE = process.env.S3E2E_IMAGE ?? "cfo-s3-computer:stg";
const PORT = Number(process.env.S3E2E_PORT ?? 17090);
const PLAN = process.env.S3E2E_PLAN ?? "quick";
const R2_ROOT = process.env.R2_ROOT;
const OUT = process.env.S3E2E_OUT;
const MAX_WAIT_MS = Number(process.env.S3E2E_MAX_WAIT_MS ?? 20_000);
if (!R2_ROOT || !OUT) throw new Error("run through run.sh");

const bucket = fileBucket(R2_ROOT);
writeFileSync(OUT, "");
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (line.startsWith('{"s3"')) {
    appendFileSync(OUT, `${line}\n`);
    const event = JSON.parse(line);
    realLog(`${new Date(event.wt).toISOString()} ${event.s3} ${event.step ?? ""}`);
  } else realLog(...args);
};

class DockerContainer {
  #running = false;
  get running() {
    return this.#running;
  }
  start(options) {
    if (this.#running) throw new Error("the container is already running");
    execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    const args = ["run", "-d", "--name", NAME, "--network", NETWORK, "--cpus", "1"];
    args.push("--memory", "6g", "-p", `127.0.0.1:${PORT}:7070`);
    for (const [key, value] of Object.entries(options.env ?? {}))
      args.push("-e", `${key}=${value}`);
    execFileSync("docker", [...args, IMAGE], { stdio: "ignore" });
    this.#running = true;
  }
  async destroy() {
    execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    this.#running = false;
  }
  async setInactivityTimeout() {}
  getTcpPort(port) {
    if (port !== 7070) throw new Error(`unexpected port ${port}`);
    return {
      fetch: (url, init) => fetch(`http://127.0.0.1:${PORT}${new URL(url).pathname}`, init),
    };
  }
  async interceptOutboundHttp(host, fetcher) {
    if (host === "backups.sandbox.internal") {
      writeFileSync(join(R2_ROOT, "grant.json"), JSON.stringify(fetcher.ctx.props));
    }
  }
  async exec(cmd, options = {}) {
    if (!this.#running) throw new Error("the container is not running");
    const child = spawn("docker", ["exec", "-i", NAME, ...cmd], {
      stdio: ["pipe", options.stdout === "ignore" ? "ignore" : "pipe", "pipe"],
    });
    const exitCode = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    const stdin = options.stdin === "pipe" ? Writable.toWeb(child.stdin) : null;
    if (!stdin) child.stdin.end();
    const stdout = child.stdout ? Readable.toWeb(child.stdout) : null;
    const stderrMode = options.stderr ?? "pipe";
    const stderr = stderrMode === "pipe" ? Readable.toWeb(child.stderr) : null;
    if (!stderr) child.stderr.resume();
    const drain = async (stream) => {
      if (!stream) return new Uint8Array();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return new Uint8Array(Buffer.concat(chunks));
    };
    return {
      pid: child.pid,
      stdin,
      stdout,
      stderr,
      exitCode,
      async output() {
        const [out, err, code] = await Promise.all([drain(stdout), drain(stderr), exitCode]);
        return { stdout: out, stderr: err, exitCode: code };
      },
      kill(signal = 15) {
        child.kill(signal);
      },
    };
  }
}

function memoryStorage() {
  const map = new Map();
  let alarm = null;
  return {
    map,
    async get(key) {
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

const storage = memoryStorage();
const env = { CKPT: bucket };
const ctx = {
  storage,
  container: new DockerContainer(),
  exports: {
    DirectoryBackupGateway: ({ props }) => new DirectoryBackupGateway({ props }, env),
    HoldingGateway: ({ props }) => new HoldingGateway({ props }, env),
  },
  blockConcurrencyWhile: async (fn) => fn(),
};

const bench = new Bench(ctx, env);
const origin = "http://s3-e2e.local.test";
const start = await bench.fetch(
  new Request(`${origin}/campaign`, {
    method: "POST",
    headers: { Origin: origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ intent: bench.state.token, plan: PLAN }).toString(),
  }),
);
if (start.status !== 303)
  throw new Error(`campaign start refused: ${start.status} ${await start.text()}`);
for (let i = 0; i < 2000; i++) {
  const at = await storage.getAlarm();
  if (at === null) break;
  await storage.deleteAlarm();
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(Math.max(0, at - Date.now()), MAX_WAIT_MS)),
  );
  await bench.alarm();
}
const view = await bench.view();
realLog(JSON.stringify(view, null, 1));
await ctx.container.destroy();
