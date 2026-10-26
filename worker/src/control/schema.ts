import type { Migration } from "../shared/migrations.ts";

export const CONTROL_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "control_meta",
    statements: ["CREATE TABLE control_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"],
  },
  {
    version: 2,
    name: "limits",
    statements: [
      // The installation's computers, by the name `provision` gave them (WP3.2).
      `CREATE TABLE computers (
         computer_id TEXT PRIMARY KEY,
         name TEXT NOT NULL UNIQUE,
         created_at INTEGER NOT NULL
       )`,
      // The slots: one (computer, generation) pair per reservation. `adopted` marks a slot rebuilt
      // by reconciliation from WorkspaceDO's report rather than granted to a request.
      `CREATE TABLE slots (
         computer_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         granted_at INTEGER NOT NULL,
         adopted INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (computer_id, generation)
       )`,
      // Per computer, the highest generation known to be finished (limits.ts, "Generations").
      `CREATE TABLE floors (
         computer_id TEXT PRIMARY KEY,
         floor INTEGER NOT NULL
       )`,
      // Mutating calls by operation ID: a repeat returns the recorded outcome; kept 8 days.
      `CREATE TABLE operations (
         operation_id TEXT PRIMARY KEY,
         request TEXT NOT NULL,
         result TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      "CREATE INDEX operations_by_age ON operations (created_at)",
    ],
  },
];
