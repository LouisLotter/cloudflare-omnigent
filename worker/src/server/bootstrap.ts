// The watchdog's bootstrap check (design: "Bootstrap (E1)", G1BR-002, R-30), as a pure function.
// The bootstrap secret may be deleted only once the owner's account both exists and is durable:
//   - initialized (X0): Omnigent's `GET /v1/info` reports `accounts_enabled: true` and
//     `needs_setup: false`; `needs_setup` alone is not enough, as it is also false in header and
//     OIDC modes;
//   - durable: the replicated position covers a position read after `/v1/info` showed the owner.
//
// The Durable Object reads, in this order and over the container's ports, never through the
// public hostname: the entrypoint's position (`before`), `/v1/info`, the position again
// (`after`). `before` and `after` from one boot prove that `/v1/info` came from that boot too, so
// `after.txid` covers the commit that created the owner. That position is kept as the target,
// bound to its boot; a later check of the same boot reports the owner durable once
// `replicatedTxid` reaches it. A new boot (a replaced or restored server) starts over.

import {
  BootstrapStatus,
  InstallationId,
  ReplicationPosition,
  SUPPORTED_BOOTSTRAP_STATUS_VERSIONS,
  SUPPORTED_REPLICATION_POSITION_VERSIONS,
} from "@cfo/contracts";
import { z } from "zod";

/**
 * The fields of Omnigent's `/v1/info` the check reads. Omnigent's own API, not a platform
 * contract: other fields are ignored.
 */
export const OmnigentInfo = z.object({
  accounts_enabled: z.boolean(),
  needs_setup: z.boolean(),
});

/** A position read after the owner was seen, bound to its boot. */
export interface BootstrapTarget {
  readonly bootId: string;
  readonly txid: number;
}

export const BootstrapTargetSchema = z.strictObject({
  bootId: z.string().min(1),
  txid: z.number().int().min(0),
});

/** The three reads, as parsed JSON, or null where a read failed. */
export interface BootstrapProbe {
  readonly before: unknown;
  readonly info: unknown;
  readonly after: unknown;
}

export type BootstrapReason =
  | "durable"
  | "not_replicated"
  | "not_initialized"
  | "info_unavailable"
  | "position_unavailable"
  | "boot_changed";

export type BootstrapCheck =
  | {
      readonly status: BootstrapStatus;
      readonly target: BootstrapTarget | null;
      readonly reason: BootstrapReason;
    }
  | {
      readonly status: null;
      readonly target: BootstrapTarget | null;
      readonly reason: "no_installation";
    };

const STATUS_VERSION = SUPPORTED_BOOTSTRAP_STATUS_VERSIONS[0];

function position(raw: unknown): ReplicationPosition | null {
  const parsed = ReplicationPosition.safeParse(raw);
  if (!parsed.success) return null;
  const supported: readonly number[] = SUPPORTED_REPLICATION_POSITION_VERSIONS;
  return supported.includes(parsed.data.protocolVersion) ? parsed.data : null;
}

/** One check. `previous` is the target the last check kept. */
export function checkBootstrap(
  installationId: unknown,
  previous: BootstrapTarget | null,
  probe: BootstrapProbe,
  now: number,
): BootstrapCheck {
  const installation = InstallationId.safeParse(installationId);
  if (!installation.success) return { status: null, target: previous, reason: "no_installation" };

  const result = (
    initialized: boolean,
    target: BootstrapTarget | null,
    reason: BootstrapReason,
  ) => ({
    status: BootstrapStatus.parse({
      protocolVersion: STATUS_VERSION,
      installationId: installation.data,
      initialized,
      checkedAt: new Date(now).toISOString(),
    }),
    target,
    reason,
  });

  const info = OmnigentInfo.safeParse(probe.info);
  if (!info.success) return result(false, previous, "info_unavailable");
  if (!info.data.accounts_enabled || info.data.needs_setup) {
    return result(false, null, "not_initialized");
  }

  const before = position(probe.before);
  const after = position(probe.after);
  if (before === null || after === null) return result(false, previous, "position_unavailable");
  if (before.bootId !== after.bootId) return result(false, null, "boot_changed");

  const target =
    previous !== null && previous.bootId === after.bootId
      ? previous
      : { bootId: after.bootId, txid: after.txid };
  const durable = after.replicatedTxid >= target.txid;
  return result(durable, target, durable ? "durable" : "not_replicated");
}
