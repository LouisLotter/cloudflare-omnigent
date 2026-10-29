// `platform.internal`'s key service: the endpoint of core change 19's HTTP cipher, which
// encrypts the records of Omnigent's credential store (D22: GitHub linking only). Specified by
// the fork's `designs/CREDENTIAL_STORE.md`, "HTTP key service", and pinned byte for byte by its
// test vectors (`tests/fixtures/credential_key_service/protocol_v1.json`, copied into
// `test/fixtures/omnigent/`). Pure: no Workers runtime import; the entrypoint is
// `PlatformInternal` in `internal/entrypoints.ts`, which only the server container reaches.
//
// Custody. The record keys are 32-byte root keys in a Worker-only secret (`CFO_KEY_SERVICE_RECORD_KEYS`,
// never forwarded to a container). Each record is sealed with AES-256-GCM under a key derived by
// HKDF-SHA256 from the root key of its `(key_id, key_version)` and the record's identity (the
// context Omnigent sends), so a sealed record opens only under its own context, key ID and
// version. The server holds only the HMAC key that signs its requests (`SERVER_ENV_`, shared
// with the server as the launcher's key is); Omnigent's process never sees a record key.
//
// Every request is checked in the protocol's order before any effect:
//   0. `POST /key-service/v1/encrypt` or `/decrypt`, a body of at most MAX_KEY_SERVICE_BODY_BYTES,
//      read as bytes within MAX_KEY_SERVICE_BODY_MS (otherwise 404, 405, 413 or 400);
//   1. the three signature headers, a signing key ID this Worker holds (the current one or,
//      during a rotation, the previous one), and the HMAC over the exact bytes received, under
//      `omnigent-key-service-v1` and the path's operation, compared by `crypto.subtle.verify`,
//      which is constant-time (401 `unauthenticated`);
//   2. the timestamp within KEY_SERVICE_MAX_SKEW_S of this Worker's clock (401 `stale_request`).
//      The protocol has no nonce: a captured request replays only within that window, only to
//      its own operation, and only from the server container, the one caller that can reach it;
//   3. the body is UTF-8 JSON of the operation's shape (400 `invalid_request`).
// Then `encrypt` seals under the current record key (413 `too_large` past 32 KiB of UTF-8), and
// `decrypt` opens: 409 `key_unavailable` for a key ID or version this Worker does not hold, 422
// `unusable` for a record that does not open under it and this context. Without its keys the
// service refuses everything (503 `unavailable`): fail closed. Every reply is JSON with an exact
// Content-Length and `Cache-Control: no-store`, never a redirect. Logged by operation, status and
// refusal only: never a header, a body, a context, a key ID or a plaintext.

import {
  MIN_SIGNING_KEY_BYTES,
  SIGNATURE_HEADER,
  SIGNING_KEY_ID_HEADER,
  SigningKeyId,
  SigningTimestamp,
  sha256Hex,
  TIMESTAMP_HEADER,
} from "@cfo/contracts";
import { readBounded, type SigningKey, SLOW } from "./platform-api.ts";

/** Omnigent posts to `<base>/encrypt` and `<base>/decrypt`; the server's base is this path. */
export const KEY_SERVICE_BASE_PATH = "/key-service/v1";
export const KEY_SERVICE_PATH_PREFIX = `${KEY_SERVICE_BASE_PATH}/`;
/** The first line of every string to sign (the fork's `PROTOCOL`). */
export const KEY_SERVICE_PROTOCOL = "omnigent-key-service-v1";
/** The protocol's freshness window, in either direction. */
export const KEY_SERVICE_MAX_SKEW_S = 300;
/** The largest plaintext `encrypt` accepts, in UTF-8 bytes: the protocol's floor, exactly. */
export const KEY_SERVICE_MAX_PLAINTEXT_BYTES = 32 * 1024;
/**
 * The largest request body read. Omnigent escapes every non-ASCII character as `\uXXXX`, so a
 * plaintext at the limit can take six bytes per byte on the wire; a body larger than this is
 * refused before it is hashed.
 */
export const MAX_KEY_SERVICE_BODY_BYTES = 256 * 1024;
/** How long a body may take to arrive; a slow body cannot stretch the signature's window. */
export const MAX_KEY_SERVICE_BODY_MS = 10_000;
/** A record root key's length, and the derived AES-256 key's. */
export const RECORD_KEY_BYTES = 32;
/** The highest record key version the protocol allows. */
export const MAX_KEY_VERSION = 2 ** 31 - 1;
/** HKDF's `purpose` in every derivation, as the fork's suggested construction names it. */
export const RECORD_KEY_PURPOSE = "omnigent-credential-record";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type KeyServiceOperation = "encrypt" | "decrypt";

/**
 * The Worker secrets holding the key service's keys.
 * - The current signing pair is the server's own: `SERVER_ENV_` reaches the server container
 *   without the prefix, as Omnigent's `OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY` and `_ID`, so one
 *   secret serves both sides. The previous pair is the Worker's alone, kept only during a
 *   rotation.
 * - The record keys are the Worker's alone: no `SERVER_ENV_` prefix, so no container gets them.
 *   A JSON object: `{"keyId": "<id>", "current": <version>, "versions": {"<version>":
 *   "<32 bytes, unpadded base64url>", …}}`. Every version records still use stays in it.
 */
export const KEY_SERVICE_SECRETS = {
  currentId: "SERVER_ENV_OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY_ID",
  current: "SERVER_ENV_OMNIGENT_CREDENTIAL_HTTP_SIGNING_KEY",
  previousId: "CFO_KEY_SERVICE_SIGNING_KEY_PREVIOUS_ID",
  previous: "CFO_KEY_SERVICE_SIGNING_KEY_PREVIOUS",
  recordKeys: "CFO_KEY_SERVICE_RECORD_KEYS",
} as const;

/** The record keys: one key ID, its versions' root keys, and the version new records use. */
export interface RecordKeys {
  readonly keyId: string;
  readonly current: number;
  readonly versions: ReadonlyMap<number, Uint8Array>;
}

/** Everything the service needs: both signing keys and the record keys. */
export interface KeyServiceKeys {
  readonly signing: { readonly current: SigningKey; readonly previous: SigningKey | null };
  readonly records: RecordKeys;
}

export type KeyServiceErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "stale_request"
  | "key_unavailable"
  | "too_large"
  | "unusable"
  | "not_found"
  | "method_not_allowed"
  | "unavailable";

const STATUS: Readonly<Record<KeyServiceErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  stale_request: 401,
  not_found: 404,
  method_not_allowed: 405,
  key_unavailable: 409,
  too_large: 413,
  unusable: 422,
  unavailable: 503,
};

/** The protocol's messages carry no plaintext, ciphertext, context or key material. */
const MESSAGE: Readonly<Record<KeyServiceErrorCode, string>> = {
  invalid_request: "The request is malformed.",
  unauthenticated: "The request is not signed.",
  stale_request: "The request is too old or too far ahead.",
  not_found: "Not found.",
  method_not_allowed: "Use POST.",
  key_unavailable: "That record key is not held here.",
  too_large: "The plaintext is too large.",
  unusable: "The record does not open under this context.",
  unavailable: "The key service is not available.",
};

const encoder = new TextEncoder();

/** A reply: JSON, framed by an explicit Content-Length, never cached. */
export function keyServiceJson(body: unknown, status = 200): Response {
  const bytes = encoder.encode(JSON.stringify(body));
  return new Response(bytes, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes.byteLength),
      "cache-control": "no-store",
    },
  });
}

/** The protocol's error reply: `{"error": {"code", "message"}}`. */
export function keyServiceError(code: KeyServiceErrorCode): Response {
  return keyServiceJson({ error: { code, message: MESSAGE[code] } }, STATUS[code]);
}

// ── Encoding ────────────────────────────────────────────────────────────────────────────────

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** Unpadded base64url. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The bytes of unpadded base64url, or null when it is not that. */
export function fromBase64url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Whether a string is well-formed UTF-16: no lone surrogate, so its UTF-8 bytes are exact. */
function wellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

/** Orders strings by Unicode code point, as Python's `sort_keys` does (not by UTF-16 unit). */
function byCodePoint(a: string, b: string): number {
  const x = Array.from(a, (c) => c.codePointAt(0) ?? 0);
  const y = Array.from(b, (c) => c.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** A record's identity: an object of strings, as Omnigent sends it. */
export type RecordContext = Readonly<Record<string, string>>;

/**
 * HKDF's `info` for a record: compact JSON of its identity and key, keys sorted at every level,
 * non-ASCII written as UTF-8 (the fork's `derivation_info`). The context must be well formed.
 */
export function derivationInfo(context: RecordContext, keyId: string, keyVersion: number): string {
  const entries = Object.entries(context)
    .sort(([a], [b]) => byCodePoint(a, b))
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
  return `{"context":{${entries.join(",")}},"key_id":${JSON.stringify(keyId)},"key_version":${keyVersion},"purpose":${JSON.stringify(RECORD_KEY_PURPOSE)}}`;
}

/** The AES-256-GCM key for one record. */
async function recordKey(
  root: Uint8Array,
  context: RecordContext,
  keyId: string,
  keyVersion: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    root as Uint8Array<ArrayBuffer>,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(derivationInfo(context, keyId, keyVersion)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seals a plaintext: `base64url(iv || AES-256-GCM(plaintext) || tag)`. */
export async function sealRecord(input: {
  readonly root: Uint8Array;
  readonly context: RecordContext;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly plaintext: string;
  readonly iv: Uint8Array;
}): Promise<string> {
  const key = await recordKey(input.root, input.context, input.keyId, input.keyVersion);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: input.iv as Uint8Array<ArrayBuffer>, tagLength: TAG_BYTES * 8 },
      key,
      encoder.encode(input.plaintext),
    ),
  );
  const out = new Uint8Array(input.iv.byteLength + sealed.byteLength);
  out.set(input.iv, 0);
  out.set(sealed, input.iv.byteLength);
  return base64url(out);
}

/** Opens a sealed record: its plaintext, or null when it does not open under this context. */
export async function openRecord(input: {
  readonly root: Uint8Array;
  readonly context: RecordContext;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly ciphertext: string;
}): Promise<string | null> {
  const raw = fromBase64url(input.ciphertext);
  if (raw === null || raw.byteLength < IV_BYTES + TAG_BYTES) return null;
  const key = await recordKey(input.root, input.context, input.keyId, input.keyVersion);
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw.subarray(0, IV_BYTES) as Uint8Array<ArrayBuffer>,
        tagLength: TAG_BYTES * 8,
      },
      key,
      raw.subarray(IV_BYTES) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(opened);
  } catch {
    return null;
  }
}

// ── Keys ────────────────────────────────────────────────────────────────────────────────────

const VERSION_TEXT = /^[1-9][0-9]{0,9}$/;

function validVersion(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_KEY_VERSION
  );
}

/** The record keys from their secret's JSON, or null when it is malformed in any way. */
export function parseRecordKeys(text: unknown): RecordKeys | null {
  if (typeof text !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const { keyId, current, versions } = parsed as Record<string, unknown>;
  if (typeof keyId !== "string" || !SigningKeyId.safeParse(keyId).success) return null;
  if (!validVersion(current)) return null;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) return null;
  const held = new Map<number, Uint8Array>();
  for (const [name, value] of Object.entries(versions)) {
    if (!VERSION_TEXT.test(name)) return null;
    const version = Number(name);
    if (!validVersion(version)) return null;
    const root = typeof value === "string" ? fromBase64url(value) : null;
    if (root === null || root.byteLength !== RECORD_KEY_BYTES) return null;
    held.set(version, root);
  }
  if (!held.has(current)) return null;
  return { keyId, current, versions: held };
}

/** The record keys' secret for one new root key: what the installer stores (version 1). */
export function recordKeysSecret(keyId: string, root: Uint8Array): string {
  if (!SigningKeyId.safeParse(keyId).success) throw new Error("not a valid key ID");
  if (root.byteLength !== RECORD_KEY_BYTES) throw new Error("a record key is 32 bytes");
  return JSON.stringify({ keyId, current: 1, versions: { "1": base64url(root) } });
}

/** Python's whitespace (`str.isspace`), which `str.strip()` removes from both ends. */
const PYTHON_SPACE =
  "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PYTHON_STRIP = new RegExp(`^${PYTHON_SPACE}+|${PYTHON_SPACE}+$`, "g");

/**
 * A setting as Omnigent reads it: `os.environ.get(name, "").strip()` (http_cipher.py), so a
 * secret pasted with a trailing newline signs and verifies alike on both sides.
 */
export function pythonStrip(text: string): string {
  return text.replace(PYTHON_STRIP, "");
}

/**
 * The key service's keys from the Worker's secrets, or null when any of them is missing or
 * malformed (the service then refuses every call: fail closed). The signing pairs are trimmed
 * as Omnigent trims its own copy (Codex WP5.9 r1-2). Each signing secret must be at least
 * MIN_SIGNING_KEY_BYTES bytes; a previous key with the current key's ID is refused.
 */
export function keyServiceKeysFrom(vars: Readonly<Record<string, unknown>>): KeyServiceKeys | null {
  const key = (idName: string, secretName: string): SigningKey | null | undefined => {
    const rawId = vars[idName];
    const rawSecret = vars[secretName];
    if (rawId === undefined && rawSecret === undefined) return undefined;
    if (typeof rawId !== "string" || typeof rawSecret !== "string") return null;
    const id = pythonStrip(rawId);
    const secret = pythonStrip(rawSecret);
    if (!SigningKeyId.safeParse(id).success) return null;
    const bytes = encoder.encode(secret);
    if (bytes.byteLength < MIN_SIGNING_KEY_BYTES) return null;
    return { id, secret: bytes };
  };
  const current = key(KEY_SERVICE_SECRETS.currentId, KEY_SERVICE_SECRETS.current);
  const previous = key(KEY_SERVICE_SECRETS.previousId, KEY_SERVICE_SECRETS.previous);
  if (!current || previous === null) return null;
  if (previous && previous.id === current.id) return null;
  const records = parseRecordKeys(vars[KEY_SERVICE_SECRETS.recordKeys]);
  if (records === null) return null;
  return { signing: { current, previous: previous ?? null }, records };
}

// ── Signatures ──────────────────────────────────────────────────────────────────────────────

/** The canonical string a key-service request's signature covers. */
export function keyServiceStringToSign(input: {
  readonly operation: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly bodySha256: string;
}): string {
  return [
    KEY_SERVICE_PROTOCOL,
    input.operation,
    input.keyId,
    input.timestamp,
    input.bodySha256,
  ].join("\n");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function hmacKey(secret: Uint8Array, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * The reference signer: the three headers for one request, as Omnigent's `HttpSecretCipher`
 * sends them. For tests and harnesses; production requests come from Omnigent.
 */
export async function signKeyServiceRequest(input: {
  readonly key: Uint8Array;
  readonly keyId: string;
  readonly operation: string;
  readonly timestamp: number;
  readonly body: Uint8Array;
}): Promise<Record<string, string>> {
  const timestamp = String(input.timestamp);
  const message = keyServiceStringToSign({
    operation: input.operation,
    keyId: input.keyId,
    timestamp,
    bodySha256: await sha256Hex(input.body),
  });
  const signature = hex(
    await crypto.subtle.sign("HMAC", await hmacKey(input.key, "sign"), encoder.encode(message)),
  );
  return {
    [SIGNING_KEY_ID_HEADER]: input.keyId,
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signature,
  };
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────

/** What one request needs from the Worker. */
export interface KeyServiceDeps {
  /** Null: not configured, or a secret is malformed. */
  readonly keys: KeyServiceKeys | null;
  /** Unix seconds. */
  nowSeconds(): number;
  /** A fresh 96-bit IV for each encryption; tests may fix it. */
  randomIv?(): Uint8Array;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
}

type Refused = { readonly code: KeyServiceErrorCode; readonly refused: string };

function isContext(value: unknown): value is RecordContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, item]) => typeof item === "string" && wellFormed(key) && wellFormed(item),
  );
}

async function encrypt(
  request: Record<string, unknown>,
  context: RecordContext,
  records: RecordKeys,
  randomIv: () => Uint8Array,
): Promise<Response | Refused> {
  const plaintext = request.plaintext;
  // A lone surrogate would reach the cipher as U+FFFD: the record would not hold what was sent.
  if (typeof plaintext !== "string" || !wellFormed(plaintext)) {
    return { code: "invalid_request", refused: "shape" };
  }
  if (encoder.encode(plaintext).byteLength > KEY_SERVICE_MAX_PLAINTEXT_BYTES) {
    return { code: "too_large", refused: "too_large" };
  }
  const root = records.versions.get(records.current) as Uint8Array;
  const ciphertext = await sealRecord({
    root,
    context,
    keyId: records.keyId,
    keyVersion: records.current,
    plaintext,
    iv: randomIv(),
  });
  return keyServiceJson({ key_id: records.keyId, key_version: records.current, ciphertext });
}

async function decrypt(
  request: Record<string, unknown>,
  context: RecordContext,
  records: RecordKeys,
): Promise<Response | Refused> {
  const { key_id: keyId, key_version: keyVersion, ciphertext } = request;
  if (typeof keyId !== "string" || !validVersion(keyVersion) || typeof ciphertext !== "string") {
    return { code: "invalid_request", refused: "shape" };
  }
  const root = keyId === records.keyId ? records.versions.get(keyVersion) : undefined;
  if (root === undefined) return { code: "key_unavailable", refused: "key_unavailable" };
  const plaintext = await openRecord({ root, context, keyId, keyVersion, ciphertext });
  if (plaintext === null) return { code: "unusable", refused: "unusable" };
  return keyServiceJson({ plaintext });
}

async function signatureValid(key: SigningKey, message: string, signature: string) {
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(key.secret, "verify"),
    hexToBytes(signature) as Uint8Array<ArrayBuffer>,
    encoder.encode(message),
  );
}

async function answer(
  request: Request,
  deps: KeyServiceDeps,
  bodyDeadlineMs: number,
): Promise<{ readonly operation: string; readonly outcome: Response | Refused }> {
  const url = new URL(request.url);
  const operation = url.pathname.startsWith(KEY_SERVICE_PATH_PREFIX)
    ? url.pathname.slice(KEY_SERVICE_PATH_PREFIX.length)
    : "";
  if (operation !== "encrypt" && operation !== "decrypt") {
    return { operation: "", outcome: { code: "not_found", refused: "path" } };
  }
  const refuse = (code: KeyServiceErrorCode, refused: string) => ({
    operation,
    outcome: { code, refused },
  });
  if (request.method !== "POST") return refuse("method_not_allowed", "method");
  if (deps.keys === null) return refuse("unavailable", "no_keys");
  const { signing, records } = deps.keys;

  // 1. Headers, signing key and signature, before the body is parsed.
  const keyId = request.headers.get(SIGNING_KEY_ID_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  if (keyId === null || timestamp === null || signature === null) {
    return refuse("unauthenticated", "unsigned");
  }
  const key =
    keyId === signing.current.id
      ? signing.current
      : signing.previous !== null && keyId === signing.previous.id
        ? signing.previous
        : null;
  if (key === null) return refuse("unauthenticated", "unknown_key");
  if (!SigningTimestamp.safeParse(timestamp).success || !/^[0-9a-f]{64}$/.test(signature)) {
    return refuse("unauthenticated", "malformed_signature");
  }
  const body = await readBounded(request, MAX_KEY_SERVICE_BODY_BYTES, bodyDeadlineMs);
  if (body === null) return refuse("too_large", "body_too_large");
  if (body === SLOW) return refuse("invalid_request", "slow_body");
  const message = keyServiceStringToSign({
    operation,
    keyId,
    timestamp,
    bodySha256: await sha256Hex(body),
  });
  if (!(await signatureValid(key, message, signature))) {
    return refuse("unauthenticated", "bad_signature");
  }
  // 2. The timestamp, against the clock now, after the body has arrived.
  if (Math.abs(deps.nowSeconds() - Number(timestamp)) > KEY_SERVICE_MAX_SKEW_S) {
    return refuse("stale_request", "stale_timestamp");
  }
  // 3. The body: a UTF-8 JSON object with a context of strings.
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return refuse("invalid_request", "not_json");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return refuse("invalid_request", "shape");
  }
  const parsed = json as Record<string, unknown>;
  if (!isContext(parsed.context)) return refuse("invalid_request", "shape");
  const randomIv = deps.randomIv ?? (() => crypto.getRandomValues(new Uint8Array(IV_BYTES)));
  const outcome =
    operation === "encrypt"
      ? await encrypt(parsed, parsed.context, records, randomIv)
      : await decrypt(parsed, parsed.context, records);
  return { operation, outcome };
}

/** Handles one request to the key service. Never throws. */
export async function handleKeyServiceRequest(
  request: Request,
  deps: KeyServiceDeps,
  bodyDeadlineMs = MAX_KEY_SERVICE_BODY_MS,
): Promise<Response> {
  let operation = "";
  let outcome: Response | Refused;
  try {
    ({ operation, outcome } = await answer(request, deps, bodyDeadlineMs));
  } catch {
    outcome = { code: "invalid_request", refused: "unreadable" };
  }
  if (outcome instanceof Response) {
    deps.log("call", { operation, status: outcome.status });
    return outcome;
  }
  const response = keyServiceError(outcome.code);
  deps.log("refused", {
    ...(operation === "" ? {} : { operation }),
    status: response.status,
    refused: outcome.refused,
  });
  return response;
}
