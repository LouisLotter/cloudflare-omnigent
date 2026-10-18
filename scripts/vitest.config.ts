import { defineConfig } from "vitest/config";

// Pure modules: definition of done, at least 90% of lines and branches.
const pure = { lines: 90, branches: 90, functions: 90, statements: 90 };
// Modules that start processes or hold locks. Their remaining branches are defensive paths
// for failures of the operating system; the real-process tests and the live staging runs
// recorded in docs/verification/ exercise the rest.
const io = { lines: 85, branches: 75, functions: 80, statements: 85 };

// Tests for the repository tools in scripts/: the canary scanner and the staging tool.
export default defineConfig({
  root: import.meta.dirname,
  // Keep Vite's cache in the root node_modules rather than creating scripts/node_modules.
  cacheDir: "../node_modules/.vite/scripts",
  test: {
    name: "scripts",
    include: ["test/**/*.test.ts", "staging/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["*.ts", "staging/*.ts"],
      // stg.ts only parses arguments and wires the ports together; the live staging runs in
      // docs/verification/wp-0.4.md exercise it.
      exclude: ["**/*.test.ts", "vitest.config.ts", "staging/stg.ts"],
      reportsDirectory: "../coverage/scripts",
      thresholds: {
        "staging/guard.ts": pure,
        "staging/ops.ts": pure,
        "staging/lock.ts": { ...io, branches: 85 },
        "staging/cloud.ts": io,
        "canary-scan.ts": { ...pure, branches: 85 },
      },
    },
  },
});
