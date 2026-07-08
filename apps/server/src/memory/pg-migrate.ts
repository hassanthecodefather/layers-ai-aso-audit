import postgres from 'postgres';
import { MIGRATIONS } from './migrate';

/**
 * Postgres-only DDL that uses Postgres-specific types (e.g. TIMESTAMPTZ).
 * Applied by runPgMigrations AFTER the shared MIGRATIONS array.
 * The shared limiter plan (2026-07-08-6a-shared-limiter.md) adds to this array.
 */
export const PG_ONLY_MIGRATIONS: readonly string[] = [
  // Phase 6a: rate slot table — added by shared-limiter plan
];

/**
 * Apply all migrations to the connected Postgres instance.
 * ALTER TABLE ... ADD COLUMN statements are rewritten to ADD COLUMN IF NOT
 * EXISTS before execution so that re-running migrations is idempotent.
 * The shared MIGRATIONS array intentionally omits IF NOT EXISTS because LibSQL
 * does not support it; this layer injects it only for Postgres.
 * The caller is responsible for setting search_path on the sql connection if
 * schema isolation is required (e.g. in tests).
 */
export async function runPgMigrations(sql: postgres.Sql): Promise<void> {
  for (const stmt of [...MIGRATIONS, ...PG_ONLY_MIGRATIONS]) {
    const normalized = /^\s*ALTER\s+TABLE\b/i.test(stmt)
      ? stmt.replace(/\bADD\s+COLUMN\b(?!\s+IF\s+NOT\s+EXISTS)/gi, 'ADD COLUMN IF NOT EXISTS')
      : stmt;
    await sql.unsafe(normalized);
  }
}
