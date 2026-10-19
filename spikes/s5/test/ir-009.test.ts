// IR-009 (checkpoint review M1): a failed readback must never leave a revoked or unconfirmed grant
// recorded as usable, and the bootstrap-secret removal signal must never be published for one.
//
// Each test injects one storage fault into a save or load that carries the new grant, then checks
// the durable state (a fresh PlatformLogin on the same store stands in for a restart) and a real
// authenticated read through the fake Omnigent port.

import { beforeEach, describe, expect, it } from "vitest";
import { base64UrlEncode } from "../src/access.ts";
import { aesGcmSealer, type Sealer } from "../src/crypto.ts";
import { type LoginRecord, type LoginStore, PlatformLogin } from "../src/platform-login.ts";
import { FakeOmnigent } from "./fake-omnigent.ts";

const USER = "owner";
const randomKey = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
const PASSWORD = `pw-${randomKey()}`;

type Match = (record: LoginRecord) => boolean;

/** Durable storage with one-shot faults. `value` is what survives a restart. */
class FaultStore implements LoginStore {
  value: LoginRecord | undefined;
  /** The next matching save throws without writing. */
  failBefore: Match | undefined;
  /** The next matching save writes, then throws (the write committed; the caller cannot tell). */
  failAfter: Match | undefined;
  /** After the next matching save, the following load throws once. */
  loadFailsAfter: Match | undefined;
  /** After the next matching save, the following load returns undecryptable sealed values once. */
  corruptAfter: Match | undefined;
  private loadFails = 0;
  private corruptLoads = 0;
  unavailable = false;

  async save(record: LoginRecord): Promise<void> {
    if (this.unavailable) throw new Error("storage unavailable");
    if (this.failBefore?.(record)) {
      this.failBefore = undefined;
      throw new Error("injected: save failed before effect");
    }
    this.value = structuredClone(record);
    if (this.loadFailsAfter?.(record)) {
      this.loadFailsAfter = undefined;
      this.loadFails = 1;
    }
    if (this.corruptAfter?.(record)) {
      this.corruptAfter = undefined;
      this.corruptLoads = 1;
    }
    if (this.failAfter?.(record)) {
      this.failAfter = undefined;
      throw new Error("injected: save failed after effect");
    }
  }

  async load(): Promise<LoginRecord | undefined> {
    if (this.unavailable) throw new Error("storage unavailable");
    if (this.loadFails > 0) {
      this.loadFails--;
      throw new Error("injected: load failed");
    }
    if (this.corruptLoads > 0 && this.value) {
      this.corruptLoads--;
      const bad = "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA";
      const copy = structuredClone(this.value) as LoginRecord & Record<string, unknown>;
      if (copy.sealedRefresh) (copy as Record<string, unknown>).sealedRefresh = bad;
      const pending = copy.pending as Record<string, unknown> | undefined;
      if (pending) pending.sealedRefresh = bad;
      return copy;
    }
    return structuredClone(this.value);
  }
}

/** Any save that carries a grant from this login: the first place a fault can bite. */
const carriesGrant: Match = (r) =>
  r.sealedRefresh !== undefined || (r as { pending?: unknown }).pending !== undefined;
/** The save that makes the new grant current. */
const promotes: Match = (r) =>
  r.state === "ok" &&
  r.sealedRefresh !== undefined &&
  (r as { pending?: unknown }).pending === undefined;

let server: FakeOmnigent;
let store: FaultStore;
let sealer: Sealer;

function core(): PlatformLogin {
  return new PlatformLogin({
    omnigent: server,
    store,
    sealer,
    nowSeconds: () => server.now,
    username: USER,
    grantLifetimeSeconds: 86_400,
  });
}

const logins = () => server.calls.filter((c) => c === "POST /auth/login").length;

/**
 * The invariant: whenever the durable state says `ok`, or (before any grant was ever confirmed)
 * says the bootstrap secret may go, a process that starts now from that state can make an
 * authenticated read with the stored grant. Once a grant has been confirmed, the secret stays
 * removable even after that grant later dies: the repair card, not the secret, takes over.
 */
async function assertNoFalseSignal(beforeFirstConfirmation = true): Promise<void> {
  const restarted = core();
  const status = await restarted.status();
  if ((beforeFirstConfirmation && status.bootstrapSecretRemovable) || status.state === "ok") {
    const read = await restarted.readSchedules();
    expect(read.kind, "durable state claims a usable grant").toBe("ok");
  }
}

async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  return p.catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
}

beforeEach(async () => {
  server = new FakeOmnigent(USER, PASSWORD);
  store = new FaultStore();
  sealer = await aesGcmSealer(randomKey(), "platform-login");
});

describe("IR-009: bootstrap acceptance is confirmed before success", () => {
  it("reviewer scenario: a read failure right after the save that holds the grant", async () => {
    store.loadFailsAfter = carriesGrant;
    await settle(core().bootstrap(PASSWORD));
    // No removal signal for a grant whose storage was not confirmed.
    expect((await core().status()).bootstrapSecretRemovable).toBe(false);
    await assertNoFalseSignal();
    // Restart and retry: reconciled, then the signal, a working read and one live grant.
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("save after effect on the first save that holds the grant", async () => {
    store.failAfter = carriesGrant;
    await settle(core().bootstrap(PASSWORD));
    expect((await core().status()).bootstrapSecretRemovable).toBe(false);
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("save before effect on the first save that holds the grant", async () => {
    store.failBefore = carriesGrant;
    await settle(core().bootstrap(PASSWORD));
    expect((await core().status()).bootstrapSecretRemovable).toBe(false);
    expect(server.liveGrants()).toBe(0); // the unkept grant was revoked
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("decrypt failure when reading the stored grant back", async () => {
    store.corruptAfter = carriesGrant;
    await settle(core().bootstrap(PASSWORD));
    expect((await core().status()).bootstrapSecretRemovable).toBe(false);
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("promotion fails before effect: the verified pending grant is promoted on restart, without a new login", async () => {
    store.failBefore = promotes;
    const first = await settle(core().bootstrap(PASSWORD));
    expect(first).toMatchObject({ secretRemovable: false, outcome: "pending" });
    expect(server.liveGrants()).toBe(1); // possibly committed: never revoked
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry).toMatchObject({ secretRemovable: true });
    expect(logins()).toBe(1);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("promotion fails after effect: confirmed on restart, without a new login", async () => {
    store.failAfter = promotes;
    const first = await settle(core().bootstrap(PASSWORD));
    expect(first).toMatchObject({ secretRemovable: false, outcome: "pending" });
    expect(server.liveGrants()).toBe(1);
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry).toMatchObject({ secretRemovable: true });
    expect(logins()).toBe(1);
    expect((await core().readSchedules()).kind).toBe("ok");
  });

  it("read failure after promotion: no signal until a restart confirms it", async () => {
    store.loadFailsAfter = promotes;
    const first = await settle(core().bootstrap(PASSWORD));
    expect(first).toMatchObject({ secretRemovable: false });
    await assertNoFalseSignal();
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect(logins()).toBe(1);
    expect((await core().readSchedules()).kind).toBe("ok");
  });

  it("a pending grant revoked before reconciliation is dropped, and bootstrap logs in again", async () => {
    store.failBefore = promotes;
    await settle(core().bootstrap(PASSWORD));
    for (const g of server.grants.values()) g.revoked = true; // e.g. a password change in between
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect(logins()).toBe(2);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("Omnigent unreachable while a pending grant is reconciled: no signal, settled later", async () => {
    store.failBefore = promotes;
    await settle(core().bootstrap(PASSWORD));
    server.faults.down = true;
    expect(await core().bootstrap(PASSWORD)).toMatchObject({
      secretRemovable: false,
      outcome: "pending",
    });
    server.faults = {};
    expect((await core().bootstrap(PASSWORD)).secretRemovable).toBe(true);
    expect(logins()).toBe(1);
  });

  it("confirmation refreshes when the stored access token has expired", async () => {
    store.failAfter = promotes;
    await settle(core().bootstrap(PASSWORD));
    server.now += 3601; // the stored access token is now refused with 401
    expect((await core().bootstrap(PASSWORD)).secretRemovable).toBe(true);
    expect(logins()).toBe(1);
    expect((await core().readSchedules()).kind).toBe("ok");
  });

  it("confirmation that finds the stored grant dead gives no signal, and bootstrap logs in again", async () => {
    store.failAfter = promotes;
    await settle(core().bootstrap(PASSWORD));
    for (const g of server.grants.values()) g.revoked = true;
    const retry = await core().bootstrap(PASSWORD);
    expect(retry.secretRemovable).toBe(true);
    expect(logins()).toBe(2);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("a 5xx during confirmation leaves the acceptance pending", async () => {
    store.failAfter = promotes;
    await settle(core().bootstrap(PASSWORD));
    server.faults.readStatus = 503;
    expect(await core().bootstrap(PASSWORD)).toMatchObject({ secretRemovable: false });
    expect((await core().status()).acceptance).toBe("pending");
    server.faults = {};
    expect((await core().bootstrap(PASSWORD)).secretRemovable).toBe(true);
  });

  it("storage unreadable at the start: no login with the secret, no signal", async () => {
    store.unavailable = true;
    const r = await settle(core().bootstrap(PASSWORD));
    expect(r).toMatchObject({ secretRemovable: false });
    expect(logins()).toBe(0);
    store.unavailable = false;
    expect((await core().bootstrap(PASSWORD)).secretRemovable).toBe(true);
  });
});

describe("IR-009: repair keeps the previous usable grant until its replacement is confirmed", () => {
  beforeEach(async () => {
    expect((await core().bootstrap(PASSWORD)).secretRemovable).toBe(true);
    server.calls.length = 0;
  });

  it("proactive renewal whose promotion fails keeps reading with the old grant", async () => {
    store.failBefore = promotes;
    const outcome = await settle(core().repair(PASSWORD));
    expect(outcome).toMatchObject({ kind: "pending" });
    expect(server.liveGrants()).toBe(2); // old kept, new not revoked
    expect((await core().readSchedules()).kind).toBe("ok");
    await assertNoFalseSignal(false);
    // The next operation reconciles: the new grant becomes current, then the old one goes.
    expect((await core().readSchedules()).kind).toBe("ok");
    expect(server.liveGrants()).toBe(1);
  });

  it("repair after revocation whose save commits but throws does not report ok with a dead grant", async () => {
    const login = core();
    await login.faultRevokeStoredGrant();
    expect((await login.readSchedules()).kind).toBe("needs_reauthentication");
    store.failAfter = carriesGrant;
    await settle(core().repair(PASSWORD));
    await assertNoFalseSignal(false);
    // A second repair, or reconciliation, ends in a working login.
    const again = await settle(core().repair(PASSWORD));
    expect(["stored", "pending"]).toContain((again as { kind?: string }).kind);
    expect((await core().readSchedules()).kind).toBe("ok");
    expect((await core().status()).state).toBe("ok");
  });

  it("repair read failure after the save that holds the grant", async () => {
    const login = core();
    await login.faultRevokeStoredGrant();
    await login.readSchedules();
    store.loadFailsAfter = carriesGrant;
    await settle(core().repair(PASSWORD));
    await assertNoFalseSignal(false);
    await settle(core().repair(PASSWORD));
    expect((await core().readSchedules()).kind).toBe("ok");
  });
});
