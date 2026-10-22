// Error answers the forwarding path writes itself, in the contract's `ErrorBody` shape. Pure.

import { ErrorBody, type ErrorCode } from "@cfo/contracts";

/** An `ErrorBody` answer, never cached. The message names no internal reason. */
export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  retryable: boolean,
  headers: Readonly<Record<string, string>> = {},
): Response {
  const body: ErrorBody = ErrorBody.parse({ error: { code, message, retryable } });
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** One structured log line. Callers pass paths without query strings, and never values of secrets. */
export function logEvent(
  source: string,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  console.log(JSON.stringify({ cfo: source, event, ...fields }));
}

/** An error's description for a log line: its message, cut short. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, 200);
}
