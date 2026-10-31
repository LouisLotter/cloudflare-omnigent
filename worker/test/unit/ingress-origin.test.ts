import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { OMNIGENT_INTERNAL_ORIGIN, originAllowed } from "../../src/ingress/origin.ts";

const ORIGIN = "https://cfo.example.com";
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/v1/sessions`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: "x" }),
  });

describe("originAllowed", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "PROPFIND", "post"])(
    "refuses %s from a foreign, null, sibling or differently spelled origin",
    (method) => {
      for (const origin of [
        "https://attacker.example",
        "null",
        "https://sibling.example.com",
        "http://cfo.example.com",
        "https://cfo.example.com:443",
        "https://cfo.example.com/",
        "https://CFO.example.com",
        "",
      ]) {
        expect(originAllowed(req(method, { origin }), ORIGIN), `${method} ${origin}`).toBe(false);
      }
    },
  );

  it("allows an unsafe method from the exact origin, or with no Origin at all", () => {
    expect(originAllowed(req("POST", { origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(originAllowed(req("DELETE"), ORIGIN)).toBe(true);
  });

  it("allows safe methods from any origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(originAllowed(req(method, { origin: "https://attacker.example" }), ORIGIN)).toBe(true);
    }
  });

  it("refuses a WebSocket upgrade from another origin, and allows it from this one", () => {
    expect(
      originAllowed(
        req("GET", { upgrade: "websocket", origin: "https://attacker.example" }),
        ORIGIN,
      ),
    ).toBe(false);
    expect(originAllowed(req("GET", { upgrade: " WebSocket ", origin: "null" }), ORIGIN)).toBe(
      false,
    );
    expect(originAllowed(req("GET", { upgrade: "websocket", origin: ORIGIN }), ORIGIN)).toBe(true);
    expect(originAllowed(req("GET", { upgrade: "websocket" }), ORIGIN)).toBe(true);
    expect(originAllowed(req("GET", { upgrade: "h2c", origin: "null" }), ORIGIN)).toBe(true);
  });

  it("allows Omnigent's own non-browser marker, exactly, on unsafe methods and upgrades (WP3.43)", () => {
    // A personal machine's host tunnel, its runners' tunnels and REST calls, and Omnigent's SDK.
    expect(OMNIGENT_INTERNAL_ORIGIN).toBe("omnigent://internal");
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(originAllowed(req(method, { origin: OMNIGENT_INTERNAL_ORIGIN }), ORIGIN)).toBe(true);
    }
    expect(
      originAllowed(req("GET", { upgrade: "websocket", origin: OMNIGENT_INTERNAL_ORIGIN }), ORIGIN),
    ).toBe(true);
    // Only the exact marker: no other spelling, scheme or host passes.
    for (const origin of [
      "omnigent://internal/",
      "omnigent://Internal",
      "OMNIGENT://internal",
      "omnigent://internal.attacker.example",
      "omnigent://attacker",
      "omnigent:internal",
      "https://internal",
    ]) {
      expect(originAllowed(req("POST", { origin }), ORIGIN), origin).toBe(false);
      expect(originAllowed(req("GET", { upgrade: "websocket", origin }), ORIGIN), origin).toBe(
        false,
      );
    }
  });

  it("property: an unsafe request with an Origin passes exactly when it is this origin or the marker", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("POST", "PUT", "PATCH", "DELETE"),
        fc.oneof(
          fc.constant(ORIGIN),
          fc.constant(OMNIGENT_INTERNAL_ORIGIN),
          fc.webUrl(),
          fc.string(),
        ),
        (method, origin) => {
          let request: Request;
          try {
            request = req(method, { origin });
          } catch {
            return; // not a valid header value
          }
          const sent = request.headers.get("origin");
          expect(originAllowed(request, ORIGIN)).toBe(
            sent === ORIGIN || sent === OMNIGENT_INTERNAL_ORIGIN,
          );
        },
      ),
    );
  });
});
