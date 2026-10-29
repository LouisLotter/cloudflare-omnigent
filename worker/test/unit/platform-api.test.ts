import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ComputerId,
  type LauncherCall,
  type LauncherResult,
  signLauncherRequest,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import {
  checkLauncherRequest,
  handleLauncherRequest,
  type LauncherDeps,
  platformOperationId,
  type SigningKeys,
  signingKeysFrom,
} from "../../src/internal/platform-api.ts";
import { platformError } from "../../src/shared/errors.ts";
import { FakeControl } from "../support/fake-control.ts";
import { FakeWorkspace } from "../support/fake-workspace.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts");
const vectors = JSON.parse(
  readFileSync(join(root, "vectors", "launcher-signing-v1.json"), "utf8"),
) as {
  key: string;
  cases: {
    operation: string;
    keyId: string;
    timestamp: number;
    body: string;
    headers: Record<string, string>;
  }[];
};

const encoder = new TextEncoder();
const CURRENT = "cfo-canary-launcher-key-current-0000000000";
const PREVIOUS = "cfo-canary-launcher-key-previous-000000000";
const NOW = 1_792_407_600;
const COMPUTER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n3" as ComputerId;
const OP = "5f0c6e2a9b4d4c1e8a7f3b2d1c0e9f8a";

const keys: SigningKeys = {
  current: { id: "k-current", secret: encoder.encode(CURRENT) },
  previous: { id: "k-previous", secret: encoder.encode(PREVIOUS) },
};

interface Harness {
  deps: LauncherDeps;
  workspaces: Map<string, FakeWorkspace>;
  control: FakeControl;
  logs: { event: string; fields: Readonly<Record<string, unknown>> }[];
  /** Makes WorkspaceDO's next calls fail with no answer (a reset), after or before applying. */
  lose: { count: number; after: boolean };
}

function harness(withKeys: SigningKeys | null = keys): Harness {
  const h: Harness = {
    workspaces: new Map(),
    control: new FakeControl(),
    logs: [],
    lose: { count: 0, after: false },
    deps: undefined as unknown as LauncherDeps,
  };
  const workspaceFor = (computerId: string) => {
    let fake = h.workspaces.get(computerId);
    if (!fake) {
      fake = new FakeWorkspace(computerId as ComputerId);
      h.workspaces.set(computerId, fake);
    }
    return fake;
  };
  h.deps = {
    keys: withKeys,
    nowSeconds: () => NOW,
    launcher: async (computerId: string, call: LauncherCall): Promise<LauncherResult> => {
      if (h.lose.count > 0 && !h.lose.after) {
        h.lose.count -= 1;
        throw new Error("Durable Object reset because its code was updated.");
      }
      const result = await workspaceFor(computerId).launcher(call);
      if (h.lose.count > 0 && h.lose.after) {
        h.lose.count -= 1;
        throw new Error("Network connection lost.");
      }
      return result;
    },
    control: (call) => h.control.control(call),
    log: (event, fields) => h.logs.push({ event, fields }),
  };
  return h;
}

async function signed(
  body: string | Uint8Array,
  options: {
    operation?: string;
    key?: string;
    keyId?: string;
    timestamp?: number;
    path?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Request> {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  const operation =
    options.operation ??
    (JSON.parse(new TextDecoder().decode(bytes)) as { operation: string }).operation;
  const headers = await signLauncherRequest({
    key: encoder.encode(options.key ?? CURRENT),
    keyId: options.keyId ?? "k-current",
    operation,
    timestamp: options.timestamp ?? NOW,
    body: bytes,
  });
  return new Request(`http://platform.internal${options.path ?? `/launcher/${operation}`}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...options.headers },
    body: bytes,
  });
}

const call = (fields: Record<string, unknown>) =>
  JSON.stringify({ protocolVersion: 1, operationId: OP, ...fields });

describe("signing keys from the Worker's secrets", () => {
  it("reads the current key and, during a rotation, the previous one", () => {
    const parsed = signingKeysFrom({
      SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k2",
      SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: CURRENT,
      CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID: "k1",
      CFO_LAUNCHER_SIGNING_KEY_PREVIOUS: PREVIOUS,
    });
    expect(parsed?.current.id).toBe("k2");
    expect(parsed?.previous?.id).toBe("k1");
    expect(
      signingKeysFrom({
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k2",
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: CURRENT,
      })?.previous,
    ).toBeNull();
  });

  it.each([
    ["nothing set", {}],
    [
      "a short key",
      { SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k", SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: "short" },
    ],
    [
      "a bad key ID",
      {
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k 1",
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: CURRENT,
      },
    ],
    ["only an ID", { SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k" }],
    [
      "a previous key with the same ID",
      {
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k",
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: CURRENT,
        CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID: "k",
        CFO_LAUNCHER_SIGNING_KEY_PREVIOUS: PREVIOUS,
      },
    ],
    [
      "a half-set previous key",
      {
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY_ID: "k",
        SERVER_ENV_CFO_LAUNCHER_SIGNING_KEY: CURRENT,
        CFO_LAUNCHER_SIGNING_KEY_PREVIOUS_ID: "j",
      },
    ],
  ])("fails closed with %s", (_name, vars) => {
    expect(signingKeysFrom(vars)).toBeNull();
  });
});

describe("the receiver's checks, in the contract's order (FH-28)", () => {
  it("accepts the contract's signing vectors (Python-computed signatures)", async () => {
    const vectorKeys: SigningKeys = {
      current: { id: vectors.cases[0]?.keyId ?? "", secret: encoder.encode(vectors.key) },
      previous: null,
    };
    for (const v of vectors.cases) {
      const request = new Request(`http://platform.internal/launcher/${v.operation}`, {
        method: "POST",
        headers: v.headers,
        body: v.body,
      });
      const checked = await checkLauncherRequest(
        request,
        { ...vectorKeys, current: { ...vectorKeys.current, id: v.keyId } },
        () => v.timestamp,
      );
      expect(checked.ok, v.operation).toBe(true);
    }
  });

  it("accepts every valid LauncherRequest fixture, signed", async () => {
    const dir = join(root, "fixtures", "LauncherRequest");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const body = readFileSync(join(dir, name), "utf8");
      const checked = await checkLauncherRequest(await signed(body), keys, () => NOW);
      expect(checked.ok, name).toBe(true);
    }
  });

  it("refuses every invalid LauncherRequest fixture with 400, after the signature", async () => {
    const dir = join(root, "fixtures", "LauncherRequest", "invalid");
    for (const name of readdirSync(dir)) {
      const body = readFileSync(join(dir, name), "utf8");
      const operation = (JSON.parse(body) as { operation: string }).operation;
      const h = harness();
      const response = await handleLauncherRequest(await signed(body, { operation }), h.deps);
      expect(response.status, name).toBe(400);
      expect(h.workspaces.size + h.control.calls.length, name).toBe(0);
    }
  });

  it("accepts the previous key during a rotation, and no other", async () => {
    const body = call({ operation: "status", computerId: COMPUTER });
    const old = await checkLauncherRequest(
      await signed(body, { key: PREVIOUS, keyId: "k-previous" }),
      keys,
      () => NOW,
    );
    expect(old.ok).toBe(true);
    const afterRotation = await checkLauncherRequest(
      await signed(body, { key: PREVIOUS, keyId: "k-previous" }),
      { current: keys.current, previous: null },
      () => NOW,
    );
    expect(afterRotation.ok).toBe(false);
    // The previous key under the current key's ID does not verify.
    const mixed = await checkLauncherRequest(
      await signed(body, { key: PREVIOUS, keyId: "k-current" }),
      keys,
      () => NOW,
    );
    expect(mixed.ok).toBe(false);
  });

  const statusBody = call({ operation: "status", computerId: COMPUTER });
  const cases: [string, () => Promise<Request>, number, string][] = [
    // A server-side request forgery controls a URL or body, never the key (FH-28).
    [
      "no signature (an SSRF)",
      async () =>
        new Request("http://platform.internal/launcher/status", {
          method: "POST",
          body: statusBody,
        }),
      401,
      "unsigned",
    ],
    ["an unknown key ID", () => signed(statusBody, { keyId: "k-other" }), 401, "unknown_key"],
    [
      "another key",
      () => signed(statusBody, { key: "cfo-canary-some-other-key-000000000000" }),
      401,
      "bad_signature",
    ],
    [
      "an uppercase signature",
      async () => {
        const r = await signed(statusBody);
        const headers = new Headers(r.headers);
        headers.set(
          "X-Omnigent-Signature",
          (headers.get("X-Omnigent-Signature") ?? "").toUpperCase(),
        );
        return new Request(r.url, { method: "POST", headers, body: statusBody });
      },
      401,
      "malformed_signature",
    ],
    [
      "a changed body",
      async () => {
        const r = await signed(statusBody);
        return new Request(r.url, { method: "POST", headers: r.headers, body: `${statusBody} ` });
      },
      401,
      "bad_signature",
    ],
    [
      "a signature for another operation",
      () => signed(statusBody, { operation: "status", path: "/launcher/admission" }),
      401,
      "bad_signature",
    ],
    [
      "a timestamp 301 s old",
      () => signed(statusBody, { timestamp: NOW - 301 }),
      401,
      "stale_timestamp",
    ],
    [
      "a timestamp 301 s ahead",
      () => signed(statusBody, { timestamp: NOW + 301 }),
      401,
      "stale_timestamp",
    ],
    [
      "a non-decimal timestamp",
      async () => {
        const r = await signed(statusBody);
        const headers = new Headers(r.headers);
        headers.set("X-Omnigent-Timestamp", "0x10");
        return new Request(r.url, { method: "POST", headers, body: statusBody });
      },
      401,
      "malformed_signature",
    ],
    [
      "a path and body naming different operations",
      () => signed(call({ operation: "status", computerId: COMPUTER }), { operation: "admission" }),
      400,
      "operation_mismatch",
    ],
    ["a body that is not JSON", () => signed("not json", { operation: "status" }), 400, "not_json"],
    [
      "a body that is not UTF-8",
      () => signed(new Uint8Array([0xff, 0xfe]), { operation: "status" }),
      400,
      "not_json",
    ],
    [
      "an unsupported protocol version",
      () =>
        signed(
          JSON.stringify({
            protocolVersion: 2,
            operationId: OP,
            operation: "status",
            computerId: COMPUTER,
          }),
        ),
      400,
      "version",
    ],
    [
      "a body over the limit",
      () => signed(`{"pad":"${"x".repeat(130 * 1024)}"}`, { operation: "status" }),
      400,
      "too_large",
    ],
    ["GET", async () => new Request("http://platform.internal/launcher/status"), 400, "method"],
    [
      "an unknown path",
      async () => new Request("http://platform.internal/admin", { method: "POST" }),
      404,
      "path",
    ],
    [
      "an operation with odd characters",
      async () => new Request("http://platform.internal/launcher/Status%20x", { method: "POST" }),
      404,
      "path",
    ],
  ];
  it.each(cases)("refuses %s before any effect", async (_name, make, status, refused) => {
    const h = harness();
    const response = await handleLauncherRequest(await make(), h.deps);
    expect(response.status).toBe(status);
    expect(h.workspaces.size).toBe(0);
    expect(h.control.calls).toHaveLength(0);
    const log = h.logs.at(-1);
    expect(log?.fields).toMatchObject({ status, refused });
    // Logged by path and status: no header or body.
    expect(JSON.stringify(h.logs)).not.toMatch(/X-Omnigent|signature":|operationId/);
  });

  it("refuses everything when no key is configured (fail closed)", async () => {
    const h = harness(null);
    const response = await handleLauncherRequest(await signed(statusBody), h.deps);
    expect(response.status).toBe(503);
    expect(h.workspaces.size).toBe(0);
  });
});

describe("dispatch", () => {
  it("answers prepare itself", async () => {
    const h = harness();
    const response = await handleLauncherRequest(
      await signed(call({ operation: "prepare" })),
      h.deps,
    );
    expect(await response.json()).toEqual({ operation: "prepare", supportedProtocolVersions: [1] });
    expect(h.workspaces.size).toBe(0);
  });

  it("provisions through ControlDO by name, then the computer's WorkspaceDO", async () => {
    const h = harness();
    const first = await handleLauncherRequest(
      await signed(call({ operation: "provision", name: "managed-0f1e2d3c" })),
      h.deps,
    );
    const result = (await first.json()) as { computerId: string };
    expect(first.status).toBe(200);
    expect(h.workspaces.has(result.computerId)).toBe(true);
    // The same name again, under another operation ID: the same computer.
    const again = await handleLauncherRequest(
      await signed(
        JSON.stringify({
          protocolVersion: 1,
          operationId: "a".repeat(32),
          operation: "provision",
          name: "managed-0f1e2d3c",
        }),
      ),
      h.deps,
    );
    expect(((await again.json()) as { computerId: string }).computerId).toBe(result.computerId);
    expect(h.control.calls.map((c) => c.method)).toEqual([
      "register_computer",
      "register_computer",
    ]);
  });

  it("derives a stable platform operation ID from the launcher's", async () => {
    const a = await platformOperationId("provision", OP);
    expect(a).toMatch(/^op_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(await platformOperationId("provision", OP)).toBe(a);
    expect(await platformOperationId("provision", "a".repeat(32))).not.toBe(a);
    expect(await platformOperationId("other", OP)).not.toBe(a);
  });

  it("passes on-computer operations to that computer's WorkspaceDO with the interface version", async () => {
    const h = harness();
    const response = await handleLauncherRequest(
      await signed(call({ operation: "resume", computerId: COMPUTER })),
      h.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operation: "resume", outcome: "starting" });
    expect(h.workspaces.get(COMPUTER)?.launcherCalls.map((c) => c.operation)).toEqual(["resume"]);
    // Logged with its computer, so the wake-time table can time each computer's wake (WP3.33).
    expect(h.logs.at(-1)).toEqual({
      event: "call",
      fields: { operation: "resume", path: "/launcher/resume", status: 200, computerId: COMPUTER },
    });
  });

  it("logs a call that names no computer without one", async () => {
    const h = harness();
    await handleLauncherRequest(await signed(call({ operation: "prepare" })), h.deps);
    expect(h.logs.at(-1)).toEqual({
      event: "call",
      fields: { operation: "prepare", path: "/launcher/prepare", status: 200 },
    });
  });

  it("maps refusals to the contract's statuses: gone 410, at_capacity 429, conflict 409", async () => {
    const h = harness();
    const fake = new FakeWorkspace(COMPUTER);
    h.workspaces.set(COMPUTER, fake);
    fake.inputs.add("at_capacity");
    const busy = await handleLauncherRequest(
      await signed(call({ operation: "resume", computerId: COMPUTER })),
      h.deps,
    );
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ error: { code: "at_capacity", retryable: false } });
    fake.inputs.delete("at_capacity");
    await handleLauncherRequest(
      await signed(
        JSON.stringify({
          protocolVersion: 1,
          operationId: "b".repeat(32),
          operation: "terminate",
          computerId: COMPUTER,
        }),
      ),
      h.deps,
    );
    const gone = await handleLauncherRequest(
      await signed(
        JSON.stringify({
          protocolVersion: 1,
          operationId: "c".repeat(32),
          operation: "status",
          computerId: COMPUTER,
        }),
      ),
      h.deps,
    );
    expect(gone.status).toBe(410);
    expect(await gone.json()).toMatchObject({ error: { code: "gone", retryable: false } });
  });

  it("reports a lost reply as retryable unavailable; the repeat returns the recorded outcome", async () => {
    const h = harness();
    const fake = new FakeWorkspace(COMPUTER);
    h.workspaces.set(COMPUTER, fake);
    fake.fire("resume");
    fake.fire("container_running");
    fake.fire("restore_confirmed");
    // The claim is applied, then the answer is lost.
    h.lose = { count: 1, after: true };
    const claim = call({ operation: "claim_start", computerId: COMPUTER });
    const lost = await handleLauncherRequest(await signed(claim), h.deps);
    expect(lost.status).toBe(503);
    expect(await lost.json()).toMatchObject({ error: { code: "unavailable", retryable: true } });
    const repeated = await handleLauncherRequest(await signed(claim), h.deps);
    const first = (await repeated.json()) as { granted: boolean; startAttempt: number };
    expect(first).toMatchObject({ operation: "claim_start", granted: true, startAttempt: 1 });
    // Applied once: the repeat did not claim a second attempt.
    expect(fake.attempt).toBe(1);
  });

  it("treats an answer that is not the contract's as internal, never success", async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      launcher: async () =>
        ({ operation: "admission", admitting: true }) as unknown as LauncherResult,
    };
    const response = await handleLauncherRequest(
      await signed(call({ operation: "status", computerId: COMPUTER })),
      h.deps,
    );
    expect(response.status).toBe(500);
  });

  it("reports ControlDO unavailable as retryable (FH-37)", async () => {
    const h = harness();
    h.control.unavailable = true;
    const response = await handleLauncherRequest(
      await signed(call({ operation: "provision", name: "managed-0f1e2d3c" })),
      h.deps,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "unavailable", retryable: true },
    });
  });

  it("passes WorkspaceDO's own error codes through", async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      launcher: async () => {
        throw platformError("stale_generation", "x");
      },
    };
    const response = await handleLauncherRequest(
      await signed(call({ operation: "keep_alive", computerId: COMPUTER })),
      h.deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "stale_generation", retryable: true },
    });
  });
});

describe("the receiver's edges", () => {
  it("checks the timestamp against the clock after the body arrived, and bounds the body's time (r1-6)", async () => {
    const body = encoder.encode(call({ operation: "status", computerId: COMPUTER }));
    const headers = await signLauncherRequest({
      key: encoder.encode(CURRENT),
      keyId: "k-current",
      operation: "status",
      timestamp: NOW,
      body,
    });
    // A body that arrives late: the clock has moved on by 1,000 s meanwhile.
    let now = NOW;
    const late = new ReadableStream<Uint8Array>({
      async pull(controller) {
        now += 1_000;
        controller.enqueue(body);
        controller.close();
      },
    });
    const stale = await checkLauncherRequest(
      new Request("http://platform.internal/launcher/status", {
        method: "POST",
        headers,
        body: late,
        duplex: "half",
      } as RequestInit),
      keys,
      () => now,
    );
    expect(stale).toMatchObject({ ok: false, refused: "stale_timestamp" });
    // A body that never finishes: refused at the body deadline.
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    const slow = await checkLauncherRequest(
      new Request("http://platform.internal/launcher/status", {
        method: "POST",
        headers,
        body: stalled,
        duplex: "half",
      } as RequestInit),
      keys,
      () => NOW,
      50,
    );
    expect(slow).toMatchObject({ ok: false, refused: "slow_body" });
    // A body whose cancel never settles: the refusal still comes at the deadline (r2-2).
    const stuck = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: () => new Promise(() => undefined),
    });
    const refusedInTime = await Promise.race([
      checkLauncherRequest(
        new Request("http://platform.internal/launcher/status", {
          method: "POST",
          headers,
          body: stuck,
          duplex: "half",
        } as RequestInit),
        keys,
        () => NOW,
        20,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still pending"), 500)),
    ]);
    expect(refusedInTime).toMatchObject({ ok: false, refused: "slow_body" });
  });

  it("refuses a slow or oversized streamed body even when its cancel fails", async () => {
    const headers = await signLauncherRequest({
      key: encoder.encode(CURRENT),
      keyId: "k-current",
      operation: "status",
      timestamp: NOW,
      body: new Uint8Array(),
    });
    const failingCancel = () => {
      throw new Error("cancel failed");
    };
    const slow = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel: failingCancel,
    });
    const big = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
      cancel: failingCancel,
    });
    const request = (body: ReadableStream<Uint8Array>) =>
      new Request("http://platform.internal/launcher/status", {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit);
    expect(await checkLauncherRequest(request(slow), keys, () => NOW, 20)).toMatchObject({
      refused: "slow_body",
    });
    expect(await checkLauncherRequest(request(big), keys, () => NOW)).toMatchObject({
      refused: "too_large",
    });
  });

  it("refuses a declared length over the limit before reading, and an empty body as not JSON", async () => {
    const h = harness();
    const big = await signed(call({ operation: "status", computerId: COMPUTER }), {
      headers: { "content-length": String(10 ** 9) },
    });
    expect((await handleLauncherRequest(big, h.deps)).status).toBe(400);
    const headers = await signLauncherRequest({
      key: encoder.encode(CURRENT),
      keyId: "k-current",
      operation: "status",
      timestamp: NOW,
      body: new Uint8Array(),
    });
    const empty = new Request("http://platform.internal/launcher/status", {
      method: "POST",
      headers,
    });
    const response = await handleLauncherRequest(empty, h.deps);
    expect(response.status).toBe(400);
    expect(h.logs.at(-1)?.fields).toMatchObject({ refused: "not_json" });
  });

  it("treats a ControlDO or WorkspaceDO answer for something else as internal", async () => {
    const h = harness();
    h.deps = {
      ...h.deps,
      control: async () => ({
        method: "limits",
        maxAwakeComputers: 1,
        maxInstanceSize: "standard-4",
      }),
    };
    const wrongMethod = await handleLauncherRequest(
      await signed(call({ operation: "provision", name: "managed-0f1e2d3c" })),
      h.deps,
    );
    expect(wrongMethod.status).toBe(500);
    const h2 = harness();
    h2.deps = {
      ...h2.deps,
      launcher: async () => ({
        operation: "provision",
        computerId: "cmp_01hzy3m8k6q4t2v9w7x5r0s1n9",
      }),
    };
    const otherComputer = await handleLauncherRequest(
      await signed(call({ operation: "provision", name: "managed-0f1e2d3c" })),
      h2.deps,
    );
    expect(otherComputer.status).toBe(500);
  });
});

describe("replies the Cloudflare launcher (WP3.6) can read", () => {
  it("frames every reply with an exact Content-Length, errors included", async () => {
    const h = harness();
    for (const request of [
      await signed(call({ operation: "prepare" })),
      await signed(call({ operation: "status", computerId: COMPUTER })),
      new Request("http://platform.internal/launcher/status", { method: "POST", body: "{}" }),
      new Request("http://platform.internal/nowhere", { method: "POST" }),
    ]) {
      const response = await handleLauncherRequest(request, h.deps);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(response.headers.get("content-length"), request.url).toBe(String(bytes.byteLength));
      expect(response.headers.get("content-type")).toBe("application/json");
    }
  });

  it("answers gone (410) for each operation 3.6 names once a removal intent is recorded", async () => {
    const h = harness();
    const fake = new FakeWorkspace(COMPUTER);
    h.workspaces.set(COMPUTER, fake);
    fake.fire("resume");
    fake.fire("container_running");
    fake.fire("restore_confirmed");
    const terminate = await handleLauncherRequest(
      await signed(
        JSON.stringify({
          protocolVersion: 1,
          operationId: "e".repeat(32),
          operation: "terminate",
          computerId: COMPUTER,
        }),
      ),
      h.deps,
    );
    expect(terminate.status).toBe(200);
    const ops: [string, Record<string, unknown>][] = [
      ["resume", {}],
      ["claim_start", {}],
      [
        "start_host",
        {
          startAttempt: 1,
          hostId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          hostName: "laptop",
          token: "cfo-canary-launch-token-0123456789abcdefghij",
          hostConfig: {},
        },
      ],
      ["checkpoint", { reason: "turn_completed" }],
    ];
    for (const [index, [operation, extra]] of ops.entries()) {
      const response = await handleLauncherRequest(
        await signed(
          JSON.stringify({
            protocolVersion: 1,
            operationId: String(index + 1).padStart(32, "a"),
            operation,
            computerId: COMPUTER,
            ...extra,
          }),
        ),
        h.deps,
      );
      expect(response.status, operation).toBe(410);
      expect(await response.json()).toMatchObject({ error: { code: "gone", retryable: false } });
    }
  });
});
