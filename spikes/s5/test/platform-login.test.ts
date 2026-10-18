import { beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncode } from "../src/access.ts";
import { aesGcmSealer, checkFormToken, formToken, type Sealer } from "../src/crypto.ts";
import { type LoginRecord, PlatformLogin } from "../src/platform-login.ts";
import { escapeHtml, REASON_TEXT, renderLoginCard } from "../src/repair-card.ts";
import { FakeOmnigent } from "./fake-omnigent.ts";

const USER = "owner";
const randomKey = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
const PASSWORD = `pw-${randomKey()}`;

class MemoryStore {
  value: LoginRecord | undefined;
  failSave = false;
  corruptReadBack = false;
  saves: string[] = [];
  async load() {
    if (this.corruptReadBack && this.value) return { ...this.value, sealedRefresh: "v1.AAAA.AAAA" };
    return this.value;
  }
  async save(record: LoginRecord) {
    if (this.failSave) throw new Error("storage unavailable");
    this.saves.push(JSON.stringify(record));
    this.value = record;
  }
}

let server: FakeOmnigent;
let store: MemoryStore;
let sealer: Sealer;
let login: PlatformLogin;

function make(lifetimeSeconds = 86_400): PlatformLogin {
  return new PlatformLogin({
    omnigent: server,
    store,
    sealer,
    nowSeconds: () => server.now,
    username: USER,
    grantLifetimeSeconds: lifetimeSeconds,
  });
}

beforeEach(async () => {
  server = new FakeOmnigent(USER, PASSWORD);
  store = new MemoryStore();
  sealer = await aesGcmSealer(randomKey(), "platform-login");
  login = make();
});

const count = (prefix: string) => server.calls.filter((c) => c === prefix).length;

describe("bootstrap", () => {
  it("stores a verified grant, then reports the secret removable", async () => {
    expect((await login.status()).bootstrapSecretRemovable).toBe(false);
    const r = await login.bootstrap(PASSWORD);
    expect(r).toEqual({ state: "ok", secretRemovable: true, outcome: "stored" });
    // Verified before storing: one refresh and one read happened before the save.
    expect(server.calls).toEqual([
      "POST /auth/login",
      "POST /oauth/token",
      "GET /v1/scheduled-tasks",
    ]);
    const read = await login.readSchedules();
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.tasks[0]?.id).toBe("task-1");
  });

  it("keeps no password and no plaintext token", async () => {
    await login.bootstrap(PASSWORD);
    await login.readSchedules();
    const grant = [...server.grants.values()][0];
    for (const saved of store.saves) {
      expect(saved).not.toContain(PASSWORD);
      expect(saved).not.toContain(grant?.refresh);
      expect(saved).not.toContain("access-");
    }
    const status = JSON.stringify(await login.status());
    expect(status).not.toContain(PASSWORD);
    expect(status).not.toContain("v1.");
  });

  it("is idempotent once a grant is stored", async () => {
    await login.bootstrap(PASSWORD);
    const r = await login.bootstrap(PASSWORD);
    expect(r).toEqual({ state: "ok", secretRemovable: true, outcome: "already_stored" });
    expect(count("POST /auth/login")).toBe(1);
  });

  it("without a secret, needs the owner", async () => {
    expect(await login.bootstrap(undefined)).toEqual({
      state: "needs_reauthentication",
      secretRemovable: false,
      outcome: "no_secret",
    });
    expect((await login.status()).reason).toBe("no_credentials");
  });

  it("keeps the secret when the password is refused", async () => {
    const r = await login.bootstrap("wrong");
    expect(r).toEqual({
      state: "needs_reauthentication",
      secretRemovable: false,
      outcome: "rejected",
    });
    expect((await login.status()).reason).toBe("credentials_rejected");
  });

  it("keeps the secret after a 200 login without refresh material", async () => {
    server.faults.failGrantIssue = true;
    const r = await login.bootstrap(PASSWORD);
    expect(r).toEqual({
      state: "needs_reauthentication",
      secretRemovable: false,
      outcome: "no_refresh",
    });
    expect((await login.status()).reason).toBe("login_without_refresh");
    server.faults.failGrantIssue = false;
    expect((await login.bootstrap(PASSWORD)).secretRemovable).toBe(true);
  });

  it("refuses a grant whose first refresh fails, and revokes it", async () => {
    server.faults.refreshError = "invalid_grant";
    const r = await login.bootstrap(PASSWORD);
    expect(r.outcome).toBe("unusable");
    expect(r.secretRemovable).toBe(false);
    expect((await login.status()).reason).toBe("grant_unusable");
    expect(count("POST /oauth/revoke")).toBe(1);
    expect(server.liveGrants()).toBe(0);
  });

  it("refuses a grant whose first read fails, and revokes it", async () => {
    server.faults.readStatus = 403;
    const r = await login.bootstrap(PASSWORD);
    expect(r.outcome).toBe("unusable");
    expect(r.secretRemovable).toBe(false);
    expect(server.liveGrants()).toBe(0);
  });

  it.each([
    ["unreachable", { down: true }],
    ["login 503", { loginStatus: 503 }],
    ["login 429", { loginStatus: 429 }],
    ["first refresh 502", { refreshStatus: 502 }],
    ["first read 500", { readStatus: 500 }],
  ])("treats %s as transient and keeps the secret", async (_, faults) => {
    server.faults = faults;
    const r = await login.bootstrap(PASSWORD);
    expect(r.outcome).toBe("transient");
    expect(r.secretRemovable).toBe(false);
    expect(r.state).toBe("bootstrap_pending");
    server.faults = {};
    expect((await login.bootstrap(PASSWORD)).outcome).toBe("stored");
  });

  it("keeps the secret if the grant cannot be stored, and revokes the orphan", async () => {
    store.failSave = false;
    const original = store.save.bind(store);
    let saves = 0;
    store.save = async (record) => {
      saves++;
      if (record.state === "ok") throw new Error("storage unavailable");
      return original(record);
    };
    await expect(login.bootstrap(PASSWORD)).rejects.toThrow("storage unavailable");
    expect(saves).toBeGreaterThan(0);
    expect((await login.status()).bootstrapSecretRemovable).toBe(false);
    expect(server.liveGrants()).toBe(0);
  });

  it("keeps the secret if the stored grant does not read back", async () => {
    store.corruptReadBack = true;
    await expect(login.bootstrap(PASSWORD)).rejects.toThrow();
    expect(server.liveGrants()).toBe(0);
  });
});

describe("reads with the platform's grant", () => {
  beforeEach(async () => {
    await login.bootstrap(PASSWORD);
    server.calls.length = 0;
  });

  it("reuses the access token until it nears expiry, then refreshes", async () => {
    await login.readSchedules();
    expect(count("POST /oauth/token")).toBe(0);
    server.now += 3600 - 30;
    expect((await login.readSchedules()).kind).toBe("ok");
    expect(count("POST /oauth/token")).toBe(1);
  });

  it("refreshes once on a 401 and retries", async () => {
    server.now += 3601; // the access token expired at the server, the cache did not notice
    await login.faultDropAccessToken(); // even without a cached token the path is the same
    expect((await login.readSchedules()).kind).toBe("ok");
  });

  it("revocation: needs_reauthentication, grant_rejected", async () => {
    await login.faultRevokeStoredGrant();
    expect(await login.readSchedules()).toEqual({
      kind: "needs_reauthentication",
      reason: "grant_rejected",
    });
    const s = await login.status();
    expect([s.state, s.serverError, s.bootstrapSecretRemovable]).toEqual([
      "needs_reauthentication",
      "invalid_grant",
      true,
    ]);
  });

  it("password reset: needs_reauthentication, grant_rejected", async () => {
    server.resetPassword(USER, "new-password-123");
    expect((await login.readSchedules()).kind).toBe("needs_reauthentication");
    expect((await login.status()).reason).toBe("grant_rejected");
  });

  it("absolute expiry: expired_token gives grant_expired", async () => {
    server.now += 86_400 - 60; // the refresh below runs the purge while the grant is still young
    server.calls.length = 0;
    await login.faultDropAccessToken();
    expect((await login.readSchedules()).kind).toBe("ok"); // purge ran now, grant still young
    server.now += 120;
    await login.faultDropAccessToken();
    expect(await login.readSchedules()).toEqual({
      kind: "needs_reauthentication",
      reason: "grant_expired",
    });
    expect((await login.status()).serverError).toBe("expired_token");
  });

  it("absolute expiry after a purge: invalid_grant, still grant_expired by the platform's clock", async () => {
    server.now += 86_400 + 600;
    await login.faultDropAccessToken();
    expect(await login.readSchedules()).toEqual({
      kind: "needs_reauthentication",
      reason: "grant_expired",
    });
    expect((await login.status()).serverError).toBe("invalid_grant");
  });

  it("an access token outlives its grant's lifetime until its own expiry", async () => {
    server.now += 86_400 - 10;
    await login.faultDropAccessToken();
    await login.readSchedules(); // fresh 1-hour token minted 10 s before the grant's end
    server.now += 1800;
    expect((await login.readSchedules()).kind).toBe("ok");
  });

  it.each([
    ["refresh 503", { refreshStatus: 503 }],
    ["refresh 429", { refreshStatus: 429 }],
    ["server unreachable", { down: true }],
    ["read 502", { readStatus: 502 }],
  ])("%s is transient: state stays ok", async (_, faults) => {
    await login.faultDropAccessToken();
    server.faults = faults;
    expect((await login.readSchedules()).kind).toBe("transient");
    const s = await login.status();
    expect(s.state).toBe("ok");
    expect(s.lastTransient).not.toBeNull();
    server.faults = {};
    expect((await login.readSchedules()).kind).toBe("ok");
  });

  it("a 401 that survives a fresh token is a dead grant", async () => {
    server.faults.rejectAllAccess = true;
    expect(await login.readSchedules()).toEqual({
      kind: "needs_reauthentication",
      reason: "grant_rejected",
    });
    expect((await login.status()).serverError).toBe("http 401");
  });

  it("an unexpected refusal code is a dead grant too", async () => {
    server.faults.refreshError = "invalid_request";
    await login.faultDropAccessToken();
    expect((await login.readSchedules()).kind).toBe("needs_reauthentication");
  });

  it("does not call the server while it needs the owner", async () => {
    await login.faultRevokeStoredGrant();
    await login.readSchedules();
    server.calls.length = 0;
    expect((await login.readSchedules()).kind).toBe("needs_reauthentication");
    expect(server.calls).toEqual([]);
  });

  it("shares one refresh between concurrent reads", async () => {
    await login.faultDropAccessToken();
    const results = await Promise.all([
      login.readSchedules(),
      login.readSchedules(),
      login.readSchedules(),
    ]);
    expect(results.map((r) => r.kind)).toEqual(["ok", "ok", "ok"]);
    expect(count("POST /oauth/token")).toBe(1);
  });

  it("reports an unexpected status from the read itself", async () => {
    server.faults.readStatus = 404;
    expect(await login.readSchedules()).toEqual({ kind: "unexpected", status: 404 });
  });
});

describe("repair", () => {
  beforeEach(async () => {
    await login.bootstrap(PASSWORD);
    await login.faultRevokeStoredGrant();
    await login.readSchedules();
    server.calls.length = 0;
  });

  it("a wrong password changes nothing", async () => {
    expect((await login.repair("wrong")).kind).toBe("rejected");
    const s = await login.status();
    expect([s.state, s.reason]).toEqual(["needs_reauthentication", "grant_rejected"]);
  });

  it("refuses an empty or oversized password without a request", async () => {
    expect((await login.repair("")).kind).toBe("rejected");
    expect((await login.repair("x".repeat(1025))).kind).toBe("rejected");
    expect(server.calls).toEqual([]);
  });

  it("the password stores a new grant and keeps nothing of the password", async () => {
    expect((await login.repair(PASSWORD)).kind).toBe("stored");
    expect((await login.readSchedules()).kind).toBe("ok");
    for (const saved of store.saves) expect(saved).not.toContain(PASSWORD);
  });

  it("revokes the previous grant only after the new one is stored", async () => {
    await login.repair(PASSWORD); // the revoked grant gets a (harmless) revoke too
    server.calls.length = 0;
    const savesBefore = store.saves.length;
    const order: string[] = [];
    const save = store.save.bind(store);
    store.save = async (r) => {
      order.push(`save:${r.state}`);
      return save(r);
    };
    const request = server.request.bind(server);
    server.request = async (path, init) => {
      order.push(`${init.method ?? "GET"} ${path}`);
      return request(path, init);
    };
    expect((await login.repair(PASSWORD)).kind).toBe("stored"); // proactive renewal while ok
    expect(store.saves.length).toBeGreaterThan(savesBefore);
    const stored = order.lastIndexOf("save:ok");
    const revoke = order.indexOf("POST /oauth/revoke");
    expect(stored).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(stored);
    expect(server.liveGrants()).toBe(1);
  });

  it("login without refresh at repair keeps needs_reauthentication with that reason", async () => {
    server.faults.failGrantIssue = true;
    expect((await login.repair(PASSWORD)).kind).toBe("no_refresh");
    expect((await login.status()).reason).toBe("login_without_refresh");
  });

  it("a proactive renewal that gets no refresh material leaves the working grant alone", async () => {
    await login.repair(PASSWORD);
    server.faults.failGrantIssue = true;
    expect((await login.repair(PASSWORD)).kind).toBe("no_refresh");
    expect((await login.status()).state).toBe("ok");
    server.faults = {};
    expect((await login.readSchedules()).kind).toBe("ok");
  });
});

describe("repair card", () => {
  const base = {
    state: "ok" as const,
    reason: null,
    serverError: null,
    since: null,
    lastGoodAt: 1_800_000_000,
    grantObtainedAt: 1_800_000_000,
    grantLifetimeEndsAt: 1_800_000_000 + 30 * 86_400,
    expiresInSeconds: 30 * 86_400,
    bootstrapSecretRemovable: true,
    lastTransient: null,
    events: [],
  };

  it("shows no form while the login works", () => {
    const html = renderLoginCard(base, "t");
    expect(html).toContain('data-state="ok"');
    expect(html).not.toContain("<form");
  });

  it("warns ahead of the absolute lifetime and offers renewal", () => {
    const html = renderLoginCard({ ...base, expiresInSeconds: 3 * 86_400 }, "t");
    expect(html).toContain('data-warning="expiry"');
    expect(html).toContain("ends in 3 day(s)");
    expect(html).toContain('action="/platform/login/repair"');
  });

  it.each(Object.keys(REASON_TEXT))("explains %s and asks for the password", (reason) => {
    const html = renderLoginCard(
      { ...base, state: "needs_reauthentication", reason: reason as keyof typeof REASON_TEXT },
      "tok<en>",
      "wrong_password",
    );
    expect(html).toContain(`data-reason="${reason}"`);
    expect(html).toContain('type="password"');
    expect(html).toContain('value="tok&lt;en&gt;"');
    expect(html).toContain('data-message="wrong_password"');
  });

  it("escapes text", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  });
});

describe("crypto", () => {
  it("seals with a fresh nonce, binds the purpose, and detects tampering", async () => {
    const key = randomKey();
    const a = await aesGcmSealer(key, "one");
    const b = await aesGcmSealer(key, "two");
    const sealed = await a.seal("secret value");
    expect(sealed).not.toContain("secret");
    expect(await a.seal("secret value")).not.toBe(sealed);
    expect(await a.open(sealed)).toBe("secret value");
    await expect(b.open(sealed)).rejects.toThrow();
    await expect(a.open(`${sealed.slice(0, -2)}AA`)).rejects.toThrow();
    await expect(a.open("v2.x.y")).rejects.toThrow("unknown sealed format");
    await expect(aesGcmSealer(base64UrlEncode(new Uint8Array(16)), "x")).rejects.toThrow();
  });

  it("form tokens are bound to identity, purpose and time", async () => {
    const key = randomKey();
    const now = 1_800_000_000_000;
    const t = await formToken(key, "sub-1", "repair", now);
    expect(await checkFormToken(key, t, "sub-1", "repair", now + 1000)).toBe(true);
    expect(await checkFormToken(key, t, "sub-2", "repair", now)).toBe(false);
    expect(await checkFormToken(key, t, "sub-1", "other", now)).toBe(false);
    expect(await checkFormToken(key, t, "sub-1", "repair", now + 901_000)).toBe(false);
    expect(await checkFormToken(key, t, "sub-1", "repair", now - 120_000)).toBe(false);
    expect(await checkFormToken(randomKey(), t, "sub-1", "repair", now)).toBe(false);
    for (const junk of ["", "x", "1.", "abc.def", "1.!!"]) {
      expect(await checkFormToken(key, junk, "sub-1", "repair", now)).toBe(false);
    }
  });
});
