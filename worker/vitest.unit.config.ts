import { defineConfig } from "vitest/config";

/**
 * Modules that need the Workers runtime: the entry point, the Durable Object classes and the
 * modules that work on Durable Object storage. They cannot run in Node, so the workers project
 * measures their coverage instead (vitest.workers.config.ts imports this list). Every other
 * module under src/ counts as pure and must meet the unit thresholds below. Add a module here
 * only if it cannot run in plain Node, for example a future `container-port.ts`.
 */
export const runtimeModules = [
  "src/index.ts",
  "src/web.ts",
  "src/**/*DO.ts",
  "src/shared/sql.ts",
  "src/server/OmnigentServer.ts",
  // The private virtual hosts' entrypoints and the WebSocket answer (WorkerEntrypoint, Response
  // 101), and the Sandbox SDK's adapter, which imports `cloudflare:workers` (WP3.3).
  "src/internal/entrypoints.ts",
  "src/internal/upgrade-answer.ts",
  "src/egress/backups.ts",
  // The pages' assets, bundled as text modules by Wrangler's rules (WP3.5): not loadable in Node.
  "src/pages/assets.ts",
];

// Pure modules only: nothing here may import from "cloudflare:workers".
export default defineConfig({
  test: {
    name: "unit",
    include: ["test/unit/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      exclude: runtimeModules,
      reportsDirectory: "coverage/unit",
      // Definition of done: at least 90% for pure modules. Checked per file, so a well-tested
      // module cannot hide an untested one.
      thresholds: { perFile: true, lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
