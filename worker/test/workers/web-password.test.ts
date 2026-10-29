// The password page through the whole web Worker inside workerd (WP3.34): web.ts with WP2.1's real
// ingress (Access assertion, AUD, owner pin), the OMNIGENT binding into the real OmnigentServer,
// and a fake server container that checks the platform call's signature. The order of the tests
// matters: the web Worker's isolate remembers once the owner has a password.
import {
  createExecutionContext,
  evictAllDurableObjects,
  runDurableObjectAlarm,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  OWNER_PASSWORD_CALL_PATH,
  PLATFORM_CALL_SIGNATURE_HEADER,
  PLATFORM_CALL_TIMESTAMP_HEADER,
  signPlatformCall,
} from "@cfo/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { PASSWORD_PATH } from "../../src/pages/password.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import web, { routeAdmitted } from "../../src/web.ts";
import {
  AUD,
  claims,
  HOST,
  jwksResponse,
  makeKey,
  OWNER_EMAIL,
  SALT,
  sign,
  TEAM,
  type TestKey,
} from "../support/access-keys.ts";
import type { FakeServerContainer } from "../support/fake-server-container.ts";
import { testServers } from "../support/server-harness.ts";

const ORIGIN = `https://${HOST}`;
const COOKIE_SECRET = "d".repeat(64); // synthetic
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const PASSWORD = `${["CFO", "CANARY", ""].join("_")}WEBPAGEPASSWORD01`;
const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

let key: TestKey;
let ingressEnv: WebEnv;
let assertion: string;
let stranger: string;
let fake: FakeServerContainer;
const platformCalls: { password: string; valid: boolean }[] = [];
/** Every line logged in this file, kept across its tests. */
const logs: string[] = [];

beforeAll(async () => {
  key = await makeKey("kid-password-test");
  ingressEnv = {
    OMNIGENT: env.OMNIGENT,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
  } as unknown as WebEnv;
  const now = Math.floor(Date.now() / 1000);
  // One Access session for the whole file, as a browser keeps one: its ID binds the intent.
  assertion = await sign(key, claims(now, { exp: now + 3600 }));
  stranger = await sign(key, claims(now, { exp: now + 3600, email: "someone@example.invalid" }));
  testServers.release(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME), {
    SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET: COOKIE_SECRET,
    CFO_OWNER_PASSWORD_ON_PAGE: "true",
  });
});

beforeEach(async () => {
  testServers.clock.reset();
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.stubGlobal("fetch", async () => jwksResponse(key));
  fake = testServers.create(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME));
  fake.running = true;
  fake.handler = async (_port, request) => {
    if (new URL(request.url).pathname !== OWNER_PASSWORD_CALL_PATH) {
      return Response.json({ path: new URL(request.url).pathname });
    }
    const text = await request.text();
    const expected = await signPlatformCall({
      cookieSecret: COOKIE_SECRET,
      method: "POST",
      path: OWNER_PASSWORD_CALL_PATH,
      timestamp: Number(request.headers.get(PLATFORM_CALL_TIMESTAMP_HEADER)),
      body: new TextEncoder().encode(text),
    });
    platformCalls.push({
      password: (JSON.parse(text) as { password: string }).password,
      valid:
        expected[PLATFORM_CALL_SIGNATURE_HEADER] ===
        request.headers.get(PLATFORM_CALL_SIGNATURE_HEADER),
    });
    return Response.json({ ok: true }, { headers: { "x-cfo-durability": "confirmed" } });
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await evictAllDurableObjects();
});

async function visit(
  path: string,
  init: RequestInit = {},
  who: "owner" | "stranger" | "nobody" = "owner",
  session: string = assertion,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (who !== "nobody") {
    headers.set("cf-access-jwt-assertion", who === "owner" ? session : stranger);
  }
  const response = await web.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }),
    ingressEnv,
    createExecutionContext(),
  );
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, headers: response.headers });
}

function form(fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  };
}

async function intent(): Promise<string> {
  const html = await (await visit(PASSWORD_PATH)).text();
  const token = /name="intent" value="([0-9a-f]{64})"/.exec(html)?.[1];
  if (token === undefined) throw new Error("no intent token on the page");
  return token;
}

describe("web Worker: the password page behind Access (in this order)", () => {
  it("refuses anyone but the pinned owner, page and change alike, before the object", async () => {
    for (const who of ["nobody", "stranger"] as const) {
      expect((await visit(PASSWORD_PATH, {}, who)).status).toBe(403);
      expect((await visit("/", { headers: navigation }, who)).status).toBe(403);
      const change = await visit(
        PASSWORD_PATH,
        form({ intent: "0".repeat(64), password: PASSWORD, confirm: PASSWORD }),
        who,
      );
      expect(change.status).toBe(403);
    }
    expect(fake.requests).toEqual([]);
    expect(platformCalls).toEqual([]);
  });

  it("sends the owner's first page load to the password page, and nothing else", async () => {
    const first = await visit("/", { headers: navigation });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe(PASSWORD_PATH);
    const deep = await visit("/sessions/s1", { headers: { "sec-fetch-dest": "document" } });
    expect(deep.headers.get("location")).toBe(PASSWORD_PATH);
    const api = await visit("/v1/info", { headers: { "sec-fetch-mode": "cors" } });
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ accounts_enabled: true });
    expect(fake.forwarded().map((r) => new URL(r.url).pathname)).toEqual([]);
  });

  it("forwards a page load as usual, and logs it, when OmnigentServer cannot say", async () => {
    // As an object still on an older build answers: no such method. Forwarding is the real one.
    const olderObject = {
      ...ingressEnv,
      OMNIGENT: {
        getByName(name: string) {
          const stub = env.OMNIGENT.getByName(name);
          return {
            fetch: (request: Request) => stub.fetch(request),
            ownerPassword: async () => {
              throw new TypeError(
                'The RPC receiver does not implement the method "ownerPassword".',
              );
            },
          };
        },
      },
    } as unknown as WebEnv;
    const response = await routeAdmitted(
      {
        ok: true,
        request: new Request(`${ORIGIN}/`, { headers: navigation }),
        origin: ORIGIN,
        identity: { sub: "sub", sessionId: "e".repeat(64), issuedAt: 1, expiresAt: 2 },
      },
      olderObject,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(logs.some((line) => line.includes('"event":"first_visit_unknown"'))).toBe(true);
  });

  it("refuses a change from another origin or a stale page, and sets nothing", async () => {
    const token = await intent();
    const foreign = await visit(
      PASSWORD_PATH,
      form(
        { intent: token, password: PASSWORD, confirm: PASSWORD },
        { origin: "https://evil.example" },
      ),
    );
    expect(foreign.status).toBe(403);
    const stale = await visit(
      PASSWORD_PATH,
      form({ intent: "0".repeat(64), password: PASSWORD, confirm: PASSWORD }),
    );
    expect(stale.headers.get("location")).toBe(`${PASSWORD_PATH}?result=intent`);
    expect(platformCalls).toEqual([]);
  });

  it("never forwards a platform call's path, whoever asks", async () => {
    const direct = await visit(OWNER_PASSWORD_CALL_PATH, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, nonce: "0".repeat(32) }),
    });
    expect(direct.status).toBe(404);
    expect(platformCalls).toEqual([]);
  });

  it("sets the password through the signed call, then stops redirecting", async () => {
    const token = await intent();
    const done = await visit(
      PASSWORD_PATH,
      form({ intent: token, username: "owner-canary", password: PASSWORD, confirm: PASSWORD }),
    );
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${PASSWORD_PATH}?result=done`);
    expect(platformCalls).toEqual([{ password: PASSWORD, valid: true }]);
    const page = await (await visit(`${PASSWORD_PATH}?result=done`)).text();
    expect(page).toContain("Your Omnigent password is set");
    // Another Access session of the owner's sees the form, not "done" (Codex r1-3).
    const now = Math.floor(Date.now() / 1000);
    const other = await sign(key, claims(now, { exp: now + 3600, iat: now - 5 }));
    const elsewhere = await (
      await visit(`${PASSWORD_PATH}?result=done`, {}, "owner", other)
    ).text();
    expect(elsewhere).not.toContain("is set");
    expect(page).toContain("<strong>owner-canary</strong>");
    // Chosen: page loads now reach Omnigent, and the page is the reset.
    const home = await visit("/", { headers: navigation });
    expect(home.status).toBe(200);
    expect(await home.json()).toEqual({ path: "/" });
    expect(await (await visit(PASSWORD_PATH)).text()).toContain("Reset your Omnigent password");
    // The watchdog's own work is unaffected.
    expect(
      await runDurableObjectAlarm(
        env.OMNIGENT.get(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME)),
      ),
    ).toBe(true);
  });

  it("logged no password anywhere on the way", () => {
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });
});
