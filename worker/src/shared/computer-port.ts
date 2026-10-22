// The computer's container port: what WorkspaceDO (WP3.1) needs from its container, as an
// interface. WP3.3 implements it in `computer/container-port.ts`, the only computer module that
// touches `ctx.container` or the Sandbox SDK's `DirectoryBackup`; WP3.1 builds against it and its
// fake (`test/support/fake-computer-container.ts`). Owned by the integration lead (3.C).

import type { DirectoryBackupRecord, InstanceSize } from "@cfo/contracts";

export interface ComputerStartOptions {
  /** Always explicit: Cloudflare's default size is far too small. */
  readonly instance: InstanceSize;
  /** The supervisor's start environment: at least `COMPUTER_START_ENV`'s names. */
  readonly env: Readonly<Record<string, string>>;
}

export interface BackupOptions {
  /** The staged layer's directory inside the container. */
  readonly dir: string;
  readonly name: string;
  /** The computer's key prefix, `workspaceBackupPrefix(computerId)` (RC-25). */
  readonly prefix: string;
  /** The upload deadline; the SDK sets none (design, capture step 5). */
  readonly signal?: AbortSignal;
}

export interface RestoreOptions {
  readonly dir: string;
  readonly prefix: string;
  readonly signal?: AbortSignal;
}

/**
 * The parts of a computer's container WorkspaceDO uses. Every start, stop and backup goes
 * through here, so tests can refuse a start right after a stop, drop a connection and record
 * every stop.
 */
export interface ComputerContainerPort {
  /** Whether the container runs, as the runtime reports it now. */
  readonly running: boolean;
  /**
   * Starts the container, with internet access. Returns once the options are validated: a start
   * Cloudflare refuses right after a stop (DC-37) shows only as `running` staying false, so
   * WorkspaceDO treats a container not running `TIMING.startRefusedAfterS` after `start()` as
   * refused, never waiting on `monitor()`. Throws if a container runs.
   */
  start(options: ComputerStartOptions): void;
  /** Stops the container and resolves once the runtime confirms it stopped. */
  destroy(reason: string): Promise<void>;
  /** Sends a signal to the container's main process, the supervisor (SIGTERM is 15). */
  signal(signo: number): void;
  /**
   * HTTP to a container port, always `http://`. A dropped connection rejects with "Network
   * connection lost." (`isConnectionLostError`); the request may or may not have been delivered,
   * so only a message the computer API makes safe to repeat may be sent again.
   */
  fetch(port: number, request: Request): Promise<Response>;
  /** Registers a virtual host's intercept, before every start; never a catch-all. */
  registerIntercept(host: string, target: Fetcher): Promise<void>;
  setInactivityTimeout(ms: number): Promise<void>;
  /** Uploads a staged layer with `DirectoryBackup` (Sandbox SDK 1.0.0). */
  backup(options: BackupOptions): Promise<DirectoryBackupRecord>;
  /** Restores a layer into `options.dir`, replacing it only once the download is verified. */
  restore(record: DirectoryBackupRecord, options: RestoreOptions): Promise<void>;
  /** Deletes a layer's object; needs no running container. Deleting a gone object succeeds. */
  deleteBackup(record: DirectoryBackupRecord, options: { readonly prefix: string }): Promise<void>;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

/** The runtime's answer when a connection to the container dropped (S3's staging runs). */
export const CONNECTION_LOST_MESSAGE = "Network connection lost.";

export function isConnectionLostError(error: unknown): boolean {
  return messageOf(error).includes("network connection lost");
}

/**
 * Cloudflare's refusal of a start right after a stop (DC-37), wherever it surfaces. The server's
 * port (`server/container-port.ts`, WP2.2) has the same recognizer.
 */
export const NO_INSTANCE_MESSAGE =
  "There is no container instance that can be provided to this Durable Object, try again later";

export function isStartRefusedError(error: unknown): boolean {
  return messageOf(error).includes(
    "there is no container instance that can be provided to this durable object",
  );
}
