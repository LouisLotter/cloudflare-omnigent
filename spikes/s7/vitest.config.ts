import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit, property and handler tests for the spike Worker. Run from the repository root:
//   pnpm exec vitest run --config spikes/s7/vitest.config.ts
// `cloudflare:workers` is aliased to a small stub, so the real handlers and Durable Object
// classes run in Node against fake storage and containers.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/guard.ts", "src/forward.ts", "src/controls.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./.run/coverage",
    },
  },
});
