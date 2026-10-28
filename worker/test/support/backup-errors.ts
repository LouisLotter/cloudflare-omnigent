/**
 * Upload failures shaped as the Sandbox SDK 1.0.0 raises them (`SandboxBackupError`: an `Error`
 * named so, with own `code`, `operation`, `path` and `detail`, and the message
 * `${operation} '${path}': ${detail}`), for the upload retry's tests (WP3.22). The Workers-runtime
 * test checks the SDK's own `SandboxBackupError.is` accepts them.
 */
export function sdkBackupError(
  code: string,
  detail: string,
  path = "/var/cfo/staged/lyr_x",
): Error {
  const error = new Error(`backup '${path}': ${detail}`);
  error.name = "SandboxBackupError";
  return Object.assign(error, { code, operation: "backup", path, detail });
}

/** The 27 Oct 2026 sitting's failure: the gateway's 502 for R2's lost connection. */
export const SITTING_PART_FAILURE = (): Error =>
  sdkBackupError(
    "BACKUP_TRANSFER",
    "gateway rejected the part upload with HTTP 502: Network connection lost.",
  );
