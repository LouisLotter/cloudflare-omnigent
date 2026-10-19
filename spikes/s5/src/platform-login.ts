// Spike S5: the platform's own Omnigent login (design decision 11), as ControlDO would hold it.
//
// Pure module behind three ports (the Omnigent server, durable storage, a sealer), so the same
// code runs in unit tests with a scripted server, in `wrangler dev` against a local Omnigent
// container, and in staging against the Omnigent container behind Access.
//
// The rules it prototypes:
//   - A grant is accepted only from a login response that carries refresh material, and only
//     after it has minted an access token and read /v1/scheduled-tasks.
//   - Acceptance has three durable steps, because a storage write can fail before or after it
//     takes effect, and a read-back can fail on its own (IR-009):
//       1. `pending`: the sealed candidate is written beside the current grant and read back.
//          A pending grant is never used; it is verified again before it can become current. If
//          this step fails, the candidate is revoked: nothing trusts it.
//       2. promotion: one write makes the candidate current (the replaced grant is kept as
//          `sealedRetiring`) and clears `pending`. From here on the candidate may be durably
//          current, so a failure is "pending", never a revocation.
//       3. confirmation: the stored grant is read back intact and used for an authenticated read,
//          and then `confirmedAt` (and once, `firstConfirmedAt`) is written and read back. Only
//          then is the previous grant revoked, and only `firstConfirmedAt` makes the bootstrap
//          secret removable (RC-02).
//     Every bootstrap, repair and authenticated call first reconciles whatever an interrupted
//     run left behind: it verifies and promotes a pending grant, or drops it when Omnigent refuses
//     it, and confirms an unconfirmed promotion.
//   - Omnigent login grants do not rotate, so concurrent or repeated refreshes are safe.
//   - A refusal from /oauth/token (`invalid_grant`, `expired_token`, `invalid_request`), or a
//     401 that survives a fresh access token, means the grant is dead: `needs_reauthentication`.
//     A network error, 429 or 5xx is transient: the state stays `ok`, the data is stale.
//   - Repair takes the owner's password once, obtains a new grant the same way, and keeps no
//     password. The previous usable grant stays current until its replacement is confirmed.

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
  /** A verified candidate written beside the current grant. Never used until reconciled. */
  readonly pending?: PendingGrant;
  /** The grant the current one replaced; revoked once the current one is confirmed. */
  readonly sealedRetiring?: string;
  /** When the current grant was confirmed. Unset after a promotion until confirmation. */
  readonly confirmedAt?: number;
  /** Set once, by the first confirmation. The bootstrap secret may go after this. */
  readonly firstConfirmedAt?: number;
  readonly reason?: ReauthReason;
  /** What the server said, for example `expired_token`, `invalid_grant` or `http 401`. */
  readonly serverError?: string;
  readonly since?: number;
  readonly lastGoodAt?: number;
  readonly lastTransient?: { readonly at: number; readonly detail: string };
  readonly events: readonly LoginEvent[];
}

export interface PendingGrant {
  readonly sealedRefresh: string;
  readonly sealedAccess: string;
  readonly accessExpiresAt: number;
  readonly obtainedAt: number;
  readonly source: "bootstrap" | "repair";
}

export type ObtainOutcome =
  /** Promoted and confirmed. */
  | { readonly kind: "stored" }
  /** Possibly current, not yet confirmed; the next reconciliation settles it. Nothing revoked. */
  | { readonly kind: "pending"; readonly detail: string }
  /** Not kept: the candidate was revoked. */
  | { readonly kind: "storage_failed"; readonly detail: string }
  | { readonly kind: "rejected"; readonly detail: string }
  | { readonly kind: "no_refresh" }
  | { readonly kind: "unusable"; readonly detail: string }
  | { readonly kind: "transient"; readonly detail: string };

type Verified =
  | { readonly kind: "ok"; readonly access: string; readonly expiresAt: number }
  | { readonly kind: "dead"; readonly detail: string }
  | { readonly kind: "transient"; readonly detail: string };

const errorText = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 120) : String(error);

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
   * First login, with the bootstrap secret. Reconciles an interrupted earlier run first. Once a
   * grant has been confirmed it never logs in again and reports the secret as removable; while
   * an acceptance is unconfirmed it neither logs in nor reports the secret as removable.
   */
  async bootstrap(
    secret: string | undefined,
  ): Promise<{ state: LoginState | "unknown"; secretRemovable: boolean; outcome: string }> {
    let current: LoginRecord;
    try {
      await this.reconcile();
      current = await this.record();
    } catch {
      // The durable state is unknown: logging in now could orphan or duplicate a grant.
      return { state: "unknown", secretRemovable: false, outcome: "storage_unavailable" };
    }
    if (current.firstConfirmedAt !== undefined) {
      return { state: current.state, secretRemovable: true, outcome: "already_stored" };
    }
    const unsettled =
      current.pending !== undefined ||
      (current.state === "ok" &&
        current.sealedRefresh !== undefined &&
        current.confirmedAt === undefined);
    if (unsettled) {
      // A pending or unconfirmed grant that reconciliation could not settle yet (transient).
      // A never-confirmed grant that reconciliation found dead falls through: log in again.
      return { state: current.state, secretRemovable: false, outcome: "pending" };
    }
    if (secret === undefined || secret === "") {
      await this.needsReauth("no_credentials", undefined, "bootstrap: no secret");
      return { state: "needs_reauthentication", secretRemovable: false, outcome: "no_secret" };
    }
    const outcome = await this.obtain(secret, "bootstrap");
    const after = await this.record().catch(() => undefined);
    return {
      state: after?.state ?? "unknown",
      secretRemovable: after?.firstConfirmedAt !== undefined && outcome.kind === "stored",
      outcome: outcome.kind,
    };
  }

  /** The repair card's action. The password is used for one login request and then dropped. */
  async repair(password: string): Promise<ObtainOutcome> {
    if (password === "" || password.length > 1024) {
      return { kind: "rejected", detail: "empty or oversized password" };
    }
    try {
      await this.reconcile();
    } catch (error) {
      return { kind: "transient", detail: `storage: ${errorText(error)}` };
    }
    return this.obtain(password, "repair");
  }

  /**
   * Settles what an interrupted acceptance left behind. A pending grant is verified with
   * Omnigent and promoted, or dropped if Omnigent refuses it. A promoted but unconfirmed grant
   * is confirmed. A confirmed grant's retired predecessor is revoked. Transient failures leave
   * everything as it is. Storage failures propagate.
   */
  async reconcile(): Promise<"settled" | "transient"> {
    const record = await this.record();
    if (record.pending !== undefined) {
      let refresh: string | undefined;
      try {
        refresh = await this.deps.sealer.open(record.pending.sealedRefresh);
      } catch {
        refresh = undefined;
      }
      if (refresh === undefined) {
        await this.dropPending("reconcile: pending grant unreadable, dropped");
      } else {
        const verified = await this.verifyGrant(refresh);
        if (verified.kind === "transient") return "transient";
        if (verified.kind === "dead") {
          await this.dropPending(`reconcile: pending grant refused (${verified.detail}), dropped`);
        } else {
          const promoted = await this.promote(refresh, verified, record.pending.source);
          if (promoted.kind !== "stored") return "transient";
        }
      }
    }
    const latest = await this.record();
    if (
      latest.state === "ok" &&
      latest.sealedRefresh !== undefined &&
      latest.confirmedAt === undefined
    ) {
      const confirmed = await this.confirm(undefined, "reconcile");
      if (confirmed.kind !== "stored") return "transient";
    } else if (latest.confirmedAt !== undefined && latest.sealedRetiring !== undefined) {
      await this.retire(latest);
    }
    return "settled";
  }

  private async dropPending(event: string): Promise<void> {
    const { pending: _p, ...rest } = await this.record();
    await this.deps.store.save(this.withEvent(rest, event));
  }

  /** One refresh and one authoritative read. No side effects on the record. */
  private async verifyGrant(refresh: string): Promise<Verified> {
    const minted = await this.mint(refresh);
    if (minted.kind === "transient") return minted;
    if (minted.kind === "rejected") return { kind: "dead", detail: minted.error };
    let probe: Response;
    try {
      probe = await this.deps.omnigent.request("/v1/scheduled-tasks", {
        method: "GET",
        headers: { authorization: `Bearer ${minted.access}` },
      });
    } catch (error) {
      return {
        kind: "transient",
        detail: `read unreachable: ${error instanceof Error ? error.name : "error"}`,
      };
    }
    if (probe.status === 200) return minted;
    const detail = `read http ${probe.status}`;
    return isTransientStatus(probe.status)
      ? { kind: "transient", detail }
      : { kind: "dead", detail };
  }

  /**
   * Step 2: make the verified candidate current in one write, keeping the replaced grant as
   * `sealedRetiring`. From the moment this write may have taken effect, nothing revokes the
   * candidate; a failure is reported as `pending` and left to reconciliation.
   */
  private async promote(
    refresh: string,
    verified: { readonly access: string; readonly expiresAt: number },
    source: "bootstrap" | "repair",
  ): Promise<ObtainOutcome> {
    try {
      const latest = await this.record();
      const {
        pending,
        confirmedAt: _c,
        reason: _r,
        serverError: _e,
        since: _s,
        lastTransient: _t,
        ...kept
      } = latest;
      const now = this.deps.nowSeconds();
      // An older retiring grant that never got revoked is revoked now, before its slot is reused.
      if (kept.sealedRetiring !== undefined && kept.sealedRetiring !== kept.sealedRefresh) {
        const older = await this.deps.sealer.open(kept.sealedRetiring).catch(() => undefined);
        if (older !== undefined && older !== refresh) await this.revoke(older);
      }
      const next: LoginRecord = this.withEvent(
        {
          ...kept,
          state: "ok",
          sealedRefresh: pending?.sealedRefresh ?? (await this.deps.sealer.seal(refresh)),
          sealedAccess: await this.deps.sealer.seal(verified.access),
          accessExpiresAt: verified.expiresAt,
          grantObtainedAt: pending?.obtainedAt ?? now,
          grantLifetimeEndsAt: (pending?.obtainedAt ?? now) + this.deps.grantLifetimeSeconds,
          ...(latest.sealedRefresh !== undefined ? { sealedRetiring: latest.sealedRefresh } : {}),
        },
        `${source}: grant promoted`,
      );
      await this.deps.store.save(next);
    } catch (error) {
      return { kind: "pending", detail: `promotion not confirmed: ${errorText(error)}` };
    }
    return this.confirm(refresh, source);
  }

  /**
   * Step 3: the stored grant reads back intact (and equals `expected` when the caller still
   * holds it in memory), works for an authenticated read with the stored copy, and the
   * confirmation itself reads back. Only then is the replaced grant revoked.
   */
  private async confirm(expected: string | undefined, source: string): Promise<ObtainOutcome> {
    let stored: string;
    let access: string | undefined;
    try {
      const record = await this.record();
      if (record.pending !== undefined || record.sealedRefresh === undefined) {
        return { kind: "pending", detail: "promotion did not read back" };
      }
      stored = await this.deps.sealer.open(record.sealedRefresh);
      if (expected !== undefined && stored !== expected) {
        return { kind: "pending", detail: "stored grant differs from the one promoted" };
      }
      access =
        record.sealedAccess !== undefined
          ? await this.deps.sealer.open(record.sealedAccess)
          : undefined;
    } catch (error) {
      return { kind: "pending", detail: `stored grant unreadable: ${errorText(error)}` };
    }
    // A real authenticated operation with what is stored, not with what is in memory.
    let used = access !== undefined ? await this.readWith(access) : "refresh";
    let fresh: { access: string; expiresAt: number } | undefined;
    if (used === "refresh") {
      const verified = await this.verifyGrant(stored);
      if (verified.kind === "transient") return { kind: "pending", detail: verified.detail };
      if (verified.kind === "dead") {
        await this.needsReauth(
          "grant_unusable",
          verified.detail,
          `${source}: stored grant refused`,
        );
        return { kind: "unusable", detail: verified.detail };
      }
      fresh = verified;
      used = "ok";
    }
    if (used !== "ok") return { kind: "pending", detail: used };
    try {
      const latest = await this.record();
      const now = this.deps.nowSeconds();
      const confirmed: LoginRecord = this.withEvent(
        {
          ...latest,
          ...(fresh
            ? {
                sealedAccess: await this.deps.sealer.seal(fresh.access),
                accessExpiresAt: fresh.expiresAt,
              }
            : {}),
          confirmedAt: now,
          firstConfirmedAt: latest.firstConfirmedAt ?? now,
          lastGoodAt: now,
        },
        `${source}: grant confirmed`,
      );
      await this.deps.store.save(confirmed);
      const back = await this.record();
      if (
        back.confirmedAt === undefined ||
        back.sealedRefresh === undefined ||
        (await this.deps.sealer.open(back.sealedRefresh)) !== stored
      ) {
        return { kind: "pending", detail: "confirmation did not read back" };
      }
      await this.retire(back);
    } catch (error) {
      return { kind: "pending", detail: `confirmation not stored: ${errorText(error)}` };
    }
    return { kind: "stored" };
  }

  /** An authenticated read with a given access token: "ok", "refresh" on 401, or a transient detail. */
  private async readWith(access: string): Promise<"ok" | "refresh" | string> {
    try {
      const r = await this.deps.omnigent.request("/v1/scheduled-tasks", {
        method: "GET",
        headers: { authorization: `Bearer ${access}` },
      });
      if (r.status === 200) return "ok";
      if (r.status === 401) return "refresh";
      return `read http ${r.status}`;
    } catch (error) {
      return `read unreachable: ${error instanceof Error ? error.name : "error"}`;
    }
  }

  /** Revokes the replaced grant of a confirmed record, then forgets it. Best effort. */
  private async retire(record: LoginRecord): Promise<void> {
    if (record.sealedRetiring === undefined) return;
    const [old, current] = await Promise.all([
      this.deps.sealer.open(record.sealedRetiring).catch(() => undefined),
      record.sealedRefresh !== undefined
        ? this.deps.sealer.open(record.sealedRefresh).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    if (old !== undefined && old !== current) await this.revoke(old);
    try {
      const { sealedRetiring: _r, ...rest } = await this.record();
      await this.deps.store.save(rest);
    } catch {
      // Reconciliation retries; a second revoke of the same grant is harmless.
    }
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

    // Step 1: write the candidate as pending, beside the current grant, and read it back.
    const candidate: PendingGrant = {
      sealedRefresh: await this.deps.sealer.seal(refresh),
      sealedAccess: await this.deps.sealer.seal(minted.access),
      accessExpiresAt: minted.expiresAt,
      obtainedAt: this.deps.nowSeconds(),
      source,
    };
    let replaced: PendingGrant | undefined;
    try {
      const latest = await this.record();
      replaced = latest.pending;
      await this.deps.store.save(
        this.withEvent({ ...latest, pending: candidate }, `${source}: grant written as pending`),
      );
      const back = await this.record();
      if (
        back.pending === undefined ||
        (await this.deps.sealer.open(back.pending.sealedRefresh)) !== refresh
      ) {
        throw new Error("the pending grant did not read back");
      }
    } catch (error) {
      // Nothing uses a pending grant without verifying it again, so revoking it is safe even if
      // the write took effect: reconciliation then finds it refused and drops it.
      await this.revoke(refresh);
      return { kind: "storage_failed", detail: errorText(error) };
    }
    if (replaced !== undefined) {
      const old = await this.deps.sealer.open(replaced.sealedRefresh).catch(() => undefined);
      if (old !== undefined && old !== refresh) await this.revoke(old);
    }
    // Steps 2 and 3: promote, then confirm.
    return this.promote(refresh, minted, source);
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
    let record: LoginRecord;
    try {
      // Settle an interrupted acceptance first; while it stays unsettled the current grant,
      // which is the previous usable one, keeps serving.
      await this.reconcile();
      record = await this.record();
    } catch (error) {
      return { kind: "transient", detail: `storage: ${errorText(error)}` };
    }
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
      bootstrapSecretRemovable: r.firstConfirmedAt !== undefined,
      acceptance:
        r.pending !== undefined || (r.sealedRefresh !== undefined && r.confirmedAt === undefined)
          ? "pending"
          : r.confirmedAt !== undefined
            ? "confirmed"
            : "none",
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
  /** True once a grant has been confirmed: stored, read back, and used. Never reset. */
  readonly bootstrapSecretRemovable: boolean;
  /** "pending" while an acceptance is unsettled; the platform then keeps its previous grant. */
  readonly acceptance: "none" | "pending" | "confirmed";
  readonly lastTransient: { readonly at: number; readonly detail: string } | null;
  readonly events: readonly LoginEvent[];
}
