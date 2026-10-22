import type { Migration } from "../shared/migrations.ts";

/** OmnigentServer's storage: the watchdog's state, the bootstrap check and the outage records. */
export const SERVER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "watchdog_and_outages",
    statements: [
      "CREATE TABLE server_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      `CREATE TABLE outages (
         outage_id TEXT PRIMARY KEY,
         record TEXT NOT NULL,
         started_ms INTEGER NOT NULL,
         ended_ms INTEGER
       )`,
      "CREATE INDEX outages_by_start ON outages (started_ms)",
    ],
  },
];
