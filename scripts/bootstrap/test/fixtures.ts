// Synthetic installations for the bootstrap's tests. No real account, hostname or address: the
// account ID is a run of one digit, the zone is example.test, the owner a canary address.

import { join, resolve } from "node:path";
import { makeOwnerPin } from "../../../worker/src/ingress/owner.ts";
import { readWranglerConfig } from "../../staging/cloud.ts";
import type { BootstrapState } from "../machine.ts";
import type { Installation } from "../settings.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const WORKER = join(ROOT, "worker");
export const OWNER_EMAIL = "owner-canary@example.test";
export const INSTALLATION = "ins_01hs3f9q2m8z4w7k6t5r1n0ybc";
export const OWNER_PASSWORD = "cfo-canary-owner-password-0001";

let pin: string | undefined;

/** The canary owner's pin, with a fixed salt so that tests can compare it. */
export async function ownerPin(): Promise<string> {
  pin ??= await makeOwnerPin(OWNER_EMAIL, new Uint8Array(32).fill(7));
  return pin;
}

export async function accountPlan(overrides: Partial<Installation> = {}): Promise<Installation> {
  return {
    installationId: INSTALLATION,
    accountId: "1".repeat(32),
    platformWorker: "cloudflare-omnigent",
    webWorker: "cloudflare-omnigent-web",
    hostname: "omnigent.example.test",
    ownerPin: await ownerPin(),
    ownerUsername: "owner",
    replica: {
      url: "s3://cfo-canary-replica/omnigent",
      endpoint: "https://canary.r2.example.test",
    },
    artifacts: { url: "s3://cfo-canary-artifacts" },
    target: { kind: "account" },
    plannedAt: "2026-10-22T11:00:00.000Z",
    ...overrides,
  };
}

/** A staging test installation: a file replica, and the artifacts on the container's disk. */
export async function stagingPlan(overrides: Partial<Installation> = {}): Promise<Installation> {
  const { artifacts: _onDisk, ...plan } = await accountPlan({
    platformWorker: "cfo-stg-wp24-platform",
    webWorker: "cfo-stg-wp24-web",
    hostname: "cfo-stg-wp24-web.example.test",
    replica: { url: "file:///replica" },
    target: {
      kind: "staging",
      owner: "WP2.4",
      platformSuffix: "wp24-platform",
      webSuffix: "wp24-web",
      days: 1,
    },
  });
  return { ...plan, ...overrides };
}

export function freshState(installation: Installation): BootstrapState {
  return { stateVersion: 1, installation, journal: {} };
}

/** The checked-in Wrangler configurations, as the bootstrap reads them. */
export function baseConfigs() {
  return {
    platform: readWranglerConfig(join(WORKER, "wrangler.jsonc"), WORKER).raw,
    web: readWranglerConfig(join(WORKER, "wrangler.web.jsonc"), WORKER).raw,
  };
}
