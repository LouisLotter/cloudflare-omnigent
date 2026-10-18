import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  decide,
  isManagedPath,
  markManaged,
  normalizeBasePath,
  percentDecode,
} from "../src/guard.ts";

function view(method: string, path: string, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return { method, url: `http://omnigent.internal${path}`, headers: h };
}

/** Python's urllib.parse.unquote, as uvicorn applies it, for the cases checked here. */
describe("percentDecode", () => {
  it("decodes letters, slashes and UTF-8 like unquote", () => {
    expect(percentDecode("/v1/%73haring")).toBe("/v1/sharing");
    expect(percentDecode("/v1%2Fsharing")).toBe("/v1/sharing");
    expect(percentDecode("/v1%2fsharing")).toBe("/v1/sharing");
    expect(percentDecode("/%EF%BD%93")).toBe("/ｓ");
  });
  it("leaves invalid escapes literal and replaces invalid UTF-8", () => {
    expect(percentDecode("/a%zz%4")).toBe("/a%zz%4");
    expect(percentDecode("/%FF")).toBe("/�");
  });
  it("decodes only once", () => {
    expect(percentDecode("/v1/%2573haring")).toBe("/v1/%73haring");
  });
});

describe("canonicalPath", () => {
  it.each([
    ["/v1/sharing", "/v1/sharing"],
    ["/v1/sharing/", "/v1/sharing"],
    ["//v1//sharing//", "/v1/sharing"],
    ["/V1/SHARING", "/v1/sharing"],
    ["/v1/%2573haring", "/v1/sharing"],
    ["/v1%252Fsharing", "/v1/sharing"],
    ["/v1/x/../sharing", "/v1/sharing"],
    ["/v1/x/%2e%2e/sharing", "/v1/sharing"],
    ["/v1/x%2F..%2Fsharing", "/v1/sharing"],
    ["/v1\\sharing", "/v1/sharing"],
    ["/v1%5Csharing", "/v1/sharing"],
    ["/v1/sharing;x=1", "/v1/sharing"],
    ["/v1/sharing%00", "/v1/sharing"],
    ["/v1/sharing.", "/v1/sharing"],
    ["/v1/sharing%20", "/v1/sharing"],
    ["/../../v1/sharing", "/v1/sharing"],
  ])("%s -> %s", (input, output) => {
    expect(canonicalPath(input)).toBe(output);
  });
});

describe("isManagedPath", () => {
  it("matches the endpoint and anything under it", () => {
    expect(isManagedPath("/v1/sharing")).toBe(true);
    expect(isManagedPath("/v1/sharing/reset")).toBe(true);
  });
  it("does not match near misses", () => {
    for (const path of [
      "/v1/sharingx",
      "/v1/sharing-x",
      "/x/v1/sharing",
      "/v1/%EF%BD%93haring",
      "/v1/sessions/abc/sharing",
      "/v1/info",
      "/settings/sharing",
    ]) {
      expect(isManagedPath(path), path).toBe(false);
    }
  });
  it("matches under a configured base path, and still without it", () => {
    const base = normalizeBasePath("/omni/");
    expect(base).toBe("/omni");
    expect(isManagedPath("/omni/v1/sharing", base)).toBe(true);
    expect(isManagedPath("/OMNI/v1/%73haring", base)).toBe(true);
    expect(isManagedPath("/v1/sharing", base)).toBe(true);
    expect(isManagedPath("/other/v1/sharing", base)).toBe(false);
  });
  it("normalizes empty and root base paths to none", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("omni")).toBe("/omni");
  });
});

describe("decide", () => {
  it("reads GET and HEAD, refuses every other method", () => {
    expect(decide(view("GET", "/v1/sharing"))).toEqual({ action: "read" });
    expect(decide(view("HEAD", "/v1/sharing"))).toEqual({ action: "read" });
    for (const method of ["PUT", "put", "POST", "PATCH", "DELETE", "OPTIONS", "PROPPATCH", "FOO"]) {
      expect(decide(view(method, "/v1/sharing")).action, method).toBe("refuse");
    }
  });
  it("refuses method overrides and upgrades even on GET", () => {
    for (const header of ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"]) {
      expect(decide(view("GET", "/v1/sharing", { [header]: "PUT" })).action).toBe("refuse");
    }
    expect(decide(view("GET", "/v1/sharing?_method=PUT")).action).toBe("refuse");
    expect(decide(view("GET", "/v1/sharing?%5FMETHOD=PUT")).action).toBe("refuse");
    expect(decide(view("GET", "/v1/sharing", { Upgrade: "websocket" })).action).toBe("refuse");
  });
  it("passes everything that is not the managed path", () => {
    expect(decide(view("PUT", "/v1/sessions/abc"))).toEqual({ action: "pass" });
    expect(decide(view("GET", "/v1/info", { "X-HTTP-Method-Override": "PUT" }))).toEqual({
      action: "pass",
    });
  });
});

describe("markManaged", () => {
  it("sets every editable flag to false and keeps the values", () => {
    const out = markManaged({
      object: "sharing",
      sharing_mode: "read_only",
      editable: true,
      public_sharing_enabled: false,
      public_sharing_editable: true,
      public_sharing_max_level_editable: true,
      default_public_sessions_editable: true,
      future_setting_editable: true,
    });
    expect(out).toMatchObject({
      sharing_mode: "read_only",
      public_sharing_enabled: false,
      editable: false,
      public_sharing_editable: false,
      public_sharing_max_level_editable: false,
      default_public_sessions_editable: false,
      future_setting_editable: false,
      managed: true,
    });
  });
  it("refuses anything that is not an object", () => {
    for (const value of [null, [], "x", 1]) expect(() => markManaged(value)).toThrow();
  });
});

// Property tests: any spelling of the managed path that the server, or the Worker's URL parser,
// could turn back into /v1/sharing is refused for writes.

const encodeChar = (c: string, mode: number): string => {
  const hex = c.charCodeAt(0).toString(16).padStart(2, "0");
  if (mode === 1) return `%${hex.toLowerCase()}`;
  if (mode === 2) return `%${hex.toUpperCase()}`;
  if (mode === 3) return `%25${hex.toUpperCase()}`;
  return c;
};

const spelledPath = fc
  .record({
    leading: fc.integer({ min: 1, max: 3 }),
    middle: fc.integer({ min: 1, max: 3 }),
    trailing: fc.integer({ min: 0, max: 2 }),
    upper: fc.array(fc.boolean(), { minLength: 9, maxLength: 9 }),
    modes: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 9, maxLength: 9 }),
    slashMode: fc.integer({ min: 0, max: 3 }),
    dots: fc.constantFrom("", "/.", "/x/..", "/%2e", "/x/%2e%2e"),
    query: fc.constantFrom("", "?a=1", "?x=y&z"),
  })
  .map((p) => {
    const chars = "v1sharing".split("").map((c, i) => (p.upper[i] ? c.toUpperCase() : c));
    const enc = chars.map((c, i) => encodeChar(c, p.modes[i] ?? 0));
    const v1 = enc.slice(0, 2).join("");
    const sharing = enc.slice(2).join("");
    const sep = p.slashMode === 0 ? "/".repeat(p.middle) : encodeChar("/", p.slashMode);
    return `${"/".repeat(p.leading)}${v1}${p.dots}${sep}${sharing}${"/".repeat(p.trailing)}${p.query}`;
  });

describe("properties", () => {
  it("refuses writes to every spelling of the managed path", () => {
    fc.assert(
      fc.property(spelledPath, fc.constantFrom("PUT", "POST", "PATCH", "DELETE"), (path, m) => {
        const url = new URL(`http://h${path}`);
        expect(decide(view(m, url.pathname + url.search)).action).toBe("refuse");
      }),
      { numRuns: 2000 },
    );
  });

  it("never refuses paths whose segments do not spell the managed path", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9_-]{1,12}$/), { minLength: 1, maxLength: 5 }),
        (segments) => {
          fc.pre(!(segments[0] === "v1" && segments[1] === "sharing"));
          const path = `/${segments.join("/")}`;
          expect(decide(view("PUT", path)).action).toBe("pass");
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("canonicalPath is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (s) => {
        const once = canonicalPath(`/${s}`);
        expect(canonicalPath(once)).toBe(once);
      }),
      { numRuns: 2000 },
    );
  });
});
