// Stand-in for the `cloudflare:workers` module, so the S3 Worker's modules and the Sandbox SDK
// load under Node in Vitest and in the local end-to-end driver. Bindings are faked per use.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
