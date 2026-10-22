// The holding gateway (gateway.js): part uploads inside the hold window wait for its end, then
// go through the Sandbox SDK's own handler; control calls never use it.
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs

import { describe, expect, it } from "vitest";
import { gatewayFor, HoldingGateway, holdFor } from "./gateway.js";

// Workers' FixedLengthStream, which the SDK's part handler uses, for Node.
globalThis.FixedLengthStream ??= class FixedLengthStream {
  constructor() {
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writable = writable;
  }
};

function fakeBucket(parts) {
  return {
    get: async () => null,
    delete: async () => undefined,
    createMultipartUpload: async () => ({ uploadId: "u1" }),
    resumeMultipartUpload: () => ({
      uploadPart: async (n, readable) => {
        const text = await new Response(readable).text();
        parts.push({ n, text, at: Date.now() });
        return { etag: `e${n}` };
      },
    }),
  };
}

function part(n, body) {
  return new Request(`http://backups.sandbox.internal/parts/${n}`, {
    method: "PUT",
    headers: { "content-length": String(body.length) },
    body,
  });
}

describe("holdFor", () => {
  it("holds only inside the window", () => {
    const props = { holdFromMs: 1_000, holdUntilMs: 5_000 };
    expect(holdFor(props, 999)).toBe(0);
    expect(holdFor(props, 1_000)).toBe(4_000);
    expect(holdFor(props, 4_999)).toBe(1);
    expect(holdFor(props, 5_000)).toBe(0);
    expect(holdFor({}, 1_000)).toBe(0);
    expect(holdFor(undefined, 1_000)).toBe(0);
  });
});

describe("HoldingGateway", () => {
  const grant = { protocolVersion: 1, mode: "write", binding: "CKPT", key: "k", uploadId: "u1" };

  it("passes a part through at once outside a hold", async () => {
    const parts = [];
    const gw = new HoldingGateway({ props: grant }, { CKPT: fakeBucket(parts) });
    const res = await gw.fetch(part(1, "abc"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: "e1" });
    expect(parts).toEqual([expect.objectContaining({ n: 1, text: "abc" })]);
  });

  it("holds a part until the window ends, then stores it", async () => {
    const parts = [];
    const now = Date.now();
    const props = { ...grant, holdFromMs: now - 10, holdUntilMs: now + 150 };
    const gw = new HoldingGateway({ props }, { CKPT: fakeBucket(parts) });
    const t0 = Date.now();
    const res = await gw.fetch(part(2, "defg"));
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(130);
    expect(parts[0].at).toBeGreaterThanOrEqual(props.holdUntilMs - 5);
  });

  it("still refuses what the grant does not allow", async () => {
    const gw = new HoldingGateway({ props: { protocolVersion: 1, mode: "deny" } }, {});
    expect((await gw.fetch(part(1, "x"))).status).toBe(403);
  });
});

describe("gatewayFor", () => {
  it("sends control calls to the SDK's gateway and transfers to the holding one", () => {
    const made = [];
    const exports = {
      DirectoryBackupGateway: (o) => made.push(["sdk", o.props]),
      HoldingGateway: (o) => made.push(["holding", o.props]),
    };
    const gateway = gatewayFor(exports, { from: 1, until: 2 });
    gateway({ props: { protocolVersion: 1, mode: "control", key: "k" } });
    gateway({ props: { protocolVersion: 1, mode: "write", key: "k" } });
    gateway({ props: { protocolVersion: 1, mode: "deny" } });
    expect(made).toEqual([
      ["sdk", { protocolVersion: 1, mode: "control", key: "k" }],
      ["holding", { protocolVersion: 1, mode: "write", key: "k", holdFromMs: 1, holdUntilMs: 2 }],
      ["holding", { protocolVersion: 1, mode: "deny", holdFromMs: 1, holdUntilMs: 2 }],
    ]);
  });
});
