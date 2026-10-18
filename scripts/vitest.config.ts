import type { ViteUserConfig } from "vitest/config";

// Run by the root `test:scripts` script with the worker package's vitest: the repository root has
// no vitest dependency, so this file has no runtime imports.
export default {
  root: import.meta.dirname,
  // Keep Vite's cache out of scripts/, which has no node_modules of its own.
  cacheDir: "../node_modules/.vite/scripts",
  test: {
    name: "scripts",
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
} satisfies ViteUserConfig;
