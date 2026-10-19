// Node stand-in for the `cloudflare:workers` module, so the real Worker handlers and Durable
// Object classes run under Vitest with fake ports. Only what spikes/s7/src uses.

export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected readonly ctx: ExecutionContext<Props>;
  protected readonly env: Env;
  constructor(ctx: ExecutionContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
