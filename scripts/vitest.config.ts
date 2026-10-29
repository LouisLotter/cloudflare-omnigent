import { defineConfig } from "vitest/config";

// Pure modules: definition of done, at least 90% of lines and branches.
const pure = { lines: 90, branches: 90, functions: 90, statements: 90 };
// Modules that start processes or hold locks. Their remaining branches are defensive paths
// for failures of the operating system; the real-process tests and the live staging runs
// recorded in the project's verification notes exercise the rest.
const io = { lines: 85, branches: 75, functions: 80, statements: 85 };

// Tests for the repository tools in scripts/: the canary scanner, the staging tool, the
// bootstrap script and the restore drill's staging harness Worker (its pure parts).
export default defineConfig({
  root: import.meta.dirname,
  // Keep Vite's cache in the root node_modules rather than creating scripts/node_modules.
  cacheDir: "../node_modules/.vite/scripts",
  test: {
    name: "scripts",
    include: [
      "test/**/*.test.ts",
      "staging/**/*.test.ts",
      "bootstrap/**/*.test.ts",
      "restore-drill/staging/**/*.test.ts",
    ],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: [
        "*.ts",
        "staging/*.ts",
        "bootstrap/*.ts",
        "restore-drill/staging/src/plan.ts",
        "restore-drill/staging/src/controls.ts",
      ],
      // stg.ts, bootstrap.ts and github-app-command.ts only parse arguments and wire the ports
      // together; the live staging runs recorded for WP0.4 and WP2.4 exercise the first two.
      exclude: [
        "**/*.test.ts",
        "vitest.config.ts",
        "staging/stg.ts",
        "bootstrap/bootstrap.ts",
        "bootstrap/github-app-command.ts",
      ],
      reportsDirectory: "../coverage/scripts",
      thresholds: {
        "staging/guard.ts": pure,
        "staging/ops.ts": pure,
        "staging/lock.ts": { ...io, branches: 85 },
        "staging/cloud.ts": io,
        "canary-scan.ts": { ...pure, branches: 85 },
        "bootstrap/settings.ts": pure,
        "bootstrap/events.ts": pure,
        "bootstrap/access.ts": pure,
        "bootstrap/access-app.ts": pure,
        "bootstrap/preflight.ts": pure,
        // It starts the clipboard tool: a fake one on PATH exercises that.
        "bootstrap/password.ts": io,
        "bootstrap/machine.ts": pure,
        "bootstrap/state.ts": pure,
        "bootstrap/r2-token.ts": pure,
        "bootstrap/github-app.ts": pure,
        "bootstrap/remove.ts": io,
        "bootstrap/cloud.ts": io,
        "bootstrap/staging.ts": io,
        "restore-drill/staging/src/plan.ts": pure,
        "restore-drill/staging/src/controls.ts": pure,
      },
    },
  },
});
