import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { ErrorBody } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import type { ControlDO } from "../../src/control/ControlDO.ts";
import { CONTROL_MIGRATIONS } from "../../src/control/schema.ts";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { migrate } from "../../src/shared/sql.ts";
import { stepsWithEviction } from "../support/eviction.ts";

describe("ControlDO", () => {
  it("applies its schema once and keeps state across eviction", async () => {
    const stub = env.CONTROL.getByName("installation");
    const health = await stepsWithEviction(stub, [
      (control) => control.health(),
      (control) => control.health(),
      (control) => control.health(),
    ]);
    expect(health).toEqual([
      { schemaVersion: 1, boots: 1 },
      { schemaVersion: 1, boots: 2 },
      { schemaVersion: 1, boots: 3 },
    ]);

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
