// The GitHub setup page through the whole web Worker inside workerd (WP3.36): web.ts with WP2.1's
// real ingress (Access assertion, AUD, owner pin, hostnames, origin), the OMNIGENT binding into
// the real OmnigentServer, and a fake server container. The page is GitHub's return address
// after "Install": it must be exactly as closed as the password page (WP3.34), never reach the
// object for anyone but the pinned owner, and send the owner on only once GitHub linking is on.
import {
  createExecutionContext,
  evictAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import { makeOwnerPin } from "../../src/ingress/owner.ts";
import { GITHUB_SETUP_PATH, INTEGRATIONS_PATH } from "../../src/pages/github.ts";
import type { OmnigentServer } from "../../src/server/OmnigentServer.ts";
import { OMNIGENT_SERVER_OBJECT_NAME } from "../../src/shared/rpc.ts";
import web from "../../src/web.ts";
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
const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
/** Synthetic: the App's settings as `github-app` stores them. */
const APP = {
  SERVER_ENV_OMNIGENT_GITHUB_APP_ID: "123456",
  SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_ID: "Iv23liCanaryClient00",
  SERVER_ENV_OMNIGENT_GITHUB_APP_CLIENT_SECRET: "cfo-canary-github-client-secret-00000000",
  SERVER_ENV_OMNIGENT_GITHUB_APP_REDIRECT_URI: `${ORIGIN}/v1/connections/github/callback`,
  SERVER_ENV_OMNIGENT_GITHUB_APP_SLUG: "omnigent-01hs3f9q",
};
/** What GitHub appends to the setup URL; anyone could forge it, and the page ignores it. */
const FROM_GITHUB = `${GITHUB_SETUP_PATH}?installation_id=12345&setup_action=install`;

let key: TestKey;
let ingressEnv: WebEnv;
let assertion: string;
let stranger: string;
let fake: FakeServerContainer;
const logs: string[] = [];

beforeAll(async () => {
  key = await makeKey("kid-github-test");
  ingressEnv = {
    OMNIGENT: env.OMNIGENT,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ALLOWED_HOSTNAMES: HOST,
    OWNER_EMAIL_HASH: await makeOwnerPin(OWNER_EMAIL, SALT),
  } as unknown as WebEnv;
  const now = Math.floor(Date.now() / 1000);
  assertion = await sign(key, claims(now, { exp: now + 3600 }));
  stranger = await sign(key, claims(now, { exp: now + 3600, email: "someone@example.invalid" }));
  // The owner chose a password already: page loads outside /platform/ reach Omnigent.
  testServers.release(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME), {
    SERVER_ENV_OMNIGENT_ACCOUNTS_INIT_ADMIN_PASSWORD: null,
    SERVER_ENV_CFO_INSTALLATION_INITIALIZED: "true",
  });
});

beforeEach(() => {
  testServers.clock.reset();
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  vi.stubGlobal("fetch", async () => jwksResponse(key));
  fake = testServers.create(env.OMNIGENT.idFromName(OMNIGENT_SERVER_OBJECT_NAME));
  fake.info = { accounts_enabled: true, needs_setup: false, enabled_connections: [] };
  fake.handler = async (_port, request) => Response.json({ path: new URL(request.url).pathname });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await evictAllDurableObjects();
});

async function visit(
  url: string,
  init: RequestInit = {},
  who: "owner" | "stranger" | "nobody" = "owner",
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (who !== "nobody")
    headers.set("cf-access-jwt-assertion", who === "owner" ? assertion : stranger);
  const target = url.startsWith("http") ? url : `${ORIGIN}${url}`;
  const response = await web.fetch(
    new Request(target, { ...init, headers, redirect: "manual" }),
    ingressEnv,
    createExecutionContext(),
  );
  const body = await response.arrayBuffer();
  return new Response(body, { status: response.status, headers: response.headers });
}

const stub = () =>
  env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as DurableObjectStub<OmnigentServer>;

async function nextCheck(): Promise<void> {
  const at = await runInDurableObject(stub(), (_i: OmnigentServer, state) =>
    state.storage.getAlarm(),
  );
  testServers.clock.advance(Math.max(0, (at ?? testServers.clock.now()) - testServers.clock.now()));
  expect(await runDurableObjectAlarm(stub())).toBe(true);
}

/** A running server, started and answering. */
async function running(): Promise<void> {
  await nextCheck();
  await nextCheck();
}

describe("web Worker: the GitHub setup page behind Access", () => {
  it("refuses anyone but the pinned owner before the object, whatever GitHub appended", async () => {
    for (const who of ["nobody", "stranger"] as const) {
      for (const path of [GITHUB_SETUP_PATH, FROM_GITHUB]) {
        const response = await visit(path, { headers: navigation }, who);
        expect(response.status, `${who} ${path}`).toBe(403);
        expect(response.headers.get("location")).toBeNull();
      }
    }
    expect(fake.requests).toEqual([]);
    expect(logs.some((l) => l.includes('"event":"ingress_refused"'))).toBe(true);
  });

  it("refuses another hostname, another scheme, and a change from another origin", async () => {
    expect((await visit(`https://other.example.invalid${GITHUB_SETUP_PATH}`)).status).toBe(404);
    expect((await visit(`http://${HOST}${GITHUB_SETUP_PATH}`)).status).toBe(404);
    const foreign = await visit(GITHUB_SETUP_PATH, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(403);
    // The page changes nothing: even its own origin gets no POST.
    const own = await visit(GITHUB_SETUP_PATH, { method: "POST", headers: { origin: ORIGIN } });
    expect(own.status).toBe(405);
    expect(fake.requests).toEqual([]);
  });

  it("never forwards a platform call's path, and the page itself never reaches Omnigent's routes", async () => {
    await running();
    for (const path of ["/_cfo/github", "/_cfo/owner-password"]) {
      expect((await visit(path, { method: "POST", headers: { origin: ORIGIN } })).status).toBe(404);
    }
    await visit(FROM_GITHUB, { headers: navigation });
    // Only the object's own reads: its health check and /v1/info, never a forwarded request.
    expect(fake.forwarded()).toEqual([]);
  });

  it("waits while the server runs without the App, then opens Integrations once GitHub linking is on", async () => {
    await running();
    const waiting = await visit(FROM_GITHUB, { headers: navigation });
    expect(waiting.status).toBe(200);
    const html = await waiting.text();
    expect(html).toContain("Finishing GitHub setup");
    expect(html).toContain('data-step="switching"');
    expect(html).toContain('http-equiv="refresh"');
    expect(html).not.toContain("installation_id");
    // The secrets change: the object switches to the new version, and its watchdog restarts the
    // server with the App's settings.
    testServers.release(stub().id, APP);
    await evictDurableObject(stub());
    const restarting = await (await visit(GITHUB_SETUP_PATH, { headers: navigation })).text();
    expect(restarting).toContain('data-step="restarting"');
    await nextCheck(); // replaced: SIGTERM
    await nextCheck(); // seen stopped
    fake.info = { accounts_enabled: true, needs_setup: false, enabled_connections: ["github"] };
    await nextCheck(); // started with the App's settings
    await nextCheck(); // it answers
    const ready = await visit(FROM_GITHUB, { headers: navigation });
    expect(ready.status).toBe(303);
    expect(ready.headers.get("location")).toBe(INTEGRATIONS_PATH);
    // And Integrations is Omnigent's, forwarded as usual.
    const integrations = await visit(INTEGRATIONS_PATH, { headers: navigation });
    expect(await integrations.json()).toEqual({ path: INTEGRATIONS_PATH });
    // No value of the App's settings in any line.
    for (const value of Object.values(APP)) expect(logs.join("\n")).not.toContain(value);
  });
});
