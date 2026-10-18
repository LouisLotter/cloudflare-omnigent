// Spike S5: the platform's own Omnigent login (design decision 11), as ControlDO would hold it.
//
// Pure module behind three ports (the Omnigent server, durable storage, a sealer), so the same
// code runs in unit tests with a scripted server, in `wrangler dev` against a local Omnigent
// container, and in staging against the Omnigent container behind Access.
//
// The rules it prototypes:
//   - A grant is accepted only from a login response that carries refresh material, and only
//     after it has minted an access token and read /v1/scheduled-tasks. Then it is sealed and
//     written, read back, and only then does `firstGrantStoredAt` exist. The bootstrap secret is
//     removable only from that moment (RC-02).
//   - Omnigent login grants do not rotate, so concurrent or repeated refreshes are safe.
//   - A refusal from /oauth/token (`invalid_grant`, `expired_token`, `invalid_request`), or a
//     401 that survives a fresh access token, means the grant is dead: `needs_reauthentication`.
//     A network error, 429 or 5xx is transient: the state stays `ok`, the data is stale.
//   - Repair takes the owner's password once, obtains a new grant the same way, and keeps no
//     password. The old grant is revoked only after the new one is stored.

import type { Sealer } from "./crypto.ts";

export interface OmnigentPort {
  /** A request to the Omnigent server on its private path. `path` starts with "/". */
  request(path: string, init: RequestInit): Promise<Response>;
}

export interface LoginStore {
  load(): Promise<LoginRecord | undefined>;
  save(record: LoginRecord): Promise<void>;
}

export type LoginState = "bootstrap_pending" | "ok" | "needs_reauthentication";

export type ReauthReason =
  /** Nothing stored, and no bootstrap secret to log in with. */
  | "no_credentials"
  /** Omnigent refused the bootstrap or repair password. */
  | "credentials_rejected"
  /** Login succeeded but the response had no refresh grant. */
  | "login_without_refresh"
  /** A grant from a successful login failed its first refresh or read. */
  | "grant_unusable"
  /** Refresh refused because the grant reached its absolute lifetime. */
  | "grant_expired"
  /** Refresh refused otherwise: revoked, password changed or reset, account removed, database restored. */
  | "grant_rejected";

export interface LoginEvent {
  readonly at: number;
  readonly event: string;
}

export interface LoginRecord {
  readonly version: 1;
  readonly state: LoginState;
  readonly username: string;
  readonly sealedRefresh?: string;
  readonly sealedAccess?: string;
  /** Epoch seconds. */
  readonly accessExpiresAt?: number;
  readonly grantObtainedAt?: number;
  readonly grantLifetimeEndsAt?: number;
  /** Set in the same write as the first stored grant. The bootstrap secret may go after this. */
  readonly firstGrantStoredAt?: number;
  readonly reason?: ReauthReason;
  /** What the server said, for example `expired_token`, `invalid_grant` or `http 401`. */
  readonly serverError?: string;
  readonly since?: number;
  readonly lastGoodAt?: number;
  readonly lastTransient?: { readonly at: number; readonly detail: string };
  readonly events: readonly LoginEvent[];
}

export type ObtainOutcome =
  | { readonly kind: "stored" }
  | { readonly kind: "rejected"; readonly detail: string }
  | { readonly kind: "no_refresh" }
  | { readonly kind: "unusable"; readonly detail: string }
  | { readonly kind: "transient"; readonly detail: string };

export type CallResult =
  | { readonly kind: "ok"; readonly response: Response }
  | { readonly kind: "needs_reauthentication"; readonly reason: ReauthReason | undefined }
  | { readonly kind: "transient"; readonly detail: string };

type Minted =
  | { readonly kind: "ok"; readonly access: string; readonly expiresAt: number }
  | { readonly kind: "rejected"; readonly error: string }
  | { readonly kind: "transient"; readonly detail: string };

export interface ScheduleSummary {
  readonly id: string;
  readonly name: string | null;
  readonly state: string | null;
  readonly host_id: string | null;
  readonly next_run_at: string | number | null;
  readonly updated_at: string | number | null;
}

export interface PlatformLoginDeps {
  readonly omnigent: OmnigentPort;
  readonly store: LoginStore;
  readonly sealer: Sealer;
  readonly nowSeconds: () => number;
  readonly username: string;
  /** The grant lifetime the server was started with (OMNIGENT_GRANT_MAX_LIFETIME_DAYS). */
  readonly grantLifetimeSeconds: number;
}

const MAX_EVENTS = 30;
const ACCESS_MARGIN_SECONDS = 60;

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class PlatformLogin {
  private refreshing: Promise<string | CallResult> | undefined;
  private readonly deps: PlatformLoginDeps;

  constructor(deps: PlatformLoginDeps) {
    this.deps = deps;
  }

  async record(): Promise<LoginRecord> {
    return (
      (await this.deps.store.load()) ?? {
        version: 1,
        state: "bootstrap_pending",
        username: this.deps.username,
        events: [],
      }
    );
  }

  private withEvent(record: LoginRecord, event: string): LoginRecord {
    const events = [...record.events, { at: this.deps.nowSeconds(), event }].slice(-MAX_EVENTS);
    return { ...record, events };
  }

  private async needsReauth(
    reason: ReauthReason,
    serverError: string | undefined,
    event: string,
  ): Promise<void> {
    const current = await this.record();
    const now = this.deps.nowSeconds();
    const { serverError: _, ...rest } = current;
    await this.deps.store.save(
      this.withEvent(
        {
          ...rest,
          state: "needs_reauthentication",
          reason,
          ...(serverError !== undefined ? { serverError } : {}),
          since: current.state === "needs_reauthentication" ? (current.since ?? now) : now,
        },
        event,
      ),
    );
  }

  private async transient(detail: string, event: string): Promise<void> {
    const current = await this.record();
    await this.deps.store.save(
      this.withEvent({ ...current, lastTransient: { at: this.deps.nowSeconds(), detail } }, event),
    );
  }

  /**
   * First login, with the bootstrap secret. Idempotent: once a grant has been stored, it never
   * logs in again and reports the secret as removable.
   */
  async bootstrap(
    secret: string | undefined,
  ): Promise<{ state: LoginState; secretRemovable: boolean; outcome: string }> {
    const current = await this.record();
    if (current.firstGrantStoredAt !== undefined) {
      return { state: current.state, secretRemovable: true, outcome: "already_stored" };
    }
    if (secret === undefined || secret === "") {
      await this.needsReauth("no_credentials", undefined, "bootstrap: no secret");
      return { state: "needs_reauthentication", secretRemovable: false, outcome: "no_secret" };
    }
    const outcome = await this.obtain(secret, "bootstrap");
    const after = await this.record();
    return {
      state: after.state,
      secretRemovable: after.firstGrantStoredAt !== undefined,
      outcome: outcome.kind,
    };
  }

  /** The repair card's action. The password is used for one login request and then dropped. */
  async repair(password: string): Promise<ObtainOutcome> {
    if (password === "" || password.length > 1024) {
      return { kind: "rejected", detail: "empty or oversized password" };
    }
    return this.obtain(password, "repair");
  }

  private async obtain(password: string, source: "bootstrap" | "repair"): Promise<ObtainOutcome> {
    const before = await this.record();
    let response: Response;
    try {
      response = await this.deps.omnigent.request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: before.username, password, issue_refresh: true }),
      });
    } catch (error) {
      const detail = `login unreachable: ${error instanceof Error ? error.name : "error"}`;
      await this.transient(detail, `${source}: ${detail}`);
      return { kind: "transient", detail };
    }
    if (isTransientStatus(response.status)) {
      const detail = `login http ${response.status}`;
      await this.transient(detail, `${source}: ${detail}`);
      return { kind: "transient", detail };
    }
    if (!response.ok) {
      const detail = `login http ${response.status}`;
      // A wrong password at the repair card leaves the original reason in place.
      if (source === "bootstrap") {
        await this.needsReauth("credentials_rejected", detail, "bootstrap: password refused");
      } else {
        await this.deps.store.save(this.withEvent(await this.record(), "repair: password refused"));
      }
      return { kind: "rejected", detail };
    }
    const body = (await response.json().catch(() => undefined)) as
      | { refresh_token?: unknown }
      | undefined;
    const refresh = body?.refresh_token;
    if (typeof refresh !== "string" || refresh.length < 16) {
      // The handler catches a failed grant issuance and still answers 200 (accounts_auth.py).
      if (before.state !== "ok") {
        await this.needsReauth(
          "login_without_refresh",
          "no refresh_token",
          `${source}: login without refresh`,
        );
      } else {
        await this.transient("login without refresh", `${source}: login without refresh`);
      }
      return { kind: "no_refresh" };
    }

    // Prove the grant works before keeping it: one refresh, one authoritative read.
    const minted = await this.mint(refresh);
    if (minted.kind === "transient") {
      await this.revoke(refresh);
      await this.transient(minted.detail, `${source}: first refresh ${minted.detail}`);
      return { kind: "transient", detail: minted.detail };
    }
    if (minted.kind === "rejected") {
      await this.revoke(refresh);
      if (before.state !== "ok") {
        await this.needsReauth("grant_unusable", minted.error, `${source}: new grant refused`);
      }
      return { kind: "unusable", detail: minted.error };
    }
    let probe: Response;
    try {
      probe = await this.deps.omnigent.request("/v1/scheduled-tasks", {
        method: "GET",
        headers: { authorization: `Bearer ${minted.access}` },
      });
    } catch (error) {
      await this.revoke(refresh);
      const detail = `read unreachable: ${error instanceof Error ? error.name : "error"}`;
      await this.transient(detail, `${source}: ${detail}`);
      return { kind: "transient", detail };
    }
    if (probe.status !== 200) {
      await this.revoke(refresh);
      const detail = `first read http ${probe.status}`;
      if (isTransientStatus(probe.status)) {
        await this.transient(detail, `${source}: ${detail}`);
        return { kind: "transient", detail };
      }
      if (before.state !== "ok") {
        await this.needsReauth("grant_unusable", detail, `${source}: ${detail}`);
      }
      return { kind: "unusable", detail };
    }

    const now = this.deps.nowSeconds();
    const {
      reason: _r,
      serverError: _e,
      since: _s,
      lastTransient: _t,
      ...kept
    } = await this.record();
    const next: LoginRecord = this.withEvent(
      {
        ...kept,
        state: "ok",
        sealedRefresh: await this.deps.sealer.seal(refresh),
        sealedAccess: await this.deps.sealer.seal(minted.access),
        accessExpiresAt: minted.expiresAt,
        grantObtainedAt: now,
        grantLifetimeEndsAt: now + this.deps.grantLifetimeSeconds,
        firstGrantStoredAt: kept.firstGrantStoredAt ?? now,
        lastGoodAt: now,
      },
      `${source}: grant stored`,
    );
    try {
      await this.deps.store.save(next);
      const back = await this.deps.store.load();
      if (!back?.sealedRefresh || (await this.deps.sealer.open(back.sealedRefresh)) !== refresh) {
        throw new Error("the stored grant did not read back");
      }
    } catch (error) {
      // Never leave a live grant that nobody holds.
      await this.revoke(refresh);
      throw error;
    }
    // Retire the previous grant only now that its replacement is durable.
    if (before.sealedRefresh !== undefined) {
      const old = await this.deps.sealer.open(before.sealedRefresh).catch(() => undefined);
      if (old !== undefined && old !== refresh) await this.revoke(old);
    }
    return { kind: "stored" };
  }

  private async mint(refresh: string): Promise<Minted> {
    let response: Response;
    try {
      response = await this.deps.omnigent.request("/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refresh,
        }).toString(),
      });
    } catch (error) {
      return {
        kind: "transient",
        detail: `refresh unreachable: ${error instanceof Error ? error.name : "error"}`,
      };
    }
    if (isTransientStatus(response.status)) {
      return { kind: "transient", detail: `refresh http ${response.status}` };
    }
    const body = (await response.json().catch(() => undefined)) as
      | { access_token?: unknown; expires_in?: unknown; error?: unknown }
      | undefined;
    if (response.status === 200 && typeof body?.access_token === "string") {
      const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
      return {
        kind: "ok",
        access: body.access_token,
        expiresAt: this.deps.nowSeconds() + ttl,
      };
    }
    return {
      kind: "rejected",
      error: typeof body?.error === "string" ? body.error : `http ${response.status}`,
    };
  }

  /** Best effort: a revoke that fails leaves a grant that only its absolute lifetime ends. */
  private async revoke(refresh: string): Promise<number | undefined> {
    try {
      const response = await this.deps.omnigent.request("/oauth/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ refresh_token: refresh }).toString(),
      });
      return response.status;
    } catch {
      return undefined;
    }
  }

  private async accessToken(force: boolean): Promise<string | CallResult> {
    const record = await this.record();
    const now = this.deps.nowSeconds();
    if (
      !force &&
      record.sealedAccess !== undefined &&
      record.accessExpiresAt !== undefined &&
      record.accessExpiresAt - now > ACCESS_MARGIN_SECONDS
    ) {
      return this.deps.sealer.open(record.sealedAccess);
    }
    this.refreshing ??= this.refreshAccess().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async refreshAccess(): Promise<string | CallResult> {
    const record = await this.record();
    if (record.state !== "ok" || record.sealedRefresh === undefined) {
      return { kind: "needs_reauthentication", reason: record.reason };
    }
    const minted = await this.mint(await this.deps.sealer.open(record.sealedRefresh));
    if (minted.kind === "ok") {
      const latest = await this.record();
      await this.deps.store.save(
        this.withEvent(
          {
            ...latest,
            sealedAccess: await this.deps.sealer.seal(minted.access),
            accessExpiresAt: minted.expiresAt,
          },
          "refresh: ok",
        ),
      );
      return minted.access;
    }
    if (minted.kind === "transient") {
      await this.transient(minted.detail, `refresh: ${minted.detail}`);
      return { kind: "transient", detail: minted.detail };
    }
    const pastLifetime =
      record.grantLifetimeEndsAt !== undefined &&
      this.deps.nowSeconds() >= record.grantLifetimeEndsAt;
    const reason: ReauthReason =
      minted.error === "expired_token" || pastLifetime ? "grant_expired" : "grant_rejected";
    await this.needsReauth(reason, minted.error, `refresh: refused (${minted.error})`);
    return { kind: "needs_reauthentication", reason };
  }

  /** An authenticated request with the platform's own grant. Never touches a computer's login. */
  async call(path: string, init: RequestInit = {}): Promise<CallResult> {
    const record = await this.record();
    if (record.state !== "ok") return { kind: "needs_reauthentication", reason: record.reason };
    for (const force of [false, true]) {
      const access = await this.accessToken(force);
      if (typeof access !== "string") return access;
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${access}`);
      let response: Response;
      try {
        response = await this.deps.omnigent.request(path, { ...init, headers });
      } catch (error) {
        const detail = `${path} unreachable: ${error instanceof Error ? error.name : "error"}`;
        await this.transient(detail, detail);
        return { kind: "transient", detail };
      }
      if (response.status === 401) continue;
      if (isTransientStatus(response.status)) {
        const detail = `${path} http ${response.status}`;
        await this.transient(detail, detail);
        return { kind: "transient", detail };
      }
      const latest = await this.record();
      await this.deps.store.save({ ...latest, lastGoodAt: this.deps.nowSeconds() });
      return { kind: "ok", response };
    }
    await this.needsReauth("grant_rejected", "http 401", `${path}: 401 after a fresh token`);
    return { kind: "needs_reauthentication", reason: "grant_rejected" };
  }

  async readSchedules(): Promise<
    | { kind: "ok"; tasks: ScheduleSummary[] }
    | Exclude<CallResult, { kind: "ok" }>
    | { kind: "unexpected"; status: number }
  > {
    const result = await this.call("/v1/scheduled-tasks", { method: "GET" });
    if (result.kind !== "ok") return result;
    if (result.response.status !== 200) {
      return { kind: "unexpected", status: result.response.status };
    }
    const body = (await result.response.json()) as { scheduled_tasks?: unknown };
    const list = Array.isArray(body.scheduled_tasks) ? body.scheduled_tasks : [];
    const text = (v: unknown) => (typeof v === "string" ? v : null);
    const stamp = (v: unknown) => (typeof v === "string" || typeof v === "number" ? v : null);
    return {
      kind: "ok",
      tasks: list.map((entry) => {
        const t = entry as Record<string, unknown>;
        return {
          id: String(t.id),
          name: text(t.name),
          state: text(t.state),
          host_id: text(t.host_id),
          next_run_at: stamp(t.next_run_at),
          updated_at: stamp(t.updated_at),
        };
      }),
    };
  }

  /** The state for the platform pages and the repair card. Holds no secret. */
  async status(): Promise<LoginStatus> {
    const r = await this.record();
    const now = this.deps.nowSeconds();
    return {
      state: r.state,
      reason: r.reason ?? null,
      serverError: r.serverError ?? null,
      since: r.since ?? null,
      lastGoodAt: r.lastGoodAt ?? null,
      grantObtainedAt: r.grantObtainedAt ?? null,
      grantLifetimeEndsAt: r.grantLifetimeEndsAt ?? null,
      expiresInSeconds: r.grantLifetimeEndsAt !== undefined ? r.grantLifetimeEndsAt - now : null,
      bootstrapSecretRemovable: r.firstGrantStoredAt !== undefined,
      lastTransient: r.lastTransient ?? null,
      events: r.events.slice(-12),
    };
  }

  // ---- Spike-only fault injection, used by the scenario runners. ----

  /** Revokes the stored grant on the server, as an outside revocation would, and keeps the record. */
  async faultRevokeStoredGrant(): Promise<number | undefined> {
    const r = await this.record();
    if (r.sealedRefresh === undefined) return undefined;
    return this.revoke(await this.deps.sealer.open(r.sealedRefresh));
  }

  /** Forgets the cached access token, so the next call must refresh (an hour passing). */
  async faultDropAccessToken(): Promise<void> {
    const { sealedAccess: _a, accessExpiresAt: _e, ...rest } = await this.record();
    await this.deps.store.save(rest);
  }
}

export interface LoginStatus {
  readonly state: LoginState;
  readonly reason: ReauthReason | null;
  readonly serverError: string | null;
  readonly since: number | null;
  readonly lastGoodAt: number | null;
  readonly grantObtainedAt: number | null;
  readonly grantLifetimeEndsAt: number | null;
  readonly expiresInSeconds: number | null;
  readonly bootstrapSecretRemovable: boolean;
  readonly lastTransient: { readonly at: number; readonly detail: string } | null;
  readonly events: readonly LoginEvent[];
}
