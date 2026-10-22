// The staging harness (test/staging/ingress/harness.ts) inside workerd, before it is deployed:
// the self-test passes with a locally signed assertion, the echo probe shows nothing leaked, and
// no response carries the assertion or an email.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IngressEnv } from "../../src/ingress/index.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import harness from "../staging/ingress/harness.ts";
import {
  AUD,
  claims,
  HOST,
  ISSUER,
  jwksResponse,
  makeKey,
  OWNER_EMAIL,
  SALT,
  sign,
  TEAM,
  type TestKey,
} from "../support/access-keys.ts";

const ORIGIN = `https://${HOST}`;
let key: TestKey;
let other: TestKey;
let env: IngressEnv;
const ctx = {} as ExecutionContext;

beforeAll(async () => {
  [key, other] = await Promise.all([makeKey("kid-current"), makeKey("kid-previous")]);
  env = {
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function serveCerts() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    return jwksResponse(key, other);
  });
}

describe("the staging harness", () => {
  it("passes its self-test on a genuine assertion and shows a clean forwarded request", async () => {
    serveCerts();
    const token = await sign(key, claims(Math.floor(Date.now() / 1000)));
    const response = await harness.fetch(
      new Request(`${ORIGIN}/__ingress/selftest?format=json`, {
        headers: {
          "cf-access-jwt-assertion": token,
          "cf-access-authenticated-user-email": OWNER_EMAIL,
          cookie: `CF_Authorization=${token}; theme=dark`,
        },
      }),
      env,
      ctx,
    );
    expect(response.headers.get("x-cfo-ingress-harness")).toBe("1");
    const text = await response.text();
    expect(text).not.toContain(token.slice(-40));
    expect(text).not.toContain(OWNER_EMAIL);
    const report = JSON.parse(text);
    expect(report.cases.filter((c: { pass: boolean }) => !c.pass)).toEqual([]);
    expect(report).toMatchObject({
      verdict: "PASS",
      s5Cases: 18,
      teamKeys: 2,
      arrivedWithIdentity: [
        "cf-access-authenticated-user-email",
        "cf-access-jwt-assertion",
        "CF_Authorization",
      ],
      forwardedCookieNames: ["theme"],
      forwardedLeak: null,
    });
    expect(report.cases.map((c: { name: string }) => c.name)).toContain(
      "another genuine team key's ID",
    );

    const page = await harness.fetch(
      new Request(`${ORIGIN}/__ingress/selftest`, {
        headers: { "cf-access-jwt-assertion": token },
      }),
      env,
      ctx,
    );
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const html = await page.text();
    expect(html).toContain('"verdict": "PASS"');
    expect(html).not.toContain(token.slice(-40));
  });

  it("echoes a same-origin POST with spoofed identity headers, all stripped", async () => {
    serveCerts();
    const token = await sign(key, claims(Math.floor(Date.now() / 1000)));
    const response = await harness.fetch(
      new Request(`${ORIGIN}/__ingress/echo`, {
        method: "POST",
        body: "echo",
        headers: {
          "cf-access-jwt-assertion": token,
          origin: ORIGIN,
          "x-forwarded-email": "spoof@example.invalid",
          "cf-access-authenticated-user-email": "spoof@example.invalid",
          "remote-user": "spoof",
        },
      }),
      env,
      ctx,
    );
    expect(await response.json()).toMatchObject({
      verdict: "PASS",
      leak: null,
      bodyForwarded: true,
      origin: "exact",
    });
  });

  it("marks its refusals, and has no route but its two behind ingress", async () => {
    serveCerts();
    const anonymous = await harness.fetch(new Request(`${ORIGIN}/__ingress/selftest`), env, ctx);
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers.get("x-cfo-ingress-harness")).toBe("1");
    const token = await sign(key, claims(Math.floor(Date.now() / 1000)));
    const unknown = await harness.fetch(
      new Request(`${ORIGIN}/v1/sessions`, { headers: { "cf-access-jwt-assertion": token } }),
      env,
      ctx,
    );
    expect(unknown.status).toBe(404);
    const unconfigured = await harness.fetch(new Request(`${ORIGIN}/`), {}, ctx);
    expect(unconfigured.status).toBe(503);
  });
});
