// The actual ControlDO in workerd under random interleavings: computers that follow WorkspaceDO's
// reservation protocol (WP3.1; design, "One controller per computer"), with lost, slow, dropped
// and delayed requests and replies, late releases, fenced and late starts, reconciliation with
// 3.C's FakeWorkspace reports (also racing a computer's own steps), and ControlDO evicted at any
// point. After every step:
//   - the slots never exceed the limit, and a computer holds at most one;
//   - every reservation a computer holds, and every live container of an unfenced generation, has
//     its slot (one reservation per live container);
//   - every slot is accounted for: the computer's current reservation, or a release it still owes
//     (nothing leaks, even for a moment);
//   - no slot is given back while its generation's container runs, fenced or not;
//   - a wake is refused only when other computers hold the limit;
// and once every delayed request has arrived and every owed release is delivered, exactly the
// reservations the computers hold remain.
//
// The computers here are the callers, modelled on WP3.1's protocol: a generation is persisted
// before it is asked for and never asked twice; a failed ask (a lost reply, a dropped or delayed
// request) gives the generation up and owes its release; releases are retried with their operation
// ID until delivered; a newer generation is asked only once no container runs.
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ComputerId,
  type ControlCall,
  ControlResult,
  type ReservationPhase,
} from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONTROL_TIMING } from "../../src/control/ControlDO.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { testControl } from "../support/control-harness.ts";
import { newComputerId, newOperationId } from "../support/control-ids.ts";
import { FakeControl } from "../support/fake-control.ts";
import type { ControlDO } from "../support/platform-test-worker.ts";

type Stub = DurableObjectStub<ControlDO>;

interface Computer {
  readonly id: ComputerId;
  /** The highest generation ever asked for. */
  lastReserved: number;
  /** The generation of the reservation last granted and applied. */
  applied: number;
  phase: ReservationPhase | null;
  fenced: boolean;
  container: boolean;
  owed: { readonly generation: number; readonly operationId: string }[];
}

/** `slow`: granted, but reconciliation runs before the computer applies the reply. */
type Fault = "ok" | "slow" | "lost_reply" | "dropped" | "delayed";

type Action =
  | { readonly kind: "wake"; readonly c: number; readonly fault: Fault }
  | {
      readonly kind: "start" | "up" | "give_up" | "late_up" | "sleep" | "down" | "confirm";
      readonly c: number;
    }
  | { readonly kind: "drain"; readonly c: number; readonly fault: "ok" | "lost_reply" | "dropped" }
  | { readonly kind: "deliver"; readonly k: number }
  | { readonly kind: "reconcile" | "evict" }
  /** Reconciliation while the computer runs a step of its own between its report and ControlDO's
   * decision. */
  | { readonly kind: "race"; readonly c: number; readonly step: "confirm_release" | "wake" };

const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("wake" as const),
      c: fc.nat(2),
      fault: fc.constantFrom<Fault>("ok", "ok", "slow", "lost_reply", "dropped", "delayed"),
    }),
  },
  {
    weight: 8,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "start" as const,
        "up" as const,
        "give_up" as const,
        "late_up" as const,
        "sleep" as const,
        "down" as const,
        "confirm" as const,
      ),
      c: fc.nat(2),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("drain" as const),
      c: fc.nat(2),
      fault: fc.constantFrom("ok" as const, "lost_reply" as const, "dropped" as const),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("deliver" as const), k: fc.nat(10) }) },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constantFrom("reconcile" as const, "evict" as const) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("race" as const),
      c: fc.nat(2),
      step: fc.constantFrom("confirm_release" as const, "wake" as const),
    }),
  },
);

/** One call made inside the object, so a refusal does not leave it unevictable in this pool. */
async function send(stub: Stub, call: ControlCall): Promise<ControlResult | string> {
  return runInDurableObject(stub, async (instance: ControlDO) => {
    try {
      return ControlResult.parse(await instance.control(call));
    } catch (error) {
      return errorCodeOf(error) ?? String(error);
    }
  });
}

async function slots(stub: Stub): Promise<string[]> {
  return runInDurableObject(stub, (_instance: ControlDO, state) =>
    state.storage.sql
      .exec<{ computer_id: string; generation: number }>(
        "SELECT computer_id, generation FROM slots",
      )
      .toArray()
      .map((r) => `${r.computer_id}/${r.generation}`)
      .sort(),
  );
}

function publish(c: Computer): void {
  testControl.computer(c.id).reservationState = {
    computerId: c.id,
    generation: c.applied,
    phase: c.phase,
    fenced: c.fenced,
    containerRunning: c.container,
  };
}

/** The reservations a computer holds or a live unfenced container needs. */
function needed(computers: readonly Computer[]): string[] {
  return computers
    .filter(
      (c) =>
        c.phase === "reserved" ||
        c.phase === "starting" ||
        c.phase === "running" ||
        (c.container && !c.fenced),
    )
    .map((c) => `${c.id}/${c.applied}`);
}

async function run(limit: number, count: number, actions: readonly Action[]): Promise<void> {
  const name = `simulation-${crypto.randomUUID()}`;
  testControl.setSettings(name, { CFO_MAX_AWAKE_COMPUTERS: limit });
  // A stub made in the caller's own context: a racing step runs inside the object's alarm.
  const object = () => env.CONTROL.getByName(name) as unknown as Stub;
  const stub = object();
  const computers: Computer[] = Array.from({ length: count }, () => ({
    id: newComputerId(),
    lastReserved: 0,
    applied: 0,
    phase: null,
    fenced: false,
    container: false,
    owed: [],
  }));
  for (const c of computers) publish(c);
  const delayed: ControlCall[] = [];
  const trace: string[] = [];
  const at = (where: string) => `${where}: ${trace.join(" ")}`;
  let before = await slots(stub);

  const check = async (where: string) => {
    const held = await slots(stub);
    expect(held.length, at(where)).toBeLessThanOrEqual(limit);
    for (const slot of needed(computers)) expect(held, at(where)).toContain(slot);
    for (const c of computers) {
      const mine = held.filter((h) => h.startsWith(`${c.id}/`));
      expect(mine.length, at(where)).toBeLessThanOrEqual(1);
      for (const slot of mine) {
        const generation = Number(slot.split("/")[1]);
        const current = c.phase !== null && c.applied === generation;
        const owed = c.owed.some((o) => o.generation === generation);
        expect(current || owed, at(`${where}: unaccounted ${slot}`)).toBe(true);
      }
      // Given back while its container runs?
      if (c.container && before.includes(`${c.id}/${c.applied}`)) {
        expect(held, at(`${where}: freed under a running container`)).toContain(
          `${c.id}/${c.applied}`,
        );
      }
    }
    before = held;
  };

  const drain = async (target: Stub, c: Computer, fault: "ok" | "lost_reply" | "dropped") => {
    const owed = c.owed[0];
    if (owed === undefined || fault === "dropped") return;
    const result = await send(target, {
      method: "release",
      interfaceVersion: 1,
      operationId: owed.operationId,
      computerId: c.id,
      generation: owed.generation,
    });
    expect(typeof result, at("release")).toBe("object");
    if (fault === "ok") c.owed.shift();
  };

  const wake = async (target: Stub, c: Computer, fault: Fault) => {
    if (c.phase !== null || c.container || c.owed.length >= 20) return;
    const generation = Math.max(c.applied, c.lastReserved) + 1;
    c.lastReserved = generation;
    const call: ControlCall = {
      method: "reserve",
      interfaceVersion: 1,
      operationId: newOperationId(),
      computerId: c.id,
      generation,
    };
    const others = (await slots(target)).filter((h) => !h.startsWith(`${c.id}/`)).length;
    if (fault === "delayed") delayed.push(call);
    const reaches = fault === "ok" || fault === "slow" || fault === "lost_reply";
    const result = reaches ? await send(target, call) : null;
    if (fault === "lost_reply" || fault === "dropped" || fault === "delayed") {
      // No answer seen: the generation is given up, and its slot owed back.
      c.owed.push({ generation, operationId: newOperationId() });
      return;
    }
    expect(typeof result, at("wake")).toBe("object");
    if (typeof result !== "object" || result?.method !== "reserve") return;
    if (!result.granted) {
      expect(others, at("refused below the limit")).toBeGreaterThanOrEqual(limit);
      return;
    }
    if (fault === "slow") {
      // Reconciliation reads the computer before it has applied the grant.
      await runDurableObjectAlarm(target);
      expect(await slots(target), at("slow grant")).toContain(`${c.id}/${generation}`);
    }
    c.applied = generation;
    c.phase = "reserved";
    c.fenced = false;
  };

  for (const a of actions) {
    const c = "c" in a ? computers[a.c % count] : undefined;
    trace.push(
      `${a.kind}${c ? `(${computers.indexOf(c)})` : ""}${"fault" in a ? `:${a.fault}` : ""}${"step" in a ? `:${a.step}` : ""}`,
    );
    switch (a.kind) {
      case "wake":
        if (c) await wake(stub, c, a.fault);
        break;
      case "start":
        if (c?.phase === "reserved" && !c.fenced) c.phase = "starting";
        break;
      case "up":
        if (c?.phase === "starting" && !c.fenced) {
          c.container = true;
          c.phase = "running";
        }
        break;
      case "give_up":
        if (c && (c.phase === "reserved" || c.phase === "starting")) {
          c.fenced = true;
          c.phase = "releasing";
        }
        break;
      case "late_up":
        // A fenced generation's start runs late: its container comes up (and refuses itself).
        if (c?.fenced && c.phase === "releasing" && !c.container) c.container = true;
        break;
      case "sleep":
        if (c?.phase === "running") c.phase = "releasing";
        break;
      case "down":
        if (c?.phase === "releasing") c.container = false;
        break;
      case "confirm":
        if (c?.phase === "releasing" && !c.container) {
          c.phase = null;
          c.owed.push({ generation: c.applied, operationId: newOperationId() });
        }
        break;
      case "drain":
        if (c) await drain(stub, c, a.fault);
        break;
      case "deliver": {
        const call = delayed.splice(a.k % Math.max(delayed.length, 1), 1)[0];
        if (call) await send(stub, call);
        break;
      }
      case "reconcile":
        await runDurableObjectAlarm(stub);
        break;
      case "race": {
        if (!c) break;
        const step = a.step;
        testControl.behave(c.id, {
          kind: "meanwhile",
          step: async () => {
            const inner = object();
            if (step === "wake") {
              await wake(inner, c, "ok");
            } else if (c.phase === "releasing" && !c.container) {
              c.phase = null;
              c.owed.push({ generation: c.applied, operationId: newOperationId() });
              await drain(inner, c, "ok");
            }
          },
        });
        await runDurableObjectAlarm(stub);
        testControl.behave(c.id, null);
        break;
      }
      case "evict":
        await stub.health();
        await evictDurableObject(stub);
        break;
    }
    for (const x of computers) publish(x);
    await check(a.kind);
  }

  // Quiesce: every owed release is delivered, then every delayed request arrives (after its
  // release, the worst order), every given-up start is finished, and reconciliation runs again.
  for (const c of computers) while (c.owed.length > 0) await drain(stub, c, "ok");
  for (const call of delayed.splice(0)) await send(stub, call);
  for (const c of computers) {
    if (c.fenced && c.phase === "releasing") {
      c.container = false;
      c.phase = null;
      c.owed.push({ generation: c.applied, operationId: newOperationId() });
    }
    while (c.owed.length > 0) await drain(stub, c, "ok");
    publish(c);
  }
  await runDurableObjectAlarm(stub);
  await check("quiesced");
  const remaining = await slots(stub);
  const holding = computers.filter((c) => c.phase !== null).map((c) => `${c.id}/${c.applied}`);
  expect(remaining, at("no leak")).toEqual(holding.sort());
  // ControlDO asked the computers for nothing but their reservations.
  for (const c of computers) {
    const fake = testControl.computer(c.id);
    expect([fake.launcherCalls, fake.pageCalls, fake.computerCalls]).toEqual([[], [], []]);
  }
}

describe("ControlDO under random interleavings", () => {
  it("keeps the limit and one reservation per live container, and leaks no slot", async () => {
    testControl.timing = { ...CONTROL_TIMING, reportTimeoutMs: 200 };
    testControl.productionWorkspace = false;
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(action, { minLength: 10, maxLength: 50 }),
        run,
      ),
      { numRuns: 80 },
    );
  }, 180_000);
});

// 3.C's FakeControl stands in for ControlDO in WorkspaceDO's and the routes' tests, so it must keep
// the same rules: the same random calls, including replays and reused operation IDs, get the same
// answers from both (minted computer IDs aside).
describe("FakeControl keeps ControlDO's rules", () => {
  type Call =
    | {
        readonly kind: "reserve" | "release";
        readonly c: number;
        readonly g: number;
        readonly op: number;
      }
    | { readonly kind: "forget"; readonly c: number; readonly op: number }
    | { readonly kind: "register"; readonly n: number; readonly op: number }
    | { readonly kind: "list" | "limits" };
  const op = fc.nat(7); // 0-3: one of four reusable IDs; 4-7: a fresh one
  const call: fc.Arbitrary<Call> = fc.oneof(
    {
      weight: 6,
      arbitrary: fc.record({
        kind: fc.constantFrom("reserve" as const, "release" as const),
        c: fc.nat(2),
        g: fc.nat(6),
        op,
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("forget" as const), c: fc.nat(2), op }) },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constant("register" as const), n: fc.nat(2), op }),
    },
    {
      weight: 1,
      arbitrary: fc.record({ kind: fc.constantFrom("list" as const, "limits" as const) }),
    },
  );

  /** An answer with minted computer IDs replaced by their order of appearance. */
  function normalizer() {
    const seen = new Map<string, string>();
    const name = (id: string) => {
      if (!seen.has(id)) seen.set(id, `computer-${seen.size}`);
      return seen.get(id) as string;
    };
    return (answer: ControlResult | string): unknown => {
      if (typeof answer === "string") return answer;
      if (answer.method === "register_computer")
        return { ...answer, computerId: name(answer.computerId) };
      if (answer.method === "list_computers") {
        return [...answer.computers]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((x) => ({ ...x, computerId: name(x.computerId) }));
      }
      return answer;
    };
  }

  it("answers every call as ControlDO does", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.array(call, { maxLength: 40 }),
        async (limit, calls) => {
          const name = `parity-${crypto.randomUUID()}`;
          testControl.setSettings(name, { CFO_MAX_AWAKE_COMPUTERS: limit });
          const stub = env.CONTROL.getByName(name) as unknown as Stub;
          const fake = new FakeControl();
          fake.maxAwakeComputers = limit;
          fake.maxInstanceSize = "standard-4";
          const ids = [newComputerId(), newComputerId(), newComputerId()];
          const ops = [newOperationId(), newOperationId(), newOperationId(), newOperationId()];
          const opOf = (i: number) => (i < ops.length ? (ops[i] as string) : newOperationId());
          const [real, model] = [normalizer(), normalizer()];
          const trace: string[] = [];
          for (const c of calls) {
            let request: ControlCall;
            switch (c.kind) {
              case "reserve":
              case "release":
                request = {
                  method: c.kind,
                  interfaceVersion: 1,
                  operationId: opOf(c.op),
                  computerId: ids[c.c] as ComputerId,
                  generation: c.g,
                };
                break;
              case "forget":
                request = {
                  method: "forget_computer",
                  interfaceVersion: 1,
                  operationId: opOf(c.op),
                  computerId: ids[c.c] as ComputerId,
                };
                break;
              case "register":
                request = {
                  method: "register_computer",
                  interfaceVersion: 1,
                  operationId: opOf(c.op),
                  name: `managed-0000000${c.n}`,
                };
                break;
              case "list":
                request = { method: "list_computers", interfaceVersion: 1 };
                break;
              case "limits":
                request = { method: "limits", interfaceVersion: 1 };
                break;
            }
            trace.push(JSON.stringify(c));
            const fromFake = await fake.control(request).then(
              (r) => ControlResult.parse(r),
              (error: unknown) => errorCodeOf(error) ?? String(error),
            );
            const fromControl = await send(stub, request);
            expect(real(fromControl), trace.join(" ")).toEqual(model(fromFake));
          }
          expect(await slots(stub)).toEqual([...fake.slots].map((x) => x).sort());
        },
      ),
      { numRuns: 80 },
    );
  }, 180_000);
});
