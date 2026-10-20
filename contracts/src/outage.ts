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
    /** Found stopped, running but not answering, or not ready within the readiness wait. */
    cause: z.enum(["container_stopped", "not_answering", "start_failed"]),
    startedAt: Timestamp,
    detectedAt: Timestamp,
    /** When the server answered again; null while the outage lasts. */
    endedAt: Timestamp.nullable(),
    /** Restarts the watchdog made during the outage. */
    restarts: z.number().int().min(0).max(1000),
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
