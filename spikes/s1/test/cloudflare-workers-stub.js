// Stand-in for the `cloudflare:workers` module, so that the S1 Worker's own handlers and
// Durable Object classes run under Node in Vitest. Bindings and storage are faked per test.
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
