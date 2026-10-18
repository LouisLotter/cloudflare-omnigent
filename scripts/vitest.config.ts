import { defineConfig } from "vitest/config";

// Tests for the repository tools in scripts/: the canary scanner and the staging tool.
export default defineConfig({
  root: import.meta.dirname,
  // Keep Vite's cache in the root node_modules rather than creating scripts/node_modules.
  cacheDir: "../node_modules/.vite/scripts",
  test: {
    name: "scripts",
    include: ["test/**/*.test.ts", "staging/**/*.test.ts"],
    environment: "node",
  },
});
