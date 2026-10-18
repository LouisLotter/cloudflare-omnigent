import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { ErrorBody } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import type { ControlDO } from "../../src/control/ControlDO.ts";
import { CONTROL_MIGRATIONS } from "../../src/control/schema.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { migrate } from "../../src/shared/sql.ts";

describe("ControlDO", () => {
  it("applies its schema once and keeps state across eviction", async () => {
    const stub = env.CONTROL.getByName("installation");
    expect(await stub.health()).toEqual({ schemaVersion: 1, boots: 1 });

    await evictDurableObject(stub);
    expect(await stub.health()).toEqual({ schemaVersion: 1, boots: 2 });

    await evictDurableObject(stub);
    expect(await stub.health()).toEqual({ schemaVersion: 1, boots: 3 });

    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const rows = state.storage.sql.exec("SELECT version, name FROM _cfo_schema").toArray();
      expect(rows).toEqual([{ version: 1, name: "control_meta" }]);
    });
  });

  it("refuses to run older code against a newer database", async () => {
    const stub = env.CONTROL.getByName("downgrade");
    await stub.health();
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      expect(migrate(state.storage, CONTROL_MIGRATIONS)).toBe(1);
      let code: string | undefined;
      try {
        migrate(state.storage, []);
      } catch (error) {
        code = errorCodeOf(error);
      }
      expect(code).toBe("unsupported_version");
    });
  });
});

describe("migration failure", () => {
  it("rolls back a failed migration completely, including its journal entry", async () => {
    const stub = env.CONTROL.getByName("failed-migration");
    await stub.health();
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const broken = [
        ...CONTROL_MIGRATIONS,
        {
          version: 2,
          name: "broken",
          statements: [
            "CREATE TABLE half_done (x INTEGER)",
            "INSERT INTO table_that_does_not_exist VALUES (1)",
          ],
        },
      ];
      expect(() => migrate(state.storage, broken)).toThrow();
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((row) => row.name);
      expect(tables).not.toContain("half_done");
      const versions = state.storage.sql.exec("SELECT version FROM _cfo_schema").toArray();
      expect(versions).toEqual([{ version: 1 }]);
    });
    // The object still starts after the failed attempt, at its original version.
    await evictDurableObject(stub);
    expect((await stub.health()).schemaVersion).toBe(1);

    // A corrected migration then applies cleanly. (The object is not restarted afterwards:
    // its code only knows version 1, and downgrade protection would refuse to start it.)
    await runInDurableObject(stub, (_instance: ControlDO, state) => {
      const fixed = [
        ...CONTROL_MIGRATIONS,
        { version: 2, name: "fixed", statements: ["CREATE TABLE half_done (x INTEGER)"] },
      ];
      expect(migrate(state.storage, fixed)).toBe(2);
    });
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
