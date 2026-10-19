import type { Migration } from "../shared/migrations.ts";

export const CONTROL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "control_meta",
    statements: ["CREATE TABLE control_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"],
  },
];
