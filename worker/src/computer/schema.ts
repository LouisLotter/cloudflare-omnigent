import type { Migration } from "../shared/migrations.ts";

/** WorkspaceDO's SQLite schema: one key-value table the controller's `Store` is built on. */
export const WORKSPACE_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "workspace_kv",
    statements: [
      "CREATE TABLE workspace_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
    ],
  },
];
