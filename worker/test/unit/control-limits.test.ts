// limits.ts, ControlDO's decisions, as pure functions: the tables of cases and properties over
// random sequences. The Durable Object that applies them is tested in workerd
// (test/workers/control.test.ts, control-simulation.test.ts).
import type { ComputerId, ReservationState } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  adoption,
  DEFAULT_LIMITS,
  decideRelease,
  decideReserve,
  FORGOTTEN_FLOOR,
  judgeSlot,
  MAX_COMPUTERS,
  NO_FLOOR,
  parseLimits,
  planReconciliation,
  type Report,
  type Slot,
  slotKey,
} from "../../src/control/limits.ts";

const A = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
const B = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" as ComputerId;
const C = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n5" as ComputerId;

function report(
  computerId: ComputerId,
  generation: number,
  phase: ReservationState["phase"],
  containerRunning: boolean | null,
  fenced = false,
): ReservationState {
  return { computerId, generation, phase, fenced, containerRunning };
}

describe("parseLimits", () => {
  it("uses the defaults when nothing is set", () => {
    expect(parseLimits({})).toEqual({ ok: true, limits: DEFAULT_LIMITS });
    expect(parseLimits({ CFO_MAX_AWAKE_COMPUTERS: "", CFO_MAX_INSTANCE_SIZE: "" })).toEqual({
      ok: true,
      limits: DEFAULT_LIMITS,
    });
  });

  it("reads whole numbers from 0 to the most computers, as text or a number", () => {
    for (const [value, expected] of [
      ["0", 0],
      [0, 0],
      ["7", 7],
      [7, 7],
      [String(MAX_COMPUTERS), MAX_COMPUTERS],
    ] as const) {
      expect(parseLimits({ CFO_MAX_AWAKE_COMPUTERS: value })).toEqual({
        ok: true,
        limits: { ...DEFAULT_LIMITS, maxAwakeComputers: expected },
      });
    }
    expect(parseLimits({ CFO_MAX_INSTANCE_SIZE: "basic" })).toEqual({
      ok: true,
      limits: { ...DEFAULT_LIMITS, maxInstanceSize: "basic" },
    });
  });

  it("refuses anything else rather than guessing a cap", () => {
    for (const value of [
      "-1",
      "1.5",
      "abc",
      " 2",
      "1e3",
      String(MAX_COMPUTERS + 1),
      2.5,
      -1,
      {},
      true,
    ]) {
      const parsed = parseLimits({ CFO_MAX_AWAKE_COMPUTERS: value });
      expect(parsed.ok, String(value)).toBe(false);
      expect(!parsed.ok && parsed.problem).toMatch(/CFO_MAX_AWAKE_COMPUTERS/);
    }
    for (const value of ["standard-5", "STANDARD-2", 4, null]) {
      const parsed = parseLimits({ CFO_MAX_INSTANCE_SIZE: value });
      expect(parsed.ok, String(value)).toBe(false);
      expect(!parsed.ok && parsed.problem).toMatch(/CFO_MAX_INSTANCE_SIZE/);
    }
  });
});

describe("decideReserve", () => {
  it("grants within the limit and refuses at the limit with the counts", () => {
    expect(
      decideReserve({ slots: [], floor: NO_FLOOR, limit: 1, computerId: A, generation: 1 }),
    ).toEqual({
      kind: "grant",
      floor: 0,
      replaces: [],
    });
    expect(
      decideReserve({
        slots: [{ computerId: B, generation: 4 }],
        floor: NO_FLOOR,
        limit: 1,
        computerId: A,
        generation: 1,
      }),
    ).toEqual({ kind: "refuse", floor: 0, awake: 1, limit: 1 });
    expect(
      decideReserve({ slots: [], floor: NO_FLOOR, limit: 0, computerId: A, generation: 0 }),
    ).toEqual({
      kind: "refuse",
      floor: NO_FLOOR,
      awake: 0,
      limit: 0,
    });
  });

  it("answers a held slot the same, even at the limit", () => {
    const slots = [{ computerId: A, generation: 3 }];
    expect(decideReserve({ slots, floor: 2, limit: 1, computerId: A, generation: 3 })).toEqual({
      kind: "held",
      floor: 2,
    });
  });

  it("refuses a finished generation even while its slot is still held (Codex r1-3)", () => {
    // A/1 is held, A asked for 2 (refused at the limit), so generation 1 is finished.
    const slots = [{ computerId: A, generation: 1 }];
    expect(decideReserve({ slots, floor: 1, limit: 0, computerId: A, generation: 1 })).toEqual({
      kind: "stale",
      floor: 1,
    });
  });

  it("refuses a generation at or below the floor as stale", () => {
    for (const generation of [0, 4, 5]) {
      expect(decideReserve({ slots: [], floor: 5, limit: 9, computerId: A, generation })).toEqual({
        kind: "stale",
        floor: 5,
      });
    }
    expect(
      decideReserve({
        slots: [],
        floor: FORGOTTEN_FLOOR,
        limit: 9,
        computerId: A,
        generation: 2 ** 40,
      }).kind,
    ).toBe("stale");
  });

  it("does not count the computer's own older slots, and replaces them", () => {
    const slots = [
      { computerId: A, generation: 1 },
      { computerId: A, generation: 2 },
      { computerId: B, generation: 1 },
    ];
    expect(decideReserve({ slots, floor: 1, limit: 2, computerId: A, generation: 3 })).toEqual({
      kind: "grant",
      floor: 2,
      replaces: [
        { computerId: A, generation: 1 },
        { computerId: A, generation: 2 },
      ],
    });
    // On a refusal the older slots stay (they may still be counted for a live container).
    expect(decideReserve({ slots, floor: 1, limit: 1, computerId: A, generation: 3 })).toEqual({
      kind: "refuse",
      floor: 2,
      awake: 1,
      limit: 1,
    });
  });
});

describe("decideRelease", () => {
  it("is idempotent and raises the floor to the generation", () => {
    const slots = [{ computerId: A, generation: 2 }];
    expect(decideRelease({ slots, floor: 1, computerId: A, generation: 2 })).toEqual({
      released: true,
      floor: 2,
    });
    expect(decideRelease({ slots: [], floor: 2, computerId: A, generation: 2 })).toEqual({
      released: false,
      floor: 2,
    });
    expect(decideRelease({ slots, floor: 7, computerId: A, generation: 2 })).toEqual({
      released: true,
      floor: 7,
    });
    expect(decideRelease({ slots, floor: NO_FLOOR, computerId: B, generation: 2 })).toEqual({
      released: false,
      floor: 2,
    });
  });
});

describe("judgeSlot", () => {
  const slot: Slot = { computerId: A, generation: 5 };
  const cases: [string, Report, "keep" | "release"][] = [
    ["unreachable", "unreachable", "keep"],
    ["no computer record", null, "release"],
    ["another computer's report", report(B, 5, null, false), "keep"],
    ["grant not yet applied", report(A, 4, "running", true), "keep"],
    ["grant not yet applied, nothing running", report(A, 4, null, false), "keep"],
    ["a newer generation runs", report(A, 6, "running", true), "release"],
    ["a newer generation is reserved", report(A, 7, "reserved", false), "release"],
    ["container runs, phase null", report(A, 5, null, true), "keep"],
    ["stop confirmed, reservation dropped", report(A, 5, null, false), "release"],
    ["reservation dropped, container unknown", report(A, 5, null, null), "release"],
    ["reserved, start delayed", report(A, 5, "reserved", false), "keep"],
    ["starting, nothing yet", report(A, 5, "starting", false), "keep"],
    ["starting, unknown", report(A, 5, "starting", null), "keep"],
    ["running", report(A, 5, "running", true), "keep"],
    ["running, seen stopped", report(A, 5, "running", false), "keep"],
    ["releasing, stop unconfirmed", report(A, 5, "releasing", false), "keep"],
    ["releasing, still running", report(A, 5, "releasing", true), "keep"],
    ["fenced, late container up", report(A, 5, "releasing", true, true), "keep"],
    ["fenced, container unknown", report(A, 5, "releasing", null, true), "keep"],
    ["fenced, no container", report(A, 5, "releasing", false, true), "release"],
    ["fenced while reserved, no container", report(A, 5, "reserved", false, true), "release"],
    ["fenced while starting, no container", report(A, 5, "starting", false, true), "release"],
  ];
  for (const [name, r, verdict] of cases) {
    it(`${verdict}s: ${name}`, () => {
      expect(judgeSlot(slot, r)).toBe(verdict);
    });
  }

  it("never frees a slot whose container may run, or whose start may still come", () => {
    const phase = fc.constantFrom<ReservationState["phase"]>(
      null,
      "reserved",
      "starting",
      "running",
      "releasing",
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        phase,
        fc.constantFrom(true, false, null),
        fc.boolean(),
        (slotGeneration, generation, p, containerRunning, fenced) => {
          const s = { computerId: A, generation: slotGeneration };
          const verdict = judgeSlot(s, report(A, generation, p, containerRunning, fenced));
          if (generation < slotGeneration) expect(verdict).toBe("keep");
          if (generation === slotGeneration && containerRunning === true)
            expect(verdict).toBe("keep");
          if (generation === slotGeneration && (p === "reserved" || p === "starting") && !fenced) {
            expect(verdict).toBe("keep");
          }
          if (verdict === "release" && generation === slotGeneration) {
            expect(
              containerRunning !== true && (p === null || (fenced && containerRunning === false)),
            ).toBe(true);
          }
        },
      ),
    );
  });
});

describe("adoption", () => {
  it("rebuilds a reservation the report holds and ControlDO does not", () => {
    expect(adoption(A, report(A, 3, "running", true), [], 2)).toEqual({
      computerId: A,
      generation: 3,
    });
    expect(
      adoption(A, report(A, 3, "reserved", false), [{ computerId: A, generation: 1 }], 1),
    ).toEqual({
      computerId: A,
      generation: 3,
    });
  });

  it("adopts nothing it could not keep, already holds, or has finished", () => {
    expect(adoption(A, "unreachable", [], NO_FLOOR)).toBeNull();
    expect(adoption(A, null, [], NO_FLOOR)).toBeNull();
    expect(adoption(A, report(B, 3, "running", true), [], NO_FLOOR)).toBeNull();
    expect(adoption(A, report(A, 3, null, true), [], NO_FLOOR)).toBeNull();
    expect(
      adoption(A, report(A, 3, "running", true), [{ computerId: A, generation: 3 }], 2),
    ).toBeNull();
    expect(adoption(A, report(A, 3, "running", true), [], 3)).toBeNull();
    expect(adoption(A, report(A, 3, "running", true), [], FORGOTTEN_FLOOR)).toBeNull();
    expect(adoption(A, report(A, 3, "releasing", false, true), [], NO_FLOOR)).toBeNull();
  });
});

describe("planReconciliation", () => {
  it("releases only eligible slots, adopts only known computers, and keeps unasked ones", () => {
    const slots = [
      { computerId: A, generation: 1 },
      { computerId: B, generation: 2 },
      { computerId: C, generation: 1 },
    ];
    const plan = planReconciliation({
      slots,
      // B/2 was granted while the reports were read.
      eligible: new Set([slotKey(slots[0] as Slot), slotKey(slots[2] as Slot)]),
      reports: new Map<ComputerId, Report>([
        [A, report(A, 1, null, false)],
        [B, null],
        // C was not asked.
      ]),
      floors: new Map([
        [A, 0],
        [B, 1],
      ]),
      registered: new Set([A]),
    });
    expect(plan).toEqual({ release: [{ computerId: A, generation: 1 }], adopt: [] });

    const adopt = planReconciliation({
      slots: [],
      eligible: new Set(),
      reports: new Map<ComputerId, Report>([
        [A, report(A, 4, "running", true)],
        [B, report(B, 2, "running", true)],
      ]),
      floors: new Map(),
      registered: new Set([A]),
    });
    expect(adopt).toEqual({ release: [], adopt: [{ computerId: A, generation: 4 }] });
  });
});

describe("the limit and one-slot-per-computer invariants, over random calls", () => {
  type Step =
    | { readonly kind: "reserve"; readonly computer: number; readonly generation: number }
    | { readonly kind: "release"; readonly computer: number; readonly generation: number }
    | { readonly kind: "forget"; readonly computer: number };
  const ids = [A, B, C];
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      kind: fc.constant("reserve" as const),
      computer: fc.integer({ min: 0, max: 2 }),
      generation: fc.integer({ min: 0, max: 12 }),
    }),
    fc.record({
      kind: fc.constant("release" as const),
      computer: fc.integer({ min: 0, max: 2 }),
      generation: fc.integer({ min: 0, max: 12 }),
    }),
    fc.record({ kind: fc.constant("forget" as const), computer: fc.integer({ min: 0, max: 2 }) }),
  );

  it("never holds more slots than the limit or two for one computer, nor grants at or below a floor", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.array(step, { maxLength: 60 }),
        (limit, steps) => {
          let slots: Slot[] = [];
          const floors = new Map<ComputerId, number>();
          const floorOf = (id: ComputerId) => floors.get(id) ?? NO_FLOOR;
          for (const s of steps) {
            const computerId = ids[s.computer] as ComputerId;
            if (s.kind === "reserve") {
              const before = slots.length;
              const floorBefore = floorOf(computerId);
              const d = decideReserve({
                slots,
                floor: floorOf(computerId),
                limit,
                computerId,
                generation: s.generation,
              });
              if (d.kind !== "stale")
                floors.set(computerId, Math.max(floorOf(computerId), d.floor));
              if (d.kind === "grant") {
                const replaced = new Set(d.replaces.map(slotKey));
                slots = [
                  ...slots.filter((x) => !replaced.has(slotKey(x))),
                  { computerId, generation: s.generation },
                ];
                expect(slots.length).toBeLessThanOrEqual(Math.max(limit, before));
                expect(s.generation).toBeGreaterThan(floorBefore);
              }
              if (d.kind === "stale") expect(s.generation).toBeLessThanOrEqual(floorBefore);
              if (d.kind === "refuse") expect(d.awake).toBeGreaterThanOrEqual(limit);
              // Asking twice gives the same answer.
              const repeat = decideReserve({
                slots,
                floor: floorOf(computerId),
                limit,
                computerId,
                generation: s.generation,
              });
              if (d.kind === "grant" || d.kind === "held") expect(repeat.kind).toBe("held");
            } else if (s.kind === "release") {
              const d = decideRelease({
                slots,
                floor: floorOf(computerId),
                computerId,
                generation: s.generation,
              });
              if (d.released)
                slots = slots.filter(
                  (x) => slotKey(x) !== slotKey({ computerId, generation: s.generation }),
                );
              floors.set(computerId, d.floor);
            } else {
              slots = slots.filter((x) => x.computerId !== computerId);
              floors.set(computerId, FORGOTTEN_FLOOR);
            }
            expect(slots.length).toBeLessThanOrEqual(limit);
            for (const id of ids) {
              expect(slots.filter((x) => x.computerId === id).length).toBeLessThanOrEqual(1);
            }
          }
        },
      ),
    );
  });
});
