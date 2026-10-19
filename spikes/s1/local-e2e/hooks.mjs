// Lets plain Node load the S1 Worker and the Sandbox SDK: `cloudflare:workers` resolves to the
// test stub, and Workers' FixedLengthStream gets a minimal stand-in. Load with --import.
import { registerHooks } from "node:module";

const stub = new URL("../test/cloudflare-workers-stub.js", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
    return next(specifier, context);
  },
});

globalThis.FixedLengthStream ??= class FixedLengthStream {
  constructor() {
    const { readable, writable } = new TransformStream();
    this.readable = readable;
    this.writable = writable;
  }
};
