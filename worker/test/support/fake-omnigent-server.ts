/**
 * In-memory fake of the OmnigentServer Durable Object, for tests of the packages that call it:
 * ingress (WP2.1) forwards browser requests through `fetch`, and the cloud-computers page (WP3.5)
 * reads outage records. It uses only web-standard APIs, so it runs in Node and in workerd.
 *
 * - `fetch` records every request and answers with the next queued response, else 200 "ok".
 * - `outages` returns the records a test added that overlap the range, oldest first, by the
 *   contract's own `outageOverlaps` rule, so the fake and WP2.2 cannot disagree on it.
 * - `unconfirmedResponse` builds the server image's 424 for a path, in the body shape that
 *   path's clients parse (spike S4), for tests that a 424 is passed through and never retried.
 */
import {
  DURABILITY_UNCONFIRMED_CODE,
  DURABILITY_UNCONFIRMED_MESSAGE,
  DURABILITY_UNCONFIRMED_STATUS,
  durabilityBodyShape,
  OutageRecord,
  outageOverlaps,
  type Timestamp,
} from "@cfo/contracts";
import type { OmnigentServerRpc } from "../../src/shared/rpc.ts";

export class FakeOmnigentServer implements OmnigentServerRpc {
  readonly requests: Request[] = [];
  private readonly queued: Response[] = [];
  private readonly records: OutageRecord[] = [];

  /** The response for the next forwarded request. */
  respondWith(response: Response): void {
    this.queued.push(response);
  }

  /** Adds an outage record; it must satisfy the contract. */
  addOutage(record: OutageRecord): void {
    this.records.push(OutageRecord.parse(record));
  }

  async fetch(request: Request): Promise<Response> {
    this.requests.push(request);
    return this.queued.shift() ?? new Response("ok");
  }

  async outages(from: Timestamp, to: Timestamp): Promise<OutageRecord[]> {
    return this.records
      .filter((record) => outageOverlaps(record, from, to))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }
}

/** The 424 the server image's response barrier sends for a request to `path`. */
export function unconfirmedResponse(path: string): Response {
  const body =
    durabilityBodyShape(path) === "auth"
      ? { error: DURABILITY_UNCONFIRMED_MESSAGE, code: DURABILITY_UNCONFIRMED_CODE, applied: true }
      : {
          error: { code: DURABILITY_UNCONFIRMED_CODE, message: DURABILITY_UNCONFIRMED_MESSAGE },
          applied: true,
        };
  return Response.json(body, { status: DURABILITY_UNCONFIRMED_STATUS });
}
