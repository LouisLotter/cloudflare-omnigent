import { describe, expect, it } from "vitest";
import { CONTROL_MIGRATIONS } from "../../src/control/schema.ts";
import { type Migration, planMigrations } from "../../src/shared/migrations.ts";

// Each Durable Object's migration registry must be a valid list: versions 1..n in order and no
// empty migration. Checked here in Node, so a broken registry fails before any object boots.
const registries: [string, readonly Migration[]][] = [["ControlDO", CONTROL_MIGRATIONS]];

describe("Durable Object schema registries", () => {
  it.each(registries)("%s: a new database applies every migration", (_name, migrations) => {
    expect(planMigrations(0, migrations)).toEqual(migrations);
  });

  it.each(registries)("%s: a current database applies nothing", (_name, migrations) => {
    expect(planMigrations(migrations.length, migrations)).toEqual([]);
  });
});
