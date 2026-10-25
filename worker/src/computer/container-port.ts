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

/** Makes the `DirectoryBackup` for a key prefix (`egress/backups.ts`). */
export type DirectoryBackupsFor = (prefix: string) => DirectoryBackups;

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
      return options.backups(backup.prefix).backup({
        dir: backup.dir,
        name: backup.name,
        ...(backup.signal ? { signal: backup.signal } : {}),
      });
    },
    restore(record, restore: RestoreOptions) {
      return options.backups(restore.prefix).restore(record, {
        dir: restore.dir,
        ...(restore.signal ? { signal: restore.signal } : {}),
      });
    },
    deleteBackup(record, { prefix }) {
      return options.backups(prefix).delete(record);
    },
  };
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
  /** The design's 10 s: a container not running by then counts as refused. */
  readonly deadlineMs?: number;
  readonly pollMs?: number;
  /** A probe of the container's readiness, for example the supervisor's port. */
  probe(): Promise<boolean>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
}

/**
 * Watches a start that `start()` accepted, with no `monitor()`: a pending `monitor()` holds the
 * Durable Object in memory for up to 15 minutes and delays idle stops (design, lifecycle step 4).
 * A refusal right after a stop surfaces in the next container call (CF-05), so the probe's error
 * is read: Cloudflare's own refusal text means `refused`. Otherwise the start counts as `ready`
 * once the probe answers, and as `not_running` when the deadline passes first, which WorkspaceDO
 * also retries as a refusal.
 */
export async function observeStart(options: ObserveOptions): Promise<StartOutcome> {
  const deadline = options.deadlineMs ?? 10_000;
  const poll = options.pollMs ?? 250;
  const wait = options.sleep ?? sleep;
  const clock = options.clock ?? Date.now;
  const started = clock();
  for (;;) {
    const afterMs = clock() - started;
    try {
      if (await options.probe()) return { kind: "ready", afterMs: clock() - started };
    } catch (error) {
      if (isStartRefusedError(error)) return { kind: "refused", afterMs: clock() - started };
    }
    if (afterMs >= deadline) return { kind: "not_running", afterMs };
    await wait(poll);
  }
}
