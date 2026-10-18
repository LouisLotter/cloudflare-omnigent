import { ErrorCode } from "@cfo/contracts";

// Error classes and prototypes do not survive Durable Object RPC; only the message does.
// So the code travels inside the message as a "[code] " prefix and is recognized on the other side.

const PREFIX = /^\[([a-z_]+)\] /;

export function platformError(code: ErrorCode, message: string): Error {
  const error = new Error(`[${code}] ${message}`);
  error.name = "PlatformError";
  return error;
}

/** The platform error code carried by `error`, or undefined for any other error. */
export function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = PREFIX.exec(error.message);
  if (!match) return undefined;
  const parsed = ErrorCode.safeParse(match[1]);
  return parsed.success ? parsed.data : undefined;
}
