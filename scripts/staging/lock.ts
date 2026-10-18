// Locks between staging commands, including commands started from different worktrees.
//
// A lock is flock(2) on an open file description, taken by running flock(1) on an inherited
// descriptor. The kernel releases it when the last descriptor closes, so a crashed command
// never leaves a stale lock. Every child process the staging tool starts receives the held
// descriptors (see heldLockFds), so an orphaned Wrangler upload keeps its deployment locked
// until it exits. Lock files are never deleted: deleting one would let two holders coexist.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const held = new Set<number>();

/** Descriptors of the locks this process holds, to pass to every child process. */
export function heldLockFds(): number[] {
  return [...held];
}

/**
 * Takes an exclusive lock on `file`, waiting up to `waitSeconds` (0: fail at once).
 * Returns the release function. Throws, naming the current holder, if the lock is busy.
 */
export function acquireLock(file: string, waitSeconds: number, holder: string): () => void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, "a", 0o600);
  const wait = waitSeconds > 0 ? ["--timeout", String(waitSeconds)] : ["--nonblock"];
  const result = spawnSync("flock", ["--exclusive", ...wait, "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  if (result.error || result.status !== 0) {
    closeSync(fd);
    if (result.error) {
      throw new Error(`the staging lock needs flock(1) from util-linux: ${result.error.message}`);
    }
    const owner = existsSync(`${file}.owner`) ? readFileSync(`${file}.owner`, "utf8").trim() : "";
    throw new Error(`busy: ${file} is held by another command${owner ? ` (${owner})` : ""}`);
  }
  writeFileSync(`${file}.owner`, `${holder}\n`, { mode: 0o600 });
  held.add(fd);
  return () => {
    if (held.delete(fd)) closeSync(fd);
  };
}

/** Sleeps without returning to the event loop; the staging tool is synchronous throughout. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
