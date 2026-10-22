import { ErrorBody } from "@cfo/contracts";
import { describe, expect, it, vi } from "vitest";
import { describeError, errorResponse, logEvent } from "../../src/server/responses.ts";

describe("responses", () => {
  it("answers an ErrorBody that is never cached, with any extra headers", async () => {
    const plain = errorResponse(403, "forbidden", "Access denied.", false);
    expect(plain.headers.get("cache-control")).toBe("no-store");
    expect(ErrorBody.parse(await plain.json())).toEqual({
      error: { code: "forbidden", message: "Access denied.", retryable: false },
    });
    const retry = errorResponse(503, "unavailable", "Later.", true, { "retry-after": "5" });
    expect([retry.status, retry.headers.get("retry-after")]).toEqual([503, "5"]);
  });

  it("describes errors briefly and logs one JSON line", () => {
    expect(describeError(new TypeError("bad"))).toBe("TypeError: bad");
    expect(describeError("x".repeat(500))).toHaveLength(200);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("server", "upgrade", { path: "/v1/x" });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      cfo: "server",
      event: "upgrade",
      path: "/v1/x",
    });
    logEvent("watchdog", "no_container");
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toEqual({
      cfo: "watchdog",
      event: "no_container",
    });
    log.mockRestore();
  });
});
