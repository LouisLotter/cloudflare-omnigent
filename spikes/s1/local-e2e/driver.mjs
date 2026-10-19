// Local end-to-end run of S1's restore phases, without Cloudflare: the real S1Computer phase
// code, the real DirectoryBackup and DirectoryBackupGateway from @cloudflare/sandbox 1.0.0, the
// real sandbox-shim in the real computer image, and the real Omnigent host and server. Only the
// platform parts are stand-ins:
//   - ctx.container drives a Docker container (`docker run`, `docker exec -i`, `docker rm`),
//     limited to 1 vCPU and 6 GiB like standard-2;
//   - outbound intercepts are Docker network aliases: omnigent.internal is the server container,
//     backups.sandbox.internal the gateway container (gateway-server.mjs), which reads the grant
//     this driver registers;
//   - R2 is a directory shared with the gateway container (fake-r2.mjs);
//   - Durable Object storage is in memory, and alarms run back to back after their delay.
//
// Started by run.sh. Writes the result lines (JSON) to $S1E2E_OUT.

import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { DirectoryBackupGateway } from "@cloudflare/sandbox";
import { S1Computer } from "../src/index.js";
import { fileBucket } from "./fake-r2.mjs";

const NAME = "s1-e2e-computer";
const NETWORK = process.env.S1E2E_NETWORK ?? "s1-e2e";
const IMAGE = process.env.S1E2E_IMAGE ?? "cfo-s1/computer:local";
const R2_ROOT = process.env.R2_ROOT;
const SERVER_URL = process.env.S1E2E_SERVER_URL;
const COMMAND = process.env.S1E2E_COMMAND;
const MAX_WAIT_MS = Number(process.env.S1E2E_MAX_WAIT_MS ?? 25_000);
const OUT = process.env.S1E2E_OUT;
if (!R2_ROOT || !SERVER_URL || !COMMAND || !OUT) throw new Error("run through run.sh");

const bucket = fileBucket(R2_ROOT);

class DockerContainer {
  #running = false;
  get running() {
    return this.#running;
  }
  start(options) {
    if (this.#running) throw new Error("the container is already running");
    execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
    const args = ["run", "-d", "--name", NAME, "--network", NETWORK, "--cpus", "1"];
    args.push("--memory", "6g");
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
    async list({ prefix = "" } = {}) {
      return new Map([...map].filter(([key]) => key.startsWith(prefix)).sort());
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

const server = {
  async hostStatus(hostId) {
    const response = await fetch(`${SERVER_URL}/v1/hosts/${hostId}`);
    if (response.status === 404) return "absent";
    return (await response.json()).status;
  },
  async marks() {
    return {};
  },
  async keepAlive() {
    return true;
  },
  async ensureUp() {
    return { started: false, readyMs: 0 };
  },
  async stop() {},
};

const storage = memoryStorage();
const ctx = {
  storage,
  container: new DockerContainer(),
  exports: {
    HostRoute: () => ({}),
    DirectoryBackupGateway: ({ props }) =>
      new DirectoryBackupGateway({ props }, { BACKUPS: bucket }),
  },
  blockConcurrencyWhile: async (fn) => fn(),
  waitUntil() {},
};
const env = {
  S1_VERSION: "local-e2e",
  S1_COMMAND: COMMAND,
  SERVER: { idFromName: (name) => name, get: () => server },
};

const computer = new S1Computer(ctx, env);
await computer.kickoff({ armedUntil: Date.now() + 4 * 3_600_000 });
for (let i = 0; i < 500; i++) {
  const at = await storage.getAlarm();
  if (at === null) break;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(Math.max(0, at - Date.now()), MAX_WAIT_MS)),
  );
  await computer.alarm();
  const idle =
    (await storage.get("phase")) === undefined && ((await storage.get("queue")) ?? []).length === 0;
  if (idle) break;
}
await ctx.container.destroy();
const lines = [];
for (const [, value] of await storage.list({ prefix: "result:" }))
  lines.push(JSON.stringify(value));
writeFileSync(OUT, `${lines.join("\n")}\n`);
