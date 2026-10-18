// Every request shape found that could change the sharing settings, plus near misses that must
// not be refused. Each variant runs against the server directly (the control: does it reach the
// write handler?) and through both Worker entry points (does the guard stop it?).

import { gzipSync } from "node:zlib";
import type { RawRequest } from "./lib.ts";

/** What the guard must do with the variant. */
export type Expect = "refuse" | "rewrite" | "forward";

export interface Variant {
  readonly id: string;
  readonly group: "path" | "method" | "override" | "body" | "get" | "near-miss" | "base-path";
  readonly description: string;
  readonly expect: Expect;
  /** Builds the request for one entry point; `auth` is the entry's credential header. */
  readonly build: (auth: readonly [string, string], port: number) => RawRequest;
  /** Only meaningful when the server and the Worker run with this base path. */
  readonly basePath?: string;
}

const JSON_CT = ["Content-Type", "application/json"] as const;
/** Moves public sharing away from the managed value (off). */
const BODY = '{"public_sharing": true}';

function put(
  id: string,
  group: Variant["group"],
  description: string,
  target: string,
  expect: Expect = "refuse",
  extra: Partial<RawRequest> = {},
): Variant {
  return {
    id,
    group,
    description,
    expect,
    build: (auth) => ({
      line: `PUT ${target} HTTP/1.1`,
      headers: [auth, JSON_CT, ...(extra.headers ?? [])],
      body: BODY,
      ...(extra.chunked ? { chunked: true } : {}),
    }),
  };
}

function body(
  id: string,
  description: string,
  payload: Buffer | string | undefined,
  headers: ReadonlyArray<readonly [string, string]> = [JSON_CT],
  chunked = false,
): Variant {
  return {
    id,
    group: "body",
    description,
    expect: "refuse",
    build: (auth) => ({
      line: "PUT /v1/sharing HTTP/1.1",
      headers: [auth, ...headers],
      ...(payload === undefined ? {} : { body: payload }),
      ...(chunked ? { chunked: true } : {}),
    }),
  };
}

function method(
  id: string,
  group: Variant["group"],
  description: string,
  verb: string,
  target = "/v1/sharing",
  headers: ReadonlyArray<readonly [string, string]> = [],
  withBody = true,
): Variant {
  return {
    id,
    group,
    description,
    expect: "refuse",
    build: (auth) => ({
      line: `${verb} ${target} HTTP/1.1`,
      headers: [auth, JSON_CT, ...headers],
      ...(withBody ? { body: BODY } : {}),
    }),
  };
}

function get(
  id: string,
  group: Variant["group"],
  description: string,
  target: string,
  expect: Expect,
  options: {
    verb?: string;
    headers?: ReadonlyArray<readonly [string, string]>;
    anonymous?: boolean;
  } = {},
): Variant {
  return {
    id,
    group,
    description,
    expect,
    build: (auth) => ({
      line: `${options.verb ?? "GET"} ${target} HTTP/1.1`,
      headers: [...(options.anonymous ? [] : [auth]), ...(options.headers ?? [])],
    }),
  };
}

export const VARIANTS: readonly Variant[] = [
  // Path spellings, all PUT with a body that turns public sharing on.
  put("P01", "path", "canonical path", "/v1/sharing"),
  put("P02", "path", "trailing slash", "/v1/sharing/"),
  put("P03", "path", "two trailing slashes", "/v1/sharing//"),
  put("P04", "path", "leading double slash", "//v1/sharing"),
  put("P05", "path", "inner double slash", "/v1//sharing"),
  put("P06", "path", "slashes everywhere", "///v1///sharing///"),
  put("P07", "path", "upper case", "/V1/SHARING"),
  put("P08", "path", "mixed case", "/v1/Sharing"),
  put("P09", "path", "one encoded letter", "/v1/%73haring"),
  put("P10", "path", "fully encoded segment", "/v1/%73%68%61%72%69%6e%67"),
  put("P11", "path", "encoded upper case", "/v1/%53HARING"),
  put("P12", "path", "encoded slash", "/v1%2Fsharing"),
  put("P13", "path", "encoded slash, lower-case hex", "/v1%2fsharing"),
  put("P14", "path", "every slash encoded after the first", "/%2Fv1%2Fsharing"),
  put("P15", "path", "double-encoded letter", "/v1/%2573haring"),
  put("P16", "path", "double-encoded slash", "/v1%252Fsharing"),
  put("P17", "path", "dot segment", "/v1/./sharing"),
  put("P18", "path", "dot-dot segment", "/v1/x/../sharing"),
  put("P19", "path", "leading dot segment", "/./v1/sharing"),
  put("P20", "path", "encoded dot segment", "/v1/%2e/sharing"),
  put("P21", "path", "encoded dot-dot segment", "/v1/x/%2e%2e/sharing"),
  put("P22", "path", "dot-dot with encoded slash", "/v1/x/..%2Fsharing"),
  put("P23", "path", "encoded slash dot-dot encoded slash", "/v1/x%2F..%2Fsharing"),
  put("P24", "path", "query string", "/v1/sharing?x=1"),
  put("P25", "path", "matrix parameter", "/v1/sharing;x=1"),
  put("P26", "path", "encoded semicolon", "/v1/sharing%3Bx=1"),
  put("P27", "path", "encoded NUL", "/v1/sharing%00"),
  put("P28", "path", "encoded trailing space", "/v1/sharing%20"),
  put("P29", "path", "encoded trailing slash", "/v1/sharing%2F"),
  put("P30", "path", "encoded backslash", "/v1%5Csharing"),
  put("P31", "path", "raw backslash", "/v1\\sharing"),
  put("P32", "path", "fragment in request line", "/v1/sharing#x"),
  {
    id: "P33",
    group: "path",
    description: "absolute-form request target",
    expect: "refuse",
    build: (auth, port) => ({
      line: `PUT http://127.0.0.1:${port}/v1/sharing HTTP/1.1`,
      headers: [auth, JSON_CT],
      body: BODY,
    }),
  },
  {
    id: "P34",
    group: "path",
    description: "absolute-form target naming the private host",
    expect: "refuse",
    build: (auth) => ({
      line: "PUT http://omnigent.internal/v1/sharing HTTP/1.1",
      headers: [auth, JSON_CT],
      body: BODY,
    }),
  },
  put("P35", "path", "trailing dot", "/v1/sharing."),
  {
    id: "P36",
    group: "path",
    description: "HTTP/1.0 request",
    expect: "refuse",
    build: (auth) => ({
      line: "PUT /v1/sharing HTTP/1.0",
      headers: [auth, JSON_CT],
      body: BODY,
    }),
  },

  // Other methods on the canonical path.
  method("M01", "method", "POST", "POST"),
  method("M02", "method", "PATCH", "PATCH"),
  method("M03", "method", "DELETE", "DELETE"),
  method("M04", "method", "OPTIONS", "OPTIONS", "/v1/sharing", [], false),
  method("M05", "method", "lower-case put", "put"),
  method("M06", "method", "mixed-case Put", "Put"),
  method("M07", "method", "WebDAV PROPPATCH", "PROPPATCH"),
  method("M08", "method", "unknown method", "FOO"),
  method("M09", "method", "TRACE", "TRACE", "/v1/sharing", [], false),

  // Method override headers and parameters. Omnigent honors none of them; the guard refuses them
  // anyway, so that a future middleware cannot turn a GET into a write.
  method("O01", "override", "GET with X-HTTP-Method-Override: PUT", "GET", "/v1/sharing", [
    ["X-HTTP-Method-Override", "PUT"],
  ]),
  method("O02", "override", "GET with X-HTTP-Method: PUT", "GET", "/v1/sharing", [
    ["X-HTTP-Method", "PUT"],
  ]),
  method("O03", "override", "GET with X-Method-Override: PUT", "GET", "/v1/sharing", [
    ["X-Method-Override", "PUT"],
  ]),
  method("O04", "override", "POST with X-HTTP-Method-Override: PUT", "POST", "/v1/sharing", [
    ["X-HTTP-Method-Override", "PUT"],
  ]),
  method("O05", "override", "GET with ?_method=PUT", "GET", "/v1/sharing?_method=PUT"),
  method(
    "O06",
    "override",
    "WebSocket upgrade",
    "GET",
    "/v1/sharing",
    [
      ["Upgrade", "websocket"],
      ["Connection", "Upgrade"],
      ["Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="],
      ["Sec-WebSocket-Version", "13"],
    ],
    false,
  ),

  // Body shapes on the canonical PUT. The guard never reads the body; these show that each one
  // would have been a write, including Pydantic's lax booleans.
  body("D01", "JSON boolean true", '{"public_sharing": true}'),
  body("D02", 'lax boolean "true"', '{"public_sharing": "true"}'),
  body("D03", 'lax boolean "yes"', '{"public_sharing": "yes"}'),
  body("D04", 'lax boolean "on"', '{"public_sharing": "on"}'),
  body("D05", "lax boolean 1", '{"public_sharing": 1}'),
  body("D06", 'lax boolean "1"', '{"public_sharing": "1"}'),
  body("D07", 'lax boolean "t"', '{"public_sharing": "t"}'),
  body("D08", 'lax boolean "YES"', '{"public_sharing": "YES"}'),
  body("D09", "mode in upper case", '{"sharing_mode": "ON"}'),
  body("D10", "mode with spaces", '{"sharing_mode": " on "}'),
  body("D11", "default public sessions", '{"default_public_sessions": "all"}'),
  body("D12", "public permission ceiling", '{"public_sharing_max_level": "edit"}'),
  body("D13", "duplicate key, last wins", '{"public_sharing": false, "public_sharing": true}'),
  body("D14", "escaped key", '{"public\\u005fsharing": true}'),
  body("D15", "unknown extra field", '{"public_sharing": true, "unknown": 1}'),
  body("D16", "no Content-Type", BODY, []),
  body("D17", "text/plain Content-Type", BODY, [["Content-Type", "text/plain"]]),
  body("D18", "form-encoded body", "public_sharing=true", [
    ["Content-Type", "application/x-www-form-urlencoded"],
  ]),
  body("D19", "chunked transfer encoding", BODY, [JSON_CT], true),
  body("D20", "gzip Content-Encoding", gzipSync(Buffer.from(BODY)), [
    JSON_CT,
    ["Content-Encoding", "gzip"],
  ]),
  body("D21", "no body", undefined),
  body("D22", "empty object", "{}"),
  body("D23", "UTF-8 byte order mark", `﻿${BODY}`),
  body(
    "D24",
    "the managed value itself (a no-op that still writes a file)",
    '{"public_sharing": false}',
  ),
  body("D25", "+json media type", BODY, [["Content-Type", "application/merge-patch+json"]]),

  // Reads: forwarded and rewritten as managed, or passed through.
  get("G01", "get", "GET, rewritten as managed", "/v1/sharing", "rewrite"),
  get("G02", "get", "HEAD, headers only", "/v1/sharing", "rewrite", { verb: "HEAD" }),
  get("G03", "get", "GET with encoded letter", "/v1/%73haring", "rewrite"),
  get("G04", "get", "GET with gzip accepted", "/v1/sharing", "rewrite", {
    headers: [["Accept-Encoding", "gzip"]],
  }),
  get("G05", "get", "GET without credentials (401 passes through)", "/v1/sharing", "rewrite", {
    anonymous: true,
  }),
  get("G06", "get", "GET /v1/info (not a managed path)", "/v1/info", "forward"),

  // Near misses: not the managed path. They must pass the guard and still never write.
  put("N01", "near-miss", "longer last segment", "/v1/sharingx", "forward"),
  put("N02", "near-miss", "suffixed last segment", "/v1/sharing-x", "forward"),
  put("N03", "near-miss", "unknown prefix (no base path configured)", "/x/v1/sharing", "forward"),
  put("N04", "near-miss", "full-width letter", "/v1/%EF%BD%93haring", "forward"),
  put("N05", "near-miss", "sub-resource of a session", "/v1/sessions/abc/sharing", "forward"),
];

/** Run only when the server and the Worker are started with base path /omni. */
export const BASE_PATH_VARIANTS: readonly Variant[] = [
  { ...put("B01", "base-path", "base path prefix", "/omni/v1/sharing"), basePath: "/omni" },
  { ...put("B02", "base-path", "base path, encoded", "/omni/v1/%73haring"), basePath: "/omni" },
  {
    ...put("B03", "base-path", "canonical path without the prefix", "/v1/sharing"),
    basePath: "/omni",
  },
  {
    ...get("B04", "base-path", "GET under the base path, rewritten", "/omni/v1/sharing", "rewrite"),
    basePath: "/omni",
  },
  { ...put("B05", "base-path", "upper-case base path", "/OMNI/v1/sharing"), basePath: "/omni" },
];
