import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "contracts",
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage",
      // The schemas are pure modules: the same 90% per-file floor as the worker's unit project.
      thresholds: { perFile: true, lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
