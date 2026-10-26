import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/ingress/limits.ts";
import {
  type ComputerIdentity,
  canonicalPath,
  handleComputerRequest,
  hostTunnelCredentials,
  LAUNCH_TOKEN_HEADER,
  normalizeBasePath,
  normalizeHostId,
  policyDecision,
  ROUTE_HTTP_LIMITS,
  ROUTE_UPGRADE_LIMITS,
  type RouteDeps,
  serverRoutedPath,
} from "../../src/internal/omnigent-route.ts";
import { FORWARD_VERSION_HEADER } from "../../src/shared/rpc.ts";

const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "contracts",
  "fixtures",
);

const COMPUTER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3";
const HOST_A = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const HOST_B = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const TOKEN_A = "cfo-canary-launch-token-a-0123456789abcdef";
const TOKEN_B = "cfo-canary-launch-token-b-0123456789abcdef";
const BASE = "http://omnigent.internal";

const props = (overrides: Record<string, unknown> = {}) => ({
  propsVersion: 1,
  computerId: COMPUTER,
  generation: 4,
  hostId: HOST_A,
  ...overrides,
});

interface Harness {
  deps: RouteDeps;
  forwarded: Request[];
  logs: { event: string; fields: Readonly<Record<string, unknown>> }[];
  reads: number;
  identity: ComputerIdentity | Error;
  forwardError: Error | null;
  now: number;
}

function harness(): Harness {
  const h: Harness = {
    forwarded: [],
    logs: [],
    reads: 0,
    identity: { generation: 4, hostId: HOST_A },
    forwardError: null,
    now: 1_000_000,
    deps: undefined as unknown as RouteDeps,
  };
  h.deps = {
    httpLimiter: new RateLimiter(() => h.now, ROUTE_HTTP_LIMITS),
    upgradeLimiter: new RateLimiter(() => h.now, ROUTE_UPGRADE_LIMITS),
    readIdentity: async () => {
      h.reads += 1;
      if (h.identity instanceof Error) throw h.identity;
      return h.identity;
    },
    forward: async (request) => {
      h.forwarded.push(request);
      if (h.forwardError) throw h.forwardError;
      return new Response("from omnigent", { status: 200 });
    },
    answerUpgrade: (response) => response,
    log: (event, fields) => h.logs.push({ event, fields }),
  };
  return h;
}

function tunnelRequest(hostSegment: string, headers: Record<string, string>): Request {
  return new Request(`${BASE}/v1/hosts/${hostSegment}/tunnel`, {
    headers: { upgrade: "websocket", connection: "Upgrade", ...headers },
  });
}

describe("canonicalPath", () => {
  it.each([
    ["/auth/setup", "/auth/setup"],
    ["/AUTH/Setup", "/auth/setup"],
    ["/auth%2Fsetup", "/auth/setup"],
    ["/auth%252Fsetup", "/auth/setup"],
    ["/auth%25252Fsetup", "/auth/setup"],
    ["/auth%5Csetup", "/auth/setup"],
    ["//auth///setup/", "/auth/setup"],
    ["/v1/x/../../auth/setup", "/auth/setup"],
    ["/v1/x/%2e%2e/%2e%2e/auth/./setup", "/auth/setup"],
    ["/auth/setup;jsessionid=1", "/auth/setup"],
    ["/auth/setup.", "/auth/setup"],
    ["/auth/setup%20", "/auth/setup"],
    ["/auth/se%00tup", "/auth/setup"],
    ["/auth/s%C3%A9tup", "/auth/sétup"],
    ["/bad%zzpercent", "/bad%zzpercent"],
    ["/", "/"],
  ])("%s → %s", (raw, expected) => {
    expect(canonicalPath(raw).path).toBe(expected);
  });

  it("notes a decoded # or ? and paths that never settle", () => {
    expect(canonicalPath("/auth/setup%3Fx").decodedDelimiter).toBe(true);
    expect(canonicalPath("/auth/setup%23x").decodedDelimiter).toBe(true);
    expect(canonicalPath("/auth/setup").decodedDelimiter).toBe(false);
    expect(canonicalPath(`/a${"%25".repeat(1)}2525252F`).undecodable).toBe(true);
  });
});

describe("the block list, path by path", () => {
  const decide = (method: string, path: string, headers: Record<string, string> = {}) =>
    policyDecision(method, new URL(`${BASE}${path}`), new Headers(headers));

  const accountPaths = [
    "/auth/invite",
    "/auth/register",
    "/auth/magic",
    "/auth/magic/redeem",
    "/auth/setup",
    "/auth/users",
    "/auth/users/someone",
    "/auth/users/me/password",
    "/oauth",
    "/oauth/token",
    "/oauth/authorize/callback",
  ];
  it.each(accountPaths)("account administration: %s refuses changes, allows reads", (path) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "FOO"]) {
      expect(decide(method, path)).toEqual({ allowed: false, reason: "account" });
    }
    expect(decide("GET", path).allowed).toBe(true);
    expect(decide("HEAD", path).allowed).toBe(true);
  });

  it("sharing: PUT /v1/sharing, and POST or DELETE on a session's permissions", () => {
    expect(decide("PUT", "/v1/sharing")).toEqual({ allowed: false, reason: "sharing" });
    expect(decide("GET", "/v1/sharing").allowed).toBe(true);
    for (const path of [
      "/v1/sessions/abc/permissions",
      "/v1/sessions/abc/permissions/user-1",
      "/v1/sessions/abc/permissions-bulk",
    ]) {
      expect(decide("POST", path)).toEqual({ allowed: false, reason: "sharing" });
      expect(decide("DELETE", path)).toEqual({ allowed: false, reason: "sharing" });
      expect(decide("GET", path).allowed).toBe(true);
    }
  });

  it("the dedicated approval route refuses every change", () => {
    const path = "/v1/sessions/abc/elicitations/el-1/resolve";
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(decide(method, path)).toEqual({ allowed: false, reason: "approval" });
    }
    expect(decide("GET", path).allowed).toBe(true);
  });

  it("leaves ordinary agent and runner traffic alone", () => {
    for (const [method, path] of [
      ["POST", "/v1/sessions/abc/events"],
      ["POST", "/v1/sessions"],
      ["GET", "/v1/sessions/abc"],
      ["POST", "/v1/runners/runner_token_abc/token"],
      ["GET", "/v1/runners/runner_token_abc/tunnel"],
      ["POST", "/v1/hosts/abc/runners"],
      ["POST", "/auth/login"],
      ["POST", "/v1/sessions/abc/policies"],
      ["GET", "/v1/info"],
    ] as const) {
      expect(decide(method, path)).toEqual({ allowed: true, hostTunnel: null });
    }
  });

  it("refuses method overrides on any path", () => {
    expect(decide("POST", "/v1/sessions/abc/events", { "x-http-method-override": "GET" })).toEqual({
      allowed: false,
      reason: "method_override",
    });
    expect(decide("GET", "/v1/info", { "X-HTTP-Method": "PUT" }).allowed).toBe(false);
    expect(decide("GET", "/v1/info", { "x-method-override": "PUT" }).allowed).toBe(false);
    expect(decide("POST", "/v1/sessions?_method=GET").allowed).toBe(false);
    expect(decide("POST", "/v1/sessions?%5Fmethod=GET").allowed).toBe(false);
    expect(decide("POST", "/v1/sessions?_METHOD=GET").allowed).toBe(false);
  });

  it("refuses an encoded # or ? on a managed prefix, and an undecodable path", () => {
    expect(decide("GET", "/auth/setup%3F").allowed).toBe(false);
    expect(decide("GET", "/v1/sessions/a%23b").allowed).toBe(false);
    expect(decide("GET", "/files/a%3Fb").allowed).toBe(true);
    expect(decide("GET", "/a%2525252525").allowed).toBe(false);
  });

  it("strips a configured base path before matching", () => {
    const url = new URL(`${BASE}/omnigent/auth/setup`);
    expect(policyDecision("POST", url, new Headers(), "/omnigent").allowed).toBe(false);
    expect(policyDecision("POST", url, new Headers(), "").allowed).toBe(true);
    expect(
      policyDecision("GET", new URL(`${BASE}/omnigent`), new Headers(), "/omnigent/").allowed,
    ).toBe(true);
  });

  it("names the host of a host tunnel, in Omnigent's normal form", () => {
    expect(decide("GET", `/v1/hosts/${HOST_A}/tunnel`)).toEqual({
      allowed: true,
      hostTunnel: HOST_A,
    });
    expect(decide("GET", `/v1/hosts/host_${HOST_A.toUpperCase()}/tunnel/`)).toEqual({
      allowed: true,
      hostTunnel: HOST_A,
    });
    expect(decide("GET", `/v1/hosts/${HOST_B}%2Ftunnel`)).toEqual({
      allowed: true,
      hostTunnel: HOST_B,
    });
    expect(decide("GET", "/v1/hosts/not-a-uuid/tunnel")).toEqual({
      allowed: false,
      reason: "host_id_malformed",
    });
  });

  // Property: however a blocked path is spelled, an unsafe method on it is refused.
  it("refuses every encoded, cased or padded spelling of a blocked path", () => {
    const blocked = [
      "/auth/setup",
      "/auth/users/me/password",
      "/oauth/token",
      "/v1/sessions/s1/elicitations/e1/resolve",
      "/v1/sessions/s1/permissions",
    ];
    const char = (c: string) =>
      fc.constantFrom(
        c,
        c.toUpperCase(),
        `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
        `%25${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
    const spelled = fc
      .constantFrom(...blocked)
      .chain((path) =>
        fc.tuple(
          ...path
            .split("/")
            .slice(1)
            .map((segment) =>
              fc.tuple(
                fc.tuple(...[...segment].map((c) => char(c))).map((cs) => cs.join("")),
                fc.constantFrom("", ";x=1", ".", "%20", "%2e"),
                fc.constantFrom("/", "//", "/./", "%2F", "%5C", "\\"),
              ),
            ),
        ),
      )
      .map((parts) =>
        parts
          .map(([segment, pad, slash], i) => `${i === 0 ? "/" : slash}${segment}${pad}`)
          .join(""),
      );
    fc.assert(
      fc.property(spelled, fc.constantFrom("POST", "DELETE"), (path, method) => {
        const decision = policyDecision(method, new URL(`${BASE}${path}`), new Headers());
        expect(decision.allowed).toBe(false);
      }),
      { numRuns: 500 },
    );
  });
});

describe("host IDs and a host tunnel's credentials", () => {
  it("normalizes as Omnigent does, accepting at least what it accepts", () => {
    expect(normalizeHostId(HOST_A)).toBe(HOST_A);
    expect(normalizeHostId("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")).toBe(HOST_A);
    expect(normalizeHostId(`host_${HOST_A}`)).toBe(HOST_A);
    expect(normalizeHostId(`agy_conv_${HOST_A}`)).toBe(HOST_A);
    expect(normalizeHostId(HOST_A.toUpperCase())).toBe(HOST_A);
    expect(normalizeHostId(`unknown_${HOST_A}`)).toBeNull();
    expect(normalizeHostId(HOST_A.slice(1))).toBeNull();
    expect(normalizeHostId("zz".repeat(16))).toBeNull();
  });

  it("wants exactly one launch token and no other credential", () => {
    const h = (entries: Record<string, string>) => hostTunnelCredentials(new Headers(entries));
    expect(h({ [LAUNCH_TOKEN_HEADER]: TOKEN_A })).toBe("ok");
    expect(h({})).toBe("no_launch_token");
    expect(h({ [LAUNCH_TOKEN_HEADER]: " " })).toBe("no_launch_token");
    expect(h({ authorization: "Bearer x" })).toBe("no_launch_token");
    expect(h({ [LAUNCH_TOKEN_HEADER]: TOKEN_A, authorization: "Bearer x" })).toBe("conflicting");
    expect(h({ [LAUNCH_TOKEN_HEADER]: TOKEN_A, cookie: "session=x" })).toBe("conflicting");
    expect(h({ [LAUNCH_TOKEN_HEADER]: "short" })).toBe("conflicting");
    const two = new Headers();
    two.append(LAUNCH_TOKEN_HEADER, TOKEN_A);
    two.append(LAUNCH_TOKEN_HEADER, TOKEN_B);
    expect(hostTunnelCredentials(two)).toBe("conflicting");
  });
});

describe("handleComputerRequest", () => {
  it("forwards ordinary traffic once, with trust headers stripped and the interface version", async () => {
    const h = harness();
    const response = await handleComputerRequest(
      new Request(`${BASE}/v1/sessions/abc/events?secret=x`, {
        method: "POST",
        body: "{}",
        headers: {
          "x-forwarded-email": "someone@example.test",
          "cf-access-jwt-assertion": "forged",
          "x-cfo-interface-version": "999",
          authorization: "Bearer runner-owner-token",
        },
      }),
      props(),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    const sent = h.forwarded[0] as Request;
    expect(sent.headers.get("x-forwarded-email")).toBeNull();
    expect(sent.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(sent.headers.get(FORWARD_VERSION_HEADER)).toBe("1");
    expect(sent.headers.get("authorization")).toBe("Bearer runner-owner-token");
    expect(sent.redirect).toBe("manual");
    expect(sent.method).toBe("POST");
    expect(await sent.text()).toBe("{}");
    // Logged by path and status, never the query string or a header value.
    const line = JSON.stringify(h.logs);
    expect(line).toContain('"path":"/v1/sessions/abc/events"');
    expect(line).not.toContain("secret=x");
    expect(line).not.toContain("runner-owner-token");
  });

  it("refuses a blocked path before the server, its identity or its limits are touched", async () => {
    const h = harness();
    const response = await handleComputerRequest(
      new Request(`${BASE}/auth/setup`, { method: "POST", body: "{}" }),
      props(),
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden", retryable: false } });
    expect(h.forwarded).toHaveLength(0);
    expect(h.reads).toBe(0);
  });

  it.each([
    ["no props", undefined],
    ["a newer props version", props({ propsVersion: 2 })],
    ["props with a token", { ...props(), token: TOKEN_A }],
    ["another shape", { computerId: COMPUTER }],
  ])("refuses %s", async (_name, raw) => {
    const h = harness();
    const response = await handleComputerRequest(new Request(`${BASE}/v1/info`), raw, h.deps);
    expect(response.status).toBe(503);
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses every intercept-props fixture the contract marks invalid", async () => {
    const dir = join(fixtures, "InterceptProps", "invalid");
    for (const name of readdirSync(dir)) {
      const h = harness();
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      const response = await handleComputerRequest(new Request(`${BASE}/v1/info`), raw, h.deps);
      expect(response.status, name).toBe(503);
    }
  });

  it("refuses a call from an older generation, and from a newer one it cannot confirm", async () => {
    const h = harness();
    h.identity = { generation: 5, hostId: HOST_A };
    const old = await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps);
    expect(old.status).toBe(409);
    expect(await old.json()).toMatchObject({ error: { code: "stale_generation" } });
    const ahead = await handleComputerRequest(
      new Request(`${BASE}/v1/info`),
      props({ generation: 6 }),
      h.deps,
    );
    expect(ahead.status).toBe(409);
    expect(h.forwarded).toHaveLength(0);
  });

  it("fails closed, retryably, when the computer's identity cannot be read", async () => {
    const h = harness();
    h.identity = new Error("Network connection lost.");
    const response = await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { retryable: true } });
    expect(h.forwarded).toHaveLength(0);
  });

  it("passes the computer's own host tunnel with its launch token", async () => {
    const h = harness();
    const response = await handleComputerRequest(
      tunnelRequest(HOST_A, { [LAUNCH_TOKEN_HEADER]: TOKEN_A, origin: "omnigent-internal://host" }),
      props(),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0]?.headers.get(LAUNCH_TOKEN_HEADER)).toBe(TOKEN_A);
  });

  // RC-23: computer A's hostile process tries B's identity on the live connection.
  it.each([
    ["B's host ID with A's token", tunnelRequest(HOST_B, { [LAUNCH_TOKEN_HEADER]: TOKEN_A })],
    [
      "B's host ID with no launch-token header",
      tunnelRequest(HOST_B, { authorization: "Bearer owner" }),
    ],
    [
      "B's host ID with both headers",
      tunnelRequest(HOST_B, { [LAUNCH_TOKEN_HEADER]: TOKEN_B, authorization: "Bearer owner" }),
    ],
    [
      "B's host ID, dashed",
      tunnelRequest(`${HOST_B.slice(0, 8)}-${HOST_B.slice(8)}`, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }),
    ],
    [
      "B's host ID, legacy prefix",
      tunnelRequest(`host_${HOST_B}`, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }),
    ],
    [
      "B's host ID, encoded slash",
      new Request(`${BASE}/v1/hosts/${HOST_B}%2Ftunnel`, {
        headers: { upgrade: "websocket", [LAUNCH_TOKEN_HEADER]: TOKEN_A },
      }),
    ],
    [
      "A's host ID with no launch-token header",
      tunnelRequest(HOST_A, { authorization: "Bearer owner" }),
    ],
    [
      "A's host ID with both headers",
      tunnelRequest(HOST_A, { [LAUNCH_TOKEN_HEADER]: TOKEN_A, authorization: "Bearer owner" }),
    ],
    [
      "A's host ID with conflicting headers",
      (() => {
        const headers = new Headers({ upgrade: "websocket" });
        headers.append(LAUNCH_TOKEN_HEADER, TOKEN_A);
        headers.append(LAUNCH_TOKEN_HEADER, TOKEN_B);
        return new Request(`${BASE}/v1/hosts/${HOST_A}/tunnel`, { headers });
      })(),
    ],
  ])("refuses %s", async (_name, request) => {
    const h = harness();
    const response = await handleComputerRequest(request, props(), h.deps);
    expect(response.status).toBe(403);
    expect(h.forwarded).toHaveLength(0);
  });

  it("refuses a host tunnel before Omnigent bound a host, or when the props disagree", async () => {
    const h = harness();
    h.identity = { generation: 4, hostId: null };
    const unbound = await handleComputerRequest(
      tunnelRequest(HOST_A, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }),
      props({ hostId: null }),
      h.deps,
    );
    expect(unbound.status).toBe(403);
    h.identity = { generation: 4, hostId: HOST_A };
    const disagree = await handleComputerRequest(
      tunnelRequest(HOST_A, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }),
      props({ hostId: HOST_B }),
      h.deps,
    );
    expect(disagree.status).toBe(403);
    expect(h.forwarded).toHaveLength(0);
  });

  it("reads the identity for every request, so a generation change fences at once (r1-2)", async () => {
    const h = harness();
    expect(
      (await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps)).status,
    ).toBe(200);
    h.identity = { generation: 5, hostId: HOST_A }; // WorkspaceDO started generation 5
    const old = await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps);
    expect(old.status).toBe(409);
    expect(h.reads).toBe(2);
    expect(h.forwarded).toHaveLength(1);
  });

  it("repeats a failed identity read once before refusing", async () => {
    const h = harness();
    let calls = 0;
    h.deps = {
      ...h.deps,
      readIdentity: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Network connection lost.");
        return { generation: 4, hostId: HOST_A };
      },
    };
    expect(
      (await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps)).status,
    ).toBe(200);
    expect(calls).toBe(2);
  });

  it("limits each computer's requests, upgrades apart from HTTP", async () => {
    const h = harness();
    for (let i = 0; i < ROUTE_UPGRADE_LIMITS.burst; i += 1) {
      const ok = await handleComputerRequest(
        new Request(`${BASE}/v1/runners/r/tunnel`, { headers: { upgrade: "websocket" } }),
        props(),
        h.deps,
      );
      expect(ok.status).toBe(200);
    }
    const limited = await handleComputerRequest(
      new Request(`${BASE}/v1/runners/r/tunnel`, { headers: { upgrade: "websocket" } }),
      props(),
      h.deps,
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    // HTTP has its own budget, and another computer its own bucket.
    expect(
      (await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps)).status,
    ).toBe(200);
  });

  it("never repeats a forward that failed; a lost change is not retryable, a lost read is (r1-3)", async () => {
    const h = harness();
    h.forwardError = new Error("Network connection lost.");
    const change = await handleComputerRequest(
      new Request(`${BASE}/v1/sessions`, { method: "POST", body: "{}" }),
      props(),
      h.deps,
    );
    expect(change.status).toBe(502);
    expect(await change.json()).toMatchObject({ error: { code: "unavailable", retryable: false } });
    expect(h.forwarded).toHaveLength(1);
    const read = await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), h.deps);
    expect(read.status).toBe(503);
    expect(await read.json()).toMatchObject({ error: { retryable: true } });
    expect(h.forwarded).toHaveLength(2);
  });

  it("applies the rules under Omnigent's base path too, and refuses everything with a bad one (r1-1)", async () => {
    const h = harness();
    h.deps = { ...h.deps, basePath: "/omnigent" };
    const sharing = await handleComputerRequest(
      new Request(`${BASE}/omnigent/v1/sharing`, { method: "PUT", body: "{}" }),
      props(),
      h.deps,
    );
    expect(sharing.status).toBe(403);
    const prefixedOther = await handleComputerRequest(
      new Request(`${BASE}/omnigent/v1/hosts/${HOST_B}/tunnel`, {
        headers: { upgrade: "websocket", [LAUNCH_TOKEN_HEADER]: TOKEN_A },
      }),
      props(),
      h.deps,
    );
    expect(prefixedOther.status).toBe(403);
    const own = await handleComputerRequest(
      new Request(`${BASE}/omnigent/v1/hosts/${HOST_A}/tunnel`, {
        headers: { upgrade: "websocket", [LAUNCH_TOKEN_HEADER]: TOKEN_A },
      }),
      props(),
      h.deps,
    );
    expect(own.status).toBe(200);
    expect(h.forwarded).toHaveLength(1);
    const bad = await handleComputerRequest(new Request(`${BASE}/v1/info`), props(), {
      ...h.deps,
      basePath: null,
    });
    expect(bad.status).toBe(503);
  });
});

describe("normalizeBasePath (Omnigent's _normalize_base_path)", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    ["/", ""],
    [" /omnigent/ ", "/omnigent"],
    ["proxy/6767", "/proxy/6767"],
    ["//evil.example", null],
    ["/a b", null],
    ["/a%2Fb", null],
    ["/a/../b", null],
    ["/a/./b", null],
  ])("%s → %s", (value, expected) => {
    expect(normalizeBasePath(value)).toBe(expected);
  });
});

describe("upgrades on blocked paths (r1-8)", () => {
  it("refuses an upgrade on a blocked path even as GET", () => {
    const url = new URL(`${BASE}/auth/users`);
    expect(policyDecision("GET", url, new Headers({ upgrade: "websocket" })).allowed).toBe(false);
    expect(policyDecision("GET", url, new Headers()).allowed).toBe(true);
    expect(
      policyDecision(
        "GET",
        new URL(`${BASE}/v1/sessions/s/stream`),
        new Headers({ upgrade: "websocket" }),
      ).allowed,
    ).toBe(true);
  });
});

describe("base paths", () => {
  it("leaves a path without the base path as it is", () => {
    const url = new URL(`${BASE}/auth/setup`);
    expect(policyDecision("POST", url, new Headers(), "/omnigent").allowed).toBe(false);
  });
});

describe("base paths Omnigent accepts but a canonical strip would misread (r2-1)", () => {
  it("normalizes exactly as Omnigent: case-sensitive reserved first segments refused", () => {
    expect(normalizeBasePath("/V1")).toBe("/V1");
    expect(normalizeBasePath("/v1.")).toBe("/v1.");
    expect(normalizeBasePath("/AUTH")).toBe("/AUTH");
    for (const reserved of [
      "/v1",
      "/v1/x",
      "/auth",
      "/oauth",
      "/api",
      "/login",
      "/c",
      "/settings",
      "/.well-known",
    ]) {
      expect(normalizeBasePath(reserved), reserved).toBeNull();
    }
  });

  it("routes as Omnigent's middleware: decoded once, a literal case-sensitive prefix", () => {
    expect(serverRoutedPath("/V1/v1/sharing", "/V1")).toBe("/v1/sharing");
    expect(serverRoutedPath("/v1/sharing", "/V1")).toBe("/v1/sharing");
    expect(serverRoutedPath("/V1", "/V1")).toBe("/");
    expect(serverRoutedPath("/V1x/a", "/V1")).toBe("/V1x/a");
    expect(serverRoutedPath("/omnigent%2Fv1/sharing", "/omnigent")).toBe("/v1/sharing");
    expect(serverRoutedPath("/a", "")).toBe("/a");
  });

  it.each([
    ["/V1", "PUT", "/v1/sharing"],
    ["/v1.", "PUT", "/v1/sharing"],
    ["/AUTH", "POST", "/auth/users"],
    ["/V1", "PUT", "/V1/v1/sharing"],
    ["/AUTH", "POST", "/AUTH/auth/users"],
    ["/omnigent", "POST", "/omnigent/v1/sessions/s/elicitations/e/resolve"],
  ])("with base %s, %s %s is refused", (base, method, path) => {
    expect(policyDecision(method, new URL(`${BASE}${path}`), new Headers(), base).allowed).toBe(
      false,
    );
  });

  it("binds a host tunnel found in either form", () => {
    for (const path of [`/v1/hosts/${HOST_B}/tunnel`, `/V1/v1/hosts/${HOST_B}/tunnel`]) {
      expect(policyDecision("GET", new URL(`${BASE}${path}`), new Headers(), "/V1")).toEqual({
        allowed: true,
        hostTunnel: HOST_B,
      });
    }
  });

  it("refuses B's tunnel through the handler under base /V1, with or without a launch token", async () => {
    for (const headers of [{ authorization: "Bearer owner" }, { [LAUNCH_TOKEN_HEADER]: TOKEN_A }]) {
      const h = harness();
      h.deps = { ...h.deps, basePath: "/V1" };
      const response = await handleComputerRequest(
        new Request(`${BASE}/v1/hosts/${HOST_B}/tunnel`, {
          headers: { upgrade: "websocket", ...headers },
        }),
        props(),
        h.deps,
      );
      expect(response.status).toBe(403);
      expect(h.forwarded).toHaveLength(0);
    }
  });
});
