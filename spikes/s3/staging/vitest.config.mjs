import { defineConfig } from "vitest/config";

// Campaign-control tests for the S3 staging page. From the repository root:
//   pnpm exec vitest run --config spikes/s3/staging/vitest.config.mjs
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["*.test.js"],
  },
});
