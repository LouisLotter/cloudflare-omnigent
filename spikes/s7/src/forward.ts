// The shared server-forwarding function. Every route to the Omnigent server goes through it: the
// browser entry (public hostname behind Access) and the computer entry (the private host route,
// reached through container interception of omnigent.internal). The guard runs here, so neither
// entry can bypass it, and it runs before the server is contacted, so a refusal does not depend
// on the server being up.

import { decide, MANAGED_MESSAGE, markManaged, refusalBody } from "./guard.ts";

export type Entry = "browser" | "computer";

/**
 * Spike-only comparison modes. `strict` is the guard under test. `naive` matches the raw
 * pathname exactly, as a first implementation might. `off` forwards everything.
 */
export type GuardMode = "strict" | "naive" | "off";

export interface ForwardDeps {
  /** Sends a request to the Omnigent server. */
  readonly upstream: (request: Request) => Promise<Response>;
  /** Origin the upstream request is addressed to, for example `http://127.0.0.1:18700`. */
  readonly upstreamOrigin: string;
  /** Omnigent's configured base path, normalized; "" for a root deployment. */
  readonly basePath: string;
  readonly mode: GuardMode;
  readonly log: (entry: Record<string, unknown>) => void;
}

/** Headers that only the Worker may set; a client value is dropped before forwarding. */
const STRIPPED_REQUEST_HEADERS = [
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-user",
  "x-forwarded-email",
  "x-real-ip",
];

/** Response headers that describe the upstream body, invalid once the body is rewritten. */
const BODY_HEADERS = ["content-length", "content-encoding", "etag", "last-modified"];

function guardHeader(response: Response, value: string): Response {
  if (response.status === 101 || response.webSocket) return response;
  const copy = new Response(response.body, response);
  copy.headers.set("x-s7-guard", value);
  return copy;
}

function refusal(): Response {
  return new Response(refusalBody(), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-s7-guard": "refused",
    },
  });
}

async function markResponse(response: Response, method: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.status !== 200 || !contentType.includes("json")) {
    return guardHeader(response, "managed-passthrough");
  }
  const headers = new Headers(response.headers);
  for (const name of BODY_HEADERS) headers.delete(name);
  headers.set("cache-control", "no-store");
  headers.set("x-s7-guard", "rewritten");
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  let body: string;
  try {
    body = JSON.stringify(markManaged(await response.json()));
  } catch {
    // Fail closed: never show the settings as editable because the rewrite failed.
    return new Response(
      JSON.stringify({ error: { code: "bad_gateway", message: MANAGED_MESSAGE } }),
      {
        status: 502,
        headers: { "content-type": "application/json", "x-s7-guard": "rewrite-failed" },
      },
    );
  }
  headers.set("content-type", "application/json");
  return new Response(body, { status: 200, headers });
}

/** Bodies of refused requests are read up to this size and dropped, never parsed or forwarded. */
const DISCARD_LIMIT = 64 * 1024;

/**
 * Drains a refused request's body so the client's upload completes before the refusal, then
 * stops at DISCARD_LIMIT. Cancelling the stream outright made Wrangler's local proxy report a
 * lost connection instead of the 403.
 */
async function discardBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  let read = 0;
  try {
    while (read <= DISCARD_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.byteLength;
    }
    await reader.cancel();
  } catch {
    // The client went away; the refusal still stands.
  }
}

function naiveDecision(request: Request): "pass" | "read" | "refuse" {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/sharing") return "pass";
  return request.method === "PUT" ? "refuse" : request.method === "GET" ? "read" : "pass";
}

export async function forwardToServer(
  request: Request,
  entry: Entry,
  deps: ForwardDeps,
): Promise<Response> {
  const url = new URL(request.url);
  let action: "pass" | "read" | "refuse";
  let reason = "";
  if (deps.mode === "off") {
    action = "pass";
  } else if (deps.mode === "naive") {
    action = naiveDecision(request);
  } else {
    const decision = decide(request, deps.basePath);
    action = decision.action;
    if (decision.action === "refuse") reason = decision.reason;
  }

  // Logged by path and status only: no query, headers or bodies.
  const log = (status: number) =>
    deps.log({
      s7: "forward",
      entry,
      method: request.method,
      path: url.pathname,
      action,
      reason,
      status,
    });

  if (action === "refuse") {
    log(403);
    await discardBody(request);
    return refusal();
  }

  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  // Concatenation keeps a path such as `//host/x` a path; new URL(path, origin) would not.
  const target = `${deps.upstreamOrigin}${url.pathname}${url.search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstreamRequest = new Request(target, {
    method: request.method,
    headers,
    body: hasBody ? request.body : null,
    redirect: "manual",
  });
  let response: Response;
  try {
    response = await deps.upstream(upstreamRequest);
  } catch {
    log(502);
    return new Response(
      JSON.stringify({ error: { code: "bad_gateway", message: "The server is not reachable." } }),
      {
        status: 502,
        headers: { "content-type": "application/json", "x-s7-guard": "upstream-error" },
      },
    );
  }
  log(response.status);
  if (action === "read") return markResponse(response, request.method);
  return guardHeader(response, "forwarded");
}
