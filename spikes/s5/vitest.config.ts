import { defineConfig } from "vitest/config";

// Spike S5 unit tests: the pure modules, in Node, with keys generated at run time.
//   pnpm exec vitest run --config spikes/s5/vitest.config.ts
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/spike-s5",
  test: {
    name: "spike-s5",
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["src/*.ts"],
      exclude: ["src/worker.ts", "src/scenarios.ts"],
      reportsDirectory: "../../coverage/spike-s5",
    },
  },
});
