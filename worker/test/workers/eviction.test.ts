import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { stepsWithEviction } from "../support/eviction.ts";

// ControlDO counts its constructions in storage, so `boots` shows each eviction.
describe("stepsWithEviction", () => {
  it("evicts between steps but not after the last one", async () => {
    const stub = env.CONTROL.getByName("between-steps");
    const indexes: number[] = [];

    const boots = await stepsWithEviction(stub, [
      async (control, index) => {
        indexes.push(index);
        return (await control.health()).boots;
      },
      async (control, index) => {
        indexes.push(index);
        return (await control.health()).boots;
      },
    ]);

    expect(boots).toEqual([1, 2]);
    expect(indexes).toEqual([0, 1]);
    expect((await stub.health()).boots).toBe(2);
  });

  it("evicts after the last step too when asked", async () => {
    const stub = env.CONTROL.getByName("after-last");

    await stepsWithEviction(stub, [(control) => control.health()], { evictAfterLast: true });

    expect((await stub.health()).boots).toBe(2);
  });

  it("stops at a failing step", async () => {
    const stub = env.CONTROL.getByName("failing-step");
    let laterStepRan = false;

    await expect(
      stepsWithEviction(stub, [
        (control) => control.health(),
        async () => {
          throw new Error("step failed");
        },
        async () => {
          laterStepRan = true;
        },
      ]),
    ).rejects.toThrow("step failed");
    expect(laterStepRan).toBe(false);
  });

  it("returns no results for no steps", async () => {
    expect(await stepsWithEviction(env.CONTROL.getByName("no-steps"), [])).toEqual([]);
  });
});

describe("storage between tests in one file", () => {
  // The eviction module's documentation relies on this behaviour of @cloudflare/vitest-plugin
  // 1.4.0: Durable Object storage is not reset between tests, so tests use distinct object names.
  // If an upgrade changes it, update that documentation.
  it("first test leaves two boots in storage and no running instance", async () => {
    const stub = env.CONTROL.getByName("shared-between-tests");
    const health = await stepsWithEviction(stub, [(c) => c.health(), (c) => c.health()], {
      evictAfterLast: true,
    });
    expect(health.map((result) => result.boots)).toEqual([1, 2]);
  });

  it("second test sees the first test's storage", async () => {
    expect((await env.CONTROL.getByName("shared-between-tests").health()).boots).toBe(3);
  });
});
