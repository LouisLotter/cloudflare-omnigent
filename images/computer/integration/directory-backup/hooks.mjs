// Lets plain Node load the Sandbox SDK: `cloudflare:workers` resolves to a stub, and Workers'
// FixedLengthStream gets a minimal stand-in. Load with --import (from spike S3).
import { registerHooks } from "node:module";

const stub = new URL("./cloudflare-workers-stub.mjs", import.meta.url).href;
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
