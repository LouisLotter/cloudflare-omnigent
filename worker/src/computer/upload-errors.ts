// Which upload failures WorkspaceDO repeats (WP3.22). Imports nothing, so the image's container
// suite runs this same function against the real sandbox-shim's errors
// (images/computer/integration/directory-backup).

/**
 * Whether a backup failed in a way worth repeating the whole upload for. Sandbox SDK 1.0.0
 * retries nothing: its shim uploads each part once, and the SDK's gateway answers 502 with R2's
 * message when a part's put fails, so one lost connection fails the layer (the 27 Oct 2026
 * sitting: "gateway rejected the part upload with HTTP 502: Network connection lost.").
 *
 * Only the SDK's `SandboxBackupError` `BACKUP_TRANSFER` is repeated, and only when the gateway
 * answered 502, 503 or 504 (504 is also the platform gateway's own part timeout,
 * `egress/backups.ts`) or the connection was lost, reset, refused or closed. The real shim says
 * "gateway rejected the part upload with HTTP 502: Network connection lost." when R2 fails after
 * the part's bytes arrived, and "gateway connection failed: Broken pipe (os error 32)" when the
 * gateway answers before reading them (images/computer/integration/directory-backup). The SDK raises
 * `BACKUP_TRANSFER` only from the shim's exchange, before `completeUpload`, and aborts that
 * attempt's multipart upload, so a repeated attempt never leaves an object behind. Never
 * repeated:
 *   - any other error, a bare "Network connection lost." included: `completeUpload` raises those
 *     too, possibly after R2 created the object, and a new attempt would write a second one
 *     (Codex WP3.22 r1, finding 3);
 *   - the write fence's refusal (403) or any other answer;
 *   - `BACKUP_INTEGRITY` (R2 stored a different size), a file error in the staged directory, an
 *     abort or timeout (the deadline), a stopped container.
 */
export function isTransientUploadError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "SandboxBackupError") return false;
  if ((error as { readonly code?: unknown }).code !== "BACKUP_TRANSFER") return false;
  const message = error.message.toLowerCase();
  return (
    /\bhttp (?:502|503|504)\b/.test(message) ||
    /network connection lost|connection (?:reset|refused|closed)|econnreset|broken pipe/.test(
      message,
    )
  );
}
