import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests of the S3 staging Worker: the campaign controls (IR-017), the campaign's step machine
// and the holding gateway. From the repository root, after `npm ci --prefix spikes/s3/staging`:
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: fileURLToPath(new URL("./cloudflare-workers-stub.js", import.meta.url)),
      },
    ],
  },
  test: {
    root: import.meta.dirname,
    include: ["*.test.js"],
    // Processed by Vite, so that the alias above also applies inside the Sandbox SDK.
    server: { deps: { inline: ["@cloudflare/sandbox"] } },
  },
});
