// The staging locks, exercised with real processes: they exclude each other, a crash releases
// them, a surviving child process keeps them, and concurrent registry writers lose nothing.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fileStore } from "./cloud.ts";
import { acquireLock } from "./lock.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "cfo-stg-lock-"));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

// A separate process that takes a lock, optionally starts a long-lived child that inherits it,
// prints "held <child pid>", and waits to be killed.
const HOLDER = join(scratch, "holder.ts");
writeFileSync(
  HOLDER,
  `import { spawn } from "node:child_process";
import { acquireLock } from ${JSON.stringify(join(HERE, "lock.ts"))};
import { childStdio } from ${JSON.stringify(join(HERE, "cloud.ts"))};
const [file, withChild] = process.argv.slice(2);
acquireLock(file, 0, "holder " + process.pid);
let child = 0;
if (withChild === "yes") {
  const sleeper = spawn("sleep", ["30"], { stdio: childStdio(false), detached: true });
  sleeper.unref();
  child = sleeper.pid ?? 0;
}
console.log("held " + child);
setInterval(() => {}, 1000);
`,
);

function startHolder(
  file: string,
  withChild: boolean,
): Promise<{ holder: ChildProcess; child: number }> {
  const holder = spawn(process.execPath, [HOLDER, file, withChild ? "yes" : "no"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(holder);
  return new Promise((resolve, reject) => {
    holder.stdout?.on("data", (chunk: Buffer) => {
      const match = /held (\d+)/.exec(chunk.toString());
      if (match) resolve({ holder, child: Number(match[1]) });
    });
    holder.on("exit", (code) => reject(new Error(`holder exited with ${code}`)));
  });
}

function killed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGKILL");
  });
}

function free(file: string): boolean {
  return spawnSync("flock", ["--nonblock", file, "true"]).status === 0;
}

describe("staging locks", () => {
  it("excludes a second holder in the same process, and names the first", () => {
    const file = join(scratch, "same.lock");
    const release = acquireLock(file, 0, "first holder");
    expect(() => acquireLock(file, 0, "second")).toThrow("first holder");
    expect(free(file)).toBe(false);
    release();
    release(); // releasing twice is harmless
    expect(free(file)).toBe(true);
    acquireLock(file, 0, "again")();
  });

  it("is released when the holding process is killed", async () => {
    const file = join(scratch, "crash.lock");
    const { holder } = await startHolder(file, false);
    expect(() => acquireLock(file, 0, "test")).toThrow("busy");
    await killed(holder);
    expect(free(file)).toBe(true);
  });

  it("stays held while a child of a killed holder is still running", async () => {
    const file = join(scratch, "orphan.lock");
    const { holder, child } = await startHolder(file, true);
    expect(child).toBeGreaterThan(0);
    await killed(holder);
    // The orphaned child, standing in for an upload, still holds the lock.
    expect(() => acquireLock(file, 0, "test")).toThrow("busy");
    process.kill(child, "SIGKILL");
    for (let i = 0; i < 50 && !free(file); i++) await new Promise((r) => setTimeout(r, 20));
    expect(free(file)).toBe(true);
  });

  it("serializes registry updates from concurrent processes", async () => {
    const file = join(scratch, "registry", "resources.json");
    const writer = join(scratch, "writer.ts");
    writeFileSync(
      writer,
      `import { fileStore } from ${JSON.stringify(join(HERE, "cloud.ts"))};
const [file, id] = process.argv.slice(2);
const store = fileStore(file, "writer " + id);
for (let i = 0; i < 15; i++) {
  const name = "cfo-stg-w" + id + "-" + i;
  store.update((all) => [...all, {
    name, hostname: name + ".example.com", owner: "test", state: "pending",
    createdAt: "2026-10-18T12:00:00.000Z", expiresAt: "2026-10-25T12:00:00.000Z",
  }]);
}
`,
    );
    const writers = [0, 1, 2, 3].map(
      (id) =>
        new Promise<number | null>((resolve) => {
          const child = spawn(process.execPath, [writer, file, String(id)], { stdio: "inherit" });
          children.push(child);
          child.on("exit", resolve);
        }),
    );
    expect(await Promise.all(writers)).toEqual([0, 0, 0, 0]);
    expect(fileStore(file, "test").load()).toHaveLength(60);
  }, 30_000);
});
