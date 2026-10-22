// R2 "blocked" for the S3 staging run (RC-15): a DirectoryBackupGateway that holds the
// container's part uploads for a while, as a stalled R2 would.
//
// DirectoryBackup registers the gateway as the container's backups.sandbox.internal intercept
// with props for the operation (a write grant, a read grant or a deny). `gatewayFor` adds a
// hold window to those props: a part upload that arrives inside [holdFromMs, holdUntilMs)
// waits until holdUntilMs, then goes through the SDK's own handler. Control calls (create,
// complete and abort the upload, delete) go to the SDK's gateway unchanged.

import { DirectoryBackupGateway } from "@cloudflare/sandbox";

/** Milliseconds a request arriving at `now` waits, or 0. */
export function holdFor(props, now) {
  const from = Number(props?.holdFromMs ?? 0);
  const until = Number(props?.holdUntilMs ?? 0);
  return until > now && now >= from ? until - now : 0;
}

export class HoldingGateway extends DirectoryBackupGateway {
  async fetch(request) {
    const wait = holdFor(this.ctx.props, Date.now());
    if (wait > 0) {
      console.log(JSON.stringify({ s3: "gateway_hold", wt: Date.now(), wait_ms: wait }));
      await new Promise((resolve) => setTimeout(resolve, wait));
      console.log(JSON.stringify({ s3: "gateway_release", wt: Date.now() }));
    }
    return super.fetch(request);
  }
}

/**
 * The `gateway` argument for DirectoryBackup: `exports` is the Durable Object's ctx.exports,
 * `hold` an optional { from, until } in epoch milliseconds.
 */
export function gatewayFor(exports, hold) {
  return (options) => {
    const props = options.props;
    if (props.mode === "control") return exports.DirectoryBackupGateway({ props });
    return exports.HoldingGateway({
      props: { ...props, holdFromMs: hold?.from ?? 0, holdUntilMs: hold?.until ?? 0 },
    });
  };
}
