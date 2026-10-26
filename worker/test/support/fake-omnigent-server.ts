/**
 * In-memory fake of the OmnigentServer Durable Object, for tests of the packages that call it:
 * the web Worker's forwarding path (WP2.2) passes browser requests through `fetch`, and the
 * cloud-computers page (WP3.5) reads outage records. It uses only web-standard APIs, so it runs
 * in Node and in workerd.
 *
 * - `fetch` records every request and answers with the next queued response, else 200 "ok".
 * - `outages` returns the records a test added that overlap the range, oldest first, by the
 *   contract's own `outageOverlaps` rule, so the fake and WP2.2 cannot disagree on it.
 * - `bootstrapStatus` returns what a test set, null by default; `ensureStarted` counts calls.
 * - Every RPC call checks its interface version as OmnigentServer does: a newer one is refused
 *   with `unsupported_version`.
 * - `unconfirmedResponse` builds the server image's 424 for a path, in the body shape that
 *   path's clients parse (spike S4), for tests that a 424 is passed through and never retried.
 */
import {
  type BootstrapStatus,
  DURABILITY_UNCONFIRMED_CODE,
  DURABILITY_UNCONFIRMED_MESSAGE,
  DURABILITY_UNCONFIRMED_STATUS,
  durabilityBodyShape,
  OutageRecord,
  outageOverlaps,
  type ReplicationHealth,
} from "@cfo/contracts";
import { platformError } from "../../src/shared/errors.ts";
import {
  OMNIGENT_SERVER_INTERFACE_VERSION,
  type OmnigentServerCall,
  type OmnigentServerRpc,
  type OutagesQuery,
} from "../../src/shared/rpc.ts";

function checkVersion(call: OmnigentServerCall): void {
  if (!(call.interfaceVersion >= 1 && call.interfaceVersion <= OMNIGENT_SERVER_INTERFACE_VERSION)) {
    throw platformError("unsupported_version", `interface version ${call.interfaceVersion}`);
  }
}

export class FakeOmnigentServer implements OmnigentServerRpc {
  readonly requests: Request[] = [];
  private readonly queued: Response[] = [];
  private readonly records: OutageRecord[] = [];
  /** What `bootstrapStatus` answers. */
  bootstrap: BootstrapStatus | null = null;
  /** What `replication` answers (WP3.5). */
  replicationHealth: ReplicationHealth = {
    state: "replicating",
    lastSyncAt: null,
    checkedAt: "2026-10-22T09:15:00.000Z",
  };

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

  async outages(query: OutagesQuery): Promise<OutageRecord[]> {
    checkVersion(query);
    const { from, to } = query;
    return this.records
      .filter((record) => outageOverlaps(record, from, to))
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  async bootstrapStatus(call: OmnigentServerCall): Promise<BootstrapStatus | null> {
    checkVersion(call);
    return this.bootstrap;
  }

  async replication(call: OmnigentServerCall): Promise<ReplicationHealth> {
    checkVersion(call);
    return this.replicationHealth;
  }

  /** How many times `ensureStarted` was called. */
  ensured = 0;

  async ensureStarted(call: OmnigentServerCall): Promise<void> {
    checkVersion(call);
    this.ensured += 1;
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
