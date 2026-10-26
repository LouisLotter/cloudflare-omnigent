import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  type ComputerId,
  ComputerId as ComputerIdSchema,
  type ControlCall,
  ControlResult,
  ErrorBody,
  type ReservationState,
} from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONTROL_TIMING } from "../../src/control/ControlDO.ts";
import { DEFAULT_LIMITS, FORGOTTEN_FLOOR, MAX_COMPUTERS } from "../../src/control/limits.ts";
import { CONTROL_MIGRATIONS } from "../../src/control/schema.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { migrate } from "../../src/shared/sql.ts";
import { testControl } from "../support/control-harness.ts";
import { newComputerId, newOperationId } from "../support/control-ids.ts";
import { stepsWithEviction } from "../support/eviction.ts";
import type { ControlDO } from "../support/platform-test-worker.ts";

// ControlDO, the actual receiver, in workerd: real SQLite, alarms, RPC and eviction. Its
// WorkspaceDOs are 3.C's FakeWorkspace (control-harness.ts).

type Stub = DurableObjectStub<ControlDO>;

declare global {
  interface ImportMeta {
    /** Vite's static glob import, which loads the contract's fixtures into workerd. */
    glob<T = unknown>(
      pattern: string,
      options: { readonly eager: true; readonly import: "default" },
    ): Record<string, T>;
  }
}

function control(settings?: {
  CFO_MAX_AWAKE_COMPUTERS?: unknown;
  CFO_MAX_INSTANCE_SIZE?: unknown;
}) {
  const name = `control-${crypto.randomUUID()}`;
  if (settings !== undefined) testControl.setSettings(name, settings);
  return env.CONTROL.getByName(name) as unknown as Stub;
}

/** One call; every answer must be contract-valid. */
async function call(stub: Stub, c: ControlCall): Promise<ControlResult> {
  return ControlResult.parse(await stub.control(c));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return errorCodeOf(
    await promise.then(
      () => null,
      (error: unknown) => error,
    ),
  );
}

const V = { interfaceVersion: 1 } as const;

function reserve(computerId: ComputerId, generation: number, operationId = newOperationId()) {
  return { method: "reserve", ...V, operationId, computerId, generation } as const;
}

function release(computerId: ComputerId, generation: number, operationId = newOperationId()) {
  return { method: "release", ...V, operationId, computerId, generation } as const;
}

function register(name: string, operationId = newOperationId()) {
  return { method: "register_computer", ...V, operationId, name } as const;
}

function forget(computerId: ComputerId, operationId = newOperationId()) {
  return { method: "forget_computer", ...V, operationId, computerId } as const;
}

const GRANTED = { method: "reserve", granted: true };

function refused(awake: number, limit: number) {
  return { method: "reserve", granted: false, reason: "at_capacity", awake, limit };
}

/**
 * A refused call's error code, with the call made inside the object. Eviction steps refuse this
 * way: in this test pool, an object whose RPC method has thrown can no longer be evicted ("it still
 * has active references"; recorded for the lead as an upstream candidate).
 */
async function refusal(stub: Stub, c: ControlCall): Promise<string | undefined> {
  return runInDurableObject(stub, (instance: ControlDO) => codeOf(instance.control(c)));
}

/** The same object through a stub made in the caller's own context (a step run by the object). */
function again(stub: Stub): Stub {
  return env.CONTROL.getByName(stub.id.name as string) as unknown as Stub;
}

async function slots(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, (_instance: ControlDO, state) =>
    state.storage.sql
      .exec<{ computer_id: string; generation: number; adopted: number }>(
        "SELECT computer_id, generation, adopted FROM slots ORDER BY computer_id, generation",
      )
      .toArray()
      .map((r) => `${r.computer_id}/${r.generation}${r.adopted ? " (adopted)" : ""}`),
  );
}

async function tables(stub: Stub): Promise<string> {
  return runInDurableObject(stub, (_instance: ControlDO, state) =>
    JSON.stringify(
      ["computers", "slots", "floors", "operations"].map((t) =>
        state.storage.sql.exec(`SELECT * FROM ${t}`).toArray(),
      ),
    ),
  );
}

async function alarmAt(stub: Stub): Promise<number | null> {
  return runInDurableObject(stub, (_instance: ControlDO, state) => state.storage.getAlarm());
}

/** What the computer's WorkspaceDO reports for its reservation. */
function reports(
  computerId: ComputerId,
  generation: number,
  phase: ReservationState["phase"],
  more: Partial<Pick<ReservationState, "fenced" | "containerRunning">> = {},
): void {
  testControl.computer(computerId).reservationState = {
    computerId,
    generation,
    phase,
    fenced: more.fenced ?? false,
    containerRunning:
      "containerRunning" in more ? (more.containerRunning ?? null) : phase === "running",
  };
}

async function reconcile(stub: Stub): Promise<void> {
  // Every reconciliation here runs on a fresh instance, as after a restart.
  await stub.health();
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}

beforeEach(() => {
  testControl.timing = { ...CONTROL_TIMING, reportTimeoutMs: 200 };
  testControl.productionWorkspace = false;
});

afterEach(() => {
  testControl.productionWorkspace = false;
});

// ---------------------------------------------------------------------------------------------

describe("ControlDO's schema", () => {
  it("applies its schema once and keeps state across eviction", async () => {
    const stub = control();
    const health = await stepsWithEviction(stub, [
      (c) => c.health(),
      (c) => c.health(),
      (c) => c.health(),
    ]);
    expect(health).toEqual([
      { schemaVersion: 2, boots: 1 },
      { schemaVersion: 2, boots: 2 },
      { schemaVersion: 2, boots: 3 },
    ]);

    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const rows = state.storage.sql.exec("SELECT version, name FROM _cfo_schema").toArray();
      expect(rows).toEqual([
        { version: 1, name: "control_meta" },
        { version: 2, name: "limits" },
      ]);
    });
  });

  it("refuses to run older code against a newer database", async () => {
    const stub = control();
    await stub.health();
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      expect(migrate(state.storage, CONTROL_MIGRATIONS)).toBe(CONTROL_MIGRATIONS.length);
      let code: string | undefined;
      try {
        migrate(state.storage, []);
      } catch (error) {
        code = errorCodeOf(error);
      }
      expect(code).toBe("unsupported_version");
    });
  });

  it("rolls back a failed migration completely, including its journal entry", async () => {
    const stub = control();
    await stub.health();
    const next = CONTROL_MIGRATIONS.length + 1;
    const current = CONTROL_MIGRATIONS.map((m) => ({ version: m.version }));
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const broken = [
        ...CONTROL_MIGRATIONS,
        {
          version: next,
          name: "broken",
          statements: [
            "CREATE TABLE half_done (x INTEGER)",
            "INSERT INTO table_that_does_not_exist VALUES (1)",
          ],
        },
      ];
      expect(() => migrate(state.storage, broken)).toThrow();
      const names = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
      expect(names).not.toContain("half_done");
      expect(state.storage.sql.exec("SELECT version FROM _cfo_schema").toArray()).toEqual(current);
    });
    // The object still starts after the failed attempt, at its original version.
    await evictDurableObject(stub);
    expect((await stub.health()).schemaVersion).toBe(CONTROL_MIGRATIONS.length);

    // A corrected migration then applies cleanly. (The object is not restarted afterwards: its
    // code does not know that version, and downgrade protection would refuse to start it.)
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const fixed = [
        ...CONTROL_MIGRATIONS,
        { version: next, name: "fixed", statements: ["CREATE TABLE half_done (x INTEGER)"] },
      ];
      expect(migrate(state.storage, fixed)).toBe(next);
    });
  });
});

describe("ControlDO's receiver and the contract's fixtures", () => {
  const files = import.meta.glob("../../../contracts/fixtures/ControlCall/**/*.json", {
    eager: true,
    import: "default",
  });
  const valid = Object.entries(files).filter(([path]) => !path.includes("/invalid/"));
  const invalid = Object.entries(files).filter(([path]) => path.includes("/invalid/"));

  it("takes every valid ControlCall fixture and answers with a valid ControlResult", async () => {
    expect(valid.length).toBeGreaterThanOrEqual(7);
    for (const [path, fixture] of valid) {
      const stub = control();
      const result = await call(stub, fixture as ControlCall);
      expect(result.method, path).toBe((fixture as { method: string }).method);
    }
  });

  it("refuses every invalid fixture before any effect", async () => {
    expect(invalid.length).toBeGreaterThanOrEqual(4);
    const stub = control();
    await call(stub, register("managed-0badf00d"));
    const before = await tables(stub);
    for (const [path, fixture] of invalid) {
      expect(await codeOf(stub.control(fixture as ControlCall)), path).toBe("bad_request");
    }
    // No stop of any kind: the fixture's `stop_computer` is not a method ControlDO has.
    expect(await tables(stub)).toBe(before);
  });

  it("refuses a newer interface version, even for a method it does not know", async () => {
    const stub = control();
    const computerId = newComputerId();
    expect(await codeOf(stub.control({ ...reserve(computerId, 1), interfaceVersion: 2 }))).toBe(
      "unsupported_version",
    );
    const unknown = { method: "drain_all", interfaceVersion: 2 } as unknown as ControlCall;
    expect(await codeOf(stub.control(unknown))).toBe("unsupported_version");
    for (const junk of [null, "reserve", 7, {}, { method: "reserve", interfaceVersion: "2" }]) {
      expect(await codeOf(stub.control(junk as unknown as ControlCall))).toBe("bad_request");
    }
    expect(await slots(stub)).toEqual([]);
  });

  it("tolerates unknown fields, as the contract's loose objects do", async () => {
    const stub = control();
    const computerId = newComputerId();
    expect(
      await call(stub, { ...reserve(computerId, 1), addedLater: true } as ControlCall),
    ).toEqual(GRANTED);
  });
});

describe("the computers' registry", () => {
  it("records a computer once per name, across eviction and lost replies", async () => {
    const stub = control();
    const op = newOperationId();
    const [first, repeat, again, list] = await stepsWithEviction(stub, [
      (c) => c.control(register("managed-7f3c2a9e", op)),
      // The same operation repeated after a lost reply.
      (c) => c.control(register("managed-7f3c2a9e", op)),
      // `provision` repeated by Omnigent with a new operation ID: still the same computer.
      (c) => c.control(register("managed-7f3c2a9e")),
      (c) => c.control({ method: "list_computers", ...V }),
    ]);
    expect(ComputerIdSchema.safeParse((first as { computerId: string }).computerId).success).toBe(
      true,
    );
    expect(repeat).toEqual(first);
    expect(again).toEqual(first);
    expect(list).toEqual({
      method: "list_computers",
      computers: [
        { computerId: (first as { computerId: string }).computerId, name: "managed-7f3c2a9e" },
      ],
    });
    expect(await codeOf(stub.control(register("managed-00000000", op)))).toBe("conflict");
  });

  it("forgets a computer and its name; a later registration gets a new computer", async () => {
    const stub = control();
    const a = (await call(stub, register("managed-aaaaaaaa"))) as { computerId: ComputerId };
    const b = (await call(stub, register("managed-bbbbbbbb"))) as { computerId: ComputerId };
    expect(a.computerId).not.toBe(b.computerId);
    expect(await call(stub, reserve(a.computerId, 1))).toEqual(GRANTED);
    const forgetOp = newOperationId();
    const [gone, repeated, again, list] = await stepsWithEviction(stub, [
      (c) => c.control(forget(a.computerId, forgetOp)),
      (c) => c.control(forget(a.computerId, forgetOp)),
      (c) => c.control(forget(a.computerId)),
      (c) => c.control({ method: "list_computers", ...V }),
    ]);
    expect(gone).toEqual({ method: "forget_computer", forgotten: true });
    expect(repeated).toEqual(gone);
    expect(again).toEqual({ method: "forget_computer", forgotten: false });
    expect(list).toEqual({
      method: "list_computers",
      computers: [{ computerId: b.computerId, name: "managed-bbbbbbbb" }],
    });
    // Its slot went with it, and no generation of it takes a slot again.
    expect(await slots(stub)).toEqual([]);
    expect(await codeOf(stub.control(reserve(a.computerId, 2)))).toBe("stale_generation");
    const c = (await call(stub, register("managed-aaaaaaaa"))) as { computerId: ComputerId };
    expect(c.computerId).not.toBe(a.computerId);
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const row = state.storage.sql
        .exec<{ floor: number }>("SELECT floor FROM floors WHERE computer_id = ?", a.computerId)
        .one();
      expect(row.floor).toBe(FORGOTTEN_FLOOR);
    });
  });

  it("refuses a computer beyond the most an installation records", async () => {
    const stub = control();
    await stub.health();
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      for (let i = 0; i < MAX_COMPUTERS; i += 1) {
        state.storage.sql.exec(
          "INSERT INTO computers (computer_id, name, created_at) VALUES (?, ?, ?)",
          newComputerId(),
          `managed-${i.toString(16).padStart(8, "0")}`,
          i,
        );
      }
    });
    expect(await codeOf(stub.control(register("managed-fffffffe")))).toBe("conflict");
    // A name already recorded still answers.
    expect((await call(stub, register("managed-00000000"))).method).toBe("register_computer");
    const list = await call(stub, { method: "list_computers", ...V });
    expect(list.method === "list_computers" && list.computers.length).toBe(MAX_COMPUTERS);
  });
});

describe("limits", () => {
  it("answers the defaults, or the installation's settings", async () => {
    expect(await call(control(), { method: "limits", ...V })).toEqual({
      method: "limits",
      ...DEFAULT_LIMITS,
    });
    const set = control({ CFO_MAX_AWAKE_COMPUTERS: "5", CFO_MAX_INSTANCE_SIZE: "standard-2" });
    expect(await call(set, { method: "limits", ...V })).toEqual({
      method: "limits",
      maxAwakeComputers: 5,
      maxInstanceSize: "standard-2",
    });
  });

  it("fails visibly on an invalid setting, without touching held slots or releases", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: "1" });
    const computerId = newComputerId();
    expect(await call(stub, reserve(computerId, 1))).toEqual(GRANTED);
    testControl.setSettings(stub.id.name as string, { CFO_MAX_AWAKE_COMPUTERS: "-1" });
    expect(await codeOf(stub.control({ method: "limits", ...V }))).toBe("internal");
    expect(await codeOf(stub.control(reserve(newComputerId(), 1)))).toBe("internal");
    expect(await slots(stub)).toEqual([`${computerId}/1`]);
    testControl.setSettings(stub.id.name as string, { CFO_MAX_INSTANCE_SIZE: "huge" });
    expect(await codeOf(stub.control({ method: "limits", ...V }))).toBe("internal");
    expect(await call(stub, release(computerId, 1))).toEqual({ method: "release", released: true });
  });

  it("reads the production settings from the Worker's variables", async () => {
    const stub = control();
    await stub.health();
    await runInDurableObject(stub, (instance: ControlDO) => {
      const defaults = instance.defaults();
      // wrangler.test.jsonc sets neither variable: the defaults apply.
      expect(defaults.settings).toEqual({
        CFO_MAX_AWAKE_COMPUTERS: undefined,
        CFO_MAX_INSTANCE_SIZE: undefined,
      });
      expect(defaults.timing).toEqual(CONTROL_TIMING);
      expect(defaults.clockSkewMs).toBeLessThan(60_000);
    });
  });
});

describe("reservations", () => {
  it("grants within the limit and refuses at once at the limit, with the counts and no queue", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 2 });
    const [a, b, c] = [newComputerId(), newComputerId(), newComputerId()];
    const refusedOp = newOperationId();
    const results = await stepsWithEviction(stub, [
      (s) => s.control(reserve(a, 1)),
      (s) => s.control(reserve(b, 1)),
      (s) => s.control(reserve(c, 1, refusedOp)),
      (s) => s.control(release(a, 1)),
      // No queue: freeing a slot grants nothing by itself.
      () => slots(stub),
      // The refused operation repeated still answers its recorded refusal and takes no slot.
      (s) => s.control(reserve(c, 1, refusedOp)),
      () => slots(stub),
      // A new request for the slot is granted now.
      (s) => s.control(reserve(c, 2)),
    ]);
    expect(results[0]).toEqual(GRANTED);
    expect(results[1]).toEqual(GRANTED);
    expect(results[2]).toEqual(refused(2, 2));
    expect(results[3]).toEqual({ method: "release", released: true });
    expect(results[4]).toEqual([`${b}/1`]);
    expect(results[5]).toEqual(refused(2, 2));
    expect(results[6]).toEqual([`${b}/1`]);
    expect(results[7]).toEqual(GRANTED);
    expect((await slots(stub)).sort()).toEqual([`${b}/1`, `${c}/2`].sort());
  });

  it("refuses every wake when the limit is zero, and when it is lowered keeps the awake ones", async () => {
    const none = control({ CFO_MAX_AWAKE_COMPUTERS: 0 });
    expect(await call(none, reserve(newComputerId(), 1))).toEqual(refused(0, 0));

    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 3 });
    const awake = [newComputerId(), newComputerId(), newComputerId()];
    for (const id of awake) {
      expect(await call(stub, reserve(id, 1))).toEqual(GRANTED);
      reports(id, 1, "running");
    }
    testControl.setSettings(stub.id.name as string, { CFO_MAX_AWAKE_COMPUTERS: 1 });
    expect(await call(stub, reserve(newComputerId(), 1))).toEqual(refused(3, 1));
    await reconcile(stub);
    // No computer is stopped to make room: the slots stay, and ControlDO only ever read reports.
    expect(await slots(stub)).toHaveLength(3);
    for (const id of awake) {
      const fake = testControl.computer(id);
      expect(fake.launcherCalls).toEqual([]);
      expect(fake.pageCalls).toEqual([]);
      expect(fake.computerCalls).toEqual([]);
      expect(fake.effects).toEqual([]);
    }
  });

  it("is idempotent by (computer, generation) and by operation ID", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 1 });
    const computerId = newComputerId();
    const op = newOperationId();
    const results = await stepsWithEviction(stub, [
      (s) => s.control(reserve(computerId, 3, op)),
      // Its reply lost: the same operation again.
      (s) => s.control(reserve(computerId, 3, op)),
      // The same slot under another operation ID: the same answer, at the limit of one.
      (s) => s.control(reserve(computerId, 3)),
    ]);
    expect(results).toEqual([GRANTED, GRANTED, GRANTED]);
    expect(await slots(stub)).toEqual([`${computerId}/3`]);
    expect(await codeOf(stub.control(release(computerId, 3, op)))).toBe("conflict");
    expect(await codeOf(stub.control(reserve(newComputerId(), 3, op)))).toBe("conflict");
  });

  it("never lets a lost or delayed reservation outlive its release", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 1 });
    const computerId = newComputerId();
    const lost = newOperationId();
    const results = await stepsWithEviction(stub, [
      // Granted, but the reply is lost: WorkspaceDO gives generation 1 up and releases it.
      (s) => s.control(reserve(computerId, 1, lost)),
      (s) => s.control(release(computerId, 1)),
      // The lost request repeated, or delivered late under another ID, takes no slot.
      (s) => refusal(s, reserve(computerId, 1, lost)),
      (s) => refusal(s, reserve(computerId, 1)),
      // A request that was never delivered before its release: the release comes first.
      (s) => s.control(release(computerId, 2)),
      (s) => refusal(s, reserve(computerId, 2)),
      () => slots(stub),
      // The computer's next generation is granted.
      (s) => s.control(reserve(computerId, 3)),
    ]);
    expect(results).toEqual([
      GRANTED,
      { method: "release", released: true },
      "stale_generation",
      "stale_generation",
      { method: "release", released: false },
      "stale_generation",
      [],
      GRANTED,
    ]);
  });

  it("lets a newer generation replace the computer's older slot, so it never competes with itself", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 1 });
    const [a, b] = [newComputerId(), newComputerId()];
    const results = await stepsWithEviction(stub, [
      (s) => s.control(reserve(a, 1)),
      // a's container stopped; its release is still on its way when its next wake asks.
      (s) => s.control(reserve(a, 2)),
      () => slots(stub),
      // Another computer still finds the one slot taken.
      (s) => s.control(reserve(b, 1)),
      // The older generation's late release frees nothing, and its late request takes nothing.
      (s) => s.control(release(a, 1)),
      (s) => refusal(s, reserve(a, 1)),
      () => slots(stub),
    ]);
    expect(results).toEqual([
      GRANTED,
      GRANTED,
      [`${a}/2`],
      refused(1, 1),
      { method: "release", released: false },
      "stale_generation",
      [`${a}/2`],
    ]);
  });

  it("answers a lost release's repeat with its recorded outcome", async () => {
    const stub = control();
    const computerId = newComputerId();
    const op = newOperationId();
    const results = await stepsWithEviction(stub, [
      (s) => s.control(reserve(computerId, 4)),
      (s) => s.control(release(computerId, 4, op)),
      (s) => s.control(release(computerId, 4, op)),
      (s) => s.control(release(computerId, 4)),
    ]);
    expect(results.slice(1)).toEqual([
      { method: "release", released: true },
      { method: "release", released: true },
      { method: "release", released: false },
    ]);
  });

  it("serializes concurrent wakes: never more slots than the limit", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 3 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => call(stub, reserve(newComputerId(), 1))),
    );
    expect(results.filter((r) => r.method === "reserve" && r.granted)).toHaveLength(3);
    expect(await slots(stub)).toHaveLength(3);
  });

  it("keeps operation outcomes for at least 7 days, then forgets them", async () => {
    const stub = control();
    const computerId = newComputerId();
    const op = newOperationId();
    expect(await call(stub, release(computerId, 9, op))).toEqual({
      method: "release",
      released: false,
    });
    testControl.advance(7 * 86_400_000);
    expect(await codeOf(stub.control(reserve(computerId, 10, op)))).toBe("conflict");
    testControl.advance(86_400_000 + 1);
    await call(stub, release(newComputerId(), 1));
    // Pruned: the ID is new again.
    expect(await call(stub, reserve(computerId, 10, op))).toEqual(GRANTED);
  });
});

describe("reconciliation", () => {
  it("arms its alarm while a slot is held, and soon after every restart", async () => {
    const stub = control();
    await stub.health();
    expect(await alarmAt(stub)).toBeNull();
    const computerId = newComputerId();
    await call(stub, reserve(computerId, 1));
    expect(await alarmAt(stub)).toBe(testControl.now() + CONTROL_TIMING.reconcileIntervalMs);
    await evictDurableObject(stub);
    await stub.health();
    expect(await alarmAt(stub)).toBe(testControl.now() + CONTROL_TIMING.restartDelayMs);
    reports(computerId, 1, "running");
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmAt(stub)).toBe(testControl.now() + CONTROL_TIMING.reconcileIntervalMs);
    await call(stub, release(computerId, 1));
    // The last alarm finds nothing held and sets no other.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await alarmAt(stub)).toBeNull();
    await evictDurableObject(stub);
    await stub.health();
    expect(await alarmAt(stub)).toBeNull();
  });

  it("releases a slot once its container is confirmed stopped, and fences its generation", async () => {
    const stub = control();
    const computerId = newComputerId();
    await call(stub, reserve(computerId, 5));
    // The stop is confirmed and WorkspaceDO dropped the reservation, but its release was lost.
    reports(computerId, 5, null, { containerRunning: false });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
    expect(await codeOf(stub.control(reserve(computerId, 5)))).toBe("stale_generation");
    // The release arrives late: nothing to free.
    expect(await call(stub, release(computerId, 5))).toEqual({
      method: "release",
      released: false,
    });
  });

  it("follows a delayed start across reconciliation, releasing only once it is fenced", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 1 });
    const computerId = newComputerId();
    reports(computerId, 0, null, { containerRunning: false });
    await call(stub, reserve(computerId, 1));
    // The grant is still on its way to WorkspaceDO: its report shows the previous generation.
    await reconcile(stub);
    expect(await slots(stub)).toEqual([`${computerId}/1`]);
    // Reserved, then starting, with no container yet: a delayed start may still come.
    for (const phase of ["reserved", "starting"] as const) {
      reports(computerId, 1, phase, { containerRunning: false });
      await reconcile(stub);
      expect(await slots(stub), phase).toEqual([`${computerId}/1`]);
    }
    // Unknown container state keeps it too.
    reports(computerId, 1, "starting", { containerRunning: null });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([`${computerId}/1`]);
    // The start is given up and fenced; a late container of it is still up: kept.
    reports(computerId, 1, "releasing", { fenced: true, containerRunning: true });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([`${computerId}/1`]);
    reports(computerId, 1, "releasing", { fenced: true, containerRunning: null });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([`${computerId}/1`]);
    // Fenced and no container: released, and the delayed request can no longer take it.
    reports(computerId, 1, "releasing", { fenced: true, containerRunning: false });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
    expect(await codeOf(stub.control(reserve(computerId, 1)))).toBe("stale_generation");
  });

  it("keeps a running or stopping computer's slot whatever else it reports", async () => {
    const stub = control();
    const computerId = newComputerId();
    await call(stub, reserve(computerId, 2));
    const cases: [ReservationState["phase"], boolean | null][] = [
      ["running", true],
      ["running", false],
      ["running", null],
      ["releasing", true],
      ["releasing", false],
      ["releasing", null],
      [null, true],
    ];
    for (const [phase, containerRunning] of cases) {
      reports(computerId, 2, phase, { containerRunning });
      await reconcile(stub);
      expect(await slots(stub), `${phase} ${containerRunning}`).toEqual([`${computerId}/2`]);
    }
  });

  it("releases a slot its computer has moved past, or one with no computer record", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 5 });
    const [moved, removed] = [newComputerId(), newComputerId()];
    await call(stub, reserve(moved, 1));
    await call(stub, reserve(removed, 1));
    // `moved` asked for generation 3 elsewhere; its newer container runs (an impossible state
    // for one ControlDO, but reconciliation must still judge it).
    reports(moved, 3, "running");
    testControl.computer(removed).reservationState = null;
    await reconcile(stub);
    // Generation 1 is finished; generation 3's reservation is rebuilt from the report.
    expect(await slots(stub)).toEqual([`${moved}/3 (adopted)`]);
    expect(await codeOf(stub.control(reserve(removed, 1)))).toBe("stale_generation");
  });

  it("keeps every slot it cannot judge: unreachable, late, invalid or another computer's report", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 5 });
    const ids = [newComputerId(), newComputerId(), newComputerId(), newComputerId()];
    for (const id of ids) {
      await call(stub, reserve(id, 1));
      reports(id, 1, null, { containerRunning: false });
    }
    const [unreachable, late, invalid, other] = ids as [
      ComputerId,
      ComputerId,
      ComputerId,
      ComputerId,
    ];
    testControl.behave(unreachable, { kind: "unreachable" });
    testControl.behave(late, { kind: "hangs" });
    testControl.behave(invalid, {
      kind: "answers",
      value: { computerId: invalid, generation: -1 },
    });
    testControl.behave(other, {
      kind: "answers",
      value: {
        computerId: newComputerId(),
        generation: 1,
        phase: null,
        fenced: false,
        containerRunning: false,
      },
    });
    await reconcile(stub);
    expect((await slots(stub)).sort()).toEqual(ids.map((id) => `${id}/1`).sort());
    for (const id of ids) testControl.behave(id, null);
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
  });

  it("reads reports through the WORKSPACE binding, and keeps every slot while it has none", async () => {
    const stub = control();
    const computerId = newComputerId();
    await call(stub, reserve(computerId, 1));
    testControl.productionWorkspace = true;
    await reconcile(stub);
    // Before WorkspaceDO is bound (WP3.1), no report can be read and the slot is kept. Once it is,
    // the actual WorkspaceDO answers that it holds no record of this computer: the slot goes.
    const bound = (env as { readonly WORKSPACE?: unknown }).WORKSPACE !== undefined;
    expect(await slots(stub)).toEqual(bound ? [] : [`${computerId}/1`]);
  });

  it("never brings back a slot released while its report was being read", async () => {
    const stub = control();
    const { computerId } = (await call(stub, register("managed-race0001"))) as {
      computerId: ComputerId;
    };
    await call(stub, reserve(computerId, 1));
    // The report says the reservation is held (stopping); before ControlDO acts on it, the stop
    // is confirmed and WorkspaceDO's release arrives.
    reports(computerId, 1, "releasing", { containerRunning: true });
    testControl.behave(computerId, {
      kind: "meanwhile",
      step: async () => {
        expect(await call(again(stub), release(computerId, 1))).toEqual({
          method: "release",
          released: true,
        });
      },
    });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
  });

  it("never releases a slot granted while the reports were being read", async () => {
    const stub = control();
    const other = newComputerId();
    await call(stub, reserve(other, 1));
    reports(other, 1, "running");
    // A computer just registered, with no record yet, provisioned and woken while ControlDO waits.
    const { computerId } = (await call(stub, register("managed-new00001"))) as {
      computerId: ComputerId;
    };
    testControl.computer(computerId).reservationState = null;
    testControl.behave(computerId, {
      kind: "meanwhile",
      step: async () => {
        expect(await call(again(stub), reserve(computerId, 1))).toEqual(GRANTED);
      },
    });
    await reconcile(stub);
    expect((await slots(stub)).sort()).toEqual([`${computerId}/1`, `${other}/1`].sort());
  });

  it("rebuilds a reservation its computer holds but ControlDO does not, and counts it", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 1 });
    const { computerId } = (await call(stub, register("managed-adopt001"))) as {
      computerId: ComputerId;
    };
    reports(computerId, 4, "running");
    await reconcile(stub);
    expect(await slots(stub)).toEqual([`${computerId}/4 (adopted)`]);
    expect(await call(stub, reserve(newComputerId(), 1))).toEqual(refused(1, 1));
    // Released like any other once its stop is confirmed.
    reports(computerId, 4, null, { containerRunning: false });
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
    // Never at or below the computer's floor: a stale report does not bring it back.
    reports(computerId, 4, "running");
    const sweepNow = () =>
      runInDurableObject(stub, (_instance: ControlDO, state) => {
        state.storage.sql.exec("DELETE FROM control_meta WHERE key = 'last_sweep_at'");
      });
    await sweepNow();
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
    // Never for a computer that is forgotten, or was never registered and holds no slot.
    await call(stub, forget(computerId));
    reports(computerId, 9, "running");
    const stranger = newComputerId();
    reports(stranger, 1, "running");
    await call(stub, register("managed-adopt002"));
    await sweepNow();
    await reconcile(stub);
    expect(await slots(stub)).toEqual([]);
    expect(testControl.asked).not.toContain(stranger);
  });

  it("asks every registered computer at most hourly, and the slot holders every time", async () => {
    const stub = control();
    const { computerId: idle } = (await call(stub, register("managed-idle0001"))) as {
      computerId: ComputerId;
    };
    testControl.computer(idle).reservationState = null;
    const busy = newComputerId();
    await call(stub, reserve(busy, 1));
    reports(busy, 1, "running");
    const asked = () => testControl.asked.filter((id) => id === idle || id === busy);
    const start = asked().length;
    await reconcile(stub);
    expect(asked().slice(start).sort()).toEqual([busy, idle].sort());
    const second = asked().length;
    testControl.advance(CONTROL_TIMING.reconcileIntervalMs);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(asked().slice(second)).toEqual([busy]);
    const third = asked().length;
    testControl.advance(CONTROL_TIMING.sweepIntervalMs);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(asked().slice(third).sort()).toEqual([busy, idle].sort());
    // Nothing but `reservation` was ever asked of either.
    for (const id of [idle, busy]) {
      const fake = testControl.computer(id);
      expect([fake.launcherCalls, fake.pageCalls, fake.computerCalls]).toEqual([[], [], []]);
    }
  });

  it("keeps awake computers' slots across a restart and accepts the releases owed meanwhile (FH-37)", async () => {
    const stub = control({ CFO_MAX_AWAKE_COMPUTERS: 2 });
    const [awake, stopped] = [newComputerId(), newComputerId()];
    await call(stub, reserve(awake, 1));
    await call(stub, reserve(stopped, 1));
    reports(awake, 1, "running");
    reports(stopped, 1, "releasing", { containerRunning: false });
    const owed = newOperationId();
    const results = await stepsWithEviction(stub, [
      () => runDurableObjectAlarm(stub),
      () => slots(stub),
      // The release WorkspaceDO could not deliver while ControlDO was away, retried.
      (s) => s.control(release(stopped, 1, owed)),
      (s) => s.control(release(stopped, 1, owed)),
      () => slots(stub),
    ]);
    expect(results).toEqual([
      true,
      [`${awake}/1`, `${stopped}/1`].sort(),
      { method: "release", released: true },
      { method: "release", released: true },
      [`${awake}/1`],
    ]);
  });
});

describe("Worker entry point", () => {
  it("answers the health check", async () => {
    const response = await exports.default.fetch("https://example.test/__health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("returns a contract-valid error body for unknown routes", async () => {
    const response = await exports.default.fetch("https://example.test/nope");
    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).error.code).toBe("not_found");
  });
});
