import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { runtimeModules } from "./vitest.unit.config.ts";

// Runs inside workerd with real Durable Object storage, alarms and eviction.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    name: "workers",
    include: ["test/workers/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      // Only the runtime-bound modules: the unit project measures the pure ones, so their
      // branches need not be tested a second time inside workerd.
      include: runtimeModules,
      reportsDirectory: "coverage/workers",
      // The aggregate must reach 85% (75% of branches), and each file a lower floor, so a small
      // untested Durable Object or adapter cannot hide behind well-tested ones. Error paths that
      // workerd cannot reach are why these sit below the 90% required of pure modules.
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 85,
        statements: 85,
        perFile: { lines: 70, branches: 50, functions: 70, statements: 70 },
      },
    },
  },
});
