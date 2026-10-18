import { type Migration, planMigrations } from "./migrations.ts";

const SCHEMA_TABLE = "_cfo_schema";

/**
 * Applies pending migrations in one synchronous storage transaction.
 * Call from the DO constructor inside `ctx.blockConcurrencyWhile`.
 * Returns the schema version now in effect.
 */
export function migrate(storage: DurableObjectStorage, migrations: readonly Migration[]): number {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA_TABLE} (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const row = storage.sql
      .exec<{ version: number | null }>(`SELECT MAX(version) AS version FROM ${SCHEMA_TABLE}`)
      .one();
    const applied = row.version ?? 0;
    for (const migration of planMigrations(applied, migrations)) {
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec(
        `INSERT INTO ${SCHEMA_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`,
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    }
    return Math.max(applied, migrations.length);
  });
}
