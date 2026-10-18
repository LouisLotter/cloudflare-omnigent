import { defineConfig } from "vitest/config";

// Pure modules only: nothing here may import from "cloudflare:workers".
export default defineConfig({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reportsDirectory: "coverage/unit",
    },
  },
});
