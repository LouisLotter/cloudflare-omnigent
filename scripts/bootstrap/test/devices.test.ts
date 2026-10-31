// The devices step (WP3.43): the owner's personal machines through the Cloudflare One Client.
// Every case runs against a fake Zero Trust whose updates of the organization and of an
// application replace the whole object, as Cloudflare's PUT does: a field the step leaves out is
// lost, and a field Cloudflare only reports is refused. The command runs on a real state file.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult } from "../../staging/cloud.ts";
import { ownerOnlyAppBody } from "../access.ts";
import {
  ACCESS_SETTLE_MS,
  AccessRefusal,
  AccessUnavailable,
  type IdentityProvider,
} from "../access-app.ts";
import { cfDevicesApi } from "../cloud.ts";
import {
  cloudflareDuration,
  type DevicesApi,
  type DevicesContext,
  type DevicesRecord,
  devicesNextSteps,
  devicesStatus,
  durationMinutes,
  ensureDevices,
  sessionDuration,
  writableApp,
} from "../devices.ts";
import { devicesCommand, devicesLockPath } from "../devices-command.ts";
import { BootstrapRefusal } from "../machine.ts";
import type { Installation } from "../settings.ts";
import { fileStateStore, parseState, stateVersionFor } from "../state.ts";
import { accountPlan, freshState, OWNER_EMAIL, stagingPlan } from "./fixtures.ts";

const HOST = "omnigent.example.test";
const TEAM = "team.cloudflareaccess.com";
const APP_ID = "app-installation";
const AUD = "a".repeat(64);

class Crash extends Error {}

type Call =
  | "organization"
  | "updateOrganization"
  | "apps"
  | "app"
  | "createApp"
  | "updateApp"
  | "identityProviders"
  | "defaultProfile"
  | "updateDefaultProfile"
  | "customProfiles"
  | "teamDomain";

const WRITES: readonly Call[] = [
  "updateOrganization",
  "createApp",
  "updateApp",
  "updateDefaultProfile",
];

/** A Zero Trust account as the owner's looked on 31 October: nothing for devices yet. */
class FakeZeroTrust implements DevicesApi {
  now = Date.UTC(2026, 9, 31, 12, 0, 0);
  team: string | undefined = TEAM;
  organizationValue: Record<string, unknown> = {
    allow_authenticate_via_warp: false,
    auth_domain: TEAM,
    cache_device_posture: false,
    created_at: "2026-10-01T00:00:00Z",
    deny_unmatched_requests: false,
    deny_unmatched_requests_exempted_zone_names: [],
    disable_end_user_app_creation: false,
    has_migrated_private_apps: true,
    is_ui_read_only: false,
    login_design: { background_color: "#000000" },
    name: TEAM,
    service_token_inactivity: { action: "disable", enabled: false },
    session_duration: "8h",
    strict_service_token_auth: true,
    trusted_accounts: [],
    updated_at: "2026-10-01T00:00:00Z",
    warp_auth_non_browser_401: false,
  };
  readonly appsById = new Map<string, Record<string, unknown>>();
  idps: IdentityProvider[] = [{ id: "idp-otp", type: "onetimepin" }];
  profile: Record<string, unknown> = {
    default: true,
    service_mode_v2: { mode: "warp" },
    tunnel_protocol: "masque",
    exclude: [
      { address: "10.0.0.0/8" },
      { address: "100.64.0.0/10", description: "CGNAT" },
      { host: "corp.example.test", description: "a person's own" },
    ],
  };
  custom = 0;
  readonly calls: Call[] = [];
  readonly forbidden = new Set<Call>();
  /** A write that takes effect and whose answer is lost. */
  crashAfter: { call: Call; nth: number } | undefined;
  /** A write that is lost before it reaches Cloudflare. */
  crashBefore: { call: Call; nth: number } | undefined;
  /** A create whose answer is lost and which lands only after this long (or never: undefined). */
  lateCreate: { afterMs: number | undefined } | undefined;
  readonly #landing: { due: number; apply: () => void }[] = [];
  /** Cloudflare drops this organization field on an update (a field the PUT does not keep). */
  dropsOnUpdate: string | undefined;
  /** Cloudflare gives the application a new AUD on an update. */
  newAudOnUpdate = false;
  /** Cloudflare keeps the exclude list after the PATCH (still exclude mode). */
  keepsExclude = false;
  #next = 1;
  readonly #counts = new Map<Call, number>();

  constructor() {
    this.appsById.set(APP_ID, this.withReported(this.installationApp(), APP_ID, AUD));
  }

  installationApp(): Record<string, unknown> {
    return {
      ...ownerOnlyAppBody({
        name: "cloudflare-omnigent-web--0a1b2c3d",
        hostname: HOST,
        ownerEmail: OWNER_EMAIL,
        identityProviderId: "idp-otp",
      }),
      options_preflight_bypass: false,
      enable_binding_cookie: false,
      http_only_cookie_attribute: true,
      self_hosted_domains: [HOST],
      destinations: [{ type: "public", uri: HOST }],
      tags: [],
    };
  }

  withReported(app: Record<string, unknown>, id: string, aud?: string): Record<string, unknown> {
    const policies = Array.isArray(app.policies) ? app.policies : [];
    return {
      ...app,
      id,
      uid: id,
      ...(aud === undefined ? {} : { aud }),
      created_at: "2026-10-20T00:00:00Z",
      updated_at: new Date(this.now).toISOString(),
      policies: policies.map((p: Record<string, unknown>, i: number) => ({
        id: typeof p.id === "string" ? p.id : `pol-${this.#next++}`,
        uid: "u",
        precedence: i + 1,
        reusable: false,
        exclude: [],
        require: [],
        created_at: "2026-10-20T00:00:00Z",
        updated_at: "2026-10-20T00:00:00Z",
        ...p,
      })),
    };
  }

  /** Lands what a lost create made, once its time has come. */
  #settle(): void {
    for (const pending of this.#landing.splice(0)) {
      if (pending.due <= this.now) pending.apply();
      else this.#landing.push(pending);
    }
  }

  #call<T>(name: Call, effect: () => T): T {
    this.#settle();
    const n = (this.#counts.get(name) ?? 0) + 1;
    this.#counts.set(name, n);
    this.calls.push(name);
    if (this.forbidden.has(name)) throw new AccessUnavailable("Cloudflare refused (403)");
    if (this.crashBefore?.call === name && this.crashBefore.nth === n) {
      throw new Crash(`lost before ${name}`);
    }
    const result = effect();
    if (this.crashAfter?.call === name && this.crashAfter.nth === n) {
      throw new Crash(`lost after ${name}`);
    }
    return result;
  }

  teamDomain = () => this.#call("teamDomain", () => this.team);
  organization = () => this.#call("organization", () => structuredClone(this.organizationValue));
  updateOrganization = (body: Record<string, unknown>) =>
    this.#call("updateOrganization", () => {
      for (const key of ["created_at", "updated_at"]) {
        if (key in body) throw new Error(`[12000] ${key} is read-only`);
      }
      // A PUT: what is not sent is gone.
      const next: Record<string, unknown> = {
        ...structuredClone(body),
        created_at: this.organizationValue.created_at,
        updated_at: new Date(this.now).toISOString(),
      };
      if (this.dropsOnUpdate !== undefined) delete next[this.dropsOnUpdate];
      this.organizationValue = next;
    });
  apps = () => this.#call("apps", () => [...this.appsById.values()].map((a) => structuredClone(a)));
  app = (id: string) => this.#call("app", () => structuredClone(this.appsById.get(id)));
  createApp = (body: Record<string, unknown>) => {
    const id = `app-${this.#next++}`;
    const make = () => {
      this.appsById.set(id, this.withReported(structuredClone(body), id));
    };
    if (this.lateCreate !== undefined) {
      const { afterMs } = this.lateCreate;
      this.lateCreate = undefined;
      return this.#call("createApp", () => {
        if (afterMs !== undefined) this.#landing.push({ due: this.now + afterMs, apply: make });
        throw new Error("cf zero-trust access applications create failed: timeout");
      });
    }
    return this.#call("createApp", () => {
      make();
      return id;
    });
  };
  updateApp = (id: string, body: Record<string, unknown>) =>
    this.#call("updateApp", () => {
      const before = this.appsById.get(id);
      if (before === undefined) throw new Error("[11021] not found");
      for (const key of ["id", "aud", "uid", "created_at", "updated_at"]) {
        if (key in body) throw new Error(`[12000] ${key} is read-only`);
      }
      for (const p of (body.policies ?? []) as Record<string, unknown>[]) {
        for (const key of ["uid", "created_at", "updated_at", "reusable"]) {
          if (key in p) throw new Error(`[12000] policy ${key} is read-only`);
        }
      }
      const aud = this.newAudOnUpdate ? "b".repeat(64) : (before.aud as string | undefined);
      this.appsById.set(id, this.withReported(structuredClone(body), id, aud));
    });
  identityProviders = () => this.#call("identityProviders", () => this.idps.map((p) => ({ ...p })));
  defaultProfile = () => this.#call("defaultProfile", () => structuredClone(this.profile));
  updateDefaultProfile = (patch: Record<string, unknown>) =>
    this.#call("updateDefaultProfile", () => {
      if ("include" in patch && "exclude" in patch) throw new Error("both include and exclude");
      if (Array.isArray(patch.include)) {
        this.profile = { ...this.profile, include: structuredClone(patch.include) };
        if (!this.keepsExclude) delete this.profile.exclude;
      }
    });
  customProfiles = () => this.#call("customProfiles", () => this.custom);

  writes(): Call[] {
    return this.calls.filter((c) => WRITES.includes(c));
  }

  enrollmentApps(): Record<string, unknown>[] {
    return [...this.appsById.values()].filter((a) => a.type === "warp");
  }
}

interface Harness {
  readonly zt: FakeZeroTrust;
  record: DevicesRecord;
  readonly lines: string[];
  readonly slept: number[];
  run(overrides?: Partial<DevicesContext>): ReturnType<typeof ensureDevices>;
}

async function harness(plan?: Installation, zt = new FakeZeroTrust()): Promise<Harness> {
  const p = plan ?? (await accountPlan());
  const h: Harness = {
    zt,
    record: {},
    lines: [],
    slept: [],
    run: (overrides = {}) =>
      ensureDevices({
        api: zt,
        plan: p,
        accessApp: { name: "cloudflare-omnigent-web--0a1b2c3d", id: APP_ID },
        ownerEmail: ` ${OWNER_EMAIL.toUpperCase()} `,
        recorded: () => structuredClone(h.record),
        record: (r) => {
          h.record = structuredClone(r);
        },
        now: () => zt.now,
        sleep: async (ms) => {
          h.slept.push(ms);
          zt.now += ms;
        },
        nonce: () => "5e6f7a8b",
        log: (line) => h.lines.push(line),
        ...overrides,
      }),
  };
  return h;
}

const refusal = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccessRefusal) return error.message;
    throw error;
  }
  throw new Error("expected a refusal");
};

const hostsOf = (routes: unknown) => (routes as { host?: string }[]).map((r) => r.host);

describe("ensureDevices: the owner's account as it is today", () => {
  it("sets all four, writing back the organization and the application whole", async () => {
    const h = await harness();
    const before = structuredClone(h.zt.organizationValue);
    const outcome = await h.run();
    expect(outcome).toMatchObject({ teamDomain: TEAM, team: "team", sessionDuration: "720h" });
    expect(outcome.changed).toHaveLength(4);

    // 1. Only this installation's application, with everything else it had.
    const app = h.zt.appsById.get(APP_ID) as Record<string, unknown>;
    expect(app.allow_authenticate_via_warp).toBe(true);
    expect(app.aud).toBe(AUD);
    expect(app.same_site_cookie_attribute).toBe("lax");
    expect(app.self_hosted_domains).toEqual([HOST]);
    expect(app.allowed_idps).toEqual(["idp-otp"]);
    expect((app.policies as { id: string }[]).map((p) => p.id)).toEqual(["pol-1"]);

    // 2. The organization: its two fields; the rest as it was; never every application.
    const org = h.zt.organizationValue;
    expect(org.warp_auth_session_duration).toBe("720h");
    expect(org.warp_auth_non_browser_401).toBe(true);
    expect(org.allow_authenticate_via_warp).toBe(false);
    for (const key of Object.keys(before)) {
      if (["updated_at", "warp_auth_non_browser_401"].includes(key)) continue;
      expect(org[key], key).toEqual(before[key]);
    }

    // 3. Owner-only enrollment, with the installation's login method.
    const [enrollment, ...more] = h.zt.enrollmentApps();
    expect(more).toHaveLength(0);
    expect(enrollment).toMatchObject({
      type: "warp",
      name: "cloudflare-omnigent-web-devices--5e6f7a8b",
      allowed_idps: ["idp-otp"],
      auto_redirect_to_identity: true,
    });
    expect(
      ((enrollment?.policies ?? []) as Record<string, unknown>[]).map((p) => [
        p.decision,
        p.include,
      ]),
    ).toEqual([["allow", [{ email: { email: OWNER_EMAIL } }]]]);

    // 4. The split tunnel: the hostname and the sign-in domain only; the old list kept.
    expect(hostsOf(h.zt.profile.include)).toEqual([HOST, TEAM]);
    expect(h.zt.profile.exclude).toBeUndefined();
    expect(h.zt.profile.tunnel_protocol).toBe("masque");
    expect(h.record.previousSplitTunnel?.entries).toHaveLength(3);

    expect(h.record).toMatchObject({
      enrollment: { name: "cloudflare-omnigent-web-devices--5e6f7a8b", id: "app-2" },
      sessionDuration: "720h",
    });
    for (const key of [
      "appStartedAt",
      "appChangedAt",
      "organizationStartedAt",
      "organizationChangedAt",
      "splitTunnelStartedAt",
      "splitTunnelChangedAt",
      "checkedAt",
    ] as const) {
      expect(h.record[key], key).toBeDefined();
    }
    // The owner's address is in Cloudflare's policy, never in the record or the lines.
    expect(JSON.stringify(h.record)).not.toContain(OWNER_EMAIL);
    expect(h.lines.join("\n")).not.toContain(OWNER_EMAIL);
  });

  it("changes nothing when run again, and needs no address then", async () => {
    const h = await harness();
    await h.run();
    const writes = h.zt.writes().length;
    const again = await h.run({ ownerEmail: undefined });
    expect(again.changed).toEqual([]);
    expect(h.zt.writes()).toHaveLength(writes);
  });

  it("never touches another application", async () => {
    const zt = new FakeZeroTrust();
    const other = zt.withReported(
      {
        ...ownerOnlyAppBody({
          name: "other",
          hostname: "other.example.test",
          ownerEmail: OWNER_EMAIL,
        }),
        aud: "c".repeat(64),
      },
      "app-other",
      "c".repeat(64),
    );
    zt.appsById.set("app-other", other);
    const h = await harness(undefined, zt);
    await h.run();
    expect(zt.appsById.get("app-other")).toEqual(other);
  });

  it("refuses a staging installation, and an account without a Zero Trust organization", async () => {
    const staged = await harness(await stagingPlan());
    expect(await refusal(staged.run())).toContain("own account");
    expect(staged.zt.calls).toEqual([]);
    const h = await harness();
    h.zt.team = undefined;
    expect(await refusal(h.run())).toContain("no Zero Trust organization");
    expect(h.zt.writes()).toEqual([]);
  });

  it("refuses a malformed pin and a session out of range before any call", async () => {
    const bad = await harness(await accountPlan({ ownerPin: "nope" }));
    await expect(bad.run()).rejects.toThrow("owner pin is malformed");
    const h = await harness();
    for (const session of ["0d", "91d", "2161h", "1.5d", "two", "30s", "", "0m"]) {
      await expect(h.run({ session }), session).rejects.toThrow("at most 90 days");
    }
    expect(h.zt.calls).toEqual([]);
    expect(sessionDuration("90d")).toBe("2160h");
    expect(sessionDuration(" 15m ")).toBe("15m");
    expect(sessionDuration("2h45m")).toBe("2h45m");
    expect(sessionDuration("90m")).toBe("1h30m");
    expect(sessionDuration("120s")).toBe("2m");
  });

  it("reads Cloudflare's duration forms, Go's included, as the same session", () => {
    expect(durationMinutes("720h")).toBe(43_200);
    expect(durationMinutes("720h0m0s")).toBe(43_200);
    expect(durationMinutes("30d")).toBe(43_200);
    expect(durationMinutes("2h45m")).toBe(165);
    expect(durationMinutes("45m30s")).toBeUndefined();
    expect(durationMinutes("1h-5m")).toBeUndefined();
    expect(cloudflareDuration(0)).toBe("0m");
    expect(cloudflareDuration(60)).toBe("1h");
  });
});

describe("ensureDevices: the installation's Access application", () => {
  it("uses one someone else made only when it already allows the client, never changing it", async () => {
    const h = await harness();
    const refused = await refusal(h.run({ accessApp: undefined }));
    expect(refused).toContain("was not created by the bootstrap");
    expect(refused).toContain("Authenticate with Cloudflare One Client");
    expect(h.zt.writes()).toEqual([]);
    (h.zt.appsById.get(APP_ID) as Record<string, unknown>).allow_authenticate_via_warp = true;
    await h.run({ accessApp: undefined });
    expect(h.zt.calls.filter((c) => c === "updateApp")).toHaveLength(0);
  });

  it("refuses when none or several cover the hostname and none is recorded", async () => {
    const h = await harness();
    h.zt.appsById.delete(APP_ID);
    expect(await refusal(h.run({ accessApp: undefined }))).toContain("found 0");
  });

  it("refuses when the recorded one is gone, or is not owner-only, or binds its cookie", async () => {
    const gone = await harness();
    gone.zt.appsById.delete(APP_ID);
    expect(await refusal(gone.run())).toContain("is gone");

    const widened = await harness();
    const app = widened.zt.appsById.get(APP_ID) as Record<string, unknown>;
    (app.policies as Record<string, unknown>[])[0] = {
      name: "Allow owner",
      decision: "allow",
      include: [{ email: { email: OWNER_EMAIL } }, { email: { email: "someone@example.test" } }],
    };
    expect(await refusal(widened.run())).toContain("admits someone other than the owner");
    expect(widened.zt.writes()).toEqual([]);

    const bound = await harness();
    (bound.zt.appsById.get(APP_ID) as Record<string, unknown>).enable_binding_cookie = true;
    expect(await refusal(bound.run())).toContain("Binding Cookie");
    expect(bound.zt.writes()).toEqual([]);
  });

  it("names the dashboard step when Cloudflare refuses the update (403), and records the start", async () => {
    const h = await harness();
    h.zt.forbidden.add("updateApp");
    const refused = await refusal(h.run());
    expect(refused).toContain("403 Forbidden");
    expect(refused).toContain("turn on Authenticate with Cloudflare One Client");
    expect(h.record.appStartedAt).toBeDefined();
    expect(h.record.appChangedAt).toBeUndefined();
  });

  it("stops when the update changed the AUD tag that ingress checks", async () => {
    const h = await harness();
    h.zt.newAudOnUpdate = true;
    await expect(h.run()).rejects.toThrow("another AUD tag");
  });

  it("stops when Cloudflare did not keep the setting", async () => {
    const h = await harness();
    const update = h.zt.updateApp;
    h.zt.updateApp = (id, body) => update(id, { ...body, allow_authenticate_via_warp: false });
    await expect(h.run()).rejects.toThrow("did not keep Authenticate");
  });

  it("refuses when the update left it other than owner-only", async () => {
    const h = await harness();
    const update = h.zt.updateApp;
    h.zt.updateApp = (id, body) =>
      update(id, {
        ...body,
        policies: [{ name: "x", decision: "bypass", include: [{ everyone: {} }] }],
      });
    expect(await refusal(h.run())).toContain("after its update");
  });
});

describe("writableApp", () => {
  it("drops what Cloudflare only reports, keeps inline policies whole and links reusable ones", () => {
    const body = writableApp({
      id: "x",
      aud: "y",
      uid: "z",
      created_at: "t",
      updated_at: "t",
      name: "n",
      policies: [
        { id: "p1", uid: "u", reusable: false, created_at: "t", name: "inline", decision: "allow" },
        { id: "p2", reusable: true, precedence: 2, name: "shared", decision: "allow", include: [] },
        { id: "p3", reusable: true, name: "shared, no precedence" },
        "a-policy-id",
      ],
    });
    expect(body).toEqual({
      name: "n",
      policies: [
        { id: "p1", name: "inline", decision: "allow" },
        { id: "p2", precedence: 2 },
        { id: "p3" },
        "a-policy-id",
      ],
    });
    expect(writableApp({ name: "no policies" })).toEqual({ name: "no policies" });
  });
});

describe("ensureDevices: the organization", () => {
  it("keeps a client session it already has unless one is asked for", async () => {
    const h = await harness();
    h.zt.organizationValue.warp_auth_session_duration = "168h";
    const kept = await h.run();
    expect(kept.sessionDuration).toBe("168h");
    expect(h.zt.organizationValue.warp_auth_session_duration).toBe("168h");
    expect(h.lines.join("\n")).toContain(
      "keeping the organization's Cloudflare One Client session of 168h",
    );
    const asked = await h.run({ session: "7d" });
    expect(asked.changed).toEqual([]);
    const longer = await h.run({ session: "60d" });
    expect(longer.sessionDuration).toBe("1440h");
    expect(h.zt.organizationValue.warp_auth_session_duration).toBe("1440h");
    // A short one, to see a lapse within a sitting, and back.
    await h.run({ session: "15m" });
    expect(h.zt.organizationValue.warp_auth_session_duration).toBe("15m");
  });

  it("takes Cloudflare's own spelling of a session as the same one, and keeps the record readable", async () => {
    const h = await harness();
    h.zt.organizationValue.warp_auth_session_duration = "2h45m0s";
    h.zt.organizationValue.warp_auth_non_browser_401 = true;
    const kept = await h.run();
    expect(kept.sessionDuration).toBe("2h45m");
    expect(h.zt.calls).not.toContain("updateOrganization");
    // Cloudflare answers in Go's form after a write: still the session asked for.
    const update = h.zt.updateOrganization;
    h.zt.updateOrganization = (body) =>
      update({
        ...body,
        warp_auth_session_duration: `${body.warp_auth_session_duration as string}0m0s`,
      });
    await h.run({ session: "30d" });
    expect(h.zt.organizationValue.warp_auth_session_duration).toBe("720h0m0s");
    await h.run();
    expect(h.zt.calls.filter((c) => c === "updateOrganization")).toHaveLength(1);
    const plan = await accountPlan();
    const text = JSON.stringify({
      ...freshState(plan),
      stateVersion: 7,
      journal: { devices: h.record },
    });
    expect(parseState(text).journal.devices?.sessionDuration).toBe("720h");
    for (const value of ["forever", "0m", "2161h"]) {
      // Unreadable, or outside what this step sets, is not kept (Codex r2).
      const odd = await harness();
      odd.zt.organizationValue.warp_auth_session_duration = value;
      await expect(odd.run(), value).rejects.toThrow(`session is "${value}"`);
      expect(odd.record.checkedAt, value).toBeUndefined();
      await odd.run({ session: "30d" });
      expect(odd.zt.organizationValue.warp_auth_session_duration).toBe("720h");
    }
  });

  it("says, and leaves, an organization that lets every application use the client", async () => {
    const h = await harness();
    h.zt.organizationValue.allow_authenticate_via_warp = true;
    await h.run();
    expect(h.zt.organizationValue.allow_authenticate_via_warp).toBe(true);
    expect(h.lines.join("\n")).toContain("this step does not change that");
  });

  it("reports a field the update changed besides its own", async () => {
    const h = await harness();
    h.zt.dropsOnUpdate = "login_design";
    await expect(h.run()).rejects.toThrow("also changed login_design");
    expect(h.record.organizationChangedAt).toBeDefined();
  });

  it("stops when Cloudflare did not keep its settings", async () => {
    const h = await harness();
    h.zt.dropsOnUpdate = "warp_auth_non_browser_401";
    await expect(h.run()).rejects.toThrow("did not keep the organization's");
  });

  it("names the dashboard step on a 403", async () => {
    const h = await harness();
    h.zt.forbidden.add("updateOrganization");
    const refused = await refusal(h.run());
    expect(refused).toContain("Return 401 response for non-browser traffic");
    expect(refused).toContain("leave Apply to all Access applications off");
  });
});

describe("ensureDevices: device enrollment", () => {
  const enrollmentBy = (zt: FakeZeroTrust, email: string, name = "Warp Login App") =>
    zt.withReported(
      {
        type: "warp",
        name,
        policies: [{ name: "Allow", decision: "allow", include: [{ email: { email } }] }],
      },
      `app-theirs-${name.length}`,
    );

  it("asks for the owner's address only when it must write a policy", async () => {
    const h = await harness();
    const refused = await refusal(h.run({ ownerEmail: undefined }));
    expect(refused).toContain("--owner-email");
    expect(h.zt.enrollmentApps()).toHaveLength(0);
    expect(await refusal(h.run({ ownerEmail: "someone@example.test" }))).toContain("not the owner");
    await h.run();
    expect(h.zt.enrollmentApps()).toHaveLength(1);
  });

  it("uses an owner-only one someone else made as it is", async () => {
    const zt = new FakeZeroTrust();
    const theirs = enrollmentBy(zt, OWNER_EMAIL);
    zt.appsById.set(theirs.id as string, theirs);
    const h = await harness(undefined, zt);
    await h.run({ ownerEmail: undefined });
    expect(zt.appsById.get(theirs.id as string)).toEqual(theirs);
    expect(zt.calls.filter((c) => c === "createApp")).toHaveLength(0);
    expect(h.lines.join("\n")).toContain("leaves it alone");
  });

  it("refuses one someone else made that admits others, and several", async () => {
    const zt = new FakeZeroTrust();
    const theirs = enrollmentBy(zt, "someone@example.test");
    zt.appsById.set(theirs.id as string, theirs);
    const h = await harness(undefined, zt);
    const refused = await refusal(h.run());
    expect(refused).toContain("admits someone other than the owner");
    expect(refused).toContain("Device enrollment permissions");
    expect(zt.appsById.get(theirs.id as string)).toEqual(theirs);
    const second = enrollmentBy(zt, OWNER_EMAIL, "another one");
    zt.appsById.set(second.id as string, second);
    expect(await refusal(h.run())).toContain("only one of");
  });

  it("puts its own back to owner-only when someone widened it, with the address", async () => {
    const h = await harness();
    await h.run();
    const id = h.record.enrollment?.id as string;
    const app = h.zt.appsById.get(id) as Record<string, unknown>;
    (app.policies as Record<string, unknown>[]).push({
      id: "pol-extra",
      name: "Everyone",
      decision: "allow",
      include: [{ everyone: {} }],
    });
    expect(await refusal(h.run({ ownerEmail: undefined }))).toContain("--owner-email");
    const outcome = await h.run();
    expect(outcome.changed).toEqual(["device enrollment admits only the owner again"]);
    const restored = h.zt.appsById.get(id) as Record<string, unknown>;
    expect((restored.policies as unknown[]).length).toBe(1);
    expect(restored.name).toBe(app.name);
  });

  it("refuses another enrollment application beside its own", async () => {
    const h = await harness();
    await h.run();
    const theirs = enrollmentBy(h.zt, OWNER_EMAIL);
    h.zt.appsById.set(theirs.id as string, theirs);
    expect(await refusal(h.run())).toContain("besides this installation's");
  });

  it("creates its own again when it is gone", async () => {
    const h = await harness();
    await h.run();
    h.zt.appsById.delete(h.record.enrollment?.id as string);
    await h.run();
    expect(h.zt.enrollmentApps()).toHaveLength(1);
    expect(h.lines.join("\n")).toContain("is gone; creating it again");
  });

  it("offers every login method when the installation's application names none", async () => {
    const zt = new FakeZeroTrust();
    delete (zt.appsById.get(APP_ID) as Record<string, unknown>).allowed_idps;
    const h = await harness(undefined, zt);
    await h.run();
    const [enrollment] = zt.enrollmentApps();
    expect(enrollment?.allowed_idps).toBeUndefined();
    expect(enrollment?.auto_redirect_to_identity).toBeUndefined();
  });

  it("clears its intent on a 403 and names the dashboard step", async () => {
    const h = await harness();
    h.zt.forbidden.add("createApp");
    const refused = await refusal(h.run());
    expect(refused).toContain("Device enrollment permissions");
    expect(h.record.enrollment).toBeUndefined();
  });

  it("adopts the application a create whose answer was lost made, once it lands", async () => {
    const h = await harness();
    h.zt.lateCreate = { afterMs: 60_000 };
    await expect(h.run()).rejects.toThrow("timeout");
    expect(h.record.enrollment).toMatchObject({
      name: "cloudflare-omnigent-web-devices--5e6f7a8b",
    });
    expect(h.record.enrollment?.id).toBeUndefined();
    await h.run();
    expect(h.slept).toEqual([ACCESS_SETTLE_MS]);
    expect(h.zt.enrollmentApps()).toHaveLength(1);
    expect(h.record.enrollment?.id).toBeDefined();
    expect(h.lines.join("\n")).toContain("created by an interrupted run, is recorded now");
  });

  it("creates anew when a lost create never landed within the settle time", async () => {
    const h = await harness();
    h.zt.lateCreate = { afterMs: undefined };
    await expect(h.run()).rejects.toThrow("timeout");
    await h.run();
    expect(h.slept).toEqual([ACCESS_SETTLE_MS]);
    expect(h.zt.enrollmentApps()).toHaveLength(1);
  });

  it("stops when the application Cloudflare holds is not what was written", async () => {
    const h = await harness();
    const create = h.zt.createApp;
    h.zt.createApp = (body) => create({ ...body, type: "self_hosted" });
    await expect(h.run()).rejects.toThrow("not of type warp");
    const g = await harness();
    g.zt.app = (id) => (id === APP_ID ? structuredClone(g.zt.appsById.get(id)) : undefined);
    await expect(g.run()).rejects.toThrow("not there after its write");
    const w = await harness();
    const createWide = w.zt.createApp;
    w.zt.createApp = (body) =>
      createWide({
        ...body,
        policies: [{ name: "x", decision: "allow", include: [{ everyone: {} }] }],
      });
    expect(await refusal(w.run())).toContain("after its write");
  });
});

describe("ensureDevices: the split tunnel", () => {
  it("adds only what is missing to a profile already in include mode, keeping its other routes", async () => {
    const zt = new FakeZeroTrust();
    zt.profile = {
      service_mode_v2: { mode: "warp" },
      include: [{ address: "10.1.0.0/16" }, { host: TEAM.toUpperCase() }],
    };
    const h = await harness(undefined, zt);
    const outcome = await h.run();
    expect(hostsOf(zt.profile.include)).toEqual([undefined, TEAM.toUpperCase(), HOST]);
    expect(h.record.previousSplitTunnel).toBeUndefined();
    expect(outcome.changed.at(-1)).toContain(`also sends ${HOST}`);
  });

  it("keeps the first saved exclude list when a switch is retried, and never takes a profile with both lists as ready (Codex r1-6)", async () => {
    const h = await harness();
    h.zt.keepsExclude = true;
    await expect(h.run()).rejects.toThrow("not in include mode");
    const saved = h.record.previousSplitTunnel;
    expect(saved?.entries).toHaveLength(3);
    // Run again with Cloudflare unchanged: both lists still there, so not ready.
    await expect(h.run()).rejects.toThrow("not in include mode");
    expect(h.record.checkedAt).toBeUndefined();
    // Once Cloudflare drops the exclude list, the same run repairs it; the first copy is kept.
    h.zt.keepsExclude = false;
    await h.run();
    expect(h.zt.profile.exclude).toBeUndefined();
    expect(hostsOf(h.zt.profile.include)).toEqual([HOST, TEAM]);
    expect(h.record.previousSplitTunnel).toEqual(saved);
    expect(h.record.checkedAt).toBeDefined();
  });

  it("refuses a profile whose client cannot route a domain, and names the step on a 403", async () => {
    const h = await harness();
    h.zt.profile.service_mode_v2 = { mode: "warp_tunnel_only" };
    expect(await refusal(h.run())).toContain("Traffic and DNS");
    const f = await harness();
    f.zt.forbidden.add("updateDefaultProfile");
    expect(await refusal(f.run())).toContain("Include IPs and domains");
  });

  it("notes other login methods and custom profiles, and reads past a 403 on login methods", async () => {
    const h = await harness();
    h.zt.idps = [...h.zt.idps, { id: "idp-gh", type: "github" }];
    h.zt.custom = 2;
    await h.run();
    const lines = h.lines.join("\n");
    expect(lines).toContain("also signs in with github");
    expect(lines).toContain("2 device profiles besides the default");
    const f = await harness();
    f.zt.forbidden.add("identityProviders");
    f.zt.custom = 1;
    await f.run();
    expect(f.lines.join("\n")).toContain("1 device profile besides");
    const e = await harness();
    e.zt.identityProviders = () => {
      throw new Error("network");
    };
    await expect(e.run()).rejects.toThrow("network");
  });
});

describe("ensureDevices: interrupted at every write, then run again", () => {
  it("ends as one clean run does, with one enrollment application", async () => {
    const clean = await harness();
    await clean.run();
    const points: { call: Call; nth: number; after: boolean }[] = [];
    for (const call of WRITES) {
      for (const after of [false, true]) points.push({ call, nth: 1, after });
    }
    for (const point of points) {
      const h = await harness();
      if (point.after) h.zt.crashAfter = point;
      else h.zt.crashBefore = point;
      await h.run().catch((error: unknown) => {
        if (!(error instanceof Crash)) throw error;
      });
      await h.run();
      const label = `${point.after ? "after" : "before"} ${point.call}`;
      expect(h.zt.enrollmentApps(), label).toHaveLength(1);
      expect(hostsOf(h.zt.profile.include), label).toEqual([HOST, TEAM]);
      expect(h.zt.organizationValue.warp_auth_session_duration, label).toBe("720h");
      expect(
        (h.zt.appsById.get(APP_ID) as Record<string, unknown>).allow_authenticate_via_warp,
      ).toBe(true);
      expect(h.record.previousSplitTunnel?.entries, label).toHaveLength(3);
      expect(h.record.checkedAt, label).toBeDefined();
    }
  });
});

describe("devicesStatus and devicesNextSteps", () => {
  it("says what was set up, and what each machine does next", async () => {
    expect(devicesStatus(undefined)).toEqual([
      "Personal devices: not set up (bootstrap.ts devices).",
    ]);
    expect(devicesStatus({ appStartedAt: "2026-10-31T12:00:00.000Z" })[0]).toContain(
      "not finished",
    );
    const h = await harness();
    const outcome = await h.run();
    const lines = devicesStatus(h.record);
    expect(lines[0]).toContain("sessions last 720h");
    expect(lines.join("\n")).toContain("created by this installation");
    expect(lines.join("\n")).toContain("3 routes");
    expect(devicesStatus({ checkedAt: "2026-10-31T12:00:00.000Z" })).toEqual([
      "Personal devices: checked at 2026-10-31T12:00:00.000Z.",
    ]);
    const next = devicesNextSteps(await accountPlan(), outcome).join("\n");
    expect(next).toContain(`omnigent-host.sh setup --server https://${HOST}`);
    expect(next).toContain("(team)");
  });
});

describe("the state file records the devices step", () => {
  it("round-trips the record as version 7, and refuses a malformed one", async () => {
    const h = await harness();
    await h.run();
    const plan = await accountPlan();
    const state = { ...freshState(plan), journal: { devices: h.record } };
    expect(stateVersionFor(plan, state.journal)).toBe(7);
    const text = JSON.stringify({ ...state, stateVersion: 7 });
    expect(parseState(text).journal.devices).toEqual(h.record);
    const bad = (devices: unknown) =>
      JSON.stringify({ ...state, stateVersion: 7, journal: { devices } });
    expect(() => parseState(bad({ sessionDuration: "30 days" }))).toThrow("not a duration");
    expect(() =>
      parseState(bad({ previousSplitTunnel: { mode: "include", entries: [] } })),
    ).toThrow("malformed");
    expect(() =>
      parseState(
        bad({
          previousSplitTunnel: {
            mode: "exclude",
            entries: [{ address: 10 }],
            savedAt: "2026-10-31T12:00:00Z",
          },
        }),
      ),
    ).toThrow("is not text");
    expect(() => parseState(bad({ enrollment: { id: "x" } }))).toThrow("enrollment.name");
    expect(() => parseState(bad({ checkedAt: "yesterday" }))).toThrow("not a time");
  });
});

describe("devicesCommand", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("runs the step on the state file under the installation's and the account's locks", async () => {
    dir = mkdtempSync(join(tmpdir(), "cfo-devices-"));
    const locks = join(dir, "locks");
    mkdirSync(locks);
    const path = join(dir, "state.json");
    const plan = await accountPlan();
    const store = fileStateStore(path);
    store.save({
      ...freshState(plan),
      journal: { accessApp: { name: "cloudflare-omnigent-web--0a1b2c3d", id: APP_ID } },
    });
    const zt = new FakeZeroTrust();
    const code = await devicesCommand(path, {
      api: zt,
      lockDir: locks,
      ownerEmail: OWNER_EMAIL,
      session: "14d",
    });
    expect(code).toBe(0);
    const saved = store.load();
    expect(saved.stateVersion).toBe(7);
    expect(saved.journal.devices?.sessionDuration).toBe("336h");
    expect(saved.journal.accessApp?.id).toBe(APP_ID);
    expect(devicesLockPath(plan.accountId, locks)).toBe(
      join(locks, `${plan.accountId}.zero-trust-devices.lock`),
    );

    // Run again: nothing to change, and it says so.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    try {
      expect(await devicesCommand(path, { api: zt, lockDir: locks })).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toContain("bootstrap: every setting was in place already");

    // A person's step is a refusal; an argument out of form an error.
    await expect(devicesCommand(path, { api: zt, lockDir: locks, session: "two" })).rejects.toThrow(
      "at most 90 days",
    );
    zt.organizationValue.warp_auth_non_browser_401 = false;
    zt.forbidden.add("updateOrganization");
    await expect(devicesCommand(path, { api: zt, lockDir: locks })).rejects.toBeInstanceOf(
      BootstrapRefusal,
    );
    zt.forbidden.clear();
    zt.updateOrganization = () => {
      throw new Error("network");
    };
    await expect(devicesCommand(path, { api: zt, lockDir: locks })).rejects.toThrow("network");
  });
});

describe("cfDevicesApi: the devices step's Cloudflare through cf", () => {
  const FORBIDDEN = "┌ APIError\n│ [10000] Authentication error\n│ 403 Forbidden · HTTP\n└";

  function fakeRunner(answer: (args: readonly string[]) => Partial<CommandResult>) {
    const calls: string[][] = [];
    const runner = (command: string, args: readonly string[], options: { inherit: boolean }) => {
      expect(command).toBe("cf");
      expect(options.inherit).toBe(false);
      calls.push([...args]);
      return { status: 0, stdout: "", stderr: "", ...answer(args) } as CommandResult;
    };
    return { calls, runner };
  }

  it("reads and writes with the right commands, bodies as JSON, and a 403 as AccessUnavailable", () => {
    const answers: Record<string, Partial<CommandResult>> = {
      "organization get": { stdout: JSON.stringify({ result: { auth_domain: TEAM } }) },
      "organization update": { stdout: JSON.stringify({ result: {} }) },
      "default get": { stdout: JSON.stringify({ result: { include: [] } }) },
      "default update": { stdout: JSON.stringify({ result: {} }) },
      "custom list": {
        stdout: JSON.stringify({ result: [{ default: true }, { default: false }, {}] }),
      },
      "applications update": { stdout: JSON.stringify({ result: {} }) },
      "applications create": { stdout: JSON.stringify({ result: { id: "app-new" } }) },
      "identity-providers list": { stdout: JSON.stringify([{ id: "i", type: "onetimepin" }]) },
      "applications list": { stdout: JSON.stringify([{ id: "a" }]) },
      "applications get": { stdout: JSON.stringify({ id: "a" }) },
    };
    const fake = fakeRunner((args) => {
      const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
      return key === undefined ? { status: 1, stderr: "unexpected" } : (answers[key] ?? {});
    });
    const api = cfDevicesApi(fake.runner);
    expect(api.teamDomain()).toBe(TEAM);
    expect(api.organization()).toEqual({ auth_domain: TEAM });
    api.updateOrganization({ warp_auth_non_browser_401: true });
    expect(api.defaultProfile()).toEqual({ include: [] });
    api.updateDefaultProfile({ include: [{ host: HOST }] });
    expect(api.customProfiles()).toBe(2);
    api.updateApp("app-1", { allow_authenticate_via_warp: true });
    expect(api.createApp({ type: "warp" })).toBe("app-new");
    expect(api.identityProviders()).toEqual([{ id: "i", type: "onetimepin" }]);
    expect(api.apps()).toEqual([{ id: "a" }]);
    expect(api.app("a")).toEqual({ id: "a" });
    expect(fake.calls).toContainEqual([
      "zero-trust",
      "organization",
      "update",
      "--body",
      '{"warp_auth_non_browser_401":true}',
    ]);
    expect(fake.calls).toContainEqual([
      "zero-trust",
      "devices",
      "profiles",
      "default",
      "update",
      "--body",
      JSON.stringify({ include: [{ host: HOST }] }),
    ]);
    expect(fake.calls).toContainEqual([
      "zero-trust",
      "access",
      "applications",
      "update",
      "app-1",
      "--body",
      '{"allow_authenticate_via_warp":true}',
    ]);

    const refused = cfDevicesApi(fakeRunner(() => ({ status: 1, stderr: FORBIDDEN })).runner);
    expect(() => refused.updateOrganization({})).toThrow(AccessUnavailable);
    expect(() => refused.updateApp("a", {})).toThrow(AccessUnavailable);
    expect(() => refused.updateDefaultProfile({})).toThrow(AccessUnavailable);
    const odd = cfDevicesApi(
      fakeRunner(() => ({ stdout: JSON.stringify({ result: [1] }) })).runner,
    );
    expect(() => odd.organization()).toThrow("answered without an object");
    const notList = cfDevicesApi(
      fakeRunner(() => ({ stdout: JSON.stringify({ result: {} }) })).runner,
    );
    expect(() => notList.customProfiles()).toThrow("answered no list");
  });
});
