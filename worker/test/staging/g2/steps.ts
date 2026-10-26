// G2 sitting (test code, never shipped): the steps the staging harness runs inside the platform
// Worker's OmnigentServer object, on the production class (platform.ts). Each step is
// resumable: its record is saved before every effect and after every stage, so a Durable
// Object restart (a version switch) costs at most the measurement in flight, never a second
// kill.
//
//   replace-1  after the bootstrap's release, as the owner with the generated password: checks
//              before (login, /v1/info, sharing managed, the running container started with the
//              released configuration, a schedule "g2-sitting: edit me"); then the container is
//              destroyed and the production watchdog replaces it. From the new boot's first
//              `running` report, the re-snapshot probe (VD-15, as WP2.5 measured it: a security
//              write every 2 s until one is confirmed, and one ordinary commit timed until the
//              replica covers it). Then the checks after (RC-02's durable half: the owner,
//              restored from R2, signs in) and RC-07's fixtures (an HTML and an SVG attachment,
//              with their content headers as Omnigent answers through the forward). It keeps
//              the session it signed in with, for `rotate`.
//   rotate     after `run.sh rotate` set a new cookie secret: waits until the watchdog has
//              restarted the server with it (G2-SEC-001's controlled restart, no kill here), then
//              checks that the session from before the rotation is refused.
//   replace-2  after the owner's edits: the same replacement, timed, with no credential (the
//              owner changed the password); the owner then checks the edits in the browser.
//   recovery   optional, once the platform runs with an empty replica prefix: the server must
//              be in recovery mode (never setup) and stay there, unrestarted.
//
// Requests go through the production forward (OmnigentServer.fetch), the path the web Worker's
// take after ingress. The control port (8001) is read directly, as the watchdog reads it.
// Results are console lines {"cfo":"g2_sitting",...}; no credential is ever logged.

export type StepName = "replace-1" | "rotate" | "replace-2" | "recovery";
export const STEP_NAMES: readonly StepName[] = ["replace-1", "rotate", "replace-2", "recovery"];

export interface EntrypointStatus {
  readonly phase: string;
  readonly bootId?: string | null;
  readonly installationInitializedExpected?: boolean | null;
  readonly recovery?: { readonly reason?: string; readonly transient?: boolean } | null;
  readonly replication?: {
    readonly txid?: number;
    readonly replicatedTxid?: number;
    readonly caughtUp?: boolean;
  } | null;
}

export interface Position {
  readonly bootId: string;
  readonly txid: number;
  readonly replicatedTxid: number;
}

export interface HttpAnswer {
  readonly status: number;
  /** Lowercased names; only the ones a step records. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `name=value` pairs of every Set-Cookie header. */
  readonly cookies: readonly string[];
  readonly json: unknown;
  readonly ms: number;
}

export interface Upload {
  readonly filename: string;
  readonly type: string;
  readonly content: string;
}

export interface HttpInit {
  readonly json?: unknown;
  readonly bearer?: string;
  readonly cookie?: string;
  readonly upload?: Upload;
}

/** What the object knows about the server's configuration (no value of any secret). */
export interface ConfigView {
  /** The fingerprint the running container was started with (the watchdog's record). */
  readonly startedWith: string | null;
  /** The fingerprint a container started now would get, from this object's environment. */
  readonly current: string;
  readonly initialized: string | null;
  readonly bootstrapPassword: boolean;
  readonly replicaUrl: string | null;
}

/** The session replace-1 keeps for `rotate`: credentials, stored apart, never logged. */
export interface KeptSession {
  readonly cookie: string;
  readonly token: string;
  readonly fingerprint: string;
}

export interface G2Ports {
  now(): number;
  sleep(ms: number): Promise<void>;
  running(): boolean;
  destroy(): Promise<void>;
  /** `GET :8001/status`, or null while the container is stopped or does not answer. */
  status(): Promise<EntrypointStatus | null>;
  /** `GET :8001/position`: 200 with a position, 503 while Litestream cannot say, 0 on error. */
  position(): Promise<{ readonly status: number; readonly body: Position | null }>;
  /** A request through the production forward. */
  http(method: string, path: string, init?: HttpInit): Promise<HttpAnswer>;
  config(): Promise<ConfigView>;
  load(step: StepName): Promise<StepRecord | undefined>;
  save(record: StepRecord): Promise<void>;
  keep(session: KeptSession): Promise<void>;
  kept(): Promise<KeptSession | undefined>;
  forget(): Promise<void>;
  log(event: string, fields: Record<string, unknown>): void;
}

export interface StepContext {
  readonly step: StepName;
  /** The generated owner password: until the owner changes it (replace-1, rotate). */
  readonly ownerPassword: string | undefined;
  readonly ownerUsername: string;
}

export type Stage = "pending" | "killed" | "answered" | "done" | "failed";

export interface ProbeWrite {
  readonly atS: number;
  readonly status: number;
  readonly code?: string;
  readonly ms: number;
}

export interface StepRecord {
  readonly step: StepName;
  stage: Stage;
  createdAt: number;
  updatedAt: number;
  invocations: number;
  waiting?: string;
  failure?: string;
  bootIdBefore?: string | null;
  before?: Record<string, unknown>;
  killSentAt?: number;
  killedAt?: number;
  /** Seconds after the kill was sent: first seen stopped, and each phase of the new boot. */
  stoppedSeenS?: number;
  phasesS?: Record<string, number>;
  newBootId?: string;
  /** When the new boot was first seen answering (or in recovery mode), absolute ms. */
  answeredAt?: number;
  answeredAfterKillS?: number;
  /** The watch was interrupted (a Durable Object restart) and resumed: its times are late. */
  resumed?: boolean;
  /** rotate and recovery: when this object first ran the new configuration. */
  switchSeenAt?: number;
  appliedAfterSwitchS?: number;
  appliedBy?: "watchdog" | "harness kill";
  probe?: Record<string, unknown>;
  replica?: Record<string, unknown>;
  after?: Record<string, unknown>;
  rc07?: Record<string, unknown>;
  rotation?: Record<string, unknown>;
  recovery?: Record<string, unknown>;
}

export const LIMITS = {
  /** From the kill to the new boot's answer. */
  watchMs: 20 * 60_000,
  /** One invocation's share of a step; the next cron tick resumes it. */
  invocationMs: 12 * 60_000,
  pollMs: 1_000,
  /** WP2.5's probe: a security write every 2 s until one is confirmed. */
  probeIntervalMs: 2_000,
  probeMs: 10 * 60_000,
  positionPollMs: 500,
  /** From this object's first sight of a new configuration to the restarted server's answer. */
  applyMs: 15 * 60_000,
  /** Recovery mode must hold this long, unrestarted. */
  recoveryHoldMs: 3 * 60_000,
} as const;

/** The empty replica prefix recovery uses (run.sh recovery sets it). */
export const EMPTY_REPLICA_MARK = "/g2-empty-";
/** The schedule the owner edits (RC-03), and the probe's, never due in the sitting. */
export const EDIT_ME = "g2-sitting: edit me";
export const RRULE = "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=3";

/** RC-07's hostile artifacts: active content that must download, never render. */
export const RC07_FILES: readonly Upload[] = [
  {
    filename: "g2-rc07.html",
    type: "text/html",
    content:
      '<!doctype html><meta charset="utf-8"><title>g2-sitting RC-07</title>' +
      "<script>document.title = 'SCRIPT RAN: RC-07 FAILED'; document.body.style.background = 'red'</script>" +
      "<p>g2-sitting RC-07 canary. If you can read this in the browser, the file was rendered.</p>",
  },
  {
    filename: "g2-rc07.svg",
    type: "image/svg+xml",
    content:
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40">' +
      "<script>document.documentElement.setAttribute('data-ran', 'yes')</script>" +
      '<text x="4" y="24">g2-sitting RC-07</text></svg>',
  },
];

/** The response headers RC-07 is about. */
export const RC07_HEADERS = [
  "content-type",
  "content-disposition",
  "x-content-type-options",
  "content-security-policy",
  "cache-control",
] as const;

const secs = (ms: number) => Math.round(ms / 100) / 10;
const ok = (status: number) => status === 200 || status === 201;

function idOf(json: unknown): string | undefined {
  const id = (json as { id?: unknown } | null)?.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

function codeOf(json: unknown): string | undefined {
  const error = (json as { error?: unknown } | null)?.error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function listOf(json: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  for (const key of keys) {
    const value = (json as Record<string, unknown> | null)?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** The editable flags of `GET /v1/sharing`: managed means there are some and none is true. */
export function sharingManaged(answer: HttpAnswer): { managed: boolean; editable: object } {
  const body = (answer.json ?? {}) as Record<string, unknown>;
  const editable = Object.fromEntries(
    Object.entries(body).filter(([k]) => k === "editable" || k.endsWith("_editable")),
  );
  const values = Object.values(editable);
  return {
    managed: answer.status === 200 && values.length > 0 && values.every((v) => v === false),
    editable,
  };
}

/**
 * Whether the running container was started with the released configuration: the watchdog's
 * record of its start equals what this object would start now, the object holds no bootstrap
 * password and `INITIALIZED=true`, and the entrypoint itself says it expects an initialized
 * installation. Fingerprints only; no value of any secret.
 */
export async function configCheck(ports: G2Ports) {
  const config = await ports.config();
  const status = await ports.status();
  const startedWithCurrent = config.startedWith !== null && config.startedWith === config.current;
  const released = !config.bootstrapPassword && config.initialized === "true";
  return {
    startedWith: config.startedWith,
    current: config.current,
    startedWithCurrent,
    released,
    entrypointExpectsInitialized: status?.installationInitializedExpected ?? null,
    pass: startedWithCurrent && released && status?.installationInitializedExpected === true,
  };
}

/** Runs one step as far as it can in this invocation. Never throws; the record says why. */
export async function runStep(ports: G2Ports, ctx: StepContext): Promise<StepRecord> {
  const started = ports.now();
  let record: StepRecord = (await ports.load(ctx.step)) ?? {
    step: ctx.step,
    stage: "pending",
    createdAt: started,
    updatedAt: started,
    invocations: 0,
  };
  if (record.stage === "done" || record.stage === "failed") return record;
  record = { ...record, invocations: record.invocations + 1 };
  const save = async () => {
    record.updatedAt = ports.now();
    await ports.save(record);
  };
  const wait = async (why: string) => {
    if (record.waiting !== why) ports.log("step_waiting", { step: ctx.step, why });
    record.waiting = why;
    await save();
    return record;
  };
  try {
    if (record.stage === "pending") {
      const why = await prerequisites(ports, ctx, record, started);
      if (why === "applied") {
        // rotate, recovery: the watchdog restarted the server with the new configuration.
        delete record.waiting;
        record.stage = "answered";
        await save();
      } else if (why === "kill") {
        delete record.waiting;
        await kill(ports, record, ctx, save);
      } else {
        return await wait(why);
      }
    }
    if (record.stage === "killed") {
      const reached = await watch(ports, record, ctx, started);
      await save();
      if (!reached) return record;
      record.stage = "answered";
      await save();
      ports.log("answered", {
        step: ctx.step,
        afterKillS: record.answeredAfterKillS,
        phasesS: record.phasesS,
        resumed: record.resumed ?? false,
      });
    }
    if (record.stage === "answered") {
      await afterAnswer(ports, record, ctx);
      record.stage = "done";
      await save();
      ports.log("step_done", { step: ctx.step, record });
    }
  } catch (error) {
    record.stage = "failed";
    record.failure = (error instanceof Error ? error.message : String(error)).slice(0, 300);
    await save();
    ports.log("step_failed", { step: ctx.step, failure: record.failure });
  }
  return record;
}

async function answering(ports: G2Ports): Promise<string | undefined> {
  if (!ports.running()) return "the server is not running";
  const status = await ports.status();
  if (status?.phase !== "running") return `the server reports ${status?.phase ?? "nothing"}`;
  const health = await ports.http("GET", "/health");
  if (health.status !== 200) return `the server's health check answered ${health.status}`;
  return undefined;
}

/**
 * "kill" when the step's container should be destroyed now, "applied" when the watchdog has
 * already restarted it with the new configuration (rotate, recovery), else why it waits.
 */
async function prerequisites(
  ports: G2Ports,
  ctx: StepContext,
  record: StepRecord,
  started: number,
): Promise<string> {
  if (ctx.step === "replace-1" || ctx.step === "replace-2") {
    if (ctx.step === "replace-1") {
      const config = await ports.config();
      if (config.bootstrapPassword) return "the bootstrap has not released yet";
      if (!ctx.ownerPassword) return "G2_OWNER_PASSWORD is not set";
    }
    return (await answering(ports)) ?? "kill";
  }
  // rotate and recovery: a new configuration, which the watchdog applies with a restart.
  const config = await ports.config();
  if (ctx.step === "rotate") {
    const kept = await ports.kept();
    if (kept === undefined) return "no session kept by replace-1";
    if (config.current === kept.fingerprint) {
      return "this object still runs the configuration from before the rotation";
    }
  } else if (!config.replicaUrl?.includes(EMPTY_REPLICA_MARK)) {
    return "this object does not run with the empty replica yet";
  }
  for (;;) {
    const now = ports.now();
    record.switchSeenAt ??= now;
    const status = await ports.status();
    const target = ctx.step === "recovery" ? "recovery" : "running";
    const applied =
      (await ports.config()).startedWith === config.current &&
      ports.running() &&
      status?.phase === target &&
      (target === "recovery" || (await ports.http("GET", "/health")).status === 200);
    if (applied) {
      if (status?.bootId) record.newBootId = status.bootId;
      record.answeredAt = now;
      record.appliedAfterSwitchS = secs(now - record.switchSeenAt);
      record.appliedBy = "watchdog";
      if (status?.phase === "recovery") record.recovery = { reason: status.recovery?.reason };
      return "applied";
    }
    if (now - record.switchSeenAt > LIMITS.applyMs) {
      if (ctx.step === "recovery") {
        // Not this step's subject: start the empty-replica server by a kill instead.
        record.appliedBy = "harness kill";
        return "kill";
      }
      throw new Error(
        `the new configuration did not reach the server within ${LIMITS.applyMs / 60_000} minutes of this object running it (G2-SEC-001)`,
      );
    }
    if (now - started > LIMITS.invocationMs) return "the server still runs the old configuration";
    await ports.sleep(LIMITS.pollMs);
  }
}

async function kill(
  ports: G2Ports,
  record: StepRecord,
  ctx: StepContext,
  save: () => Promise<void>,
): Promise<void> {
  record.bootIdBefore = (await ports.status())?.bootId ?? null;
  if (ctx.step === "replace-1") record.before = await checksBefore(ports, ctx);
  else record.before = { config: await configCheck(ports) };
  // Persist before the effect: a restart after this line never kills twice.
  record.killSentAt = ports.now();
  record.stage = "killed";
  await save();
  ports.log("kill_sent", { step: ctx.step, bootIdBefore: record.bootIdBefore });
  await ports.destroy();
  record.killedAt = ports.now();
  await save();
}

async function login(ports: G2Ports, ctx: StepContext, password: string): Promise<HttpAnswer> {
  return ports.http("POST", "/auth/login", {
    json: { username: ctx.ownerUsername, password, issue_refresh: false },
  });
}

async function signIn(
  ports: G2Ports,
  ctx: StepContext,
): Promise<{ token: string; cookie: string }> {
  const answer = await login(ports, ctx, ctx.ownerPassword ?? "");
  const token = (answer.json as { token?: unknown } | null)?.token;
  if (answer.status !== 200 || typeof token !== "string") {
    throw new Error(`the owner's login answered ${answer.status}`);
  }
  return { token, cookie: answer.cookies.join("; ") };
}

async function bearer(ports: G2Ports, ctx: StepContext): Promise<string> {
  return (await signIn(ports, ctx)).token;
}

async function agentId(ports: G2Ports, token: string): Promise<string> {
  const answer = await ports.http("GET", "/v1/agents", { bearer: token });
  const id = idOf(listOf(answer.json, "data", "agents")[0]);
  if (answer.status !== 200 || id === undefined) {
    throw new Error(`GET /v1/agents answered ${answer.status} without an agent`);
  }
  return id;
}

function schedule(name: string, agent: string) {
  return { name, prompt: "g2-sitting canary", rrule: RRULE, agent_id: agent, timezone: "UTC" };
}

async function info(ports: G2Ports) {
  const answer = await ports.http("GET", "/v1/info");
  const body = (answer.json ?? {}) as Record<string, unknown>;
  return {
    status: answer.status,
    accounts_enabled: body.accounts_enabled,
    needs_setup: body.needs_setup,
  };
}

async function schedules(ports: G2Ports, token: string): Promise<unknown[]> {
  const answer = await ports.http("GET", "/v1/scheduled-tasks", { bearer: token });
  return listOf(answer.json, "data", "scheduled_tasks");
}

async function checksBefore(ports: G2Ports, ctx: StepContext): Promise<Record<string, unknown>> {
  const config = await configCheck(ports);
  if (!config.pass) ports.log("config_mismatch", { step: ctx.step, config });
  const token = await bearer(ports, ctx);
  const agent = await agentId(ports, token);
  const sharing = sharingManaged(await ports.http("GET", "/v1/sharing", { bearer: token }));
  let editMe = idOf(
    (await schedules(ports, token)).find((t) => (t as { name?: unknown }).name === EDIT_ME),
  );
  let created: HttpAnswer | undefined;
  if (editMe === undefined) {
    created = await ports.http("POST", "/v1/scheduled-tasks", {
      bearer: token,
      json: schedule(EDIT_ME, agent),
    });
    editMe = idOf(created.json);
  }
  return {
    config,
    login: 200,
    info: await info(ports),
    sharing,
    editMe: { id: editMe, status: created?.status ?? "existed", ms: created?.ms },
    position: (await ports.position()).body,
  };
}

/** Follows the replacement until the new boot answers (or enters recovery). */
async function watch(
  ports: G2Ports,
  record: StepRecord,
  ctx: StepContext,
  started: number,
): Promise<boolean> {
  const killSentAt = record.killSentAt ?? started;
  const target = ctx.step === "recovery" ? "recovery" : "running";
  if (record.phasesS !== undefined) record.resumed = true;
  record.phasesS ??= {};
  for (;;) {
    const now = ports.now();
    if (!ports.running()) {
      record.stoppedSeenS ??= secs(now - killSentAt);
    } else {
      const status = await ports.status();
      if (status?.bootId && status.bootId !== record.bootIdBefore) {
        record.newBootId = status.bootId;
        record.phasesS[status.phase] ??= secs(ports.now() - killSentAt);
        if (status.phase === target || status.phase === "recovery") {
          record.answeredAt = ports.now();
          record.answeredAfterKillS = secs(record.answeredAt - killSentAt);
          if (status.phase === "recovery") {
            record.recovery = { reason: status.recovery?.reason ?? null };
            if (target === "running") throw new Error("the replacement entered recovery mode");
          }
          return true;
        }
      }
    }
    if (now - killSentAt > LIMITS.watchMs) {
      throw new Error(`no ${target} report within ${LIMITS.watchMs / 60_000} minutes of the kill`);
    }
    if (now - started > LIMITS.invocationMs) return false;
    await ports.sleep(LIMITS.pollMs);
  }
}

async function afterAnswer(ports: G2Ports, record: StepRecord, ctx: StepContext): Promise<void> {
  const from = record.answeredAt ?? ports.now();
  switch (ctx.step) {
    case "replace-1": {
      // Both views start at once, from the first `running` report (WP2.5 r1-7).
      const [probe, replica] = await Promise.all([
        personView(ports, ctx, from).catch((e: unknown) => ({ error: String(e).slice(0, 200) })),
        replicaView(ports, ctx, from).catch((e: unknown) => ({ error: String(e).slice(0, 200) })),
      ]);
      record.probe = { ...probe, interrupted: record.resumed ?? false };
      record.replica = replica;
      record.after = await checksAfter(ports, ctx, record);
      record.rc07 = await rc07(ports, ctx);
      return;
    }
    case "rotate":
      record.rotation = await rotationRefusesOldSession(ports, ctx);
      return;
    case "replace-2":
      record.replica = await caughtUp(ports, from);
      record.after = {
        config: await configCheck(ports),
        health: (await ports.http("GET", "/health")).status,
        info: await info(ports),
      };
      return;
    case "recovery":
      record.recovery = { ...record.recovery, ...(await recoveryHolds(ports, record, from)) };
      return;
  }
}

/** A security write every 2 s from the answer until one is confirmed (S4, WP2.5). */
async function personView(ports: G2Ports, ctx: StepContext, from: number) {
  const token = await bearer(ports, ctx);
  const agent = await agentId(ports, token);
  const writes: ProbeWrite[] = [];
  for (let n = 0; ports.now() - from < LIMITS.probeMs; n++) {
    const sent = ports.now();
    const answer = await ports.http("POST", "/v1/scheduled-tasks", {
      bearer: token,
      json: schedule(`g2-resnapshot-${n}`, agent),
    });
    const code = codeOf(answer.json);
    writes.push({
      atS: secs(sent - from),
      status: answer.status,
      ms: Math.round(answer.ms),
      ...(code ? { code } : {}),
    });
    if (ok(answer.status)) break;
    await ports.sleep(LIMITS.probeIntervalMs);
  }
  const confirmed = writes.find((w) => ok(w.status));
  return {
    measuredFrom: "the new boot's first running report",
    firstConfirmedWriteSentS: confirmed?.atS ?? null,
    firstConfirmedWriteAnsweredS: confirmed ? secs(confirmed.atS * 1000 + confirmed.ms) : null,
    unconfirmedWritesBefore: writes.filter((w) => w.status === 424).length,
    writes,
  };
}

/** One ordinary commit at once, then the time until the replica's position covers it. */
async function replicaView(ports: G2Ports, ctx: StepContext, from: number) {
  const token = await bearer(ports, ctx);
  const agent = await agentId(ports, token);
  const commitSentS = secs(ports.now() - from);
  const session = await ports.http("POST", "/v1/sessions", {
    bearer: token,
    json: { agent_id: agent },
  });
  if (!ok(session.status)) throw new Error(`POST /v1/sessions answered ${session.status}`);
  let target: Position | null = null;
  let unavailable = 0;
  while (ports.now() - from < LIMITS.probeMs) {
    const position = await ports.position();
    if (position.status !== 200 || position.body === null) {
      unavailable += 1; // 503 while Litestream uploads (WP2.6): ask again
    } else if (target === null) {
      target = position.body;
    } else if (position.body.bootId !== target.bootId) {
      throw new Error("the server restarted during the probe");
    }
    if (target !== null && position.body && position.body.replicatedTxid >= target.txid) {
      return {
        commitSentS,
        targetTxid: target.txid,
        newCommitDurableAfterS: secs(ports.now() - from),
        positionUnavailable: unavailable,
      };
    }
    await ports.sleep(LIMITS.positionPollMs);
  }
  return { commitSentS, newCommitDurableAfterS: null, positionUnavailable: unavailable };
}

/** Without a commit of its own: when the new boot's replica first covers its database. */
async function caughtUp(ports: G2Ports, from: number) {
  while (ports.now() - from < LIMITS.probeMs) {
    const replication = (await ports.status())?.replication;
    if (replication?.caughtUp === true) {
      return { caughtUpAfterS: secs(ports.now() - from), txid: replication.txid ?? null };
    }
    await ports.sleep(LIMITS.positionPollMs);
  }
  return { caughtUpAfterS: null };
}

async function checksAfter(ports: G2Ports, ctx: StepContext, record: StepRecord) {
  const owner = await login(ports, ctx, ctx.ownerPassword ?? "");
  const wrong = await login(ports, ctx, `${ctx.ownerPassword ?? ""}-not-it`);
  const token = (owner.json as { token?: unknown } | null)?.token;
  const tasks = typeof token === "string" ? await schedules(ports, token) : [];
  const wanted = (record.before?.editMe as { id?: string } | undefined)?.id;
  const editMe = tasks.find((t) => idOf(t) === wanted);
  if (owner.status === 200 && typeof token === "string") {
    // The session `rotate` checks after the cookie key changes. Never logged.
    await ports.keep({
      cookie: owner.cookies.join("; "),
      token,
      fingerprint: (await ports.config()).current,
    });
  }
  return {
    config: await configCheck(ports),
    ownerLogin: owner.status,
    wrongPassword: wrong.status,
    info: await info(ports),
    editMeKept: (editMe as { name?: unknown } | undefined)?.name === EDIT_ME,
    schedules: tasks.length,
    sharing: sharingManaged(
      await ports.http("GET", "/v1/sharing", typeof token === "string" ? { bearer: token } : {}),
    ),
  };
}

/** RC-07's fixtures: a session holding the hostile artifacts, and their content headers. */
async function rc07(ports: G2Ports, ctx: StepContext) {
  const token = await bearer(ports, ctx);
  const agent = await agentId(ports, token);
  const session = await ports.http("POST", "/v1/sessions", {
    bearer: token,
    json: { agent_id: agent },
  });
  const sessionId = idOf(session.json);
  if (!ok(session.status) || sessionId === undefined) {
    return { session: session.status, files: [] };
  }
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/resources/files`;
  const files = [];
  for (const upload of RC07_FILES) {
    const created = await ports.http("POST", base, { bearer: token, upload });
    const fileId = idOf(created.json);
    if (!ok(created.status) || fileId === undefined) {
      files.push({ filename: upload.filename, upload: created.status, code: codeOf(created.json) });
      continue;
    }
    const path = `${base}/${encodeURIComponent(fileId)}/content`;
    const content = await ports.http("GET", path, { bearer: token });
    files.push({
      filename: upload.filename,
      upload: created.status,
      path,
      content: content.status,
      headers: Object.fromEntries(
        RC07_HEADERS.filter((h) => content.headers[h] !== undefined).map((h) => [
          h,
          content.headers[h],
        ]),
      ),
    });
  }
  return { sessionId, files };
}

/** After the cookie key changed: the kept session is refused, a new sign-in works. */
async function rotationRefusesOldSession(ports: G2Ports, ctx: StepContext) {
  const kept = await ports.kept();
  if (kept === undefined) throw new Error("no session kept by replace-1");
  const oldCookie = await ports.http("GET", "/auth/me", { cookie: kept.cookie });
  const oldBearer = await ports.http("GET", "/auth/me", { bearer: kept.token });
  const fresh = await signIn(ports, ctx);
  const newCookie = await ports.http("GET", "/auth/me", { cookie: fresh.cookie });
  await ports.forget();
  return {
    config: await configCheck(ports),
    oldCookie: oldCookie.status,
    oldBearer: oldBearer.status,
    newCookie: newCookie.status,
    cookieNames: kept.cookie.split("; ").map((pair) => pair.split("=")[0]),
    pass: oldCookie.status === 401 && newCookie.status === 200,
  };
}

/** Recovery mode must answer for itself, never offer setup, and never be restarted. */
async function recoveryHolds(ports: G2Ports, record: StepRecord, from: number) {
  const answers: Record<string, number> = {};
  for (const path of ["/", "/v1/info", "/health"]) {
    answers[path] = (await ports.http("GET", path)).status;
  }
  const setup = await ports.http("POST", "/auth/setup", {
    json: { username: "g2-intruder", password: "g2-intruder-password" },
  });
  while (ports.now() - from < LIMITS.recoveryHoldMs) await ports.sleep(5_000);
  const status = await ports.status();
  return {
    answers,
    setupPost: setup.status,
    heldS: secs(ports.now() - from),
    stillRecovery: status?.phase === "recovery",
    sameBoot: status?.bootId === record.newBootId,
    reasonAtEnd: status?.recovery?.reason ?? null,
  };
}
