// The GitHub setup page (WP3.36, `pages/github.ts` through `pages/router.ts`): the GitHub App's
// setup URL. GET and HEAD only, the pages' security headers, a 303 to Omnigent's Integrations
// page only once a server started with the App's settings reports GitHub linking on, a calm
// self-reloading wait otherwise, and after a bounded wait what is wrong, in plain words. GitHub's
// query values are ignored. Also the pure reading of Omnigent's `/v1/info` (server/github-linking.ts).
import type { GitHubSetupResult, PageOwner } from "@cfo/contracts";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import type { WebEnv } from "../../src/env.ts";
import type { Admitted } from "../../src/ingress/index.ts";
import {
  bindingsGitHubSetupBackend,
  GITHUB_SETUP_PATH,
  GITHUB_SETUP_REFRESH_S,
  GITHUB_SETUP_WAIT_MS,
  type GitHubSetupView,
  githubSetupView,
  INTEGRATIONS_PATH,
  PROBLEMS,
  waitStart,
} from "../../src/pages/github.ts";
import { layout } from "../../src/pages/html.ts";
import { routePlatform } from "../../src/pages/router.ts";
import {
  GITHUB_APP_CLIENT_ID_ENV,
  githubAppConfigured,
  githubAppTag,
  githubAppTagOf,
  githubLinkingOf,
} from "../../src/server/github-linking.ts";
import { FakeOmnigentServer } from "../support/fake-omnigent-server.ts";

const ORIGIN = "https://omnigent.example.test";
const OWNER: PageOwner = { sub: "owner-sub-canary", sessionId: "ab".repeat(32) };
const NOW = Date.UTC(2026, 9, 29, 18, 40, 0);

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

function visit(path: string, init: RequestInit = {}, now = NOW): Promise<Response> {
  return routePlatform(admitted(path, init), {} as WebEnv, {
    github: server,
    assets: async () => ({}),
    now: () => now,
    log: (fields) => logged.push(fields),
  });
}

const state = (over: Partial<GitHubSetupResult> = {}): GitHubSetupResult => ({
  configured: true,
  applied: true,
  server: "answering",
  linking: "on",
  ...over,
});

function expectPageHeaders(response: Response): void {
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("GET /platform/github", () => {
  it("opens Omnigent's Integrations page once GitHub linking is on, whatever GitHub appended", async () => {
    const response = await visit(`${GITHUB_SETUP_PATH}?installation_id=1&setup_action=install`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(INTEGRATIONS_PATH);
    expectPageHeaders(response);
    expect(server.githubSetupCalls).toBe(1);
    expect(logged).toEqual([{ event: "github_setup", view: "ready" }]);
  });

  it("waits calmly, reloading itself with the time of the first load, and carries no script", async () => {
    server.githubSetupState = state({ applied: false, linking: "off" });
    const response = await visit(`${GITHUB_SETUP_PATH}?installation_id=1&setup_action=install`);
    expect(response.status).toBe(200);
    expectPageHeaders(response);
    const html = await response.text();
    expect(html).toContain("<h1>Finishing GitHub setup…</h1>");
    expect(html).toContain('data-step="restarting"');
    expect(html).toContain("Connect GitHub");
    expect(html).toContain(
      `<meta http-equiv="refresh" content="${GITHUB_SETUP_REFRESH_S};url=${GITHUB_SETUP_PATH}?since=${NOW}">`,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("installation_id");
    expect(html).toContain("in about 15 minutes");
    // Later loads keep the first load's time.
    const later = await (
      await visit(`${GITHUB_SETUP_PATH}?since=${NOW}`, {}, NOW + 14 * 60_000)
    ).text();
    expect(later).toContain(`url=${GITHUB_SETUP_PATH}?since=${NOW}"`);
    expect(later).toContain("in about 1 minute,");
    expect(logged).toEqual([]);
  });

  it("names a held or recovering server at once, and keeps checking until the wait ends", async () => {
    for (const server_ of ["held", "recovery"] as const) {
      server.githubSetupState = state({ server: server_, linking: "unknown" });
      const html = await (await visit(GITHUB_SETUP_PATH)).text();
      expect(html).toContain(`data-notice="${server_}"`);
      expect(html).toContain('http-equiv="refresh"');
      const after = await (
        await visit(`${GITHUB_SETUP_PATH}?since=${NOW}`, {}, NOW + GITHUB_SETUP_WAIT_MS)
      ).text();
      expect(after).toContain(`data-notice="${server_}"`);
      expect(after).not.toContain('http-equiv="refresh"');
    }
  });

  it("after the wait, says what is wrong and offers to check again, never Integrations", async () => {
    const cases: [GitHubSetupResult, string][] = [
      [state({ configured: false, linking: "off" }), "not_configured"],
      [state({ server: "starting", linking: "unknown" }), "not_answering"],
      [state({ applied: false, linking: "off" }), "not_restarted"],
      [state({ linking: "off" }), "off"],
      [state({ linking: "unknown" }), "unknown"],
    ];
    for (const [answer, problem] of cases) {
      server.githubSetupState = answer;
      const response = await visit(
        `${GITHUB_SETUP_PATH}?since=${NOW - GITHUB_SETUP_WAIT_MS}`,
        {},
        NOW,
      );
      expect(response.status, problem).toBe(200);
      const html = await response.text();
      expect(html).toContain("<h1>GitHub setup is not finished</h1>");
      expect(html).toContain(`data-notice="${problem}"`);
      expect(html).toContain(`href="${GITHUB_SETUP_PATH}" data-check-again`);
      expect(html).not.toContain('http-equiv="refresh"');
      expect(html).not.toContain(INTEGRATIONS_PATH);
      expect(logged.at(-1)).toEqual({ event: "github_setup", view: "stopped", problem });
    }
  });

  it("keeps checking when OmnigentServer cannot be asked, then says so", async () => {
    server.failNextGitHubSetupCall = true;
    const html = await (await visit(GITHUB_SETUP_PATH)).text();
    expect(html).toContain('data-step="switching"');
    expect(logged).toEqual([{ event: "github_setup_unavailable", error: "TypeError" }]);
    server.failNextGitHubSetupCall = true;
    const after = await (
      await visit(`${GITHUB_SETUP_PATH}?since=${NOW - GITHUB_SETUP_WAIT_MS}`)
    ).text();
    expect(after).toContain('data-notice="unreachable"');
  });

  it("answers HEAD without a body, and refuses every other method", async () => {
    const head = await visit(GITHUB_SETUP_PATH, { method: "HEAD" });
    expect(head.status).toBe(303);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await visit(GITHUB_SETUP_PATH, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(server.githubSetupCalls).toBe(1);
    expect((await visit(`${GITHUB_SETUP_PATH}/x`)).status).toBe(404);
  });

  it("parses the binding's answer with the contract", async () => {
    const env = {
      OMNIGENT: { getByName: () => ({ githubSetup: async () => ({ configured: "yes" }) }) },
    };
    await expect(
      bindingsGitHubSetupBackend(env).githubSetup({ interfaceVersion: 1 }),
    ).rejects.toThrow();
    const good = {
      OMNIGENT: { getByName: () => ({ githubSetup: async () => state() }) },
    };
    expect(await bindingsGitHubSetupBackend(good).githubSetup({ interfaceVersion: 1 })).toEqual(
      state(),
    );
  });
});

describe("githubSetupView", () => {
  it("is ready only for a server started with this version's App settings that lists GitHub", () => {
    fc.assert(
      fc.property(
        fc.record({
          configured: fc.boolean(),
          applied: fc.boolean(),
          server: fc.constantFrom("answering", "starting", "held", "recovery", "unavailable"),
          linking: fc.constantFrom("on", "off", "unknown"),
        }),
        fc.integer({ min: 0, max: 2 * GITHUB_SETUP_WAIT_MS }),
        (answer, waited) => {
          const view: GitHubSetupView = githubSetupView(answer as GitHubSetupResult, waited);
          const ready = answer.configured && answer.applied && answer.linking === "on";
          expect(view.kind === "ready").toBe(ready);
          if (!ready) expect(view.kind).toBe(waited < GITHUB_SETUP_WAIT_MS ? "waiting" : "stopped");
        },
      ),
    );
  });

  it("names the step while waiting", () => {
    const step = (s: GitHubSetupResult | null) => {
      const view = githubSetupView(s, 0);
      return view.kind === "waiting" ? view.step : view.kind;
    };
    expect(step(null)).toBe("switching");
    expect(step(state({ configured: false }))).toBe("switching");
    expect(step(state({ applied: false }))).toBe("restarting");
    expect(step(state({ server: "starting", linking: "unknown" }))).toBe("starting");
    expect(step(state({ linking: "off" }))).toBe("reporting");
  });

  it("has words for every problem, naming the installer's step where it helps", () => {
    expect(PROBLEMS.not_configured).toContain("node scripts/bootstrap/bootstrap.ts github-app");
    expect(PROBLEMS.off).toContain("--replace");
  });
});

describe("waitStart", () => {
  it("takes `since` only as a time not in the future", () => {
    const at = (query: string) => waitStart(new URL(`${ORIGIN}/platform/github${query}`), NOW);
    expect(at("")).toBe(NOW);
    expect(at(`?since=${NOW - 5}`)).toBe(NOW - 5);
    expect(at(`?since=${NOW + 5}`)).toBe(NOW);
    for (const bad of [
      "?since=",
      "?since=-1",
      "?since=1e9",
      "?since=abc",
      "?since=1234567890123456",
    ]) {
      expect(at(bad), bad).toBe(NOW);
    }
  });
});

describe("layout's reload", () => {
  it("reloads only a path on this origin", () => {
    expect(layout("t", "b", [], { seconds: 5, url: "/platform/github?since=1&x=<" })).toContain(
      '<meta http-equiv="refresh" content="5;url=/platform/github?since=1&amp;x=&lt;">',
    );
    expect(layout("t", "b")).not.toContain("refresh");
    for (const url of ["https://evil.example", "//evil.example/", "javascript:alert(1)"]) {
      expect(() => layout("t", "b", [], { seconds: 5, url }), url).toThrow();
    }
  });
});

describe("Omnigent's /v1/info, read for GitHub linking", () => {
  it("lists GitHub only when enabled_connections names it", () => {
    expect(githubLinkingOf({ enabled_connections: ["github"] })).toBe(true);
    expect(githubLinkingOf({ enabled_connections: ["mcp", "github"] })).toBe(true);
    expect(githubLinkingOf({ enabled_connections: [] })).toBe(false);
    expect(githubLinkingOf({ enabled_connections: ["databricks"] })).toBe(false);
    for (const unsaid of [null, undefined, "x", [], { enabled_connections: "github" }, {}]) {
      expect(githubLinkingOf(unsaid)).toBeNull();
    }
  });

  it("tags the App by its client ID: short, stable, distinct, never the ID itself", async () => {
    const tag = await githubAppTag("Iv23liCanary");
    expect(tag).toMatch(/^[0-9a-f]{16}$/);
    expect(tag).not.toContain("Iv23liCanary");
    expect(await githubAppTag(" Iv23liCanary ")).toBe(tag);
    expect(await githubAppTag("Iv23liCanarz")).not.toBe(tag);
    expect(await githubAppTagOf({ [GITHUB_APP_CLIENT_ID_ENV]: "Iv23liCanary" })).toBe(tag);
    for (const value of [undefined, null, "", "  "]) expect(await githubAppTag(value)).toBeNull();
    expect(await githubAppTagOf({ [GITHUB_APP_CLIENT_ID_ENV]: 7 })).toBeNull();
    expect(await githubAppTagOf({})).toBeNull();
  });

  it("says whether this version holds the App's client ID, names only", () => {
    expect(githubAppConfigured({ [GITHUB_APP_CLIENT_ID_ENV]: "Iv23liCanary" })).toBe(true);
    for (const value of [undefined, "", "  ", 1]) {
      expect(githubAppConfigured({ [GITHUB_APP_CLIENT_ID_ENV]: value })).toBe(false);
    }
  });
});
