// The managed-settings guard: pure functions, no Workers APIs.
//
// Omnigent's sharing endpoint writes override files that take effect at once and outlive the
// request (routes/sharing.py). In this deployment the settings are managed by the installation,
// so the shared forwarding path refuses every write to that endpoint and marks reads of it as
// not editable.
//
// Matching follows two rules learned from the S7 control runs:
//   1. Decide on the path that will be forwarded, decoded the way the server decodes it. Uvicorn
//      percent-decodes the whole path once, including %2F, before Starlette routes it, so
//      `/v1%2Fsharing` and `/v1/%73haring` reach the write handler. The Worker's own URL parser
//      also resolves dot segments, %2e segments and backslashes, so paths that are harmless at
//      the server become the canonical path once a Worker forwards them.
//   2. Over-match rather than under-match. The canonical form also decodes repeatedly, folds
//      case, collapses slashes and drops matrix parameters and trailing dots. None of those
//      spellings reach the handler today; refusing them costs nothing, because no other route
//      lives at those paths.

/** The write endpoint and everything under it. */
export const MANAGED_ROOT = "/v1/sharing";

export const MANAGED_MESSAGE =
  "Sharing settings are managed by your installation settings and can't be changed here.";

/** Headers and query keys that some frameworks treat as the real method. Omnigent honors none. */
const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"];
const METHOD_OVERRIDE_QUERY = "_method";

const MAX_DECODE_ROUNDS = 8;
const HEX_PAIR = /^[0-9a-fA-F]{2}$/;

/**
 * Percent-decodes once, the way Python's `urllib.parse.unquote` does for uvicorn: valid escapes
 * become bytes, the bytes are read as UTF-8 with replacement, and invalid escapes stay literal.
 */
export function percentDecode(input: string): string {
  if (!input.includes("%")) return input;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < input.length; ) {
    const pair = input.slice(i + 1, i + 3);
    if (input[i] === "%" && HEX_PAIR.test(pair)) {
      bytes.push(Number.parseInt(pair, 16));
      i += 3;
      continue;
    }
    const codePoint = input.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(codePoint);
    for (const b of encoder.encode(char)) bytes.push(b);
    i += char.length;
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(new Uint8Array(bytes));
}

/**
 * A deliberately aggressive canonical form of a request path, used only for matching. It is
 * never forwarded: the server receives the path exactly as the Worker parsed it.
 */
export function canonicalPath(pathname: string): string {
  let path = pathname;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    const next = percentDecode(path);
    if (next === path) break;
    path = next;
  }
  // Backslash is a separator to WHATWG URL parsers and to some proxies.
  path = path.replaceAll("\\", "/");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
  path = path.replace(/[\u0000-\u001f\u007f]/g, "");
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    const segment = (raw.split(";")[0] ?? "").trim();
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    const trimmed = segment.replace(/[.\s]+$/u, "");
    if (trimmed === "") continue;
    segments.push(trimmed.toLowerCase());
  }
  return `/${segments.join("/")}`;
}

/** Normalizes a configured base path the way Omnigent does: "" or "/prefix" without a slash. */
export function normalizeBasePath(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return "";
  return canonicalPath(trimmed.startsWith("/") ? trimmed : `/${trimmed}`);
}

/** True when the path is the managed endpoint, or under it, with or without the base path. */
export function isManagedPath(pathname: string, basePath = ""): boolean {
  const path = canonicalPath(pathname);
  const roots = basePath ? [MANAGED_ROOT, `${basePath}${MANAGED_ROOT}`] : [MANAGED_ROOT];
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

export type Decision =
  | { readonly action: "pass" }
  | { readonly action: "read" }
  | { readonly action: "refuse"; readonly reason: string };

export interface RequestView {
  readonly method: string;
  readonly url: string;
  readonly headers: { has(name: string): boolean; get(name: string): string | null };
}

/**
 * What the forwarding path does with a request:
 *   - `pass`: not the managed endpoint; forward unchanged.
 *   - `read`: a plain GET or HEAD of the managed endpoint; forward, then mark as managed.
 *   - `refuse`: anything else on the managed endpoint. Decided from the method and path alone,
 *     never from the body, so Pydantic's lax parsing and body framing cannot matter.
 */
export function decide(request: RequestView, basePath = ""): Decision {
  const url = new URL(request.url);
  if (!isManagedPath(url.pathname, basePath)) return { action: "pass" };
  if (METHOD_OVERRIDE_HEADERS.some((name) => request.headers.has(name))) {
    return { action: "refuse", reason: "method-override-header" };
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase() === METHOD_OVERRIDE_QUERY) {
      return { action: "refuse", reason: "method-override-query" };
    }
  }
  if (request.headers.has("upgrade")) return { action: "refuse", reason: "upgrade" };
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return { action: "read" };
  return { action: "refuse", reason: "write-method" };
}

/**
 * Marks a `GET /v1/sharing` payload as managed: every `editable` and `*_editable` flag becomes
 * false, which is what Omnigent's settings page reads to disable its controls. Throws on
 * anything that is not a JSON object, so the caller can fail closed.
 */
export function markManaged(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("sharing payload is not a JSON object");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = key === "editable" || key.endsWith("_editable") ? false : value;
  }
  out.managed = true;
  out.managed_message = MANAGED_MESSAGE;
  return out;
}

/** The refusal body, in Omnigent's error envelope so its interface shows the message. */
export function refusalBody(): string {
  return JSON.stringify({ error: { code: "forbidden", message: MANAGED_MESSAGE } });
}
