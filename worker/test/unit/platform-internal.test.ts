import { describe, expect, it } from "vitest";
import { isServerProps, PLATFORM_INTERNAL_HOST } from "../../src/server/platform-internal.ts";

describe("platform.internal's registration", () => {
  it("is the contract's host, and only the server's own props pass", () => {
    expect(PLATFORM_INTERNAL_HOST).toBe("platform.internal");
    expect(isServerProps({ propsVersion: 1, caller: "omnigent-server" })).toBe(true);
    for (const props of [
      undefined,
      null,
      "omnigent-server",
      { propsVersion: 2, caller: "omnigent-server" },
      { propsVersion: 1, caller: "computer" },
      {
        propsVersion: 1,
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3",
        generation: 1,
        hostId: null,
      },
    ]) {
      expect(isServerProps(props)).toBe(false);
    }
  });
});
