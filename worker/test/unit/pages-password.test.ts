// The owner's Omnigent password page (WP3.34, `pages/password.ts` through `pages/router.ts`):
// the security headers and framing protection; exact origin, fetch metadata, form type and size,
// and the intent token before any effect; validation before any call; the outcomes as fixed
// words after a 303; nothing echoed or logged; and the first-visit redirect.
import type { OwnerPasswordResult, PageOwner } from "@cfo/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import { MAX_FORM_BYTES } from "../../src/pages/http.ts";
import {
  bindingsPasswordBackend,
  type FirstVisitMemo,
  firstVisitRedirect,
  PASSWORD_PATH,
} from "../../src/pages/password.ts";
import { routePlatform } from "../../src/pages/router.ts";
import { FakeOmnigentServer } from "../support/fake-omnigent-server.ts";

const ORIGIN = "https://omnigent.example.test";
const OWNER: PageOwner = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
/** Built at run time: no literal canary in a source file (scripts/canary-scan.ts). */
const PASSWORD = `${["CFO", "CANARY", ""].join("_")}PAGEPASSWORD0001`;

let server: FakeOmnigentServer;
let logged: Readonly<Record<string, string>>[];

beforeEach(() => {
  server = new FakeOmnigentServer();
  logged = [];
});

function admitted(path: string, init: RequestInit = {}): Admitted {
  return {
    ok: true,
    request: new Request(`${ORIGIN}${path}`, init),
    origin: ORIGIN,
    identity: { sub: OWNER.sub, sessionId: OWNER.sessionId, issuedAt: 1, expiresAt: 2 },
  };
}

function visit(path: string, init: RequestInit = {}): Promise<Response> {
  return routePlatform(admitted(path, init), {} as WebEnv, {
    password: server,
    assets: async () => ({}),
    log: (fields) => logged.push(fields),
  });
}

function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
  return visit(PASSWORD_PATH, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

const good = () => ({
  intent: server.intentToken,
  username: "owner",
  password: PASSWORD,
  confirm: PASSWORD,
});

const sets = () => server.passwordCalls.filter((c) => c.action === "set");

function expectPageHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("GET /platform/password", () => {
  it("asks the owner to choose a password, once, for the browser's password manager", async () => {
    const response = await visit(PASSWORD_PATH);
    expect(response.status).toBe(200);
    expectPageHeaders(response);
    const html = await response.text();
    expect(html).toContain("<h1>Choose your Omnigent password</h1>");
    expect(html).toContain(`name="intent" value="${server.intentToken}"`);
    expect(html).toContain('autocomplete="username" value="owner" readonly');
    expect(html.match(/autocomplete="new-password"/g)).toHaveLength(2);
    expect(html).toContain('minlength="8"');
    expect(html).toContain('maxlength="128"');
    expect(html).toContain(`action="${PASSWORD_PATH}"`);
    expect(html).not.toContain("<script");
    expect(server.passwordCalls).toEqual([{ action: "state", sessionId: OWNER.sessionId }]);
  });

  it("is the reset once the owner has a password, and says it signs out everywhere", async () => {
    server.passwordState = { state: "chosen", username: "owner" };
    const html = await (await visit(PASSWORD_PATH)).text();
    expect(html).toContain("<h1>Reset your Omnigent password</h1>");
    expect(html).toContain("signs you out of Omnigent everywhere");
    expect(html).toContain("Reset my password");
  });

  it("offers no form when the installation names no owner", async () => {
    server.passwordState = { state: "unchosen", username: null };
    const html = await (await visit(PASSWORD_PATH)).text();
    expect(html).toContain('data-notice="not_configured"');
    expect(html).not.toContain("<form");
  });

  it("shows the done page with the way to sign in, only to the session that just set it", async () => {
    // A URL's word alone shows the form, never "done" (Codex r1-3).
    for (const passwordState of [
      { state: "unchosen" as const, username: "owner" },
      { state: "chosen" as const, username: "owner" },
      { state: "chosen" as const, username: "owner", justSet: false },
    ]) {
      server.passwordState = passwordState;
      const html = await (await visit(`${PASSWORD_PATH}?result=done`)).text();
      expect(html).not.toContain("is set");
      expect(html).not.toContain("data-notice=");
      expect(html).toContain("<form");
    }
    server.passwordState = { state: "chosen", username: "owner", justSet: true };
    const response = await visit(`${PASSWORD_PATH}?result=done`);
    expectPageHeaders(response);
    const html = await response.text();
    expect(html).toContain("Your Omnigent password is set");
    expect(html).toContain('href="/" data-sign-in');
    expect(html).toContain("<strong>owner</strong>");
  });

  it.each(["unconfirmed", "unavailable", "rate_limited", "intent", "not_configured", "failed"])(
    "shows the %s outcome above the form",
    async (word) => {
      const html = await (await visit(`${PASSWORD_PATH}?result=${word}`)).text();
      expect(html).toContain(`data-notice="${word}"`);
      expect(html).toContain("<form");
    },
  );

  it("never reflects an unknown result word", async () => {
    const html = await (
      await visit(`${PASSWORD_PATH}?result=${encodeURIComponent("<script>alert(1)</script>")}`)
    ).text();
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("data-notice=");
  });

  it("escapes the username", async () => {
    server.passwordState = { state: "unchosen", username: '"><img src=x>' };
    const html = await (await visit(PASSWORD_PATH)).text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img src=x&gt;");
  });

  it("answers 503 when OmnigentServer cannot be asked, and HEAD with no body", async () => {
    server.failNextPasswordCall = true;
    const down = await visit(PASSWORD_PATH);
    expect(down.status).toBe(503);
    expectPageHeaders(down);
    expect(logged).toContainEqual({ event: "password_page_unavailable", error: "TypeError" });
    const head = await visit(PASSWORD_PATH, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("allows only GET, HEAD and POST", async () => {
    const response = await visit(PASSWORD_PATH, { method: "PUT" });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST");
    expect((await visit(`${PASSWORD_PATH}/x`)).status).toBe(404);
  });
});

describe("POST /platform/password", () => {
  it("sets the password and answers a 303 to its outcome", async () => {
    const response = await post(good());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PASSWORD_PATH}?result=done`);
    expectPageHeaders(response);
    expect(sets()).toEqual([
      { action: "set", sessionId: OWNER.sessionId, passwordLength: PASSWORD.length },
    ]);
    expect(logged).toContainEqual({ event: "password_change", outcome: "done" });
  });

  it.each<[string, OwnerPasswordResult, string]>([
    ["unconfirmed", { action: "set", outcome: "unconfirmed" }, "unconfirmed"],
    [
      "unavailable",
      { action: "set", outcome: "unavailable", retryAfterSeconds: 30 },
      "unavailable",
    ],
    [
      "rate limited",
      { action: "set", outcome: "refused", reason: "rate_limited", retryAfterSeconds: 60 },
      "rate_limited",
    ],
    [
      "not configured",
      { action: "set", outcome: "refused", reason: "not_configured" },
      "not_configured",
    ],
    ["failed", { action: "set", outcome: "failed" }, "failed"],
  ])("sends %s to its outcome word", async (_, outcome, word) => {
    server.setOutcomes.push(outcome);
    const response = await post(good());
    expect(response.headers.get("location")).toBe(`${PASSWORD_PATH}?result=${word}`);
  });

  it("sends another session's intent token to the intent outcome", async () => {
    const response = await post({ ...good(), intent: "0".repeat(64) });
    expect(response.headers.get("location")).toBe(`${PASSWORD_PATH}?result=intent`);
  });

  it("says try again when OmnigentServer cannot be reached", async () => {
    // The state read for the page is not needed: the token comes from the form.
    server.failNextPasswordCall = true;
    const response = await post(good());
    expect(response.headers.get("location")).toBe(`${PASSWORD_PATH}?result=unavailable`);
    expect(logged).toContainEqual({ event: "password_change_error", error: "TypeError" });
  });

  it.each<[string, Record<string, string>]>([
    ["no origin", { origin: "" }],
    ["a null origin", { origin: "null" }],
    ["a foreign origin", { origin: "https://evil.example" }],
    ["a sibling origin", { origin: "https://other.example.test" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["another content type", { "content-type": "application/json" }],
  ])("refuses %s before any call", async (_, headers) => {
    const init = { ...headers };
    if (init.origin === "") delete init.origin;
    const response = await visit(PASSWORD_PATH, {
      method: "POST",
      headers: Object.fromEntries(
        Object.entries({
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
          ...init,
        }).filter(([name]) => !(name === "origin" && headers.origin === "")),
      ),
      body: new URLSearchParams(good()).toString(),
    });
    expect(response.status).toBe(403);
    expectPageHeaders(response);
    expect(server.passwordCalls).toEqual([]);
    expect(logged[0]?.event).toBe("page_change_refused");
  });

  it("refuses a body over the bound and a repeated field before any call", async () => {
    const big = await post({ ...good(), pad: "x".repeat(MAX_FORM_BYTES) });
    expect(big.status).toBe(403);
    const repeated = await visit(PASSWORD_PATH, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: `${new URLSearchParams(good()).toString()}&password=other-password-1`,
    });
    expect(repeated.status).toBe(403);
    expect(server.passwordCalls).toEqual([]);
  });

  it("refuses a malformed intent token without a call", async () => {
    const response = await post({ ...good(), intent: "not-a-token" });
    expect(response.headers.get("location")).toBe(`${PASSWORD_PATH}?result=intent`);
    expect(server.passwordCalls).toEqual([]);
  });

  it.each<[string, Record<string, string>, string]>([
    ["differing passwords", { confirm: `${PASSWORD}x` }, "The two passwords differ"],
    ["a short one", { password: "short", confirm: "short" }, "at least 8 characters"],
    ["four keys", { password: "🔑🔑🔑🔑", confirm: "🔑🔑🔑🔑" }, "at least 8 characters"],
    ["a long one", { password: "a".repeat(129), confirm: "a".repeat(129) }, "at most 128"],
    ["no password", { password: "", confirm: "" }, "at least 8 characters"],
  ])("shows the form again for %s, echoing nothing", async (_, change, text) => {
    const response = await post({ ...good(), ...change });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain(text);
    expect(html).toContain("<form");
    expect(html).not.toContain(PASSWORD);
    expect(html).not.toContain("short");
    expect(sets()).toEqual([]);
  });

  it("shows the unavailable page when the form cannot be shown again", async () => {
    server.failNextPasswordCall = true;
    const response = await post({ ...good(), confirm: "different-one" });
    expect(response.status).toBe(503);
  });

  it("logs no password, whatever happens", async () => {
    await post(good());
    await post({ ...good(), confirm: "x" });
    await post({ ...good(), intent: "0".repeat(64) });
    server.failNextPasswordCall = true;
    await post(good());
    await post(good(), { origin: "https://evil.example" });
    expect(JSON.stringify(logged)).not.toContain(PASSWORD);
  });
});

describe("the first visit", () => {
  const navigation = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };

  it("sends a page load to the password page while the owner has none", async () => {
    const memo: FirstVisitMemo = { chosen: false };
    const response = await firstVisitRedirect(
      admitted("/", { headers: navigation }),
      server,
      memo,
      (fields) => logged.push(fields),
    );
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(PASSWORD_PATH);
    expect(memo.chosen).toBe(false);
    const document = await firstVisitRedirect(
      admitted("/sessions/s1", { headers: { "sec-fetch-dest": "document" } }),
      server,
      memo,
      () => undefined,
    );
    expect(document?.status).toBe(303);
  });

  it("stops asking once the owner has one", async () => {
    server.passwordState = { state: "chosen", username: "owner" };
    const memo: FirstVisitMemo = { chosen: false };
    const log = () => undefined;
    expect(
      await firstVisitRedirect(admitted("/", { headers: navigation }), server, memo, log),
    ).toBeNull();
    expect(memo.chosen).toBe(true);
    const calls = server.passwordCalls.length;
    expect(
      await firstVisitRedirect(admitted("/", { headers: navigation }), server, memo, log),
    ).toBeNull();
    expect(server.passwordCalls.length).toBe(calls);
  });

  it.each<[string, RequestInit]>([
    ["an API call", { headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } }],
    ["a request without fetch metadata", {}],
    ["a POST", { method: "POST", headers: navigation, body: "{}" }],
    ["a WebSocket", { headers: { ...navigation, upgrade: "websocket" } }],
  ])("never touches %s", async (_, init) => {
    const memo: FirstVisitMemo = { chosen: false };
    expect(
      await firstVisitRedirect(admitted("/v1/info", init), server, memo, () => undefined),
    ).toBeNull();
    expect(server.passwordCalls).toEqual([]);
  });

  it("forwards as usual when OmnigentServer cannot say", async () => {
    server.failNextPasswordCall = true;
    const memo: FirstVisitMemo = { chosen: false };
    const response = await firstVisitRedirect(
      admitted("/", { headers: navigation }),
      server,
      memo,
      (fields) => logged.push(fields),
    );
    expect(response).toBeNull();
    expect(memo.chosen).toBe(false);
    expect(logged).toEqual([{ event: "first_visit_unknown", error: "TypeError" }]);
  });
});

describe("unusual answers and forms", () => {
  it("treats an answer of the wrong kind as no answer", async () => {
    const odd = {
      ownerPassword: async (): Promise<OwnerPasswordResult> => ({
        action: "set",
        outcome: "done",
      }),
    };
    const page = await routePlatform(admitted(PASSWORD_PATH), {} as WebEnv, {
      password: odd,
      assets: async () => ({}),
      log: (fields) => logged.push(fields),
    });
    expect(page.status).toBe(503);
    expect(logged).toContainEqual({ event: "password_page_unavailable", error: "Error" });
    const stateForSet = {
      ownerPassword: async (): Promise<OwnerPasswordResult> => ({
        action: "state",
        state: "chosen",
        username: "owner",
        intentToken: "7".repeat(64),
      }),
    };
    const change = await routePlatform(
      admitted(PASSWORD_PATH, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(good()).toString(),
      }),
      {} as WebEnv,
      { password: stateForSet, assets: async () => ({}), log: () => undefined },
    );
    expect(change.headers.get("location")).toBe(`${PASSWORD_PATH}?result=failed`);
  });

  it("names a thrown non-error by its type only", async () => {
    const throwing = {
      ownerPassword: async (): Promise<OwnerPasswordResult> => {
        throw "a string";
      },
    };
    const memo: FirstVisitMemo = { chosen: false };
    await firstVisitRedirect(
      admitted("/", { headers: { "sec-fetch-mode": "navigate" } }),
      throwing,
      memo,
      (fields) => logged.push(fields),
    );
    expect(logged).toEqual([{ event: "first_visit_unknown", error: "string" }]);
  });

  it("shows the done page without a username when the installation names none", async () => {
    server.passwordState = { state: "chosen", username: null, justSet: true };
    const html = await (await visit(`${PASSWORD_PATH}?result=done`)).text();
    expect(html).toContain("Sign in to Omnigent with your new password.");
  });

  it.each<[string, Record<string, string>, number | string]>([
    ["no intent", { password: PASSWORD, confirm: PASSWORD }, `${PASSWORD_PATH}?result=intent`],
    ["no password", { intent: "7".repeat(64), confirm: PASSWORD }, 400],
    ["no confirmation", { intent: "7".repeat(64), password: PASSWORD }, 400],
  ])("handles a form with %s", async (_, fields, expected) => {
    const response = await post(fields);
    if (typeof expected === "number") expect(response.status).toBe(expected);
    else expect(response.headers.get("location")).toBe(expected);
    expect(sets()).toEqual([]);
  });

  it("never treats an inherited property as an outcome word", async () => {
    const html = await (await visit(`${PASSWORD_PATH}?result=toString`)).text();
    expect(html).not.toContain("data-notice=");
  });
});

describe("the binding", () => {
  it("calls the one OmnigentServer object, and refuses an answer outside the contract", async () => {
    const names: string[] = [];
    const backend = bindingsPasswordBackend({
      OMNIGENT: {
        getByName(name: string) {
          names.push(name);
          return server;
        },
      },
    });
    const state = await backend.ownerPassword({
      action: "state",
      interfaceVersion: 1,
      owner: OWNER,
    });
    expect(state).toMatchObject({ action: "state", state: "unchosen" });
    expect(names).toEqual(["omnigent-server"]);
    const broken = bindingsPasswordBackend({
      OMNIGENT: {
        getByName: () => ({ ownerPassword: async () => ({ action: "set", outcome: "maybe" }) }),
      },
    });
    await expect(
      broken.ownerPassword({ action: "state", interfaceVersion: 1, owner: OWNER }),
    ).rejects.toThrow();
  });
});
