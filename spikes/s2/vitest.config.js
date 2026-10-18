import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// IR-017 tests for the spike's public controls, against the real Worker module in Node.
// Run from the repository root:
//   pnpm exec vitest run --config spikes/s2/vitest.config.js
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers.js", import.meta.url)),
    },
  },
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.js"],
    environment: "node",
  },
});
