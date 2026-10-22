// The harness Worker's pure parts: the owner's R2 credentials, the containers' environments,
// the harness's status, and what the Durable Object's alarm does next. No Workers APIs here.

/** How long one run may last before it stops itself and forgets the credentials. */
export const RUN_WINDOW_MS = 3 * 60 * 60_000;
/** The alarm's period while a run is active. */
export const ALARM_MS = 15_000;
/** Polls without an answer from the harness before a run counts as failed. */
export const MAX_MISSED_POLLS = 12;
/** How long the replaced container may take to serve Omnigent's /health. */
export const REPLACEMENT_HEALTH_TIMEOUT_MS = 20 * 60_000;

const ENDPOINT = /^https:\/\/[0-9a-f]{32}\.(?:(?:eu|fedramp)\.)?r2\.cloudflarestorage\.com$/;
const ACCESS_KEY_ID = /^[0-9a-f]{32}$/;
const SECRET_ACCESS_KEY = /^[0-9a-f]{64}$/;
/** Result names the harness may report; they become R2 object names. */
export const RESULT_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RUN_ID = /^run-\d{8}t\d{6}z-[0-9a-f]{6}$/;

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

/** An R2 API token's S3 credentials, as the dashboard shows them once, scoped to one bucket. */
export interface R2Credentials {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The owner's form. Only exactly these three fields, in R2's own formats, are accepted, so
 * nothing else can reach the container's environment. The reason never echoes a value.
 */
export function parseCredentials(input: unknown): Parsed<R2Credentials> {
  if (!isRecord(input)) return { ok: false, reason: "the body must be a JSON object" };
  const keys = Object.keys(input).sort().join(",");
  if (keys !== "accessKeyId,endpoint,secretAccessKey") {
    return { ok: false, reason: "expected exactly endpoint, accessKeyId and secretAccessKey" };
  }
  const { endpoint, accessKeyId, secretAccessKey } = input;
  if (typeof endpoint !== "string" || !ENDPOINT.test(endpoint.trim().toLowerCase())) {
    return { ok: false, reason: "endpoint must be https://<account id>.r2.cloudflarestorage.com" };
  }
  if (typeof accessKeyId !== "string" || !ACCESS_KEY_ID.test(accessKeyId.trim())) {
    return { ok: false, reason: "accessKeyId must be 32 hexadecimal characters" };
  }
  if (typeof secretAccessKey !== "string" || !SECRET_ACCESS_KEY.test(secretAccessKey.trim())) {
    return { ok: false, reason: "secretAccessKey must be 64 hexadecimal characters" };
  }
  return {
    ok: true,
    value: {
      endpoint: endpoint.trim().toLowerCase(),
      accessKeyId: accessKeyId.trim(),
      secretAccessKey: secretAccessKey.trim(),
    },
  };
}

/** The Worker's configuration of a run, from its variables. */
export interface RunConfig {
  readonly bucket: string;
  readonly plan: string;
  readonly barrierWrites: string;
  readonly barrierItems: string;
  readonly idleSeconds: string;
}

/** A run's own values. The owner password and cookie secret are generated for the run. */
export interface RunSettings extends RunConfig {
  readonly runId: string;
  readonly ownerPassword: string;
  readonly cookieSecret: string;
}

export function newRunId(now: Date, hex6: string): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "z")
    .toLowerCase();
  const id = `run-${stamp}-${hex6}`;
  if (!RUN_ID.test(id)) throw new Error("bad run id");
  return id;
}

export function resultKey(runId: string, name: string): string {
  if (!RUN_ID.test(runId) || !RESULT_NAME.test(name)) throw new Error("bad result name");
  return `results/${runId}/${name}.json`;
}

/** The measurement container's environment: the harness's settings and Litestream's token. */
export function harnessEnv(run: RunSettings, creds: R2Credentials): Record<string, string> {
  return {
    DRILL_MODE: "measure",
    DRILL_RUN_ID: run.runId,
    DRILL_PLAN: run.plan,
    DRILL_BUCKET: run.bucket,
    DRILL_ENDPOINT: creds.endpoint,
    DRILL_REGION: "auto",
    DRILL_OWNER_PASSWORD: run.ownerPassword,
    DRILL_COOKIE_SECRET: run.cookieSecret,
    DRILL_BARRIER_WRITES: run.barrierWrites,
    DRILL_BARRIER_ITEMS: run.barrierItems,
    DRILL_IDLE_S: run.idleSeconds,
    LITESTREAM_ACCESS_KEY_ID: creds.accessKeyId,
    LITESTREAM_SECRET_ACCESS_KEY: creds.secretAccessKey,
  };
}

export interface Awaiting {
  readonly prefix: string;
  readonly manifest: string;
  readonly fillerRows: number;
}

/** The replacement container's environment: the same, restoring ``awaiting.prefix``. */
export function replacedEnv(
  run: RunSettings,
  creds: R2Credentials,
  awaiting: Awaiting,
): Record<string, string> {
  return {
    ...harnessEnv(run, creds),
    DRILL_MODE: "replaced",
    DRILL_REPLACED_PREFIX: awaiting.prefix,
    DRILL_REPLACED_MANIFEST: awaiting.manifest,
    DRILL_REPLACED_FILLER_ROWS: String(awaiting.fillerRows),
  };
}

/** What the harness reports on its status port, checked before anything acts on it. */
export interface HarnessStatus {
  readonly mode: string;
  readonly phase: string | null;
  readonly done: boolean;
  readonly results: readonly string[];
  readonly errors: Readonly<Record<string, string>>;
  readonly awaiting: Awaiting | null;
}

export function parseHarnessStatus(input: unknown): Parsed<HarnessStatus> {
  if (!isRecord(input)) return { ok: false, reason: "not an object" };
  const { mode, phase, done, results, errors, awaiting_replacement: waiting } = input;
  if (typeof mode !== "string" || typeof done !== "boolean") {
    return { ok: false, reason: "mode or done missing" };
  }
  if (phase !== null && typeof phase !== "string") return { ok: false, reason: "bad phase" };
  if (
    !Array.isArray(results) ||
    !results.every((r) => typeof r === "string" && RESULT_NAME.test(r))
  ) {
    return { ok: false, reason: "bad results" };
  }
  const errorMap: Record<string, string> = {};
  if (isRecord(errors)) {
    for (const [k, v] of Object.entries(errors)) errorMap[k] = String(v).slice(0, 100);
  }
  let awaiting: Awaiting | null = null;
  if (waiting !== null && waiting !== undefined) {
    if (
      !isRecord(waiting) ||
      typeof waiting.prefix !== "string" ||
      !RESULT_NAME.test(waiting.prefix) ||
      typeof waiting.manifest !== "string" ||
      waiting.manifest.length > 64_000 ||
      typeof waiting.filler_rows !== "number" ||
      !Number.isInteger(waiting.filler_rows)
    ) {
      return { ok: false, reason: "bad awaiting_replacement" };
    }
    awaiting = {
      prefix: waiting.prefix,
      manifest: waiting.manifest,
      fillerRows: waiting.filler_rows,
    };
  }
  return {
    ok: true,
    value: {
      mode,
      phase: (phase as string | null) ?? null,
      done,
      results,
      errors: errorMap,
      awaiting,
    },
  };
}

export type Outcome = "done" | "stopped" | "expired" | "failed";

/** The container replacement on Cloudflare, timed by the Durable Object (epoch ms). */
export interface Replacement {
  readonly prefix: string;
  readonly requestedAt: number;
  readonly stoppedAt?: number;
  readonly startCalledAt?: number;
  readonly healthyAt?: number;
  readonly error?: string;
}

/** A run as the Durable Object keeps it. No credential is ever part of it. */
export interface RunRecord {
  readonly runId: string;
  readonly startedAt: number;
  readonly armedUntil: number;
  readonly mode: "measure" | "replaced";
  readonly phase: string | null;
  readonly stored: readonly string[];
  readonly errors: Readonly<Record<string, string>>;
  readonly missedPolls: number;
  readonly replacement?: Replacement;
  readonly outcome?: Outcome;
  readonly finishedAt?: number;
}

export type Action =
  | { readonly kind: "store"; readonly names: readonly string[] }
  | { readonly kind: "replace"; readonly awaiting: Awaiting }
  | { readonly kind: "await-health" }
  | { readonly kind: "finish"; readonly outcome: Outcome };

/**
 * What the alarm does next, from the run and what it just observed (``status`` is null when
 * the harness did not answer). Results are stored before anything finishes the run.
 */
export function decide(run: RunRecord, status: HarnessStatus | null, now: number): Action[] {
  if (run.outcome !== undefined) return [];
  const actions: Action[] = [];
  if (status !== null) {
    const fresh = status.results.filter((name) => !run.stored.includes(name));
    if (fresh.length > 0) actions.push({ kind: "store", names: fresh });
  }
  if (now >= run.armedUntil) return [...actions, { kind: "finish", outcome: "expired" }];
  const replacement = run.replacement;
  if (replacement !== undefined && replacement.healthyAt === undefined) {
    if (replacement.error !== undefined) return [...actions, { kind: "finish", outcome: "failed" }];
    if (now - replacement.requestedAt > REPLACEMENT_HEALTH_TIMEOUT_MS) {
      return [...actions, { kind: "finish", outcome: "failed" }];
    }
    return [...actions, { kind: "await-health" }];
  }
  if (status === null) {
    // The caller counts this poll as missed; a harness silent for MAX_MISSED_POLLS has failed.
    return run.missedPolls + 1 >= MAX_MISSED_POLLS
      ? [...actions, { kind: "finish", outcome: "failed" }]
      : actions;
  }
  if (run.mode === "measure" && status.awaiting !== null && replacement === undefined) {
    return [...actions, { kind: "replace", awaiting: status.awaiting }];
  }
  if (status.done) return [...actions, { kind: "finish", outcome: "done" }];
  return actions;
}

/** The replacement's durations, for the evidence. */
export function replacementTimings(r: Replacement): Record<string, number | null> {
  const span = (a?: number, b?: number) => (a !== undefined && b !== undefined ? b - a : null);
  return {
    stopMs: span(r.requestedAt, r.stoppedAt),
    startToHealthyMs: span(r.startCalledAt, r.healthyAt),
    lossToHealthyMs: span(r.requestedAt, r.healthyAt),
  };
}
