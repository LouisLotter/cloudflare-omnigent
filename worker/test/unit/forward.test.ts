import { DurabilityUnconfirmed, ErrorBody } from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import type { Admitted } from "../../src/ingress/index.ts";
import { forwardToServer, type ServerBinding } from "../../src/server/forward.ts";
import { hasForeignOrigin, needsOriginCheck, proxyToOmnigent } from "../../src/server/proxy.ts";
import {
  FORWARD_VERSION_HEADER,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
} from "../../src/shared/rpc.ts";
import { defined } from "../support/defined.ts";
import { unconfirmedResponse } from "../support/fake-omnigent-server.ts";

const ORIGIN = "https://omnigent.example.test";

class FakeBinding implements ServerBinding {
  readonly names: string[] = [];
  readonly requests: Request[] = [];
  answer: (request: Request) => Promise<Response> = async () => new Response("ok");

  getByName(name: string) {
    this.names.push(name);
    return {
      fetch: async (request: Request) => {
        this.requests.push(request);
        return this.answer(request);
      },
    };
  }
}

function admitted(request: Request): Admitted {
  return {
    ok: true,
    request,
    origin: ORIGIN,
    identity: { sub: "sub-canary", sessionId: "session-canary", issuedAt: 1, expiresAt: 2 },
  };
}

describe("forwardToServer", () => {
  it("calls the one server object once, with the interface version and no trust header", async () => {
    const binding = new FakeBinding();
    const response = await forwardToServer(
      new Request(`${ORIGIN}/v1/sessions?limit=5`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-email": "attacker@example.invalid",
          "cf-access-authenticated-user-email": "owner@example.invalid",
          [FORWARD_VERSION_HEADER]: "999",
          "x-cfo-computer-id": "cmp_spoofed",
          authorization: "Bearer omnigent-session",
        },
        body: '{"a":1}',
      }),
      binding,
    );
    expect(await response.text()).toBe("ok");
    expect(binding.names).toEqual([OMNIGENT_SERVER_OBJECT_NAME]);
    expect(binding.requests).toHaveLength(1);
    const sent = defined(binding.requests[0], "a forwarded request");
    expect(sent.url).toBe(`${ORIGIN}/v1/sessions?limit=5`);
    expect(sent.method).toBe("POST");
    expect(await sent.text()).toBe('{"a":1}');
    expect(Object.fromEntries(sent.headers)).toEqual({
      authorization: "Bearer omnigent-session",
      "content-type": "application/json",
      [FORWARD_VERSION_HEADER]: String(OMNIGENT_SERVER_INTERFACE_VERSION),
    });
  });

  it("passes a 424 through unchanged and never retries it, or anything else", async () => {
    for (const make of [
      () => unconfirmedResponse("/v1/scheduled-tasks"),
      () => new Response("busy", { status: 503 }),
      () => new Response("gone", { status: 502 }),
    ]) {
      const binding = new FakeBinding();
      binding.answer = async () => make();
      const response = await forwardToServer(
        new Request(`${ORIGIN}/v1/scheduled-tasks`, { method: "POST", body: "{}" }),
        binding,
      );
      expect(binding.requests).toHaveLength(1);
      if (response.status === 424) {
        expect(DurabilityUnconfirmed.safeParse(await response.json()).success).toBe(true);
      }
    }
  });

  it("reports a lost answer to a change as not retryable, and a failed read as retryable", async () => {
    const binding = new FakeBinding();
    binding.answer = async () => {
      throw new Error("Durable Object reset because its code was updated.");
    };
    const change = await forwardToServer(
      new Request(`${ORIGIN}/auth/password`, { method: "POST", body: "{}" }),
      binding,
    );
    expect(change.status).toBe(502);
    expect(ErrorBody.parse(await change.json()).error).toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    const read = await forwardToServer(new Request(`${ORIGIN}/v1/sessions`), binding);
    expect(read.status).toBe(503);
    expect(read.headers.get("retry-after")).toBe("5");
    expect(ErrorBody.parse(await read.json()).error.retryable).toBe(true);
    expect(binding.requests).toHaveLength(2);
  });
});

describe("proxyToOmnigent: exact origins on the forwarding path", () => {
  const cases: [string, Record<string, string>, boolean][] = [
    ["POST, foreign origin", { origin: "https://evil.example" }, false],
    ["POST, null origin", { origin: "null" }, false],
    ["POST, same-site sibling", { origin: "https://other.example.test" }, false],
    ["POST, http scheme", { origin: "http://omnigent.example.test" }, false],
    ["POST, trailing slash", { origin: `${ORIGIN}/` }, false],
    ["POST, exact origin", { origin: ORIGIN }, true],
    ["POST, no origin", {}, true],
  ];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const [name, headers, forwarded] of cases) {
      it(`${name.replace("POST", method)}: ${forwarded ? "forwarded" : "refused"}`, async () => {
        const binding = new FakeBinding();
        const response = await proxyToOmnigent(
          admitted(new Request(`${ORIGIN}/v1/sharing`, { method, headers, body: "{}" })),
          { OMNIGENT: binding },
        );
        expect(binding.requests).toHaveLength(forwarded ? 1 : 0);
        if (!forwarded) {
          expect(response.status).toBe(403);
          expect(ErrorBody.parse(await response.json()).error).toEqual({
            code: "forbidden",
            message: "Access denied.",
            retryable: false,
          });
        }
      });
    }
  }

  it("checks a WebSocket upgrade's origin, and lets safe requests through whatever their origin", async () => {
    const binding = new FakeBinding();
    const env = { OMNIGENT: binding };
    const upgrade = (origin: string) =>
      new Request(`${ORIGIN}/v1/sessions/updates`, { headers: { upgrade: "websocket", origin } });
    expect((await proxyToOmnigent(admitted(upgrade("https://evil.example")), env)).status).toBe(
      403,
    );
    expect((await proxyToOmnigent(admitted(upgrade("null")), env)).status).toBe(403);
    expect(binding.requests).toHaveLength(0);
    await proxyToOmnigent(admitted(upgrade(ORIGIN)), env);
    await proxyToOmnigent(
      admitted(new Request(`${ORIGIN}/`, { headers: { origin: "https://evil.example" } })),
      env,
    );
    expect(binding.requests).toHaveLength(2);
    expect(needsOriginCheck(new Request(`${ORIGIN}/`, { method: "OPTIONS" }))).toBe(false);
    expect(hasForeignOrigin(new Request(`${ORIGIN}/`), ORIGIN)).toBe(false);
  });

  it("passes Omnigent's own protections through to the browser (RC-07's proxy part)", async () => {
    const binding = new FakeBinding();
    const headers = {
      "content-disposition": "attachment; filename=\"x.html\"; filename*=UTF-8''x.html",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-type": "text/html",
    };
    binding.answer = async () => new Response("<script>alert(1)</script>", { headers });
    const response = await proxyToOmnigent(
      admitted(new Request(`${ORIGIN}/v1/sessions/s/resources/r/content`)),
      { OMNIGENT: binding },
    );
    for (const [name, value] of Object.entries(headers)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
