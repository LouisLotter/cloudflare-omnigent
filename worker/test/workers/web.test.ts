// The web Worker's forwarding path end to end inside workerd: web.ts → proxy.ts → forward.ts →
// the OMNIGENT binding → OmnigentServer → a fake server container. Ingress (WP2.1) is replaced
// by a fabricated admission, as its implementation lands separately; one test drives web.ts's
// own handler to check that an unadmitted request reaches nothing.
import { createExecutionContext, evictAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DurabilityUnconfirmed, ErrorBody } from "@cfo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import web, { routeAdmitted } from "../../src/web.ts";
import { defined } from "../support/defined.ts";
import { unconfirmedResponse } from "../support/fake-omnigent-server.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const ORIGIN = "https://omnigent.example.test";
const webEnv = { OMNIGENT: env.OMNIGENT } as unknown as WebEnv;
let fake: FakeServerContainer;

function admitted(path: string, init: RequestInit = {}): Admitted {
  return {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { sub: "sub-canary", sessionId: "session-canary", issuedAt: 1, expiresAt: 2 },
  };
}

async function route(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await routeAdmitted(admitted(path, init), webEnv, createExecutionContext());
  if (response.webSocket) return response;
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, headers: response.headers });
}

beforeEach(() => {
  testServers.clock.reset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // The one server object, with a container that runs and answers.
  fake = testServers.create(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME));
  fake.running = true;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
});

describe("web Worker: the forwarding path", () => {
  it("forwards an admitted request through the binding, with no trust header reaching Omnigent", async () => {
    const response = await route("/v1/sessions?limit=5", {
      headers: {
        "x-forwarded-email": "attacker@example.invalid",
        "cf-access-authenticated-user-email": "owner@example.invalid",
        "x-cfo-interface-version": "99",
        "x-cfo-computer-id": "cmp_spoofed",
        cookie: "__Host-ap_session=s",
      },
    });
    expect(response.status).toBe(200);
    const [sent] = fake.forwarded();
    expect(sent?.url).toBe("http://omnigent.example.test/v1/sessions?limit=5");
    expect(sent?.headers.cookie).toBe("__Host-ap_session=s");
    const leaked = Object.keys(sent?.headers ?? {}).filter((h) =>
      /^(x-cfo-|cf-access-|x-forwarded-email)/.test(h),
    );
    expect(leaked).toEqual([]);
  });

  it("refuses an unsafe method or an upgrade with a foreign or null Origin before the server", async () => {
    const refused = [
      ["POST", { origin: "https://evil.example" }],
      ["POST", { origin: "null" }],
      ["DELETE", { origin: "https://sibling.example.test" }],
      ["GET", { origin: "https://evil.example", upgrade: "websocket" }],
      ["GET", { origin: "null", upgrade: "websocket" }],
    ] as const;
    for (const [method, headers] of refused) {
      const response = await route("/v1/sessions", {
        method,
        headers,
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(response.status).toBe(403);
      expect(ErrorBody.parse(await response.json()).error.code).toBe("forbidden");
    }
    expect(fake.requests).toEqual([]);
    const allowed = await route("/v1/sessions", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "{}",
    });
    expect(allowed.status).toBe(200);
  });

  it("passes a 424 and a redirect through once, untouched", async () => {
    fake.handler = (_port, request) =>
      new URL(request.url).pathname === "/"
        ? new Response(null, { status: 302, headers: { location: "/login" } })
        : unconfirmedResponse(new URL(request.url).pathname);
    const redirect = await route("/");
    expect([redirect.status, redirect.headers.get("location")]).toEqual([302, "/login"]);
    const unconfirmed = await route("/auth/password", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: "{}",
    });
    expect(unconfirmed.status).toBe(424);
    expect(await unconfirmed.json()).toMatchObject({
      code: "durability_unconfirmed",
      applied: true,
    });
    expect(fake.forwarded().map((r) => new URL(r.url).pathname)).toEqual(["/", "/auth/password"]);
    const api = await route("/v1/scheduled-tasks", { method: "POST", body: "{}" });
    expect(DurabilityUnconfirmed.safeParse(await api.json()).success).toBe(true);
    expect(fake.forwarded()).toHaveLength(3);
  });

  it("carries a WebSocket end to end under a bare 101", async () => {
    const response = await route("/v1/sessions/updates", {
      headers: { upgrade: "websocket", origin: ORIGIN, "sec-websocket-protocol": "omnigent.v1" },
    });
    expect(response.status).toBe(101);
    expect([...response.headers.keys()]).toEqual(["sec-websocket-protocol"]);
    const socket = defined(response.webSocket, "a WebSocket");
    socket.accept();
    const echoed = new Promise<unknown>((resolve) =>
      socket.addEventListener("message", (event) => resolve(event.data)),
    );
    socket.send("ping");
    expect(await echoed).toBe("ping");
    socket.close(1000, "done");
  });

  it("passes Omnigent's attachment and preview headers to the browser (RC-07's proxy part)", async () => {
    const headers = {
      "content-disposition": 'attachment; filename="page.html"',
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    };
    fake.handler = () =>
      new Response("<h1>x</h1>", { headers: { ...headers, "content-type": "text/html" } });
    const response = await route("/v1/sessions/s/resources/r/content");
    for (const [name, value] of Object.entries(headers))
      expect(response.headers.get(name)).toBe(value);
  });
});

describe("web Worker: ingress first", () => {
  it("lets no unadmitted request reach the server or wake its container", async () => {
    fake.running = false;
    const response = await web.fetch(
      new Request(`${ORIGIN}/v1/sessions`, { method: "POST", body: "{}" }),
      webEnv,
      createExecutionContext(),
    );
    expect([403, 404, 429, 503]).toContain(response.status);
    await response.arrayBuffer();
    expect(fake.requests).toEqual([]);
    expect(fake.starts).toEqual([]);
  });
});
