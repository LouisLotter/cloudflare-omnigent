// The assembled tests' simulated container (WP3.18): its `sandbox-shim` holds the container's
// backup lock from `locked` until its stdin closes, as the Sandbox SDK requires (Codex WP3.18's
// optional finding), so overlapping operations are serialized as on a real container.
import type { ComputerId } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { FakeRuntimeContainer } from "../support/runtime-container.ts";

const CMP = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
const SHIM = ["/usr/local/bin/sandbox-shim", "directory-backup"];

/** The first frame's JSON payload, or "none" if nothing arrives within `ms`. */
async function firstFrame(process: ExecProcess, ms = 50): Promise<unknown> {
  const reader = (process.stdout as ReadableStream<Uint8Array>).getReader();
  const timeout = new Promise<"none">((resolve) => setTimeout(() => resolve("none"), ms));
  const read = reader.read().then(
    (r) => {
      if (r.done || r.value === undefined) return "closed";
      return JSON.parse(new TextDecoder().decode(r.value.subarray(10))) as unknown;
    },
    () => "released", // a read still pending when the lock on the stream is released
  );
  const result = await Promise.race([read, timeout]);
  reader.releaseLock();
  return result;
}

describe("the simulated container's sandbox-shim", () => {
  it("holds the backup lock from `locked` until stdin closes, then hands it on", async () => {
    const c = new FakeRuntimeContainer(CMP);
    c.start({
      instance: "standard-1",
      env: { CFO_COMPUTER_ID: CMP, CFO_GENERATION: "1" },
    } as never);
    const request = JSON.stringify({ gateway: "backups.sandbox.internal", dir: "/var/cfo/x" });
    const first = await c.exec([...SHIM, "backup", request]);
    const second = await c.exec([...SHIM, "restore", request]);
    expect(await firstFrame(first)).toEqual({ kind: "locked" });
    // The second waits for the lock.
    expect(await firstFrame(second)).toBe("none");
    // The first's caller gives up (closes stdin before acknowledging): it exits, the lock passes.
    await (first.stdin as WritableStream<Uint8Array>).close();
    expect(await first.exitCode).toBe(1);
    expect(await firstFrame(second, 1_000)).toEqual({ kind: "locked" });
    second.kill();
    expect(await second.exitCode).toBe(137);
    expect(c.shimRuns).toEqual(["backup:/var/cfo/x", "restore:/var/cfo/x"]);
    await expect(c.exec(["/bin/sh", "-c", "true"])).rejects.toThrow("unexpected exec");
  });
});
