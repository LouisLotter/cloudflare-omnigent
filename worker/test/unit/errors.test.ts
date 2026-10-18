import { ErrorCode } from "@cfo/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { errorCodeOf, platformError } from "../../src/shared/errors.ts";

describe("platform errors", () => {
  it("round-trips every error code through the message, as it must across RPC", () => {
    for (const code of ErrorCode.options) {
      const error = platformError(code, "something happened");
      // Simulate RPC: only the message survives.
      expect(errorCodeOf(new Error(error.message))).toBe(code);
    }
  });

  it("does not recognize unknown codes, plain errors or non-errors", () => {
    expect(errorCodeOf(new Error("[teapot] no"))).toBeUndefined();
    expect(errorCodeOf(new Error("plain failure"))).toBeUndefined();
    expect(errorCodeOf("[internal] a string is not an error")).toBeUndefined();
    expect(errorCodeOf(undefined)).toBeUndefined();
  });

  it("recognizes a code regardless of the message text", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ErrorCode.options), fc.string(), (code, text) => {
        expect(errorCodeOf(platformError(code, text))).toBe(code);
      }),
    );
  });
});
