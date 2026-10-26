// A computer's intercepts (design, "Network"). Pure: no Workers runtime import. WorkspaceDO
// (WP3.1) calls these with its container port and its `ctx.exports`:
//   - `startWithIntercepts` before every start: the intercepts first, with this generation's
//     props, then `start()`, so the computer's first request already finds them;
//   - `refreshIntercepts` in every new instance that finds the container running, and when
//     `start_host` names the host ID: it registers the same hosts again, only to refresh their
//     trusted props (CF-06: intercepts persist across instances and run the new code).
// Hosts registered: `omnigent.internal` (the live connection, A′) and `computer.internal` (the
// computer API); `git.internal` arrives with stage 4. Never a catch-all, never
// `platform.internal` (the server's only), and never the Sandbox SDK's backup host, which
// `DirectoryBackup` registers itself for each operation: re-registering it during a backup or
// restore would replace that operation's grant and fail it.

import {
  COMPUTER_API_HOST,
  type ComputerId,
  type Generation,
  type HostId,
  InterceptProps,
  PLATFORM_INTERNAL_HOST,
} from "@cfo/contracts";
import type { ComputerContainerPort, ComputerStartOptions } from "../shared/computer-port.ts";

/** The live connection's virtual host (A′). */
export const OMNIGENT_INTERNAL_HOST = "omnigent.internal";
/** The Sandbox SDK's backup gateway host: registered only by `DirectoryBackup` itself. */
export const BACKUP_GATEWAY_HOST = "backups.sandbox.internal";

/** The props version this code writes. Handlers refuse versions they do not know. */
export const INTERCEPT_PROPS_VERSION = 1;

/** Each intercepted host and the platform Worker entrypoint that serves it. */
export const COMPUTER_INTERCEPTS = [
  { host: OMNIGENT_INTERNAL_HOST, entrypoint: "OmnigentRoute" },
  { host: COMPUTER_API_HOST, entrypoint: "ComputerApi" },
] as const;

export type ComputerEntrypoint = (typeof COMPUTER_INTERCEPTS)[number]["entrypoint"];

/** `ctx.exports`, as far as these intercepts need it. */
export type InterceptExports = Readonly<
  Record<ComputerEntrypoint, (options: { readonly props: InterceptProps }) => Fetcher>
>;

/**
 * The intercept targets for these props: each computer host and its entrypoint, bound to the
 * props, which the handlers trust (WorkspaceDO's `intercepts`). The backup host is not among them:
 * `DirectoryBackup` registers it for each operation, with a grant fenced to the generation.
 */
export function interceptTargets(
  exports: InterceptExports,
  props: InterceptProps,
): readonly { readonly host: string; readonly target: Fetcher }[] {
  const checked = InterceptProps.parse(props);
  return COMPUTER_INTERCEPTS.map(({ host, entrypoint }) => ({
    host,
    target: exports[entrypoint]({ props: checked }),
  }));
}

/** Hosts a computer must never have intercepted (a catch-all, or another component's). */
export function interceptHostAllowed(host: string): boolean {
  const name = host.trim().toLowerCase();
  if (name === "" || name.includes("*") || name.includes("/") || name.includes(":")) return false;
  if (name === PLATFORM_INTERNAL_HOST || name === BACKUP_GATEWAY_HOST) return false;
  return COMPUTER_INTERCEPTS.some((entry) => entry.host === name);
}

/** This generation's props, checked against the contract. */
export function interceptProps(
  computerId: ComputerId,
  generation: Generation,
  hostId: HostId | null,
): InterceptProps {
  return InterceptProps.parse({
    propsVersion: INTERCEPT_PROPS_VERSION,
    computerId,
    generation,
    hostId,
  });
}

/** Registers every computer intercept with these props. Rejects if any registration fails. */
export async function registerIntercepts(
  port: Pick<ComputerContainerPort, "registerIntercept">,
  exports: InterceptExports,
  props: InterceptProps,
): Promise<void> {
  const checked = InterceptProps.parse(props);
  for (const { host, entrypoint } of COMPUTER_INTERCEPTS) {
    if (!interceptHostAllowed(host)) throw new Error(`refusing to intercept ${host}`);
    await port.registerIntercept(host, exports[entrypoint]({ props: checked }));
  }
}

/**
 * Before every start: the intercepts with this generation's props, then the start. If a
 * registration fails, nothing is started.
 */
export async function startWithIntercepts(
  port: Pick<ComputerContainerPort, "registerIntercept" | "start">,
  exports: InterceptExports,
  props: InterceptProps,
  options: ComputerStartOptions,
): Promise<void> {
  await registerIntercepts(port, exports, props);
  port.start(options);
}

/**
 * In a new instance, or when the host ID is named: the same intercepts again, only to refresh
 * their props, and only while the container runs. Returns whether it registered.
 */
export async function refreshIntercepts(
  port: Pick<ComputerContainerPort, "registerIntercept" | "running">,
  exports: InterceptExports,
  props: InterceptProps,
): Promise<boolean> {
  if (!port.running) return false;
  await registerIntercepts(port, exports, props);
  return true;
}
