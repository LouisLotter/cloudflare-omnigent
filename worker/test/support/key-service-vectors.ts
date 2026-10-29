// The fork's test vectors for core change 19's HTTP key service, vendored byte for byte from
// `tests/fixtures/credential_key_service/protocol_v1.json` at the pinned fork commit
// (`cfo/integration` 3d7f7d08c; the file last changed in c8a8a48ce). Its SHA-256 is pinned below:
// refresh the copy, and this constant, only from the fork.

import type { KeyServiceKeys } from "../../src/internal/key-service.ts";
import { fromBase64url } from "../../src/internal/key-service.ts";
import vectors from "../fixtures/omnigent/key_service_protocol_v1.json";

export const VECTORS_SHA256 = "97c0a816859145198710c99c353e82d0f0ffb87e7d876c2efb5b9a5d5e8cb671";

export interface EndpointCase {
  readonly name: string;
  readonly operation: string;
  readonly now: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly expect: {
    readonly status: number;
    readonly code?: string;
    readonly body?: Readonly<Record<string, unknown>>;
  };
}

export interface Exchange {
  readonly operation: string;
  readonly request: {
    readonly path: string;
    readonly body: string;
    readonly string_to_sign: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly response: { readonly status: number; readonly body: Readonly<Record<string, unknown>> };
  readonly stored_record?: string;
}

export interface Seal {
  readonly context: Readonly<Record<string, string>>;
  readonly key_id: string;
  readonly key_version: number;
  readonly plaintext: string;
  readonly hkdf_info: string;
  readonly iv_base64url: string;
  readonly ciphertext: string;
}

export const V = vectors as unknown as {
  readonly protocol: string;
  readonly signing_key: { readonly key_id: string; readonly key_utf8: string };
  readonly record_key: {
    readonly key_id: string;
    readonly key_version: number;
    readonly key_base64url: string;
  };
  readonly timestamp: number;
  readonly freshness_window_seconds: number;
  readonly exchanges: readonly Exchange[];
  readonly seals: readonly Seal[];
  readonly endpoint_cases: readonly EndpointCase[];
};

/** The record root key the vectors use. */
export function vectorRoot(): Uint8Array {
  const root = fromBase64url(V.record_key.key_base64url);
  if (root === null) throw new Error("the vectors' record key is not base64url");
  return root;
}

/** The keys the vectors' endpoint holds: one signing key, one record key version. */
export function vectorKeys(): KeyServiceKeys {
  return {
    signing: {
      current: {
        id: V.signing_key.key_id,
        secret: new TextEncoder().encode(V.signing_key.key_utf8),
      },
      previous: null,
    },
    records: {
      keyId: V.record_key.key_id,
      current: V.record_key.key_version,
      versions: new Map([[V.record_key.key_version, vectorRoot()]]),
    },
  };
}

/** A request to the key service as Omnigent sends one: exact body bytes and headers. */
export function vectorRequest(
  operation: string,
  headers: Readonly<Record<string, string>>,
  body: string,
): Request {
  return new Request(`http://platform.internal/key-service/v1/${operation}`, {
    method: "POST",
    headers,
    body: new TextEncoder().encode(body),
  });
}
