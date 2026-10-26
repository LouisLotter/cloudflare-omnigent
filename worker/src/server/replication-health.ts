// The replication warning for the cloud-computers page (FH-15's G3 part, WP3.5), judged from the
// entrypoint's `GET :8001/status` (WP2.3): its `replication` member carries Litestream's `txid`,
// `replicatedTxid`, `caughtUp` and `lastSyncAt`, or an `error`. Pure, so it runs in plain tests.

import { REPLICATION_LAG_WARNING_MS, type ReplicationHealth } from "@cfo/contracts";
import { z } from "zod";

const Replication = z.union([
  z.looseObject({ error: z.string().max(500) }),
  z.looseObject({
    caughtUp: z.boolean(),
    lastSyncAt: z.string().max(64).nullable().optional(),
  }),
]);

const Status = z.looseObject({
  phase: z.string().max(32),
  replication: Replication.nullable().optional(),
});

/** An instant Litestream reports, as milliseconds, or null when it cannot be read. */
function instant(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The page's replication state from one status read (`null` when it could not be read):
 * `replicating` when the replica holds every commit or synced within the threshold, `lagging`
 * when commits wait and the last sync is older (or unknown), `failing` on Litestream's error,
 * `unknown` otherwise (no status, or a server not running).
 */
export function judgeReplication(status: unknown, nowMs: number): ReplicationHealth {
  const checkedAt = new Date(nowMs).toISOString();
  const parsed = Status.safeParse(status);
  if (!parsed.success || parsed.data.phase !== "running") {
    return { state: "unknown", lastSyncAt: null, checkedAt };
  }
  const replication = parsed.data.replication;
  if (replication === null || replication === undefined) {
    return { state: "unknown", lastSyncAt: null, checkedAt };
  }
  if ("error" in replication && typeof replication.error === "string") {
    return { state: "failing", lastSyncAt: null, checkedAt };
  }
  const facts = replication as { caughtUp: boolean; lastSyncAt?: string | null };
  const last = instant(facts.lastSyncAt);
  const lastSyncAt = last === null ? null : new Date(last).toISOString();
  if (facts.caughtUp) return { state: "replicating", lastSyncAt, checkedAt };
  const lagging = last === null || nowMs - last > REPLICATION_LAG_WARNING_MS;
  return { state: lagging ? "lagging" : "replicating", lastSyncAt, checkedAt };
}
