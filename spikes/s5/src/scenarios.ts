// Spike S5: the platform-login scenarios, run against a real Omnigent server.
//
// The same code runs in `wrangler dev` against a local Omnigent container and in staging
// against the container behind Access. Owner actions (creating a schedule, resetting or changing
// the password) use an ordinary owner session, as the owner's browser would. Fault injection
// uses SQL on the server's synthetic database, through a port: `container.exec` in staging, a
// local helper running `docker exec` locally.
//
// Results never contain a token or a password.

import type { PlatformLogin } from "./platform-login.ts";

export interface StepResult {
  readonly scenario: string;
  readonly step: string;
  readonly expect: string;
  readonly got: string;
  readonly pass: boolean;
}

export interface ScenarioPorts {
  login(name: string): Promise<PlatformLogin>;
  readonly bootstrapSecret: string;
  readonly username: string;
  /** A request straight to Omnigent's private path, for owner actions. */
  server(path: string, init?: RequestInit): Promise<Response>;
  faultSql(sql: string): Promise<{ exitCode: number; output: string }>;
  record(step: StepResult): Promise<void>;
  renderCard(name: string): Promise<string>;
}

export const SQL = {
  failGrantInserts:
    "CREATE TRIGGER IF NOT EXISTS s5_fail_grant BEFORE INSERT ON device_grants BEGIN SELECT RAISE(ABORT, 's5 injected fault'); END;",
  allowGrantInserts: "DROP TRIGGER IF EXISTS s5_fail_grant;",
  /** Moves every live login grant one day and one second into the past. */
  ageLoginGrants:
    "UPDATE device_grants SET approved_at = approved_at - 86401, created_at = created_at - 86401 WHERE client_id = 'omnigent-cli' AND status = 4;",
};

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cardFacts(html: string): string {
  const state = /data-state="([^"]+)"/.exec(html)?.[1] ?? "none";
  const reason = /data-reason="([^"]+)"/.exec(html)?.[1] ?? "none";
  const form = html.includes('action="/platform/login/repair"') ? "form" : "no-form";
  const warning = html.includes('data-warning="expiry"') ? " expiry-warning" : "";
  return `${state} ${reason} ${form}${warning}`;
}

export async function runScenarios(ports: ScenarioPorts): Promise<void> {
  let ownerPassword = ports.bootstrapSecret;
  let scenario = "setup";
  const check = async (step: string, expect: string, got: string) => {
    await ports.record({ scenario, step, expect, got, pass: expect === got });
  };
  const ownerSession = async (): Promise<string> => {
    const r = await ports.server("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: ports.username, password: ownerPassword }),
    });
    const body = (await r.json()) as { token?: unknown };
    if (r.status !== 200 || typeof body.token !== "string") {
      throw new Error(`owner login failed: http ${r.status}`);
    }
    return body.token;
  };
  const readKind = async (login: PlatformLogin) => {
    const r = await login.readSchedules();
    return r.kind === "needs_reauthentication" ? `${r.kind} ${r.reason}` : r.kind;
  };
  const readHas = async (login: PlatformLogin, id: string) => {
    const r = await login.readSchedules();
    return r.kind === "ok"
      ? r.tasks.some((t) => t.id === id)
        ? "ok, schedule listed"
        : "ok, missing"
      : r.kind;
  };
  // Each scenario records its own failure, and the next one still runs.
  const guarded = async (name: string, run: () => Promise<void>) => {
    scenario = name;
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : "error";
      await check("completed", "no error", message);
    }
  };
  const sql = async (statement: string) => {
    const r = await ports.faultSql(statement);
    if (r.exitCode !== 0) throw new Error(`fault SQL failed: ${r.output}`);
  };

  // Setup: the owner creates one schedule, as from the browser.
  const session = await ownerSession();
  const agents = (await (
    await ports.server("/v1/agents", { headers: { authorization: `Bearer ${session}` } })
  ).json()) as { data?: { id: string }[] };
  const agentId = agents.data?.[0]?.id;
  if (!agentId) throw new Error("no agent to schedule");
  const created = await ports.server("/v1/scheduled-tasks", {
    method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "s5 synthetic schedule",
      prompt: "s5 synthetic prompt",
      rrule: "FREQ=DAILY;BYHOUR=3;BYMINUTE=0",
      agent_id: agentId,
    }),
  });
  const scheduleId = ((await created.json()) as { id?: string }).id ?? "";
  await check("owner creates a schedule", "200", String(created.status));

  // A. Bootstrap, and the platform reading /v1/scheduled-tasks with its own grant.
  scenario = "bootstrap";
  const main = await ports.login("scenario-main");
  let status = await main.status();
  await check(
    "before bootstrap",
    "bootstrap_pending false",
    `${status.state} ${status.bootstrapSecretRemovable}`,
  );
  let boot = await main.bootstrap(ports.bootstrapSecret);
  await check(
    "bootstrap",
    "stored ok true",
    `${boot.outcome} ${boot.state} ${boot.secretRemovable}`,
  );
  await check(
    "platform reads /v1/scheduled-tasks with its own grant",
    "ok, schedule listed",
    await readHas(main, scheduleId),
  );
  boot = await main.bootstrap(ports.bootstrapSecret);
  await check(
    "bootstrap again does not log in again",
    "already_stored true",
    `${boot.outcome} ${boot.secretRemovable}`,
  );

  // B. A login response without refresh material, at bootstrap and at repair.
  await guarded("login without refresh", async () => {
    const fresh = await ports.login("scenario-without-refresh");
    await sql(SQL.failGrantInserts);
    boot = await fresh.bootstrap(ports.bootstrapSecret);
    status = await fresh.status();
    await check(
      "bootstrap gets HTTP 200 without refresh_token",
      "no_refresh needs_reauthentication false",
      `${boot.outcome} ${boot.state} ${boot.secretRemovable}`,
    );
    await check("reason", "login_without_refresh", String(status.reason));
    await check(
      "repair card",
      "needs_reauthentication login_without_refresh form",
      cardFacts(await ports.renderCard("scenario-without-refresh")),
    );
    const repairNoRefresh = await fresh.repair(ownerPassword);
    await check("repair while the fault holds", "no_refresh", repairNoRefresh.kind);
    await check(
      "still not removable",
      "false",
      String((await fresh.status()).bootstrapSecretRemovable),
    );
    await sql(SQL.allowGrantInserts);
    boot = await fresh.bootstrap(ports.bootstrapSecret);
    await check(
      "bootstrap retried after the fault",
      "stored ok true",
      `${boot.outcome} ${boot.state} ${boot.secretRemovable}`,
    );
    await check("reads after retry", "ok, schedule listed", await readHas(fresh, scheduleId));
  });
  // Never leave the fault behind for the scenarios that follow.
  await ports.faultSql(SQL.allowGrantInserts).catch(() => undefined);

  // C. Revocation of the platform's grant.
  await guarded("revocation", async () => {
    await main.faultRevokeStoredGrant();
    await check(
      "read after revocation",
      "needs_reauthentication grant_rejected",
      await readKind(main),
    );
    status = await main.status();
    await check("server said", "invalid_grant", String(status.serverError));
    await check(
      "repair card",
      "needs_reauthentication grant_rejected form",
      cardFacts(await ports.renderCard("scenario-main")),
    );
    await check(
      "bootstrap secret still not needed",
      "true",
      String(status.bootstrapSecretRemovable),
    );
    await check(
      "repair with a wrong password",
      "rejected",
      (await main.repair(`${ownerPassword}-wrong`)).kind,
    );
    await check(
      "reason kept after a wrong password",
      "grant_rejected",
      String((await main.status()).reason),
    );
    await check("repair with the password", "stored", (await main.repair(ownerPassword)).kind);
    await check("read after repair", "ok, schedule listed", await readHas(main, scheduleId));
  });

  // D. Password reset by an admin (the owner is the admin), which revokes sessions and grants.
  await guarded("password reset", async () => {
    const resetSession = await ownerSession();
    const reset = await ports.server(`/auth/users/${encodeURIComponent(ports.username)}/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${resetSession}` },
    });
    const resetBody = (await reset.json()) as { new_password?: string };
    await check("owner resets the password", "200", String(reset.status));
    const oldPassword = ownerPassword;
    ownerPassword = resetBody.new_password ?? ownerPassword;
    await check("read after reset", "needs_reauthentication grant_rejected", await readKind(main));
    await check(
      "repair card",
      "needs_reauthentication grant_rejected form",
      cardFacts(await ports.renderCard("scenario-main")),
    );
    await check("repair with the old password", "rejected", (await main.repair(oldPassword)).kind);
    await check("repair with the new password", "stored", (await main.repair(ownerPassword)).kind);
    await check(
      "schedule survives the reset",
      "ok, schedule listed",
      await readHas(main, scheduleId),
    );
  });

  // D2. Self-service password change, which also revokes every other login.
  await guarded("password change", async () => {
    const changeSession = await ownerSession();
    const nextPassword = randomSecret();
    const change = await ports.server("/auth/users/me/password", {
      method: "POST",
      headers: { authorization: `Bearer ${changeSession}`, "content-type": "application/json" },
      body: JSON.stringify({ old_password: ownerPassword, new_password: nextPassword }),
    });
    await check("owner changes the password", "204", String(change.status));
    ownerPassword = nextPassword;
    await check("read after change", "needs_reauthentication grant_rejected", await readKind(main));
    await check("repair with the new password", "stored", (await main.repair(ownerPassword)).kind);
    await check("read after repair", "ok, schedule listed", await readHas(main, scheduleId));
  });

  // E. Absolute expiry, with the server's lifetime shortened to one day and the grant aged.
  await guarded("absolute expiry", async () => {
    status = await main.status();
    await check(
      "lifetime known to the platform",
      "86400",
      String((status.grantLifetimeEndsAt ?? 0) - (status.grantObtainedAt ?? 0)),
    );
    await check(
      "expiry warning on the card (lifetime under 7 days)",
      "ok none form expiry-warning",
      cardFacts(await ports.renderCard("scenario-main")),
    );
    await sql(SQL.ageLoginGrants);
    await check("cached access token after the grant aged", "ok", await readKind(main));
    await main.faultDropAccessToken();
    const expiredRead = await readKind(main);
    await check(
      "read once the access token must be refreshed",
      "needs_reauthentication",
      expiredRead.split(" ")[0] ?? "",
    );
    // Omnigent answers `expired_token`, unless its opportunistic purge (at most every 5 minutes,
    // on a refresh) deleted the aged row first: then `invalid_grant`, like a revocation.
    const said = String((await main.status()).serverError);
    const pair = `${expiredRead.split(" ")[1]} ${said}`;
    await ports.record({
      scenario,
      step: "reason and server answer",
      expect: "grant_expired expired_token | grant_rejected invalid_grant (purged)",
      got: pair,
      pass: pair === "grant_expired expired_token" || pair === "grant_rejected invalid_grant",
    });
    const expiredCard = cardFacts(await ports.renderCard("scenario-main"));
    await check(
      "repair card",
      "needs_reauthentication form",
      expiredCard.replace(/ grant_\w+/, ""),
    );
    await check("repair with the password", "stored", (await main.repair(ownerPassword)).kind);
    await check("read after repair", "ok, schedule listed", await readHas(main, scheduleId));
  });
}
