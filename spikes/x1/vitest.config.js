import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The transport and UI Workers' real modules, in Node, with the platform faked (test/harness.js).
// Run from the repository root:
//   pnpm exec vitest run --config spikes/x1/vitest.config.js
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare-workers.js", import.meta.url)),
    },
  },
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.js"],
    setupFiles: ["test/setup.js"],
    environment: "node",
  },
});
