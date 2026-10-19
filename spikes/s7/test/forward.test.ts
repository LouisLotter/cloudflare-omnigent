import { describe, expect, it } from "vitest";
import { type ForwardDeps, forwardToServer } from "../src/forward.ts";
import { MANAGED_MESSAGE, refusalBody } from "../src/guard.ts";

const ORIGIN = "http://upstream.test";

const SHARING = {
  object: "sharing",
  sharing_mode: "read_only",
  editable: true,
  public_sharing_enabled: false,
  public_sharing_editable: true,
  public_sharing_max_level: "read",
  public_sharing_max_level_editable: true,
  default_public_sessions: "off",
  default_public_sessions_editable: true,
};

function harness(respond: (request: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: ForwardDeps = {
    upstream: async (request) => {
      seen.push(request);
      return respond(request);
    },
    upstreamOrigin: ORIGIN,
    basePath: "",
    mode: "strict",
    log: (entry) => logs.push(entry),
  };
  return { deps, seen, logs };
}

const jsonResponse = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"x"', ...headers },
  });

describe("forwardToServer", () => {
  it("refuses a write without contacting the server, from either entry", async () => {
    for (const entry of ["browser", "computer"] as const) {
      const { deps, seen, logs } = harness(() => {
        throw new Error("must not be called");
      });
      const response = await forwardToServer(
        new Request("http://w/v1/%73haring", { method: "PUT", body: '{"public_sharing":"yes"}' }),
        entry,
        deps,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("x-s7-guard")).toBe("refused");
      expect(await response.text()).toBe(refusalBody());
      expect(seen).toHaveLength(0);
      expect(logs[0]).toMatchObject({ entry, action: "refuse", status: 403 });
    }
  });

  it("refuses while the server is down, because it never asks the server", async () => {
    const { deps } = harness(() => {
      throw new Error("connection refused");
    });
    const write = await forwardToServer(
      new Request("http://w/v1/sharing", { method: "PUT", body: "{}" }),
      "browser",
      deps,
    );
    expect(write.status).toBe(403);
    const read = await forwardToServer(new Request("http://w/v1/sharing"), "browser", deps);
    expect(read.status).toBe(502);
    expect(read.headers.get("x-s7-guard")).toBe("upstream-error");
  });

  it("marks a read as managed and drops stale body headers", async () => {
    const { deps, seen } = harness(() => jsonResponse(SHARING, { "content-encoding": "gzip" }));
    const response = await forwardToServer(new Request("http://w/v1/sharing"), "computer", deps);
    expect(seen[0]?.url).toBe(`${ORIGIN}/v1/sharing`);
    expect(response.headers.get("x-s7-guard")).toBe("rewritten");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      sharing_mode: "read_only",
      editable: false,
      public_sharing_editable: false,
      public_sharing_max_level_editable: false,
      default_public_sessions_editable: false,
      managed: true,
      managed_message: MANAGED_MESSAGE,
    });
  });

  it("answers HEAD with headers only", async () => {
    const { deps } = harness(() => jsonResponse(SHARING));
    const response = await forwardToServer(
      new Request("http://w/v1/sharing", { method: "HEAD" }),
      "browser",
      deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-s7-guard")).toBe("rewritten");
    expect(await response.text()).toBe("");
  });

  it("passes non-200 and non-JSON reads through unchanged", async () => {
    const unauthorized = harness(
      () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }),
    );
    const r1 = await forwardToServer(
      new Request("http://w/v1/sharing"),
      "browser",
      unauthorized.deps,
    );
    expect(r1.status).toBe(401);
    expect(r1.headers.get("x-s7-guard")).toBe("managed-passthrough");
    const html = harness(
      () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const r2 = await forwardToServer(new Request("http://w/v1/sharing/"), "browser", html.deps);
    expect(await r2.text()).toBe("<html>");
    expect(r2.headers.get("x-s7-guard")).toBe("managed-passthrough");
  });

  it("fails closed when a JSON read cannot be rewritten", async () => {
    const { deps } = harness(
      () => new Response("[1,2", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const response = await forwardToServer(new Request("http://w/v1/sharing"), "browser", deps);
    expect(response.status).toBe(502);
    expect(response.headers.get("x-s7-guard")).toBe("rewrite-failed");
  });

  it("forwards other traffic to the server's origin, never to a host named in the path", async () => {
    const { deps, seen } = harness(() => new Response("ok"));
    const response = await forwardToServer(
      new Request("http://w//evil.test/v1/info?x=1", {
        headers: { "cf-access-jwt-assertion": "forged", "x-forwarded-for": "1.2.3.4" },
      }),
      "computer",
      deps,
    );
    expect(response.headers.get("x-s7-guard")).toBe("forwarded");
    const sent = seen[0];
    expect(sent && new URL(sent.url).host).toBe("upstream.test");
    expect(sent?.url).toBe(`${ORIGIN}//evil.test/v1/info?x=1`);
    expect(sent?.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(sent?.headers.get("x-forwarded-for")).toBeNull();
  });

  it("naive mode, kept for comparison, misses encoded spellings", async () => {
    const { deps, seen } = harness(() => jsonResponse(SHARING));
    const response = await forwardToServer(
      new Request("http://w/v1%2Fsharing", { method: "PUT" }),
      "browser",
      { ...deps, mode: "naive" },
    );
    expect(response.headers.get("x-s7-guard")).toBe("forwarded");
    expect(seen).toHaveLength(1);
  });
});
