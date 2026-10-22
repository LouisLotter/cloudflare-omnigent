// Reading the watchdog's bootstrap events from Workers Logs (WP2.4). Pure: no I/O, so the
// Workers-runtime tests can feed it what the real OmnigentServer logs.
//
// While the bootstrap password exists, OmnigentServer's watchdog (WP2.2) logs one structured
// line on every check, about once a minute:
//
//   {"cfo":"bootstrap","event":"status","reason":"durable",
//    "bootstrapStatus":{"protocolVersion":1,"installationId":"ins_…","initialized":true,
//                       "checkedAt":"…"},"secretPresent":true}
//
// `initialized` is true only when Omnigent's `/v1/info` shows `accounts_enabled: true` and
// `needs_setup: false` and the replicated position covers the owner's commit (X0, G1BR-002).
// The log is a notice, never the only record: the status itself is stored in the object, and a
// lost line recurs a minute later.
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
}

/** Any invocation of the platform Worker, for the check after the release. */
export interface Invocation {
  readonly loggedAt: number;
  readonly versionId: string | undefined;
  readonly eventType: string | undefined;
}

export interface ParsedLogs {
  readonly statuses: readonly StatusEvent[];
  readonly invocations: readonly Invocation[];
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
    invocations.push({ loggedAt, versionId, eventType });
    const line = logLine(event.source);
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
    });
  }
  return { statuses, invocations, malformed };
}

export interface AcceptanceRules {
  readonly installationId: string;
  /** The laptop's clock, in milliseconds. */
  readonly now: number;
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

const FRESH_MS = 10 * 60_000;
const SKEW_MS = 5 * 60_000;

function time(status: BootstrapStatus): number {
  return Date.parse(status.checkedAt);
}

const REASONS: Readonly<Record<string, string>> = {
  not_initialized: "Omnigent does not show the owner yet",
  not_replicated: "the owner exists but its record is not replicated yet",
  info_unavailable: "the watchdog could not read Omnigent's /v1/info",
  position_unavailable: "the watchdog could not read the replicated position",
  boot_changed: "the server restarted between the watchdog's reads",
};

/**
 * Whether the bootstrap may release: the newest status of this installation says initialized
 * (owner present and durable), it is fresh, and nothing contradicts it.
 */
export function decide(statuses: readonly StatusEvent[], rules: AcceptanceRules): Decision {
  const mine = statuses.filter((e) => e.status.installationId === rules.installationId);
  const others = statuses.length - mine.length;
  if (mine.length === 0) {
    const why =
      others > 0
        ? "the only bootstrap statuses are another installation's"
        : "no bootstrap status yet (the server starts within a minute or two of the deploy)";
    return { accepted: false, why, latest: undefined };
  }
  // Newest by the watchdog's own clock, then by Workers Logs' time.
  const latest = mine.reduce((a, b) =>
    time(b.status) > time(a.status) ||
    (time(b.status) === time(a.status) && b.loggedAt > a.loggedAt)
      ? b
      : a,
  );
  const age = rules.now - time(latest.status);
  if (age > (rules.freshMs ?? FRESH_MS)) {
    return { accepted: false, why: "the newest bootstrap status is too old", latest };
  }
  if (-age > (rules.skewMs ?? SKEW_MS)) {
    return {
      accepted: false,
      why: "the newest bootstrap status is from the future: check this laptop's clock",
      latest,
    };
  }
  if (!latest.status.initialized) {
    const why = REASONS[latest.reason ?? ""] ?? "the owner is not initialized and durable yet";
    return { accepted: false, why, latest };
  }
  // A line that says initialized but gives another reason contradicts itself: not accepted.
  if (latest.reason !== undefined && latest.reason !== "durable") {
    return { accepted: false, why: "the newest bootstrap status contradicts itself", latest };
  }
  return { accepted: true, event: latest };
}

export type Verification =
  | { readonly verified: true }
  | { readonly verified: false; readonly why: string };

/**
 * After the release (R-27): the platform Worker's objects run a version that never reported
 * the bootstrap password (they switch about 300 s after a version is deployed), and nothing has
 * reported it since. Versions that reported it are known from their own status lines, and the
 * accepted status's version is one of them. The secret listing already shows the release; this
 * checks that the running objects follow it.
 */
export function verifyRelease(
  logs: ParsedLogs,
  rules: {
    readonly installationId: string;
    /** The version that logged the accepted status. */
    readonly acceptedVersionId: string | undefined;
    /** When the release's change was confirmed, in milliseconds. */
    readonly releasedAt: number;
  },
): Verification {
  if (rules.acceptedVersionId === undefined) {
    return { verified: false, why: "Workers Logs did not say which version logged the status" };
  }
  const reported = logs.statuses.filter(
    (e) => e.status.installationId === rules.installationId && e.secretPresent === true,
  );
  const withPassword = new Set<string | undefined>([rules.acceptedVersionId]);
  for (const e of reported) withPassword.add(e.versionId);
  const lastReported = Math.max(Number.NEGATIVE_INFINITY, ...reported.map((e) => e.loggedAt));
  const clean = logs.invocations.some(
    (i) =>
      i.eventType === "alarm" &&
      i.loggedAt >= rules.releasedAt &&
      i.loggedAt > lastReported &&
      i.versionId !== undefined &&
      !withPassword.has(i.versionId),
  );
  if (clean) return { verified: true };
  return {
    verified: false,
    why:
      lastReported >= rules.releasedAt
        ? "the server's object still runs a version with the bootstrap password (it switches about 5 minutes after the release)"
        : "the server's object has not run on the new version yet (it switches about 5 minutes after the release)",
  };
}
