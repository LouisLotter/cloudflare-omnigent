import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests of the S1 Worker's public routes, campaign arming (IR-017) and restore phases. Run from
// the repository root, after `npm ci --prefix spikes/s1`:
//   pnpm exec vitest run --config spikes/s1/vitest.config.js
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: fileURLToPath(new URL("./test/cloudflare-workers-stub.js", import.meta.url)),
      },
    ],
  },
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.js"],
    // Processed by Vite, so that the alias above also applies inside the Sandbox SDK.
    server: { deps: { inline: ["@cloudflare/sandbox"] } },
  },
});
