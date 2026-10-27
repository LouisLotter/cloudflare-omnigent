// The server controller's container port: the only server module that touches `ctx.container`
// (code-structure plan, "Beta APIs only behind adapters"). It uses the Durable Object Container
// API directly, as X1's native forwarding did, never the containers library: its default fetch
// accepts both sockets and returns the container's handshake headers (R-24).
//
// The server's container runs under the `durable_object` scheduling policy (WP3.19): the image
// and the size are start options, not configuration. Each start names the image this Worker
// version maps under `SERVER_IMAGE_KEY` and the size `SERVER_INSTANCE` (server-env.ts). A running container
// keeps the image and size it started with: a deploy changes neither, so the watchdog's
// fingerprint covers both (server-env.ts) and a release that changes one replaces the server
// once. There is no `max_instances`: one named OmnigentServer object runs one container.

import { SERVER_INSTANCE } from "./server-env.ts";

/** The port the Omnigent server listens on inside its container. */
export const OMNIGENT_PORT = 8000;

/** The server's image key under `containers[].images` in the platform Worker's configuration. */
export const SERVER_IMAGE_KEY = "server";

/** Why `monitor()` settled: a clean exit, or the error it rejected with. */
export interface ContainerExit {
  readonly error: unknown;
}

/** The parts of a container the server controller uses. */
export interface ServerContainer {
  readonly running: boolean;
  /**
   * Starts the container with this environment, internet access, `SERVER_INSTANCE`'s size and
   * this image (null: none named, as for a class without an image map). Throws if it runs.
   */
  start(env: Readonly<Record<string, string>>, image: string | null): void;
  /** Calls `onExit` once the container started last stops, or its start fails. */
  watch(onExit: (exit: ContainerExit) => void): void;
  /** HTTP to a container port, over `http://` (an `https://` URL throws on Cloudflare). */
  fetch(port: number, request: Request): Promise<Response>;
  destroy(reason: string): Promise<void>;
  /** Sends a signal to the container's main process, such as SIGTERM (15). */
  signal(signo: number): void;
  setInactivityTimeout(ms: number): Promise<void>;
  interceptOutboundHttp(host: string, target: Fetcher): Promise<void>;
}

/** The container of this Durable Object, or null when its class has none configured. */
export function serverContainerOf(ctx: DurableObjectState): ServerContainer | null {
  return ctx.container ? nativeServerContainer(ctx.container) : null;
}

/**
 * The image this Worker version would start the server with: its `SERVER_IMAGE_KEY` entry under
 * `ctx.container.images`, a reference Wrangler pins by digest when it deploys
 * (`registry.cloudflare.com/<account>/<repository>@sha256:<digest>`). The map ships with the
 * version, so a new version may name another image while the running container keeps its own.
 * Null without a container, an images map or that key.
 */
export function serverImageOf(ctx: { readonly container?: Container }): string | null {
  try {
    const image = ctx.container?.images[SERVER_IMAGE_KEY];
    return typeof image === "string" && image !== "" ? image : null;
  } catch {
    // A class under the default policy has no images map.
    return null;
  }
}

/**
 * The start options the runtime gets: internet on (required with any options), the environment,
 * the size, the image. Typed as the runtime's options, so `SERVER_INSTANCE` must be a size the
 * runtime's types accept.
 */
export function serverStartOptions(
  env: Readonly<Record<string, string>>,
  image: string | null,
): ContainerStartupOptions {
  const start = { enableInternet: true, env: { ...env }, instance: SERVER_INSTANCE };
  return image === null ? start : { ...start, image };
}

/** The adapter over the runtime's container. */
export function nativeServerContainer(container: Container): ServerContainer {
  return {
    get running() {
      return container.running;
    },
    start(env, image) {
      container.start(serverStartOptions(env, image));
    },
    watch(onExit) {
      container.monitor().then(
        () => onExit({ error: null }),
        (error: unknown) => onExit({ error }),
      );
    },
    fetch(port, request) {
      return container.getTcpPort(port).fetch(request);
    },
    destroy(reason) {
      return container.destroy(reason);
    },
    signal(signo) {
      container.signal(signo);
    },
    setInactivityTimeout(ms) {
      return container.setInactivityTimeout(ms);
    },
    interceptOutboundHttp(host, target) {
      return container.interceptOutboundHttp(host, target);
    },
  };
}

const NO_INSTANCE = "there is no container instance that can be provided to this durable object";
const NOT_LISTENING = "the container is not listening";

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).toLowerCase();
}

/** Cloudflare's refusal of a start right after a stop (DC-37). */
export function isNoInstanceError(error: unknown): boolean {
  return messageOf(error).includes(NO_INSTANCE);
}

/**
 * The exit code in an error `monitor()` rejected with, if it names one: the runtime reports a
 * non-zero exit as "container exited with unexpected exit code: N", and a stop by signal as
 * "runtime signalled the container to exit: N" (which gives no exit code). A clean exit
 * resolves `monitor()` and is code 0.
 */
export function exitCodeOf(exit: ContainerExit): number | null {
  if (exit.error === null) return 0;
  const match = /exited with unexpected exit code:\s*(\d{1,3})\b/.exec(messageOf(exit.error));
  const code = match?.[1] === undefined ? null : Number(match[1]);
  return code !== null && code <= 255 ? code : null;
}

/** A port fetch that never reached a listening server: the request was not sent. */
export function isNotListeningError(error: unknown): boolean {
  return messageOf(error).includes(NOT_LISTENING);
}
