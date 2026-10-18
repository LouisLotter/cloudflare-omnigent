import { defineConfig } from "vitest/config";

// Unit and property tests for the pure guard. Run from the repository root:
//   pnpm exec vitest run --config spikes/s7/vitest.config.ts
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/guard.ts", "src/forward.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "./.run/coverage",
    },
  },
});
