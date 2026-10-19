import { platformError } from "./errors.ts";

/** One forward-only schema migration for a Durable Object's SQLite database. */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

/**
 * Pure planning step: validates the migration list and returns what must run.
 * Versions must be exactly 1..n in order. A database newer than the code is refused,
 * so an old deployment can never run against state written by a newer one.
 */
export function planMigrations(
  appliedVersion: number,
  migrations: readonly Migration[],
): readonly Migration[] {
  if (!Number.isInteger(appliedVersion) || appliedVersion < 0) {
    throw platformError("internal", `invalid applied schema version ${appliedVersion}`);
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw platformError(
        "internal",
        `migration ${migration.name} has version ${migration.version}, expected ${index + 1}`,
      );
    }
    if (migration.statements.length === 0) {
      throw platformError("internal", `migration ${migration.name} has no statements`);
    }
  });
  if (appliedVersion > migrations.length) {
    throw platformError(
      "unsupported_version",
      `database schema version ${appliedVersion} is newer than this code (${migrations.length})`,
    );
  }
  return migrations.slice(appliedVersion);
}
