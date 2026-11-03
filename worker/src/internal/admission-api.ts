// `platform.internal/access/v1/admission` (WP8.3): the server image's admission adapter tells the
// platform who Cloudflare Access should admit. Pure: no Workers runtime import; the entrypoint
// is `PlatformInternal` in `internal/entrypoints.ts`, which only the server container reaches.
//
// Checked in this order before any effect:
//   0. `POST` on exactly ADMISSION_PATH, a body of at most MAX_ADMISSION_BODY_BYTES;
//   1. the launcher's three signature headers and key (the server holds it), with the HMAC over
//      the admission call's own string to sign (`admissionStringToSign`), so no launcher
//      signature is valid here (401);
//   2. the timestamp within LAUNCHER_SIGNATURE_MAX_SKEW_S (401);
//   3. the body parses as an `AccessAdmissionCall` (400).
// Then OmnigentServer applies it (access-admission.ts): 200 for `applied` and `stale`, 409 for
// `refused`, 503 when Access did not answer or did not keep the list, so the adapter retries.
// Logged by outcome and status only: never a header, an address or the token.

import {
  type AccessAdmissionCall,
  AccessAdmissionCall as AccessAdmissionCallSchema,
  type AccessAdmissionResult,
  ADMISSION_PATH,
  admissionStringToSign,
  LAUNCHER_SIGNATURE_MAX_SKEW_S,
  SIGNATURE_HEADER,
  SIGNING_KEY_ID_HEADER,
  SigningTimestamp,
  sha256Hex,
  TIMESTAMP_HEADER,
} from "@cfo/contracts";
import {
  launcherError,
  launcherJson,
  readBounded,
  type SigningKey,
  type SigningKeys,
  SLOW,
} from "./platform-api.ts";

/** A thousand addresses of up to 320 characters, quoted and separated, with room to spare. */
export const MAX_ADMISSION_BODY_BYTES = 400_000;

export interface AdmissionApiDeps {
  readonly keys: SigningKeys | null;
  nowSeconds(): number;
  admit(call: AccessAdmissionCall): Promise<AccessAdmissionResult>;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
}

export function isAdmissionPath(pathname: string): boolean {
  return pathname === ADMISSION_PATH;
}

async function verify(key: SigningKey, message: string, signatureHex: string): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.secret as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    signature[i] = Number.parseInt(signatureHex.slice(2 * i, 2 * i + 2), 16);
  }
  return crypto.subtle.verify("HMAC", cryptoKey, signature, new TextEncoder().encode(message));
}

export async function handleAdmissionRequest(
  request: Request,
  deps: AdmissionApiDeps,
): Promise<Response> {
  const refuse = (status: number, refused: string, response: Response): Response => {
    deps.log("refused", { status, refused });
    return response;
  };
  if (new URL(request.url).pathname !== ADMISSION_PATH) {
    return refuse(404, "path", launcherError("not_found", "Not found."));
  }
  if (request.method !== "POST") {
    return refuse(400, "method", launcherError("bad_request", "Use POST."));
  }
  const { keys } = deps;
  if (keys === null) {
    return refuse(503, "no_keys", launcherError("unavailable", "Admission is not configured."));
  }
  const keyId = request.headers.get(SIGNING_KEY_ID_HEADER);
  const timestamp = request.headers.get(TIMESTAMP_HEADER);
  const signature = request.headers.get(SIGNATURE_HEADER);
  const key =
    keyId === keys.current.id
      ? keys.current
      : keys.previous !== null && keyId === keys.previous.id
        ? keys.previous
        : null;
  if (
    key === null ||
    timestamp === null ||
    signature === null ||
    !SigningTimestamp.safeParse(timestamp).success ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) {
    return refuse(401, "unsigned", launcherError("unauthorized", "Not signed."));
  }
  const body = await readBounded(request, MAX_ADMISSION_BODY_BYTES, 10_000);
  if (body === null || body === SLOW) {
    return refuse(400, "body", launcherError("bad_request", "The request body is unusable."));
  }
  const message = admissionStringToSign({
    keyId: key.id,
    timestamp,
    bodySha256: await sha256Hex(body),
  });
  if (!(await verify(key, message, signature))) {
    return refuse(401, "bad_signature", launcherError("unauthorized", "Not signed."));
  }
  if (Math.abs(deps.nowSeconds() - Number(timestamp)) > LAUNCHER_SIGNATURE_MAX_SKEW_S) {
    return refuse(401, "stale_timestamp", launcherError("unauthorized", "Not signed."));
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return refuse(400, "not_json", launcherError("bad_request", "The body is not JSON."));
  }
  const parsed = AccessAdmissionCallSchema.safeParse(json);
  if (!parsed.success) {
    return refuse(400, "schema", launcherError("bad_request", "Not an admission call."));
  }
  let result: AccessAdmissionResult;
  try {
    result = await deps.admit(parsed.data);
  } catch {
    return refuse(
      503,
      "unconfirmed",
      launcherError("unavailable", "Access did not confirm the member list. Try again."),
    );
  }
  const status = result.outcome === "refused" ? 409 : 200;
  deps.log("answered", { status, outcome: result.outcome });
  return launcherJson(result, status);
}
