// The computer's container port (3.C's `ComputerContainerPort`): the only computer module that
// touches `ctx.container`, and the Sandbox SDK's `DirectoryBackup` through a factory that
// `egress/backups.ts` supplies. Pure in the module-rule sense: it imports nothing from
// `cloudflare:workers` or the SDK at run time, so its tests run in Node against a recording
// stand-in for the runtime's container.
//
//   - Every start is explicit about its size (Cloudflare's default is far too small), has
//     internet access (design, "Network"), and names the image when the class has a map of
//     images (the `durable_object` policy). `start()` returns once Cloudflare has validated its
//     options; a start refused right after a stop (DC-37) shows only afterwards, so
//     `observeStart` reads the outcome from `running` and a port probe, without `monitor()`
//     (3.C's open question 3: the design's rule, measured on staging by WP3.3).
//   - Containers are reached over `http://` only: an `https://` URL throws on Cloudflare.
//   - `destroy()` resolves once the runtime reports the container stopped, or rejects.
//   - No intercept for a catch-all, `platform.internal` or the SDK's backup host
//     (`computer/network.ts`).

import type { DirectoryBackupRecord, InstanceSize } from "@cfo/contracts";
import {
  type BackupOptions,
  type ComputerContainerPort,
  type ComputerStartOptions,
  isStartRefusedError,
  type RestoreOptions,
} from "../shared/computer-port.ts";
import { interceptHostAllowed } from "./network.ts";

/** The image key under `containers[].images` in the platform Worker's configuration. */
export const COMPUTER_IMAGE_KEY = "computer";

/** One computer's `DirectoryBackup`, for one key prefix (Sandbox SDK 1.0.0). */
export interface DirectoryBackups {
  backup(options: {
    dir: string;
    name?: string;
    signal?: AbortSignal;
  }): Promise<DirectoryBackupRecord>;
  restore(
    record: DirectoryBackupRecord,
    options?: { dir?: string; signal?: AbortSignal },
  ): Promise<void>;
  delete(record: DirectoryBackupRecord, options?: { signal?: AbortSignal }): Promise<void>;
}

/**
 * Makes the `DirectoryBackup` for a key prefix (`egress/backups.ts`): for an upload, fenced to the
 * generation whose capture it is; for a restore or a delete (`null`), with no fence, so nothing
 * can be written through it.
 */
export type DirectoryBackupsFor = (prefix: string, generation: number | null) => DirectoryBackups;

/** The runtime's container, as far as this adapter uses it. */
export type RuntimeContainer = Pick<
  Container,
  | "running"
  | "images"
  | "start"
  | "destroy"
  | "signal"
  | "getTcpPort"
  | "interceptOutboundHttp"
  | "setInactivityTimeout"
>;

export interface ComputerPortOptions {
  readonly backups: DirectoryBackupsFor;
  /** How long `destroy()` waits for `running` to turn false after the runtime's stop. */
  readonly stopConfirmMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The start options the runtime gets: an explicit size, internet on, the image if mapped. */
export function runtimeStartOptions(
  options: ComputerStartOptions,
  images: Readonly<Record<string, string>>,
): ContainerStartupOptions {
  const image = images[COMPUTER_IMAGE_KEY];
  const start = {
    enableInternet: true,
    env: { ...options.env },
    instance: options.instance as Exclude<InstanceSize, "basic">,
  };
  return (image === undefined ? start : { ...start, image }) as ContainerStartupOptions;
}

/**
 * This Durable Object's container: the runtime's `ctx.container`, or null when its class has no
 * container configured (a deployment without the computer image).
 */
export function computerContainerOf(ctx: { readonly container?: Container }): Container | null {
  return ctx.container ?? null;
}

export function nativeComputerContainer(
  container: RuntimeContainer,
  options: ComputerPortOptions,
): ComputerContainerPort {
  const wait = options.sleep ?? sleep;
  const confirmMs = options.stopConfirmMs ?? 5_000;
  return {
    get running() {
      return container.running;
    },
    start(startOptions) {
      if (container.running) throw new Error("start() called while the container is running");
      container.start(runtimeStartOptions(startOptions, imagesOf(container)));
    },
    async destroy(reason) {
      await container.destroy(reason);
      for (let waited = 0; container.running; waited += 100) {
        if (waited >= confirmMs) throw new Error("the container did not stop");
        await wait(100);
      }
    },
    signal(signo) {
      container.signal(signo);
    },
    fetch(port, request) {
      if (!request.url.startsWith("http://")) {
        return Promise.reject(new Error("only http:// reaches a container port"));
      }
      return container.getTcpPort(port).fetch(request);
    },
    async registerIntercept(host, target) {
      if (!interceptHostAllowed(host)) throw new Error(`refusing to intercept ${host}`);
      await container.interceptOutboundHttp(host, target);
    },
    setInactivityTimeout(ms) {
      return container.setInactivityTimeout(ms);
    },
    backup(backup: BackupOptions) {
      return options.backups(backup.prefix, backup.generation).backup({
        dir: backup.dir,
        name: backup.name,
        ...(backup.signal ? { signal: backup.signal } : {}),
      });
    },
    restore(record, restore: RestoreOptions) {
      return options.backups(restore.prefix, null).restore(record, {
        dir: restore.dir,
        ...(restore.signal ? { signal: restore.signal } : {}),
      });
    },
    deleteBackup(record, { prefix }) {
      return options.backups(prefix, null).delete(record);
    },
  };
}

/**
 * Whether an upload failed in a way worth repeating the whole upload for (WP3.22). Sandbox SDK
 * 1.0.0 retries nothing: its shim uploads each part once, and the gateway answers 502 with R2's
 * message when a part's put fails, so one lost connection fails the layer (the 27 Oct 2026 sitting:
 * "gateway rejected the part upload with HTTP 502: Network connection lost."). Transient:
 *   - the SDK's `SandboxBackupError` `BACKUP_TRANSFER` with a gateway answer of 502, 503 or 504
 *     (504 is also the platform gateway's own part timeout, `egress/backups.ts`), or a lost,
 *     reset or refused connection;
 *   - "Network connection lost." between WorkspaceDO and the container (S3).
 * Never: the write fence's refusal (403) or any other answer, `BACKUP_INTEGRITY` (R2 stored a
 * different size), a file error in the staged directory, an abort or timeout (the deadline), or a
 * stopped container. A failed attempt leaves no object: the SDK aborts its multipart upload, and
 * only `completeUpload`, which these failures precede, makes the object exist.
 */
export function isTransientUploadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  const message = error.message.toLowerCase();
  if (error.name === "SandboxBackupError") {
    if ((error as { readonly code?: unknown }).code !== "BACKUP_TRANSFER") return false;
    return (
      /\bhttp (?:502|503|504)\b/.test(message) ||
      /network connection lost|connection (?:reset|refused|closed)|econnreset|broken pipe/.test(
        message,
      )
    );
  }
  return message.includes("network connection lost");
}

function imagesOf(container: RuntimeContainer): Readonly<Record<string, string>> {
  try {
    return container.images ?? {};
  } catch {
    // A class under the default policy has no images map.
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// Observing a start without `monitor()`

export type StartOutcome =
  | { readonly kind: "ready"; readonly afterMs: number }
  /** Cloudflare refused the start (DC-37): retry it under the same generation. */
  | { readonly kind: "refused"; readonly afterMs: number }
  /** Not running, or not answering, by the deadline: treated as refused, never as stopped. */
  | { readonly kind: "not_running"; readonly afterMs: number };

export interface ObserveOptions {
  /** The design's 10 s: a container not answering by then counts as refused. */
  readonly deadlineMs?: number;
  readonly pollMs?: number;
  /** One probe's own bound, within what is left of the deadline. */
  readonly probeTimeoutMs?: number;
  /**
   * A probe of the container's readiness, for example the supervisor's port. It gets a signal
   * that aborts when its time is up; it is never awaited past that.
   */
  probe(signal: AbortSignal): Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The timer that bounds a probe (tests replace it). */
  readonly timer?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

/**
 * Watches a start that `start()` accepted, with no `monitor()`: a pending `monitor()` holds the
 * Durable Object in memory for up to 15 minutes and delays idle stops (design, lifecycle step 4),
 * and on staging it reported a failed start no earlier than `running` and a port probe did
 * (WP3.3's bench, 25 Oct). A refusal right after a stop surfaces in the next container call
 * (CF-05), so the probe's error is read: Cloudflare's own refusal text means `refused` (it also
 * follows a start that crashed; both are retried within the same budget). Otherwise the start is
 * `ready` once a probe answers within the deadline, and `not_running` once the deadline passes;
 * each probe is bounded by what is left of it, so a hanging probe cannot hold the wake
 * (Codex WP3.3 r1-5).
 */
export async function observeStart(options: ObserveOptions): Promise<StartOutcome> {
  const deadline = options.deadlineMs ?? 10_000;
  const poll = options.pollMs ?? 250;
  const probeTimeout = options.probeTimeoutMs ?? 2_000;
  const wait = options.sleep ?? sleep;
  const timer = options.timer ?? sleep;
  const clock = options.clock ?? Date.now;
  const started = clock();
  const elapsed = () => clock() - started;
  for (;;) {
    const left = deadline - elapsed();
    if (left <= 0) return { kind: "not_running", afterMs: elapsed() };
    const controller = new AbortController();
    let answered: boolean | "refused" | "timeout";
    try {
      answered = await Promise.race([
        // Called inside a promise, so a probe that throws at once is read like one that rejects
        // (Codex WP3.3 r2-3).
        Promise.resolve()
          .then(() => options.probe(controller.signal))
          .then(
            (ok) => ok,
            (error: unknown) => (isStartRefusedError(error) ? ("refused" as const) : false),
          ),
        timer(Math.min(left, probeTimeout)).then(() => "timeout" as const),
      ]);
    } finally {
      controller.abort();
    }
    if (answered === "refused") return { kind: "refused", afterMs: elapsed() };
    if (answered === true && elapsed() <= deadline) return { kind: "ready", afterMs: elapsed() };
    if (elapsed() >= deadline) return { kind: "not_running", afterMs: elapsed() };
    await wait(poll);
  }
}
