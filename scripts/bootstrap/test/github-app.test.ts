// The installer's GitHub App step (github-app.ts) with a real local page and a fake browser that
// does what GitHub does: it loads the page, reads the manifest form, comes back to the manifest's
// redirect URL with a code and the form's state, and then follows the progress page until its
// last answer. GitHub's API and Cloudflare are fakes: a small one for the page and the App, and
// the bootstrap's simulated Cloudflare (fake-cloud.ts) for the wait for GitHub linking (WP3.36).
import { describe, expect, it } from "vitest";
import { KEY_SERVICE_SECRETS, parseRecordKeys } from "../../../worker/src/internal/key-service.ts";
import { githubAppTag } from "../../../worker/src/server/github-linking.ts";
import {
  APP_PERMISSIONS,
  appName,
  browserCommand,
  createGitHubApp,
  DEFAULT_GITHUB_APP_TIMEOUT_MS,
  extraPermissions,
  finalMessage,
  GITHUB_APP_SECRETS,
  type GitHubAppCloud,
  type GitHubAppOptions,
  type GitHubAppOutcome,
  type GitHubAppPorts,
  GitHubAppRefusal,
  githubAppChanges,
  githubAppManifest,
  type Manifest,
  manifestAction,
  manifestPage,
  minutes,
  page,
  parseConversion,
} from "../github-app.ts";
import { runBootstrap, type WorkerIdentity } from "../machine.ts";
import { FakeWorld, fakeAppTag, MemoryStore, REPLACE_MS, SWITCH_MS } from "./fake-cloud.ts";
import { accountPlan, baseConfigs, freshState, INSTALLATION, OWNER_PASSWORD } from "./fixtures.ts";

const CLIENT_SECRET = "cfo-canary-github-client-secret-00000000";
const PEM = "-----BEGIN RSA PRIVATE KEY-----cfo-canary-pem-----END RSA PRIVATE KEY-----";
const WEBHOOK = "cfo-canary-webhook-secret";
const CODE = "cfocanarymanifestcode0";
const FEATURES = "key-service github-setup";

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

/**
 * A small Cloudflare for the page and the App: one version before the change and one after,
 * whose watchdog reports (right away, in real time) GitHub linking as `linking` says.
 */
class FakeCloud implements GitHubAppCloud {
  names: string[] | null = ["SERVER_ENV_OMNIGENT_ACCOUNTS_COOKIE_SECRET"];
  identity: WorkerIdentity = {
    exists: true,
    installationId: INSTALLATION,
    vars: { CFO_INSTALLATION_ID: INSTALLATION, CFO_PLATFORM_FEATURES: FEATURES },
  };
  /** The web Worker's (WP3.36: it serves the GitHub setup page). */
  web: WorkerIdentity = {
    exists: true,
    installationId: INSTALLATION,
    vars: { CFO_INSTALLATION_ID: INSTALLATION, CFO_WEB_FEATURES: "github-setup" },
  };
  changes: Record<string, string | null>[] = [];
  linking: boolean | null = true;
  async secretNames() {
    return this.names;
  }
  async workerInstallation(worker: string) {
    return worker.endsWith("-web") ? this.web : this.identity;
  }
  async updateSecrets(_worker: string, changes: Readonly<Record<string, string | null>>) {
    this.changes.push({ ...changes });
    return "sent" as const;
  }
  async activeVersion() {
    return this.changes.length === 0 ? "v1" : "v2";
  }
  /** Cloudflare's version list: none named, unless a test says which is the latest. */
  latestVersion: string | undefined;
  async versions() {
    return this.latestVersion === undefined ? [] : [{ id: this.latestVersion, number: 9 }];
  }
  async logs() {
    if (this.changes.length === 0) return [];
    const $workers = {
      scriptName: "cloudflare-omnigent",
      scriptVersion: { id: "v2" },
      eventType: "alarm",
      entrypoint: "OmnigentServer",
    };
    return [
      {
        timestamp: Date.now() + 1,
        $workers,
        source: {
          cfo: "bootstrap",
          event: "status",
          reason: "durable",
          bootstrapStatus: {
            protocolVersion: 1,
            installationId: INSTALLATION,
            initialized: true,
            checkedAt: new Date().toISOString(),
          },
          secretPresent: false,
          configApplied: true,
          githubApp: fakeAppTag(
            new Map([
              [
                GITHUB_APP_SECRETS.clientId,
                String(this.changes.at(-1)?.[GITHUB_APP_SECRETS.clientId]),
              ],
            ]),
          ),
          githubLinking: this.linking,
        },
      },
    ];
  }
}

interface Visit {
  readonly page: Response;
  readonly action: string;
  readonly manifest: Manifest;
  readonly callback?: Response;
  /** The progress page's answers, in order, the last one its last answer. */
  readonly progress: readonly {
    readonly status: number;
    readonly html: string;
    readonly location: string | null;
  }[];
}

function counter(): (n: number) => Uint8Array {
  let next = 1;
  return (n) => {
    const out = new Uint8Array(n).map(() => next++ % 256);
    return out;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser on the progress page: it loads it again while the page says to refresh. */
async function follow(statusUrl: string): Promise<Visit["progress"]> {
  const seen: { status: number; html: string; location: string | null }[] = [];
  for (let i = 0; i < 2000; i++) {
    const response = await fetch(statusUrl, { redirect: "manual" });
    const html = await response.text();
    seen.push({ status: response.status, html, location: response.headers.get("location") });
    if (response.status !== 200 || !html.includes('http-equiv="refresh"')) return seen;
    await sleep(5);
  }
  throw new Error("the progress page never ended");
}

/**
 * Runs the step with a browser that behaves as GitHub would after "Create", unless `click`
 * returns other query values (or null: never comes back). Cloudflare is `cloud`, or `world`'s.
 */
async function run(
  options: GitHubAppOptions & {
    cloud?: GitHubAppCloud;
    world?: FakeWorld;
    github?: () => Response;
    click?: (state: string) => Record<string, string> | null;
  } = {},
) {
  const cloud = options.cloud ?? options.world?.cloud() ?? new FakeCloud();
  const logs: string[] = [];
  const github: { url: string; init: RequestInit }[] = [];
  let resolveVisit: (visit: Visit) => void = () => undefined;
  const visited = new Promise<Visit>((resolve) => {
    resolveVisit = resolve;
  });
  const world = options.world;
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
        if (query === null) return resolveVisit({ page, action, manifest, progress: [] });
        const back = new URL(manifest.redirect_url);
        for (const [k, v] of Object.entries(query)) back.searchParams.set(k, v);
        const callback = await fetch(back, { redirect: "manual" });
        const location = callback.headers.get("location");
        const progress =
          callback.status === 303 && location !== null
            ? await follow(new URL(location, back).toString())
            : [];
        resolveVisit({ page, action, manifest, callback, progress });
      })();
    },
    githubApi: async (url, init) => {
      github.push({ url, init });
      return options.github ? options.github() : Response.json(conversion(), { status: 201 });
    },
    random: counter(),
    now: () => (world === undefined ? Date.now() : world.now),
    sleep: async (ms) => {
      // The simulated clock jumps; a few real milliseconds let the browser see each step.
      if (world !== undefined) world.now += Math.max(0, ms);
      await sleep(Math.min(ms, 10));
    },
    log: (message) => logs.push(message),
  };
  const plan = world?.plan ?? (await accountPlan());
  const outcome = createGitHubApp(plan, ports, {
    timeoutMs: options.timeoutMs ?? 5_000,
    expiredPageMs: options.expiredPageMs ?? 0,
    finalPageMs: options.finalPageMs ?? 2_000,
    ...(options.linkingWaitMs === undefined ? {} : { linkingWaitMs: options.linkingWaitMs }),
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

/** A finished installation on the bootstrap's simulated Cloudflare, a day after its release. */
async function installedWorld(): Promise<FakeWorld> {
  const plan = await accountPlan();
  const world = new FakeWorld(plan);
  const outcome = await runBootstrap(
    {
      cloud: world.cloud(),
      store: new MemoryStore(freshState(plan)),
      baseConfigs: baseConfigs(),
      secrets: () => ({
        ownerPassword: OWNER_PASSWORD,
        replicaAccessKeyId: "cfo-canary-replica-key-id",
        replicaSecretAccessKey: "cfo-canary-replica-secret-key",
      }),
      random: (n) => new Uint8Array(n).fill(0xab),
      now: () => world.now,
      sleep: async (ms) => {
        world.now += Math.max(0, ms);
      },
      log: () => undefined,
    },
    { waitMs: 30 * 60_000, pollMs: 30_000, verify: true, switchMs: 330_000, verifyWaitMs: 600_000 },
  );
  expect(outcome).toEqual({ kind: "done" });
  world.calls.length = 0;
  world.counts.clear();
  world.now += 24 * 3600_000;
  return world;
}

describe("the manifest", () => {
  it("names the installation's hostname for the callback and setup, with the least permissions", async () => {
    const plan = await accountPlan();
    const manifest = githubAppManifest(plan, "http://127.0.0.1:1234/callback", "0a1b");
    expect(manifest).toEqual({
      name: "Omnigent 01hs3f9q 0a1b",
      url: "https://omnigent.example.test",
      description: "Omnigent's GitHub linking for omnigent.example.test (cloudflare-omnigent).",
      redirect_url: "http://127.0.0.1:1234/callback",
      callback_urls: ["https://omnigent.example.test/v1/connections/github/callback"],
      setup_url: "https://omnigent.example.test/platform/github",
      setup_on_update: true,
      request_oauth_on_install: false,
      public: false,
      hook_attributes: { url: "https://omnigent.example.test/", active: false },
      default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      default_events: [],
    });
    expect(appName(INSTALLATION, "ffff").length).toBeLessThanOrEqual(34);
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
      githubAppManifest(plan, "http://127.0.0.1:1/callback", "0000"),
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
  it("creates the App, stores it in one secrets change, and sends the browser on to install it once linking is on", async () => {
    const fake = new FakeCloud();
    const { cloud, logs, github, visited, outcome } = await run({ cloud: fake });
    const result = await outcome;
    const visit = await visited;
    expect(result).toEqual({
      kind: "on",
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
    expect(fake.changes).toHaveLength(1);
    expect(Object.keys(fake.changes[0] ?? {}).sort()).toEqual(
      [
        ...Object.values(GITHUB_APP_SECRETS),
        KEY_SERVICE_SECRETS.currentId,
        KEY_SERVICE_SECRETS.current,
        KEY_SERVICE_SECRETS.recordKeys,
      ].sort(),
    );
    // The callback moves the browser on at once to the progress page, which ends on GitHub's
    // install page, only once linking is on.
    expect(visit.callback?.status).toBe(303);
    const last = visit.progress.at(-1);
    expect(last?.status).toBe(302);
    expect(last?.location).toBe(result.installUrl);
    expect(cloud).toBe(fake);
    // Nothing secret was printed, or shown on any page.
    const printed = [logs.join("\n"), ...visit.progress.map((p) => p.html)].join("\n");
    const values = Object.values(fake.changes[0] ?? {}).filter(
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
    await expect(outcome).rejects.toThrow(/no answer from GitHub within 1 second; nothing/);
    expect((cloud as FakeCloud).changes).toEqual([]);
  });

  it("refuses a malformed code", async () => {
    const { cloud, visited, outcome } = await run({
      click: (state) => ({ code: "../../x", state }),
      timeoutMs: 300,
    });
    expect((await visited).callback?.status).toBe(400);
    await expect(outcome).rejects.toThrow(/no answer/);
    expect((cloud as FakeCloud).changes).toEqual([]);
  });

  it("changes nothing when GitHub refuses the conversion or answers nonsense", async () => {
    for (const github of [
      () => new Response("{}", { status: 404 }),
      () => new Response("not json", { status: 201 }),
      () => Response.json({ id: 1 }, { status: 201 }),
    ]) {
      const { cloud, visited, outcome } = await run({ github });
      await expect(outcome).rejects.toThrow(GitHubAppRefusal);
      const last = (await visited).progress.at(-1);
      expect(last?.status).toBe(200);
      expect(last?.html).toContain("The App was not stored");
      expect(last?.html).not.toContain('http-equiv="refresh"');
      expect((cloud as FakeCloud).changes).toEqual([]);
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

  it("names the App to delete when it cannot be stored", async () => {
    const cloud = new FakeCloud();
    cloud.updateSecrets = async () => {
      throw new Error("cf workers secrets bulk failed");
    };
    const { logs, visited, outcome } = await run({ cloud });
    await expect(outcome).rejects.toThrow("cf workers secrets bulk failed");
    expect((await visited).progress.at(-1)?.html).toContain("See the installer&#39;s output.");
    expect(logs.join("\n")).toContain(
      "delete it at https://github.com/settings/apps/omnigent-01hs3f9q/advanced",
    );
    // Under an organization, the organization's settings (Codex WP5.9 r1, optional).
    const orgCloud = new FakeCloud();
    orgCloud.updateSecrets = cloud.updateSecrets;
    const forOrg = await run({ cloud: orgCloud, org: "cfo-org" });
    await expect(forOrg.outcome).rejects.toThrow("cf workers secrets bulk failed");
    expect(forOrg.logs.join("\n")).toContain(
      "delete it at https://github.com/organizations/cfo-org/settings/apps/omnigent-01hs3f9q/advanced",
    );
  });

  it("refuses before showing anything: no Worker, another installation's, an older release, or an App already there", async () => {
    const missing = new FakeCloud();
    missing.names = null;
    const other = new FakeCloud();
    other.identity = { exists: true, installationId: "ins_01aaaaaaaaaaaaaaaaaaaaaaaa" };
    const unknown = new FakeCloud();
    unknown.identity = { exists: true, installationId: undefined };
    const linked = new FakeCloud();
    linked.names = [GITHUB_APP_SECRETS.clientId];
    const half = new FakeCloud();
    half.names = [KEY_SERVICE_SECRETS.current];
    // A release from before the key service (WP3.35): no feature list, or one without it.
    const older = new FakeCloud();
    older.identity = { exists: true, installationId: INSTALLATION, vars: {} };
    const unlisted = new FakeCloud();
    unlisted.identity = { exists: true, installationId: INSTALLATION };
    const without = new FakeCloud();
    without.identity = {
      exists: true,
      installationId: INSTALLATION,
      vars: { CFO_PLATFORM_FEATURES: "something-else" },
    };
    // A release with the key service but from before the GitHub setup page (WP3.36).
    const keyOnly = new FakeCloud();
    keyOnly.identity = {
      exists: true,
      installationId: INSTALLATION,
      vars: { CFO_PLATFORM_FEATURES: "key-service" },
    };
    // The web Worker: gone, another installation's, or from before the setup page (an update
    // interrupted between its two deploys; Codex r1-3).
    const noWeb = new FakeCloud();
    noWeb.web = { exists: false };
    const otherWeb = new FakeCloud();
    otherWeb.web = { exists: true, installationId: "ins_01aaaaaaaaaaaaaaaaaaaaaaaa" };
    const oldWeb = new FakeCloud();
    oldWeb.web = {
      exists: true,
      installationId: INSTALLATION,
      vars: { CFO_INSTALLATION_ID: INSTALLATION },
    };
    // An earlier version serves than the latest (WP3.41b): Cloudflare would refuse the App's
    // secrets after the App was made (Codex WP3.41b r1-2).
    const behind = new FakeCloud();
    behind.identity = {
      exists: true,
      installationId: INSTALLATION,
      versionId: "v1",
      vars: { CFO_INSTALLATION_ID: INSTALLATION, CFO_PLATFORM_FEATURES: FEATURES },
    };
    behind.latestVersion = "v2";
    for (const [cloud, why] of [
      [missing, /does not exist yet/],
      [
        behind,
        /refuses to change cloudflare-omnigent's secrets while its latest version is not the one deployed/,
      ],
      [other, /is not serving installation/],
      [unknown, /is not serving installation/],
      [older, /runs a release from before GitHub linking .*bootstrap\.ts update/],
      [unlisted, /runs a release from before GitHub linking/],
      [without, /runs a release from before GitHub linking/],
      [keyOnly, /runs a release from before the GitHub setup page: .*bootstrap\.ts update/],
      [noWeb, /cloudflare-omnigent-web is not serving installation/],
      [otherWeb, /cloudflare-omnigent-web is not serving installation/],
      [oldWeb, /cloudflare-omnigent-web runs a release from before the GitHub setup page/],
      [linked, /already has a GitHub App/],
      [half, /half of the key service's signing pair/],
    ] as const) {
      let opened = false;
      const outcome = createGitHubApp(await accountPlan(), {
        cloud,
        openBrowser: () => {
          opened = true;
        },
        githubApi: async () => new Response(null, { status: 500 }),
        random: counter(),
        now: () => Date.now(),
        sleep: async () => undefined,
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
        githubApi: async () => Response.json(conversion(), { status: 201 }),
        random: counter(),
        now: () => Date.now(),
        sleep: async () => undefined,
        log: () => undefined,
      },
      { timeoutMs: 1_500, expiredPageMs: 0 },
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

describe("the wait for GitHub linking, on a simulated Cloudflare (WP3.36)", () => {
  const changedAt = (world: FakeWorld) => world.secretChanges.at(-1)?.at ?? Number.NaN;

  it("sends the browser on only once a server started with the App's settings reports GitHub linking on", async () => {
    const world = await installedWorld();
    const changes = world.secretChanges.length;
    const { logs, visited, outcome } = await run({ world });
    const result = await outcome;
    const visit = await visited;
    expect(result).toMatchObject({ kind: "on", slug: "omnigent-01hs3f9q" });
    // One secrets change; the step waited out the object's switch and the server's restart.
    expect(world.secretChanges).toHaveLength(changes + 1);
    expect(world.now - changedAt(world)).toBeGreaterThanOrEqual(SWITCH_MS + REPLACE_MS);
    expect(logs.join("\n")).toContain("waiting: the platform has not switched");
    expect(logs.join("\n")).toContain("waiting: the server is restarting with the App's settings");
    // The progress page said what happened, reloading itself, and went on only at the end.
    const pages = visit.progress.slice(0, -1);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((p) => p.status === 200 && p.location === null)).toBe(true);
    expect(pages.every((p) => p.html.includes('http-equiv="refresh"'))).toBe(true);
    expect(pages.some((p) => p.html.includes("Omnigent&#39;s server is restarting"))).toBe(true);
    expect(visit.progress.at(-1)).toMatchObject({ status: 302, location: result.installUrl });
    expect(finalMessage(world.plan, result)).toEqual({
      exitCode: 0,
      lines: [
        "GitHub linking is on at https://omnigent.example.test.",
        `next, in your browser (it went on by itself): install the App on GitHub, ${result.installUrl}; GitHub then brings you back to Omnigent's Integrations page, https://omnigent.example.test/settings/integrations: click "Connect GitHub" there.`,
      ],
    });
  });

  it("says plainly when the restarted server has GitHub linking off, and sends nobody to install", async () => {
    const world = await installedWorld();
    world.githubLinks = () => false;
    const { visited, outcome } = await run({ world });
    const result = await outcome;
    expect(result.kind).toBe("off");
    const last = (await visited).progress.at(-1);
    expect(last?.status).toBe(200);
    expect(last?.html).toContain("GitHub linking is off");
    expect(last?.html).not.toContain('http-equiv="refresh"');
    expect(last?.html).not.toContain("installations/new");
    const words = finalMessage(world.plan, result);
    expect(words.exitCode).toBe(1);
    expect(words.lines.join(" ")).toContain("--replace");
    expect(words.lines.join(" ")).not.toMatch(/\bdone\b/);
  });

  it("says plainly when the server refuses the App's settings and is held", async () => {
    const world = await installedWorld();
    world.refusesSettings = (v) => v.secrets.has(GITHUB_APP_SECRETS.clientId);
    const { visited, outcome } = await run({ world });
    const result = await outcome;
    expect(result.kind).toBe("held");
    expect((await visited).progress.at(-1)?.html).toContain("does not start with the App");
    expect(finalMessage(world.plan, result).exitCode).toBe(1);
    expect(finalMessage(world.plan, result).lines.join(" ")).toContain("exit code 78");
  });

  it("stops waiting after its time, says what it saw last, and offers the link that still leads somewhere", async () => {
    const world = await installedWorld();
    world.appliesReleases = false; // the server is never restarted with the App's settings
    const { visited, outcome } = await run({ world, linkingWaitMs: 10 * 60_000 });
    const result = await outcome;
    expect(result).toMatchObject({
      kind: "waiting",
      why: "the platform has not switched the server's object to the App's settings yet",
    });
    const last = (await visited).progress.at(-1);
    expect(last?.html).toContain("GitHub linking is not on yet");
    expect(last?.html).toContain(`href="${result.installUrl}"`);
    expect(last?.html).toContain("https://omnigent.example.test/platform/github");
    expect(finalMessage(world.plan, result).exitCode).toBe(3);
  });

  it("asks again when a query of Cloudflare fails, and still ends with linking on", async () => {
    const world = await installedWorld();
    world.crash = { call: "logs", nth: 2, when: "before" };
    const { logs, outcome } = await run({ world });
    expect((await outcome).kind).toBe("on");
    expect(logs.join("\n")).toContain("waiting: Cloudflare did not answer the query");
  });

  it("needs no word from Cloudflare about versions: the App's own tag decides (Codex r1-1)", async () => {
    const world = await installedWorld();
    world.noVersions = true;
    const result = await (await run({ world, linkingWaitMs: 10 * 60_000 })).outcome;
    expect(result.kind).toBe("on");
  });

  it("logs the same App tag the platform computes", async () => {
    const id = "Iv23liCanaryClient00";
    expect(fakeAppTag(new Map([[GITHUB_APP_SECRETS.clientId, id]]))).toBe(await githubAppTag(id));
    expect(await githubAppTag(" ")).toBeNull();
  });

  it("on --replace, never takes the old App's server for the new one's", async () => {
    const world = await installedWorld();
    // An App stored earlier, and its server restarted with it: still announcing when the
    // replacement begins, GitHub linking on (with the old App).
    await world.cloud().updateSecrets(world.plan.platformWorker, {
      [GITHUB_APP_SECRETS.appId]: "1",
      [GITHUB_APP_SECRETS.clientId]: "Iv23liOldClient000000",
      [GITHUB_APP_SECRETS.clientSecret]: "cfo-canary-old-client-secret",
      [GITHUB_APP_SECRETS.redirectUri]:
        "https://omnigent.example.test/v1/connections/github/callback",
      [GITHUB_APP_SECRETS.slug]: "omnigent-old",
      [KEY_SERVICE_SECRETS.currentId]: "ks-cafe0001",
      [KEY_SERVICE_SECRETS.current]: "cfo-canary-key-service-signing-key",
      [KEY_SERVICE_SECRETS.recordKeys]: "cfo-canary-key-service-record-keys",
    });
    world.now += SWITCH_MS + REPLACE_MS + 60_000;
    const changes = world.secretChanges.length;
    const { outcome } = await run({ world, replace: true });
    const result = await outcome;
    expect(result.kind).toBe("on");
    expect(world.secretChanges).toHaveLength(changes + 1);
    expect(world.now - changedAt(world)).toBeGreaterThanOrEqual(SWITCH_MS + REPLACE_MS);
  });
});

describe("the local page's hour", () => {
  it("waits an hour by default", () => {
    expect(DEFAULT_GITHUB_APP_TIMEOUT_MS).toBe(60 * 60_000);
  });

  it("says, on every request, that the link expired and what to do, and stores nothing from a late callback", async () => {
    let start = "";
    let state = "";
    const cloud = new FakeCloud();
    const github: string[] = [];
    const logs: string[] = [];
    const outcome = createGitHubApp(
      await accountPlan(),
      {
        cloud,
        openBrowser: (url) => {
          start = url;
        },
        githubApi: async (url) => {
          github.push(url);
          return Response.json(conversion(), { status: 201 });
        },
        random: counter(),
        now: () => Date.now(),
        sleep: async () => undefined,
        log: (message) => logs.push(message),
      },
      { timeoutMs: 300, expiredPageMs: 1_500 },
    );
    const settled = outcome.catch((error: unknown) => error);
    while (start === "") await sleep(5);
    const html = await (await fetch(start)).text();
    state =
      new URL(decode(/action="([^"]+)"/.exec(html)?.[1] ?? "")).searchParams.get("state") ?? "";
    await sleep(500); // past the hour, inside the expired page's time
    const origin = new URL(start).origin;
    for (const path of [new URL(start).pathname, `/callback?code=${CODE}&state=${state}`, "/x"]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(response.status, path).toBe(410);
      const text = await response.text();
      expect(text).toContain("This link has expired");
      expect(text).toContain("nothing was stored in your installation");
      expect(text).toContain("bootstrap.ts github-app");
      expect(text).toContain("Omnigent 01hs3f9q");
    }
    expect(logs.join("\n")).toContain("The browser's link says so until");
    const error = await settled;
    expect(error).toBeInstanceOf(GitHubAppRefusal);
    expect((error as Error).message).toBe(
      "no answer from GitHub within 1 second; nothing was changed. Run the step again",
    );
    expect(github).toEqual([]);
    expect(cloud.changes).toEqual([]);
    // Then the page is gone.
    await expect(fetch(start)).rejects.toThrow();
  });
});

describe("the progress page", () => {
  it("says the App is being stored while GitHub's answer is exchanged, and a repeated callback goes back to it", async () => {
    let answer: (response: Response) => void = () => undefined;
    const exchanged: string[] = [];
    let start = "";
    const cloud = new FakeCloud();
    const outcome = createGitHubApp(
      await accountPlan(),
      {
        cloud,
        openBrowser: (url) => {
          start = url;
        },
        githubApi: (url) => {
          exchanged.push(url);
          return new Promise<Response>((resolve) => {
            answer = resolve;
          });
        },
        random: counter(),
        now: () => Date.now(),
        sleep: async (ms) => {
          await sleep(Math.min(ms, 5));
        },
        log: () => undefined,
      },
      { timeoutMs: 5_000, finalPageMs: 2_000 },
    );
    while (start === "") await sleep(5);
    const html = await (await fetch(start)).text();
    const manifest = JSON.parse(
      decode(/name="manifest" value="([^"]+)"/.exec(html)?.[1] ?? "{}"),
    ) as Manifest;
    const state =
      new URL(decode(/action="([^"]+)"/.exec(html)?.[1] ?? "")).searchParams.get("state") ?? "";
    const back = new URL(manifest.redirect_url);
    back.searchParams.set("code", CODE);
    back.searchParams.set("state", state);
    const first = await fetch(back, { redirect: "manual" });
    expect(first.status).toBe(303);
    const status = new URL(first.headers.get("location") ?? "", back).toString();
    while (exchanged.length === 0) await sleep(5);
    const storing = await (await fetch(status, { redirect: "manual" })).text();
    expect(storing).toContain("Storing it in your installation");
    expect(storing).toContain('http-equiv="refresh"');
    // The callback once more (a reload): back to the progress page; nothing exchanged twice.
    const repeat = await fetch(back, { redirect: "manual" });
    expect(repeat.status).toBe(303);
    expect(new URL(repeat.headers.get("location") ?? "", back).toString()).toBe(status);
    answer(Response.json(conversion(), { status: 201 }));
    const progress = await follow(status);
    expect(progress.at(-1)?.status).toBe(302);
    expect(await outcome).toMatchObject({ kind: "on" });
    expect(exchanged).toHaveLength(1);
    expect(cloud.changes).toHaveLength(1);
  });

  it("names the organization's App settings on the expired page", async () => {
    let start = "";
    const outcome = createGitHubApp(
      await accountPlan(),
      {
        cloud: new FakeCloud(),
        openBrowser: (url) => {
          start = url;
        },
        githubApi: async () => Response.json(conversion(), { status: 201 }),
        random: counter(),
        now: () => Date.now(),
        sleep: async () => undefined,
        log: () => undefined,
      },
      { timeoutMs: 100, expiredPageMs: 1_000, org: "cfo-org" },
    );
    const settled = outcome.catch((error: unknown) => error);
    while (start === "") await sleep(5);
    await sleep(300);
    const text = await (await fetch(start)).text();
    expect(text).toContain("https://github.com/organizations/cfo-org/settings/apps");
    expect(await settled).toBeInstanceOf(GitHubAppRefusal);
  });
});

describe("the plain pages", () => {
  it("say durations in words", () => {
    expect(minutes(300)).toBe("1 second");
    expect(minutes(5_000)).toBe("5 seconds");
    expect(minutes(60_000)).toBe("1 minute");
    expect(minutes(20 * 60_000)).toBe("20 minutes");
    expect(minutes(DEFAULT_GITHUB_APP_TIMEOUT_MS)).toBe("an hour");
  });

  it("escape every value, and reload themselves only when asked", () => {
    const html = page("<t>", ["a & b", "<script>"], {
      link: { href: 'https://x.test/?a="b"', label: "<go>" },
      refreshS: 3,
    });
    expect(html).toContain("<title>&lt;t&gt;</title>");
    expect(html).toContain("<p>a &amp; b</p>");
    expect(html).toContain("<p>&lt;script&gt;</p>");
    expect(html).toContain('href="https://x.test/?a=&quot;b&quot;"');
    expect(html).toContain('<meta http-equiv="refresh" content="3">');
    expect(page("t", "x")).not.toContain("refresh");
  });

  it("never names a secret in the words for an outcome", async () => {
    const plan = await accountPlan();
    const base = {
      slug: "omnigent-01hs3f9q",
      installUrl: "https://github.com/apps/x/installations/new",
    };
    const outcomes: GitHubAppOutcome[] = [
      { kind: "off", ...base },
      { kind: "held", ...base },
      { kind: "waiting", why: "w", ...base },
    ];
    for (const outcome of outcomes) {
      const text = finalMessage(plan, outcome, "cfo-org").lines.join(" ");
      expect(text).toContain(plan.platformWorker);
      expect(text).not.toContain(CLIENT_SECRET);
      if (outcome.kind !== "waiting") {
        expect(text).toContain(
          "https://github.com/organizations/cfo-org/settings/apps/omnigent-01hs3f9q/advanced",
        );
      }
    }
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
