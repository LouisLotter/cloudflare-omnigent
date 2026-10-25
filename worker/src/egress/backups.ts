// The Sandbox SDK's backup gateway (`@cloudflare/sandbox` 1.0.0), and the `DirectoryBackup`
// factory the computer's container port uses (`computer/container-port.ts`).
//
// `DirectoryBackupGateway` is re-exported from the platform Worker's main module, so
// `ctx.exports.DirectoryBackupGateway` exists. `DirectoryBackup` registers it as the container's
// `backups.sandbox.internal` intercept itself, with props that grant one operation on one object
// under the computer's own key prefix, and deny everything once the operation ends: a computer
// can never name another computer's objects (RC-25). No platform code registers that host.

import { DirectoryBackup, DirectoryBackupGateway } from "@cloudflare/sandbox";
import type { DirectoryBackups, DirectoryBackupsFor } from "../computer/container-port.ts";

export { DirectoryBackupGateway };

/** The R2 binding of the computers' checkpoint bucket (code-structure plan, Wrangler). */
export const CHECKPOINTS_BINDING = "CHECKPOINTS";

/** `DirectoryBackup` for one computer's container, by key prefix. */
export function directoryBackups(
  container: Container,
  exports: { readonly DirectoryBackupGateway: ConstructorParameters<typeof DirectoryBackup>[1] },
  binding: string = CHECKPOINTS_BINDING,
): DirectoryBackupsFor {
  return (prefix: string): DirectoryBackups =>
    new DirectoryBackup(container, exports.DirectoryBackupGateway, { binding, prefix });
}
