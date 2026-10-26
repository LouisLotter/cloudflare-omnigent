import { z } from "zod";
import { OutageId, Timestamp } from "./ids.ts";

const time = (value: string) => Date.parse(value);

/**
 * One interval in which Omnigent's server did not answer, recorded by the server's watchdog
 * (WP2.2) and shown as an outage notice on the cloud-computers page: "Omnigent was unavailable
 * from 03:00 to 03:12; scheduled runs due then may not have run". `startedAt` is the last moment
 * the server was known to answer, so a notice never understates the interval.
 *
 * The time order (`startedAt` ≤ `detectedAt` ≤ `endedAt`) is checked here, not in the exported
 * JSON Schema, which cannot express it.
 */
export const OutageRecord = z
  .strictObject({
    outageId: OutageId,
    /**
     * Found stopped, running but not answering, not ready within the readiness wait, in the
     * server image's recovery mode (its database could not be restored safely; WP2.3), which
     * needs the owner rather than a restart, or replaced by the watchdog because it runs with
     * another configuration than the platform Worker now holds (a secret or setting release,
     * G2-SEC-001): one controlled restart applies the release.
     */
    cause: z.enum([
      "container_stopped",
      "not_answering",
      "start_failed",
      "recovery_mode",
      "config_changed",
    ]),
    startedAt: Timestamp,
    detectedAt: Timestamp,
    /** When the server answered again; null while the outage lasts. */
    endedAt: Timestamp.nullable(),
    /** Restarts the watchdog made during the outage. */
    restarts: z.number().int().min(0).max(1000),
    /**
     * The server container's last exit code during the outage, if one was seen: 0 a clean stop,
     * 70 Litestream failed, 71 the app exited, 75 the final sync was not confirmed (changes may
     * be lost), 78 a setting is missing or malformed (WP2.3). Absent in records written before
     * the field existed.
     */
    exitCode: z.number().int().min(0).max(255).nullable().optional(),
  })
  .refine(
    (r) =>
      time(r.startedAt) <= time(r.detectedAt) &&
      (r.endedAt === null || time(r.detectedAt) <= time(r.endedAt)),
    { message: "outage times must be in order: startedAt, detectedAt, endedAt" },
  );
export type OutageRecord = z.infer<typeof OutageRecord>;

/**
 * Whether an outage overlaps the range [from, to). An ongoing outage, with `endedAt: null`,
 * overlaps every range that ends after it started.
 */
export function outageOverlaps(record: OutageRecord, from: string, to: string): boolean {
  return (
    time(record.startedAt) < time(to) &&
    (record.endedAt === null || time(record.endedAt) > time(from))
  );
}
