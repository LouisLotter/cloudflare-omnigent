// Test stand-in for the `cloudflare:workers` module: just the DurableObject base class.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
