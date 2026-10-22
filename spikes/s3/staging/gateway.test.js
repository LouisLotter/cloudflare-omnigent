// The holding gateway (gateway.js): a write grant's part uploads wait until holdMs after the
// first part arrived, then go through the Sandbox SDK's own handler; the Durable Object (or,
// without one, the process) keeps the hold's bookkeeping; control calls never use it.
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs

import { describe, expect, it } from "vitest";
import { gatewayFor, HoldingGateway, noteHold } from "./gateway.js";

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

const grant = { protocolVersion: 1, mode: "write", binding: "CKPT", key: "k", uploadId: "u1" };

describe("noteHold", () => {
  it("starts the hold at the first part and holds every part until its end", () => {
    const holds = new Map();
    expect(noteHold(holds, "a", 120_000, 1_000)).toBe(121_000);
    expect(noteHold(holds, "a", 120_000, 5_000)).toBe(121_000);
    expect(noteHold(holds, "a", 120_000, 130_000)).toBe(121_000);
    expect(holds.get("a")).toEqual({
      first: 1_000,
      until: 121_000,
      parts: 2,
      longestWaitMs: 120_000,
    });
    expect(noteHold(holds, "b", 10, 50)).toBe(60);
  });
});

describe("HoldingGateway", () => {
  it("passes a part through at once without a hold", async () => {
    const parts = [];
    const gw = new HoldingGateway({ props: grant }, { CKPT: fakeBucket(parts) });
    const res = await gw.fetch(part(1, "abc"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ etag: "e1" });
    expect(parts).toEqual([expect.objectContaining({ n: 1, text: "abc" })]);
  });

  it("holds parts until holdMs after the first one, asking the Durable Object", async () => {
    const parts = [];
    const asked = [];
    const holds = new Map();
    const env = {
      CKPT: fakeBucket(parts),
      BENCH: {
        idFromName: (name) => name,
        get: () => ({
          holdUntil: async (key, ms) => {
            asked.push([key, ms]);
            return noteHold(holds, key, ms, Date.now());
          },
        }),
      },
    };
    const props = { ...grant, holdKey: "r2-0-1", holdMs: 150 };
    const t0 = Date.now();
    const [a, b] = await Promise.all([
      new HoldingGateway({ props }, env).fetch(part(1, "one")),
      new HoldingGateway({ props }, env).fetch(part(2, "two")),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(asked).toEqual([
      ["r2-0-1", 150],
      ["r2-0-1", 150],
    ]);
    expect(holds.get("r2-0-1").parts).toBe(2);
    expect(Math.min(...parts.map((p) => p.at))).toBeGreaterThanOrEqual(
      holds.get("r2-0-1").until - 5,
    );
  });

  it("without a Durable Object, the process keeps the hold itself", async () => {
    const parts = [];
    const props = { ...grant, holdKey: "local-1", holdMs: 80 };
    const t0 = Date.now();
    await new HoldingGateway({ props }, { CKPT: fakeBucket(parts) }).fetch(part(1, "x"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it("never holds a read, and still refuses what the grant does not allow", async () => {
    const gw = new HoldingGateway({ props: { protocolVersion: 1, mode: "deny" } }, {});
    expect((await gw.fetch(part(1, "x"))).status).toBe(403);
    const read = {
      protocolVersion: 1,
      mode: "read",
      binding: "CKPT",
      key: "k",
      holdKey: "h",
      holdMs: 10_000,
    };
    const t0 = Date.now();
    const res = await new HoldingGateway({ props: read }, { CKPT: fakeBucket([]) }).fetch(
      new Request("http://backups.sandbox.internal/object", { headers: { range: "bytes=0-1" } }),
    );
    expect(res.status).toBe(404);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("gatewayFor", () => {
  it("sends control calls to the SDK's gateway and holds only the write grant", () => {
    const made = [];
    const exports = {
      DirectoryBackupGateway: (o) => made.push(["sdk", o.props]),
      HoldingGateway: (o) => made.push(["holding", o.props]),
    };
    const gateway = gatewayFor(exports, { key: "r2-0-1", ms: 120_000 });
    gateway({ props: { protocolVersion: 1, mode: "control", key: "k" } });
    gateway({ props: { protocolVersion: 1, mode: "write", key: "k" } });
    gateway({ props: { protocolVersion: 1, mode: "deny" } });
    expect(made).toEqual([
      ["sdk", { protocolVersion: 1, mode: "control", key: "k" }],
      [
        "holding",
        { protocolVersion: 1, mode: "write", key: "k", holdKey: "r2-0-1", holdMs: 120_000 },
      ],
      ["holding", { protocolVersion: 1, mode: "deny" }],
    ]);
  });
});
