// Reading the watchdog's bootstrap events from Workers Logs (WP2.4). Pure: no I/O, so the
// Workers-runtime tests can feed it what the real OmnigentServer logs.
//
// While the bootstrap password exists, OmnigentServer's watchdog (WP2.2) logs one structured
// line on every check, about once a minute:
//
//   {"cfo":"bootstrap","event":"status","reason":"durable",
//    "bootstrapStatus":{"protocolVersion":1,"installationId":"ins_…","initialized":true,
//                       "checkedAt":"…"},"secretPresent":true,"configApplied":true}
//
// `initialized` is true only when Omnigent's `/v1/info` shows `accounts_enabled: true` and
// `needs_setup: false` and the replicated position covers the owner's commit (X0, G1BR-002).
// The log is a notice, never the only record: the status itself is stored in the object, and a
// lost line recurs a minute later.
//
// `configApplied` says the answering server was started with the configuration the logging
// version holds. A container gets its environment only when it starts, so a release reaches the
// running server only once the watchdog has replaced it (G2-SEC-001). For a while after that,
// the watchdog logs the same line without the password: the proof that the release applied.
//
// The same line says whether Omnigent lists GitHub linking (`githubLinking`, WP3.36): the
// installer's GitHub step waits for it from a server started with the App's settings
// (`checkGitHubLinking`). The watchdog's `config_error` line says a server exited with a missing
// or malformed setting (78) and is held until the configuration changes.
//
// The bootstrap accepts only the newest status of this installation, from this installation's
// platform Worker, and only while it is fresh. A status from another installation, an older
// one, a contradictory one, or one that does not parse as the contract is never accepted.

import { BootstrapStatus, SUPPORTED_BOOTSTRAP_STATUS_VERSIONS } from "../../contracts/src/index.ts";

/** One bootstrap status line, as Workers Logs delivered it. */
export interface StatusEvent {
  /** When Workers Logs recorded it, in milliseconds. */
  readonly loggedAt: number;
  /** The platform Worker version that logged it, when Workers Logs says. */
  readonly versionId: string | undefined;
  readonly status: BootstrapStatus;
  readonly reason: string | undefined;
  readonly secretPresent: boolean | undefined;
  /**
   * The server that answered was started with the logging version's configuration. Undefined
   * from a build that did not say: never proof that a release reached the server.
   */
  readonly configApplied: boolean | undefined;
  /**
   * Whether Omnigent's `/v1/info` listed GitHub linking (WP3.36): null when its answer did not
   * say, undefined from a build that does not report it.
   */
  readonly githubLinking?: boolean | null | undefined;
  /** Whether the logging version holds the GitHub App's settings (WP3.36); undefined: unsaid. */
  readonly githubApp?: boolean | undefined;
}

/** The watchdog's `config_error` line: a server exited with a missing or malformed setting. */
export interface ConfigErrorEvent {
  readonly loggedAt: number;
  readonly versionId: string | undefined;
}

/** Any invocation of the platform Worker, for the check after the release. */
export interface Invocation {
  readonly loggedAt: number;
  readonly versionId: string | undefined;
  readonly eventType: string | undefined;
  /** The class or entrypoint that ran, such as "OmnigentServer". */
  readonly entrypoint: string | undefined;
}

export interface ParsedLogs {
  readonly statuses: readonly StatusEvent[];
  readonly invocations: readonly Invocation[];
  /** The watchdog's `config_error` lines, from the OmnigentServer object (WP3.36). */
  readonly configErrors: readonly ConfigErrorEvent[];
  /**
   * Bootstrap lines that are not the contract, or not from the OmnigentServer object: never
   * accepted, counted for the report.
   */
  readonly malformed: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The structured line inside one Workers Logs event: Workers Logs parses a JSON line into
 * `source`, or keeps it as `source.message`.
 */
function logLine(source: unknown): Record<string, unknown> | undefined {
  const object = record(source);
  if (object === undefined) return undefined;
  if (typeof object.message === "string" && object.cfo === undefined) {
    try {
      return record(JSON.parse(object.message));
    } catch {
      return undefined;
    }
  }
  return object;
}

const supported: readonly number[] = SUPPORTED_BOOTSTRAP_STATUS_VERSIONS;

/**
 * The Durable Object class whose own invocations log the status. A line from anything else,
 * such as the server container's output, which Workers Logs also collects for the Worker, is
 * not the watchdog's and never counts.
 */
export const STATUS_ENTRYPOINT = "OmnigentServer";

/**
 * The bootstrap lines and invocations of `scriptName` among Workers Logs events, as `cf o11y
 * telemetry query` answers them (`events.events`). Events of other scripts are ignored.
 */
export function parseLogs(events: readonly unknown[], scriptName: string): ParsedLogs {
  const statuses: StatusEvent[] = [];
  const invocations: Invocation[] = [];
  const configErrors: ConfigErrorEvent[] = [];
  let malformed = 0;
  for (const raw of events) {
    const event = record(raw);
    const workers = record(event?.$workers);
    if (event === undefined || workers?.scriptName !== scriptName) continue;
    const loggedAt = typeof event.timestamp === "number" ? event.timestamp : Number.NaN;
    if (!Number.isFinite(loggedAt)) continue;
    const version = record(workers.scriptVersion)?.id;
    const versionId = typeof version === "string" && version !== "" ? version : undefined;
    const eventType = typeof workers.eventType === "string" ? workers.eventType : undefined;
    const entrypoint = typeof workers.entrypoint === "string" ? workers.entrypoint : undefined;
    invocations.push({ loggedAt, versionId, eventType, entrypoint });
    const line = logLine(event.source);
    if (
      line?.cfo === "watchdog" &&
      line.event === "config_error" &&
      workers.entrypoint === STATUS_ENTRYPOINT
    ) {
      configErrors.push({ loggedAt, versionId });
      continue;
    }
    if (line?.cfo !== "bootstrap" || line.event !== "status") continue;
    const status = BootstrapStatus.safeParse(line.bootstrapStatus);
    if (
      workers.entrypoint !== STATUS_ENTRYPOINT ||
      !status.success ||
      !supported.includes(status.data.protocolVersion)
    ) {
      malformed++;
      continue;
    }
    statuses.push({
      loggedAt,
      versionId,
      status: status.data,
      reason: typeof line.reason === "string" ? line.reason : undefined,
      secretPresent: typeof line.secretPresent === "boolean" ? line.secretPresent : undefined,
      configApplied: typeof line.configApplied === "boolean" ? line.configApplied : undefined,
      githubLinking:
        typeof line.githubLinking === "boolean" || line.githubLinking === null
          ? line.githubLinking
          : undefined,
      githubApp: typeof line.githubApp === "boolean" ? line.githubApp : undefined,
    });
  }
  return { statuses, invocations, configErrors, malformed };
}

export interface AcceptanceRules {
  readonly installationId: string;
  /** The laptop's clock, in milliseconds, read after the query returned. */
  readonly now: number;
  /**
   * The newest status of this installation seen before this query, in this run or an earlier
   * one (the watermark). An older status never overrides it, so a status seen once cannot be
   * forgotten by a later query that misses it (lost lines, a clock moved back). It can only
   * hold the bootstrap back: acceptance needs a status in this query's answer.
   */
  readonly seen?: StatusEvent | undefined;
  /** How old the newest status may be (default ten minutes; the watchdog logs every minute). */
  readonly freshMs?: number;
  /** How far ahead of the laptop's clock a status may claim to be (clock skew). */
  readonly skewMs?: number;
}

export type Decision =
  | { readonly accepted: true; readonly event: StatusEvent }
  | {
      readonly accepted: false;
      /** Why not, in words for the installer; names no secret. */
      readonly why: string;
      /** The newest status of this installation, if any. */
      readonly latest: StatusEvent | undefined;
    };

export const FRESH_MS = 10 * 60_000;
export const SKEW_MS = 5 * 60_000;

function time(status: BootstrapStatus): number {
  return Date.parse(status.checkedAt);
}

/** Whether `b` is newer than `a`: by the watchdog's own clock, then by Workers Logs' time. */
function newer(b: StatusEvent, a: StatusEvent): boolean {
  return (
    time(b.status) > time(a.status) ||
    (time(b.status) === time(a.status) && b.loggedAt > a.loggedAt)
  );
}

/** The newest of these statuses, or undefined. */
export function newest(statuses: readonly StatusEvent[]): StatusEvent | undefined {
  return statuses.reduce<StatusEvent | undefined>(
    (a, b) => (a === undefined || newer(b, a) ? b : a),
    undefined,
  );
}

/** Problems with a status's age at `now`: too old, or from the future; undefined when fresh. */
export function staleness(
  event: StatusEvent,
  now: number,
  freshMs: number = FRESH_MS,
  skewMs: number = SKEW_MS,
): string | undefined {
  const age = now - time(event.status);
  if (age > freshMs) return "the newest bootstrap status is too old";
  if (-age > skewMs) {
    return "the newest bootstrap status is from the future: check this laptop's clock";
  }
  return undefined;
}

const REASONS: Readonly<Record<string, string>> = {
  not_initialized: "Omnigent does not show the owner yet",
  not_replicated: "the owner exists but its record is not replicated yet",
  info_unavailable: "the watchdog could not read Omnigent's /v1/info",
  position_unavailable: "the watchdog could not read the replicated position",
  boot_changed: "the server restarted between the watchdog's reads",
};

/**
 * Whether the bootstrap may release: the newest status of this installation, in this answer
 * and no older than any seen before, says initialized (owner present and durable) for the
 * reason "durable", and it is fresh.
 */
export function decide(statuses: readonly StatusEvent[], rules: AcceptanceRules): Decision {
  const mine = statuses.filter((e) => e.status.installationId === rules.installationId);
  const others = statuses.length - mine.length;
  const answered = newest(mine);
  const seen = rules.seen?.status.installationId === rules.installationId ? rules.seen : undefined;
  if (answered === undefined && seen === undefined) {
    const why =
      others > 0
        ? "the only bootstrap statuses are another installation's"
        : "no bootstrap status yet (the server starts within a minute or two of the deploy)";
    return { accepted: false, why, latest: undefined };
  }
  if (answered === undefined || (seen !== undefined && newer(seen, answered))) {
    // Only a status seen earlier: it can hold the bootstrap back, never release it.
    const why = seen?.status.initialized
      ? "waiting for the watchdog's next status"
      : (REASONS[seen?.reason ?? ""] ?? "the owner is not initialized and durable yet");
    return { accepted: false, why, latest: seen };
  }
  const latest = answered;
  const stale = staleness(latest, rules.now, rules.freshMs, rules.skewMs);
  if (stale !== undefined) return { accepted: false, why: stale, latest };
  if (!latest.status.initialized) {
    const why = REASONS[latest.reason ?? ""] ?? "the owner is not initialized and durable yet";
    return { accepted: false, why, latest };
  }
  // The watchdog gives "durable" with every initialized status: anything else contradicts it.
  if (latest.reason !== "durable") {
    return { accepted: false, why: "the newest bootstrap status contradicts itself", latest };
  }
  return { accepted: true, event: latest };
}

export type Verification =
  | { readonly verified: true }
  | { readonly verified: false; readonly why: string };

/**
 * After the release (R-27): the OmnigentServer object runs the version the release deployed
 * (objects switch about 300 s after a version is deployed), that version has never reported
 * the bootstrap password, and nothing has reported it since the object first ran on it. While
 * the password exists the watchdog reports it on every check, so a version whose checks run
 * without reporting it does not hold it. The secret listing already shows the release; this
 * checks that the running object follows it.
 *
 * And the release is applied, not only released (G2-SEC-001): the new version adopts the
 * container that still runs with the password and `INITIALIZED=false`, until its watchdog
 * replaces it. So the check also needs a status from the released version, logged after the
 * release, from a server started with the released configuration (`configApplied`), without the
 * password, showing this installation's owner initialized and durable. Until then the release is
 * "released, not yet applied".
 */
export function verifyRelease(
  logs: ParsedLogs,
  rules: {
    readonly installationId: string;
    /** The version the release deployed, as Cloudflare listed it right after. */
    readonly releasedVersionId: string | undefined;
    /** When the release's change was confirmed, in milliseconds. */
    readonly releasedAt: number;
  },
): Verification {
  const released = rules.releasedVersionId;
  if (released === undefined) {
    return { verified: false, why: "Cloudflare did not say which version the release deployed" };
  }
  const reported = logs.statuses.filter(
    (e) => e.status.installationId === rules.installationId && e.secretPresent === true,
  );
  if (reported.some((e) => e.versionId === released)) {
    return { verified: false, why: "the released version still reports the bootstrap password" };
  }
  const runs = logs.invocations
    .filter(
      (i) =>
        i.entrypoint === STATUS_ENTRYPOINT &&
        i.eventType === "alarm" &&
        i.versionId === released &&
        i.loggedAt >= rules.releasedAt,
    )
    .map((i) => i.loggedAt);
  if (runs.length === 0) {
    return {
      verified: false,
      why: "the server's object has not run on the released version yet (it switches about 5 minutes after the release)",
    };
  }
  const firstRun = Math.min(...runs);
  if (reported.some((e) => e.loggedAt >= firstRun)) {
    return { verified: false, why: "the bootstrap password was reported after the switch" };
  }
  const applied = logs.statuses.filter(
    (e) =>
      e.status.installationId === rules.installationId &&
      e.versionId === released &&
      e.loggedAt >= rules.releasedAt &&
      e.secretPresent === false &&
      e.configApplied === true,
  );
  if (applied.length === 0) {
    return {
      verified: false,
      why: "released, not yet applied: the server still runs with its configuration from before the release (the watchdog replaces it, a restart of a few minutes)",
    };
  }
  const latest = newest(applied);
  if (latest !== undefined && !(latest.status.initialized && latest.reason === "durable")) {
    const why = REASONS[latest.reason ?? ""] ?? "the owner is not initialized and durable yet";
    return {
      verified: false,
      why: `released and applied, but the restarted server does not show a durable owner yet: ${why}`,
    };
  }
  return { verified: true };
}

export type GitHubLinkingCheck =
  /** A server started with the App's settings answers, and Omnigent lists GitHub linking. */
  | { readonly state: "on" }
  /** A server started with the App's settings answers, and Omnigent does not list it. */
  | { readonly state: "off" }
  /** The server exited with a missing or malformed setting and is held (exit 78). */
  | { readonly state: "held" }
  | { readonly state: "waiting"; readonly why: string };

/**
 * After the GitHub step's secrets change (WP3.36): whether the server runs with the App's
 * settings and Omnigent lists GitHub linking. Only lines from `versionId`, the platform Worker's
 * version that holds the App's settings, logged at or after `since` (the change) count: a status
 * from a server started with that version's configuration (`configApplied`) by a version that
 * says it holds the App (`githubApp`), or the watchdog's `config_error`, whichever is newer.
 * Anything older, from another version or another installation is never evidence either way.
 */
export function checkGitHubLinking(
  logs: ParsedLogs,
  rules: {
    readonly installationId: string;
    /** The version that holds the App's settings; undefined while Cloudflare does not say. */
    readonly versionId: string | undefined;
    readonly since: number;
  },
): GitHubLinkingCheck {
  const version = rules.versionId;
  if (version === undefined) {
    return {
      state: "waiting",
      why: "Cloudflare does not say yet which version of the platform Worker holds the App's settings",
    };
  }
  const applied = logs.statuses.filter(
    (e) =>
      e.status.installationId === rules.installationId &&
      e.versionId === version &&
      e.loggedAt >= rules.since &&
      e.configApplied === true &&
      e.githubApp === true,
  );
  const latest = newest(applied);
  const held = logs.configErrors
    .filter((e) => e.versionId === version && e.loggedAt >= rules.since)
    .reduce((at, e) => Math.max(at, e.loggedAt), Number.NEGATIVE_INFINITY);
  if (held > (latest?.loggedAt ?? Number.NEGATIVE_INFINITY)) return { state: "held" };
  if (latest !== undefined) {
    if (latest.githubLinking === true) return { state: "on" };
    if (latest.githubLinking === false) return { state: "off" };
    return {
      state: "waiting",
      why: "the restarted server answers, but its status does not say whether GitHub linking is on",
    };
  }
  const ran = logs.invocations.some(
    (i) =>
      i.entrypoint === STATUS_ENTRYPOINT && i.versionId === version && i.loggedAt >= rules.since,
  );
  return {
    state: "waiting",
    why: ran
      ? "the server is restarting with the App's settings (a few minutes)"
      : "the platform has not switched the server's object to the App's settings yet",
  };
}
