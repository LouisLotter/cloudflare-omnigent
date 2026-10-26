// The computer API (3.C, `computer-protocol.ts`): the two directions between a computer's
// supervisor (WP3.4) and its WorkspaceDO (WP3.1). Pure: no Workers runtime import; the inbound
// entrypoint is `ComputerApi` in `internal/entrypoints.ts`.
//
//   - Inbound, `POST http://computer.internal/v1/messages`: a `SupervisorMessage`, with the
//     intercept's trusted props naming the computer and generation. Checked before any effect:
//     props, size, JSON, schema (with its refinements), the message's computer and generation
//     against the props (`stale_generation`), the protocol version; then WorkspaceDO's
//     `computer` method.
//   - Outbound, `POST http://<container>:8090/v1/commands`: a `WorkspaceCommand` sent by
//     `sendCommand`, over the computer's container port.
//
// Lost connections (S3's staging runs: "Network connection lost." three times in about five
// minutes of busy calls). Every message type has an idempotency rule (COMPUTER_API_MESSAGES), so
// both directions repeat a request that got no answer, unchanged and with the same operation ID,
// within a deadline; then they report the outcome as unknown, never as a failure or a success.
// A message type without a repeat rule would be sent once and reported unknown on any loss.

import {
  COMPUTER_API_MESSAGES,
  type ComputerCall,
  ErrorBody,
  type ErrorCode,
  InterceptProps,
  LAUNCHER_ERROR_STATUS,
  MAX_COMPUTER_API_BODY_BYTES,
  SUPERVISOR_API_PORT,
  SUPERVISOR_COMMANDS_PATH,
  SUPPORTED_INTERCEPT_PROPS_VERSIONS,
  SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS,
  SupervisorMessage,
  SupervisorReply,
  WORKSPACE_INTERFACE_VERSION,
  WorkspaceCommand,
  WorkspaceCommandReply,
} from "@cfo/contracts";
import type { LimitOptions, RateLimiter } from "../ingress/limits.ts";
import { errorResponse } from "../server/responses.ts";
import { isConnectionLostError, isStartRefusedError } from "../shared/computer-port.ts";
import { errorCodeOf } from "../shared/errors.ts";

export const COMPUTER_MESSAGES_PATH = "/v1/messages";

/** Messages per computer: reports every few seconds, credential checkpoints on change. */
export const COMPUTER_API_LIMITS: LimitOptions = { burst: 120, perSecond: 10, maxClients: 1_024 };

type Idempotency =
  (typeof COMPUTER_API_MESSAGES)[keyof typeof COMPUTER_API_MESSAGES]["idempotency"];

/** Whether a message of this type may be sent again after a lost answer. */
export function repeatable(type: string): boolean {
  const rule = (COMPUTER_API_MESSAGES as Readonly<Record<string, { idempotency: Idempotency }>>)[
    type
  ];
  return rule !== undefined;
}

// ---------------------------------------------------------------------------------------------
// Retries

export interface RetryPolicy {
  /** The pauses between attempts; the number of attempts is one more. */
  readonly backoffMs: readonly number[];
  /** No new attempt starts after this many milliseconds. */
  readonly deadlineMs: number;
}

/** Inbound: WorkspaceDO's RPC failing without an answer (a reset, a version switch). */
export const INBOUND_RETRY: RetryPolicy = { backoffMs: [100, 400, 1_000], deadlineMs: 5_000 };
/** Outbound: S3's drops came singly, so a few quick repeats cover them. */
export const OUTBOUND_RETRY: RetryPolicy = {
  backoffMs: [250, 1_000, 2_000, 4_000],
  deadlineMs: 15_000,
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Inbound: supervisor → WorkspaceDO

export interface ComputerApiDeps {
  /** WorkspaceDO's `computer` method for this computer. */
  computer(computerId: string, call: ComputerCall): Promise<SupervisorReply>;
  readonly limiter: RateLimiter;
  readonly retry: RetryPolicy;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  log(event: string, fields: Readonly<Record<string, unknown>>): void;
}

function apiError(code: ErrorCode, message: string, retryable: boolean): Response {
  return errorResponse(LAUNCHER_ERROR_STATUS[code], code, message, retryable);
}

/** An answer from WorkspaceDO's RPC that is a refusal, not a lost call. */
function isRefusal(error: unknown): ErrorCode | undefined {
  return errorCodeOf(error);
}

/** Handles one message from a computer's supervisor. Never throws. */
export async function handleSupervisorMessage(
  request: Request,
  rawProps: unknown,
  deps: ComputerApiDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const log = (status: number, fields: Record<string, unknown>) =>
    deps.log("message", {
      method: request.method,
      path: url.pathname.slice(0, 64),
      status,
      ...fields,
    });

  const props = InterceptProps.safeParse(rawProps);
  if (
    !props.success ||
    !(SUPPORTED_INTERCEPT_PROPS_VERSIONS as readonly number[]).includes(props.data.propsVersion)
  ) {
    log(503, { refused: "props" });
    return apiError("unavailable", "This route is not available.", true);
  }
  const { computerId, generation } = props.data;
  const who = { computerId, generation };
  if (url.pathname !== COMPUTER_MESSAGES_PATH) {
    log(404, { ...who, refused: "path" });
    return apiError("not_found", "Not found.", false);
  }
  if (request.method !== "POST") {
    log(400, { ...who, refused: "method" });
    return apiError("bad_request", "Use POST.", false);
  }
  const limit = deps.limiter.take(computerId);
  if (!limit.allowed) {
    log(429, { ...who, refused: "rate_limit" });
    return errorResponse(429, "unavailable", "Too many messages.", true, {
      "retry-after": String(limit.retryAfterSeconds),
    });
  }
  const text = await readText(request, MAX_COMPUTER_API_BODY_BYTES);
  if (text === null) {
    log(400, { ...who, refused: "too_large_or_not_utf8" });
    return apiError("bad_request", "The message is too large or not UTF-8.", false);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    log(400, { ...who, refused: "not_json" });
    return apiError("bad_request", "Not JSON.", false);
  }
  const parsed = SupervisorMessage.safeParse(json);
  if (!parsed.success) {
    log(400, { ...who, refused: "schema" });
    return apiError("bad_request", "Not a supervisor message.", false);
  }
  const message = parsed.data;
  const typed = { ...who, type: message.type };
  if (message.computerId !== computerId || message.generation !== generation) {
    log(409, { ...typed, refused: "stale_generation" });
    return apiError("stale_generation", "Another computer or an older generation.", false);
  }
  if (
    !(SUPPORTED_SUPERVISOR_PROTOCOL_VERSIONS as readonly number[]).includes(message.protocolVersion)
  ) {
    log(400, { ...typed, refused: "version" });
    return apiError("unsupported_version", "This protocol version is not supported.", false);
  }

  const call: ComputerCall = {
    interfaceVersion: WORKSPACE_INTERFACE_VERSION,
    props: props.data,
    message,
  };
  const wait = deps.sleep ?? sleep;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const attempts = repeatable(message.type) ? deps.retry.backoffMs.length + 1 : 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const reply = SupervisorReply.parse(await deps.computer(computerId, call));
      if (reply.type !== message.type) throw new Error("reply for another message type");
      log(200, { ...typed, attempt });
      return Response.json(reply);
    } catch (error) {
      const code = isRefusal(error);
      if (code !== undefined) {
        const retryable = code === "unavailable";
        log(LAUNCHER_ERROR_STATUS[code], { ...typed, attempt, refused: code });
        return apiError(code, `Refused: ${code}.`, retryable);
      }
      const pause = deps.retry.backoffMs[attempt - 1];
      if (
        attempt >= attempts ||
        pause === undefined ||
        clock() - started + pause > deps.retry.deadlineMs
      ) {
        // Unanswered: the supervisor repeats the same message, which every rule makes safe.
        log(503, { ...typed, attempt, refused: "no_answer" });
        return apiError("unavailable", "The computer's controller did not answer.", true);
      }
      await wait(pause);
    }
  }
}

/** The body as UTF-8 text, or null when it is larger than `limit` bytes or not UTF-8. */
async function readText(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return null;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Outbound: WorkspaceDO → supervisor

/** The part of the computer's container port the client uses. */
export interface CommandPort {
  fetch(port: number, request: Request): Promise<Response>;
}

export type CommandOutcome =
  | { readonly kind: "reply"; readonly reply: WorkspaceCommandReply; readonly attempts: number }
  | {
      readonly kind: "refused";
      readonly code: ErrorCode;
      readonly retryable: boolean;
      readonly attempts: number;
    }
  /**
   * No answer, and at least one attempt may have reached the supervisor (a lost connection, a
   * timeout). The command may or may not have taken effect: the caller keeps it pending and
   * repeats it unchanged later (the same operation ID), or reconciles with `status` or
   * `job_status`.
   */
  | { readonly kind: "unknown"; readonly reason: string; readonly attempts: number }
  /** No attempt reached the supervisor: the container was not running or not listening. */
  | { readonly kind: "undelivered"; readonly reason: string; readonly attempts: number };

export interface CommandOptions {
  readonly retry?: RetryPolicy;
  /** One attempt's timeout. */
  readonly attemptTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

interface FailedAttempt {
  readonly reason: string;
  /** Whether the request may have reached the supervisor. */
  readonly maybeDelivered: boolean;
  /** Whether another attempt can help. */
  readonly retry: boolean;
}

/** What a thrown container-port call says about delivery. */
export function classifyFailure(error: unknown): FailedAttempt {
  if (isConnectionLostError(error)) {
    return { reason: "connection_lost", maybeDelivered: true, retry: true };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { reason: "timeout", maybeDelivered: true, retry: true };
  }
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes("not listening")) {
    // Refused before any byte was sent: the supervisor is not up yet (WP2.2, isNotListeningError).
    return { reason: "not_listening", maybeDelivered: false, retry: true };
  }
  if (message.includes("not running") || isStartRefusedError(error)) {
    return { reason: "not_running", maybeDelivered: false, retry: false };
  }
  return { reason: "transport_error", maybeDelivered: true, retry: false };
}

/**
 * Sends one command to the computer's supervisor. The command is checked against the contract
 * first and never sent malformed. A lost connection, a timeout or a not-yet-listening supervisor
 * is repeated with the same bytes while the command type allows it and the deadline lasts; a
 * `retryable` refusal (`unavailable`) too. Any other answer ends it. The reply must parse and
 * answer this command's type.
 */
export async function sendCommand(
  port: CommandPort,
  command: WorkspaceCommand,
  options: CommandOptions = {},
): Promise<CommandOutcome> {
  const parsed = WorkspaceCommand.parse(command);
  const body = JSON.stringify(parsed);
  const retry = options.retry ?? OUTBOUND_RETRY;
  const wait = options.sleep ?? sleep;
  const clock = options.clock ?? Date.now;
  const timeoutMs = options.attemptTimeoutMs ?? 30_000;
  const attempts = repeatable(parsed.type) ? retry.backoffMs.length + 1 : 1;
  const started = clock();
  let reason = "no_attempt";
  let maybeDelivered = false;
  const giveUp = (attempt: number): CommandOutcome =>
    maybeDelivered
      ? { kind: "unknown", reason, attempts: attempt }
      : { kind: "undelivered", reason, attempts: attempt };
  for (let attempt = 1; ; attempt += 1) {
    let response: Response | null = null;
    try {
      response = await port.fetch(
        SUPERVISOR_API_PORT,
        new Request(`http://computer${SUPERVISOR_COMMANDS_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        }),
      );
    } catch (error) {
      const failed = classifyFailure(error);
      reason = failed.reason;
      maybeDelivered ||= failed.maybeDelivered;
      if (!failed.retry) return giveUp(attempt);
    }
    if (response !== null) {
      const outcome = await readCommandResponse(response, parsed.type, attempt);
      if (outcome.kind === "refused" && !outcome.retryable && maybeDelivered) {
        // An earlier attempt may have taken effect before its answer was lost; a refusal of this
        // later one (a generation that changed meanwhile, say) does not settle that (r1-4).
        return {
          kind: "unknown",
          reason: `refused_${outcome.code}_after_lost_answer`,
          attempts: attempt,
        };
      }
      if (outcome.kind !== "refused" || !outcome.retryable) return outcome;
      // The supervisor answered: it saw this attempt.
      maybeDelivered = true;
      reason = `refused_${outcome.code}`;
    }
    const pause = retry.backoffMs[attempt - 1];
    if (
      attempt >= attempts ||
      pause === undefined ||
      clock() - started + pause > retry.deadlineMs
    ) {
      return giveUp(attempt);
    }
    await wait(pause);
  }
}

async function readCommandResponse(
  response: Response,
  type: WorkspaceCommand["type"],
  attempts: number,
): Promise<CommandOutcome> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return { kind: "unknown", reason: "unreadable_reply", attempts };
  }
  if (response.ok) {
    const reply = WorkspaceCommandReply.safeParse(json);
    if (!reply.success || reply.data.type !== type) {
      return { kind: "unknown", reason: "malformed_reply", attempts };
    }
    return { kind: "reply", reply: reply.data, attempts };
  }
  const error = ErrorBody.safeParse(json);
  if (!error.success) return { kind: "unknown", reason: `status_${response.status}`, attempts };
  return {
    kind: "refused",
    code: error.data.error.code,
    retryable: error.data.error.retryable,
    attempts,
  };
}
