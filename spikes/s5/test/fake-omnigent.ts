// A scripted Omnigent for the platform-login unit tests. It models the behaviour read from the
// fork (accounts_auth.py, device_auth.py, auth.py, accounts_store.py) and confirmed against the
// real server in the local scenario run:
//   - /auth/login answers 200 with `refresh_token` only when asked and the grant insert works;
//   - login grants never rotate; refresh returns the same refresh token and a 1-hour access token;
//   - refresh past the absolute lifetime answers `expired_token`, unless the opportunistic purge
//     (at most every 300 s, on a refresh) deleted the row first: then `invalid_grant`;
//   - revocation and a password change or reset (new account generation) answer `invalid_grant`,
//     and every access token from that grant or generation answers 401 at once.

import type { OmnigentPort } from "../src/platform-login.ts";

interface Grant {
  refresh: string;
  user: string;
  generation: number;
  approvedAt: number;
  revoked: boolean;
}

export class FakeOmnigent implements OmnigentPort {
  now = 1_800_000_000;
  lifetime = 86_400;
  private lastPurge = Number.NEGATIVE_INFINITY;
  readonly users = new Map<string, { password: string; generation: number }>();
  readonly grants = new Map<string, Grant>();
  private readonly access = new Map<string, { grantId: string; generation: number; exp: number }>();
  readonly calls: string[] = [];
  private seq = 0;
  faults: {
    failGrantIssue?: boolean;
    down?: boolean;
    loginStatus?: number;
    refreshStatus?: number;
    refreshError?: string;
    readStatus?: number;
    rejectAllAccess?: boolean;
  } = {};

  constructor(username: string, password: string) {
    this.users.set(username, { password, generation: 1 });
  }

  private id(prefix: string): string {
    this.seq++;
    return `${prefix}-${this.seq}-${"x".repeat(24)}`;
  }

  resetPassword(username: string, password: string): void {
    const user = this.users.get(username);
    if (!user) throw new Error("no user");
    this.users.set(username, { password, generation: user.generation + 1 });
  }

  liveGrants(): number {
    return [...this.grants.values()].filter((g) => !g.revoked).length;
  }

  async request(path: string, init: RequestInit): Promise<Response> {
    const method = init.method ?? "GET";
    this.calls.push(`${method} ${path}`);
    if (this.faults.down) throw new TypeError("fetch failed");
    if (method === "POST" && path === "/auth/login") return this.login(String(init.body));
    if (method === "POST" && path === "/oauth/token") return this.token(String(init.body));
    if (method === "POST" && path === "/oauth/revoke") return this.revoke(String(init.body));
    if (method === "GET" && path === "/v1/scheduled-tasks") return this.read(init);
    return Response.json({ error: "not found" }, { status: 404 });
  }

  private login(body: string): Response {
    if (this.faults.loginStatus) return new Response("x", { status: this.faults.loginStatus });
    const { username, password, issue_refresh } = JSON.parse(body) as {
      username: string;
      password: string;
      issue_refresh?: boolean;
    };
    const user = this.users.get(username);
    if (!user || user.password !== password) {
      return Response.json({ error: "invalid username or password" }, { status: 401 });
    }
    const payload: Record<string, unknown> = {
      token: "session-jwt",
      expires_in: 28_800,
      user: { id: username, is_admin: true },
    };
    if (issue_refresh === true && !this.faults.failGrantIssue) {
      const refresh = this.id("refresh");
      this.grants.set(this.id("grant"), {
        refresh,
        user: username,
        generation: user.generation,
        approvedAt: this.now,
        revoked: false,
      });
      payload.refresh_token = refresh;
    }
    return Response.json(payload);
  }

  private token(body: string): Response {
    if (this.faults.refreshStatus) return new Response("x", { status: this.faults.refreshStatus });
    if (this.faults.refreshError) {
      return Response.json({ error: this.faults.refreshError }, { status: 400 });
    }
    const form = new URLSearchParams(body);
    const refresh = form.get("refresh_token") ?? "";
    if (!refresh) return Response.json({ error: "invalid_request" }, { status: 400 });
    if (this.now - this.lastPurge >= 300) {
      this.lastPurge = this.now;
      for (const [id, g] of this.grants) {
        if (g.approvedAt <= this.now - this.lifetime) this.grants.delete(id);
      }
    }
    const entry = [...this.grants.entries()].find(([, g]) => g.refresh === refresh && !g.revoked);
    if (!entry) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const [grantId, grant] = entry;
    if (this.now - grant.approvedAt >= this.lifetime) {
      return Response.json({ error: "expired_token" }, { status: 400 });
    }
    if (this.users.get(grant.user)?.generation !== grant.generation) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const accessToken = this.id("access");
    this.access.set(accessToken, { grantId, generation: grant.generation, exp: this.now + 3600 });
    return Response.json({
      access_token: accessToken,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: 3600,
    });
  }

  private revoke(body: string): Response {
    const refresh = new URLSearchParams(body).get("refresh_token");
    for (const g of this.grants.values()) if (g.refresh === refresh) g.revoked = true;
    return Response.json({ revoked: true });
  }

  private read(init: RequestInit): Response {
    if (this.faults.readStatus) return new Response("x", { status: this.faults.readStatus });
    const auth = new Headers(init.headers).get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const a = this.access.get(token);
    const grant = a ? this.grants.get(a.grantId) : undefined;
    const ok =
      !this.faults.rejectAllAccess &&
      a !== undefined &&
      a.exp > this.now &&
      grant !== undefined &&
      !grant.revoked &&
      this.users.get(grant.user)?.generation === a.generation;
    if (!ok) {
      return Response.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        { status: 401 },
      );
    }
    return Response.json({
      scheduled_tasks: [
        {
          id: "task-1",
          name: "nightly",
          state: "active",
          host_id: "host-1",
          next_run_at: "2027-01-01T03:00:00Z",
          updated_at: "2026-10-18T00:00:00Z",
        },
      ],
    });
  }
}
