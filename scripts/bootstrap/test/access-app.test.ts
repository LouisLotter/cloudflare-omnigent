// The bootstrap creates the hostname's owner-only Access application (WP3.31, D35): every case
// against the fake Cloudflare, and through whole runs with a crash at every point.

import { describe, expect, it } from "vitest";
import { ACCESS_SAME_SITE, ownerOnlyAppBody } from "../access.ts";
import {
  ACCESS_SETTLE_MS,
  type AccessRecords,
  AccessRefusal,
  type EnsureAccessContext,
  ensureOwnerAccess,
} from "../access-app.ts";
import {
  BootstrapRefusal,
  type BootstrapState,
  type RunOptions,
  runBootstrap,
} from "../machine.ts";
import type { Installation } from "../settings.ts";
import { Crash, type CrashPoint, FakeWorld, MemoryStore } from "./fake-cloud.ts";
import { accountPlan, baseConfigs, freshState, OWNER_EMAIL, OWNER_PASSWORD } from "./fixtures.ts";

const HOST = "omnigent.example.test";
const TEAM = "team.cloudflareaccess.com";

/** An owner-only application as a person might have made it themselves. */
function theirs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...ownerOnlyAppBody({ name: "my omnigent", hostname: HOST, ownerEmail: OWNER_EMAIL }),
    ...overrides,
  };
}

interface Unit {
  readonly world: FakeWorld;
  records: AccessRecords;
  readonly history: AccessRecords[];
  readonly lines: string[];
  readonly slept: number[];
  ensure(overrides?: Partial<EnsureAccessContext>): Promise<{ teamDomain: string; aud: string }>;
}

async function unit(plan?: Installation): Promise<Unit> {
  const p = plan ?? (await accountPlan());
  const world = new FakeWorld(p);
  const u: Unit = {
    world,
    records: {},
    history: [],
    lines: [],
    slept: [],
    ensure: (overrides = {}) =>
      ensureOwnerAccess({
        api: world.accessApi(),
        plan: p,
        ownerEmail: ` ${OWNER_EMAIL.toUpperCase()} `,
        recorded: () => structuredClone(u.records),
        record: (records) => {
          u.records = structuredClone(records);
          u.history.push(u.records);
        },
        now: () => world.now,
        sleep: async (ms) => {
          u.slept.push(ms);
          world.now += ms;
        },
        nonce: () => "0a1b2c3d",
        log: (line) => u.lines.push(line),
        ...overrides,
      }),
  };
  return u;
}

/** The Access calls that change something. */
const changes = (world: FakeWorld) =>
  world.calls.filter((c) => c === "accessCreate" || c === "accessRemove" || c === "loginCreate");

describe("ensureOwnerAccess: the hostname has no Access application", () => {
  it("creates one owner-only application, records it before and after, and returns its AUD", async () => {
    const u = await unit();
    const settings = await u.ensure();
    const apps = [...u.world.accessApps.values()];
    expect(apps).toHaveLength(1);
    const [app] = apps;
    expect(app).toMatchObject({
      type: "self_hosted",
      name: "cloudflare-omnigent-web--0a1b2c3d",
      domain: HOST,
      session_duration: "24h",
      app_launcher_visible: false,
      same_site_cookie_attribute: ACCESS_SAME_SITE,
      // The account's one login method, without the chooser.
      allowed_idps: ["idp-onetimepin"],
      auto_redirect_to_identity: true,
      // The address as ingress pins it: trimmed and lowercased.
      policies: [
        { name: "Allow owner", decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] },
      ],
    });
    expect(app?.options_preflight_bypass).toBe(false);
    expect(settings).toEqual({ teamDomain: TEAM, aud: app?.aud });
    // The intent before the create, then the ID.
    expect(u.history).toEqual([
      { app: { name: "cloudflare-omnigent-web--0a1b2c3d", createStartedAt: expect.any(String) } },
      {
        app: {
          name: "cloudflare-omnigent-web--0a1b2c3d",
          id: app?.id,
          createdAt: expect.any(String),
        },
      },
    ]);
    // Read back by its ID after the create: what Access holds decides.
    expect(u.world.calls).toEqual([
      "accessOrg",
      "accessList",
      "loginList",
      "accessCreate",
      "accessGet",
      "accessList",
    ]);
    expect(u.lines.join("\n")).not.toMatch(/@/);
  });

  it("a second run reads the recorded application by its ID and creates nothing", async () => {
    const u = await unit();
    const first = await u.ensure();
    u.world.calls.length = 0;
    expect(await u.ensure()).toEqual(first);
    expect(changes(u.world)).toEqual([]);
    expect(u.world.calls).toEqual(["accessOrg", "accessGet", "accessList"]);
  });

  it("needs the owner's address, matched against the plan's pin, and creates nothing without it", async () => {
    const u = await unit();
    await expect(u.ensure({ ownerEmail: undefined })).rejects.toThrow(
      /has no Access application yet; .*run again with --owner-email <the owner's address>$/,
    );
    await expect(u.ensure({ ownerEmail: "  " })).rejects.toThrow(/--owner-email/);
    await expect(u.ensure({ ownerEmail: "someone-else@example.test" })).rejects.toThrow(
      "the address given with --owner-email is not the owner this installation was planned for",
    );
    expect(changes(u.world)).toEqual([]);
    expect(u.history).toEqual([]);
  });

  it("stops with the one step when the account has no Zero Trust organization", async () => {
    const u = await unit();
    u.world.teamDomain = undefined;
    const error = await u.ensure().catch((e: Error) => e);
    expect(error).toBeInstanceOf(AccessRefusal);
    expect((error as Error).message).toBe(
      "your Cloudflare account has no Zero Trust organization yet, which puts Access in front of Omnigent: open https://one.dash.cloudflare.com/, choose a team name and the Free plan (Cloudflare asks for a payment method even for the Free plan), then run again",
    );
    expect(u.world.calls).toEqual(["accessOrg"]);
  });

  it("a login that may not create applications (403): nothing in flight, and the dashboard step", async () => {
    const u = await unit();
    u.world.accessForbidden = true;
    const error = await u.ensure().catch((e: Error) => e);
    expect(error).toBeInstanceOf(AccessRefusal);
    expect((error as Error).message).toMatch(
      /^your cf login may not create Access applications \(Cloudflare answered 403 Forbidden\)\. In https:\/\/one\.dash\.cloudflare\.com\/, open Access, Applications, add a self-hosted application for omnigent\.example\.test with one Allow policy whose only rule is Emails with the owner's address, set its cookie's Same Site Attribute to Lax under Settings, and save it; then run again, and the bootstrap checks it\.$/,
    );
    expect(u.records).toEqual({});
    expect(u.world.accessApps.size).toBe(0);
    // The person makes it by hand; the next run checks it and uses it.
    u.world.accessForbidden = false;
    u.world.addAccessApp(theirs());
    await expect(u.ensure()).resolves.toMatchObject({ teamDomain: TEAM });
    expect(changes(u.world)).toEqual(["accessCreate"]);
  });

  it.each([
    [
      "several login methods: the application offers them all",
      [
        { id: "idp-a", type: "onetimepin" },
        { id: "idp-b", type: "github" },
      ],
      false,
      undefined,
    ],
    ["login methods it may not read (403): the application offers them all", [], true, undefined],
  ])("%s", async (_name, methods, forbidden, idps) => {
    const u = await unit();
    u.world.loginMethods = methods;
    u.world.loginsForbidden = forbidden;
    await u.ensure();
    const [app] = [...u.world.accessApps.values()];
    expect(app?.allowed_idps).toEqual(idps);
    expect(app?.auto_redirect_to_identity).toBeUndefined();
    expect(u.world.calls).not.toContain("loginCreate");
  });

  it("an account without a login method gets the one-time PIN method, recorded before and after", async () => {
    const u = await unit();
    u.world.loginMethods = [];
    await u.ensure();
    expect(u.world.loginMethods).toEqual([{ id: "idp-added-onetimepin", type: "onetimepin" }]);
    const [app] = [...u.world.accessApps.values()];
    expect(app?.allowed_idps).toEqual(["idp-added-onetimepin"]);
    expect(u.history[0]).toEqual({ loginMethod: { createStartedAt: expect.any(String) } });
    expect(u.history[1]).toEqual({
      loginMethod: { id: "idp-added-onetimepin", createdAt: expect.any(String) },
    });
    expect(u.records.loginMethod?.id).toBe("idp-added-onetimepin");
  });

  it("an add of the login method whose answer was lost is recognised; a refused one is a step", async () => {
    const u = await unit();
    u.world.loginMethods = [];
    u.world.crash = { call: "loginCreate", nth: 1, when: "after" };
    await expect(u.ensure()).rejects.toThrow(Crash);
    expect(u.records.loginMethod).toEqual({ createStartedAt: expect.any(String) });
    await u.ensure();
    expect(u.records.loginMethod).toEqual({
      id: "idp-added-onetimepin",
      createdAt: expect.any(String),
    });
    expect(u.world.loginMethods).toHaveLength(1);

    const refused = await unit();
    refused.world.loginMethods = [];
    refused.world.loginsForbidden = true;
    // Unreadable methods are offered all; with none listed and adding refused, a step.
    refused.world.loginsForbidden = false;
    const api = refused.world.accessApi();
    const error = await refused
      .ensure({
        api: {
          ...api,
          createOneTimePin: () => {
            refused.world.loginsForbidden = true;
            return api.createOneTimePin();
          },
        },
      })
      .catch((e: Error) => e);
    expect((error as Error).message).toBe(
      "your Zero Trust organization has no login method, and your cf login may not add one (403): open https://one.dash.cloudflare.com/, Settings, Authentication, add One-time PIN, then run again",
    );
    expect(refused.records).toEqual({});
    expect(refused.world.accessApps.size).toBe(0);
  });
});

describe("ensureOwnerAccess: an add of the login method left in flight", () => {
  it("waits out the settle time once before adding the one-time PIN method again", async () => {
    const u = await unit();
    u.world.loginMethods = [];
    u.records = { loginMethod: { createStartedAt: new Date(u.world.now - 60_000).toISOString() } };
    // It lands during the wait: no second add.
    u.world.before = {
      call: "loginList",
      nth: 2,
      run: () => {
        u.world.loginMethods = [{ id: "idp-late", type: "onetimepin" }];
      },
    };
    await u.ensure();
    expect(u.slept).toEqual([ACCESS_SETTLE_MS - 60_000]);
    expect(u.world.calls).not.toContain("loginCreate");
    expect(u.records.loginMethod).toEqual({ id: "idp-late", createdAt: expect.any(String) });
    // Nothing landed: added after the wait.
    const none = await unit();
    none.world.loginMethods = [];
    none.records = { loginMethod: { createStartedAt: new Date(none.world.now).toISOString() } };
    await none.ensure();
    expect(none.slept).toEqual([ACCESS_SETTLE_MS]);
    expect(none.world.calls.filter((c) => c === "loginCreate")).toHaveLength(1);
  });
});

describe("ensureOwnerAccess: an application someone else made", () => {
  it("uses a matching owner-only application as it is, without recording or changing it", async () => {
    const u = await unit();
    const id = u.world.addAccessApp(theirs());
    const before = structuredClone(u.world.accessApps.get(id));
    const settings = await u.ensure({ ownerEmail: undefined });
    expect(settings).toEqual({ teamDomain: TEAM, aud: before?.aud });
    expect(u.world.accessApps.get(id)).toEqual(before);
    expect(changes(u.world)).toEqual([]);
    expect(u.records).toEqual({});
    expect(u.lines).toEqual([
      `using the owner-only Access application "my omnigent" already on ${HOST}; the bootstrap did not create it and leaves it alone`,
    ]);
  });

  it("refuses one that differs, naming every difference and its fix, and never changes it", async () => {
    const u = await unit();
    const id = u.world.addAccessApp(
      theirs({
        same_site_cookie_attribute: "none",
        options_preflight_bypass: true,
        policies: [
          { name: "Allow owner", decision: "allow", include: [{ email: { email: OWNER_EMAIL } }] },
          { name: "Friends", decision: "allow", include: [{ email: { email: "x@example.test" } }] },
          { name: "Everyone", decision: "bypass", include: [{ everyone: {} }] },
        ],
      }),
    );
    const before = structuredClone(u.world.accessApps.get(id));
    const error = await u.ensure().catch((e: Error) => e);
    expect(error).toBeInstanceOf(AccessRefusal);
    expect((error as Error).message).toBe(
      `the Access application "my omnigent" on ${HOST}, which the bootstrap did not create, does not set its cookie to SameSite=lax; bypasses Access for CORS preflight; admits someone other than the owner; has a policy that is not an allow (a bypass or a service token). To fix it, open https://one.dash.cloudflare.com/, Access, Applications, edit it, and under Settings, Cookie settings, set Same Site Attribute to Lax; under Settings, CORS settings, turn off Bypass options requests to origin; remove every address but the owner's from the policy "Friends"; remove the policy "Everyone", or delete it and run again: the bootstrap then creates an owner-only one itself. The bootstrap never changes or widens an application it did not create`,
    );
    expect((error as Error).message).not.toMatch(/@/);
    expect(u.world.accessApps.get(id)).toEqual(before);
    expect(changes(u.world)).toEqual([]);
    expect(u.records).toEqual({});
  });

  it.each([
    ["a path on the hostname", { domain: `${HOST}/admin` }, /does not cover exactly omnigent/],
    ["not self-hosted", { type: "saas" }, /is not a self-hosted application/],
    ["no policy", { policies: [] }, /has no policy/],
    [
      "everyone",
      { policies: [{ decision: "allow", include: [{ everyone: {} }] }] },
      /other than one email/,
    ],
  ])("refuses %s", async (_name, overrides, message) => {
    const u = await unit();
    u.world.addAccessApp(theirs(overrides));
    await expect(u.ensure()).rejects.toThrow(message);
    expect(changes(u.world)).toEqual([]);
  });

  it("refuses two applications on the hostname, even owner-only ones", async () => {
    const u = await unit();
    u.world.addAccessApp(theirs());
    u.world.addAccessApp(theirs({ name: "second" }));
    await expect(u.ensure()).rejects.toThrow(
      `2 Access applications cover ${HOST} ("my omnigent", "second"), which the bootstrap did not create: keep exactly one, owner-only, or delete them all and run again, and the bootstrap creates it (https://one.dash.cloudflare.com/, Access, Applications)`,
    );
    expect(changes(u.world)).toEqual([]);
  });
});

describe("ensureOwnerAccess: what covers the hostname, from every application (Codex r1-1)", () => {
  it("refuses a bypass on a path of the hostname beside an owner-only application", async () => {
    const u = await unit();
    u.world.addAccessApp(theirs());
    u.world.addAccessApp({
      type: "self_hosted",
      name: "admin bypass",
      domain: `${HOST}/admin`,
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });
    await expect(u.ensure()).rejects.toThrow(
      `2 Access applications cover ${HOST} ("my omnigent", "admin bypass")`,
    );
    // Beside the application this installation created, too.
    const ours = await unit();
    await ours.ensure();
    ours.world.addAccessApp({
      type: "self_hosted",
      name: "admin bypass",
      domain: "elsewhere.example.test",
      destinations: [{ type: "public", uri: `${HOST}/admin` }],
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });
    await expect(ours.ensure()).rejects.toThrow(
      /another covers omnigent\.example\.test \("admin bypass"\)/,
    );
  });

  it("ignores other hostnames, and names a wildcard that also covers it without refusing", async () => {
    const u = await unit();
    u.world.addAccessApp(theirs({ name: "other", domain: "other.example.test" }));
    u.world.addAccessApp(theirs({ name: "suffix", domain: `x${HOST}` }));
    u.world.addAccessApp(theirs({ name: "deeper", domain: `*.${HOST}` }));
    u.world.addAccessApp({ type: "self_hosted", name: "catch-all", domain: "*.example.test" });
    await u.ensure();
    expect(u.world.accessApps.size).toBe(5);
    expect(u.lines.at(-1)).toBe(
      `"catch-all" also covers ${HOST} through a wildcard; if Access applies it to a path instead of this installation's application, the owner is kept out there (no one else is let in)`,
    );
    // Someone else's owner-only application, with the same note.
    const theirsToo = await unit();
    theirsToo.world.addAccessApp(theirs());
    theirsToo.world.addAccessApp({ type: "self_hosted", name: "a", domain: "omni*.example.test" });
    theirsToo.world.addAccessApp({ type: "self_hosted", name: "b", domain: "*.example.test/x" });
    await theirsToo.ensure({ ownerEmail: undefined });
    expect(theirsToo.lines.at(-1)).toMatch(
      /^"a", "b" also cover omnigent\.example\.test through a wildcard/,
    );
  });
});

describe("ensureOwnerAccess: the application it created, later", () => {
  it("creates it again when a person deleted it (the web Worker is not deployed yet)", async () => {
    const u = await unit();
    await u.ensure();
    const first = u.records.app?.id;
    u.world.accessApps.clear();
    await u.ensure();
    expect(u.records.app?.id).not.toBe(first);
    expect(u.world.accessApps.size).toBe(1);
    expect(u.lines.some((l) => l.includes("is gone; creating it again"))).toBe(true);
  });

  it("refuses it once a person widened it, and leaves it as it is", async () => {
    const u = await unit();
    await u.ensure();
    const id = String(u.records.app?.id);
    const widened = {
      ...u.world.accessApps.get(id),
      policies: [{ name: "Allow owner", decision: "allow", include: [{ everyone: {} }] }],
    };
    u.world.accessApps.set(id, structuredClone(widened));
    await expect(u.ensure()).rejects.toThrow(
      /^the Access application "cloudflare-omnigent-web--0a1b2c3d" on omnigent\.example\.test, which this installation created, admits something other than one email address\./,
    );
    expect(u.world.accessApps.get(id)).toEqual(widened);
    expect(changes(u.world)).toEqual(["accessCreate"]);
  });

  it("refuses another application that appears on the hostname beside it", async () => {
    const u = await unit();
    await u.ensure();
    u.world.addAccessApp(theirs({ name: "intruder" }));
    await expect(u.ensure()).rejects.toThrow(
      `besides this installation's Access application "cloudflare-omnigent-web--0a1b2c3d", another covers ${HOST} ("intruder") and could decide instead of it`,
    );
  });

  it("refuses what Access holds after the create when it is not what was sent", async () => {
    const u = await unit();
    u.world.before = {
      call: "accessGet",
      nth: 1,
      run: () => {
        for (const app of u.world.accessApps.values()) app.same_site_cookie_attribute = "none";
      },
    };
    await expect(u.ensure()).rejects.toThrow(
      /which this installation created, does not set its cookie/,
    );
    // Recorded: removal can still find it.
    expect(u.records.app?.id).toBeDefined();
  });
});

describe("ensureOwnerAccess: Cloudflare misbehaving", () => {
  it("stops when the application is not there right after its create, and keeps it recorded", async () => {
    const u = await unit();
    u.world.before = { call: "accessGet", nth: 1, run: () => u.world.accessApps.clear() };
    await expect(u.ensure()).rejects.toThrow(
      'the Access application "cloudflare-omnigent-web--0a1b2c3d" is not there after its create; run again',
    );
    expect(u.records.app?.id).toBeDefined();
    // The next run finds it gone and creates it again.
    await u.ensure();
    expect(u.world.accessApps.size).toBe(1);
  });

  it("an intent without a readable start time is resolved at once, never waited on", async () => {
    const u = await unit();
    u.records = { app: { name: "cloudflare-omnigent-web--99999999" } };
    await u.ensure();
    expect(u.slept).toEqual([]);
    expect(u.records.app?.name).toBe("cloudflare-omnigent-web--0a1b2c3d");
  });

  it("never names an unnamed application by anything but that", async () => {
    const u = await unit();
    u.world.addAccessApp(theirs({ name: undefined, type: "saas" }));
    await expect(u.ensure()).rejects.toThrow(/the Access application "unnamed" on/);
  });

  it("passes on errors that are not refusals: a failed listing, a failed create", async () => {
    const u = await unit();
    const api = u.world.accessApi();
    await expect(
      u.ensure({
        api: {
          ...api,
          identityProviders: () => {
            throw new Error("cf zero-trust identity-providers failed: timeout");
          },
        },
      }),
    ).rejects.toThrow(/timeout/);
    await expect(
      u.ensure({
        api: {
          ...api,
          create: () => {
            throw new Error("cf zero-trust access applications failed: timeout");
          },
        },
      }),
    ).rejects.toThrow(/timeout/);
    // A create that failed otherwise may still land: its intent stays.
    expect(u.records.app?.createStartedAt).toBeDefined();
    const login = await unit();
    login.world.loginMethods = [];
    const loginApi = login.world.accessApi();
    await expect(
      login.ensure({
        api: {
          ...loginApi,
          createOneTimePin: () => {
            throw new Error("cf zero-trust identity-providers failed: timeout");
          },
        },
      }),
    ).rejects.toThrow(/timeout/);
    await expect(
      (await unit()).ensure({ plan: { ...(await accountPlan()), ownerPin: "broken" } }),
    ).rejects.toThrow("the plan's owner pin is malformed");
  });
});

describe("ensureOwnerAccess: a create whose answer was lost", () => {
  it("adopts the application that landed, by the create's name, without waiting", async () => {
    const u = await unit();
    u.world.crash = { call: "accessCreate", nth: 1, when: "after" };
    await expect(u.ensure()).rejects.toThrow(Crash);
    expect(u.records.app).toEqual({
      name: "cloudflare-omnigent-web--0a1b2c3d",
      createStartedAt: expect.any(String),
    });
    await u.ensure();
    expect(u.slept).toEqual([]);
    expect(u.world.accessApps.size).toBe(1);
    expect(u.records.app?.id).toBe([...u.world.accessApps.keys()][0]);
    expect(changes(u.world)).toEqual(["accessCreate"]);
  });

  it("waits out the settle time once, then creates anew when nothing landed", async () => {
    const u = await unit();
    u.world.crash = { call: "accessCreate", nth: 1, when: "before" };
    await expect(u.ensure()).rejects.toThrow(Crash);
    u.world.now += 60_000;
    await u.ensure({ nonce: () => "4e5f6a7b" });
    expect(u.slept).toEqual([ACCESS_SETTLE_MS - 60_000]);
    expect([...u.world.accessApps.values()].map((a) => a.name)).toEqual([
      "cloudflare-omnigent-web--4e5f6a7b",
    ]);
    expect(u.records.app?.name).toBe("cloudflare-omnigent-web--4e5f6a7b");
    // Long after: no wait at all.
    const late = await unit();
    late.world.crash = { call: "accessCreate", nth: 1, when: "before" };
    await expect(late.ensure()).rejects.toThrow(Crash);
    late.world.now += ACCESS_SETTLE_MS;
    await late.ensure();
    expect(late.slept).toEqual([]);
  });

  it("adopts a create that lands during the wait", async () => {
    const u = await unit();
    u.world.late = { call: "accessCreate", nth: 1, afterMs: 120_000 };
    await expect(u.ensure()).rejects.toThrow(/timeout/);
    await u.ensure();
    expect(u.slept).toEqual([ACCESS_SETTLE_MS]);
    expect(u.world.accessApps.size).toBe(1);
    expect(changes(u.world)).toEqual(["accessCreate"]);
    expect(u.lines.some((l) => l.includes("created by an interrupted run, is recorded now"))).toBe(
      true,
    );
  });

  it("refuses two applications carrying one create's name", async () => {
    const u = await unit();
    u.records = {
      app: {
        name: "cloudflare-omnigent-web--0a1b2c3d",
        createStartedAt: new Date(u.world.now).toISOString(),
      },
    };
    u.world.addAccessApp(theirs({ name: "cloudflare-omnigent-web--0a1b2c3d" }));
    u.world.addAccessApp(theirs({ name: "cloudflare-omnigent-web--0a1b2c3d" }));
    await expect(u.ensure()).rejects.toThrow(
      /2 Access applications on omnigent\.example\.test are named/,
    );
  });
});

// Whole runs: Access first, then the deploys; a crash at any point leaves exactly one owner-only
// application of this installation, recorded, and the web Worker behind its AUD.

const OPTIONS: RunOptions = {
  waitMs: 30 * 60_000,
  pollMs: 30_000,
  verify: true,
  switchMs: 330_000,
  verifyWaitMs: 10 * 60_000,
};

function runner(plan: Installation, state: BootstrapState = freshState(plan)) {
  const world = new FakeWorld(plan);
  const store = new MemoryStore(state);
  const lines: string[] = [];
  let nonces = 0;
  const run = (withEmail = true) =>
    runBootstrap(
      {
        cloud: world.cloud(),
        store,
        baseConfigs: baseConfigs(),
        secrets: () => ({
          ownerPassword: OWNER_PASSWORD,
          replicaAccessKeyId: "cfo-canary-replica-key-id",
          replicaSecretAccessKey: "cfo-canary-replica-secret-key",
        }),
        accessApi: world.accessApi(),
        ...(withEmail ? { ownerEmail: OWNER_EMAIL } : {}),
        // A fresh nonce for each create.
        random: (n) => new Uint8Array(n).fill(n === 4 ? nonces++ : 0xab),
        now: () => world.now,
        sleep: async (ms) => {
          world.now += Math.max(0, ms);
        },
        log: (line) => lines.push(line),
      },
      OPTIONS,
    );
  return { world, store, lines, run };
}

/** The web Worker's last configuration names the one application's AUD and team domain. */
function expectBehindTheApplication(world: FakeWorld, store: MemoryStore): void {
  const apps = [...world.accessApps.values()];
  expect(apps).toHaveLength(1);
  const [app] = apps;
  expect(store.state.journal.accessApp?.id).toBe(app?.id);
  const vars = world.configs.get(world.plan.webWorker)?.at(-1)?.vars as Record<string, unknown>;
  expect(vars.ACCESS_AUD).toBe(app?.aud);
  expect(vars.ACCESS_TEAM_DOMAIN).toBe(TEAM);
  expect(app?.same_site_cookie_attribute).toBe("lax");
}

describe("runBootstrap with Access in the installer's account", () => {
  it("creates Access before anything is deployed, and puts the web Worker behind it", async () => {
    const plan = await accountPlan();
    const r = runner(plan);
    expect(await r.run()).toEqual({ kind: "done" });
    const order = r.world.calls.filter((c) =>
      ["accessCreate", "deployPlatform", "deployWeb", "updateSecrets"].includes(c),
    );
    expect(order).toEqual(["accessCreate", "deployPlatform", "deployWeb", "updateSecrets"]);
    expectBehindTheApplication(r.world, r.store);
    // Checked again just before the web deploy: read by its ID.
    const beforeWeb = r.world.calls.slice(0, r.world.calls.indexOf("deployWeb"));
    expect(beforeWeb.filter((c) => c === "accessGet")).toHaveLength(2);
    expect(JSON.stringify(r.store.state)).not.toContain(OWNER_EMAIL);
    expect(r.lines.join("\n")).not.toContain(OWNER_EMAIL);
    // Run again: nothing changes.
    const created = r.world.calls.filter((c) => c === "accessCreate").length;
    expect(await r.run()).toEqual({ kind: "done" });
    expect(r.world.calls.filter((c) => c === "accessCreate")).toHaveLength(created);
  });

  it("stops before any deploy when Access cannot be made, and continues once it can", async () => {
    const plan = await accountPlan();
    const r = runner(plan);
    r.world.teamDomain = undefined;
    await expect(r.run()).rejects.toThrow(BootstrapRefusal);
    await expect(r.run()).rejects.toThrow(/no Zero Trust organization/);
    expect(r.world.calls).not.toContain("deployPlatform");
    r.world.teamDomain = TEAM;
    await expect(r.run(false)).rejects.toThrow(/--owner-email/);
    expect(r.world.calls).not.toContain("deployPlatform");
    expect(await r.run()).toEqual({ kind: "done" });
    expectBehindTheApplication(r.world, r.store);
  });

  it("an installation whose web Worker is deployed reads no Access at all", async () => {
    const plan = await accountPlan();
    const r = runner(plan);
    expect(await r.run()).toEqual({ kind: "done" });
    r.world.calls.length = 0;
    r.world.teamDomain = undefined;
    expect(await r.run(false)).toEqual({ kind: "done" });
    expect(r.world.calls.filter((c) => c.startsWith("access"))).toEqual([]);
  });
});

const ACCESS_CALLS = [
  "accessOrg",
  "accessList",
  "accessGet",
  "accessCreate",
  "loginList",
  "loginCreate",
];
const ACCESS_CRASH_POINTS: (CrashPoint | { journal: number })[] = [
  ...ACCESS_CALLS.flatMap((call) =>
    [1, 2, 3].flatMap((nth) => (["before", "after"] as const).map((when) => ({ call, nth, when }))),
  ),
  ...[...ACCESS_CALLS, "deployPlatform", "deployWeb"].map((call) => ({
    call,
    nth: 1,
    when: "after" as const,
  })),
  ...Array.from({ length: 10 }, (_, i) => ({ journal: i + 1 })),
];

describe("runBootstrap with Access: a crash at any point", () => {
  it.each(
    ACCESS_CRASH_POINTS.flatMap((p) =>
      [true, false].map(
        (logins) => [JSON.stringify(p), logins ? "a login method" : "none", p, logins] as const,
      ),
    ),
  )(
    "%s, %s: a new run finishes with exactly one owner-only application, recorded",
    async (_name, _l, point, logins) => {
      const plan = await accountPlan();
      const r = runner(plan);
      if (!logins) r.world.loginMethods = [];
      if ("journal" in point) r.store.crash = { nth: point.journal };
      else r.world.crash = point;
      try {
        await r.run();
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
      }
      r.world.now += 60_000;
      let outcome = await r.run();
      if (outcome.kind !== "done") outcome = await r.run();
      expect(outcome).toEqual({ kind: "done" });
      expectBehindTheApplication(r.world, r.store);
      expect(r.world.loginMethods.filter((m) => m.type === "onetimepin")).toHaveLength(1);
      expect(r.world.released()).toBe(true);
    },
  );
});
