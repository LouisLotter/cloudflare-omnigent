// Capture and restore assembled with the Sandbox SDK's real DirectoryBackup, locally.
//
// Two computer containers from the built image. The driver plays WorkspaceDO: it sends commands
// to the supervisor's command port, uploads each staged layer with `DirectoryBackup.backup`
// (the image's sandbox-shim, exec'd into the container, writing through the SDK's real
// DirectoryBackupGateway to a file-backed bucket), then restores every layer into the second
// computer with `DirectoryBackup.restore` and sends `restore_workspace`. Only the platform is a
// stand-in (adapted from spike S3's harness): `ctx.container` drives Docker (`docker exec -i`),
// and backups.sandbox.internal is a network alias for a gateway container.
//
//   node --import ./hooks.mjs ./roundtrip.mjs   (from run.sh, which sets up the network)
//
// Writes a JSON result to $RT_OUT; exits non-zero when any check fails. Synthetic values only.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { zstdDecompressSync } from "node:zlib";
import { DirectoryBackup, DirectoryBackupGateway } from "@cloudflare/sandbox";
import { fileBucket } from "./fake-r2.mjs";

const IMAGE = process.env.RT_IMAGE;
const NETWORK = process.env.RT_NETWORK;
const R2_ROOT = process.env.RT_R2;
const OUT = process.env.RT_OUT;
const TAG = process.env.RT_TAG;
if (!IMAGE || !NETWORK || !R2_ROOT || !OUT || !TAG) throw new Error("run through run.sh");

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ulid = (prefix) => `${prefix}_${[...randomBytes(26)].map((b) => ALPHABET[b % 32]).join("")}`;
const bucket = fileBucket(R2_ROOT);
// A synthetic login, built at run time (no canary literal in source): never in any object.
const LOGIN = `${"CFO_"}CANARY_RT${randomBytes(12).toString("hex")}`;
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: Boolean(ok), ...(ok ? {} : { detail }) });
};

class DockerComputer {
  constructor(name, env) {
    this.name = name;
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    const args = ["run", "-d", "--name", name, "--network", NETWORK, "-p", "127.0.0.1::8090"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    execFileSync("docker", [...args, IMAGE], { stdio: "ignore" });
    const port = execFileSync("docker", ["port", name, "8090/tcp"])
      .toString()
      .trim()
      .split("\n")[0];
    this.base = `http://127.0.0.1:${port.split(":").pop()}`;
    this.running = true;
  }
  async interceptOutboundHttp(host, fetcher) {
    if (host === "backups.sandbox.internal") {
      writeFileSync(join(R2_ROOT, "grant.json"), JSON.stringify(fetcher.ctx.props));
    }
  }
  async exec(cmd, options = {}) {
    const child = spawn("docker", ["exec", "-i", this.name, ...cmd], {
      stdio: ["pipe", options.stdout === "ignore" ? "ignore" : "pipe", "pipe"],
    });
    const exitCode = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
    const stdin = options.stdin === "pipe" ? Writable.toWeb(child.stdin) : null;
    if (!stdin) child.stdin.end();
    const stdout = child.stdout ? Readable.toWeb(child.stdout) : null;
    const stderr = (options.stderr ?? "pipe") === "pipe" ? Readable.toWeb(child.stderr) : null;
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
  sh(script) {
    return execFileSync("docker", ["exec", this.name, "sh", "-c", script]).toString();
  }
  async command(computerId, generation, type, fields = {}) {
    const body = {
      type,
      protocolVersion: 1,
      computerId,
      generation,
      operationId: ulid("op"),
      ...fields,
    };
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(`${this.base}/v1/commands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, reply: await res.json(), op: body.operationId };
      } catch (error) {
        if (i > 100) throw error;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  async job(computerId, generation, op) {
    for (let i = 0; i < 1200; i++) {
      const { reply } = await this.command(computerId, generation, "job_status", {
        jobOperationId: op,
      });
      if (reply.job.state !== "running") return reply.job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("job timed out");
  }
  destroy() {
    execFileSync("docker", ["rm", "-f", this.name], { stdio: "ignore" });
  }
}

const env = { CKPT: bucket };
const gateway = (options) => new DirectoryBackupGateway({ props: options.props }, env);
const computerId = ulid("cmp");
// The tree as find lists it: path, type, mode, owner, size, hash or link target.
const LISTING =
  "cd /home/omnigent && find work .claude .claude.json .codex .omnigent -mindepth 0 2>/dev/null " +
  "| LC_ALL=C sort | while read -r p; do " +
  'if [ -L "$p" ]; then echo "L $p $(stat -c %u:%g "$p") $(readlink "$p")"; ' +
  'elif [ -d "$p" ]; then echo "D $p $(stat -c %a:%u:%g "$p")"; ' +
  'else echo "F $p $(stat -c %a:%u:%g:%s "$p") $(sha256sum "$p" | cut -c1-16)"; fi; done';

const a = new DockerComputer(`cfo-wp34-rt-a-${TAG}`, {
  CFO_COMPUTER_ID: computerId,
  CFO_GENERATION: "1",
});
const b = new DockerComputer(`cfo-wp34-rt-b-${TAG}`, {
  CFO_COMPUTER_ID: computerId,
  CFO_GENERATION: "2",
});
const result = { checks };
try {
  // Computer A: a new computer, a workspace, a base and a delta, each uploaded.
  let r = await a.command(computerId, 1, "restore_workspace", { manifest: null, layerDirs: [] });
  check("A restore accepted", r.status === 200, r.reply);
  check("A restore done", (await a.job(computerId, 1, r.op)).state === "done");
  r = await a.command(computerId, 1, "install_credentials", { bundle: null });
  check("A install", r.status === 200, r.reply);
  a.sh(
    "cd /home/omnigent && mkdir -p work/proj/src .claude/projects/-w .codex/sessions && " +
      "printf 'print(1)\\n' > work/proj/src/main.py && printf '#!/bin/sh\\n' > work/proj/run.sh && " +
      "chmod 0750 work/proj/run.sh && ln -s src/main.py work/proj/link && " +
      "head -c 3000000 /dev/urandom > work/proj/blob.bin && ln work/proj/blob.bin work/proj/blob-alias.bin && " +
      "printf '{\"type\":\"user\"}\\n' > .claude/projects/-w/s.jsonl && printf '{}' > .claude.json && " +
      `printf '%s' '${LOGIN}' > .claude/.credentials.json && ` +
      "chown -R omnigent:omnigent work .claude .claude.json .codex",
  );
  const records = [];
  const layers = [];
  let parent = null;
  for (const round of [0, 1]) {
    if (round === 1) {
      a.sh(
        "cd /home/omnigent && printf 'print(2)\\n' > work/proj/src/main.py && rm work/proj/link && " +
          "mkdir work/proj/link && printf x > work/proj/link/in.txt && rm -rf .codex/sessions && " +
          "chown -R omnigent:omnigent work",
      );
    }
    const layerId = ulid("lyr");
    r = await a.command(computerId, 1, "capture", {
      layerId,
      kind: round === 0 ? "base" : "delta",
      parent: round === 0 ? null : { checkpointId: ulid("ckp"), treeDigest: parent },
      policyVersion: 1,
      lease: { targetMs: 20000, hardMs: 40000 },
    });
    const job = await a.job(computerId, 1, r.op);
    check(`A capture ${round} staged`, job.state === "staged", job);
    const backups = new DirectoryBackup(a, gateway, {
      binding: "CKPT",
      prefix: `workspace/${computerId}/`,
    });
    const record = await backups.backup({ dir: job.layerDir, name: layerId });
    records.push(record);
    layers.push({
      layerId,
      kind: round === 0 ? "base" : "delta",
      backup: record,
      indexSha256: job.indexSha256,
      treeDigest: job.treeDigest,
      entries: job.entries,
      deleted: job.deleted,
      bytes: job.bytes,
    });
    r = await a.command(computerId, 1, "finish_capture", {
      captureOperationId: r.op,
      outcome: "published",
      checkpointId: ulid("ckp"),
    });
    check(`A finish ${round}`, r.status === 200, r.reply);
    parent = job.treeDigest;
    result[`record${round}`] = { format: record.format, size: record.size };
    result.cutAt = job.cutAt;
  }
  const expected = a
    .sh(LISTING)
    .split("\n")
    // The policy keeps logins, ~/.claude/backups (H22a) and Codex's per-run ~/.codex/tmp out;
    // the supervisor's own login-status checks write both.
    .filter(
      (l) =>
        l &&
        !l.includes(".claude/.credentials.json") &&
        !l.includes(".claude/backups") &&
        !l.includes(".codex/tmp"),
    );

  // Computer B: every layer restored with DirectoryBackup, then restore_workspace.
  const dirs = [];
  for (const record of records) {
    const backups = new DirectoryBackup(b, gateway, {
      binding: "CKPT",
      prefix: `workspace/${computerId}/`,
    });
    const dir = `/var/cfo/restore/${layers[dirs.length].layerId}`;
    await backups.restore(record, { dir });
    dirs.push(dir);
  }
  const manifest = {
    formatVersion: 1,
    checkpointId: ulid("ckp"),
    computerId,
    generation: 1,
    policyVersion: 1,
    parentCheckpointId: null,
    cutAt: result.cutAt,
    createdAt: new Date().toISOString(),
    roots: ["work", ".claude", ".claude.json", ".codex", ".omnigent"],
    layers,
    treeDigest: parent,
  };
  r = await b.command(computerId, 2, "restore_workspace", { manifest, layerDirs: dirs });
  check("B restore accepted", r.status === 200, r.reply);
  const restored = await b.job(computerId, 2, r.op);
  check("B restore done", restored.state === "done" && restored.stripped === 0, restored);
  check("B digest is the published one", restored.treeDigest === parent, restored);
  const got = b.sh(LISTING).split("\n").filter(Boolean);
  // A hard link inside the selection comes back as two equal files: the index has no links.
  check(
    "B tree equals A's (paths, types, modes, owners, sizes, hashes, link targets)",
    JSON.stringify(got) === JSON.stringify(expected),
    {
      onlyA: expected.filter((l) => !got.includes(l)),
      onlyB: got.filter((l) => !expected.includes(l)),
    },
  );
  check("B holds no login", !b.sh("ls -A /home/omnigent/.claude").includes(".credentials.json"));
  const objects = (await bucket.list({ prefix: `workspace/${computerId}/` })).objects;
  result.objects = objects.length;
  // RC-53 on the archives as stored: decompressed, no object holds the login.
  for (const { key } of objects) {
    const object = await bucket.get(key);
    const raw = Buffer.from(await new Response(object.body).arrayBuffer());
    const tar = zstdDecompressSync(raw);
    check(
      `object ${objects.indexOf(objects.find((o) => o.key === key))} holds no login`,
      !tar.includes(LOGIN),
    );
  }
} catch (error) {
  check("no exception", false, String(error?.stack ?? error));
} finally {
  a.destroy();
  b.destroy();
}
result.ok = checks.every((c) => c.ok);
writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ ok: result.ok, failed: checks.filter((c) => !c.ok) }, null, 1));
process.exit(result.ok ? 0 : 1);
