import { z } from "zod";
import { InstallationId, Timestamp } from "./ids.ts";

/** Versions of the bootstrap status this contract package understands. */
export const SUPPORTED_BOOTSTRAP_STATUS_VERSIONS = [1] as const;

/**
 * The server container's answer to "is this installation's account store initialized?" (WP2.4).
 * It is read from Omnigent's durable state when asked, never from an earlier step or a log line.
 * The bootstrap step deletes the bootstrap password secret only once `initialized` is true for
 * its own installation, and repeating the deletion is harmless. Experiment X0 confirms which
 * durable state is the signal (gate G1b); this shape does not depend on the answer.
 */
export const BootstrapStatus = z.strictObject({
  protocolVersion: z.number().int().min(1),
  installationId: InstallationId,
  initialized: z.boolean(),
  checkedAt: Timestamp,
});
export type BootstrapStatus = z.infer<typeof BootstrapStatus>;
