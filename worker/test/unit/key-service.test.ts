// The key service's pure module (`internal/key-service.ts`) in Node: the fork's vectors byte for
// byte, every refusal in the protocol's order, record-key rotation, encoding edges and its logs.
// The same vectors run inside workerd through the real entrypoint in
// `test/workers/key-service.test.ts`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  base64url,
  derivationInfo,
  fromBase64url,
  handleKeyServiceRequest,
  KEY_SERVICE_MAX_PLAINTEXT_BYTES,
  KEY_SERVICE_PROTOCOL,
  KEY_SERVICE_SECRETS,
  type KeyServiceDeps,
  type KeyServiceKeys,
  keyServiceKeysFrom,
  keyServiceStringToSign,
  MAX_KEY_SERVICE_BODY_BYTES,
  openRecord,
  parseRecordKeys,
  recordKeysSecret,
  sealRecord,
  signKeyServiceRequest,
} from "../../src/internal/key-service.ts";
import {
  V,
  VECTORS_SHA256,
  vectorKeys,
  vectorRequest,
  vectorRoot,
} from "../support/key-service-vectors.ts";

const encoder = new TextEncoder();
const here = dirname(fileURLToPath(import.meta.url));
const NOW = V.timestamp;
const CONTEXT = { provider: "github", user_id: "owner-canary", workspace_id: "0" };
const PLAINTEXT = '{"access_token": "cfo-canary-ghu-0000", "refresh_token": "cfo-canary-ghr-0000"}';

interface Logged {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function deps(
  keys: KeyServiceKeys | null = vectorKeys(),
  now = NOW,
  iv?: Uint8Array,
): KeyServiceDeps & { readonly logs: Logged[] } {
  const logs: Logged[] = [];
  return {
    keys,
    nowSeconds: () => now,
    ...(iv === undefined ? {} : { randomIv: () => iv }),
    log: (event, fields) => logs.push({ event, fields }),
    logs,
  };
}

/** A request signed now with the vectors' key (or another), as Omnigent signs one. */
async function signed(
  operation: string,
  body: unknown,
  options: { key?: string; keyId?: string; at?: number; path?: string } = {},
): Promise<Request> {
  const bytes = encoder.encode(typeof body === "string" ? body : JSON.stringify(body));
  const headers = await signKeyServiceRequest({
    key: encoder.encode(options.key ?? V.signing_key.key_utf8),
    keyId: options.keyId ?? V.signing_key.key_id,
    operation,
    timestamp: options.at ?? NOW,
    body: bytes,
  });
  return new Request(`http://platform.internal/key-service/v1/${options.path ?? operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bytes,
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function code(response: Response): Promise<string | undefined> {
  return ((await json(response)).error as { code?: string } | undefined)?.code;
}

async function sealed(plaintext = PLAINTEXT, context: Record<string, string> = CONTEXT) {
  const response = await handleKeyServiceRequest(
    await signed("encrypt", { context, plaintext }),
    deps(),
  );
  expect(response.status).toBe(200);
  return (await json(response)) as { key_id: string; key_version: number; ciphertext: string };
}

describe("the fork's test vectors (protocol_v1.json), byte for byte", () => {
  it("is the fork's file, unchanged", () => {
    const file = readFileSync(
      join(here, "..", "fixtures", "omnigent", "key_service_protocol_v1.json"),
    );
    expect(createHash("sha256").update(file).digest("hex")).toBe(VECTORS_SHA256);
    expect(V.protocol).toBe(KEY_SERVICE_PROTOCOL);
    expect(V.freshness_window_seconds).toBe(300);
  });

  it("signs each exchange's exact bytes with the same string and signature", async () => {
    for (const exchange of V.exchanges) {
      const body = encoder.encode(exchange.request.body);
      const digest = createHash("sha256").update(body).digest("hex");
      expect(
        keyServiceStringToSign({
          operation: exchange.operation,
          keyId: V.signing_key.key_id,
          timestamp: String(V.timestamp),
          bodySha256: digest,
        }),
      ).toBe(exchange.request.string_to_sign);
      const headers = await signKeyServiceRequest({
        key: encoder.encode(V.signing_key.key_utf8),
        keyId: V.signing_key.key_id,
        operation: exchange.operation,
        timestamp: V.timestamp,
        body,
      });
      for (const [name, value] of Object.entries(headers)) {
        expect(exchange.request.headers[name]).toBe(value);
      }
    }
  });

  it("derives each seal's key from the same HKDF info and reproduces its ciphertext", async () => {
    for (const seal of V.seals) {
      expect(derivationInfo(seal.context, seal.key_id, seal.key_version)).toBe(seal.hkdf_info);
      const iv = fromBase64url(seal.iv_base64url) as Uint8Array;
      const input = { root: vectorRoot(), context: seal.context, keyId: seal.key_id };
      expect(
        await sealRecord({ ...input, keyVersion: seal.key_version, plaintext: seal.plaintext, iv }),
      ).toBe(seal.ciphertext);
      expect(
        await openRecord({ ...input, keyVersion: seal.key_version, ciphertext: seal.ciphertext }),
      ).toBe(seal.plaintext);
    }
  });

  it("answers both exchanges exactly, the encrypt with the vectors' fixed IV", async () => {
    const iv = fromBase64url(V.seals[0]?.iv_base64url ?? "") as Uint8Array;
    for (const exchange of V.exchanges) {
      const response = await handleKeyServiceRequest(
        vectorRequest(exchange.operation, exchange.request.headers, exchange.request.body),
        deps(vectorKeys(), NOW, iv),
      );
      expect(response.status).toBe(exchange.response.status);
      expect(await response.json()).toEqual(exchange.response.body);
      if (exchange.stored_record !== undefined) {
        const reply = exchange.response.body as {
          key_id: string;
          key_version: number;
          ciphertext: string;
        };
        expect(`oshttp1:${reply.key_id}:${reply.key_version}:${reply.ciphertext}`).toBe(
          exchange.stored_record,
        );
      }
    }
  });

  it.each(V.endpoint_cases.map((c) => [c.name, c] as const))(
    "endpoint case: %s",
    async (_name, c) => {
      const response = await handleKeyServiceRequest(
        vectorRequest(c.operation, c.headers, c.body),
        deps(vectorKeys(), c.now),
      );
      expect(response.status).toBe(c.expect.status);
      const body = await json(response);
      if (c.expect.code !== undefined) {
        expect((body.error as { code: string }).code).toBe(c.expect.code);
      }
      if (c.expect.body !== undefined) expect(body).toEqual(c.expect.body);
    },
  );
});

describe("refusals, in the protocol's order", () => {
  it("refuses a bad signature, a stale clock, a wrong context and a replay to the other operation", async () => {
    const record = await sealed();
    const decrypt = { context: CONTEXT, ...record };
    // A bad signature: another key under the right ID.
    const forged = await signed("decrypt", decrypt, { key: "cfo-canary-not-the-key-000000000000" });
    expect(await code(await handleKeyServiceRequest(forged, deps()))).toBe("unauthenticated");
    // A stale clock, both ways, just past the window; at its edge it is accepted.
    for (const at of [NOW - 301, NOW + 301]) {
      const stale = await signed("decrypt", decrypt, { at });
      expect(await code(await handleKeyServiceRequest(stale, deps()))).toBe("stale_request");
    }
    for (const at of [NOW - 300, NOW + 300]) {
      const edge = await signed("decrypt", decrypt, { at });
      expect((await handleKeyServiceRequest(edge, deps())).status).toBe(200);
    }
    // Another record's context: the record does not open.
    const moved = await signed("decrypt", {
      ...decrypt,
      context: { ...CONTEXT, user_id: "other" },
    });
    expect(await code(await handleKeyServiceRequest(moved, deps()))).toBe("unusable");
    // An extra context field binds too.
    const widened = await signed("decrypt", {
      ...decrypt,
      context: { ...CONTEXT, account_id: "a" },
    });
    expect(await code(await handleKeyServiceRequest(widened, deps()))).toBe("unusable");
    // An encrypt request replayed to decrypt: its signature names the other operation.
    const encrypt = await signed("encrypt", { context: CONTEXT, plaintext: PLAINTEXT });
    const replayed = new Request("http://platform.internal/key-service/v1/decrypt", {
      method: "POST",
      headers: encrypt.headers,
      body: await encrypt.arrayBuffer(),
    });
    expect(await code(await handleKeyServiceRequest(replayed, deps()))).toBe("unauthenticated");
  });

  it("refuses a captured request replayed after the window, and never answers it", async () => {
    const record = await sealed();
    const captured = await signed("decrypt", { context: CONTEXT, ...record });
    const body = await captured.clone().arrayBuffer();
    const again = (now: number) =>
      handleKeyServiceRequest(
        new Request(captured.url, { method: "POST", headers: captured.headers, body }),
        deps(vectorKeys(), now),
      );
    expect((await again(NOW + 10)).status).toBe(200);
    const late = await again(NOW + 301);
    expect(late.status).toBe(401);
    expect(await json(late)).toEqual({
      error: { code: "stale_request", message: "The request is too old or too far ahead." },
    });
  });

  it("checks the signature before the clock, and both before the body", async () => {
    const forgedAndStale = await signed("decrypt", "not json", {
      key: "cfo-canary-not-the-key-000000000000",
      at: NOW - 1000,
    });
    expect(await code(await handleKeyServiceRequest(forgedAndStale, deps()))).toBe(
      "unauthenticated",
    );
    const staleNotJson = await signed("decrypt", "not json", { at: NOW - 1000 });
    expect(await code(await handleKeyServiceRequest(staleNotJson, deps()))).toBe("stale_request");
    const notJson = await signed("decrypt", "not json");
    expect(await code(await handleKeyServiceRequest(notJson, deps()))).toBe("invalid_request");
  });

  it("refuses unsigned, malformed and unknown-key headers as unauthenticated", async () => {
    const good = await signed("encrypt", { context: CONTEXT, plaintext: "x" });
    const variants: Record<string, string | null>[] = [
      { "x-omnigent-signing-key-id": null },
      { "x-omnigent-timestamp": null },
      { "x-omnigent-signature": null },
      { "x-omnigent-signing-key-id": "example-signing-9" },
      { "x-omnigent-timestamp": "01792584000" },
      { "x-omnigent-timestamp": "-1" },
      { "x-omnigent-signature": "ABC" },
      { "x-omnigent-signature": "0".repeat(64).toUpperCase().replace(/0/g, "A") },
    ];
    for (const change of variants) {
      const headers = new Headers(good.headers);
      for (const [name, value] of Object.entries(change)) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      const response = await handleKeyServiceRequest(
        new Request(good.url, { method: "POST", headers, body: await good.clone().arrayBuffer() }),
        deps(),
      );
      expect(response.status, JSON.stringify(change)).toBe(401);
      expect(await code(response)).toBe("unauthenticated");
    }
  });

  it("answers only POST to encrypt and decrypt", async () => {
    for (const path of ["", "seal", "encrypt/", "../launcher/prepare"]) {
      const response = await handleKeyServiceRequest(
        new Request(`http://platform.internal/key-service/v1/${path}`, { method: "POST" }),
        deps(),
      );
      expect(response.status, path).toBe(404);
    }
    const other = await handleKeyServiceRequest(
      new Request("http://platform.internal/launcher/encrypt", { method: "POST" }),
      deps(),
    );
    expect(other.status).toBe(404);
    const get = await handleKeyServiceRequest(
      new Request("http://platform.internal/key-service/v1/decrypt"),
      deps(),
    );
    expect(get.status).toBe(405);
  });

  it("refuses everything, signed or not, when its keys are missing (fail closed)", async () => {
    const response = await handleKeyServiceRequest(
      await signed("encrypt", { context: CONTEXT, plaintext: "x" }),
      deps(null),
    );
    expect(response.status).toBe(503);
    expect(await code(response)).toBe("unavailable");
  });

  it("refuses a body too large before hashing it, and one that arrives too slowly", async () => {
    const big = await signed("encrypt", "x".repeat(MAX_KEY_SERVICE_BODY_BYTES + 1));
    expect(await code(await handleKeyServiceRequest(big, deps()))).toBe("too_large");
    const headers = (await signed("encrypt", "{}")).headers;
    const never = new ReadableStream<Uint8Array>({ start: () => undefined });
    const slow = new Request("http://platform.internal/key-service/v1/encrypt", {
      method: "POST",
      headers,
      body: never,
      duplex: "half",
    } as RequestInit);
    const response = await handleKeyServiceRequest(slow, deps(), 20);
    expect(await code(response)).toBe("invalid_request");
  });

  it("answers an unreadable body with invalid_request, never by throwing", async () => {
    const headers = (await signed("encrypt", "{}")).headers;
    const broken = new Request("http://platform.internal/key-service/v1/encrypt", {
      method: "POST",
      headers,
      body: new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("reset")) }),
      duplex: "half",
    } as RequestInit);
    const response = await handleKeyServiceRequest(broken, deps());
    expect(response.status).toBe(400);
  });
});

describe("request shapes", () => {
  it("accepts a plaintext of exactly 32 KiB of UTF-8 and refuses one byte more", async () => {
    const limit = "é".repeat(KEY_SERVICE_MAX_PLAINTEXT_BYTES / 2);
    expect(
      (
        await handleKeyServiceRequest(
          await signed("encrypt", { context: CONTEXT, plaintext: limit }),
          deps(),
        )
      ).status,
    ).toBe(200);
    const over = await signed("encrypt", { context: CONTEXT, plaintext: `${limit}x` });
    const response = await handleKeyServiceRequest(over, deps());
    expect(response.status).toBe(413);
    expect(await code(response)).toBe("too_large");
  });

  it("refuses malformed bodies as invalid_request", async () => {
    const bodies: unknown[] = [
      "[1]",
      "null",
      '"text"',
      { plaintext: "x" },
      { context: "c", plaintext: "x" },
      { context: [], plaintext: "x" },
      { context: { a: 1 }, plaintext: "x" },
      { context: CONTEXT, plaintext: 1 },
      { context: CONTEXT },
      // Lone surrogates: the UTF-8 the cipher sees would not be what was sent.
      `{"context":{"provider":"github"},"plaintext":"a\\ud800b"}`,
      `{"context":{"provider":"\\udc00"},"plaintext":"x"}`,
      `{"context":{"\\ud800":"x"},"plaintext":"x"}`,
    ];
    for (const body of bodies) {
      const response = await handleKeyServiceRequest(await signed("encrypt", body), deps());
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const notUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const headers = await signKeyServiceRequest({
      key: encoder.encode(V.signing_key.key_utf8),
      keyId: V.signing_key.key_id,
      operation: "encrypt",
      timestamp: NOW,
      body: notUtf8,
    });
    const response = await handleKeyServiceRequest(
      new Request("http://platform.internal/key-service/v1/encrypt", {
        method: "POST",
        headers,
        body: notUtf8,
      }),
      deps(),
    );
    expect(await code(response)).toBe("invalid_request");
  });

  it("checks decrypt's fields: malformed is 400, a key not held 409, a bad record 422", async () => {
    const record = await sealed();
    const cases: [Record<string, unknown>, number, string][] = [
      [{ ...record, key_id: 1 }, 400, "invalid_request"],
      [{ ...record, key_version: true }, 400, "invalid_request"],
      [{ ...record, key_version: 1.5 }, 400, "invalid_request"],
      [{ ...record, key_version: 0 }, 400, "invalid_request"],
      [{ ...record, key_version: 2 ** 31 }, 400, "invalid_request"],
      [{ ...record, ciphertext: null }, 400, "invalid_request"],
      [{ ...record, key_id: "another-installation" }, 409, "key_unavailable"],
      [{ ...record, key_version: 2 }, 409, "key_unavailable"],
      [{ ...record, ciphertext: "not base64url!" }, 422, "unusable"],
      [{ ...record, ciphertext: "A" }, 422, "unusable"],
      [{ ...record, ciphertext: base64url(new Uint8Array(27)) }, 422, "unusable"],
      [{ ...record, ciphertext: `${record.ciphertext.slice(0, -2)}AA` }, 422, "unusable"],
    ];
    for (const [fields, status, expected] of cases) {
      const response = await handleKeyServiceRequest(
        await signed("decrypt", { context: CONTEXT, ...fields }),
        deps(),
      );
      expect(response.status, JSON.stringify(fields)).toBe(status);
      expect(await code(response)).toBe(expected);
    }
  });

  it("reads a record whose bytes are not UTF-8 as unusable", async () => {
    // Seal raw bytes the way the service does, but with an invalid UTF-8 plaintext.
    const iv = new Uint8Array(12).fill(7);
    const base = await crypto.subtle.importKey(
      "raw",
      vectorRoot() as Uint8Array<ArrayBuffer>,
      "HKDF",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(0),
        info: encoder.encode(derivationInfo(CONTEXT, V.record_key.key_id, 1)),
      },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array([0xc3, 0x28])),
    );
    const ciphertext = base64url(new Uint8Array([...iv, ...ct]));
    expect(
      await openRecord({
        root: vectorRoot(),
        context: CONTEXT,
        keyId: V.record_key.key_id,
        keyVersion: 1,
        ciphertext,
      }),
    ).toBeNull();
  });

  it("ignores fields the protocol does not name, as the reference endpoint does", async () => {
    const response = await handleKeyServiceRequest(
      await signed("encrypt", { context: CONTEXT, plaintext: "x", extra: true }),
      deps(),
    );
    expect(response.status).toBe(200);
  });
});

describe("replies and logs", () => {
  it("frames every reply as JSON with an exact length, no-store, and never a redirect", async () => {
    const record = await sealed();
    const requests = [
      await signed("encrypt", { context: CONTEXT, plaintext: PLAINTEXT }),
      await signed("decrypt", { context: CONTEXT, ...record }),
      await signed("decrypt", { context: { x: "y" }, ...record }),
      new Request("http://platform.internal/key-service/v1/decrypt", {
        method: "POST",
        body: "{}",
      }),
      new Request("http://platform.internal/key-service/v1/nothing", { method: "POST" }),
    ];
    for (const request of requests) {
      const response = await handleKeyServiceRequest(request, deps());
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.headers.get("content-length")).toBe(String(bytes.byteLength));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("location")).toBeNull();
      expect(response.status < 300 || response.status >= 400).toBe(true);
    }
  });

  it("logs operation, status and refusal only: no plaintext, ciphertext, context or key", async () => {
    const d = deps();
    const encrypt = await handleKeyServiceRequest(
      await signed("encrypt", { context: CONTEXT, plaintext: PLAINTEXT }),
      d,
    );
    const record = (await encrypt.json()) as { ciphertext: string };
    await handleKeyServiceRequest(
      await signed("decrypt", {
        context: CONTEXT,
        ...record,
        key_id: V.record_key.key_id,
        key_version: 1,
      }),
      d,
    );
    await handleKeyServiceRequest(
      await signed("decrypt", { context: CONTEXT, key_id: "x", key_version: 1, ciphertext: "AA" }),
      d,
    );
    await handleKeyServiceRequest(
      await signed("decrypt", "{}", { key: "cfo-canary-not-the-key-000000000000" }),
      d,
    );
    const text = JSON.stringify(d.logs);
    for (const secret of [
      "cfo-canary-ghu-0000",
      "owner-canary",
      record.ciphertext,
      V.signing_key.key_utf8,
      V.signing_key.key_id,
      V.record_key.key_id,
      V.record_key.key_base64url,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(d.logs.map((l) => l.event)).toEqual(["call", "call", "refused", "refused"]);
    expect(d.logs[0]?.fields).toEqual({ operation: "encrypt", status: 200 });
    expect(d.logs[2]?.fields).toEqual({
      operation: "decrypt",
      status: 409,
      refused: "key_unavailable",
    });
  });
});

describe("keys", () => {
  const ROOT_1 = base64url(new Uint8Array(32).fill(1));
  const ROOT_2 = base64url(new Uint8Array(32).fill(2));
  const SIGNING = "cfo-canary-key-service-signing-0000000000";
  const vars = (over: Record<string, unknown> = {}) => ({
    [KEY_SERVICE_SECRETS.currentId]: "ks-current",
    [KEY_SERVICE_SECRETS.current]: SIGNING,
    [KEY_SERVICE_SECRETS.recordKeys]: JSON.stringify({
      keyId: "ins-records",
      current: 1,
      versions: { "1": ROOT_1 },
    }),
    ...over,
  });

  it("reads the Worker's secrets, with the previous signing key only during a rotation", () => {
    const keys = keyServiceKeysFrom(vars());
    expect(keys?.signing.current.id).toBe("ks-current");
    expect(keys?.signing.previous).toBeNull();
    expect(keys?.records.keyId).toBe("ins-records");
    const rotating = keyServiceKeysFrom(
      vars({
        [KEY_SERVICE_SECRETS.previousId]: "ks-previous",
        [KEY_SERVICE_SECRETS.previous]: `${SIGNING}-old`,
      }),
    );
    expect(rotating?.signing.previous?.id).toBe("ks-previous");
  });

  it("fails closed on any missing or malformed secret", () => {
    const bad: Record<string, unknown>[] = [
      { [KEY_SERVICE_SECRETS.current]: undefined, [KEY_SERVICE_SECRETS.currentId]: undefined },
      { [KEY_SERVICE_SECRETS.current]: undefined },
      { [KEY_SERVICE_SECRETS.current]: "short" },
      { [KEY_SERVICE_SECRETS.currentId]: "bad id" },
      { [KEY_SERVICE_SECRETS.current]: 1 },
      {
        [KEY_SERVICE_SECRETS.previousId]: "ks-current",
        [KEY_SERVICE_SECRETS.previous]: `${SIGNING}x`,
      },
      { [KEY_SERVICE_SECRETS.previousId]: "ks-previous" },
      { [KEY_SERVICE_SECRETS.recordKeys]: undefined },
    ];
    for (const over of bad) expect(keyServiceKeysFrom(vars(over)), JSON.stringify(over)).toBeNull();
  });

  it("parses only well-formed record keys", () => {
    const ok = { keyId: "ins-records", current: 2, versions: { "1": ROOT_1, "2": ROOT_2 } };
    expect(parseRecordKeys(JSON.stringify(ok))?.versions.size).toBe(2);
    const bad: unknown[] = [
      undefined,
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...ok, keyId: "bad id" }),
      JSON.stringify({ ...ok, current: 0 }),
      JSON.stringify({ ...ok, current: "2" }),
      JSON.stringify({ ...ok, current: 3 }),
      JSON.stringify({ ...ok, versions: [] }),
      JSON.stringify({ ...ok, versions: null }),
      JSON.stringify({ ...ok, versions: { "01": ROOT_1, "2": ROOT_2 } }),
      JSON.stringify({ ...ok, versions: { "2147483648": ROOT_1, "2": ROOT_2 } }),
      JSON.stringify({ ...ok, versions: { "1": "short", "2": ROOT_2 } }),
      JSON.stringify({ ...ok, versions: { "1": 7, "2": ROOT_2 } }),
      JSON.stringify({ ...ok, versions: { "1": `${ROOT_1}!`, "2": ROOT_2 } }),
    ];
    for (const text of bad) expect(parseRecordKeys(text), String(text)).toBeNull();
  });

  it("writes a version-1 secret the parser reads back, and refuses a bad key ID or length", () => {
    const root = new Uint8Array(32).fill(9);
    const parsed = parseRecordKeys(
      recordKeysSecret("ins_01hs3f9q2m8z4w7k6t5r1n0ybc.records", root),
    );
    expect(parsed?.current).toBe(1);
    expect(parsed?.versions.get(1)).toEqual(root);
    expect(() => recordKeysSecret("bad id", root)).toThrow();
    expect(() => recordKeysSecret("ok", new Uint8Array(16))).toThrow();
  });

  it("keeps older records readable after a record-key rotation, and seals new ones under the current version", async () => {
    const v1 = keyServiceKeysFrom(vars()) as KeyServiceKeys;
    const old = await handleKeyServiceRequest(
      await signed(
        "encrypt",
        { context: CONTEXT, plaintext: PLAINTEXT },
        { key: SIGNING, keyId: "ks-current" },
      ),
      deps(v1),
    );
    const oldRecord = (await old.json()) as {
      key_id: string;
      key_version: number;
      ciphertext: string;
    };
    expect(oldRecord.key_version).toBe(1);
    const v2 = keyServiceKeysFrom(
      vars({
        [KEY_SERVICE_SECRETS.recordKeys]: JSON.stringify({
          keyId: "ins-records",
          current: 2,
          versions: { "1": ROOT_1, "2": ROOT_2 },
        }),
      }),
    ) as KeyServiceKeys;
    const read = await handleKeyServiceRequest(
      await signed(
        "decrypt",
        { context: CONTEXT, ...oldRecord },
        { key: SIGNING, keyId: "ks-current" },
      ),
      deps(v2),
    );
    expect(await read.json()).toEqual({ plaintext: PLAINTEXT });
    const fresh = await handleKeyServiceRequest(
      await signed(
        "encrypt",
        { context: CONTEXT, plaintext: PLAINTEXT },
        { key: SIGNING, keyId: "ks-current" },
      ),
      deps(v2),
    );
    expect(((await fresh.json()) as { key_version: number }).key_version).toBe(2);
    // A version relabelled on the record does not open: the version is bound.
    const relabelled = await handleKeyServiceRequest(
      await signed(
        "decrypt",
        { context: CONTEXT, ...oldRecord, key_version: 2 },
        { key: SIGNING, keyId: "ks-current" },
      ),
      deps(v2),
    );
    expect(await code(relabelled)).toBe("unusable");
    // Dropping a version still in use makes its records unavailable, never "not linked".
    const dropped = keyServiceKeysFrom(
      vars({
        [KEY_SERVICE_SECRETS.recordKeys]: JSON.stringify({
          keyId: "ins-records",
          current: 2,
          versions: { "2": ROOT_2 },
        }),
      }),
    ) as KeyServiceKeys;
    const gone = await handleKeyServiceRequest(
      await signed(
        "decrypt",
        { context: CONTEXT, ...oldRecord },
        { key: SIGNING, keyId: "ks-current" },
      ),
      deps(dropped),
    );
    expect(await code(gone)).toBe("key_unavailable");
  });

  it("accepts the previous signing key during a rotation", async () => {
    const keys = keyServiceKeysFrom(
      vars({
        [KEY_SERVICE_SECRETS.previousId]: "ks-previous",
        [KEY_SERVICE_SECRETS.previous]: `${SIGNING}-old`,
      }),
    ) as KeyServiceKeys;
    for (const [key, keyId] of [
      [SIGNING, "ks-current"],
      [`${SIGNING}-old`, "ks-previous"],
    ] as const) {
      const response = await handleKeyServiceRequest(
        await signed("encrypt", { context: CONTEXT, plaintext: "x" }, { key, keyId }),
        deps(keys),
      );
      expect(response.status, keyId).toBe(200);
    }
  });
});

describe("encoding (properties)", () => {
  it("round-trips base64url and refuses impossible lengths and other alphabets", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 96 }), (bytes) => {
        const text = base64url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(fromBase64url(text)).toEqual(bytes);
      }),
    );
    expect(fromBase64url("A")).toBeNull();
    expect(fromBase64url("AAAA=")).toBeNull();
    expect(fromBase64url("AA+A")).toBeNull();
  });

  it("orders context keys by code point, as Python's sort_keys does", () => {
    // UTF-16 order would put the astral character (a surrogate pair, 0xD83D…) first.
    const info = derivationInfo({ "\u{1F600}": "a", "｡": "b", z: "c" }, "k", 1);
    expect(info).toBe(
      '{"context":{"z":"c","｡":"b","\u{1F600}":"a"},"key_id":"k","key_version":1,"purpose":"omnigent-credential-record"}',
    );
    expect(derivationInfo({ q: 'a"\\\n\u0001' }, "k", 2)).toBe(
      '{"context":{"q":"a\\"\\\\\\n\\u0001"},"key_id":"k","key_version":2,"purpose":"omnigent-credential-record"}',
    );
  });

  it("opens every sealed record under its own context only", async () => {
    const text = fc.string({ unit: "grapheme", maxLength: 40 });
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ unit: "grapheme-ascii", minLength: 1, maxLength: 12 }), text, {
          maxKeys: 4,
        }),
        text,
        async (context, plaintext) => {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const input = { root: vectorRoot(), keyId: "k", keyVersion: 1 };
          const ciphertext = await sealRecord({ ...input, context, plaintext, iv });
          expect(await openRecord({ ...input, context, ciphertext })).toBe(plaintext);
          const other = { ...context, "\u0000moved": "x" };
          expect(await openRecord({ ...input, context: other, ciphertext })).toBeNull();
        },
      ),
      { numRuns: 40 },
    );
  });
});
