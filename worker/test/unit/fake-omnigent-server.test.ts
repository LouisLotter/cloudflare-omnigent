import { DurabilityUnconfirmed, DurabilityUnconfirmedAuth } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { errorCodeOf } from "../../src/shared/errors.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION } from "../../src/shared/rpc.ts";
import { FakeOmnigentServer, unconfirmedResponse } from "../support/fake-omnigent-server.ts";

const interfaceVersion = OMNIGENT_SERVER_INTERFACE_VERSION;

const outage = (startedAt: string, endedAt: string | null) => ({
  outageId: "out_01hs3f9q2m8z4w7k6t5r1n0ybc",
  cause: "container_stopped" as const,
  startedAt,
  detectedAt: startedAt,
  endedAt,
  restarts: 1,
});

describe("FakeOmnigentServer", () => {
  it("records forwarded requests and answers from its queue, then with 200", async () => {
    const server = new FakeOmnigentServer();
    server.respondWith(new Response("first", { status: 201 }));
    const first = await server.fetch(new Request("https://app.example.com/v1/sessions"));
    const second = await server.fetch(new Request("https://app.example.com/"));
    expect([first.status, await first.text()]).toEqual([201, "first"]);
    expect([second.status, await second.text()]).toEqual([200, "ok"]);
    expect(server.requests.map((r) => new URL(r.url).pathname)).toEqual(["/v1/sessions", "/"]);
  });

  it("returns overlapping outages oldest first, and refuses records outside the contract", async () => {
    const server = new FakeOmnigentServer();
    server.addOutage(outage("2026-10-20T05:00:00Z", null));
    server.addOutage(outage("2026-10-20T03:00:00Z", "2026-10-20T03:12:00Z"));
    server.addOutage(outage("2026-10-19T03:00:00Z", "2026-10-19T03:05:00Z"));
    const found = await server.outages({
      interfaceVersion,
      from: "2026-10-20T00:00:00Z",
      to: "2026-10-21T00:00:00Z",
    });
    expect(found.map((o) => o.startedAt)).toEqual(["2026-10-20T03:00:00Z", "2026-10-20T05:00:00Z"]);
    expect(() =>
      server.addOutage({ ...outage("2026-10-20T03:00:00Z", null), restarts: -1 }),
    ).toThrow();
  });

  it("answers the bootstrap status a test set, and refuses a newer interface version", async () => {
    const server = new FakeOmnigentServer();
    expect(await server.bootstrapStatus({ interfaceVersion })).toBeNull();
    server.bootstrap = {
      protocolVersion: 1,
      installationId: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
      initialized: true,
      checkedAt: "2026-10-20T09:15:00.000Z",
    };
    expect((await server.bootstrapStatus({ interfaceVersion }))?.initialized).toBe(true);
    const refused = await server
      .bootstrapStatus({ interfaceVersion: interfaceVersion + 1 })
      .catch((error: unknown) => error);
    expect(errorCodeOf(refused)).toBe("unsupported_version");
  });

  it("builds the 424 each route family's clients parse", async () => {
    const api = unconfirmedResponse("/v1/scheduled-tasks");
    const auth = unconfirmedResponse("/auth/password");
    expect([api.status, auth.status]).toEqual([424, 424]);
    expect(DurabilityUnconfirmed.safeParse(await api.json()).success).toBe(true);
    expect(DurabilityUnconfirmedAuth.safeParse(await auth.json()).success).toBe(true);
  });
});
