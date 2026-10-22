import { z } from "zod";

/** Versions of the replication position this contract package understands. */
export const SUPPORTED_REPLICATION_POSITION_VERSIONS = [1] as const;

/**
 * Where the server image's entrypoint (WP2.3) serves its replication position: a port of the
 * server container that only the OmnigentServer Durable Object reaches, never the forwarding
 * path or a computer, which reach port 8000 alone. `GET http://<container>:8001/position`
 * answers 200 with a `ReplicationPosition`, or 503 while Litestream cannot say.
 */
export const REPLICATION_POSITION_PORT = 8001;
export const REPLICATION_POSITION_PATH = "/position";

/** A Litestream transaction ID, as a JSON number. Litestream counts them from 1. */
const Txid = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * The server's database position, as Litestream reports it, for the watchdog's bootstrap check
 * (WP2.2, G1BR-002). The owner's account counts as durable only once a replicated position of
 * the same boot covers a position read after `/v1/info` first showed the owner.
 *
 * The entrypoint answers from one Litestream control call, `POST /sync` without `wait` (never
 * `wait: true`, Litestream issue 1552), the same call the response barrier uses:
 * - `txid` is the position that call returns, so it covers every commit made before the call;
 * - `replicatedTxid` is the position the replica already holds (`replicated_txid`).
 *
 * `bootId` is random for each start of the entrypoint (128 bits, lowercase hex). Positions are
 * compared only within one boot: a restored database starts a new boot, and its positions say
 * nothing about the last one's.
 */
export const ReplicationPosition = z.strictObject({
  protocolVersion: z.number().int().min(1),
  bootId: z.string().regex(/^[0-9a-f]{32}$/),
  txid: Txid,
  replicatedTxid: Txid,
});
export type ReplicationPosition = z.infer<typeof ReplicationPosition>;
