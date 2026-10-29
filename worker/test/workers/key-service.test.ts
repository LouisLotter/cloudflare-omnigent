// The credential store's key service inside workerd (WP5.9): the fork's vectors through the real
// handler with workerd's WebCrypto, and the real `PlatformInternal` entrypoint with the Worker's
// own secrets (wrangler.test.jsonc): only the server's registration reaches it, unsigned and
// stale calls are refused, and a record sealed through it opens only under its own context.
// A computer cannot reach `platform.internal` at all: its intercepts never include the host
// (`computer/network.ts`; test/unit/computer-network.test.ts and internal-routes.test.ts).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  fromBase64url,
  handleKeyServiceRequest,
  KEY_SERVICE_SECRETS,
  keyServiceKeysFrom,
  signKeyServiceRequest,
} from "../../src/internal/key-service.ts";
import { entry } from "../support/assembled.ts";
import { V, vectorKeys, vectorRequest } from "../support/key-service-vectors.ts";

const encoder = new TextEncoder();
const SIGNING_KEY = "cfo-canary-key-service-signing-0000000000";
const SIGNING_KEY_ID = "ks-test-current";
const SERVER = { propsVersion: 1, caller: "omnigent-server" };
const CONTEXT = { provider: "github", user_id: "owner-canary", workspace_id: "0" };
const PLAINTEXT = '{"access_token": "cfo-canary-ghu-1111", "refresh_token": "cfo-canary-ghr-1111"}';

/** The key service as a container reaches it: `platform.internal`, with these props. */
const reach = (props: unknown) => entry.PlatformInternal({ props });
/** As the server container reaches it, with the props OmnigentServer registers. */
const keyService = () => reach(SERVER);

async function signed(
  operation: string,
  body: unknown,
  options: { at?: number; key?: string } = {},
): Promise<Request> {
  const bytes = encoder.encode(JSON.stringify(body));
  const headers = await signKeyServiceRequest({
    key: encoder.encode(options.key ?? SIGNING_KEY),
    keyId: SIGNING_KEY_ID,
    operation,
    timestamp: options.at ?? Math.floor(Date.now() / 1000),
    body: bytes,
  });
  return new Request(`http://platform.internal/key-service/v1/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: bytes,
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("the fork's vectors under the Workers runtime", () => {
  it("reproduces both exchanges and answers all endpoint cases as specified", async () => {
    const iv = fromBase64url(V.seals[0]?.iv_base64url ?? "") as Uint8Array;
    for (const exchange of V.exchanges) {
      const response = await handleKeyServiceRequest(
        vectorRequest(exchange.operation, exchange.request.headers, exchange.request.body),
        { keys: vectorKeys(), nowSeconds: () => V.timestamp, randomIv: () => iv, log: () => {} },
      );
      expect(response.status).toBe(exchange.response.status);
      expect(await response.json()).toEqual(exchange.response.body);
    }
    for (const c of V.endpoint_cases) {
      const response = await handleKeyServiceRequest(
        vectorRequest(c.operation, c.headers, c.body),
        { keys: vectorKeys(), nowSeconds: () => c.now, log: () => {} },
      );
      expect(response.status, c.name).toBe(c.expect.status);
      const body = (await response.json()) as Record<string, unknown>;
      if (c.expect.code !== undefined) {
        expect((body.error as { code: string }).code, c.name).toBe(c.expect.code);
      }
      if (c.expect.body !== undefined) expect(body, c.name).toEqual(c.expect.body);
    }
  });
});

describe("platform.internal/key-service/v1 through the real entrypoint and the Worker's secrets", () => {
  it("holds its keys in the Worker: the signing pair the server gets, and record keys it does not", () => {
    const keys = keyServiceKeysFrom(env as unknown as Record<string, unknown>);
    expect(keys?.signing.current.id).toBe(SIGNING_KEY_ID);
    expect(keys?.records.keyId).toBe("ins_01hs3f9q2m8z4w7k6t5r1n0ybc.records");
    expect(KEY_SERVICE_SECRETS.recordKeys.startsWith("SERVER_ENV_")).toBe(false);
  });

  it("seals and opens a record for the server, bound to its context", async () => {
    const sealed = await keyService().fetch(
      await signed("encrypt", { context: CONTEXT, plaintext: PLAINTEXT }),
    );
    expect(sealed.status).toBe(200);
    const record = (await sealed.json()) as {
      key_id: string;
      key_version: number;
      ciphertext: string;
    };
    expect(record.key_id).toBe("ins_01hs3f9q2m8z4w7k6t5r1n0ybc.records");
    expect(record.ciphertext).not.toContain("cfo-canary");
    const opened = await keyService().fetch(
      await signed("decrypt", { context: CONTEXT, ...record }),
    );
    expect(await opened.json()).toEqual({ plaintext: PLAINTEXT });
    const moved = await keyService().fetch(
      await signed("decrypt", { context: { ...CONTEXT, user_id: "someone-else" }, ...record }),
    );
    expect(moved.status).toBe(422);
    expect(await errorCode(moved)).toBe("unusable");
  });

  it("refuses unsigned, wrongly signed and stale calls, and a replay to the other operation", async () => {
    const unsigned = await keyService().fetch("http://platform.internal/key-service/v1/encrypt", {
      method: "POST",
      body: JSON.stringify({ context: CONTEXT, plaintext: PLAINTEXT }),
    });
    expect(unsigned.status).toBe(401);
    expect(await errorCode(unsigned)).toBe("unauthenticated");
    const forged = await keyService().fetch(
      await signed("encrypt", { context: CONTEXT, plaintext: "x" }, { key: `${SIGNING_KEY}-x` }),
    );
    expect(await errorCode(forged)).toBe("unauthenticated");
    const stale = await keyService().fetch(
      await signed(
        "encrypt",
        { context: CONTEXT, plaintext: "x" },
        { at: Math.floor(Date.now() / 1000) - 301 },
      ),
    );
    expect(stale.status).toBe(401);
    expect(await errorCode(stale)).toBe("stale_request");
    const encrypt = await signed("encrypt", { context: CONTEXT, plaintext: "x" });
    const replayed = await keyService().fetch("http://platform.internal/key-service/v1/decrypt", {
      method: "POST",
      headers: encrypt.headers,
      body: await encrypt.arrayBuffer(),
    });
    expect(await errorCode(replayed)).toBe("unauthenticated");
  });

  it("refuses every caller that is not the server's registration", async () => {
    for (const props of [
      undefined,
      { propsVersion: 1, caller: "computer" },
      { propsVersion: 2, caller: "omnigent-server" },
      { computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3", generation: 1 },
    ]) {
      const response = await reach(props).fetch(
        await signed("encrypt", { context: CONTEXT, plaintext: PLAINTEXT }),
      );
      expect(response.status, `props ${JSON.stringify(props)}`).toBe(503);
      expect(await errorCode(response)).toBe("unavailable");
    }
  });

  it("leaves the launcher API where it was", async () => {
    const response = await keyService().fetch("http://platform.internal/launcher/prepare", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });
});
