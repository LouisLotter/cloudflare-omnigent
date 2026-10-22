import { describe, expect, it } from "vitest";
import { SERVER_MIGRATIONS } from "../../src/server/schema.ts";
import { planMigrations } from "../../src/shared/migrations.ts";

describe("OmnigentServer's schema", () => {
  it("is a valid migration list, applied in full to a new object", () => {
    expect(planMigrations(0, SERVER_MIGRATIONS).map((m) => m.name)).toEqual([
      "watchdog_and_outages",
    ]);
    expect(planMigrations(SERVER_MIGRATIONS.length, SERVER_MIGRATIONS)).toEqual([]);
  });
});
