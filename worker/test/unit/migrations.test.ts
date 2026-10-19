import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { type Migration, planMigrations } from "../../src/shared/migrations.ts";

const make = (count: number): Migration[] =>
  Array.from({ length: count }, (_, i) => ({
    version: i + 1,
    name: `m${i + 1}`,
    statements: [`CREATE TABLE t${i + 1} (x INTEGER)`],
  }));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return errorCodeOf(error);
  }
  return "no error";
}

describe("planMigrations", () => {
  it("returns every migration for a new database", () => {
    expect(planMigrations(0, make(3)).map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it("returns nothing when the database is current", () => {
    expect(planMigrations(3, make(3))).toEqual([]);
  });

  it("refuses a database newer than the code", () => {
    expect(codeOf(() => planMigrations(4, make(3)))).toBe("unsupported_version");
  });

  it("refuses gaps, duplicates and out-of-order versions", () => {
    const gap = [make(1)[0], { ...make(3)[2] }] as Migration[];
    expect(codeOf(() => planMigrations(0, gap))).toBe("internal");
    const duplicate = [make(1)[0], make(1)[0]] as Migration[];
    expect(codeOf(() => planMigrations(0, duplicate))).toBe("internal");
  });

  it("refuses an empty migration and an invalid applied version", () => {
    const empty: Migration[] = [{ version: 1, name: "empty", statements: [] }];
    expect(codeOf(() => planMigrations(0, empty))).toBe("internal");
    expect(codeOf(() => planMigrations(-1, make(1)))).toBe("internal");
    expect(codeOf(() => planMigrations(0.5, make(1)))).toBe("internal");
  });

  it("always returns exactly the suffix after the applied version", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (n, applied) => {
          const migrations = make(n);
          if (applied > n) {
            expect(codeOf(() => planMigrations(applied, migrations))).toBe("unsupported_version");
          } else {
            expect(planMigrations(applied, migrations)).toEqual(migrations.slice(applied));
          }
        },
      ),
    );
  });
});
