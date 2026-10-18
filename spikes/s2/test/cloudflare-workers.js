// Stand-in for the `cloudflare:workers` module, so the spike's real Worker module loads in Node.
// The base classes only keep ctx and env, as the runtime's do.
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
