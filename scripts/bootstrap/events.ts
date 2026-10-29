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
// The same line says which GitHub App the logging version holds (`githubApp`, a tag of its client
// ID) and whether Omnigent lists GitHub linking (`githubLinking`, WP3.36): the installer's GitHub
// step waits for its own App's tag from a server started with that configuration
// (`checkGitHubLinking`). The watchdog's `config_error` line says a server exited with a missing
// or malformed setting (78), whether that holds the current configuration (`held`) and the App
// that configuration holds.
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
  /**
   * The GitHub App the logging version holds (WP3.36): a tag of its client ID
   * (worker/src/server/github-linking.ts, `githubAppTag`), null for none; undefined: unsaid.
   */
  readonly githubApp?: string | null | undefined;
}

/** The watchdog's `config_error` line: a server exited with a missing or malformed setting. */
export interface ConfigErrorEvent {
  readonly loggedAt: number;
  readonly versionId: string | undefined;
  /** The current configuration is the one held (Codex WP3.36 r1-2); undefined: unsaid. */
  readonly held: boolean | undefined;
  /** The GitHub App the current configuration holds, as on a status line. */
  readonly githubApp: string | null | undefined;
}

function appTag(value: unknown): string | null | undefined {
  return typeof value === "string" || value === null ? value : undefined;
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
  /** When the watchdog said it replaces the server for a changed configuration (WP3.36). */
  readonly configChanges: readonly number[];
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
  const configChanges: number[] = [];
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
      line.event === "config_changed" &&
      workers.entrypoint === STATUS_ENTRYPOINT
    ) {
      configChanges.push(loggedAt);
      continue;
    }
    if (
      line?.cfo === "watchdog" &&
      line.event === "config_error" &&
      workers.entrypoint === STATUS_ENTRYPOINT
    ) {
      configErrors.push({
        loggedAt,
        versionId,
        held: typeof line.held === "boolean" ? line.held : undefined,
        githubApp: appTag(line.githubApp),
      });
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
      githubApp: appTag(line.githubApp),
    });
  }
  return { statuses, invocations, configErrors, configChanges, malformed };
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
 * settings and Omnigent lists GitHub linking. The newest word of the object about this
 * installation since the change (`since`) decides, and only when it is about the App the step
 * stored, by its tag (`appTag`), never by what Cloudflare says of versions (Codex r1-1):
 *   - a status from a server started with its logging version's configuration (`configApplied`)
 *     whose version holds this App: "on" or "off" by Omnigent's own list;
 *   - the watchdog's `config_error` saying it holds the current configuration (`held`), whose App
 *     is this one: "held" (Codex r1-2; an older container's exit is no word at all);
 *   - anything newer than those, which says the server is changing or runs something else (a
 *     replacement begun, `config_changed`; a status not yet applied; a status or a hold of
 *     another App, or of none, after a rollback or a later change): not decided, so that a later
 *     word always overrides an earlier verdict, whatever order the lines arrive in (Codex r2-1).
 * Nothing from before the change, or of another installation, counts.
 */
export function checkGitHubLinking(
  logs: ParsedLogs,
  rules: {
    readonly installationId: string;
    /** The tag of the App the step stored (`githubAppTag` of its client ID). */
    readonly appTag: string;
    readonly since: number;
  },
): GitHubLinkingCheck {
  type Word =
    | { readonly at: number; readonly kind: "status"; readonly event: StatusEvent }
    | { readonly at: number; readonly kind: "held"; readonly ours: boolean }
    | { readonly at: number; readonly kind: "changed" };
  const words: Word[] = [
    ...logs.statuses
      .filter((e) => e.status.installationId === rules.installationId && e.loggedAt >= rules.since)
      .map((event): Word => ({ at: event.loggedAt, kind: "status", event })),
    ...logs.configErrors
      .filter((e) => e.held === true && e.loggedAt >= rules.since)
      .map((e): Word => ({ at: e.loggedAt, kind: "held", ours: e.githubApp === rules.appTag })),
    ...logs.configChanges
      .filter((at) => at >= rules.since)
      .map((at): Word => ({ at, kind: "changed" })),
  ];
  // The newest; among words of the same moment, a change or a hold before a status, so that a
  // tie never decides in favour of a verdict.
  const rank = { changed: 0, held: 1, status: 2 } as const;
  const latest = words.reduce<Word | undefined>(
    (a, b) =>
      a === undefined || b.at > a.at || (b.at === a.at && rank[b.kind] < rank[a.kind]) ? b : a,
    undefined,
  );
  const restarting = "the server is restarting with the App's settings (a few minutes)";
  if (latest === undefined) {
    return {
      state: "waiting",
      why: "the platform has not switched the server's object to the App's settings yet",
    };
  }
  if (latest.kind === "changed") return { state: "waiting", why: restarting };
  if (latest.kind === "held") {
    return latest.ours
      ? { state: "held" }
      : {
          state: "waiting",
          why: "the server holds a configuration without this App (a later change?)",
        };
  }
  const status = latest.event;
  if (status.githubApp !== rules.appTag) {
    return status.githubApp === undefined || status.configApplied !== true
      ? { state: "waiting", why: restarting }
      : {
          state: "waiting",
          why: "the server still runs a configuration without this App (the platform has not switched to the App's settings yet, or a later change replaced them)",
        };
  }
  if (status.configApplied !== true) return { state: "waiting", why: restarting };
  if (status.githubLinking === true) return { state: "on" };
  if (status.githubLinking === false) return { state: "off" };
  return {
    state: "waiting",
    why: "the restarted server answers, but its status does not say whether GitHub linking is on",
  };
}
