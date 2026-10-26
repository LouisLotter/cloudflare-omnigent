// `platform.internal`: the launcher API, called only by the server's Cloudflare launcher (WP3.6)
// through the server container's intercept, never reachable from a computer or the public
// route. Pure: no Workers runtime import; the entrypoint is `PlatformInternal` in
// `internal/entrypoints.ts`.
//
// Every request is checked in the contract's order before any effect (FH-28; contracts
// `launcher.ts`):
//   0. `POST /launcher/<operation>`, a body of at most MAX_LAUNCHER_BODY_BYTES, read as bytes;
//   1. the three signature headers, a key ID this Worker holds (the current key or, during a
//      rotation, the previous one), and the HMAC over the exact bytes received, compared by
//      `crypto.subtle.verify`, which is constant-time (401 `unauthorized`);
//   2. the timestamp within LAUNCHER_SIGNATURE_MAX_SKEW_S of this Worker's clock (401);
//   3. the body is UTF-8 JSON that parses as a `LauncherRequest` whose `operation` is the path's
//      (400 `bad_request`);
//   4. its protocol version is supported (400 `unsupported_version`).
// Then `prepare` is answered here, `provision` goes to ControlDO (`register_computer`) and then
// to the computer's WorkspaceDO, and every other operation to the computer's WorkspaceDO, which
// keeps each operation's outcome by its operation ID. Failures carry the contract's error codes
// and statuses. A call that may have reached WorkspaceDO but got no answer is reported as
// `unavailable`, retryable: the launcher repeats it with the same operation ID, and the
// recorded outcome comes back (LAUNCHER_OPERATIONS). Logged by operation, path and status only:
// never a header, a body or a token.

import {
  CONTROL_INTERFACE_VERSION,
  type ControlCall,
  type ControlResult,
  ErrorBody,
  type ErrorCode,
  LAUNCHER_ERROR_CLASS,
  LAUNCHER_ERROR_STATUS,
  LAUNCHER_SIGNATURE_MAX_SKEW_S,
  type LauncherCall,
  LauncherRequest,
  LauncherResult,
  launcherStringToSign,
  MAX_LAUNCHER_BODY_BYTES,
  MIN_SIGNING_KEY_BYTES,
  SIGNATURE_HEADER,
  SIGNING_KEY_ID_HEADER,
  SigningKeyId,
  SigningTimestamp,
  SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS,
  sha256Hex,
  TIMESTAMP_HEADER,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import { errorCodeOf } from "../shared/errors.ts";

/** Every launcher operation is `POST <this>/<operation>`. */
export const LAUNCHER_PATH_PREFIX = "/launcher/";

/** One signing key: its ID and the UTF-8 bytes of its secret. */
export interface SigningKey {
  readonly id: string;
  readonly secret: Uint8Array;
}

/** The keys a Worker holds: the current one and, during a rotation, the previous one. */
export interface SigningKeys {
  readonly current: SigningKey;
  readonly previous: SigningKey | null;
}

/**
 * The Worker secrets holding the launcher's keys. The current key is the server's own
 * (`SERVER_ENV_` reaches the server container without the prefix, where the Cloudflare launcher
 * signs with `CFO_LAUNCHER_SIGNING_KEY`, WP3.6), so one secret serves both sides. The previous
 * key is the Worker's alone, kept only during a rotation.
 */
export const LAUNCHER_KEY_SECRETS = {
  currentId: "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID",
  current: "SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY",
  previousId: "CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID",
  previous: "CFO_LAUNCHER_SIGNING_KEY_PREVIOUS",
} as const;

/**
 * The launcher's keys from the Worker's secrets, or null when they are missing or malformed
 * (the API then refuses every call: fail closed). Each secret must be at least
 * MIN_SIGNING_KEY_BYTES bytes; a previous key with the current key's ID is refused.
 */
export function signingKeysFrom(vars: Readonly<Record<string, unknown>>): SigningKeys | null {
  const key = (idName: string, secretName: string): SigningKey | null | undefined => {
    const id = vars[idName];
    const secret = vars[secretName];
    if (id === undefined && secret === undefined) return undefined;
    if (typeof id !== "string" || typeof secret !== "string") return null;
    if (!SigningKeyId.safeParse(id).success) return null;
    const bytes = new TextEncoder().encode(secret);
    if (bytes.byteLength < MIN_SIGNING_KEY_BYTES) return null;
    return { id, secret: bytes };
  };
  const current = key(LAUNCHER_KEY_SECRETS.currentId, LAUNCHER_KEY_SECRETS.current);
  const previous = key(LAUNCHER_KEY_SECRETS.previousId, LAUNCHER_KEY_SECRETS.previous);
  if (!current || previous === null) return null;
  if (previous && previous.id === current.id) return null;
  return { current, previous: previous ?? null };
}

/** WorkspaceDO's launcher method, and ControlDO's entry point, as the API uses them. */
export interface LauncherDeps {
  readonly keys: SigningKeys | null;
  /** Unix seconds. */
  nowSeconds(): number;
  launcher(computerId: string, call: LauncherCall): Promise<LauncherResult>;
  control(call: ControlCall): Promise<ControlResult>;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function signatureValid(
  key: SigningKey,
  message: string,
  signatureHex: string,
): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    hexToBytes(signatureHex) as Uint8Array<ArrayBuffer>,
    new TextEncoder().encode(message),
  );
}

/** How long a body may take to arrive; a slow body cannot stretch the signature's window. */
export const MAX_LAUNCHER_BODY_MS = 10_000;

const SLOW = Symbol("slow");

/**
 * Reads at most `limit` bytes of a body within `deadlineMs`: null when it is larger, `SLOW` when
 * it takes longer.
 */
async function readBounded(
  request: Request,
  limit: number,
  deadlineMs: number,
): Promise<Uint8Array | null | typeof SLOW> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<typeof SLOW>((resolve) => {
    timer = setTimeout(() => resolve(SLOW), deadlineMs);
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);
      if (next === SLOW) {
        // Cancelled, never awaited: a cancel that does not settle cannot hold the answer (r2-2).
        reader.cancel().catch(() => undefined);
        return SLOW;
      }
      const { done, value } = next;
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * A launcher-API reply: JSON, framed by an explicit Content-Length. The Cloudflare launcher
 * (WP3.6) refuses a body that ends with the connection instead, so the length is always known.
 */
export function launcherJson(body: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}

/** The launcher's error reply: the contract's status, and whether a repeat may help. */
export function launcherError(code: ErrorCode, message: string): Response {
  return launcherJson(
    ErrorBody.parse({
      error: { code, message, retryable: LAUNCHER_ERROR_CLASS[code] === "unknown_outcome" },
    }),
    LAUNCHER_ERROR_STATUS[code],
  );
}

const base32 = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * A platform operation ID (`op_` + 26 Crockford base32) derived from a launcher operation ID, so
 * that a repeated launcher call repeats the same ControlDO call (whose journal binds the ID to the
 * request) and a different launcher call never collides with it.
 */
export async function platformOperationId(
  purpose: string,
  launcherOperationId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${purpose}\n${launcherOperationId}`),
    ),
  );
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += base32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length === 26) break;
  }
  return `op_${out}`;
}

type Checked =
  | { readonly ok: true; readonly request: LauncherRequest }
  | { readonly ok: false; readonly response: Response; readonly refused: string };

/** Steps 0–4: everything before any effect. */
export async function checkLauncherRequest(
  request: Request,
  keys: SigningKeys | null,
  nowSeconds: () => number,
  bodyDeadlineMs = MAX_LAUNCHER_BODY_MS,
): Promise<Checked> {
  const fail = (code: ErrorCode, message: string, refused: string): Checked => ({
    ok: false,
    response: launcherError(code, message),
    refused,
  });
  const url = new URL(request.url);
  if (!url.pathname.startsWith(LAUNCHER_PATH_PREFIX)) {
    return fail("not_found", "Not found.", "path");
  }
  const operation = url.pathname.slice(LAUNCHER_PATH_PREFIX.length);
  if (!/^[a-z_]{1,32}$/.test(operation)) return fail("not_found", "Not found.", "path");
  if (request.method !== "POST") return fail("bad_request", "Use POST.", "method");
  if (keys === null) return fail("unavailable", "The launcher API is not configured.", "no_keys");

  // 1. Headers, key and signature, before the body is parsed.
  const keyId = request.headers.get(SIGNING_KEY_ID_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (keyId === null || timestamp === null || signature === null) {
    return fail("unauthorized", "Not signed.", "unsigned");
  }
  const key =
    keyId === keys.current.id
      ? keys.current
      : keys.previous !== null && keyId === keys.previous.id
        ? keys.previous
        : null;
  if (
    key === null ||
    !SigningTimestamp.safeParse(timestamp).success ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return fail(
      "unauthorized",
      "Not signed.",
      key === null ? "unknown_key" : "malformed_signature",
    );
  }
  const body = await readBounded(request, MAX_LAUNCHER_BODY_BYTES, bodyDeadlineMs);
  if (body === null) return fail("bad_request", "The request is too large.", "too_large");
  if (body === SLOW) return fail("bad_request", "The request body was too slow.", "slow_body");
  const message = launcherStringToSign({
    operation,
    keyId,
    timestamp,
    bodySha256: await sha256Hex(body),
  });
  if (!(await signatureValid(key, message, signature))) {
    return fail("unauthorized", "Not signed.", "bad_signature");
  }
  // 2. The timestamp, against the clock now, after the body has arrived (Codex WP3.3 r1-6).
  if (Math.abs(nowSeconds() - Number(timestamp)) > LAUNCHER_SIGNATURE_MAX_SKEW_S) {
    return fail("unauthorized", "Not signed.", "stale_timestamp");
  }
  // 3. The body: UTF-8 JSON, a LauncherRequest for the path's operation.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return fail("bad_request", "The body is not JSON.", "not_json");
  }
  const operationInBody = (json as { readonly operation?: unknown } | null)?.operation;
  if (operationInBody !== operation) {
    return fail("bad_request", "The operation does not match the path.", "operation_mismatch");
  }
  const parsed = LauncherRequest.safeParse(json);
  if (!parsed.success) return fail("bad_request", "Not a launcher request.", "schema");
  // 4. The protocol version.
  if (
    !(SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS as readonly number[]).includes(
      parsed.data.protocolVersion,
    )
  ) {
    return fail(
      "unsupported_version",
      "This launcher protocol version is not supported.",
      "version",
    );
  }
  return { ok: true, request: parsed.data };
}

function codeOf(error: unknown): ErrorCode | undefined {
  return errorCodeOf(error);
}

/** Runs one checked request. Throws nothing: every failure is a launcher error reply. */
async function dispatch(request: LauncherRequest, deps: LauncherDeps): Promise<Response> {
  if (request.operation === "prepare") {
    return launcherJson(
      LauncherResult.parse({
        operation: "prepare",
        supportedProtocolVersions: [...SUPPORTED_LAUNCHER_PROTOCOL_VERSIONS],
      }),
    );
  }
  let computerId: string;
  if (request.operation === "provision") {
    let registered: ControlResult;
    try {
      registered = await deps.control({
        method: "register_computer",
        interfaceVersion: CONTROL_INTERFACE_VERSION,
        operationId: await platformOperationId("provision", request.operationId),
        name: request.name,
      });
    } catch (error) {
      return failure(error, "provision");
    }
    if (registered.method !== "register_computer") {
      return launcherError("internal", "Unexpected answer.");
    }
    computerId = registered.computerId;
  } else {
    computerId = request.computerId;
  }
  let result: LauncherResult;
  try {
    result = await deps.launcher(computerId, {
      interfaceVersion: WORKSPACE_INTERFACE_VERSION,
      request,
    });
  } catch (error) {
    return failure(error, request.operation);
  }
  const checked = LauncherResult.safeParse(result);
  if (!checked.success || checked.data.operation !== request.operation) {
    return launcherError("internal", "Unexpected answer.");
  }
  if (checked.data.operation === "provision" && checked.data.computerId !== computerId) {
    return launcherError("internal", "Unexpected answer.");
  }
  return launcherJson(checked.data);
}

function failure(error: unknown, _operation: string): Response {
  const code = codeOf(error);
  if (code !== undefined) {
    return launcherError(
      code,
      code === "at_capacity" ? "All computers are busy." : `Refused: ${code}.`,
    );
  }
  // No answer from the controller: the call may or may not have taken effect. The launcher
  // repeats it with the same operation ID, which returns the recorded outcome.
  return launcherError("unavailable", "The computer's controller did not answer.");
}

/** Handles one request to the launcher API. Never throws. */
export async function handleLauncherRequest(
  request: Request,
  deps: LauncherDeps,
): Promise<Response> {
  const path = new URL(request.url).pathname.slice(0, 64);
  let checked: Checked;
  try {
    checked = await checkLauncherRequest(request, deps.keys, () => deps.nowSeconds());
  } catch {
    checked = {
      ok: false,
      response: launcherError("bad_request", "Unreadable request."),
      refused: "unreadable",
    };
  }
  if (!checked.ok) {
    deps.log("refused", { path, status: checked.response.status, refused: checked.refused });
    return checked.response;
  }
  const response = await dispatch(checked.request, deps);
  deps.log("call", {
    operation: checked.request.operation,
    path,
    status: response.status,
  });
  return response;
}
