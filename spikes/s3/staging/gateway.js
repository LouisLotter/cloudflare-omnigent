// R2 "blocked" for the S3 staging run (RC-15): a DirectoryBackupGateway that holds the
// container's part uploads, as a stalled R2 would.
//
// DirectoryBackup registers the gateway as the container's backups.sandbox.internal intercept
// with props for the operation (a write grant, a read grant or a deny). `gatewayFor` adds a
// hold to a write grant: { holdKey, holdMs }. The hold starts when the first part of that upload
// arrives, so archive production before it never eats into the hold; every part arriving before
// it ends waits for its end, then goes through the SDK's own handler. The Bench Durable Object
// keeps each hold's start and the longest wait a part really finished (holdUntil, holdWaited),
// so the campaign can show how long R2 was blocked. Control calls (create, complete and abort the upload, delete) and restores go to
// the SDK's gateway unchanged.

import { DirectoryBackupGateway } from "@cloudflare/sandbox";

/**
 * A hold's bookkeeping: first arrival, end, parts held, the longest wait promised on arrival and
 * (noteWaited) the longest wait a part actually finished. Pure.
 */
export function noteHold(holds, key, holdMs, now) {
  let hold = holds.get(key);
  if (!hold) {
    hold = { first: now, until: now + holdMs, parts: 0, promisedMaxMs: 0, observedMaxMs: 0 };
    holds.set(key, hold);
  }
  const wait = Math.max(0, hold.until - now);
  if (wait > 0) hold.parts += 1;
  hold.promisedMaxMs = Math.max(hold.promisedMaxMs, wait);
  return hold.until;
}

export function noteWaited(holds, key, waitedMs) {
  const hold = holds.get(key);
  if (hold) hold.observedMaxMs = Math.max(hold.observedMaxMs, waitedMs);
}

// Where no Durable Object is reachable (the local harness's gateway process), one process
// holds the bookkeeping itself.
const localHolds = new Map();

export class HoldingGateway extends DirectoryBackupGateway {
  async fetch(request) {
    const props = this.ctx.props ?? {};
    if (!(props.mode === "write" && props.holdKey && props.holdMs > 0)) return super.fetch(request);
    const arrived = Date.now();
    const bench = this.env.BENCH ? this.env.BENCH.get(this.env.BENCH.idFromName("s3")) : null;
    const until = bench
      ? await bench.holdUntil(props.holdKey, props.holdMs)
      : noteHold(localHolds, props.holdKey, props.holdMs, arrived);
    const wait = until - Date.now();
    if (wait > 0) {
      console.log(JSON.stringify({ s3: "gateway_hold", wt: arrived, wait_ms: wait }));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const response = await super.fetch(request);
    // A part stored after its wait proves the container kept that request open throughout:
    // an abandoned request's body can no longer be read.
    if (wait > 0 && response.ok) {
      const waited = Date.now() - arrived;
      if (bench) await bench.holdWaited(props.holdKey, waited);
      else noteWaited(localHolds, props.holdKey, waited);
    }
    return response;
  }
}

/**
 * The `gateway` argument for DirectoryBackup: `exports` is the Durable Object's ctx.exports,
 * `hold` an optional { key, ms } for the upload's write grant.
 */
export function gatewayFor(exports, hold) {
  return (options) => {
    const props = options.props;
    if (props.mode === "control") return exports.DirectoryBackupGateway({ props });
    if (props.mode === "write" && hold) {
      return exports.HoldingGateway({ props: { ...props, holdKey: hold.key, holdMs: hold.ms } });
    }
    return exports.HoldingGateway({ props });
  };
}
