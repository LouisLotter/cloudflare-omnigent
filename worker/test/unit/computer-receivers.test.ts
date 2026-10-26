// The actual receivers (adversarial lesson ST-01): WorkspaceDO's own receivers take every golden
// fixture they consume, and refuse every invalid and refined one before any effect; and every
// command WorkspaceDO sends is recorded in a corpus that the supervisor's actual Python receiver
// (`images/computer/cfo_computer/contract.py`) parses in python/tests/computer.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { CMP, ComputerSim, HOST, live } from "../support/computer-sim.ts";

const FIXTURES = join(import.meta.dirname, "../../../contracts/fixtures");
const CORPUS = join(import.meta.dirname, "../fixtures/workspace-commands.json");

function fixtures(name: string): { valid: unknown[]; invalid: [string, unknown][] } {
  const dir = join(FIXTURES, name);
  const read = (sub: string) =>
    existsSync(join(dir, sub))
      ? readdirSync(join(dir, sub))
          .filter((f) => f.endsWith(".json"))
          .map(
            (f) =>
              [`${sub}/${f}`, JSON.parse(readFileSync(join(dir, sub, f), "utf8"))] as [
                string,
                unknown,
              ],
          )
      : [];
  return { valid: read(".").map(([, v]) => v), invalid: [...read("invalid"), ...read("refined")] };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

describe("WorkspaceDO's receivers and the contract's fixtures", () => {
  it("takes every valid launcher request and refuses every invalid one before any effect", async () => {
    const { valid, invalid } = fixtures("LauncherRequest");
    expect(valid.length).toBeGreaterThan(5);
    for (const request of valid) {
      const sim = new ComputerSim();
      await sim.running();
      expect(await codeOf(sim.controller.launcher({ interfaceVersion: 1, request }))).not.toBe(
        "bad_request",
      );
    }
    for (const [name, request] of invalid) {
      const sim = new ComputerSim();
      await sim.running();
      const before = sim.store.dump();
      expect(await codeOf(sim.controller.launcher({ interfaceVersion: 1, request })), name).toMatch(
        /^(bad_request|unsupported_version)$/,
      );
      expect(sim.store.dump(), name).toBe(before);
    }
  });

  it("takes every valid supervisor message and refuses every invalid or refined one", async () => {
    const { valid, invalid } = fixtures("SupervisorMessage");
    for (const message of valid) {
      const sim = new ComputerSim();
      await sim.running();
      const m = message as { computerId: string; generation: number };
      const code = await codeOf(
        sim.controller.computer({
          interfaceVersion: 1,
          props: {
            propsVersion: 1,
            computerId: m.computerId,
            generation: m.generation,
            hostId: HOST,
          },
          message,
        }),
      );
      // The fixtures name generation 7: an older or newer generation than this computer's is stale.
      expect(code === undefined || code === "stale_generation").toBe(true);
    }
    for (const [name, message] of invalid) {
      const sim = new ComputerSim();
      await sim.running();
      const before = sim.store.dump();
      const code = await codeOf(
        sim.controller.computer({
          interfaceVersion: 1,
          props: { propsVersion: 1, computerId: CMP, generation: 1, hostId: HOST },
          message,
        }),
      );
      expect(code, name).toMatch(/^(bad_request|stale_generation|unsupported_version)$/);
      expect(sim.store.dump(), name).toBe(before);
    }
  });

  it("takes every valid page call and refuses every invalid one", async () => {
    const { valid, invalid } = fixtures("PagesCall");
    for (const call of valid) {
      const sim = new ComputerSim();
      await sim.running();
      expect(await codeOf(sim.controller.pages(call))).not.toBe("bad_request");
    }
    for (const [name, call] of invalid) {
      const sim = new ComputerSim();
      await sim.running();
      expect(await codeOf(sim.controller.pages(call)), name).toBe("bad_request");
    }
  });
});

/** Every command type and shape WorkspaceDO sends, from runs that reach each of them. */
async function commands(): Promise<unknown[]> {
  const sim = new ComputerSim();
  await sim.running();
  const sup = live(sim);
  sup.signIn("claude");
  sup.write("work/a.txt", "1");
  await sim.call(sim.client.checkpointRequest());
  sup.options.capturePolls = 1;
  sup.write("work/a.txt", "2");
  await sim.call(sim.client.checkpointRequest());
  await sim.advance(10_000);
  sim.computer.failBackups = 1;
  sup.write("work/a.txt", "3");
  await sim.call(sim.client.checkpointRequest());
  await sim.advance(5 * 60_000);
  sup.runnerProcesses = 0;
  await sim.call(sim.client.suspendRequest());
  await sim.advance(30_000);
  await sim.client.wake({ hostId: HOST, token: sim.token(2) });
  await sim.advance(10_000);
  await sim.call(sim.client.terminateRequest());
  await sim.advance(30_000);
  await sim.controller.pages({
    interfaceVersion: 1,
    action: "sign_out",
    operationId: "op_00000000000000000000000001",
  });
  await sim.advance(3 * 60_000);
  const seen = new Map<string, unknown>();
  for (const body of sim.computer.supervisors.flatMap((s) => s.raw)) {
    const c = body as Record<string, unknown>;
    const shape = [c.type, c.kind, c.outcome, c.bundle === null, c.manifest === null].join("/");
    if (!seen.has(shape)) seen.set(shape, body);
  }
  return [...seen.values()];
}

describe("the commands WorkspaceDO sends", () => {
  it("cover every command type, and match the corpus the Python receiver checks", async () => {
    const corpus = await commands();
    const types = new Set(corpus.map((c) => (c as { type: string }).type));
    expect([...types].sort()).toEqual(
      [
        "capture",
        "credential_snapshot",
        "finish_capture",
        "install_credentials",
        "job_status",
        "restore_workspace",
        "sign_out",
        "start_host",
        "status",
      ].sort(),
    );
    if (process.env.CFO_UPDATE_CORPUS === "1") {
      writeFileSync(CORPUS, `${JSON.stringify(corpus, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(CORPUS, "utf8"))).toEqual(corpus);
  });
});
