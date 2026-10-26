// The platform pages' routes (WP3.5, `pages/router.ts` and the pages): framing protection on every
// answer (RC-07's G3 part); GET never changes state and a control URL shows a confirmation (P1);
// exact origin and CSRF checks before any effect; the terminal's capability kept out of URLs; the
// cloud-computers page's contents; untrusted names rendered as text.
import type {
  ComputerId,
  OutageRecord,
  PageFrontCall,
  PageFrontResult,
  PageOwner,
  PagesCall,
  PagesResult,
  ReplicationHealth,
} from "@cfo/contracts";
import { describe, expect, it } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import type { PagesBackend, StateResult } from "../../src/pages/backend.ts";
import { MAX_FORM_BYTES } from "../../src/pages/http.ts";
import { isPlatformPath, routePlatform } from "../../src/pages/router.ts";
import { platformError } from "../../src/shared/errors.ts";
import { NEVER_SIGNED_IN, NOW, PAGE_CMP, pageState } from "../support/page-states.ts";

const ORIGIN = "https://omnigent.example.test";
const OWNER: PageOwner = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const INTENT = "c3".repeat(32);
const OP = "op_01hzy4a7b8c9d0e1f2g3h4j5k6";
const OTHER = "cmp_01hzy3m8k6q4t2v9w7x5r0s1n4" as ComputerId;
const CAP = "Q2Fwz9-TerminalCapabilityCanary_00000000000";

class FakeBackend implements PagesBackend {
  states = new Map<string, StateResult | null>([
    [PAGE_CMP, { action: "state", computer: pageState(), intentToken: INTENT }],
  ]);
  names = new Map<string, string>([[PAGE_CMP, "managed-7f3c2a9e"]]);
  outageRecords: OutageRecord[] | null = [];
  health: ReplicationHealth | null = {
    state: "replicating",
    lastSyncAt: null,
    checkedAt: "2026-10-22T09:20:00.000Z",
  };
  readonly acts: { id: string; call: PagesCall | PageFrontCall }[] = [];
  readonly upgrades: Request[] = [];
  actResult: PagesResult | PageFrontResult | Error = { action: "restart", outcome: "accepted" };
  upgradeResult: Response = new Response(null, { status: 403 });
  failState = new Set<string>();

  async computers() {
    return [...this.names].map(([computerId, name]) => ({
      computerId: computerId as ComputerId,
      name,
    }));
  }
  async state(id: ComputerId) {
    if (this.failState.has(id)) throw platformError("unavailable", "down");
    return this.states.get(id) ?? null;
  }
  async act(id: ComputerId, call: PagesCall | PageFrontCall) {
    this.acts.push({ id, call });
    if (this.actResult instanceof Error) throw this.actResult;
    return this.actResult;
  }
  async upgrade(_id: ComputerId, request: Request) {
    this.upgrades.push(request);
    return this.upgradeResult;
  }
  async outages() {
    return this.outageRecords;
  }
  async replication() {
    return this.health;
  }
}

const ASSETS = {
  "pages.css": { body: "body{}", type: "text/css; charset=utf-8" },
  "setup-client.js": { body: "/* client */", type: "text/javascript; charset=utf-8" },
};

function setup() {
  const backend = new FakeBackend();
  const logs: Readonly<Record<string, string>>[] = [];
  const route = (path: string, init: RequestInit = {}) => {
    const admitted: Admitted = {
      ok: true,
      request: new Request(`${ORIGIN}${path}`, init),
      origin: ORIGIN,
      identity: { ...OWNER, issuedAt: 1, expiresAt: 2 },
    };
    return routePlatform(admitted, {} as WebEnv, {
      backend,
      assets: async () => ASSETS,
      now: () => NOW,
      log: (fields) => logs.push(fields),
    });
  };
  return { backend, route, logs };
}

const page = `/platform/computers/${PAGE_CMP}`;
const form = (
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): RequestInit => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(fields).toString(),
});
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

function expectFramingProtection(response: Response) {
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
}

describe("framing protection on every platform answer (RC-07's G3 part)", () => {
  it("is on pages, confirmations, JSON, assets, redirects and refusals alike", async () => {
    const { route, backend } = setup();
    backend.actResult = platformError("forbidden", "stale");
    const answers = await Promise.all([
      route("/platform"),
      route("/platform/computers"),
      route(page),
      route(`${page}/state`),
      route(`${page}/do/restart`),
      route(`${page}/do/restart`, form({ op: OP, intent: INTENT })),
      route(
        `${page}/do/restart`,
        form({ op: OP, intent: INTENT }, { origin: "https://evil.example" }),
      ),
      route(`${page}/do/nonsense`),
      route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "open" })),
      route(`${page}/terminal`, { headers: { upgrade: "websocket", origin: "null" } }),
      route(`${page}/terminal`),
      route("/platform/assets/pages.css"),
      route("/platform/assets/unknown.js"),
      route("/platform/nothing"),
      route(`/platform/computers/${OTHER}`),
      route("/platform/computers", { method: "DELETE" }),
    ]);
    for (const response of answers) expectFramingProtection(response);
    expect(answers.map((r) => r.status)).toEqual([
      303, 200, 200, 200, 200, 403, 403, 404, 403, 403, 405, 200, 404, 404, 404, 405,
    ]);
  });

  it("keeps the strict policy: scripts and styles from this origin only, no base or plugins", async () => {
    const { route } = setup();
    const csp = (await route("/platform/computers")).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'self'");
    const setupCsp = (await route(page)).headers.get("content-security-policy") ?? "";
    expect(setupCsp).toContain("style-src 'self' 'unsafe-inline'");
    expect(setupCsp).toContain("connect-src 'self' wss://omnigent.example.test");
    expect(setupCsp).not.toContain("script-src 'self' 'unsafe");
  });
});

describe("routes", () => {
  it("own every path under /platform, and nothing else", () => {
    expect(isPlatformPath("/platform")).toBe(true);
    expect(isPlatformPath("/platform/computers")).toBe(true);
    expect(isPlatformPath("/platformer")).toBe(false);
    expect(isPlatformPath("/v1/sessions")).toBe(false);
  });

  it("answer HEAD without a body, and refuse other methods", async () => {
    const { route } = setup();
    const head = await route("/platform/computers", { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);
    expect((await route("/platform/assets/pages.css", { method: "HEAD" })).status).toBe(200);
    for (const [path, method] of [
      ["/platform", "POST"],
      ["/platform/assets/pages.css", "POST"],
      [page, "POST"],
      [`${page}/state`, "PUT"],
      [`${page}/do/restart`, "PUT"],
    ] as const) {
      expect(
        (await route(path, { method, headers: { origin: ORIGIN } })).status,
        `${method} ${path}`,
      ).toBe(405);
    }
  });

  it("serve the pages' assets with their content types", async () => {
    const { route } = setup();
    const css = await route("/platform/assets/pages.css");
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("cache-control")).toBe("private, max-age=300");
    expect(await css.text()).toBe("body{}");
  });

  it("answer 404 for a malformed or unknown computer, and 503 when a page cannot be built", async () => {
    const { route, backend } = setup();
    expect((await route("/platform/computers/not-an-id")).status).toBe(404);
    expect((await route(`/platform/computers/${OTHER}/state`)).status).toBe(404);
    expect((await route(`${page}/whatever`)).status).toBe(404);
    backend.failState.add(PAGE_CMP);
    const failed = await route(page);
    expect(failed.status).toBe(503);
    expectFramingProtection(failed);
  });
});

describe("state changes (P1)", () => {
  it("a GET on a control URL shows a confirmation page and changes nothing", async () => {
    const { route, backend } = setup();
    for (const slug of ["restart", "sign-out", "set-size"]) {
      const response = await route(`${page}/do/${slug}`);
      const html = await response.text();
      expect(html).toContain(`data-confirm="${slug}"`);
      expect(html).toContain(`name="intent" value="${INTENT}"`);
      expect(html).toMatch(/name="op" value="op_[0-9a-hjkmnp-tv-z]{26}"/);
      expect(html).toContain("Opening this page changed nothing");
    }
    expect(await (await route(`${page}/do/restart`)).text()).toContain(
      "A restart ends work in progress",
    );
    expect(backend.acts).toEqual([]);
  });

  it("a confirmation page says when its action is not offered now", async () => {
    const { route } = setup();
    for (const slug of ["stop-without-saving", "remove", "resolve-removal", "record-revocation"]) {
      expect(await (await route(`${page}/do/${slug}`)).text()).toContain(
        'data-confirm="not-offered"',
      );
    }
    expect((await route(`/platform/computers/${OTHER}/do/restart`)).status).toBe(404);
  });

  it.each([
    ["no Origin", { origin: "" }],
    ["Origin null", { origin: "null" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a same-site sibling", { origin: "https://other.example.test" }],
    ["another scheme", { origin: "http://omnigent.example.test" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["same-site fetch metadata", { "sec-fetch-site": "same-site" }],
    ["a JSON body", { "content-type": "application/json" }],
    ["a multipart body", { "content-type": "multipart/form-data; boundary=x" }],
  ])("a POST with %s is refused before any effect", async (_name, headers) => {
    const { route, backend, logs } = setup();
    const init = form({ op: OP, intent: INTENT }, headers);
    if ((headers as Record<string, string>).origin === "")
      delete (init.headers as Record<string, string>).origin;
    const response = await route(`${page}/do/restart`, init);
    expect(response.status).toBe(403);
    expect(backend.acts).toEqual([]);
    expect(logs.at(-1)?.event).toBe("page_change_refused");
  });

  it("refuses oversized, repeated-field and malformed forms before any effect", async () => {
    const { route, backend } = setup();
    const big = { op: OP, intent: INTENT, pad: "x".repeat(MAX_FORM_BYTES) };
    expect((await route(`${page}/do/restart`, form(big))).status).toBe(403);
    const streamed = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`op=${OP}&intent=${INTENT}&pad=`));
        controller.enqueue(new Uint8Array(MAX_FORM_BYTES));
        controller.close();
      },
    });
    expect(
      (
        await route(`${page}/do/restart`, {
          ...form({}),
          body: streamed,
          duplex: "half",
        } as RequestInit)
      ).status,
    ).toBe(403);
    expect(
      (
        await route(
          `${page}/do/restart`,
          form({ op: OP, intent: INTENT, x: "1" }).body
            ? { ...form({}), body: `op=${OP}&op=${OP}&intent=${INTENT}` }
            : {},
        )
      ).status,
    ).toBe(403);
    expect((await route(`${page}/do/restart`, form({ op: "op_bad", intent: INTENT }))).status).toBe(
      403,
    );
    expect((await route(`${page}/do/restart`, form({ op: OP, intent: "nothex" }))).status).toBe(
      403,
    );
    expect(
      (await route(`${page}/do/set-size`, form({ op: OP, intent: INTENT, size: "huge" }))).status,
    ).toBe(400);
    expect(backend.acts).toEqual([]);
  });

  it("a good POST passes the owner and token to WorkspaceDO, then redirects", async () => {
    const { route, backend } = setup();
    const response = await route(
      `${page}/do/restart`,
      form({ op: OP, intent: INTENT }, { "sec-fetch-site": "same-origin" }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${page}?done=restart&outcome=accepted`);
    expect(backend.acts).toEqual([
      {
        id: PAGE_CMP,
        call: {
          action: "restart",
          interfaceVersion: 1,
          operationId: OP,
          owner: OWNER,
          intent: INTENT,
        },
      },
    ]);
    await route(`${page}/do/set-size`, form({ op: OP, intent: INTENT, size: "standard-3" }));
    expect(backend.acts.at(-1)?.call).toMatchObject({ action: "set_size", size: "standard-3" });
  });

  it.each([
    ["sign-out", "sign_out"],
    ["record-revocation", "record_revocation"],
    ["resolve-removal", "resolve_removal"],
    ["remove", "remove"],
    ["stop-without-saving", "stop_without_saving"],
  ])("%s calls %s", async (slug, action) => {
    const { route, backend } = setup();
    await route(`${page}/do/${slug}`, form({ op: OP, intent: INTENT }));
    expect(backend.acts.at(-1)?.call).toMatchObject({ action, owner: OWNER, intent: INTENT });
  });

  it("shows a refusal's reason after the redirect, and only known reasons", async () => {
    const { route, backend } = setup();
    backend.actResult = { action: "restart", outcome: "refused", reason: "busy" };
    const response = await route(`${page}/do/restart`, form({ op: OP, intent: INTENT }));
    expect(response.headers.get("location")).toBe(`${page}?done=restart&outcome=busy`);
    expect(await (await route(`${page}?done=restart&outcome=busy`)).text()).toContain(
      "Restart this computer: Something else is in progress",
    );
    const injected = await (await route(`${page}?done=restart&outcome=%3Cscript%3E`)).text();
    expect(injected).not.toContain("<script>");
    expect(injected).not.toContain('data-notice="flash"');
  });

  it.each([
    ["forbidden", 403, "This page is out of date"],
    ["not_found", 404, "There is no such computer"],
    ["unsupported_version", 503, "being updated"],
    ["at_capacity", 409, "All computers are busy"],
    ["internal", 503, "could not be reached"],
  ] as const)("maps WorkspaceDO's %s to %i", async (code, status, text) => {
    const { route, backend } = setup();
    backend.actResult = platformError(code, "x");
    const response = await route(`${page}/do/restart`, form({ op: OP, intent: INTENT }));
    expect(response.status).toBe(status);
    expect(await response.text()).toContain(text);
  });
});

describe("the cloud-computers page", () => {
  it("lists computers, a new one as needing setup, and links to Omnigent's add and delete", async () => {
    const { route, backend } = setup();
    backend.names.set(OTHER, "managed-new");
    backend.states.set(OTHER, {
      action: "state",
      computer: pageState({
        computerId: OTHER,
        hostName: "New one",
        setupCards: [...NEVER_SIGNED_IN],
      }),
      intentToken: INTENT,
    });
    const html = await (await route("/platform/computers")).text();
    expect(html).toContain(`data-computer="${PAGE_CMP}"`);
    const other = html.slice(html.indexOf(`data-computer="${OTHER}"`));
    expect(other.slice(0, other.indexOf("</article>"))).toContain("Needs setup");
    expect(html).toContain('href="/settings/computers" data-link="omnigent-add"');
    expect(html).toContain('href="/settings/computers" data-link="omnigent-delete"');
    expect(html).toContain(`href="${page}">Set up / manage`);
    expect(html).toContain("Last saved 09:14 UTC");
  });

  it("renders untrusted names as text only", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ hostName: '<img src=x onerror="alert(1)">' }),
      intentToken: INTENT,
    });
    for (const path of ["/platform/computers", page, `${page}/do/restart`]) {
      const html = await (await route(path)).text();
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    }
  });

  it("shows outage notices and the replication warning (FH-06, FH-15)", async () => {
    const { route, backend } = setup();
    backend.outageRecords = [
      {
        outageId: "out_01hzy4a7b8c9d0e1f2g3h4j5k6",
        installationId: "ins_01hs3f9q2m8z4w7k6t5r1n0ybc",
        startedAt: "2026-10-22T03:00:00.000Z",
        endedAt: "2026-10-22T03:12:00.000Z",
      } as unknown as OutageRecord,
    ];
    backend.health = { state: "lagging", lastSyncAt: null, checkedAt: "2026-10-22T09:20:00.000Z" };
    const html = await (await route("/platform/computers")).text();
    expect(html).toContain("Omnigent was unavailable from 03:00 UTC to 03:12 UTC");
    expect(html).toContain('data-notice="replication"');
    backend.outageRecords = null;
    backend.health = {
      state: "replicating",
      lastSyncAt: null,
      checkedAt: "2026-10-22T09:20:00.000Z",
    };
    const unread = await (await route("/platform/computers")).text();
    expect(unread).toContain("outage records could not be read");
    expect(unread).not.toContain('data-notice="replication"');
  });

  it("offers a restart with its warning and removal for a computer Omnigent no longer calls", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ noContact: true }),
      intentToken: INTENT,
    });
    const html = await (await route("/platform/computers")).text();
    expect(html).toContain("Not connected to Omnigent");
    expect(html).toContain(`href="${page}/do/restart">Restart (ends work in progress)`);
    expect(html).toContain(`href="${page}/do/remove">Remove`);
    expect(await (await route(`${page}/do/remove`)).text()).toContain('data-confirm="remove"');
  });

  it("lists unresolved removals with what each still needs, keeping their logins", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        lifecycle: "removal_pending",
        status: "stopped",
        removal: {
          state: "pending",
          signOut: "none",
          loginPossiblyLost: true,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    const html = await (await route("/platform/computers")).text();
    expect(html).toContain("Removals in progress");
    expect(html).toContain(
      "Still needs a sign-out on the computer and your record that you revoked its sessions",
    );
    expect(html).toContain("Its saved logins are kept until then.");
  });

  it("hides removed computers, and names one it could not read", async () => {
    const { route, backend } = setup();
    backend.names.set(OTHER, "managed-broken");
    backend.failState.add(OTHER);
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ lifecycle: "removed" }),
      intentToken: INTENT,
    });
    const html = await (await route("/platform/computers")).text();
    expect(html).toContain("No computers yet");
    expect(html).toContain("Could not be read now: managed-broken");
  });
});

describe("the setup page", () => {
  it("embeds the terminal with the paste hint, and the two cards with their commands", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ setupCards: [...NEVER_SIGNED_IN] }),
      intentToken: INTENT,
    });
    const html = await (await route(page)).text();
    expect(html).toContain('id="terminal-panel"');
    expect(html).toContain(`data-intent="${INTENT}"`);
    expect(html).toContain(`data-terminal-url="${page}/terminal"`);
    expect(html).toContain("Ctrl+Shift+V");
    expect(html).toContain("<code>claude auth login --claudeai</code>");
    expect(html).toContain("<code>codex login --device-auth</code>");
    expect(html).toContain('<script src="/platform/assets/setup-client.js" defer></script>');
    expect(html).not.toMatch(/<script>(?!<\/script>)/);
    expect(html).not.toContain("onclick");
  });

  it("disables the terminal while the computer is not running, and hides it during a removal", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ lifecycle: "asleep", status: "stopped" }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('id="terminal-open" disabled');
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        lifecycle: "removal_pending",
        status: "stopped",
        removal: {
          state: "pending",
          signOut: "none",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    const html = await (await route(page)).text();
    expect(html).not.toContain('id="terminal-panel"');
    expect(html).toContain('data-removal-step="pending"');
  });

  it("runs the sign-out rules before it links to Omnigent's deletion", async () => {
    const { route, backend } = setup();
    const signOutFirst = await (await route(page)).text();
    expect(signOutFirst).toContain('data-removal-step="sign_out"');
    expect(signOutFirst).not.toContain('data-link="omnigent-delete"');
    expect(signOutFirst).toContain("the CLIs do not report a failed revocation");
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        removal: {
          state: "none",
          signOut: "tombstoned",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    const signedOut = await (await route(page)).text();
    expect(signedOut).toContain('data-removal-step="delete"');
    expect(signedOut).toContain('data-link="omnigent-delete"');
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ lifecycle: "asleep", status: "stopped" }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('data-removal-step="delete_then_sign_out"');
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        removal: {
          state: "none",
          signOut: "requested",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('data-removal-step="signing_out"');
  });

  it("offers 'Stop without saving' after three refused sleeps", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ refusedSleeps: 3 }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('data-action="stop-without-saving"');
    const confirm = await (await route(`${page}/do/stop-without-saving`)).text();
    expect(confirm).toContain("without saving its files");
    expect(confirm).toContain("Its logins are still saved first");
  });

  it("serves its live state as JSON, with the card markup and a fresh intent token", async () => {
    const { route } = setup();
    const body = (await (await route(`${page}/state`)).json()) as {
      intent: string;
      cards: { provider: string; html: string }[];
      running: boolean;
    };
    expect(body.intent).toBe(INTENT);
    expect(body.running).toBe(true);
    expect(body.cards.map((c) => c.provider)).toEqual(["claude", "codex"]);
    expect(body.cards[0]?.html).toContain('data-card="claude"');
  });

  it("answers 404 for a computer that does not exist", async () => {
    const { route } = setup();
    expect((await route(`/platform/computers/${OTHER}`)).status).toBe(404);
  });
});

describe("the terminal's endpoints", () => {
  it("open, reconnect and close through guarded JSON POSTs", async () => {
    const { route, backend } = setup();
    backend.actResult = {
      action: "open_terminal",
      outcome: "accepted",
      capability: CAP,
      window: 2,
      generation: 7,
      until: "2026-10-22T09:50:00.000Z",
      presentBy: "2026-10-22T09:21:00.000Z",
    };
    const opened = await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "open" }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ capability: CAP });
    await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "reconnect", window: 2 }));
    await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "close" }));
    expect(backend.acts.map((a) => a.call)).toEqual([
      {
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP,
        owner: OWNER,
        intent: INTENT,
        window: null,
      },
      {
        action: "open_terminal",
        interfaceVersion: 1,
        operationId: OP,
        owner: OWNER,
        intent: INTENT,
        window: 2,
      },
      {
        action: "close_terminal",
        interfaceVersion: 1,
        operationId: OP,
        owner: OWNER,
        intent: INTENT,
      },
    ]);
  });

  it("refuse a foreign origin, a form body, a bad mode and a bad window", async () => {
    const { route, backend } = setup();
    expect(
      (
        await route(
          `${page}/terminal`,
          json({ op: OP, intent: INTENT, mode: "open" }, { origin: "https://evil.example" }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await route(`${page}/terminal`, form({ op: OP, intent: INTENT, mode: "open" }))).status,
    ).toBe(403);
    expect(
      (await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "explode" }))).status,
    ).toBe(400);
    expect(
      (
        await route(
          `${page}/terminal`,
          json({ op: OP, intent: INTENT, mode: "reconnect", window: "0" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: "reconnect" }))).status,
    ).toBe(400);
    expect((await route(`${page}/terminal`, json({ op: OP, mode: "open" }))).status).toBe(403);
    expect((await route(`${page}/terminal`, json([1, 2]))).status).toBe(403);
    expect(
      (await route(`${page}/terminal`, json({ op: OP, intent: INTENT, mode: { nested: true } })))
        .status,
    ).toBe(403);
    expect((await route(`${page}/terminal`, { ...json({}), body: "{not json" })).status).toBe(403);
    expect(backend.acts).toEqual([]);
  });

  it("report WorkspaceDO's error code", async () => {
    const { route, backend } = setup();
    backend.actResult = platformError("forbidden", "stale");
    const response = await route(
      `${page}/terminal`,
      json({ op: OP, intent: INTENT, mode: "open" }),
    );
    expect([response.status, await response.json()]).toEqual([
      403,
      { error: { code: "forbidden" } },
    ]);
  });

  const upgrade = (headers: Record<string, string>) => ({
    headers: {
      upgrade: "websocket",
      origin: ORIGIN,
      "sec-websocket-protocol": `tty, cfo-capability.${CAP}`,
      ...headers,
    },
  });

  it("hand the upgrade to WorkspaceDO as a fresh request: the owner and capability, no browser headers", async () => {
    const { route, backend } = setup();
    const bridged = { status: 101 } as Response;
    backend.upgradeResult = bridged;
    const response = await route(
      `${page}/terminal`,
      upgrade({ cookie: "__Host-session=s", "x-cfo-terminal": "{}", authorization: "Bearer x" }),
    );
    expect(response).toBe(bridged);
    const [inner] = backend.upgrades;
    expect([...(inner?.headers.keys() ?? [])].sort()).toEqual([
      "sec-websocket-protocol",
      "upgrade",
      "x-cfo-terminal",
    ]);
    expect(inner?.headers.get("sec-websocket-protocol")).toBe("tty");
    expect(JSON.parse(inner?.headers.get("x-cfo-terminal") ?? "")).toEqual({
      interfaceVersion: 1,
      computerId: PAGE_CMP,
      owner: OWNER,
      capability: CAP,
    });
    expect(inner?.url).not.toContain(CAP);
  });

  it.each([
    ["no Origin", { origin: "" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["Origin null", { origin: "null" }],
    ["cross-site fetch metadata", { "sec-fetch-site": "cross-site" }],
    ["no capability", { "sec-websocket-protocol": "tty" }],
    ["no tty", { "sec-websocket-protocol": `cfo-capability.${CAP}` }],
    [
      "two capabilities",
      { "sec-websocket-protocol": `tty, cfo-capability.${CAP}, cfo-capability.${CAP}` },
    ],
    ["an extra subprotocol", { "sec-websocket-protocol": `tty, cfo-capability.${CAP}, chat` }],
    ["a malformed capability", { "sec-websocket-protocol": "tty, cfo-capability.short" }],
  ])("refuse an upgrade with %s before WorkspaceDO", async (_name, headers) => {
    const { route, backend } = setup();
    const init = upgrade(headers);
    if ((headers as Record<string, string>).origin === "")
      delete (init.headers as Record<string, string>).origin;
    expect((await route(`${page}/terminal`, init)).status).toBe(403);
    expect(backend.upgrades).toEqual([]);
  });

  it("refuse when WorkspaceDO refuses or cannot be reached", async () => {
    const { route, backend, logs } = setup();
    expect((await route(`${page}/terminal`, upgrade({}))).status).toBe(403);
    expect(logs.at(-1)).toMatchObject({ event: "terminal_upgrade_refused", reason: "status_403" });
    backend.upgrade = async () => {
      throw platformError("unavailable", "down");
    };
    expect((await route(`${page}/terminal`, upgrade({}))).status).toBe(403);
    expect(logs.at(-1)).toMatchObject({ reason: "error_unavailable" });
    expect(JSON.stringify(logs)).not.toContain(CAP);
  });
});

describe("edges", () => {
  it("logs to the console by path, without the query string, when no logger is given", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      const backend = new FakeBackend();
      await routePlatform(
        {
          ok: true,
          request: new Request(
            `${ORIGIN}${page}/do/restart?secret=1`,
            form({ op: OP, intent: INTENT }, { origin: "https://evil.example" }),
          ),
          origin: ORIGIN,
          identity: { ...OWNER, issuedAt: 1, expiresAt: 2 },
        },
        {} as WebEnv,
        { backend, assets: async () => ASSETS, now: () => NOW },
      );
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      event: "page_change_refused",
      reason: "foreign_origin",
      action: "restart",
      path: `${page}/do/restart`,
    });
  });

  it("confirms the remaining actions with their own explanations", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        lifecycle: "removal_pending",
        status: "stopped",
        removal: {
          state: "pending",
          signOut: "verified",
          loginPossiblyLost: true,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    expect(await (await route(`${page}/do/record-revocation`)).text()).toContain(
      "Sign this computer's sessions out at the providers first",
    );
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        lifecycle: "removal_pending",
        status: "stopped",
        removal: {
          state: "pending",
          signOut: "verified",
          loginPossiblyLost: false,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    expect(await (await route(`${page}/do/resolve-removal`)).text()).toContain(
      "This cannot be undone",
    );
    const html = await (await route(page)).text();
    expect(html).toContain("Finish the removal");
    expect(await (await route("/platform/computers")).text()).toContain("Ready to finish.");
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ refusedSleeps: 4, lastSavedAt: null }),
      intentToken: INTENT,
    });
    expect(await (await route(`${page}/do/stop-without-saving`)).text()).toContain(
      "since it was added",
    );
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState(),
      intentToken: undefined,
    } as never);
    expect(await (await route(`${page}/do/restart`)).text()).toContain(
      'data-confirm="not-offered"',
    );
  });

  it("shows a pending removal's revocation step on the computer's page, and removal for no contact", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        lifecycle: "removal_pending",
        status: "stopped",
        removal: {
          state: "pending",
          signOut: "none",
          loginPossiblyLost: true,
          revocationRecorded: false,
        },
      }),
      intentToken: INTENT,
    });
    const pending = await (await route(page)).text();
    expect(pending).toContain("record that you did");
    expect(pending).toContain("starts the computer once for the CLIs' logouts");
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ noContact: true }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain(
      `href="${page}/do/remove">Remove this computer`,
    );
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({ lifecycle: "removed" }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('data-removal-step="resolved"');
  });

  it("marks an open terminal window on the page, and serves state without a token", async () => {
    const { route, backend } = setup();
    backend.states.set(PAGE_CMP, {
      action: "state",
      computer: pageState({
        terminal: {
          window: 4,
          open: true,
          generation: 7,
          until: "2026-10-22T09:50:00.000Z",
          streams: 1,
        },
      }),
      intentToken: INTENT,
    });
    expect(await (await route(page)).text()).toContain('data-window="4"');
    backend.states.set(PAGE_CMP, { action: "state", computer: pageState() } as never);
    expect(
      ((await (await route(`${page}/state`)).json()) as { intent: unknown }).intent,
    ).toBeNull();
  });

  it("refuses a form without its token or with a failure WorkspaceDO did not name", async () => {
    const { route, backend } = setup();
    expect((await route(`${page}/do/restart`, form({ op: OP }))).status).toBe(403);
    backend.actResult = new Error("Network connection lost.");
    expect((await route(`${page}/do/restart`, form({ op: OP, intent: INTENT }))).status).toBe(503);
    const terminal = await route(
      `${page}/terminal`,
      json({ op: OP, intent: INTENT, mode: "open" }),
    );
    expect([terminal.status, await terminal.json()]).toEqual([
      503,
      { error: { code: "unavailable" } },
    ]);
  });

  it("shows an accepted change after the redirect", async () => {
    const { route } = setup();
    const html = await (await route(`${page}?done=set-size&outcome=accepted`)).text();
    expect(html).toContain('data-notice="flash"');
    expect(html).toContain("Change the size: Done.");
  });

  it("refuses an upgrade by another method, without subprotocols, or when WorkspaceDO throws", async () => {
    const { route, backend, logs } = setup();
    const post = await route(`${page}/terminal`, {
      method: "POST",
      headers: { upgrade: "websocket", origin: ORIGIN },
    });
    expect(post.status).toBe(403);
    expect(logs.at(-1)).toMatchObject({ reason: "method" });
    expect(
      (await route(`${page}/terminal`, { headers: { upgrade: "websocket", origin: ORIGIN } }))
        .status,
    ).toBe(403);
    backend.upgrade = async () => {
      throw new Error("no code");
    };
    await route(`${page}/terminal`, {
      headers: {
        upgrade: "websocket",
        origin: ORIGIN,
        "sec-websocket-protocol": `tty, cfo-capability.${CAP}`,
      },
    });
    expect(logs.at(-1)).toMatchObject({ reason: "error_unknown" });
  });
});
