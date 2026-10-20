import { DurabilityUnconfirmed, DurabilityUnconfirmedAuth } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import { FakeOmnigentServer, unconfirmedResponse } from "../support/fake-omnigent-server.ts";

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
    const found = await server.outages("2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z");
    expect(found.map((o) => o.startedAt)).toEqual(["2026-10-20T03:00:00Z", "2026-10-20T05:00:00Z"]);
    expect(() =>
      server.addOutage({ ...outage("2026-10-20T03:00:00Z", null), restarts: -1 }),
    ).toThrow();
  });

  it("builds the 424 each route family's clients parse", async () => {
    const api = unconfirmedResponse("/v1/scheduled-tasks");
    const auth = unconfirmedResponse("/auth/password");
    expect([api.status, auth.status]).toEqual([424, 424]);
    expect(DurabilityUnconfirmed.safeParse(await api.json()).success).toBe(true);
    expect(DurabilityUnconfirmedAuth.safeParse(await auth.json()).success).toBe(true);
  });
});
