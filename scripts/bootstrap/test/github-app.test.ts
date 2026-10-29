// The installer's GitHub App step (github-app.ts) with a real local page and a fake browser that
// does what GitHub does: it loads the page, reads the manifest form, and comes back to the
// manifest's redirect URL with a code and the form's state. GitHub's API and Cloudflare are fakes.
import { describe, expect, it } from "vitest";
import { KEY_SERVICE_SECRETS, parseRecordKeys } from "../../../worker/src/internal/key-service.ts";
import {
  APP_PERMISSIONS,
  appName,
  browserCommand,
  createGitHubApp,
  extraPermissions,
  GITHUB_APP_SECRETS,
  type GitHubAppCloud,
  type GitHubAppOptions,
  type GitHubAppPorts,
  GitHubAppRefusal,
  githubAppChanges,
  githubAppManifest,
  type Manifest,
  manifestAction,
  manifestPage,
  parseConversion,
} from "../github-app.ts";
import type { WorkerIdentity } from "../machine.ts";
import { accountPlan, INSTALLATION } from "./fixtures.ts";

const CLIENT_SECRET = "cfo-canary-github-client-secret-00000000";
const PEM = "-----BEGIN RSA PRIVATE KEY-----cfo-canary-pem-----END RSA PRIVATE KEY-----";
const WEBHOOK = "cfo-canary-webhook-secret";
const CODE = "cfocanarymanifestcode0";

const conversion = (over: Record<string, unknown> = {}) => ({
  id: 123456,
  slug: "omnigent-01hs3f9q",
  node_id: "A_kgDO",
  name: "Omnigent 01hs3f9q",
  client_id: "Iv23liCanaryClient00",
  client_secret: CLIENT_SECRET,
  webhook_secret: WEBHOOK,
  pem: PEM,
  permissions: { contents: "write", metadata: "read", pull_requests: "write" },
  ...over,
});

class FakeCloud implements GitHubAppCloud {
  names: string[] | null = ["SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET"];
  identity: WorkerIdentity = { exists: true, installationId: INSTALLATION };
  changes: Record<string, string | null>[] = [];
  async secretNames() {
    return this.names;
  }
  async workerInstallation() {
    return this.identity;
  }
  async updateSecrets(_worker: string, changes: Readonly<Record<string, string | null>>) {
    this.changes.push({ ...changes });
    return "sent" as const;
  }
}

interface Visit {
  readonly page: Response;
  readonly action: string;
  readonly manifest: Manifest;
  readonly callback?: Response;
}

function counter(): (n: number) => Uint8Array {
  let next = 1;
  return (n) => {
    const out = new Uint8Array(n).map(() => next++ % 256);
    return out;
  };
}

/**
 * Runs the step with a browser that behaves as GitHub would after "Create", unless `click`
 * returns other query values (or null: never comes back).
 */
async function run(
  options: GitHubAppOptions & {
    cloud?: FakeCloud;
    github?: () => Response;
    click?: (state: string) => Record<string, string> | null;
  } = {},
) {
  const cloud = options.cloud ?? new FakeCloud();
  const logs: string[] = [];
  const github: { url: string; init: RequestInit }[] = [];
  let resolveVisit: (visit: Visit) => void = () => undefined;
  const visited = new Promise<Visit>((resolve) => {
    resolveVisit = resolve;
  });
  const ports: GitHubAppPorts = {
    cloud,
    openBrowser: (url) => {
      void (async () => {
        const page = await fetch(url);
        const html = await page.clone().text();
        const action = decode(/action="([^"]+)"/.exec(html)?.[1] ?? "");
        const manifest = JSON.parse(
          decode(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? "{}"),
        );
        const state = new URL(action).searchParams.get("state") ?? "";
        const query = options.click ? options.click(state) : { code: CODE, state };
        if (query === null) return resolveVisit({ page, action, manifest });
        const back = new URL(manifest.redirect_url);
        for (const [k, v] of Object.entries(query)) back.searchParams.set(k, v);
        const callback = await fetch(back, { redirect: "manual" });
        resolveVisit({ page, action, manifest, callback });
      })();
    },
    fetch: async (url, init) => {
      github.push({ url, init });
      return options.github ? options.github() : Response.json(conversion(), { status: 201 });
    },
    random: counter(),
    log: (message) => logs.push(message),
  };
  const outcome = createGitHubApp(await accountPlan(), ports, {
    timeoutMs: options.timeoutMs ?? 5_000,
    ...(options.org === undefined ? {} : { org: options.org }),
    ...(options.replace === undefined ? {} : { replace: options.replace }),
  });
  return { cloud, logs, github, visited, outcome };
}

function decode(text: string): string {
  return text
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

describe("the manifest", () => {
  it("names the installation's hostname for the callback and setup, with the least permissions", async () => {
    const plan = await accountPlan();
    const manifest = githubAppManifest(plan, "http://127.0.0.1:1234/callback");
    expect(manifest).toEqual({
      name: "Omnigent 01hs3f9q",
      url: "https://omnigent.example.test",
      description: "Omnigent's GitHub linking for omnigent.example.test (cloudflare-omnigent).",
      redirect_url: "http://127.0.0.1:1234/callback",
      callback_urls: ["https://omnigent.example.test/v1/connections/github/callback"],
      setup_url: "https://omnigent.example.test/settings/integrations",
      setup_on_update: false,
      request_oauth_on_install: false,
      public: false,
      hook_attributes: { url: "https://omnigent.example.test/", active: false },
      default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      default_events: [],
    });
    expect(appName(INSTALLATION).length).toBeLessThanOrEqual(34);
  });

  it("posts to the person's account or an organization, and refuses a bad organization name", () => {
    expect(manifestAction("s1")).toBe("https://github.com/settings/apps/new?state=s1");
    expect(manifestAction("s1", "cfo-org")).toBe(
      "https://github.com/organizations/cfo-org/settings/apps/new?state=s1",
    );
    for (const bad of ["", "-x", "a/b", "a b", "x".repeat(40)]) {
      expect(() => manifestAction("s", bad), bad).toThrow(GitHubAppRefusal);
    }
  });

  it("escapes the manifest into the page's form", async () => {
    const plan = await accountPlan({ hostname: 'x"><script>alert(1)</script>.example.test' });
    const html = manifestPage(
      manifestAction("s"),
      githubAppManifest(plan, "http://127.0.0.1:1/callback"),
    );
    expect(html).not.toContain("<script>alert");
    expect(html.match(/<script>/g)).toHaveLength(1);
  });
});

describe("GitHub's answer", () => {
  it("keeps the ID, slug, client ID and secret, and nothing else", () => {
    const app = parseConversion(conversion());
    expect(app).toEqual({
      id: 123456,
      slug: "omnigent-01hs3f9q",
      clientId: "Iv23liCanaryClient00",
      clientSecret: CLIENT_SECRET,
      permissions: APP_PERMISSIONS,
    });
    expect(JSON.stringify(app)).not.toContain(PEM);
    expect(JSON.stringify(app)).not.toContain(WEBHOOK);
  });

  it("refuses a malformed answer without repeating it", () => {
    for (const over of [
      { id: "1" },
      { id: 0 },
      { id: 1.5 },
      { slug: "Bad Slug" },
      { client_id: "a b" },
      { client_secret: "has space" },
      { client_secret: "" },
    ]) {
      let message = "";
      try {
        parseConversion(conversion(over));
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, JSON.stringify(over)).toBe(
        "GitHub's answer was not a GitHub App's credentials",
      );
    }
    expect(() => parseConversion(null)).toThrow(GitHubAppRefusal);
    expect(parseConversion(conversion({ permissions: "x" })).permissions).toEqual({});
  });

  it("names permissions granted beyond the manifest's", () => {
    expect(extraPermissions(APP_PERMISSIONS)).toEqual([]);
    expect(
      extraPermissions({
        contents: "read",
        metadata: "write",
        administration: "write",
        issues: "read",
      }),
    ).toEqual(["administration: write", "issues: read", "metadata: write"]);
  });
});

describe("the secrets change", () => {
  it("sets the App and generates the key service's keys when the Worker has none", async () => {
    const plan = await accountPlan();
    const changes = githubAppChanges(plan, parseConversion(conversion()), new Set(), counter());
    expect(changes[GITHUB_APP_SECRETS.appId]).toBe("123456");
    expect(changes[GITHUB_APP_SECRETS.clientId]).toBe("Iv23liCanaryClient00");
    expect(changes[GITHUB_APP_SECRETS.clientSecret]).toBe(CLIENT_SECRET);
    expect(changes[GITHUB_APP_SECRETS.redirectUri]).toBe(
      "https://omnigent.example.test/v1/connections/github/callback",
    );
    expect(changes[GITHUB_APP_SECRETS.slug]).toBe("omnigent-01hs3f9q");
    expect(changes[KEY_SERVICE_SECRETS.currentId]).toMatch(/^ks-[0-9a-f]{8}$/);
    expect(changes[KEY_SERVICE_SECRETS.current]).toMatch(/^[0-9a-f]{64}$/);
    const records = parseRecordKeys(changes[KEY_SERVICE_SECRETS.recordKeys]);
    expect(records?.keyId).toBe(`${INSTALLATION}.records`);
    expect(records?.versions.get(1)?.byteLength).toBe(32);
    expect(Object.keys(changes).every((name) => !name.includes("PRIVATE_KEY"))).toBe(true);
    expect(JSON.stringify(changes)).not.toContain(PEM);
    expect(JSON.stringify(changes)).not.toContain(WEBHOOK);
  });

  it("never replaces the key service's keys the Worker already holds", async () => {
    const plan = await accountPlan();
    const present = new Set([
      KEY_SERVICE_SECRETS.currentId,
      KEY_SERVICE_SECRETS.current,
      KEY_SERVICE_SECRETS.recordKeys,
    ]);
    const changes = githubAppChanges(plan, parseConversion(conversion()), present, counter());
    expect(Object.keys(changes).sort()).toEqual(Object.values(GITHUB_APP_SECRETS).sort());
  });

  it("refuses a half-present signing pair", async () => {
    const plan = await accountPlan();
    for (const half of [KEY_SERVICE_SECRETS.currentId, KEY_SERVICE_SECRETS.current]) {
      expect(() =>
        githubAppChanges(plan, parseConversion(conversion()), new Set([half]), counter()),
      ).toThrow(/half of the key service's signing pair/);
    }
  });
});

describe("the whole step, with a local page and a browser that behaves as GitHub does", () => {
  it("creates the App, stores it in one secrets change, and sends the browser on to install it", async () => {
    const { cloud, logs, github, visited, outcome } = await run();
    const result = await outcome;
    const visit = await visited;
    expect(result).toEqual({
      slug: "omnigent-01hs3f9q",
      installUrl: "https://github.com/apps/omnigent-01hs3f9q/installations/new",
    });
    // The page: the manifest form, posted to GitHub with a fresh state, never cached.
    expect(visit.page.status).toBe(200);
    expect(visit.page.headers.get("cache-control")).toBe("no-store");
    expect(visit.page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(visit.action).toMatch(
      /^https:\/\/github\.com\/settings\/apps\/new\?state=[0-9a-f]{64}$/,
    );
    expect(visit.manifest.redirect_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(visit.manifest.default_permissions).toEqual(APP_PERMISSIONS);
    // The code went to GitHub's conversion, and nowhere else.
    expect(github).toHaveLength(1);
    expect(github[0]?.url).toBe(`https://api.github.com/app-manifests/${CODE}/conversions`);
    expect(github[0]?.init.method).toBe("POST");
    // One change of the Worker's secrets, with the App and the key service's new keys.
    expect(cloud.changes).toHaveLength(1);
    expect(Object.keys(cloud.changes[0] ?? {}).sort()).toEqual(
      [
        ...Object.values(GITHUB_APP_SECRETS),
        KEY_SERVICE_SECRETS.currentId,
        KEY_SERVICE_SECRETS.current,
        KEY_SERVICE_SECRETS.recordKeys,
      ].sort(),
    );
    // The browser goes on to GitHub's install page.
    expect(visit.callback?.status).toBe(302);
    expect(visit.callback?.headers.get("location")).toBe(result.installUrl);
    // Nothing secret was printed.
    const printed = logs.join("\n");
    const values = Object.values(cloud.changes[0] ?? {}).filter(
      (v): v is string => typeof v === "string" && v.length > 20 && !v.startsWith("https://"),
    );
    for (const secret of [CLIENT_SECRET, PEM, WEBHOOK, CODE, ...values]) {
      expect(printed).not.toContain(secret);
    }
    expect(printed).toContain("Create GitHub App");
  });

  it("refuses a callback with another state, and keeps waiting for the right one", async () => {
    let tries = 0;
    const { cloud, outcome } = await run({
      click: (state) =>
        tries++ === 0 ? { code: CODE, state: `${state}x` } : { code: CODE, state },
      timeoutMs: 300,
    });
    // The first visit's callback is refused; the outcome then times out with nothing changed.
    await expect(outcome).rejects.toThrow(/no answer from GitHub in time/);
    expect(cloud.changes).toEqual([]);
  });

  it("refuses a malformed code", async () => {
    const { cloud, visited, outcome } = await run({
      click: (state) => ({ code: "../../x", state }),
      timeoutMs: 300,
    });
    expect((await visited).callback?.status).toBe(400);
    await expect(outcome).rejects.toThrow(/no answer/);
    expect(cloud.changes).toEqual([]);
  });

  it("changes nothing when GitHub refuses the conversion or answers nonsense", async () => {
    for (const github of [
      () => new Response("{}", { status: 404 }),
      () => new Response("not json", { status: 201 }),
      () => Response.json({ id: 1 }, { status: 201 }),
    ]) {
      const { cloud, visited, outcome } = await run({ github });
      await expect(outcome).rejects.toThrow(GitHubAppRefusal);
      expect((await visited).callback?.status).toBe(500);
      expect(cloud.changes).toEqual([]);
    }
  });

  it("warns about permissions GitHub granted beyond the manifest's", async () => {
    const { logs, outcome } = await run({
      github: () =>
        Response.json(conversion({ permissions: { contents: "write", administration: "write" } }), {
          status: 201,
        }),
    });
    await outcome;
    expect(logs.join("\n")).toContain("administration: write");
  });

  it("refuses before showing anything: no Worker, another installation's, or an App already there", async () => {
    const missing = new FakeCloud();
    missing.names = null;
    const other = new FakeCloud();
    other.identity = { exists: true, installationId: "ins_01aaaaaaaaaaaaaaaaaaaaaaaa" };
    const unknown = new FakeCloud();
    unknown.identity = { exists: true, installationId: undefined };
    const linked = new FakeCloud();
    linked.names = [GITHUB_APP_SECRETS.clientId];
    for (const [cloud, why] of [
      [missing, /does not exist yet/],
      [other, /is not serving installation/],
      [unknown, /is not serving installation/],
      [linked, /already has a GitHub App/],
    ] as const) {
      let opened = false;
      const outcome = createGitHubApp(await accountPlan(), {
        cloud,
        openBrowser: () => {
          opened = true;
        },
        fetch: async () => new Response(null, { status: 500 }),
        random: counter(),
        log: () => undefined,
      });
      await expect(outcome).rejects.toThrow(why);
      expect(opened).toBe(false);
      expect(cloud.changes).toEqual([]);
    }
  });

  it("replaces the App on --replace, keeping the key service's keys", async () => {
    const cloud = new FakeCloud();
    cloud.names = [
      ...Object.values(GITHUB_APP_SECRETS),
      KEY_SERVICE_SECRETS.currentId,
      KEY_SERVICE_SECRETS.current,
      KEY_SERVICE_SECRETS.recordKeys,
    ];
    const { outcome } = await run({ cloud, replace: true });
    await outcome;
    expect(Object.keys(cloud.changes[0] ?? {}).sort()).toEqual(
      Object.values(GITHUB_APP_SECRETS).sort(),
    );
  });

  it("posts to an organization when asked", async () => {
    const { visited, outcome } = await run({ org: "cfo-org" });
    await outcome;
    expect((await visited).action).toMatch(
      /^https:\/\/github\.com\/organizations\/cfo-org\/settings\/apps\/new\?state=/,
    );
  });

  it("answers only its own address, its page once, and its callback once", async () => {
    let port = 0;
    let pagePath = "";
    const cloud = new FakeCloud();
    const outcome = createGitHubApp(
      await accountPlan(),
      {
        cloud,
        openBrowser: (url) => {
          const u = new URL(url);
          port = Number(u.port);
          pagePath = u.pathname;
        },
        fetch: async () => Response.json(conversion(), { status: 201 }),
        random: counter(),
        log: () => undefined,
      },
      { timeoutMs: 1_500 },
    );
    const settled = outcome.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const http = await import("node:http");
    const get = (path: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = http.request(
          { host: "127.0.0.1", port, path, headers: { host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });
    expect(await get(pagePath, "evil.example.test")).toBe(403);
    expect(await get(pagePath, `127.0.0.1:${port}`)).toBe(200);
    expect(await get(pagePath, `localhost:${port}`)).toBe(404);
    expect(await get("/other", `127.0.0.1:${port}`)).toBe(404);
    expect(await settled).toBeInstanceOf(GitHubAppRefusal);
    expect(cloud.changes).toEqual([]);
  });
});

describe("the browser", () => {
  it("opens with the platform's own command", () => {
    expect(browserCommand("linux", "http://127.0.0.1:1/x")).toEqual([
      "xdg-open",
      ["http://127.0.0.1:1/x"],
    ]);
    expect(browserCommand("darwin", "u")).toEqual(["open", ["u"]]);
    expect(browserCommand("win32", "u")).toEqual(["cmd", ["/c", "start", '""', "u"]]);
  });
});
