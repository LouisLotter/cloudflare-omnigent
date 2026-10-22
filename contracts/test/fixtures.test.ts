import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SupervisorMessage, wireSchemas } from "../src/index.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f));
}

const load = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));

describe("golden fixtures", () => {
  it("has a fixture directory for every wire schema, and no orphans", () => {
    const dirs = readdirSync(fixturesDir).sort();
    expect(dirs).toEqual(Object.keys(wireSchemas).sort());
  });

  for (const [name, schema] of Object.entries(wireSchemas)) {
    const valid = jsonFiles(join(fixturesDir, name));
    const invalid = jsonFiles(join(fixturesDir, name, "invalid"));
    // Invalid only by a check the exported JSON Schema cannot express (a cross-field rule).
    const refined = jsonFiles(join(fixturesDir, name, "refined"));

    it(`${name} has at least one valid and one invalid fixture`, () => {
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
    });

    for (const file of valid) {
      it(`${name} accepts ${file.split("/").pop()} and round-trips it unchanged`, () => {
        const input = load(file);
        const parsed = schema.parse(input);
        expect(JSON.parse(JSON.stringify(parsed))).toEqual(input);
      });
    }

    for (const file of invalid) {
      it(`${name} rejects invalid/${file.split("/").pop()}`, () => {
        expect(schema.safeParse(load(file)).success).toBe(false);
      });
    }

    for (const file of refined) {
      it(`${name} rejects refined/${file.split("/").pop()}`, () => {
        expect(schema.safeParse(load(file)).success).toBe(false);
      });
    }
  }
});

describe("SupervisorMessage hello properties", () => {
  const base32 = "0123456789abcdefghjkmnpqrstvwxyz";
  const id26 = fc
    .array(fc.constantFrom(...base32.split("")), { minLength: 26, maxLength: 26 })
    .map((chars) => chars.join(""));

  it("accepts every well-formed hello and round-trips it through JSON", () => {
    fc.assert(
      fc.property(
        id26,
        id26,
        fc.nat(),
        fc.integer({ min: 1, max: 1000 }),
        (computer, operation, generation, protocolVersion) => {
          const hello = {
            type: "hello" as const,
            protocolVersion,
            computerId: `cmp_${computer}`,
            generation,
            operationId: `op_${operation}`,
            supervisorVersion: "0.1.0",
          };
          const parsed = SupervisorMessage.parse(hello);
          expect(JSON.parse(JSON.stringify(parsed))).toEqual(hello);
        },
      ),
    );
  });

  it("never throws on arbitrary JSON input, only reports failure", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(() => SupervisorMessage.safeParse(value)).not.toThrow();
      }),
    );
  });
});
