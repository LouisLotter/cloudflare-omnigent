// `bootstrap.ts devices [--client-session-days <n>] [--owner-email <address>]` (WP3.43): wires
// the devices step (devices.ts) to the installation's state file, its locks and the installer's
// `cf` login. The settings it changes are the account's (the Zero Trust organization and the
// default device profile), so besides the installation's own locks it holds one for the
// account's devices settings.

import { randomBytes } from "node:crypto";
import { spawnRunner } from "../staging/cloud.ts";
import { acquireLock } from "../staging/lock.ts";
import { AccessRefusal } from "./access-app.ts";
import { cfDevicesApi } from "./cloud.ts";
import { type DevicesApi, devicesNextSteps, ensureDevices } from "./devices.ts";
import { BootstrapRefusal } from "./machine.ts";
import { fileStateStore, locksDir, resourceLockPaths, workerLockPath } from "./state.ts";

export interface DevicesCommandOptions {
  readonly ownerEmail?: string;
  /** The client session in days, as given; undefined keeps one already set. */
  readonly sessionDays?: string;
  /** For tests: the Cloudflare to use instead of the installer's cf login. */
  readonly api?: DevicesApi;
  readonly lockDir?: string;
}

/** The lock for one account's devices settings, beside the Workers' locks. */
export function devicesLockPath(accountId: string, dir: string = locksDir()): string {
  return workerLockPath(accountId, "zero-trust-devices", dir);
}

/** Runs the step for the installation in the state file at `path`. Exit status 0, or throws. */
export async function devicesCommand(
  path: string,
  options: DevicesCommandOptions,
): Promise<number> {
  let days: number | undefined;
  if (options.sessionDays !== undefined) {
    if (!/^[0-9]+$/.test(options.sessionDays.trim())) {
      throw new Error("--client-session-days takes a whole number of days, 1 to 90");
    }
    days = Number(options.sessionDays);
  }
  const store = fileStateStore(path);
  const plan = store.load().installation;
  const releases: (() => void)[] = [];
  const holder = `pid ${process.pid}, bootstrap devices, ${path}`;
  try {
    for (const lock of [
      ...resourceLockPaths(plan, options.lockDir),
      devicesLockPath(plan.accountId, options.lockDir),
    ]) {
      releases.push(acquireLock(lock, 0, holder));
    }
    const outcome = await ensureDevices({
      api: options.api ?? cfDevicesApi(spawnRunner(plan.accountId)),
      plan,
      accessApp: store.load().journal.accessApp,
      ownerEmail: options.ownerEmail,
      sessionDays: days,
      recorded: () => store.load().journal.devices ?? {},
      record: (devices) => {
        const state = store.load();
        store.save({ ...state, journal: { ...state.journal, devices } });
      },
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      nonce: () => randomBytes(4).toString("hex"),
      log: (message) => console.log(`bootstrap: ${message}`),
    }).catch((error: unknown) => {
      throw error instanceof AccessRefusal ? new BootstrapRefusal(error.message) : error;
    });
    for (const line of outcome.changed) console.log(`bootstrap: changed: ${line}`);
    if (outcome.changed.length === 0) console.log("bootstrap: every setting was in place already");
    for (const line of devicesNextSteps(plan, outcome)) console.log(`bootstrap: ${line}`);
    return 0;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
