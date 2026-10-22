// WP2.1's staging harness: the product's ingress (`withIngress`) in front of a probe handler.
// It wakes nothing and stores nothing. Every response carries `x-cfo-ingress-harness: 1`, so a
// probe can tell the Worker's answers from Access's.
//
// Steps (run from the repository root; the owner's part is step 4):
//   1. pnpm stg deploy --suffix wp21-ingress --owner WP2.1 --config worker/test/staging/ingress/wrangler.jsonc --days 1
//   2. node worker/test/staging/ingress/config.ts
//   3. pnpm stg deploy --suffix wp21-ingress --owner WP2.1 --config worker/test/staging/ingress/generated/wrangler.staging.jsonc --days 1
//      node worker/test/staging/ingress/edge.ts <out.json>          (no session needed)
//   4. Owner: open https://cfo-stg-wp21-ingress.<zone>/__ingress/selftest, sign in through
//      Access, read the verdict, reload once, and read the CF_Authorization cookie's SameSite in
//      the browser's developer tools.
//   5. node worker/test/staging/ingress/logs.ts 60 <out.json>
//      pnpm stg teardown --suffix wp21-ingress
//      node worker/test/staging/ingress/teardown-check.ts <out.json>
//
// Routes, all behind ingress:
//   GET  /__ingress/selftest  the cases derived from the caller's genuine assertion, run through
//                             the whole ingress step with the team's real keys; what the
//                             admitted request kept; an HTML page that also runs the echo probe
//   POST /__ingress/echo      the header and cookie names an admitted request still carries,
//                             sent with spoofed identity headers by the selftest page
// Nothing it returns or logs holds the assertion, an email or a cookie value.

import { JwksCache } from "../../../src/ingress/access.ts";
import { IDENTITY_HEADERS } from "../../../src/ingress/hosts.ts";
import {
  type Admitted,
  type IngressEnv,
  parseIngressEnv,
  withIngress,
} from "../../../src/ingress/index.ts";
import { deriveCases, leakedIdentity } from "../../support/ingress-derived.ts";

const MARK = "x-cfo-ingress-harness";

function marked(response: Response): Response {
  const copy = new Response(response.body, response);
  copy.headers.set(MARK, "1");
  copy.headers.set("cache-control", "no-store");
  return copy;
}

function log(line: Record<string, unknown>): void {
  console.log(JSON.stringify(line));
}

const cookieNames = (request: Request): string[] =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.split("=")[0]?.trim() ?? "")
    .filter((name) => name !== "");

const headerNames = (request: Request): string[] => [...request.headers.keys()].sort();

/** Identity material on the request as it reached the Worker: names only. */
const identityNames = (request: Request): string[] => [
  ...headerNames(request).filter(
    (name) => name.startsWith("cf-access-") || IDENTITY_HEADERS.includes(name),
  ),
  ...cookieNames(request).filter((name) => /^cf_authorization$/i.test(name)),
];

let keys: { url: string; cache: JwksCache } | undefined;

/** The team's key IDs, read from its certs endpoint. */
async function teamKids(certsUrl: string): Promise<string[]> {
  const response = await fetch(certsUrl, { signal: AbortSignal.timeout(5_000) });
  const body = (await response.json()) as { keys?: { kid?: unknown }[] };
  return (body.keys ?? [])
    .map((k) => k.kid)
    .filter((kid): kid is string => typeof kid === "string");
}

async function selftest(admitted: Admitted, original: Request, env: IngressEnv): Promise<Response> {
  const config = parseIngressEnv(env);
  if (!config) return Response.json({ error: "not configured" }, { status: 503 });
  if (keys?.url !== config.certsUrl) {
    keys = {
      url: config.certsUrl,
      cache: new JwksCache(
        config.certsUrl,
        (url) => fetch(url, { signal: AbortSignal.timeout(5_000) }),
        () => Date.now(),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ),
    };
  }
  const token = original.headers.get("cf-access-jwt-assertion") ?? "";
  const kidOf = (t: string): unknown => {
    try {
      return JSON.parse(atob((t.split(".")[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"))).kid;
    } catch {
      return undefined;
    }
  };
  const kids = await teamKids(config.certsUrl);
  const otherKid = kids.find((kid) => kid !== kidOf(token));
  const cases = await deriveCases({
    request: original,
    config,
    keys: keys.cache,
    nowMs: Date.now(),
    ...(otherKid !== undefined ? { otherKid } : {}),
  });
  const failed = cases.filter((c) => !c.pass);
  const report = {
    event: "ingress_selftest",
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    passed: cases.length - failed.length,
    total: cases.length,
    s5Cases: cases.filter((c) => c.group === "s5").length,
    teamKeys: kids.length,
    cases: cases.map(({ name, group, expected, got, pass, reachedNext }) => ({
      name,
      group,
      expected,
      got,
      pass,
      reachedNext,
    })),
    arrivedWithIdentity: identityNames(original),
    forwardedHeaderNames: headerNames(admitted.request),
    forwardedCookieNames: cookieNames(admitted.request),
    forwardedLeak: leakedIdentity(admitted.request) ?? null,
    sessionIdPrefix: admitted.identity.sessionId.slice(0, 12),
    expiresInSeconds: admitted.identity.expiresAt - Math.floor(Date.now() / 1000),
  };
  log(report);
  if (new URL(original.url).searchParams.get("format") === "json") return Response.json(report);
  const json = JSON.stringify(report, null, 2).replace(/</g, "\\u003c");
  return new Response(
    `<!doctype html>
<meta charset="utf-8">
<title>WP2.1 ingress self-test</title>
<style>body{font:15px system-ui,sans-serif;margin:2rem;max-width:60rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}</style>
<h1>WP2.1 ingress self-test: <span id="verdict"></span></h1>
<p>Derived cases: <b id="cases"></b>. Echo probe (spoofed identity headers through a same-origin POST): <b id="echo">running…</b></p>
<p>Session ID prefix: <code id="session"></code>. Reload once: it should stay the same.</p>
<p>Then open the developer tools: Application (Chrome) or Storage (Firefox), Cookies, this site, and read the <code>CF_Authorization</code> row's SameSite, Secure and HttpOnly columns.</p>
<pre id="report"></pre>
<script>
const report = ${json};
document.getElementById("verdict").textContent = report.verdict;
document.getElementById("cases").textContent = report.passed + " of " + report.total + " as expected";
document.getElementById("session").textContent = report.sessionIdPrefix;
document.getElementById("report").textContent = JSON.stringify(report, null, 2);
fetch("/__ingress/echo", {
  method: "POST",
  headers: {
    "content-type": "text/plain",
    "x-forwarded-email": "spoof@example.invalid",
    "cf-access-authenticated-user-email": "spoof@example.invalid",
    "remote-user": "spoof"
  },
  body: "echo"
}).then((r) => r.json()).then((echo) => {
  document.getElementById("echo").textContent =
    echo.verdict + " (" + echo.status + ", leaked: " + echo.leak + ")";
}).catch((e) => { document.getElementById("echo").textContent = "error: " + e; });
</script>
`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors 'none'",
      },
    },
  );
}

async function echo(admitted: Admitted, original: Request): Promise<Response> {
  const leak = leakedIdentity(admitted.request) ?? null;
  const body = await admitted.request.text();
  const report = {
    event: "ingress_echo",
    verdict: leak === null && body === "echo" ? "PASS" : "FAIL",
    status: "admitted",
    leak,
    bodyForwarded: body === "echo",
    origin: original.headers.get("origin") === admitted.origin ? "exact" : "other",
    arrivedWithIdentity: identityNames(original),
    forwardedHeaderNames: headerNames(admitted.request),
    forwardedCookieNames: cookieNames(admitted.request),
    sessionIdPrefix: admitted.identity.sessionId.slice(0, 12),
  };
  log(report);
  return Response.json(report);
}

export default {
  async fetch(request, env: IngressEnv, ctx): Promise<Response> {
    // The original is kept only to derive cases from its assertion after ingress admitted it.
    const original = request.clone();
    const handler = withIngress<IngressEnv>(async (admitted) => {
      const { pathname } = new URL(admitted.request.url);
      const method = admitted.request.method;
      if (method === "GET" && pathname === "/__ingress/selftest") {
        return selftest(admitted, original, env);
      }
      if (method === "POST" && pathname === "/__ingress/echo") return echo(admitted, original);
      return Response.json({ error: "no such route behind ingress" }, { status: 404 });
    });
    return marked(await handler(request, env, ctx));
  },
} satisfies ExportedHandler<IngressEnv>;
